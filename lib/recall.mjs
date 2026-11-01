/**
 * 记忆卡：拼进 runtime-context 的那一份「我是谁 / 记得什么」。
 *
 * 分两层：
 * - 轻查询（声音/交接条/日记/事实/热区/群摘要）同步读 sqlite 和文件——每步组装都要现算，必须便宜。
 * - 重检索（「这一句在说什么」的语义联想）异步算一次，结果按 session 存一小格缓存，card() 只同步读。
 *
 * 为什么不把联想也塞进 card()：card 每步组装都被调一次（一轮 N 步就是 N 次），
 * 而联想要打一次本地嵌入服务、还要扫几百条冷区。放进 card = 同一件事一轮做 N 次；
 * 异步算一次 + 同步读缓存 = 一轮只付一次，且绝不 await、绝不阻塞对话。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DIARY_INJECT_MAX, IMPORTANT_WEIGHT, RECALL_MAX, RECALL_SECTION_CAP, RECALL_THRESHOLD, TIER_PENALTY,
} from './constants.mjs'
import { detectEmotions, cueWords, scoreMemory } from './language.mjs'
import { cardLine, clamp } from './format.mjs'
import { numCfg } from './shared.mjs'
import { blobToVec, embedTexts } from './vector.mjs'
import { handoverNudge } from './handover.mjs'
import { listFacts } from './facts.mjs'
import { isPrivateSession } from './session.mjs'

/** 联想缓存最多记几个会话；超了丢最老的，别让一张 Map 长成泄漏。 */
const ASSOC_MAX = 8
/** 一轮里算太久还没用上就别用了。 */
const ASSOC_TTL_MS = 10 * 60 * 1000

/**
 * 造记忆卡。
 *
 * @param {object} deps 依赖
 * @returns {{card:Function, associate:Function}}
 */
export function createRecall(deps) {
  const {
    db, memoryDir, bumpStat, space, budgetChars, factMax, recentPairs,
    recallMax, recallThreshold, tierPenalty,
  } = deps

  /** 上一次组装出来的原文：同一步里会被反复组装，别把统计刷成几倍。 */
  let lastText = ''

  /**
   * session → { turn, lines, at }。
   *
   * key 是 session id：群聊、私聊、子 agent 各算各的，不串味。
   * 生命周期只有一轮：associate() 一开头就 turn+1 并清空 lines，
   * 所以上一条用户消息算出来的联想不到下一个回合（key 相同，内容已作废）。
   */
  const ASSOC = new Map()

  /** 层级惩罚：插件配置优先，缺省回落常量，越界夹到 0..1。 */
  const tierPenaltyOf = () => numCfg(tierPenalty?.(), TIER_PENALTY, 0, 1)

  /** 读当前轮的联想段；没有、过期、或属于上一轮就给空串——调用方当它不存在。 */
  const relatedOf = (sessionId) => {
    const key = String(sessionId ?? '')
    const st = ASSOC.get(key)
    if (!st || st.lines === '') return ''
    if (Date.now() - st.at > ASSOC_TTL_MS) {
      ASSOC.delete(key)
      return ''
    }
    return st.lines
  }

  /**
   * 算这一轮的联想段，算完写缓存。
   *
   * 调用方不 await 它（fire-and-forget）：算不出来、嵌入服务挂了、库坏了，
   * 这一轮就只是没有联想段，对话照常走。
   *
   * @param {string} sessionId 会话 id
   * @param {string} userText 这一轮用户说的话
   * @returns {Promise<string>} 写进缓存的那一份
   */
  const associate = async (sessionId, userText) => {
    const key = String(sessionId ?? '') || 'anon'
    // 先换一轮：同步完成，所以旧联想在新消息落地那一瞬就废掉，正在算的那条也写不进来。
    const turn = (ASSOC.get(key)?.turn ?? 0) + 1
    ASSOC.set(key, { turn, lines: '', at: Date.now() })
    while (ASSOC.size > ASSOC_MAX) ASSOC.delete(ASSOC.keys().next().value)

    const text = String(userText ?? '').trim()
    // 上限取配置，但整段最多还是 RECALL_MAX 条：卡再短，多了也挤。
    const limit = Math.min(Math.max(0, Number(recallMax?.() ?? RECALL_MAX) || 0), RECALL_MAX)
    if (text === '' || limit === 0) return ''
    try {
      const emotions = detectEmotions(text)
      const cues = cueWords(text)
      const now = Date.now()
      // 只在真要联想时才要向量；服务挂了就退回二元组重叠，不阻塞。
      const queryVec = (await embedTexts([text]))?.[0] ?? null
      if (emotions.length === 0 && cues.length === 0 && queryVec === null) return ''

      const spaceOf = String(space?.() ?? 'default')
      const hotIds = new Set(db.prepare('SELECT id FROM entries WHERE hot=1 AND space=? ORDER BY t DESC LIMIT ?')
        .all(spaceOf, recentPairs()).map((r) => r.id))
      const cold = db.prepare('SELECT id,u,a,t,w,emo,vec,tier FROM entries WHERE hot=0 AND space=? ORDER BY t DESC LIMIT 300')
        .all(spaceOf)

      const scored = cold
        .filter((r) => !hotIds.has(r.id))
        .map((r) => {
          const base = scoreMemory(
            { ...r, emo: JSON.parse(r.emo || '[]'), vec: blobToVec(r.vec) },
            { emotions, text, cues, queryVec, now },
          )
          // 时效衰减：相关度相近时新的优先，老记忆最多损失一半排序分（地板 0.5）。
          const days = Math.max(0, (now - r.t) / 86400000)
          const decay = Math.max(0.5, 0.5 ** (days / 30))
          // 层级惩罚：深的往后排，但只是边角分。印象深的（w ≥ 8）不罚。
          const tier = Math.min(Math.max(0, Number(r.tier ?? 0)), 9)
          const penalty = (r.w ?? 1) >= IMPORTANT_WEIGHT ? 0 : tier * tierPenaltyOf()
          return { r, s: base * decay - penalty }
        })
        .filter((x) => x.s > Number(recallThreshold?.() ?? RECALL_THRESHOLD))
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)

      // 每条只给一张六字段卡（正文另读），整段硬上限 RECALL_SECTION_CAP。
      const cards = []
      let used = 0
      for (const x of scored) {
        const line = cardLine(x.r, { keyword: text, score: x.s, now })
        if (line === '') continue
        if (used + line.length + (cards.length === 0 ? 0 : 1) > RECALL_SECTION_CAP) break
        cards.push(line)
        used += line.length + (cards.length === 0 ? 0 : 1)
      }
      const lines = cards.join('\n')

      // 算的过程中又来了新消息（turn 变了）：这份不属于当前轮，丢掉。
      if (ASSOC.get(key)?.turn !== turn) return ''
      ASSOC.set(key, { turn, lines, at: Date.now() })
      return lines
    } catch {
      return ''
    }
  }

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

  /**
   * 索引指针：只列「有哪些文件、一句话说明」，60 字以内。
   * 目的不是内容，是让我每轮都记得「还有这几份东西可翻」。
   */
  const readIndexPointer = () => {
    try {
      const p = String(db.prepare('PRAGMA database_list').get()?.file ?? '')
      const dir = p === '' ? memoryDir : dirname(p)
      const raw = readFileSync(join(dirname(dir), 'INDEX.md'), 'utf8')
      // 索引里的表格行：| `路径` | 说明 |
      const rows = [...raw.matchAll(/^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|$/gmu)]
        .slice(0, 12)
        .map((m) => `${m[1]}（${clamp(m[2].replace(/[。；]/gu, ''), 14)}）`)
      return rows.length === 0 ? '' : clamp(`可翻的文件：${rows.join('、')}`, 300)
    } catch { return '' }
  }

  /** 重启后第一件事：读交接条。 */
  const readHandover = () => {
    try {
      const raw = readFileSync(join(handoverDir(), 'HANDOVER.md'), 'utf8')
      const text = raw.replace(/^#.*$/gmu, '').replace(/\n{3,}/gu, '\n\n').trim()
      return text === '' ? '' : clamp(text, 400)
    } catch {
      return ''
    }
  }

  /**
   * 组一段记忆卡文本。取不到任何东西就返回空串——空串在 runtime-context 里等于不存在，
   * 比抛错安全：宁可这一轮没有记忆，也不能把对话卡住。
   *
   * @param {object} [agent] 当前 agent（只为判断私聊，缺了也能跑）
   * @returns {string}
   */
  const card = (agent) => {
    try {
      const parts = []
      const budgetMax = budgetChars()
      let budget = budgetMax
      const push = (label, body) => {
        if (!body) return
        const block = `${label}\n${body}`
        if (block.length > budget) return
        parts.push(block)
        budget -= block.length
      }

      const idx = readIndexPointer()
      if (idx !== '') push('我的文件（想看细节就照名字去翻）：', idx)

      const voice = readVoice()
      if (voice !== '') push('声音（先读这个，再看记忆）：', voice)

      const handover = readHandover()
      if (handover !== '') {
        const nudge = handoverNudge(handover)
        push('交接条（重启后先看这个）：', handover + (nudge === '' ? '' : `\n（${nudge}）`))
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

      try {
        // 只注仍然成立的：被改口的事实留在库里，但不该再当当下的事实说。
        const facts = listFacts(db, { space: spaceOf, limit: factMax() }).map((r) => r.f)
        if (facts.length > 0) push('已确认的关于用户的事实：', facts.map((f) => `- ${f}`).join('\n'))
      } catch { /* 同上 */ }

      // 联想段：这一句在说什么相关的旧事。异步算好放缓存，这里只同步读——
      // 不 await、不查向量、不打嵌入服务。没有当前轮的缓存就整段跳过。
      const related = relatedOf(String(agent?.session?.id ?? ''))
      if (related !== '') {
        // 最多占整卡 1/3：联想是甜点，不能把热区和事实挤掉。
        const room = Math.min(Math.floor(budgetMax / 3), budget - 60)
        if (room > 40) push('和这次有关、你可能想起来的（不一定用得上，别硬往上贴）：', clamp(related, room))
      }

      try {
        const recent = db.prepare('SELECT u,a FROM entries WHERE hot=1 AND space=? ORDER BY t DESC LIMIT ?')
          .all(spaceOf, recentPairs())
        if (recent.length > 0) {
          push('最近几轮的对话：',
            recent.reverse().map((r) => `用户: ${clamp(r.u, 160)} → 你: ${clamp(r.a, 160)}`).join('\n'))
        }
      } catch { /* 同上 */ }

      // 单向同步：私聊里补一份群聊摘要。群聊会话本身不注（否则重复）。
      if (isPrivateSession(String(agent?.session?.id ?? ''))) {
        try {
          const dg = JSON.parse(readFileSync(join(memoryDir, 'group-digest.json'), 'utf8'))
          // 摘要太旧（超过 12 小时）就不提了，免得说「刚才群里」其实是一天前
          if (Date.now() - (dg.generatedAt ?? 0) < 12 * 3600 * 1000 && Array.isArray(dg.lines) && dg.lines.length > 0) {
            push(
              `群里最近在聊（${dg.people?.length ?? 0} 人，仅供了解，不必主动接话）：`,
              dg.lines.slice(-5).join('\n'),
            )
          }
        } catch { /* 摘要读不了就跳过 */ }
      }

      if (parts.length === 0) return ''
      const text = `（记忆参考——只可使用下列已发生的事实，严禁编造：\n\n${parts.join('\n\n')}）`
      if (text !== lastText) {
        lastText = text
        try { bumpStat('injectChars', text.length) } catch { /* 记不上不影响注入 */ }
      }
      return text
    } catch { return '' }
  }

  return { card, associate }
}
