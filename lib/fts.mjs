/**
 * 全文索引的体检与重建。
 *
 * `entries_fts` 是外部内容表：`PRAGMA integrity_check` 只看结构，不比对索引和正文，
 * 所以「检查全绿」并不代表搜索是对的。真正的判据是 FTS5 自带的 `integrity-check`：
 * 它对 content 表逐条比对，不一致会直接抛 SQLITE_CORRUPT。
 *
 * 不同步多半来自进程在写回中途被 SIGKILL —— 这也解释了为什么 rebuild 一次就好。
 */

/**
 * 重建整张全文索引。
 *
 * @param {object} db 数据库
 * @returns {boolean} 是否重建成功
 */
export function rebuildFts(db) {
  try {
    db.exec("INSERT INTO entries_fts(entries_fts) VALUES('rebuild')")
    return true
  } catch {
    return false
  }
}

/**
 * 探针：拿一条真实记忆里的片段去搜，看能不能搜回来。
 *
 * 外部内容表上 `SELECT count(*) FROM entries_fts` 读的是正文表，
 * 条数永远对得上；`integrity-check` 也只查索引内部一致性。
 * 真正能证明「索引和正文同步」的，是搜索能不能命中。
 *
 * @param {object} db 数据库
 * @returns {{ok:boolean, term?:string}} 结果
 */
export function probeFts(db) {
  let row
  try {
    row = db.prepare("SELECT id, u FROM entries WHERE LENGTH(u) >= 3 ORDER BY RANDOM() LIMIT 1").get()
  } catch {
    return { ok: true } // 表还没有，当没坏
  }
  if (!row) return { ok: true }
  const text = String(row.u ?? '')
  // 取一段足够长的子串做查询词；找不到就跳过这份探针。
  const term = text.slice(0, Math.min(6, text.length)).trim()
  if (term.length < 3) return { ok: true }
  try {
    const hits = db.prepare('SELECT rowid AS id FROM entries_fts WHERE entries_fts MATCH ? LIMIT 5')
      .all(`"${term.replace(/"/gu, '""')}"`)
    return { ok: hits.some((h) => Number(h.id) === Number(row.id)), term }
  } catch {
    return { ok: false, term }
  }
}

/**
 * 体检：索引内部坏了、或者探针搜不回来，就重建。
 *
 * @param {object} db 数据库
 * @returns {{ok:boolean, repaired:boolean, error?:string}} 结果
 */
export function checkFts(db) {
  const repair = (reason) => {
    const ok = rebuildFts(db)
    // 重建后再探一次，确认真的好了。
    const after = ok ? probeFts(db) : { ok: false }
    return { ok: ok && after.ok, repaired: ok, error: reason.slice(0, 200) }
  }

  try {
    db.exec("INSERT INTO entries_fts(entries_fts) VALUES('integrity-check')")
  } catch (error) {
    return repair(String(error?.message ?? error))
  }

  const probe = probeFts(db)
  if (!probe.ok) return repair(`probe-miss:${probe.term ?? ''}`)
  return { ok: true, repaired: false }
}

/**
 * 判断一个错误是不是「索引坏了」这一类。
 *
 * @param {unknown} error 错误
 * @returns {boolean} 是否属于损坏类
 */
export function isCorrupt(error) {
  const m = String(error?.message ?? error).toLowerCase()
  return m.includes('malformed') || m.includes('corrupt') || m.includes('not a database')
}
