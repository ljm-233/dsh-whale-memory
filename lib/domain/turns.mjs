/**
 * 每一轮：共享时间线落一条、攒下这一轮的话、轮末判一次情绪、压缩前抢救。
 *
 * 整块原样从 index.mjs 搬出来（session/event 那条钩子 + 它的几个 helper），
 * 只把外层包成 createTurnRecorder()。
 */
import { textOf, clamp } from '../format.mjs'
import { windowOf } from '../session.mjs'
import { applyMoodTurn, appendUnwilling, matchUnwilling } from './mood.mjs'
import { EVENT_MAX } from '../constants.mjs'

/**
 * @param {object} deps 依赖
 * @param {object} deps.db 库
 * @param {object} deps.writer 写入器
 * @param {object} deps.cfg 配置取值函数
 * @param {Function} deps.dayKeyOf 本地日期键
 * @param {Function} deps.associate 异步联想
 * @param {Function} deps.salvageCompacted 压缩抢救
 * @returns {{handleSessionEvent:Function}}
 */
export function createTurnRecorder({ db, writer, cfg, dayKeyOf, associate, salvageCompacted }) {
  const {
    moodEnabled, moodHalfLifeMin, activeSpace, unwillingFile,
    moodInjectDailyMax, moodInjectMinDelta, moodInjectCooldownHours,
  } = cfg
  const flush = writer.flush
  /**
   * 往共享时间线写一条。
   *
   * 所有会话、所有窗口都写同一张表——这样换个窗口也不会「完全不知道刚才干了什么」。
   * 只留最近 EVENT_MAX 条，老的滚掉。
   *
   * @param {object} session 会话
   * @param {string} kind user | assistant | tool
   * @param {string} text 内容
   */
  const recordEvent = (session, kind, text) => {
    const body = String(text ?? '').replace(/\s+/gu, ' ').trim()
    if (body === '') return
    try {
      const sid = String(session?.id ?? 'unknown')
      const win = windowOf(session)
      db.prepare('INSERT INTO events(at, session, window, kind, text) VALUES(?,?,?,?,?)')
        .run(Date.now(), sid, win, kind, clamp(body, 400))
      const total = db.prepare('SELECT COUNT(*) c FROM events').get().c
      if (total > EVENT_MAX) {
        db.prepare('DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY at ASC LIMIT ?)')
          .run(total - EVENT_MAX)
      }
    } catch { /* 记不上不影响对话 */ }
  }

  // ---- 情绪记账（判我自己的话） ----
  //
  // 挂在本仓库现用的等价钩子上：`turn/end`（DSH 的 agent/turn-stopping 之后追加的那条事件）。
  // 一轮里的话都在 `user/message` / `assistant/message` 那两步顺手接住（事件流里 `textOf(message)`），
  // 轮末一起交给 applyMoodTurn：**我的话当情绪，对方的话只当冲击**。
  const moodTurns = new Map()
  const MOOD_STREAK_GAP_MS = 30 * 60 * 1000

  /** 这一轮的用户原话攒在这里（按会话分开，两个窗口不会串味）。 */
  const collectMoodText = (session, text) => {
    const sid = String(session?.id ?? 'unknown')
    const t = moodTurns.get(sid) ?? { texts: [], selfs: [], streak: 0, lastAt: 0 }
    t.texts = [...t.texts.slice(-2), String(text ?? '').slice(0, 500)]
    moodTurns.set(sid, t)
  }

  /** 这一轮我说的话攒在这里——情绪判定的主信号。 */
  const collectMoodSelf = (session, text) => {
    const sid = String(session?.id ?? 'unknown')
    const t = moodTurns.get(sid) ?? { texts: [], selfs: [], streak: 0, lastAt: 0 }
    t.selfs = [...(t.selfs ?? []).slice(-3), String(text ?? '').slice(0, 2000)]
    moodTurns.set(sid, t)
  }

  /** 轮末记一笔。任何异常都咽掉：心情记不上，对话照旧。 */
  const bookMoodTurn = (session, event) => {
    const sid = String(session?.id ?? 'unknown')
    const t = moodTurns.get(sid) ?? { texts: [], selfs: [], streak: 0, lastAt: 0 }
    moodTurns.set(sid, { texts: [], selfs: [], streak: t.streak, lastAt: t.lastAt })
    // 出口①：我在会话里说了「不想做」这类话 → 只记进 `我不想做.md`，不执行、不改任何东西。
    // 这一条不受情绪开关管：关掉记账也不该关掉「我能拒绝」的留痕。
    const now = Date.now()
    try {
      for (const quote of matchUnwilling(t.selfs ?? [])) appendUnwilling(unwillingFile(), quote, now)
    } catch { /* 记不上就算了，账房不该拖垮对话 */ }
    if (!moodEnabled()) return
    try {
      const streak = now - t.lastAt <= MOOD_STREAK_GAP_MS ? t.streak + 1 : 1
      applyMoodTurn(db, {
        space: activeSpace(),
        signal: {
          at: now,
          // 主信号：我这一轮说的话（没有就传空数组，等于「我没说话」）
          assistantTexts: t.selfs ?? [],
          // 冲击：对方的话
          userTexts: t.texts,
          kind: String(event?.data?.reason?.kind ?? event?.data?.kind ?? ''),
          hour: new Date(now).getHours(),
          turnStreak: streak,
        },
        halfLifeMin: moodHalfLifeMin(),
        perDay: moodInjectDailyMax(),
        minDelta: moodInjectMinDelta(),
        cooldownHours: moodInjectCooldownHours(),
        day: dayKeyOf(new Date(now)),
      })
      moodTurns.set(sid, { texts: [], selfs: [], streak, lastAt: now })
    } catch { /* 记账失败不影响对话 */ }
  }

  const handleSessionEvent = (session, event) => {
    if (!event || typeof event.type !== 'string') return
    if (event.type === 'user/message') {
      const msg = event.data ?? event.message ?? event
      if (msg && msg.source && msg.source.kind === 'user') {
        const text = textOf(msg)
        if (text !== '') {
          writer.setUser(text)
          recordEvent(session, 'user', text)
          collectMoodText(session, text)
          // 联想：一句用户消息算一次，算完放 recall 的小缓存，card() 只同步读。
          // 不等它——算不出来这一轮就没有联想段，不耽误回话。
          associate(String(session?.id ?? ''), text).catch(() => undefined)
        }
      }
    } else if (event.type === 'assistant/message') {
      const msg = (event.data && event.data.message) ?? event.message
      if (msg && typeof msg === 'object') {
        const text = textOf(msg)
        if (text !== '') {
          writer.setAssistant(text)
          recordEvent(session, 'assistant', text)
          // 我的话是情绪的主信号：这里接住，轮末再判。
          collectMoodSelf(session, text)
        }
      }
    } else if (event.type === 'tool/result' || event.type === 'tool/call') {
      const name = String(event.data?.name ?? event.data?.tool ?? '')
      if (name !== '') recordEvent(session, 'tool', name)
    } else if (event.type === 'turn/end') {
      flush().catch(() => undefined)
      bookMoodTurn(session, event)
    } else if (event.type === 'compaction/summary') {
      // 压缩前抢救：被压缩的原文还在会话日志里，趁现在蒸馏成长期记忆。
      salvageCompacted(session, event.data ?? {}).catch(() => undefined)
    }
  }

  return { handleSessionEvent }
}
