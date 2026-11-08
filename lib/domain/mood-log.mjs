/**
 * 情绪的落库与流程：判一次、涨落一次、写 meta、写 mood_log，以及渲染那一刻开口。
 *
 * 幂等靠「同一轮不推进 updatedAt」这一条，见 `note()`。
 * 「我不想做」那本账的追加也在这里（只记录，不执行）。
 *
 * @module mood-log
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dayKeyOf } from '../shared.mjs'
// `judge` 是老名字（原文件里的 `const judge = judgeSignal`），这里用别名保住调用点。
import { judgeSignal as judge, matchUnwilling } from './mood-judge.mjs'
import {
  DIMS, MOOD_CEIL, MOOD_FLOOR, MOOD_STEP_DIVISOR, SIG_DIM, SIG_RAW,
  decay, loadState, numClamp, saveState,
} from './mood-state.mjs'
import { say } from './mood-render.mjs'

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

  // 2026-11-08：加地板与天花板。原来 0–100 全开，而打分只看我自己说的话，
  // 于是「说得短→分低→提示该更短→更短」形成正反馈，一夜之间压到 0。
  // 地板 25 / 天花板 90：情绪还能动，但不再把自己压成没劲的样子。
  s.mood = numClamp(s.mood + moodStep, MOOD_FLOOR, MOOD_CEIL)
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

// ---- 出口：「我不想做」那本账 ----

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
