/**
 * 记忆注入：每次开口前，把相关旧事、事实、最近几轮、日记和群摘要拼进上下文。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PART_CAP, DIARY_INJECT_MAX, IMPORTANT_WEIGHT } from './constants.mjs'
import { detectEmotions, cueWords, scoreMemory } from './language.mjs'
import { textOf, clamp } from './format.mjs'
import { blobToVec, embedTexts } from './vector.mjs'
import { isPrivateSession } from './session.mjs'

/**
 * 造记忆注入器。
 *
 * @param {object} deps 依赖
 * @returns {{build:Function}}
 */
export function createRecall(deps) {
  const {
    db, memoryDir, bumpStat,
    budgetChars, factMax, recentPairs, recallMax, recallThreshold, weightMax,
  } = deps

  /**
   * 组一段记忆注入文本；没有可注入的东西就返回 null。
   */
  const build = async ({ agent, messages }) => {
    const userText = messages
      .filter((m) => m && m.source && m.source.kind === 'user')
      .map(textOf)
      .join('\n')
      .trim()

    const emotions = detectEmotions(userText)
    const cues = userText !== '' ? cueWords(userText) : []
    const now = Date.now()

    // 当前消息向量（有服务就用，没有降级）
    const queryVec = userText !== '' ? (await embedTexts([userText]))?.[0] ?? null : null

    const parts = []
    let budget = budgetChars()
    const push = (label, body) => {
      if (!body) return
      const block = `${label}\n${body}`
      if (block.length > budget) return
      parts.push(block)
      budget -= block.length
    }

    // 最近的日记：给上下文一点「昨天我也在」的连续性
    try {
      const diaries = db.prepare('SELECT day, text FROM diary ORDER BY day DESC LIMIT ?')
        .all(DIARY_INJECT_MAX).reverse()
      if (diaries.length > 0) {
        push(
          '我最近写下的日记（我自己的记录，不是用户说的话）：',
          diaries.map((d) => `${d.day}：${clamp(d.text, 200)}`).join('\n'),
        )
      }
    } catch { /* 表还没建好就跳过 */ }

    const facts = db.prepare('SELECT f FROM facts ORDER BY id DESC LIMIT ?').all(factMax()).map((r) => r.f)
    if (facts.length > 0) push('已确认的关于用户的事实：', facts.map((f) => `- ${f}`).join('\n'))

    const recent = db.prepare('SELECT u,a FROM entries WHERE hot=1 ORDER BY t DESC LIMIT ?').all(recentPairs())
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

    // ---- 另一个窗口刚发生了什么 ----
    //
    // 私聊和群聊是两个 session：记忆库共享，但上下文各走各的。
    // 不补这一段，私聊里的我就是「不知道群里刚聊过什么」的我。
    try {
      const rows = db.prepare(`
        SELECT window, kind, text FROM events
        WHERE session != ? AND at >= ?
        ORDER BY at DESC LIMIT 8
      `).all(sessionId, Date.now() - 3 * 3600 * 1000)
      if (rows.length > 0) {
        push(
          '另一个窗口最近发生的事（同一个我，别装作没看见）：',
          rows.reverse().map((r) => `- ${r.kind === 'user' ? '用户' : r.kind === 'assistant' ? '我' : '工具'}：${clamp(r.text, 60)}`).join('\n'),
        )
      }
    } catch { /* 表还没建好就跳过 */ }

    // ---- 主动联想：真向量打分 ----
    if (emotions.length > 0 || cues.length > 0) {
      const hotIds = new Set(recent.map((r) => r.id))
      const cold = db.prepare('SELECT id,u,a,t,w,emo,vec FROM entries WHERE hot=0 ORDER BY t DESC LIMIT 500').all()
      const scored = cold
        .filter((r) => !hotIds.has(r.id))
        .map((r) => ({
          r,
          emo: JSON.parse(r.emo || '[]'),
          vec: blobToVec(r.vec),
        }))
        .map((x) => ({
          ...x,
          s: scoreMemory({ ...x.r, emo: x.emo, vec: x.vec }, { emotions, text: userText, cues, queryVec, now }),
        }))
        .filter((x) => x.s > recallThreshold())
        .sort((a, b) => b.s - a.s)
        .slice(0, recallMax())

      if (scored.length > 0) {
        const kind = emotions.length > 0 ? `情绪(${emotions.join('/')})` : '话题'
        push(
          `主动想起的相关旧事（因${kind}相关而取用；若确实贴合可自然提一句，否则忽略）：`,
          scored.map((x, i) => {
            const w = x.r.w ?? 1
            const tag = w >= IMPORTANT_WEIGHT ? '〔印象深刻〕' : ''
            const noisy = x.r.u.startsWith('（联想）') ? '〔联想·非对话〕' : ''
            return `${i + 1}. ${tag}${noisy}用户: ${clamp(x.r.u, PART_CAP)} → 你: ${clamp(x.r.a, PART_CAP)}`
          }).join('\n'),
        )
        // 被想起 → 权重累积
        const up = db.prepare('UPDATE entries SET w = MIN(w + 1, ?) WHERE id = ?')
        for (const x of scored) up.run(weightMax(), x.r.id)
        bumpStat('recalled')
      }
    }

    if (parts.length === 0) return null

    const text = `（记忆参考——只可使用下列已发生的事实，严禁编造：\n\n${parts.join('\n\n')}）`
    return { text, count: parts.length }
  }

  return { build }
}
