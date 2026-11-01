/**
 * 记忆注入：每次开口前，把相关旧事、事实、最近几轮、日记和群摘要拼进上下文。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PART_CAP, DIARY_INJECT_MAX, IMPORTANT_WEIGHT, RECALL_LINE_CAP, TIER_PENALTY } from './constants.mjs'
import { detectEmotions, cueWords, scoreMemory, rrf, cosine } from './language.mjs'
import { textOf, clamp } from './format.mjs'
import { handoverNudge } from './handover.mjs'
import { blobToVec, embedTexts } from './vector.mjs'
import { isPrivateSession } from './session.mjs'
import { matchScenes } from './scenes.mjs'
import { entitiesIn, neighbors } from './graph.mjs'

/**
 * 造记忆注入器。
 *
 * @param {object} deps 依赖
 * @returns {{build:Function}}
 */
export function createRecall(deps) {
  const {
    db, memoryDir, bumpStat, space,
    budgetChars, factMax, recentPairs, recallMax, recallThreshold, weightMax,
  } = deps

  /**
   * 组一段记忆注入文本；没有可注入的东西就返回 null。
   */
  /**
   * 重启后第一件事：读交接条。
   *
   * 上下文是按会话走的，重启就断；但「我是谁、上次做到哪、下一步做什么」这三件事
   * 必须活着。写成文件，每轮注入最前面，字数压到 400 以内。
   */
  /** 交接条跟着数据库放在一起，属于插件自己的数据。 */
  const handoverDir = () => {
    try {
      const p = String(db.prepare('PRAGMA database_list').get()?.file ?? '')
      return p === '' ? memoryDir : dirname(p)
    } catch { return memoryDir }
  }

  /** 声音文件：比记忆更靠前，先定语气再谈事实。 */
  const readVoice = () => {
    try {
      const p = String(db.prepare('PRAGMA database_list').get()?.file ?? '')
      const dir = p === '' ? memoryDir : dirname(p)
      const raw = readFileSync(join(dirname(dir), 'notes', 'VOICE.md'), 'utf8')
      return clamp(raw.replace(/^#.*$/gmu, '').replace(/\n{2,}/gu, '；').trim(), 260)
    } catch { return '' }
  }

  const readHandover = () => {
    try {
      const raw = readFileSync(join(handoverDir(), 'HANDOVER.md'), 'utf8')
      const text = raw.replace(/^#.*$/gmu, '').replace(/\n{3,}/gu, '\n\n').trim()
      return text === '' ? '' : clamp(text, 400)
    } catch {
      return ''
    }
  }

  const build = async ({ agent, messages }) => {
    const userText = messages
      .filter((m) => m && m.source && m.source.kind === 'user')
      .map(textOf)
      .join('\n')
      .trim()

    const emotions = detectEmotions(userText)
    const cues = userText !== '' ? cueWords(userText) : []
    const now = Date.now()

    // 当前消息向量：只在真要联想时才去要，闲聊轮不必付这一次网络延迟。
    let queryVec = null
    const embedQuery = async () => {
      if (queryVec !== null || userText === '') return queryVec
      queryVec = (await embedTexts([userText]))?.[0] ?? null
      return queryVec
    }

    const parts = []
    let budget = budgetChars()
    const push = (label, body) => {
      if (!body) return
      const block = `${label}\n${body}`
      if (block.length > budget) return
      parts.push(block)
      budget -= block.length
    }

    const voice = readVoice()
    if (voice !== '') push('声音（先读这个，再看记忆）：', voice)

    // 重启后先看交接条
    const handover = readHandover()
    if (handover !== '') {
      const nudge = handoverNudge(handover)
      push('交接条（重启后先看这个）：', handover + (nudge === '' ? '' : `\n（${nudge}）`))
    }

    // 自己醒来的回合：没有入站消息 —— 这时候要给的不是「记得什么」，而是「接着做什么」
    const isSelfWake = userText === ''
    if (isSelfWake) {
      const next = handover.match(/\*\*下一步\*\*[：:]\s*([^\n]+)/u)?.[1] ?? ''
      push(
        '这是你自己醒的，没人叫你。',
        (next === '' ? '没有排好的下一步。' : `上次留给你的下一步：${next}`) +
          '\n自唤醒固定三件事，按顺序：一、读交接条；二、往日记里写一两句今天的话（写下来才算发生过）；' +
          '三、看要不要找人说话。做完就停，别硬耗；做不动就把卡点写回 HANDOVER.md。',
      )
    }

    // 最近的日记：给上下文一点「昨天我也在」的连续性
    try {
      const diaries = db.prepare('SELECT day, text FROM diary ORDER BY day DESC LIMIT ?')
        .all(DIARY_INJECT_MAX).reverse()
      if (diaries.length > 0) {
        push(
          '我最近写下的日记（我自己的记录，不是用户说的话）：',
          diaries.map((d) => `${d.day}：${clamp(d.text, 120)}`).join('\n'),
        )
      }
    } catch { /* 表还没建好就跳过 */ }

    const spaceOf = String(space?.() ?? 'default')

    const facts = db.prepare('SELECT f FROM facts WHERE space=? ORDER BY id DESC LIMIT ?')
      .all(spaceOf, factMax()).map((r) => r.f)
    if (facts.length > 0) push('已确认的关于用户的事实：', facts.map((f) => `- ${f}`).join('\n'))

    const recent = db.prepare('SELECT u,a FROM entries WHERE hot=1 AND space=? ORDER BY t DESC LIMIT ?')
      .all(spaceOf, recentPairs())
    if (recent.length > 0) {
      push('最近几轮的对话：',
        recent.reverse().map((r) => `用户: ${clamp(r.u, PART_CAP)} → 你: ${clamp(r.a, PART_CAP)}`).join('\n'))
    }

    // ---- 单向同步：私聊里补一份群聊摘要 ----
    //
    // 群聊和私聊是两个 session，私聊看不到群里刚发生什么。
    // 这里只在私聊会话注入，群聊会话不注入（否则重复）。
    // 方向是单向的：群 → 私聊，私聊的内容不回流群聊。
    const sessionId = String(agent?.session?.id ?? '')
    if (isPrivateSession(sessionId)) {
      const digestPath = join(memoryDir, 'group-digest.json')
      try {
        const dg = JSON.parse(readFileSync(digestPath, 'utf8'))
        // 摘要太旧（超过 12 小时）就不提了，免得说「刚才群里」其实是一天前
        if (Date.now() - (dg.generatedAt ?? 0) < 12 * 3600 * 1000 && Array.isArray(dg.lines) && dg.lines.length > 0) {
          push(
            `群里最近在聊（${dg.people?.length ?? 0} 人，仅供了解，不必主动接话）：`,
            dg.lines.slice(-5).join('\n'),
          )
        }
      } catch { /* 摘要读不了就跳过 */ }
    }

    // ---- 场景层：同一条线索下的旧事，按时间串成一段 ----
    //
    // 单条记忆各说一半，问「那个 bug 后来怎样了」答不全；场景是线，先给线再给点。
    if (userText !== '' && cues.length > 0) {
      try {
        const hit = matchScenes(db, { text: userText, limit: 1, space: spaceOf })
        if (hit.length > 0) {
          push(
            `相关场景（线索：${hit[0].topic}，${hit[0].n} 条旧事按时间串起来的）：`,
            hit[0].body.split('\n').slice(0, 4).join('\n'),
          )
          bumpStat('sceneRecall')
        }
      } catch { /* 场景表还没建就跳过 */ }
    }

    // ---- 图谱：这轮提到的人或东西，最近总跟谁一起出现 ----
    if (userText !== '') {
      try {
        const names = entitiesIn(db, userText, 1, spaceOf)
        const lines = []
        for (const name of names) {
          const ns = neighbors(db, name, 3, spaceOf).map((n) => `${n.name}(${n.w})`)
          if (ns.length > 0) lines.push(`- ${name} 常一起出现：${ns.join('、')}`)
        }
        if (lines.length > 0) {
          push('关联（只是共现统计，别当成因果）：', lines.join('\n'))
          bumpStat('graphRecall')
        }
      } catch { /* 图谱还没建就跳过 */ }
    }

    // ---- 主动联想：真向量打分 ----
    if (emotions.length > 0 || cues.length > 0) {
      await embedQuery()
      const hotIds = new Set(recent.map((r) => r.id))
      const sessionKey = String(agent?.session?.id ?? '') || 'anon'

      // 本会话已经给过的不再给：上下文里已经有了，重复注入只是白烧 token。
      let seen = new Set()
      try {
        seen = new Set(db.prepare('SELECT entry_id FROM recall_seen WHERE session=?')
          .all(sessionKey).map((r) => r.entry_id))
      } catch { /* 表还没建就当没去重 */ }

      const cold = db.prepare('SELECT id,u,a,t,w,emo,vec,tier FROM entries WHERE hot=0 AND space=? ORDER BY t DESC LIMIT 300')
        .all(spaceOf)
      const scored = cold
        .filter((r) => !hotIds.has(r.id) && !seen.has(r.id))
        .map((r) => ({
          r,
          emo: JSON.parse(r.emo || '[]'),
          vec: blobToVec(r.vec),
        }))
        .map((x) => {
          const base = scoreMemory({ ...x.r, emo: x.emo, vec: x.vec }, { emotions, text: userText, cues, queryVec, now })
          // 时效衰减：相关度相近时新的优先，老记忆最多损失一半排序分（地板 0.5，长期事实不沉底）。
          const days = Math.max(0, (now - x.r.t) / 86400000)
          const decay = Math.max(0.5, 0.5 ** (days / 30))
          // 层级惩罚：深的往后排，但只是边角分——向量/情绪仍是主权重。
          // 印象深的（w ≥ 8）不罚，免得重要条目被层级压到检索不到。
          const tier = Math.min(Math.max(0, Number(x.r.tier ?? 0)), 9)
          const penalty = (x.r.w ?? 1) >= IMPORTANT_WEIGHT ? 0 : tier * TIER_PENALTY
          return { ...x, s: base * decay - penalty }
        })
        .filter((x) => x.s > recallThreshold())

      // 混合检索：关键词一路、向量一路，用 RRF 融合后给排序加一点共识分。
      // 两路都排到前面的条目最可信；只有一路命中的也不至于被丢掉。
      let fused = []
      if (queryVec) {
        const byKeyword = [...scored].sort((a, b) => b.s - a.s).map((x) => x.r.id)
        const byVector = [...scored]
          .sort((a, b) => (cosine(queryVec, b.vec) || 0) - (cosine(queryVec, a.vec) || 0))
          .map((x) => x.r.id)
        const rank = new Map(rrf([byKeyword, byVector]).map(([id], i) => [id, i]))
        fused = scored
          .map((x) => ({ ...x, s: x.s + (recallMax() - (rank.get(x.r.id) ?? recallMax())) * 0.4 }))
          .sort((a, b) => b.s - a.s)
          .slice(0, recallMax())
      } else {
        fused = scored.sort((a, b) => b.s - a.s).slice(0, recallMax())
      }
      scored.length = 0
      scored.push(...fused)

      if (scored.length > 0) {
        const kind = emotions.length > 0 ? `情绪(${emotions.join('/')})` : '话题'
        push(
          `主动想起的相关旧事（因${kind}相关而取用；若确实贴合可自然提一句，否则忽略）：`,
          scored.map((x, i) => {
            const w = x.r.w ?? 1
            const tag = w >= IMPORTANT_WEIGHT ? '〔印象深刻〕' : ''
            const noisy = x.r.u.startsWith('（联想）') ? '〔联想·非对话〕' : ''
            return `${i + 1}. ${tag}${noisy}用户: ${clamp(x.r.u, RECALL_LINE_CAP)} → 你: ${clamp(x.r.a, RECALL_LINE_CAP)}`
          }).join('\n'),
        )
        // 被想起 → 权重累积、命中数 +1、层级回到浅一层；顺手记下「这条已经给过这个会话」。
        // 三件事合成一条 UPDATE：召回路径上每轮每条只写一次，别把库写爆。
        const up = db.prepare(
          'UPDATE entries SET w = MIN(w + 1, ?), hits = hits + 1, tier = MAX(tier - 1, 0) WHERE id = ?',
        )
        const mark = db.prepare('INSERT OR IGNORE INTO recall_seen (session, entry_id, at) VALUES (?,?,?)')
        const counted = new Set()
        for (const x of scored) {
          // 一轮里同一条只加一次（fused 之后 id 本来就唯一，这里再兜一层）。
          if (!counted.has(x.r.id)) {
            counted.add(x.r.id)
            // 写不进去也不能把这一轮对话带崩（FTS 触发器就挂在这条 UPDATE 上）。
            try { up.run(weightMax(), x.r.id) } catch { /* 忽略 */ }
          }
          try { mark.run(sessionKey, x.r.id, now) } catch { /* 去重记不上不影响注入 */ }
        }
        // 老记录定期清，别让去重表无限长。
        try { db.prepare('DELETE FROM recall_seen WHERE at < ?').run(now - 7 * 86400000) } catch { /* 忽略 */ }
        bumpStat('recalled')
      }
    }

    // 一条内容都没有就返回 null：格式规矩在系统提示里已经有了，
    // 不必为一句「不换行」把一整块空记忆塞进上下文。
    if (parts.length === 0) return null
    if (voice === '') parts.unshift('群聊格式：\n回话必须是一整段，不换行、不空行、不列表。')

    const text = `（记忆参考——只可使用下列已发生的事实，严禁编造：\n\n${parts.join('\n\n')}）`
    // 记账：每轮注入多少字，配置调过头时能看见
    try { bumpStat('injectChars', text.length) } catch { /* 记不上不影响注入 */ }
    return { text, count: parts.length }
  }

  return { build }
}
