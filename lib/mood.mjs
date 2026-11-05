/**
 * 情绪记账：每轮结束判一次、涨落一次，写进库里；渲染时过四道闸，决定说不说。
 *
 * **数据源是我自己说的话。** 0.28.18 之前这份是「镜子」：从对方的话里取情绪词，
 * 算出来的是「他在说什么」，然后冒充成我的心情。现在改过来了：
 *   - 主信号 = 本轮 assistant 的发言（词表 + 语气：句长 / 不想·算了·没事 / 主动开口）
 *   - 对方的话只算「冲击」：被夸抬 happy、被否压 mood，系数 ≤ 直接判定的 1/3
 * 旧路径 `judgeUser()` 留着做兼容，`note()` 只在信号里没有 `assistantTexts` 时才退回它。
 *
 * 三步分开：
 *   note(上一状态, 本轮信号)  → 判一次、涨落一次（变化不够大就不动，别把时间戳往前推）
 *   say(状态, now, opts)      → 渲染那一刻过四道闸，决定说不说
 *   speakForContext(db, ...)  → 上面两步接上存储，给 runtime-context 的 950 条目用
 *
 * 信号全部现成可得，没有新数据源：
 * - 词表取 whale-memory lib/constants.mjs 的 EMOTION_WORDS
 * - 本轮 kind 来自 DSH turn/end 的 reason.kind（packages/core/agent-loop/src/agent.ts:391）
 * - 饱和、1/3 步长、90 分钟单维半衰、四道闸，对齐参考实现 lib/index.js:1402-1414 / :891-909 / :1615-1636
 *
 * 设计依据见 `docs/mood-design.md`。
 *
 * @module mood
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dayKeyOf } from './shared.mjs'
import {
  MOOD_INJECT_COOLDOWN_HOURS, MOOD_INJECT_DAILY_MAX, MOOD_INJECT_MIN_DELTA,
  MOOD_LINE_CAP, MOOD_LOW, MOOD_TIRED_ALERT,
} from './constants.mjs'

/** 四根累积的情绪维度。派生量（平静）不落库，见 snapshot()。 */
export const DIMS = ['happy', 'tired', 'sad', 'care']

/** 记账总开关的默认值。设置项 `moodEnabled` 的缺省就取这一份，别在别处再写一遍。 */
export const MOOD_ENABLED = true
/** 总值半衰期的默认值（小时）。设置项 `moodHalfLifeHours` 的缺省也取这一份。 */
export const MOOD_HALF_HOURS = 3
/** 基线心情：偏低中位。参考实现实测判定 6.7:1 偏正，贴顶就变背景音（index.js:1404-1406）。 */
export const BASE_MOOD = 48
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
const numClamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * 情绪词表：只挑 whale-memory EMOTION_WORDS 里已有的词（constants.mjs:114-120）。
 * 每一类落在一根维度上：angry → sad（负向合流）、anxious → sad（只记一半）。
 */
const WORDS = {
  tired: ['累', '困', '疲惫', '撑不住', '熬夜', '没睡'],
  sad: ['难过', '伤心', '失落', '委屈', '想哭', '烦', '气死', '郁闷', '受不了'],
  anxious: ['焦虑', '紧张', '害怕', '担心', '慌', '压力'],
  happy: ['开心', '高兴', '太好了', '哈哈', '笑死', '棒', '爽'],
  care: ['想你', '陪我', '你呢', '你还', '舍不得', '一起'],
}
/** 词 → 维度（angry/anxious 都落 sad；angry 满权、anxious 半权，见 judgeSelf）。 */
const WORD_DIM = { tired: 'tired', sad: 'sad', anxious: 'sad', happy: 'happy', care: 'care' }
/** 对方的话：只当冲击，系数小（原来 4/6，这里 1/2，≤1/3）。 */
const PRAISE = ['不错', '厉害', '谢谢', '喜欢', '好用']
const NEGATE = ['不对', '错了', '重来', '没用', '别这样']
/** 「我不想做」那本账的触发词：只扫我自己的话。 */
const UNWILLING = /(不想做|不想干|不想弄|今天不想|我先不做|我不做)/u

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

/** 把一段话切成句：中英文句读 + 换行。句长和引用都靠它。 */
const sentencesOf = (text) => String(text ?? '')
  .split(/[\n。！？!?；;…]+/u)
  .map((x) => x.trim())
  .filter((x) => x !== '')

/**
 * 命中词所在那一句的前 20 字——`reason` 靠它回答「是我的哪句话」。
 *
 * @param {string[]} lines 句子
 * @param {string} word 命中的词
 * @returns {string} 截断后的原话；没找到返回 ''
 */
const quoteOf = (lines, word) => {
  for (const line of lines) {
    if (!line.includes(word)) continue
    return line.slice(0, 20)
  }
  return ''
}

/**
 * 旧路径：从**对方**的文本算判定。留作兼容（`note()` 在没有 `assistantTexts` 时退回它），
 * 新代码一律走 judgeSelf()。这一份算出来的是「他在说什么」，不是我的心情。
 *
 * @param {object} signal { at, userTexts, kind, hour, turnStreak }
 * @returns {{dims:object, raw:number, confidence:number, evidence:string[], source:string}}
 */
export function judgeUser(signal) {
  const text = (signal.userTexts ?? []).join('\n')
  const d = { happy: 0, tired: 0, sad: 0, care: 0 }
  const evidence = []
  for (const [dim, words] of Object.entries(WORDS)) {
    const hit = words.filter((w) => text.includes(w))
    if (hit.length === 0) continue
    d[dim] += dim === 'happy' ? 6 : dim === 'care' ? 5 : 7
    evidence.push(`话里有「${hit[0]}」`)
  }
  if (PRAISE.some((w) => text.includes(w))) { d.happy += 4; evidence.push('被夸了一句') }
  if (NEGATE.some((w) => text.includes(w))) { d.sad += 6; evidence.push('被否了一句') }
  if (signal.kind === 'error' || signal.kind === 'blocked') { d.sad += 5; evidence.push('这轮没跑通') }
  else if (signal.kind === 'completed' && d.happy > 0) d.happy += 2

  const hour = Number.isInteger(signal.hour) ? signal.hour : new Date(signal.at).getHours()
  if (hour >= 23 || hour < 6) { d.tired += 4; evidence.push('这个点还没停') }
  if ((signal.turnStreak ?? 0) >= 6) { d.tired += 3; evidence.push('连着干了好几轮') }
  if ((signal.userTexts ?? []).length >= 3) { d.care += 3; evidence.push('这轮说得长') }

  const raw = d.happy + d.care * 0.5 - d.sad * 1.2 - d.tired * 0.8
  const confidence = numClamp(30 + evidence.length * 15, 0, 95)
  return { dims: d, raw, confidence, evidence, source: 'user' }
}

/**
 * 新路径：从**我这一轮说的话**算判定。
 *
 * 权重（一句话版）：我话里的词 tired/sad +7、happy +6、care +5，anxious 只给 sad +4；
 * 语气上说了「不想/算了」tired +5、说了「没事/无所谓」sad +3、平均句长 ≥30 字 care +3、
 * 话说得又短又碎（≥2 句且平均 ≤8 字）sad +2、没人问我自己开口 happy +3；
 * 对方的话只算冲击：被夸 happy +1、被否 sad +2（≤ 旧版 4/6 的 1/3）；
 * 环境另算：没跑通 sad +3、23 点到 6 点 tired +3、连轮 ≥6 tired +2。
 *
 * @param {object} signal { at, assistantTexts, userTexts, kind, hour, turnStreak }
 * @returns {{dims:object, raw:number, confidence:number, evidence:string[], source:string}}
 */
export function judgeSelf(signal = {}) {
  const mine = (signal.assistantTexts ?? []).join('\n')
  const lines = sentencesOf(mine)
  const theirs = (signal.userTexts ?? []).join('\n')
  const d = { happy: 0, tired: 0, sad: 0, care: 0 }
  const evidence = []

  // 1) 我话里的情绪词：每类只算一次（同义词堆十个不算十次）
  for (const [group, words] of Object.entries(WORDS)) {
    const hit = words.find((w) => mine.includes(w))
    if (hit === undefined) continue
    const dim = WORD_DIM[group]
    const weight = group === 'anxious' ? 4 : group === 'happy' ? 6 : group === 'care' ? 5 : 7
    d[dim] += weight
    const q = quoteOf(lines, hit)
    evidence.push(q === '' ? `我话里有「${hit}」` : `我说「${q}」`)
  }

  // 2) 语气特征
  const 不想 = ['不想', '算了'].find((w) => mine.includes(w))
  if (不想 !== undefined) { d.tired += 5; evidence.push(`我说「${quoteOf(lines, 不想)}」`) }
  const 没事 = ['没事', '无所谓'].find((w) => mine.includes(w))
  if (没事 !== undefined) { d.sad += 3; evidence.push(`我说「${quoteOf(lines, 没事)}」`) }

  const lens = lines.map((x) => x.length)
  const avg = lens.length === 0 ? 0 : lens.reduce((a, b) => a + b, 0) / lens.length
  if (lines.length > 0 && avg >= 30) { d.care += 3; evidence.push('我说得展开，想多说几句') }
  else if (lines.length >= 2 && avg <= 8) { d.sad += 2; evidence.push('我话说得短促') }

  const quiet = (signal.userTexts ?? []).every((t) => String(t ?? '').trim() === '')
  if (lines.length > 0 && quiet) { d.happy += 3; evidence.push('没人问，我自己开的口') }

  // 3) 对方的话：只当冲击，系数 ≤ 旧版的 1/3
  if (PRAISE.some((w) => theirs.includes(w))) { d.happy += 1; evidence.push('他夸了一句') }
  if (NEGATE.some((w) => theirs.includes(w))) { d.sad += 2; evidence.push('他否了一句') }

  // 4) 环境
  if (signal.kind === 'error' || signal.kind === 'blocked') { d.sad += 3; evidence.push('这轮没跑通') }
  const hour = Number.isInteger(signal.hour) ? signal.hour : new Date(signal.at ?? Date.now()).getHours()
  if (hour >= 23 || hour < 6) { d.tired += 3; evidence.push('这个点还没停') }
  if ((signal.turnStreak ?? 0) >= 6) { d.tired += 2; evidence.push('连着干了好几轮') }

  const raw = d.happy + d.care * 0.5 - d.sad * 1.2 - d.tired * 0.8
  const confidence = numClamp(35 + evidence.length * 15, 0, 95)
  return { dims: d, raw, confidence, evidence, source: 'self' }
}

/**
 * 信号分派：带了 `assistantTexts`（哪怕是空数组）就走新路径。
 * 空数组 = 「这一轮我没说话」，判定为 0，不退回旧路径——否则又变回镜子。
 *
 * @param {object} signal 本轮信号
 * @returns {{dims:object, raw:number, confidence:number, evidence:string[], source:string}}
 */
export function judgeSignal(signal = {}) {
  return Array.isArray(signal?.assistantTexts) ? judgeSelf(signal) : judgeUser(signal)
}

/** 老名字，内部兼容用。 */
const judge = judgeSignal

const label = (v) => (v >= 78 ? '高兴' : v >= 60 ? '还行' : v >= 45 ? '平静' : v >= 32 ? '有点沉' : '很低')
const PLAIN = { happy: '高兴', tired: '累', sad: '难过', care: '在意' }

/** 沉/累时那句话尾巴。只是提示，不改变任何权限。 */
export const HINT = '（不想做可以说）'

/**
 * 这一轮结束：判一次、涨落一次。
 *
 * 变化不够大（参考实现 sigMood/sigDim 以下）就只走衰减，**不推进 updatedAt**——
 * 同一轮里的重复调用（每一步都会重算一次）因此能被「同一轮」挡住，不会记两笔。
 *
 * @param {object} prev 上一状态
 * @param {object} signal { at, assistantTexts, userTexts, kind, hour, turnStreak }
 * @param {object} [opts] { halfLifeMin }
 * @returns {{state:object, changed:boolean, why:string}}
 */
export function note(prev, signal, opts = {}) {
  const at = Number(signal?.at) || Date.now()
  if (at <= prev.updatedAt) return { state: prev, changed: false, why: 'same-turn' }

  const s = { ...prev, dims: { ...prev.dims }, saidAt: [...(prev.saidAt ?? [])] }
  decay(s, at, opts)

  const j = judge(signal)
  const big = Math.abs(j.raw) >= SIG_RAW || DIMS.some((k) => j.dims[k] >= SIG_DIM)
  if (!big) { s.source = j.source; return { state: s, changed: false, why: 'below-threshold' } }

  const 在顶 = s.mood >= 85 && j.raw > 0
  const 在底 = s.mood <= 40 && j.raw < 0
  const 因子 = 在顶 || 在底 ? 0.5 : 1
  const moodStep = Math.round((j.raw * 因子) / MOOD_STEP_DIVISOR)

  s.mood = numClamp(s.mood + moodStep, 0, 100)
  for (const k of DIMS) s.dims[k] = numClamp(s.dims[k] + j.dims[k], 0, 100)
  // reason 写清是「我的哪句话」，截 20 字，事后能翻回去核对。
  s.reason = j.evidence[0] ?? ''
  s.source = j.source
  s.lastConfidence = j.confidence
  s.minor = Math.abs(moodStep) < 1 && DIMS.every((k) => Math.abs(j.dims[k]) < 3)
  s.updatedAt = at
  s.lastDecayAt = at
  s.lastNotedMood = s.mood
  return { state: s, changed: true, why: 'changed' }
}

/**
 * 一行文案：**不说数值**，只给一句底子。
 *
 * 例：`今天有点沉。` / `今天轻快些。` / `今天有点沉，还累。（不想做可以说）`
 * 沉（mood < 40）或累（tired ≥ 25）时，在同一行尾补一句固定提示——
 * 那句话只是提示，不动任何权限。
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
  const budget = MOOD_LINE_CAP - (wantHint ? HINT.length : 0)
  const body = accented.length <= budget ? accented : plain
  const line = wantHint ? `${body}${HINT}` : body
  return line.length > MOOD_LINE_CAP ? line.slice(0, MOOD_LINE_CAP) : line
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
 * 「{上一状态, 本轮信号} → {新状态, 是否注入, 注入文案}」。
 *
 * @param {object} prev 上一状态
 * @param {object} signal 本轮信号（带 assistantTexts 就走新路径）
 * @param {object} [opts] { halfLifeMin, perDay, minDelta, cooldownHours }
 * @returns {{state:object, inject:object, changed:boolean, why:string}}
 */
export function applyTurn(prev, signal, opts = {}) {
  const n = note(prev, signal, opts)
  const at = Number(signal?.at) || Date.now()
  // 记账那一步不决定说不说：开口发生在渲染那一刻（speakForContext）。
  // 否则 turn/end 就把四道闸吃掉一次，等真正渲染时只剩 `already`，永远说不出去。
  if (opts.decide === false) {
    return { state: n.state, inject: { yes: false, text: '', why: 'bookkeeping' }, changed: n.changed, why: n.why }
  }
  if (!n.changed) {
    // 没变就别谈说：但已经在等说的旧变化仍然可以按闸走一遍
    const r = say(n.state, at, opts)
    return { state: r.state, inject: r.inject, changed: false, why: n.why }
  }
  const r = say(n.state, at, opts)
  return { state: r.state, inject: r.inject, changed: true, why: r.inject.why }
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

// ---- 出口：「我不想做」那本账 ----

/**
 * 我这一轮说的话里有没有「我不想做」这类句子。**只记我的原话，只记不执行。**
 *
 * @param {string[]} texts 我的话
 * @returns {string[]} 命中的原句（每句截 80 字，最多 3 句）
 */
export function matchUnwilling(texts) {
  const hits = []
  for (const raw of texts ?? []) {
    for (const line of sentencesOf(raw)) {
      if (UNWILLING.test(line)) hits.push(line.slice(0, 80))
    }
  }
  return hits.slice(0, 3)
}

/** 本地时间戳：`2026-11-05 22:10`（不用 toISOString，那是 UTC）。 */
const stampOf = (at) => {
  const d = new Date(at)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 往「我不想做」那本账里追加一行：时间 + 我的原话。
 *
 * 文件不存在就带上三行头（说清「只记录，不执行」）。写不上就算了——这本账不该拖垮对话。
 *
 * @param {string} file 绝对路径
 * @param {string} quote 我的原话
 * @param {number} [at] 现在
 * @returns {string} 写进去的那一行；写不上返回 ''
 */
export function appendUnwilling(file, quote, at = Date.now()) {
  const body = String(quote ?? '').trim()
  if (file === '' || body === '') return ''
  const line = `- ${stampOf(at)} 我说：「${body}」`
  try {
    mkdirSync(dirname(file), { recursive: true })
    if (!existsSync(file)) {
      writeFileSync(file, '# 我不想做\n\n> 只记录，不执行。我说过「不想做」的每一次，留在这里事后核对。\n\n', 'utf8')
    }
    appendFileSync(file, `${line}\n`, 'utf8')
    return line
  } catch { return '' }
}

// ---- 存储 ----
//
// 当前状态一条 meta（和 consolidate.mjs:73 一样 INSERT OR REPLACE）；
// 历史落 mood_log，`day` 冗余存本地日期，省得查询里做时区算术。

/**
 * 建表：mood_log + (day, space) 索引。
 *
 * 和 `tidy.ensureHitColumns` / `facts.ensureFactColumns` 一样是「老库补结构」的一环，
 * 由 lib/index.mjs 启动时调一次；表已存在就什么都不做。
 *
 * @param {object} db 记忆库
 */
export function ensureMoodTable(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mood_log (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        at       INTEGER NOT NULL,
        day      TEXT NOT NULL,
        space    TEXT NOT NULL DEFAULT 'default',
        mood     INTEGER NOT NULL,
        dims     TEXT NOT NULL DEFAULT '{}',
        raw      REAL NOT NULL DEFAULT 0,
        conf     INTEGER NOT NULL DEFAULT 0,
        injected INTEGER NOT NULL DEFAULT 0,
        reason   TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_mood_day ON mood_log(day, space);
    `)
  } catch { /* 建不出来就当作没有这张表：记账失败不能拖垮对话 */ }
}

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

/**
 * 落一行历史。`at` 是账单的唯一时间点，重复落同一 `at` 由上层挡（见 applyMoodTurn）。
 *
 * @param {object} db 记忆库
 * @param {object} row { at, day, space, state, raw, injected, reason }
 */
export function logTurn(db, row) {
  const at = Number(row.at) || Date.now()
  const s = row.state ?? {}
  try {
    db.prepare(`INSERT INTO mood_log (at, day, space, mood, dims, raw, conf, injected, reason)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      at,
      String(row.day ?? dayKeyOf(new Date(at))),
      String(row.space ?? 'default'),
      Math.round(Number(s.mood) || 0),
      JSON.stringify(Object.fromEntries(DIMS.map((k) => [k, Math.round(Number(s.dims?.[k]) || 0)]))),
      Number(row.raw) || 0,
      Math.round(Number(s.lastConfidence) || 0),
      row.injected ? 1 : 0,
      String(row.reason ?? s.reason ?? ''),
    )
  } catch { /* 记不上这轮就算了 */ }
}

/**
 * 一轮记账：读状态 → 判一次 → 变了才回写 meta、才落 mood_log。
 *
 * 注入不在这里做：注入发生在渲染那一刻（`speakForContext`），
 * 真说了话就把对应那行 `mood_log.injected` 标成 1（见下）。
 * 同一轮重复调用（同一个 `at`）走 `same-turn`，不落第二笔——幂等靠这一条。
 *
 * @param {object} db 记忆库
 * @param {object} opts { space, signal, halfLifeMin, day, inject }
 * @returns {{state:object, inject:object, changed:boolean, why:string, logged:boolean}}
 */
export function applyMoodTurn(db, opts = {}) {
  const space = String(opts.space ?? 'default') || 'default'
  const signal = opts.signal ?? {}
  const at = Number(signal.at) || Date.now()
  const prev = loadState(db, space, at)
  // decide: false —— 这一轮只记账，说不说留给渲染那一刻（见 applyTurn 里的注释）。
  const r = applyTurn(prev, signal, {
    halfLifeMin: opts.halfLifeMin,
    perDay: opts.perDay,
    minDelta: opts.minDelta,
    cooldownHours: opts.cooldownHours,
    decide: false,
  })
  if (!r.changed) {
    saveState(db, space, r.state)
    return { ...r, logged: false }
  }
  saveState(db, space, r.state)
  logTurn(db, {
    at,
    day: opts.day ?? dayKeyOf(new Date(at)),
    space,
    state: r.state,
    // raw 记「这一轮总值动了多少」：判定原文（judge 的 raw）没落库，落库的是它除完 3 之后的实际变化。
    raw: Math.round(r.state.mood - prev.mood),
    injected: 0,
    reason: r.state.reason,
  })
  return { ...r, logged: true }
}

/**
 * 渲染那一刻用：读状态 → 过四道闸 → 该说就说话，并且把那行日志标成「真注入了」。
 *
 * @param {object} db 记忆库
 * @param {object} [opts] { space, now, dailyMax, minDelta, cooldownHours }
 * @returns {{text:string, why:string, state:object}}
 */
export function speakForContext(db, opts = {}) {
  const space = String(opts.space ?? 'default') || 'default'
  const now = Number(opts.now) || Date.now()
  const s = loadState(db, space, now)
  const r = say(s, now, {
    perDay: opts.dailyMax,
    minDelta: opts.minDelta,
    cooldownHours: opts.cooldownHours,
  })
  // already = 什么都没动，不写库；其余每条路径都动过状态。
  if (r.inject.why !== 'already') saveState(db, space, r.state)
  if (r.inject.yes) {
    try {
      db.prepare('UPDATE mood_log SET injected=1 WHERE at=? AND space=?')
        .run(Number(s.updatedAt) || 0, space)
    } catch { /* 标不上不影响说话 */ }
  }
  return { text: r.inject.yes ? r.inject.text : '', why: r.inject.why, state: r.state }
}

/**
 * 只读查询：每天的均值/最低/最高/条数 + 最近 N 条明细。
 *
 * 参数越界一律截断，不报错（days 夹到 1–90，recent 夹到 1–100）。
 *
 * @param {object} db 记忆库
 * @param {object} [opts] { days, space, recent }
 * @returns {{days:Array, recent:Array}} 空库返回 { days: [], recent: [] }
 */
export function readMood(db, opts = {}) {
  const days = Math.min(90, Math.max(1, Number(opts.days) || 7))
  const recentN = Math.min(100, Math.max(1, Number(opts.recent) || 20))
  const space = String(opts.space ?? '').trim() || 'default'
  const from = new Date(Date.now() - (days - 1) * 86400000)
  const fromKey = dayKeyOf(from)
  let rows = []
  let recent = []
  try {
    rows = db.prepare(`
      SELECT day, CAST(round(avg(mood)) AS INTEGER) mood, min(mood) lo, max(mood) hi, count(*) n
      FROM mood_log WHERE space=? AND day >= ? GROUP BY day ORDER BY day ASC
    `).all(space, fromKey)
    recent = db.prepare('SELECT at, mood, reason FROM mood_log WHERE space=? ORDER BY at DESC LIMIT ?')
      .all(space, recentN)
  } catch {
    return { days: [], recent: [] }
  }
  return {
    days: rows.map((r) => ({ day: r.day, mood: r.mood, min: r.lo, max: r.hi, count: r.n })),
    recent: recent.map((r) => ({ at: r.at, mood: r.mood, reason: r.reason })),
  }
}
