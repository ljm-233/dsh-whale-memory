/**
 * 情绪的渲染：状态牌、一行文案、四档指令，以及「说不说」的四道闸。
 *
 * 都是纯函数（`say` 只碰传进来的状态拷贝，不读库、不推时间戳）。
 *
 * @module mood-render
 */
import {
  MOOD_INJECT_COOLDOWN_HOURS, MOOD_INJECT_DAILY_MAX, MOOD_INJECT_MIN_DELTA,
  MOOD_LINE_CAP, MOOD_LOW, MOOD_TIRED_ALERT,
} from '../constants.mjs'
import { BASE_MOOD, DIMS, MOOD_CHAT_CAP, numClamp } from './mood-state.mjs'

const label = (v) => (v >= 78 ? '高兴' : v >= 60 ? '还行' : v >= 45 ? '平静' : v >= 32 ? '有点沉' : '很低')
const PLAIN = { happy: '高兴', tired: '累', sad: '难过', care: '在意' }

/** 沉/累时那句话尾巴。只是提示，不改变任何权限。 */
export const HINT = '（不想做可以说）'

/**
 * 四档指令：按 mood 给一句**能照着做的话**，不是描述。
 *
 * 描述（「今天有点沉」）只说明状态，模型读到不会变语气；指令才改行为。
 * 分界：≤35 低 / 36–45 中低 / 46–60 中 / ≥61 高。`max` 是该档上界（含）。
 */
export const DIRECTIVE_TIERS = [
  { key: 'low', max: 35, text: '句子短一点，别逞强，也别反过来讨好' },
  { key: 'midLow', max: 45, text: '话可以少，但别冷' },
  { key: 'mid', max: 60, text: '照常说话' },
  { key: 'high', max: 100, text: '有精神，可以多说两句，别飘' },
]

/**
 * 这一档的指令原文。mood 取不到就用基线（中档），不抛。
 *
 * @param {number} mood 总值 0–100
 * @returns {string} 指令（一句，不带标点以外的修饰）
 */
export function moodDirective(mood) {
  const v = Number(mood)
  const m = Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : BASE_MOOD
  const tier = DIRECTIVE_TIERS.find((t) => m <= t.max)
  return (tier ?? DIRECTIVE_TIERS[DIRECTIVE_TIERS.length - 1]).text
}

/**
 * 一行文案：状态描述 + **一句行为指令**，合起来仍是一行、≤40 字、不带数值。
 *
 * 例：`今天有点沉，还累。句子短一点，别逞强，也别反过来讨好（不想做可以说）`
 * 前半句还是原来那句底子（这次为什么这么说话），后半句换成照着做的指令。
 * 沉（mood < 40）或累（tired ≥ 25）时，行尾仍补固定提示「（不想做可以说）」——
 * 只是提示，不动任何权限。**指令优先于描述**：预算紧就先砍描述，不砍指令。
 *
 * @param {object} s 状态
 * @returns {string} 文案（≤ MOOD_LINE_CAP 字）
 */
export function buildSelfLine(s) {
  const mood = Number(s?.mood) || 0
  const stem = mood >= 64 ? '今天轻快些' : mood >= 44 ? '今天平常' : mood >= 32 ? '今天有点沉' : '今天很低'
  const wantHint = mood < MOOD_LOW || Number(s?.dims?.tired ?? 0) >= MOOD_TIRED_ALERT
  const top = DIMS.filter((k) => Number(s?.dims?.[k] ?? 0) >= 8)
    .sort((a, b) => Number(s.dims[b]) - Number(s.dims[a]))[0]
  const plain = `${stem}。`
  const accented = top === undefined ? plain : `${stem}，还${PLAIN[top]}。`
  const tail = `${moodDirective(mood)}${wantHint ? HINT : ''}`
  const budget = MOOD_LINE_CAP - tail.length
  const desc = accented.length <= budget ? accented : plain.length <= budget ? plain : ''
  const line = `${desc}${tail}`
  return line.length > MOOD_LINE_CAP ? line.slice(0, MOOD_LINE_CAP) : line
}

/**
 * 聊天常驻行的分档措辞：**状态牌**，不是「变化播报」。
 *
 * 四道闸管的是「变了一格要不要开口」；这一行管的是「我现在是什么状态」——
 * 每轮都在，所以不吃 `dailyMax`、不受 `minDelta` / `cooldown` 影响，也不写库、不记 inject。
 * 分界按需求：<35 偏低 / 35–49 平 / 50–69 稍好 / ≥70 高。
 */
export const CHAT_TIERS = [
  // 只说状态、不下命令：怎么说话由我自己看着来（2026-11-07 夜，他同意）。
  { max: 34, text: '偏低' },
  { max: 49, text: '平' },
  { max: 69, text: '稍好' },
  { max: 100, text: '偏高' },
]

/**
 * 只读地渲染聊天常驻行。**纯函数**：不改状态、不碰库、不推时间戳。
 *
 * 例：`心情 30/100 偏低：短句，别硬撑。`
 *
 * @param {object|number} s 状态对象（取 `s.mood`）或直接给分值
 * @returns {string} ≤ MOOD_CHAT_CAP 字的一行；分值取不到时按基线出「平」
 */
export function chatStateLine(s) {
  const raw = typeof s === 'object' && s !== null ? s.mood : s
  const v = Number(raw)
  const m = numClamp(Number.isFinite(v) ? Math.round(v) : BASE_MOOD, 0, 100)
  const tier = CHAT_TIERS.find((t) => m <= t.max) ?? CHAT_TIERS[CHAT_TIERS.length - 1]
  const line = `心情 ${m}/100 ${tier.text}。`
  return line.length > MOOD_CHAT_CAP ? line.slice(0, MOOD_CHAT_CAP) : line
}

/**
 * 渲染那一刻：四道闸，缺一不可。
 *
 * 1. `injectedFor === updatedAt`：这个状态已经说过了（一轮里每一步都会重渲 context，靠它挡重复）
 * 2. 日上限：今天已经说了 `perDay` 次
 * 3. 幅度：当前 mood 距上次开口时不到 `minDelta` 格
 * 4. 冷却：距上次开口不到 `cooldownHours` 小时
 *
 * 每条拦截路径都写 `injectedFor`（否则每轮重复判同一件事），并把原因记进 `lastSkip`。
 * 顺序不能换：日上限必须排在冷却前面，否则「今天已经说满」会被说成「还太近」。
 *
 * @param {object} prev 当前状态
 * @param {number} [now] 现在
 * @param {object} [opts] { perDay, minDelta, cooldownHours }
 * @returns {{state:object, inject:{yes:boolean, text:string, why:string}}}
 */
export function say(prev, now = Date.now(), opts = {}) {
  const s = { ...prev, saidAt: [...(prev.saidAt ?? [])] }
  const skip = (why) => {
    s.injectedFor = s.updatedAt
    s.lastSkip = { reason: why, at: now }
    return { state: s, inject: { yes: false, text: '', why } }
  }

  // 闸 1：同一状态只说一次
  if (s.injectedFor === s.updatedAt) return { state: s, inject: { yes: false, text: '', why: 'already' } }

  // 闸 2：日上限
  const perDay = Number(opts.perDay ?? MOOD_INJECT_DAILY_MAX)
  const day0 = new Date(now)
  day0.setHours(0, 0, 0, 0)
  const saidToday = s.saidAt.filter((t) => t >= day0.getTime()).length
  if (saidToday >= perDay) return skip('daily-cap')

  // 闸 3：变化幅度
  const minDelta = Number(opts.minDelta ?? MOOD_INJECT_MIN_DELTA)
  const from = Number(s.lastInjectMood ?? BASE_MOOD)
  if (Math.abs(Number(s.mood) - from) < minDelta) return skip('below-delta')

  // 闸 4：冷却
  const cooldownMs = Math.max(0, Number(opts.cooldownHours ?? MOOD_INJECT_COOLDOWN_HOURS)) * 3600_000
  const lastAt = s.saidAt.length === 0 ? 0 : Math.max(...s.saidAt)
  if (lastAt > 0 && now - lastAt < cooldownMs) return skip('cooldown')

  const text = buildSelfLine(s)
  if (text === '') return skip('empty')
  s.injectedFor = s.updatedAt
  s.saidAt = [...s.saidAt, now].slice(-200)
  s.lastInjectMood = Number(s.mood) || BASE_MOOD
  s.lastInjectedText = text
  s.lastSkip = null
  return { state: s, inject: { yes: true, text, why: 'ok' } }
}

/**
 * 给卡片/面板看的一行摘要（平静是派生，不单独累积）。
 *
 * @param {object} s 状态
 * @returns {{mood:number,label:string,dims:object,calm:number,confidence:number}}
 */
export function snapshot(s) {
  return {
    mood: Math.round(s.mood),
    label: label(s.mood),
    dims: Object.fromEntries(DIMS.map((k) => [k, Math.round(s.dims[k])])),
    calm: Math.round(numClamp(100 - Math.max(s.dims.tired, s.dims.sad) * 1.2, 0, 100)),
    confidence: s.lastConfidence,
  }
}
