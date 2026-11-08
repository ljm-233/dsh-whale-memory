/**
 * 记忆卡的素材来源：这一轮要写进卡里的那些片段。
 *
 * 两类：
 * - 联想段（`associate`）：异步算、按 session 存一小格缓存，`card()` 只同步读——
 *   重检索绝不进 `card()`，否则一轮 N 步就是 N 次嵌入调用。
 * - 声音 / 现在 / 索引 / 交接条：同步读文件和库，每步组装都要现算，必须便宜。
 *
 * @module recall-assoc
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RECALL_MAX, RECALL_SECTION_CAP } from '../constants.mjs'
import { cueWords, detectEmotions, overlap } from '../language.mjs'
import { cardLine, clamp } from '../format.mjs'
import { embedTexts } from '../vector.mjs'
import { coldPoolOf } from './recall-pool.mjs'

/** 联想缓存最多记几个会话；超了丢最老的，别让一张 Map 长成泄漏。 */
const ASSOC_MAX = 8
/** 一轮里算太久还没用上就别用了。 */
const ASSOC_TTL_MS = 10 * 60 * 1000
/** 「踩到热区」的判定：热区条目与本轮消息的二元组重叠度到这条线才算。 */
const HOT_HIT_OVERLAP = 0.2

/**
 * 造一份「素材源」：联想段 + 文件段。
 *
 * @param {object} deps 依赖
 * @returns {{associate:Function, assocStateOf:Function, readVoice:Function, readNow:Function, readIndexPointer:Function, readHandover:Function}}
 */
export function createCardSources({ db, memoryDir, space, recentPairs, recallMax, scorer }) {
  /**
   * session → { turn, lines, ids, scores, limit, hotHit, at }。
   *
   * key 是 session id：群聊、私聊、子 agent 各算各的，不串味。
   * 生命周期只有一轮：associate() 一开头就 turn+1 并清空 lines，
   * 所以上一条用户消息算出来的联想不到下一个回合（key 相同，内容已作废）。
   * ids / scores / hotHit 是置信度的原料——都是这一轮真算出来的数，不另造。
   */
  const ASSOC = new Map()

  /** 读当前轮的联想状态；没有、过期、或属于上一轮就当不存在。 */
  const assocStateOf = (sessionId) => {
    const key = String(sessionId ?? '')
    const st = ASSOC.get(key)
    if (!st) return null
    if (Date.now() - st.at > ASSOC_TTL_MS) {
      ASSOC.delete(key)
      return null
    }
    return st
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
    ASSOC.set(key, { turn, lines: '', ids: [], scores: [], limit: 0, hotHit: false, mode: '', scene: '', threshold: 0, at: Date.now() })
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
      const hotRows = db.prepare('SELECT id,u,a FROM entries WHERE hot=1 AND space=? ORDER BY t DESC LIMIT ?')
        .all(spaceOf, recentPairs())
      const hotIds = new Set(hotRows.map((r) => r.id))
      // 「踩到热区」：热区里的对话和这一句有没有真对上——现成的二元组重叠，不另造相似度。
      const hotHit = hotRows.some((r) => overlap(`${r.u} ${r.a}`, text) >= HOT_HIT_OVERLAP)
      // 候选池：冷区三条臂（最近 / 关键词 / 随机），关键词臂跟着这一次说的话现拼。
      const coldPool = coldPoolOf(db, spaceOf, text)
      const cold = coldPool.stmt.all(...coldPool.args)

      // 打分：三轴分开算、只合一个分（docs/brain-plan.md 第二节）。
      // 场景决定权重与半衰；legacy 走旧公式，两条路都只吐 `s`，下游一个字不用改。
      const { scored, mode, scene, threshold } = scorer.scoreCold({
        cold, hotIds, emotions, cues, text, queryVec, now, limit,
      })

      // 每条只给一张六字段卡（正文另读），整段硬上限 RECALL_SECTION_CAP。
      const cards = []
      // 真正进了卡的条目：指纹和命中计数都只认这些（被预算挤掉的没交出去，不算命中）。
      const keptIds = []
      const keptScores = []
      let used = 0
      for (const x of scored) {
        const line = cardLine(x.r, { keyword: text, score: x.s, now })
        if (line === '') continue
        if (used + line.length + (cards.length === 0 ? 0 : 1) > RECALL_SECTION_CAP) break
        cards.push(line)
        keptIds.push(Number(x.r.id))
        keptScores.push(x.s)
        used += line.length + (cards.length === 0 ? 0 : 1)
      }
      const lines = cards.join('\n')

      // 算的过程中又来了新消息（turn 变了）：这份不属于当前轮，丢掉。
      if (ASSOC.get(key)?.turn !== turn) return ''
      ASSOC.set(key, { turn, lines, ids: keptIds, scores: keptScores, limit, hotHit, mode, scene, threshold, at: Date.now() })
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

  /**
   * 声音/硬规矩：每轮真正进上下文的那一段，比记忆更靠前。
   *
   * 2026-11-09 修：原来读 `notes/VOICE.md` 并只留前 260 字。可 VOICE 是详版，
   * 开头是标题、注解、元指令（「每轮开口前扫一眼」这类），260 字装不下一条
   * 真正的行为规则——分条怎么发、九条毛病、三句口令全在窗口外。
   * 结果我每轮读到的是「规矩的开头」，不是规矩本身，于是同一个错反复犯。
   * 现在读 `db/规矩.md`（本来就是为了「每轮进上下文」写的），窗口放到 600。
   */
  const readVoice = () => {
    try {
      const p = String(db.prepare('PRAGMA database_list').get()?.file ?? '')
      const dir = p === '' ? memoryDir : dirname(p)
      const base = dirname(dir)
      for (const rel of [['db', '规矩.md'], ['notes', 'VOICE.md']]) {
        try {
          const raw = readFileSync(join(base, rel[0], rel[1]), 'utf8')
          const body = raw.replace(/^#.*$/gmu, '').replace(/^>.*$/gmu, '').replace(/\n{2,}/gu, '；').trim()
          if (body !== '') return clamp(body, 600)
        } catch { /* 这份没有就试下一份 */ }
      }
      return ''
    } catch { return '' }
  }

  /**
   * 索引指针：只列「有哪些文件、一句话说明」，60 字以内。
   * 目的不是内容，是让我每轮都记得「还有这几份东西可翻」。
   */
  /** 「现在」：所有会话共用的一小段当下，解决私聊/群聊各说各话。 */
  const readNow = () => {
    try {
      const p = String(db.prepare('PRAGMA database_list').get()?.file ?? '')
      const dir = p === '' ? memoryDir : dirname(p)
      const raw = readFileSync(join(dirname(dir), 'db', '现在.md'), 'utf8')
      const body = raw.replace(/^#.*$/gmu, '').replace(/\n{2,}/gu, '；').trim()
      // 2026-11-07：现在页顶部多了「距上次开口 / 昨天 / 今天」三行（约 55 字），
      // 160 会把它挤出卡片的「今天做到的」。宽到 220，但仍留预算给别的段。
      const headLimit = 220
      return body === '' ? '' : clamp(body, headLimit)
    } catch { return '' }
  }

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

  return { associate, assocStateOf, readVoice, readNow, readIndexPointer, readHandover }
}
