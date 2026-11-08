/**
 * 自己梳理记忆：让模型判断哪些该合并、哪些该删、能看出什么规律；
 * 模型不可用时退回纯向量合并。
 *
 * 拆开的三块：提示词与模型调用在 ./consolidate-llm.mjs，向量兜底在
 * ./consolidate-vector.mjs；这个文件只剩编排（定时、事务、写库顺序）。
 */
import { IMPORTANT_WEIGHT } from '../constants.mjs'
import { vecToBlob, embedTexts } from '../vector.mjs'
import { rebuildScenes } from './scenes.mjs'
import { rebuildPersona } from '../persona.mjs'
import { rebuildGraph } from '../graph.mjs'
import { buildMergePrompt, callLlmText, writePersonaLlm } from './consolidate-llm.mjs'
import { vectorConsolidate } from './consolidate-vector.mjs'

/** 兼容层：拆出去的符号照旧可以从这个文件引入。 */
export * from './consolidate-llm.mjs'
export * from './consolidate-vector.mjs'

/** 定时梳理的间隔：6 小时。 */
export const CONSOLIDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * 定时梳理只在配置明确开成 `true` 时注册，默认一个定时器都不建。
 *
 * 梳理会删条目、不可逆，所以默认不让它自己跑起来；要跑就在设置页打开
 * `autoConsolidate`（下一轮重启后注册）。
 *
 * @param {object} opts
 * @param {*} opts.enabled 配置值，只有 === true 才注册
 * @param {Function} opts.run 一轮要干的事
 * @param {Function} [opts.timer] 注入 setInterval（测试用）
 * @returns {object|null} 定时器句柄；没注册就是 null
 */
export function scheduleConsolidate({ enabled, run, timer = setInterval }) {
  if (enabled !== true) return null
  const handle = timer(run, CONSOLIDATE_INTERVAL_MS)
  handle?.unref?.()
  return handle
}

/**
 * 造记忆整理器。
 *
 * @param {object} deps
 * @param {object} deps.db 记忆库
 * @param {Function} deps.bumpStat 计数
 * @param {Function} deps.defaultRoute 解析模型路由
 * @param {Function} deps.getLlm 取 llm 服务（可能还没就绪）
 * @returns {{consolidateNow:Function}}
 */
export function createConsolidator(deps) {
  const { db, bumpStat, defaultRoute, routeFor, getLlm, space, backupNow } = deps


  // ---- 自己梳理记忆 ----
  //
  // 不是外挂脚本，而是在插件内直接调 ctx.llm：
  //   1. 取一批冷区记忆
  //   2. 让模型判断：哪些该合并、哪些该删、能看出什么规律
  //   3. 按判断改库
  //
  // 模型不可用时退回纯向量合并（只合余弦 >0.85 的）。
  let consolidating = false

  /** 一组删改要么全成、要么整批回滚。事务里不许有 await。 */
  const inTx = (fn) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      db.exec('COMMIT')
      return out
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* 回滚失败也没别的办法 */ }
      throw error
    }
  }

  /** 记下这一次梳理的时间：状态接口和设置页都能看到。 */
  const stampConsolidated = () => {
    try {
      db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('consolidatedAt', ?)").run(String(Date.now()))
    } catch { /* 记不上不影响梳理 */ }
    try { bumpStat('consolidated') } catch { /* 同上 */ }
  }

  /** 模型这条路走不通时的兜底，实现见 ./consolidate-vector.mjs。 */
  const vectorFallback = () => vectorConsolidate({ db, inTx, stampConsolidated })

  const consolidateNow = async (opts = {}) => {
    if (consolidating) return { skipped: 'busy' }
    // 第一步先留一份能回滚的库：备不成就不动手，一条都不删。
    const snapshot = typeof backupNow === 'function'
      ? backupNow({ force: true, label: 'pre-consolidate' })
      : { ok: false, reason: 'no-backup' }
    if (snapshot?.ok !== true) return { skipped: 'backup-failed', detail: snapshot?.reason ?? 'unknown' }
    consolidating = true
    try {
      const batch = db.prepare(`
        SELECT id,u,a,t,w FROM entries
        WHERE hot=0 AND w < ? AND u NOT LIKE '（联想）%' AND u NOT LIKE '（规律）%'
        ORDER BY t DESC LIMIT ?
      `).all(IMPORTANT_WEIGHT, opts.batch ?? 20)

      if (batch.length < 3) return { skipped: 'too-few', count: batch.length }

      // 组装提示词（和 consolidate.js 保持同一套规则）
      const prompt = buildMergePrompt(batch)

      // llm 服务可能晚于插件就绪，用之前现取。
      const llm = getLlm()
      if (!llm || typeof llm.prepareCall !== 'function') {
        const r = vectorFallback()
        return { fallback: 'vector', ...r }
      }

      // L1（合并/去重）高频调用，默认让它走便宜的模型；配置了 llm.l1 就用配置的。
      const route = opts.route ?? (typeof routeFor === 'function' ? routeFor('l1') : defaultRoute())
      if (!route) {
        const r = vectorFallback()
        return { fallback: 'no-route', ...r }
      }

      let text = ''
      try {
        text = await callLlmText(llm, route, {
          system: '你是一个精于整理记忆的助手。只输出 JSON，不要解释。',
          prompt,
          temperature: 0.2,
          maxTokens: 3000,
          timeoutMs: opts.timeoutMs ?? 60_000,
        })
      } catch (e) {
        // 调不通就降级，不把错误抛给调用方。
        // 把关键配置也带回来，否则只能靠猜。
        const r = vectorFallback()
        return {
          fallback: 'llm-failed',
          error: String(e?.message ?? e).slice(0, 200),
          route,
          ...r,
        }
      }

      // 蒸馏记账：调用次数和产出字符数。不追求精确 token，够看「这一层花了多少」。
      try {
        bumpStat('distillCalls')
        if (text.length > 0) bumpStat('distillChars', text.length)
      } catch { /* 记不上不影响蒸馏 */ }

      const m = text.match(/\{[\s\S]*\}/u)
      if (!m) return { fallback: 'no-json', raw: text.slice(0, 200) }

      let plan
      try { plan = JSON.parse(m[0]) } catch { return { fallback: 'bad-json' } }

      if (opts.dry) return { dry: true, plan, count: batch.length }

      // 先把要写的向量算好，再一次性进事务：事务里不能有 await，
      // 否则回滚会把这段时间里别人写的条目一起带走。
      const merges = []
      for (const mg of plan.merge ?? []) {
        if (!Array.isArray(mg.ids) || mg.ids.length < 2) continue
        const ids = mg.ids.filter((id) => batch.some((b) => b.id === id))
        if (ids.length < 2) continue
        const into = String(mg.into ?? '').trim()
        if (into === '') continue
        merges.push({ ids, into, reason: mg.reason ?? '', vec: (await embedTexts([into]))?.[0] ?? null })
      }
      const dropIds = (plan.drop ?? []).filter((id) => batch.some((b) => b.id === id))
      const insight = String(plan.insight ?? '').trim()
      const insightVec = insight === '' ? null : ((await embedTexts([insight]))?.[0] ?? null)

      let mergedCount = 0
      let dropped = 0
      try {
        inTx(() => {
          for (const m of merges) {
            db.prepare('UPDATE entries SET a = ?, w = w + 1, vec = ? WHERE id = ?').run(
              `${m.into}\n（合并自 ${m.ids.length} 条：${m.reason}）`, vecToBlob(m.vec), m.ids[0],
            )
            for (const id of m.ids.slice(1)) db.prepare('DELETE FROM entries WHERE id = ?').run(id)
            mergedCount += m.ids.length - 1
          }
          for (const id of dropIds) {
            db.prepare('DELETE FROM entries WHERE id = ?').run(id)
            dropped++
          }
          if (insight !== '') {
            db.prepare('INSERT INTO entries(u,a,t,w,emo,vec,hot) VALUES(?,?,?,?,?,?,0)').run(
              `（规律）${insight}`,
              '（这是从多条记忆里总结出的规律，不是用户原话）',
              Date.now(), 3, '[]', vecToBlob(insightVec),
            )
          }
        })
      } catch (error) {
        // 已经整批回滚：一条都没删，把原因带回去，别让调用方以为成功了。
        return { error: 'tx-failed', detail: String(error?.message ?? error).slice(0, 200), merged: 0, dropped: 0 }
      }
      stampConsolidated()

      // 顺手把画像用模型重写一遍：规则版只列事实，这一版才是「我记得的你」。
      let personaWritten = false
      try {
        // L3（画像）低频，值得换更强的模型；没配就跟 L1 同一条路由。
        const personaRoute = (typeof routeFor === 'function' ? routeFor('l3') : null) ?? route
        personaWritten = await writePersonaLlm(llm, personaRoute, db, space)
      } catch { /* 画像写不出来不影响梳理 */ }

      return {
        merged: mergedCount, dropped, insight: insight || null, count: batch.length, personaWritten,
      }
    } finally {
      consolidating = false
    }
  }

  return { consolidateNow }
}


/**
 * 「梳理 + 顺手把派生数据重建一遍」的那个口子：接口手动触发时用。
 *
 * 顺序是先散点后成段，场景跟着记忆走；画像跟着场景走；图谱按空间各建一次。
 * 原样从 index.mjs 搬过来，逻辑一个字没改。
 *
 * @param {object} deps 依赖
 * @param {object} deps.db 库
 * @param {Function} deps.consolidateNow 梳理
 * @param {Function} deps.space 当前记忆空间
 * @returns {Function} 带重建的梳理
 */
export function createConsolidateAll({ db, consolidateNow, space }) {
  return async (opts) => {
    const r = await consolidateNow(opts)
    try {
      rebuildScenes(db)
      rebuildPersona(db, { space: space() })
      for (const sp of (() => {
        try { return db.prepare('SELECT DISTINCT space FROM entries').all().map((r) => String(r.space)) } catch { return ['default'] }
      })()) rebuildGraph(db, { space: sp })
    } catch { /* 建不出来不影响结果 */ }
    return r
  }
}
