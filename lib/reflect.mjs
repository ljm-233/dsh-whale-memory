/**
 * 反思：一天一条，可撤销。
 *
 * 这一版**不改任何文件**：只落表 + 打印建议，真改 `notes/VOICE.md` 由人手动确认。
 * 三道闸都是反表演的（见 brain-plan 3.3）：
 *   1. 一天最多一条：`day` 唯一——反思一旦变成日常产出，就成了台词；
 *   2. 一周内不许重复同一条：按 `before/after` 的指纹去重（同一条规矩不反复改）；
 *   3. 改动对象只允许 `notes/VOICE.md`：别的地方不是「规矩」，是内容。
 *
 * 改之前留 `.bak`（带时间戳）：`before` 也逐字留在表里，所以任何时候都能逐字退回。
 */
import { existsSync, copyFileSync } from 'node:fs'
import { dayKeyOf } from './shared.mjs'

/** 唯一允许被反思改动的文件（相对记忆库根）。 */
export const ALLOWED_FILE = 'notes/VOICE.md'

/** 「一周」的窗口：按自然日算，含今天。 */
export const DEDUPE_DAYS = 7

/**
 * 建表。挂 `ensure*` 迁移段。
 *
 * @param {object} db 记忆库
 */
export function ensureReflectionTable(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reflection (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        day          TEXT NOT NULL UNIQUE,
        changed_file TEXT NOT NULL DEFAULT 'notes/VOICE.md',
        before       TEXT NOT NULL DEFAULT '',
        after        TEXT NOT NULL DEFAULT '',
        reason       TEXT NOT NULL DEFAULT '',
        reverted     INTEGER NOT NULL DEFAULT 0
      );
    `)
  } catch { /* 建不出表就当没有反思层 */ }
}

/** 归一化：只为了判「是不是同一条」，不影响存下来的原文。 */
const norm = (s) => String(s ?? '').replace(/\s+/gu, ' ').trim()

/** 内容指纹：同一对 before/after 在窗口内只允许出现一次。 */
export function fingerprintOf(before, after) {
  const s = `${norm(before)}\u0000${norm(after)}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 时间戳 → `YYYYMMDD-HHmmss`（本地时区，和 `.bak` 文件名一致）。 */
export function stampOf(at = Date.now()) {
  const d = new Date(at)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 改文件之前留一份 `.bak.<时间戳>`。
 *
 * 文件不存在就不留（没东西可备份），返回空串。
 *
 * @param {string} file 目标文件
 * @param {number} [at] 时间戳
 * @returns {string} 备份路径，或 ''
 */
export function backupBeforeWrite(file, at = Date.now()) {
  const path = String(file ?? '')
  if (path === '' || !existsSync(path)) return ''
  const bak = `${path}.bak.${stampOf(at)}`
  try {
    copyFileSync(path, bak)
    return bak
  } catch { return '' }
}

/**
 * 提一条反思建议。
 *
 * 过闸顺序固定（先便宜后贵）：空 / 没变 → 文件不许 → 一天一条 → 一周不重复。
 * 全过才落表并生成 `.bak`，然后**停在这里**：不改 VOICE.md。
 *
 * @param {object} db 记忆库
 * @param {{day?:string, changedFile?:string, before:string, after:string, reason?:string,
 *          now?:number, voicePath?:string}} opts
 * @returns {{ok:boolean, code?:string, message:string, id?:number, backup?:string, suggestion?:string}}
 */
export function propose(db, opts = {}) {
  const now = Number(opts.now ?? Date.now())
  const day = String(opts.day ?? dayKeyOf(new Date(now)))
  const changedFile = String(opts.changedFile ?? ALLOWED_FILE)
  const before = String(opts.before ?? '')
  const after = String(opts.after ?? '')
  const reason = String(opts.reason ?? '')

  if (norm(before) === '' || norm(after) === '') {
    return { ok: false, code: 'empty', message: 'before/after 都得有原文，空的不算反思' }
  }
  if (norm(before) === norm(after)) {
    return { ok: false, code: 'no-change', message: 'before 和 after 一样，等于没改' }
  }
  if (changedFile !== ALLOWED_FILE) {
    return { ok: false, code: 'file-not-allowed', message: `只允许改 ${ALLOWED_FILE}，不收 ${changedFile}` }
  }

  // 闸 1：一天一条
  try {
    const today = db.prepare('SELECT id FROM reflection WHERE day=?').get(day)
    if (today) return { ok: false, code: 'day-taken', message: `${day} 已经有一条反思了（一天最多一条）` }
  } catch { /* 表没建好就当没闸 */ }

  // 闸 2：一周内不许重复同一条
  const fp = fingerprintOf(before, after)
  try {
    const since = dayKeyOf(new Date(now - (DEDUPE_DAYS - 1) * 86400_000))
    const rows = db.prepare('SELECT day, before, after FROM reflection WHERE day >= ?').all(since)
    for (const r of rows) {
      if (fingerprintOf(r.before, r.after) === fp) {
        return { ok: false, code: 'repeat', message: `${r.day} 已经提过同一条改动（指纹 ${fp}），一周内不重复` }
      }
    }
  } catch { /* 同上 */ }

  // 闸 3：留 .bak（有文件才留），落表，然后停手
  const backup = String(opts.voicePath ?? '') === '' ? '' : backupBeforeWrite(String(opts.voicePath), now)
  let id = 0
  try {
    const info = db.prepare(
      'INSERT INTO reflection(day,changed_file,before,after,reason,reverted) VALUES(?,?,?,?,?,0)',
    ).run(day, changedFile, before, after, reason)
    id = Number(info?.lastInsertRowid ?? 0)
  } catch (e) {
    return { ok: false, code: 'db', message: `落表失败：${e.message}` }
  }

  const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}…` : s)
  const suggestion = `建议：${changedFile} 里「${clip(before)}」→「${clip(after)}」${reason === '' ? '' : `（理由：${reason}）`}`
  return {
    ok: true,
    id,
    backup,
    message: `${suggestion}｜未自动写入，等你确认${backup === '' ? '' : `；原件已备份 ${backup}`}`,
    suggestion,
  }
}

/**
 * 撤销：把 `reverted` 置 1。表里 `before` 逐字都在，所以退回不靠记忆。
 *
 * @param {object} db 记忆库
 * @param {number} id 行 id
 * @returns {{ok:boolean, message:string, row?:object}}
 */
export function revert(db, id, opts = {}) {
  const row = (() => {
    try { return db.prepare('SELECT * FROM reflection WHERE id=?').get(Number(id)) } catch { return null }
  })()
  if (!row) return { ok: false, message: `没有 id=${id} 这条反思` }
  if (Number(row.reverted) === 1) return { ok: false, message: `id=${id} 已经撤过了` }
  try {
    db.prepare('UPDATE reflection SET reverted=1 WHERE id=?').run(Number(id))
  } catch (e) {
    return { ok: false, message: `撤销失败：${e.message}` }
  }
  const backup = String(opts.voicePath ?? '') === '' ? '' : backupBeforeWrite(String(opts.voicePath), Number(opts.now ?? Date.now()))
  return { ok: true, row, backup, message: `已标记撤销（id=${id}），把「${row.after.slice(0, 40)}」换回「${row.before.slice(0, 40)}」` }
}

/** 最近几条（人工抽查用：一条命令就能看见最近改了什么）。 */
export function recent(db, limit = 5) {
  try {
    return db.prepare('SELECT id, day, changed_file, before, after, reason, reverted FROM reflection ORDER BY day DESC LIMIT ?')
      .all(Math.max(1, Math.min(50, Number(limit) || 5)))
  } catch { return [] }
}
