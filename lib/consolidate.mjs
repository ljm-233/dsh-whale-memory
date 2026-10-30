/**
 * 自己梳理记忆：让模型判断哪些该合并、哪些该删、能看出什么规律；
 * 模型不可用时退回纯向量合并。
 */
import { IMPORTANT_WEIGHT } from './constants.mjs'
import { vecToBlob, embedTexts } from './vector.mjs'
import { detectEmotions } from './language.mjs'
import { clamp } from './format.mjs'

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
  const { db, bumpStat, defaultRoute, getLlm } = deps


  // ---- 自己梳理记忆 ----
  //
  // 不是外挂脚本，而是在插件内直接调 ctx.llm：
  //   1. 取一批冷区记忆
  //   2. 让模型判断：哪些该合并、哪些该删、能看出什么规律
  //   3. 按判断改库
  //
  // 模型不可用时退回纯向量合并（只合余弦 >0.85 的）。
  let consolidating = false

  const consolidateNow = async (opts = {}) => {
    if (consolidating) return { skipped: 'busy' }
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

      // 用当前会话的路由（若拿不到就用配置里的）
      const route = opts.route ?? defaultRoute()
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
        const control = { provider: route.provider, model: route.model, temperature: 0.2, maxTokens: 1200 }
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

      const m = text.match(/\{[\s\S]*\}/u)
      if (!m) return { fallback: 'no-json', raw: text.slice(0, 200) }

      let plan
      try { plan = JSON.parse(m[0]) } catch { return { fallback: 'bad-json' } }

      if (opts.dry) return { dry: true, plan, count: batch.length }

      // 执行合并
      let mergedCount = 0
      for (const mg of plan.merge ?? []) {
        if (!Array.isArray(mg.ids) || mg.ids.length < 2) continue
        const ids = mg.ids.filter((id) => batch.some((b) => b.id === id))
        if (ids.length < 2) continue
        const into = String(mg.into ?? '').trim()
        if (into === '') continue

        const keep = ids[0]
        const vec = (await embedTexts([into]))?.[0] ?? null
        db.prepare('UPDATE entries SET a = ?, w = w + 1, vec = ? WHERE id = ?').run(
          `${into}\n（合并自 ${ids.length} 条：${mg.reason ?? ''}）`, vecToBlob(vec), keep,
        )
        for (const id of ids.slice(1)) db.prepare('DELETE FROM entries WHERE id = ?').run(id)
        mergedCount += ids.length - 1
      }

      // 执行删除
      let dropped = 0
      for (const id of plan.drop ?? []) {
        if (!batch.some((b) => b.id === id)) continue
        db.prepare('DELETE FROM entries WHERE id = ?').run(id)
        dropped++
      }

      // 记录规律
      const insight = String(plan.insight ?? '').trim()
      if (insight !== '') {
        const vec = (await embedTexts([insight]))?.[0] ?? null
        db.prepare('INSERT INTO entries(u,a,t,w,emo,vec,hot) VALUES(?,?,?,?,?,?,0)').run(
          `（规律）${insight}`,
          '（这是从多条记忆里总结出的规律，不是用户原话）',
          Date.now(), 3, '[]', vecToBlob(vec),
        )
      }

      bumpStat('consolidated')
      return { merged: mergedCount, dropped, insight: insight || null, count: batch.length }
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
  }

  return { consolidateNow }
}
