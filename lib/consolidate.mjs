/**
 * 自己梳理记忆：让模型判断哪些该合并、哪些该删、能看出什么规律；
 * 模型不可用时退回纯向量合并。
 */
import { IMPORTANT_WEIGHT } from './constants.mjs'
import { vecToBlob, blobToVec, embedTexts } from './vector.mjs'
import { detectEmotions, cosine } from './language.mjs'
import { clamp } from './format.mjs'

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
      const list = batch.map((e) => `[${e.id}] 用户: ${e.u}\n      你: ${e.a}`).join('\n\n')
      const prompt = `你在整理一个 AI 助手的长期记忆库。下面是一批记忆条目，每条有编号。

${list}

请判断怎么整理，只输出 JSON，不要解释：

{
  "merge": [{"ids": [3, 7], "into": "合并后的一句话", "reason": "为什么合并"}],
  "drop": [12, 15],
  "insight": "从这批记忆里总结出的关于用户的一条规律，没有就留空"
}

规则：
- merge：内容重复或高度相似的才合并
- drop：完全没有信息量的（纯问候、纯表情、单字回复）
- insight：只写能明确看出的规律，不要编
- 宁可少做，不要错做`

      // llm 服务可能晚于插件就绪，用之前现取。
      const llm = getLlm()
      if (!llm || typeof llm.prepareCall !== 'function') {
        const r = vectorConsolidate()
        return { fallback: 'vector', ...r }
      }

      // L1（合并/去重）高频调用，默认让它走便宜的模型；配置了 llm.l1 就用配置的。
      const route = opts.route ?? (typeof routeFor === 'function' ? routeFor('l1') : defaultRoute())
      if (!route) {
        const r = vectorConsolidate()
        return { fallback: 'no-route', ...r }
      }

      // 加超时：网关不通时不能一直挂着，否则接口调用会卡死
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 60_000)

      let text = ''
      try {
        // 正确用法（照 translator/src/deepseek.ts）：
        //   prepareCall(config, signal) —— 传对象，不是 (provider, model, signal)
        //   stream({ ...prepared.config, system, messages, signal })
        // 用 prepared.config 展开而不是手写 provider/model，否则 INVALID_PREPARED_CALL。
        // 控制项（temperature/maxTokens）必须在 prepareCall 的 config 里就给，
        // 否则 callConfigEquals 会判定「config changed before adapter dispatch」——
        // 它拿 options 里这几项和 resolvedConfig 逐一比对。
        const control = { provider: route.provider, model: route.model, temperature: 0.2, maxTokens: 3000, reasoningEffort: 'off' }
        const prepared = await llm.prepareCall(control, ac.signal)
        const options = {
          ...prepared.config,
          system: '你是一个精于整理记忆的助手。只输出 JSON，不要解释。',
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          signal: ac.signal,
        }

        // StreamChunk 只有 text-delta（没有裸 text），照 types.ts 的定义来
        for await (const chunk of prepared.stream(options)) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        }
      } catch (e) {
        clearTimeout(timer)
        // 调不通就降级，不把错误抛给调用方。
        // 把关键配置也带回来，否则只能靠猜。
        const r = vectorConsolidate()
        return {
          fallback: 'llm-failed',
          error: String(e?.message ?? e).slice(0, 200),
          route,
          ...r,
        }
      }
      clearTimeout(timer)

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
        personaWritten = await writePersonaLlm(llm, personaRoute, db)
      } catch { /* 画像写不出来不影响梳理 */ }

      return {
        merged: mergedCount, dropped, insight: insight || null, count: batch.length, personaWritten,
      }
    } finally {
      consolidating = false
    }
  }

  /** 纯向量兜底：只合余弦 >0.85 的，删掉空壳。 */
  const vectorConsolidate = () => {
    const cold = db.prepare(`
      SELECT id,u,a,t,w,vec FROM entries
      WHERE hot=0 AND w < ? AND u NOT LIKE '（联想）%'
      ORDER BY t ASC LIMIT 200
    `).all(IMPORTANT_WEIGHT)

    if (cold.length < 3) return { merged: 0, dropped: 0 }

    const withVec = cold.map((r) => ({ r, vec: blobToVec(r.vec) }))
    const used = new Set()

    try {
      const out = inTx(() => {
        let merged = 0
        for (let i = 0; i < withVec.length; i++) {
          if (used.has(i)) continue
          const group = [withVec[i]]
          used.add(i)
          for (let j = i + 1; j < withVec.length; j++) {
            if (used.has(j)) continue
            if (cosine(withVec[i].vec, withVec[j].vec) > 0.85) { group.push(withVec[j]); used.add(j) }
          }
          if (group.length < 2) continue
          group.sort((a, b) => `${b.r.u}${b.r.a}`.length - `${a.r.u}${a.r.a}`.length)
          const head = group[0]
          const rest = group.slice(1)
          db.prepare('UPDATE entries SET a = ?, w = ? WHERE id = ?').run(
            `${head.r.a}\n（另有 ${rest.length} 次相近，已合并）`,
            Math.max(...group.map((g) => g.r.w ?? 1)), head.r.id,
          )
          for (const g of rest) db.prepare('DELETE FROM entries WHERE id = ?').run(g.r.id)
          merged += rest.length
        }

        const junk = db.prepare(`
          SELECT id FROM entries WHERE hot=0 AND w < ? AND LENGTH(TRIM(u)) < 3
        `).all(IMPORTANT_WEIGHT)
        for (const j of junk) db.prepare('DELETE FROM entries WHERE id = ?').run(j.id)

        return { merged, dropped: junk.length }
      })
      stampConsolidated()
      return out
    } catch (error) {
      return { merged: 0, dropped: 0, error: String(error?.message ?? error).slice(0, 200) }
    }
  }


  /**
   * 用模型把散记忆写成一小段画像。
   *
   * 只写「看得出来」的：事实归事实，推测归推测；宁短不编。
   *
   * @param {object} llm llm 服务
   * @param {{provider:string,model:string}} route 路由
   * @param {object} db 记忆库
   * @returns {Promise<boolean>} 是否写成功
   */
  const writePersonaLlm = async (llm, route, db) => {
    const activeSpace = String((typeof space === 'function' ? space() : 'default') ?? 'default')
    const facts = db.prepare('SELECT f FROM facts WHERE space=? ORDER BY id DESC LIMIT 12').all(activeSpace).map((r) => r.f)
    const scenes = (() => {
      try {
        return db.prepare('SELECT topic, body FROM scenes WHERE space=? ORDER BY updated DESC LIMIT 6').all(activeSpace)
      } catch { return [] }
    })()
    const recent = db.prepare('SELECT u FROM entries WHERE hot=0 ORDER BY t DESC LIMIT 15').all()
    if (facts.length === 0 && recent.length === 0) return false

    const material = [
      facts.length > 0 ? `事实：\n${facts.map((f) => `- ${f}`).join('\n')}` : '',
      scenes.length > 0 ? `成段的旧事：\n${scenes.map((s) => `- ${s.topic}：${String(s.body).split('\n').slice(0, 2).join(' / ')}`).join('\n')}` : '',
      recent.length > 0 ? `最近聊到：\n${recent.map((r) => `- ${String(r.u ?? '').slice(0, 40)}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n')

    const prompt = `下面是我记住的材料，请写一段「我记得的你」，120 字以内，第二人称（叫对方「你」、叫自己「我」），只写材料里能看出来的：
- 事实与推测分开写，推测要带「也许」「可能」
- 不写套话，不写心理分析，不评价这个人
- 没有材料支撑的不要写
- 不要写「你让某某做插件」这类把我和别人混在一起的话

${material}`

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 45_000)
    try {
      const control = { provider: route.provider, model: route.model, temperature: 0.4, maxTokens: 1200, reasoningEffort: 'off' }
      const prepared = await llm.prepareCall(control, ac.signal)
      const options = {
        ...prepared.config,
        system: '你在给自己写一小段关于对方的画像：用「你」称呼对方，用「我」称呼自己，不要把两个人的身份写混。只输出正文。',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        signal: ac.signal,
      }
      let text = ''
      for await (const chunk of prepared.stream(options)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      }
      const body = text.trim().slice(0, 600)
      if (body.length < 10) return false
      db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('personaLLM', ?)").run(body)
      db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('personaLLMAt', ?)").run(String(Date.now()))
      return true
    } finally {
      clearTimeout(timer)
    }
  }

  return { consolidateNow }
}
