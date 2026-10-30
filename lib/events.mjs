/**
 * 跨窗口事件线。
 */

export function recentEvents(db, opts = {}) {
  const where = []
  const args = []

  const hours = Number(opts.hours)
  if (Number.isFinite(hours) && hours > 0) {
    where.push('at >= ?')
    args.push(Date.now() - hours * 3_600_000)
  }

  const kind = String(opts.kind ?? '').trim()
  if (kind !== '' && kind !== 'any') {
    where.push('kind = ?')
    args.push(kind)
  }

  const session = String(opts.session ?? '').trim()
  if (session !== '') {
    where.push('session = ?')
    args.push(session)
  }

  const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 30))

  return db.prepare(
    `SELECT at, session, window, kind, text FROM events ${clause} ORDER BY at DESC LIMIT ?`,
  ).all(...args, limit)
}

/**
 * 按条件翻记忆条目。只读。
 *
 * @param {DatabaseSync} db 记忆库
 * @param {object} opts
 * @param {string} [opts.keyword] 正文关键词（用户或助手任一侧命中）
 * @param {'any'|'hot'|'cold'} [opts.zone] 热区 / 冷区 / 不限
 * @param {number} [opts.limit] 最多几条，1–100，默认 20
 * @returns {Array<{id:number,u:string,a:string,t:number,w:number,emo:string[],hot:number}>}
 */
