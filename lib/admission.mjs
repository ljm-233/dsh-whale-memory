/**
 * 取舍层（影子模式）：这条该入库、只进日志、还是忘掉。
 *
 * 三条铁律，写在最前面：
 *   1. **纯规则，不调模型**。模型版连「为什么漏了这条」都说不清，规则版能对账。
 *   2. **决定和理由一起落盘**。只存 `decision` 的账，一周后没人说得清当时为什么这么判，
 *      所以 `reason` 里必须带上命中的每条规则名和它的原始信号值。
 *   3. **默认只记不动**。`applied=0` = 影子：写表一行，入库行为一个字不改。
 *      只有把设置项 `admitShadow` 关掉，`drop` 才真的拦下那条写入（`applied=1`）。
 *
 * 表和 `entries` 同库，删表即回滚——没有任何既有路径读 `admit`。
 */
import { detectEmotions, overlap } from './language.mjs'
import { clamp } from './shared.mjs'

/** 影子模式下 `applied` 恒为 0；关掉影子才写 1。 */
export const SHADOW = 0
/** 决策真的落到写入路径上了。 */
export const APPLIED = 1

/** 只打招呼/表情/单字：没有可记的东西。 */
const GREET_RE = /^(?:嗯+|哦+|噢+|啊+|呃+|好|好的|好吧|在吗|在不在|早|早安|晚安|午安|哈+|嘿+|诶+|喂|hi|hello|ok|草|1|6|666|\.{2,}|。{2,})[。！？~～!?…\s]*$/iu
/** 一次性信息：抄下来只会变成过期噪音。 */
const ONESHOT_RE = /验证码|校验码|动态码|临时口令|一次性(?:口令|链接|码)|口令是|密码是|取件码|\btoken\b|\b\d{6}\b/iu
/** 事实句式：这条以后会被当成「已知」用。 */
const FACT_RE = /我叫|我是|我在|我喜欢|我爱|我住|我不喜欢|我的|我在做|我在弄|我这边/iu
/** 承诺/待办：说出口就得有人接。 */
const PROMISE_RE = /我去做|我会|我明天|明天|记得|待办|别忘|回头|下周|晚点/iu

/**
 * 判据表。每条规则都能在 `reason` 里报出自己的名字和贡献值。
 *
 * `delta` 相加得 `score`：`≥4` 入库、`1~3` 只进日志、`≤0` 忘掉。
 * 单条规则的分不是拍脑袋：事实句是硬信号（+3），长度和承诺只是佐证（+2/+1），
 * 重复度是负向证据（-3）。
 *
 * `veto: true` 的规则是**一票否决**：命中就忘掉，不再看总分。
 * 为什么「一次性信息」必须否决而不是扣分：验证码旁边往往还跟着一句正常的话，
 * 加分一叠加就会变成「值得记」——而那条口令半小时后就过期了，记下来只是污染。
 */
export const RULES = [
  { id: 'greet-only', delta: -4, veto: true, why: '只是打招呼/表情/单字', test: (t) => GREET_RE.test(t) },
  { id: 'one-shot', delta: -4, veto: true, why: '含临时口令或一次性信息', test: (t) => ONESHOT_RE.test(t) },
  { id: 'fact', delta: 3, why: '含事实句式', test: (t) => FACT_RE.test(t) },
  { id: 'emotional-impact', delta: 2, why: '含情绪词', test: (t) => detectEmotions(t).length > 0 },
  { id: 'long', delta: 2, why: '长度 ≥ 20 字', test: (t) => t.length >= 20 },
  { id: 'promise-todo', delta: 1, why: '含承诺/待办', test: (t) => PROMISE_RE.test(t) },
]

/** 与热区条目的二元组重叠到这条线就算「重复度高」——只进日志，不再占一条记忆。 */
export const DUP_LINE = 0.6

/** 入库 / 只进日志 / 忘掉 这三档的分界。 */
export const KEEP_SCORE = 4

/** FNV-1a：内容指纹，用来把决定对回 `entries` 的正文。不落依赖，16 位十六进制。 */
export function fingerprint(text) {
  let h = 0x811c9dc5
  const s = String(text ?? '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 判一条输入该怎么处理。
 *
 * 纯函数：同一句话 + 同一批热区文本，永远给同一个决定——这是能事后复查的前提。
 *
 * @param {string} text 待判的原文（一般是这一轮对方说的话）
 * @param {{recent?:string[]}} [opts] `recent` 是热区里已有的正文，用来判重复度
 * @returns {{decision:'keep'|'log-only'|'drop', score:number, reason:string, subject:string, dup:number}}
 */
export function judge(text, opts = {}) {
  const body = String(text ?? '').trim()
  const recent = Array.isArray(opts.recent) ? opts.recent : []
  let dup = 0
  for (const r of recent) {
    const s = String(r ?? '').trim()
    if (s === '') continue
    const ov = overlap(body, s)
    if (ov > dup) dup = ov
  }

  const hits = []
  let score = 0
  let veto = false
  for (const rule of RULES) {
    let on = false
    try { on = rule.test(body) === true } catch { on = false }
    if (!on) continue
    score += rule.delta
    if (rule.veto === true) veto = true
    hits.push(`${rule.id}${rule.delta > 0 ? '+' : ''}${rule.delta}`)
  }
  // 重复度单独一条：它不是二值规则，得把实际值写进 reason。
  if (dup >= DUP_LINE) {
    score -= 3
    hits.push('dup-high-3')
  }

  let decision = veto ? 'drop' : score >= KEEP_SCORE ? 'keep' : score >= 1 ? 'log-only' : 'drop'
  // 重复度高的一律不进库：同样的意思记第二遍没有信息量，只有噪音。
  if (decision === 'keep' && dup >= DUP_LINE) decision = 'log-only'

  const reason = `${hits.length === 0 ? 'no-rule' : hits.join(',')} | len=${body.length} dup=${dup.toFixed(2)} score=${score} -> ${decision}`
  return { decision, score, reason, subject: fingerprint(body), dup }
}

/**
 * 建表。挂在 `lib/index.mjs` 既有的 `ensure*` 迁移段里，老库补表、新库建表。
 *
 * @param {object} db 记忆库
 */
export function ensureAdmitTable(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS admit (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        at       INTEGER NOT NULL,
        kind     TEXT NOT NULL DEFAULT 'turn',
        subject  TEXT NOT NULL DEFAULT '',
        decision TEXT NOT NULL,
        reason   TEXT NOT NULL DEFAULT '',
        applied  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_admit_at ON admit(at);
    `)
  } catch { /* 建不出表就当没有这一层：记账失败不能拖垮对话 */ }
}

/** 热区里已有的正文：判重复度用，只读。 */
export function recentTexts(db, { space = 'default', limit = 20 } = {}) {
  try {
    return db.prepare('SELECT u FROM entries WHERE hot=1 AND space=? ORDER BY t DESC LIMIT ?')
      .all(String(space), limit).map((r) => String(r.u ?? ''))
  } catch { return [] }
}

/**
 * 判一条并落账。
 *
 * @param {object} db 记忆库
 * @param {{at?:number, kind?:string, text:string, space?:string, shadow?:boolean, recent?:string[]}} opts
 * @returns {{id:number, decision:string, reason:string, applied:number}}
 */
export function record(db, opts = {}) {
  const at = Number(opts.at ?? Date.now())
  const text = String(opts.text ?? '')
  const verdict = judge(text, { recent: opts.recent })
  const shadow = opts.shadow !== false
  const applied = shadow ? SHADOW : APPLIED
  let id = 0
  try {
    const info = db.prepare('INSERT INTO admit(at,kind,subject,decision,reason,applied) VALUES(?,?,?,?,?,?)')
      .run(at, String(opts.kind ?? 'turn'), verdict.subject, verdict.decision, clamp(verdict.reason, 200), applied)
    id = Number(info?.lastInsertRowid ?? 0)
  } catch { /* 写不进就只是少一行账，写入路径照旧 */ }
  return { id, ...verdict, applied }
}

/**
 * 对账用：某个时间点之后每档各几条。
 *
 * @param {object} db 记忆库
 * @param {number} since 毫秒时间戳
 * @returns {Array<{decision:string, applied:number, n:number}>}
 */
export function tally(db, since) {
  try {
    return db.prepare('SELECT decision, applied, COUNT(*) n FROM admit WHERE at >= ? GROUP BY decision, applied ORDER BY n DESC')
      .all(Number(since ?? 0))
  } catch { return [] }
}
