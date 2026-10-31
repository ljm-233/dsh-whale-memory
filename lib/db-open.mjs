/**
 * 开库：把 busy timeout 这件事收在一处。
 *
 * `timeout` 是 `DatabaseSync` 的构造选项，但老一点的 Node（22.x 早期）不认它，
 * 传进去可能直接抛。所以这里先带选项试，失败就退回「裸开 + PRAGMA busy_timeout」，
 * 两条路都拿得到同样的效果。
 */
import { DatabaseSync } from 'node:sqlite'

/**
 * @param {string} path 数据库路径
 * @param {{readOnly?:boolean,timeout?:number}} [opts] 选项
 * @returns {DatabaseSync} 连接
 */
export function openDb(path, opts = {}) {
  const timeout = Number(opts.timeout ?? 5000) || 5000
  const base = {}
  if (opts.readOnly === true) base.readOnly = true

  try {
    return new DatabaseSync(path, { ...base, timeout })
  } catch {
    const db = new DatabaseSync(path, base)
    try { db.exec(`PRAGMA busy_timeout = ${Math.trunc(timeout)}`) } catch { /* 设不上就按默认 0 */ }
    return db
  }
}
