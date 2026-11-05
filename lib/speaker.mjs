/**
 * 说话人：一条记忆是谁说的。
 *
 * 只认两样东西，别的一律留空：
 *   1. 正文里**已经存在**的痕迹（`<@OPENID…>` 前缀、`<dsh_im_source>{"senderId":…}`）。
 *   2. 群档 `group-history.sqlite` 里 ±10 分钟窗内的**唯一**对齐。
 *
 * 为什么不能猜：猜错会污染长期记忆，而且错得很安静（`docs/brain-plan.md` 第六节）。
 * 所以这里所有出口都遵守同一条规矩——认不出就是空串，空串表示「不知道谁说的」。
 *
 * 库里只存 openid 前 8 位大写十六进制；明文留在 `~/.dsh/miyu/private/`，不进库。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db-open.mjs'

/** 群档的默认位置（隔壁插件的库，只读打开）。 */
export const GROUP_DB = join(homedir(), '.dsh', 'integrations', 'dsh-im', 'group-history.sqlite')

/** 对齐窗口：对齐依据是「同一句话 + 同一个十分钟」，再宽就会张冠李戴。 */
export const WINDOW_MS = 10 * 60 * 1000

/** 太短的正文没有对齐价值：一个字能对上几十条，唯一性纯属偶然。 */
export const MIN_NEEDLE = 4
/** 前缀对齐要求短的那边至少这么长：5~7 字的一句话在十分钟窗里撞车不算罕见。 */
export const MIN_FULL_NEEDLE = 8
/** 条目被 PART_CAP(300) 截断时才走「条目是群档前缀」这条：别的一律不算。 */
export const TRUNC_NEEDLE = 100

const HEX8 = /^[0-9A-F]{8}$/
/** `<@OPENID…>`：QQ 群里被 @ 的前缀，openid 是 32 位十六进制，只取前 8。 */
const AT_RE = /<@([0-9A-Fa-f]{8})/
/** 上下文增强块里的 `"senderId":"…"`。 */
const SENDER_RE = /"senderId"\s*:\s*"([0-9A-Fa-f]{8})/

/** 注入块：它们是**信封**，不是说的话，对齐前必须剥掉。 */
const BLOCK_RES = [
  /<dsh_im_source_guidance>[\s\S]*?<\/dsh_im_source_guidance>/g,
  /<dsh_im_source>[\s\S]*?<\/dsh_im_source>/g,
  /<dsh_im_context>[\s\S]*?<\/dsh_im_context>/g,
  /<dsh_im_reply_to>[\s\S]*?<\/dsh_im_reply_to>/g,
]
const MENTION_RE = /<@[0-9A-Fa-f]{6,}>/g

/**
 * openid → 库里那 8 位。任何不干净的值一律给空串，不做「尽力修一下」。
 *
 * @param {unknown} raw 原始标识
 * @returns {string} 8 位大写十六进制，或 ''
 */
export function toSpk(raw) {
  const s = String(raw ?? '').replace(/[^0-9A-Fa-f]/g, '').slice(0, 8).toUpperCase()
  return HEX8.test(s) ? s : ''
}

/**
 * 从正文里已有的痕迹认说话人。
 *
 * @param {string} text 条目正文（`entries.u`）
 * @returns {string} 8 位 spk，或 ''
 */
export function regexSpeaker(text) {
  const t = String(text ?? '')
  const m = SENDER_RE.exec(t) ?? AT_RE.exec(t)
  return m ? toSpk(m[1]) : ''
}

/**
 * 剥信封：注入块、@ 前缀、多余空白。剩下的才是「这个人说的字」。
 *
 * @param {string} text 任意一侧的正文
 * @returns {string} 归一化后的正文
 */
export function normUserText(text) {
  let t = String(text ?? '')
  for (const re of BLOCK_RES) t = t.replace(re, ' ')
  t = t.replace(MENTION_RE, ' ')
  return t.replace(/\s+/g, ' ').trim()
}

/**
 * 在候选里找唯一说话人。
 *
 * 命中判据（归一化后）：完全相等，或一方是另一方的**前缀**（短的那边至少 MIN_NEEDLE 字）。
 * 前缀是因为 `entries.u` 被 PART_CAP 截断、而群档是全文；短的一边太短就直接不判。
 *
 * @param {Array<{sender_id:string,text:string}>} rows 窗口内的群档行
 * @param {string} text 待对齐的正文
 * @returns {{spk:string, reason:'match'|'ambiguous'|'none'|'short'}}
 */
export function alignSpeaker(rows, text) {
  const a = normUserText(text)
  if (a.length < MIN_NEEDLE) return { spk: '', reason: 'short' }
  const hits = new Set()
  for (const r of Array.isArray(rows) ? rows : []) {
    const b = normUserText(r?.text)
    if (b === '') continue
    // 三个方向，都要「短的那边够长」：
    //  - 完全相等：最硬的证据；
    //  - 群档那条是条目的前缀：条目可能比群档长（后面还跟了别的东西）；
    //  - 条目是群档的前缀：只可能是 PART_CAP 截断（300 字），不可能是巧合。
    const hit = a === b
      || (b.length >= MIN_FULL_NEEDLE && a.startsWith(b))
      || (a.length >= TRUNC_NEEDLE && b.startsWith(a))
    if (!hit) continue
    const spk = toSpk(r.sender_id)
    if (spk !== '') hits.add(spk)
  }
  if (hits.size === 0) return { spk: '', reason: 'none' }
  if (hits.size > 1) return { spk: '', reason: 'ambiguous' }
  return { spk: [...hits][0], reason: 'match' }
}

/**
 * 读群档里某一刻前后窗口的候选。
 *
 * 群档是隔壁插件的库：只读打开，打不开就当没有（和 `lib/diary.mjs` 读语料库一个路子）。
 *
 * @param {string} dbPath 群档路径
 * @param {number} at 毫秒时间戳（`entries.t`）
 * @param {number} [windowMs] 窗口半宽
 * @returns {Array<{sender_id:string,text:string}>}
 */
export function readGroupWindow(dbPath, at, windowMs = WINDOW_MS) {
  if (!dbPath || !existsSync(dbPath)) return []
  let g = null
  try {
    g = openDb(dbPath, { readOnly: true, timeout: 2000 })
    return g.prepare('SELECT sender_id, text FROM messages WHERE sent_at BETWEEN ? AND ?')
      .all(Math.trunc(at) - windowMs, Math.trunc(at) + windowMs)
  } catch { return [] } finally {
    try { g?.close() } catch { /* 关不上就算了，只读连接 */ }
  }
}

/**
 * 造一个「这一句是谁说的」解析器，给写入路径用。
 *
 * 顺序：正文痕迹 → 群档唯一对齐 → 空串。开关关掉就永远空串（写入行为回到今天）。
 *
 * @param {object} [opts]
 * @param {() => boolean} [opts.enabled] 是否启用（默认开）
 * @param {() => string} [opts.dbPath] 群档路径
 * @param {number} [opts.windowMs] 窗口半宽
 * @returns {(text:string, at:number) => string}
 */
export function createSpeakerResolver(opts = {}) {
  const enabled = typeof opts.enabled === 'function' ? opts.enabled : () => opts.enabled !== false
  const dbPath = typeof opts.dbPath === 'function' ? opts.dbPath : () => opts.dbPath ?? GROUP_DB
  const windowMs = Number(opts.windowMs ?? WINDOW_MS)
  return (text, at = Date.now()) => {
    if (enabled() !== true) return ''
    const direct = regexSpeaker(text)
    if (direct !== '') return direct
    let path = GROUP_DB
    try { path = String(dbPath() ?? '') || GROUP_DB } catch { path = GROUP_DB }
    return alignSpeaker(readGroupWindow(path, at, windowMs), text).spk
  }
}

/**
 * 老库补说话人列与 person 表。挂在既有 `ensure*` 段里，重复执行安全。
 *
 * DDL 与 `docs/brain-plan.md` 一字不差：
 *   - `spk TEXT NOT NULL DEFAULT ''`（空串 = 不知道谁说的，老查询一个字不用改）
 *   - `imp REAL`（NULL = 自动，只存人工覆盖）
 *   - `person`：`name` **不设唯一**——ARK / 梁 两个 spk 同名
 *
 * @param {object} db 记忆库
 * @returns {boolean} 补成功了没有
 */
export function ensureSpeakerColumns(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(entries)').all().map((c) => c.name)
    if (!cols.includes('spk')) db.exec("ALTER TABLE entries ADD COLUMN spk TEXT NOT NULL DEFAULT ''")
    if (!cols.includes('imp')) db.exec('ALTER TABLE entries ADD COLUMN imp REAL')
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entries_spk_t ON entries(spk, t);
      CREATE TABLE IF NOT EXISTS person (
        spk     TEXT NOT NULL,
        space   TEXT NOT NULL DEFAULT 'default',
        name    TEXT NOT NULL,
        aka     TEXT NOT NULL DEFAULT '[]',
        score   REAL NOT NULL DEFAULT 1,
        source  TEXT NOT NULL DEFAULT '',
        updated INTEGER NOT NULL,
        PRIMARY KEY (spk, space)
      );
      CREATE INDEX IF NOT EXISTS idx_person_name ON person(space, name);
    `)
    return true
  } catch { return false }
}
