/**
 * 计数：总数表 + 按天表。原样从 index.mjs 搬出来。
 */

/**
 * @param {object} deps 依赖
 * @param {object} deps.db 库
 * @param {Function} deps.dayOf 本地日期键
 * @returns {{bumpStat:Function, readStats:Function}}
 */
export function createStats({ db, dayOf }) {
  const bumpStat = (k, n = 1) => {
    db.prepare('INSERT INTO stats(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=v+?').run(k, n, n)
    try {
      db.prepare('INSERT INTO daily_stats(day,k,v) VALUES(?,?,?) ON CONFLICT(day,k) DO UPDATE SET v=v+?')
        .run(dayOf(new Date()), k, n, n)
    } catch { /* 按天表建不出来就只记总数 */ }
  }
  const readStats = () => {
    const rows = db.prepare('SELECT k,v FROM stats').all()
    const out = { merged: 0, recalled: 0, ruminated: 0 }
    for (const r of rows) out[r.k] = r.v
    return out
  }

  return { bumpStat, readStats }
}
