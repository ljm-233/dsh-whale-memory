/**
 * 情绪记账：每轮结束判一次、涨落一次，写进库里；**不注入任何东西**。
 *
 * 三步分开，对应参考实现的两个阶段（lib/index.js:1402 的 applyDelta 与 :1601 的 context text）：
 *   note(上一状态, 本轮信号)  → 判一次、涨落一次（变化不够大就不动，别把时间戳往前推）
 *   say(状态)                → 在渲染那一刻过四道闸，决定说不说（本阶段只留接口，不接注入口）
 *   applyTurn(...)           → 两者合一，就是「{上一状态, 本轮信号} → {新状态, 是否注入, 文案}」
 *
 * 信号全部现成可得，没有新数据源：
 * - 词表取 whale-memory lib/constants.mjs 的 EMOTION_WORDS
 * - 本轮 kind 来自 DSH turn/end 的 reason.kind（packages/core/agent-loop/src/agent.ts:391）
 * - 饱和、1/3 步长、90 分钟单维半衰、四道闸，对齐参考实现 lib/index.js:1402-1414 / :891-909 / :1615-1636
 *
 * 设计依据见 `docs/mood-design.md`。当前只做「记账 + 查询」，注入还没开：
 * 没有两周真实分布，门槛/上限/基线都只能抄参考实现，抄来的数字不能当定论。
 *
 * @module mood
 */
import { dayKeyOf } from './shared.mjs'

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
/** 注入置信门槛、每日上限（index.js:187 / :194）：这一阶段只用来算 why，不影响记账。 */
export const CONF_MIN = 60
export const PER_DAY = 6

const MIN = 60_000
const numClamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** 情绪词表：只挑 whale-memory EMOTION_WORDS 里已有的词（constants.mjs:114-120）。 */
const WORDS = {
  tired: ['累', '困', '疲惫', '撑不住', '熬夜', '没睡'],
  sad: ['难过', '伤心', '失落', '委屈', '想哭', '烦', '气死'],
  happy: ['开心', '高兴', '太好了', '哈哈', '笑死', '棒', '爽'],
  care: ['想你', '陪我', '你呢', '你还', '舍不得'],
}
const PRAISE = ['不错', '厉害', '谢谢', '喜欢', '好用']
const NEGATE = ['不对', '错了', '重来', '别', '没用']

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
    minor: false,
    reason: '',
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

/**
 * 从本轮信号算原始判定（未饱和、未除 3）。
 *
 * @param {object} signal { at, userTexts, kind, hour, turnStreak }
 * @returns {{dims:object, raw:number, confidence:number, evidence:string[]}}
 */
function judge(signal) {
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
  // 置信：命中证据条数给分，纯时间点信号撑不到门槛
  const confidence = numClamp(30 + evidence.length * 15, 0, 95)
  return { dims: d, raw, confidence, evidence }
}

const label = (v) => (v >= 78 ? '高兴' : v >= 60 ? '还行' : v >= 45 ? '平静' : v >= 32 ? '有点沉' : '很低')
const PLAIN = { happy: '高兴', tired: '累', sad: '难过', care: '在意' }

/**
 * 一行文案，≤60 字。这一阶段不注入，只留给 `say()` 与以后的面板用。
 *
 * @param {object} s 状态
 * @returns {string} 文案
 */
function buildLine(s) {
  const top = DIMS.filter((k) => s.dims[k] >= 8).sort((a, b) => s.dims[b] - s.dims[a]).slice(0, 2)
  const state = `（这会儿）${label(s.mood)}` + (top.length ? `，还${top.map((k) => PLAIN[k]).join('、')}` : '')
  const why = String(s.reason ?? '').trim()
  const line = why === '' ? state : `${state} —— ${why}`
  return line.length > 60 ? line.slice(0, 60) : line
}

/**
 * 这一轮结束：判一次、涨落一次。
 *
 * 变化不够大（参考实现 sigMood/sigDim 以下）就只走衰减，**不推进 updatedAt**——
 * 同一轮里的重复调用（每一步都会重算一次）因此能被「同一轮」挡住，不会记两笔。
 *
 * @param {object} prev 上一状态
 * @param {object} signal { at, userTexts, kind, hour, turnStreak }
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
  if (!big) return { state: s, changed: false, why: 'below-threshold' }

  const 在顶 = s.mood >= 85 && j.raw > 0
  const 在底 = s.mood <= 40 && j.raw < 0
  const 因子 = 在顶 || 在底 ? 0.5 : 1
  const moodStep = Math.round((j.raw * 因子) / MOOD_STEP_DIVISOR)

  s.mood = numClamp(s.mood + moodStep, 0, 100)
  for (const k of DIMS) s.dims[k] = numClamp(s.dims[k] + j.dims[k], 0, 100)
  s.reason = j.evidence[0] ?? ''
  s.lastConfidence = j.confidence
  s.minor = Math.abs(moodStep) < 1 && DIMS.every((k) => Math.abs(j.dims[k]) < 3)
  s.updatedAt = at
  s.lastDecayAt = at
  s.lastNotedMood = s.mood
  return { state: s, changed: true, why: 'changed' }
}

/**
 * 渲染那一刻：四道闸，决定说不说。
 *
 * 当前阶段没有任何注入口调用它，`applyTurn` 会走一遍并把 `why` 带回来——
 * 这样以后开注入时，拦截原因已经攒在库里（`mood_log.reason` + 返回值）可以直接数。
 *
 * @param {object} prev 当前状态
 * @param {number} [now] 现在
 * @param {object} [opts] { confMin, perDay }
 * @returns {{state:object, inject:{yes:boolean, text:string, why:string}}}
 */
export function say(prev, now = Date.now(), opts = {}) {
  const s = { ...prev, saidAt: [...(prev.saidAt ?? [])] }
  // 闸 1：这次变化已经说过了（一轮里每一步都会重渲 context，靠它挡住重复）
  if (s.injectedFor === s.updatedAt) return { state: s, inject: { yes: false, text: '', why: 'already' } }
  // 闸 2：小波动只记账
  if (s.minor) { s.injectedFor = s.updatedAt; return { state: s, inject: { yes: false, text: '', why: 'minor' } } }
  // 闸 3：判得没底 → 只记账（标成处理过，免得每轮重复）
  if (s.lastConfidence < (opts.confMin ?? CONF_MIN)) {
    s.injectedFor = s.updatedAt
    return { state: s, inject: { yes: false, text: '', why: 'low-confidence' } }
  }
  // 闸 4：日上限
  const day0 = new Date(now)
  day0.setHours(0, 0, 0, 0)
  const saidToday = s.saidAt.filter((t) => t >= day0.getTime()).length
  if (saidToday >= (opts.perDay ?? PER_DAY)) {
    s.injectedFor = s.updatedAt
    return { state: s, inject: { yes: false, text: '', why: 'daily-cap' } }
  }

  const text = buildLine(s)
  if (text === '') return { state: s, inject: { yes: false, text: '', why: 'empty' } }
  s.injectedFor = s.updatedAt
  s.saidAt = [...s.saidAt, now].slice(-200)
  s.lastInjectedText = text
  return { state: s, inject: { yes: true, text, why: 'ok' } }
}

/**
 * 「{上一状态, 本轮信号} → {新状态, 是否注入, 注入文案}」。
 *
 * @param {object} prev 上一状态
 * @param {object} signal 本轮信号
 * @param {object} [opts] { halfLifeMin, confMin, perDay }
 * @returns {{state:object, inject:object, changed:boolean, why:string}}
 */
export function applyTurn(prev, signal, opts = {}) {
  const n = note(prev, signal, opts)
  const at = Number(signal?.at) || Date.now()
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
 * **不注入**：`applyTurn` 返回的 `inject` 只当作「以后说不说」的判据，这里一个字都不往外送。
 * 同一轮重复调用（同一个 `at`）走 `same-turn`，不落第二笔——幂等靠这一条。
 *
 * @param {object} db 记忆库
 * @param {object} opts { space, signal, halfLifeMin, day }
 * @returns {{state:object, inject:object, changed:boolean, why:string, logged:boolean}}
 */
export function applyMoodTurn(db, opts = {}) {
  const space = String(opts.space ?? 'default') || 'default'
  const signal = opts.signal ?? {}
  const at = Number(signal.at) || Date.now()
  const prev = loadState(db, space, at)
  const r = applyTurn(prev, signal, { halfLifeMin: opts.halfLifeMin })
  if (!r.changed) return { ...r, logged: false }
  saveState(db, space, r.state)
  // injected 恒为 0：这一阶段没有任何注入口。等开注入时再按 say() 的 yes 写。
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
