/**
 * 两行「现在的心情」：变化播报（四道闸）与常驻状态牌（只读）。
 *
 * 原样从 index.mjs 搬出来，只把外层包成 createMoodLines()。
 */
import { loadState, decay, chatStateLine, speakForContext } from './mood.mjs'

/**
 * @param {object} deps 依赖
 * @param {object} deps.db 库
 * @param {object} deps.cfg 配置取值函数
 * @returns {{moodContextLine:Function, moodChatState:Function}}
 */
export function createMoodLines({ db, cfg }) {
  const {
    moodEnabled, moodChatLine, moodHalfLifeMin, activeSpace,
    moodInjectDailyMax, moodInjectMinDelta, moodInjectCooldownHours,
  } = cfg
  /**
   * 情绪那一行：渲染时现读状态、过四道闸，一天最多说 `moodInjectDailyMax` 次（默认 4）。
   *
   * 只返回一句话（或不返回），不改任何权限、不碰别的 context 条目。
   */
  const moodContextLine = () => {
    if (!moodEnabled()) return ''
    try {
      const r = speakForContext(db, {
        space: activeSpace(),
        now: Date.now(),
        dailyMax: moodInjectDailyMax(),
        minDelta: moodInjectMinDelta(),
        cooldownHours: moodInjectCooldownHours(),
      })
      return r.text
    } catch { return '' }
  }

  /**
   * 聊天常驻行（状态牌）：每轮都在的一行，只读当前状态。
   *
   * **不写库**：`loadState` 只读，衰减只发生在内存里的一份拷贝上，不 `saveState`；
   * 因此 `mood_log.injected` 不会被改写，也不吃 `moodInjectDailyMax`、不受 `minDelta` / `cooldown` 限制。
   * 与下面 `moodContextLine()`（变化播报，四道闸）互不影响，另起一条 context 条目。
   */
  const moodChatState = () => {
    if (!moodEnabled() || !moodChatLine()) return ''
    try {
      const now = Date.now()
      const s = loadState(db, activeSpace(), now)
      // 只在这一份拷贝上算平复：看着更准，但一个字都不回写。
      decay(s, now, { halfLifeMin: moodHalfLifeMin() })
      return chatStateLine(s)
    } catch { return '' }
  }

  return { moodContextLine, moodChatState }
}
