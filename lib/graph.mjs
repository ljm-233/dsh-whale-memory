/**
 * 实体关系：谁和谁总一起出现。
 *
 * 单条记忆里看不出关系，把它们叠起来才看得出来：某个项目总跟着某个人，
 * 某个人一出现就带着那件烦心事。这里只做共现统计，不做推断。
 *
 * 纯规则、可重建，不调模型。
 */
import { cueWords } from './language.mjs'

/** 一个实体的最高保留数。 */
const MAX_ENTITIES = 300
/** 一条边至少要被看到几次才留下。 */
const MIN_EDGE = 2
/** 边表上限：再多也没人看，白占库。 */
const MAX_EDGES = 2000

/**
 * 重建实体表与边表。
 *
 * @param {object} db 数据库
 * @param {{scan?:number,minCount?:number}} [opts] 参数
 * @returns {{entities:number,edges:number}} 数量
 */
export function rebuildGraph(db, opts = {}) {
  const scan = opts.scan ?? 800
  const minCount = opts.minCount ?? 3
  const space = String(opts.space ?? 'default')

  const rows = db.prepare('SELECT u, a FROM entries WHERE space=? ORDER BY t DESC LIMIT ?').all(space, scan)

  const freq = new Map()
  const perEntry = []
  for (const r of rows) {
    const words = [...new Set(cueWords(`${r.u ?? ''} ${r.a ?? ''}`))].filter((w) => w.length >= 2)
    if (words.length === 0) continue
    perEntry.push(words)
    for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1)
  }

  const kept = [...freq.entries()]
    .filter(([, n]) => n >= minCount)
    // 长串 openid / 十六进制 id 不是实体，别让它们占节点和边。
    .filter(([w]) => !/^[0-9a-f]{12,}$/iu.test(w) && !/^\d{8,}$/u.test(w) && !(w.length > 12 && /^[a-z0-9]+$/u.test(w)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ENTITIES)
    .map(([w]) => w)
  const keepSet = new Set(kept)

  const edges = new Map()
  for (const words of perEntry) {
    const hit = words.filter((w) => keepSet.has(w))
    for (let i = 0; i < hit.length; i++) {
      for (let j = i + 1; j < hit.length; j++) {
        const [x, y] = hit[i] < hit[j] ? [hit[i], hit[j]] : [hit[j], hit[i]]
        const key = `${x}\u0000${y}`
        edges.set(key, (edges.get(key) ?? 0) + 1)
      }
    }
  }

  const now = Date.now()
  db.prepare('DELETE FROM entities WHERE space=?').run(space)
  db.prepare('DELETE FROM edges WHERE space=?').run(space)
  const insE = db.prepare('INSERT OR REPLACE INTO entities (name, space, n, updated) VALUES (?,?,?,?)')
  for (const w of kept) insE.run(w, space, freq.get(w), now)

  const insEdge = db.prepare('INSERT OR REPLACE INTO edges (a, b, space, w, updated) VALUES (?,?,?,?,?)')
  let edgeCount = 0
  const ranked = [...edges.entries()]
    .filter(([, n]) => n >= MIN_EDGE)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_EDGES)
  for (const [key, n] of ranked) {
    if (n < MIN_EDGE) continue
    const [a, b] = key.split('\u0000')
    insEdge.run(a, b, space, n, now)
    edgeCount += 1
  }
  return { entities: kept.length, edges: edgeCount }
}

/**
 * 找和某个词最常一起出现的几个。
 *
 * @param {object} db 数据库
 * @param {string} name 实体名
 * @param {number} [limit] 取几个
 * @returns {Array<{name:string,w:number}>} 邻居
 */
export function neighbors(db, name, limit = 5, space = 'default') {
  const target = String(name ?? '').trim()
  if (target === '') return []
  try {
    return db.prepare(`
      SELECT CASE WHEN a = ? THEN b ELSE a END AS name, w
      FROM edges WHERE space = ? AND (a = ? OR b = ?)
      ORDER BY w DESC LIMIT ?
    `).all(target, String(space), target, target, limit).map((r) => ({ name: r.name, w: r.w }))
  } catch { return [] }
}

/**
 * 从一段话里认出图谱里有的实体，最多返回 limit 个（按命中次数排）。
 *
 * @param {object} db 数据库
 * @param {string} text 本轮的话
 * @param {number} [limit] 取几个
 * @returns {string[]} 实体名
 */
export function entitiesIn(db, text, limit = 3, space = 'default') {
  const cues = new Set(cueWords(String(text ?? '')))
  if (cues.size === 0) return []
  let rows = []
  try { rows = db.prepare('SELECT name FROM entities WHERE space=?').all(String(space)) } catch { return [] }
  return rows
    .map((r) => r.name)
    .filter((name) => cues.has(name))
    .slice(0, limit)
}
