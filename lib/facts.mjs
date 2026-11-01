/**
 * 事实的有效期与冲突留痕。
 *
 * 一张事实被写进来之后不该永远等权：改口过的旧说法只是「不再成立」，
 * 不是「没发生过」。所以这里只做两件事——给事实记上有效期（valid_from /
 * valid_until），改口时把旧事实的 valid_until 盖上时间戳并留一行冲突记录。
 *
 * 全程不删任何行：失效只是不参与默认注入，历史照样查得到。
 */
import { similarity } from './language.mjs'
import { clamp } from './format.mjs'

/** 短文本事实的高度相似线：和记忆合并用的是同一个口味（0.62）。 */
const SIMILAR_ENOUGH = 0.62

/**
 * 老库补列：valid_from / valid_until，外加冲突表。
 *
 * SQLite 没有 ADD COLUMN IF NOT EXISTS，只能先问再改（同 tidy.ensureHitColumns）。
 * 老行没有写入时间可查，回填成现在；回填后不再为 0，重跑不会把它往后推。
 *
 * @param {object} db 记忆库
 * @param {number} [now] 当前时间
 * @returns {boolean} 补成功了没有
 */
export function ensureFactColumns(db, now = Date.now()) {
  try {
    const cols = db.prepare('PRAGMA table_info(facts)').all().map((c) => c.name)
    if (!cols.includes('valid_from')) db.exec('ALTER TABLE facts ADD COLUMN valid_from INTEGER NOT NULL DEFAULT 0')
    if (!cols.includes('valid_until')) db.exec('ALTER TABLE facts ADD COLUMN valid_until INTEGER')
    db.prepare('UPDATE facts SET valid_from = ? WHERE valid_from IS NULL OR valid_from = 0').run(now)
    db.exec(`
      CREATE TABLE IF NOT EXISTS fact_conflicts (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        old_id   INTEGER NOT NULL,
        new_id   INTEGER NOT NULL,
        reason   TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        created  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fact_conflicts_created ON fact_conflicts(created);
    `)
    return true
  } catch { return false }
}

/**
 * 读事实。默认只给仍成立的（valid_until 为空或还没到）。
 *
 * @param {object} db 记忆库
 * @param {object} [opts]
 * @param {string} [opts.space] 记忆空间
 * @param {number} [opts.limit] 最多几条
 * @param {boolean} [opts.includeExpired] 连失效的旧事实一起给
 * @param {number} [opts.now] 当前时间
 * @returns {Array<{id:number,f:string,valid_from:number,valid_until:number|null}>}
 */
export function listFacts(db, opts = {}) {
  const space = String(opts.space ?? 'default')
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 12))
  const now = Number(opts.now) || Date.now()
  const rows = opts.includeExpired === true
    ? db.prepare('SELECT id, f, valid_from, valid_until FROM facts WHERE space = ? ORDER BY id DESC LIMIT ?')
      .all(space, limit)
    : db.prepare('SELECT id, f, valid_from, valid_until FROM facts WHERE space = ? AND (valid_until IS NULL OR valid_until > ?) ORDER BY id DESC LIMIT ?')
      .all(space, now, limit)
  return rows.map((r) => ({
    id: Number(r.id),
    f: String(r.f ?? ''),
    valid_from: Number(r.valid_from ?? 0),
    valid_until: r.valid_until === null || r.valid_until === undefined ? null : Number(r.valid_until),
  }))
}

/**
 * 写一条事实：一模一样的就跳过；高度相似但内容不同的，是改口——
 * 给旧事实盖上 valid_until，再写一行 fact_conflicts，然后写下新事实。
 *
 * @param {object} db 记忆库
 * @param {object} input
 * @param {string} input.text 事实正文
 * @param {string} [input.space] 记忆空间
 * @param {number} [input.now] 当前时间
 * @returns {{written:boolean,id:number,conflict:boolean}}
 */
export function recordFact(db, input = {}) {
  const f = String(input.text ?? '').trim()
  const space = String(input.space ?? 'default')
  const now = Number(input.now) || Date.now()
  if (f === '') return { written: false, id: 0, conflict: false }

  const alive = db.prepare('SELECT id, f FROM facts WHERE space = ? AND (valid_until IS NULL OR valid_until > ?) ORDER BY id DESC')
    .all(space, now)
  for (const row of alive) {
    const old = String(row.f ?? '')
    // 原话重复：不新增行，也不算冲突。
    if (old === f) return { written: false, id: Number(row.id), conflict: false }
    // ponytail: 短文本只比字面相似度，0.62 是个口味值；事实长到需要向量时再换 cosine。
    if (similarity(old, f) < SIMILAR_ENOUGH) continue
    db.prepare('UPDATE facts SET valid_until = ? WHERE id = ?').run(now, row.id)
    const info = db.prepare('INSERT INTO facts(f, space, valid_from) VALUES(?,?,?)').run(f, space, now)
    const newId = Number(info.lastInsertRowid)
    db.prepare('INSERT INTO fact_conflicts(old_id, new_id, reason, evidence, created) VALUES(?,?,?,?,?)')
      .run(
        Number(row.id),
        newId,
        'superseded',
        `旧：${clamp(old, 80)}｜新：${clamp(f, 80)}`,
        now,
      )
    return { written: true, id: newId, conflict: true }
  }

  // 文本本身是 UNIQUE：别的空间写过同样一句就写不进来，按老行为跳过。
  const info = db.prepare('INSERT OR IGNORE INTO facts(f, space, valid_from) VALUES(?,?,?)').run(f, space, now)
  return { written: Number(info.changes) > 0, id: Number(info.lastInsertRowid) || 0, conflict: false }
}

/**
 * 最近的冲突：只读，给模型和 /conflicts 端点看。
 *
 * 旧事实万一下架了（facts 有上限），join 出来的正文会是空，但 evidence 里
 * 两份摘要都还在，所以永远有东西可读。
 *
 * @param {object} db 记忆库
 * @param {object} [opts]
 * @param {number} [opts.limit] 最多几条
 * @returns {Array<object>}
 */
export function recentConflicts(db, opts = {}) {
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 20))
  return db.prepare(`
    SELECT c.id, c.old_id, c.new_id, c.reason, c.evidence, c.created,
           o.f AS old_text, n.f AS new_text
    FROM fact_conflicts c
    LEFT JOIN facts o ON o.id = c.old_id
    LEFT JOIN facts n ON n.id = c.new_id
    ORDER BY c.created DESC, c.id DESC LIMIT ?`).all(limit).map((r) => ({
    id: Number(r.id),
    oldId: Number(r.old_id),
    newId: Number(r.new_id),
    reason: String(r.reason ?? ''),
    evidence: String(r.evidence ?? ''),
    created: Number(r.created ?? 0),
    oldText: String(r.old_text ?? ''),
    newText: String(r.new_text ?? ''),
  }))
}
