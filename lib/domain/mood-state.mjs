/**
 * 情绪的状态与常量：初始状态、自然平复、meta 读写。
 *
 * 四根维度、半衰、地板天花板、以及各处的默认值都只在这里写一份——
 * 别在别处再抄一遍数字。判定在 `mood-judge.mjs`，渲染在 `mood-render.mjs`，
 * 落库与记账流程在 `mood-log.mjs`；对外仍从 `mood.mjs` 取（兼容层）。
 *
 * @module mood-state
 */
import { MOOD_INJECT_DAILY_MAX } from '../constants.mjs'

/** 四根累积的情绪维度。派生量（平静）不落库，见 snapshot()。 */
export const DIMS = ['happy', 'tired', 'sad', 'care']

/** 记账总开关的默认值。设置项 `moodEnabled` 的缺省就取这一份，别在别处再写一遍。 */
export const MOOD_ENABLED = true
/** 聊天常驻行（状态牌）的默认值。设置项 `moodChatLine` 的缺省取这一份。 */
export const MOOD_CHAT_LINE = true
/** 聊天常驻行的字数上限：极短，一行看得完，不占版面。 */
export const MOOD_CHAT_CAP = 20
/** 总值半衰期的默认值（小时）。设置项 `moodHalfLifeHours` 的缺省也取这一份。 */
export const MOOD_HALF_HOURS = 3
/** 基线心情：偏低中位。参考实现实测判定 6.7:1 偏正，贴顶就变背景音（index.js:1404-1406）。 */
export const BASE_MOOD = 48
/** 情绪下限/上限：不让正反馈把分数一路压到 0，也不让它常驻峰值（2026-11-08）。 */
export const MOOD_FLOOR = 25
export const MOOD_CEIL = 90
/** 总值半衰期：3 小时（按小时算出分钟，供衰减用）。 */
export const MOOD_HALF_MIN = MOOD_HALF_HOURS * 60
/** 单根情绪半衰期：90 分钟，与参考实现一致（index.js:898-899）。 */
export const DIM_HALF_MIN = 90
/** 总值每轮只吃判定值的 1/3（index.js:214）。 */
export const MOOD_STEP_DIVISOR = 3
/** 变化是否够大：参考实现的 sigMood=3 / sigDim=5（index.js:191-192）。 */
export const SIG_RAW = 3
export const SIG_DIM = 5
/** 注入置信门槛（保留给面板看，不再当闸用）：参考 index.js:187。 */
export const CONF_MIN = 60
/** 每日上限的旧名，留作兼容；新代码用常量里的 MOOD_INJECT_DAILY_MAX。 */
export const PER_DAY = MOOD_INJECT_DAILY_MAX

const MIN = 60_000
export const numClamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * 初始状态。第一次记账、或者 meta 里的 JSON 坏了，都用它。
 *
 * @param {number} [now] 现在
 * @returns {object} 状态
 */
export function initState(now = Date.now()) {
  return {
    mood: BASE_MOOD,
    dims: { happy: 0, tired: 0, sad: 0, care: 0 },
    updatedAt: now,
    lastDecayAt: now,
    lastNotedMood: BASE_MOOD,
    injectedFor: 0,
    lastConfidence: 0,
    lastInjectedText: '',
    /** 上次开口时的心情值：第 3 道闸拿它算幅度。 */
    lastInjectMood: BASE_MOOD,
    /** 上次为什么没说：{ reason, at }，排查用（`daily-cap` / `below-delta` / `cooldown`）。 */
    lastSkip: null,
    minor: false,
    reason: '',
    source: '',
    saidAt: [],
  }
}

/**
 * 自然平复：总值向基线回落，单维向 0 散掉。原地改，调用方自己拷。
 *
 * @param {object} s 状态（会被改）
 * @param {number} [now] 现在
 * @param {object} [opts] { halfLifeMin } 总值半衰期，默认 MOOD_HALF_MIN
 * @returns {object} 同一个状态
 */
export function decay(s, now = Date.now(), opts = {}) {
  const ageMin = Math.max(0, now - s.lastDecayAt) / MIN
  if (ageMin < 1) return s
  const half = Math.max(1, Number(opts.halfLifeMin) || MOOD_HALF_MIN)
  const km = 1 - Math.exp(-(Math.LN2 * ageMin) / half)
  s.mood = s.mood + (BASE_MOOD - s.mood) * km
  const ke = 1 - Math.exp(-(Math.LN2 * ageMin) / DIM_HALF_MIN)
  for (const k of DIMS) s.dims[k] = Math.max(0, s.dims[k] * (1 - ke))
  s.lastDecayAt = now
  return s
}

// ---- 存储 ----
//
// 当前状态一条 meta（和 consolidate.mjs:73 一样 INSERT OR REPLACE）；
// 历史落 mood_log，`day` 冗余存本地日期，省得查询里做时区算术。

/**
 * 当前状态的 meta 键。一个空间一条。
 *
 * @param {string} space 记忆空间
 * @returns {string} 键名
 */
export function moodStateKey(space = 'default') {
  return `mood.state.${String(space ?? 'default').trim() || 'default'}`
}

/**
 * 读当前状态；没有、或者 JSON 坏了，都给初始状态。
 *
 * @param {object} db 记忆库
 * @param {string} [space] 空间
 * @param {number} [now] 现在
 * @returns {object} 状态
 */
export function loadState(db, space = 'default', now = Date.now()) {
  // 从没记过账：`updatedAt` 归 0（不是 now），否则第一轮会被 note() 当成「同一轮」挡掉。
  const fresh = () => ({ ...initState(now), updatedAt: 0 })
  try {
    const raw = String(db.prepare('SELECT v FROM meta WHERE k=?').get(moodStateKey(space))?.v ?? '')
    if (raw === '') return fresh()
    const o = JSON.parse(raw)
    if (!o || typeof o !== 'object' || typeof o.mood !== 'number') return fresh()
    // 老库/半截 JSON 兜底：缺哪块补哪块，别因为一个字段没了从头再来。
    const base = initState(now)
    return {
      ...base,
      ...o,
      // 老库里可能存着被正反馈压到底的 0；读的时候抬回地板，别让明天从 0 开始（2026-11-08）。
      mood: numClamp(Number(o.mood), MOOD_FLOOR, MOOD_CEIL),
      dims: { ...base.dims, ...(o.dims && typeof o.dims === 'object' ? o.dims : {}) },
      saidAt: Array.isArray(o.saidAt) ? o.saidAt : [],
    }
  } catch {
    return { ...initState(now), updatedAt: 0 }
  }
}

/**
 * 写回当前状态。
 *
 * @param {object} db 记忆库
 * @param {string} [space] 空间
 * @param {object} state 状态
 */
export function saveState(db, space = 'default', state) {
  try {
    db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)')
      .run(moodStateKey(space), JSON.stringify(state))
  } catch { /* 写不上不影响对话 */ }
}
