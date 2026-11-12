/**
 * 实体关系：谁和谁总一起出现。
 *
 * 单条记忆里看不出关系，把它们叠起来才看得出来：某个项目总跟着某个人，
 * 某个人一出现就带着那件烦心事。这里只做共现统计，不做推断。
 *
 * 纯规则、可重建，不调模型。
 */
import { cueWords } from './language.mjs'
import { clamp } from './format.mjs'

/** 一个实体的最高保留数。 */
const MAX_ENTITIES = 300
/** 一条边至少要被看到几次才留下。 */
export const MIN_EDGE = 2
/** 边表上限：再多也没人看，白占库。 */
const MAX_EDGES = 2000
/** 一次图查询最多给多少个实体：再多也是滚动阅读，翻不到。 */
export const MAX_NODES = 200
/** 缺省给多少个实体。 */
export const DEFAULT_NODES = 50
/** 找「最近出现在哪条记忆」时往前翻多少条：再往前翻也长不出新实体。 */
const LAST_SCAN = 800
/** 一条摘要留多长（和 /entries 一致）。 */
const SUMMARY_CHARS = 300

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
 * 分批版的 rebuildGraph。
 *
 * 2026-11-09：ljm 说「卡片慢了」。量出来 `rebuildGraph` 一次要 5250ms，
 * 而它是同步的——JS 单线程，这五秒里整个插件都在等它，卡片当然排队。
 * 这里把它切成小片：每片处理一条记忆，片与片之间让出主线程。
 * 主线程占用从「一次性 5.2 秒」变成「很多次几毫秒」。
 *
 * 算法、参数、落库结果和同步版完全一致，只是多切了几下。
 */
export async function rebuildGraphAsync(db, opts = {}) {
  const scan = opts.scan ?? 800
  const minCount = opts.minCount ?? 3
  const space = String(opts.space ?? 'default')
  const slice = opts.slice ?? 40

  const rows = db.prepare('SELECT u, a FROM entries WHERE space=? ORDER BY t DESC LIMIT ?').all(space, scan)

  const freq = new Map()
  const perEntry = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const words = [...new Set(cueWords(`${r.u ?? ''} ${r.a ?? ''}`))].filter((w) => w.length >= 2)
    if (words.length > 0) {
      perEntry.push(words)
      for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1)
    }
    if (i % slice === slice - 1) await new Promise((r2) => setImmediate(r2))
  }

  const kept = [...freq.entries()]
    .filter(([, n]) => n >= minCount)
    .filter(([w]) => !/^[0-9a-f]{12,}$/iu.test(w) && !/^\d{8,}$/u.test(w) && !(w.length > 12 && /^[a-z0-9]+$/u.test(w)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ENTITIES)
    .map(([w]) => w)
  const keepSet = new Set(kept)

  const edges = new Map()
  for (let i = 0; i < perEntry.length; i++) {
    const hit = perEntry[i].filter((w) => keepSet.has(w))
    for (let x = 0; x < hit.length; x++) {
      for (let y = x + 1; y < hit.length; y++) {
        const [a, b] = hit[x] < hit[y] ? [hit[x], hit[y]] : [hit[y], hit[x]]
        const key = `${a}\u0000${b}`
        edges.set(key, (edges.get(key) ?? 0) + 1)
      }
    }
    if (i % slice === slice - 1) await new Promise((r2) => setImmediate(r2))
  }

  const now = Date.now()
  db.prepare('DELETE FROM entities WHERE space=?').run(space)
  db.prepare('DELETE FROM edges WHERE space=?').run(space)
  const insE = db.prepare('INSERT OR REPLACE INTO entities (name, space, n, updated) VALUES (?,?,?,?)')
  for (const w of kept) insE.run(w, space, freq.get(w), now)

  const insEdge = db.prepare('INSERT OR REPLACE INTO edges (a, b, space, w, updated) VALUES (?,?,?,?,?)')
  let edgeCount = 0
  const ranked = [...edges.entries()].filter(([, n]) => n >= MIN_EDGE).sort((a, b) => b[1] - a[1]).slice(0, MAX_EDGES)
  for (const [key, n] of ranked) {
    const [a, b] = key.split('\u0000')
    insEdge.run(a, b, space, n, now)
    edgeCount += 1
  }
  return { entities: kept.length, edges: edgeCount }
}

/**
 * 这些实体各自「最近一次出现在哪条记忆里」。
 *
 * entities 表只存了次数，没有时间；时间只能从记忆本身找回来。
 * 按 t 倒着扫，先撞上的那次就是最近的，扫够就停——不必整库过一遍。
 *
 * @param {object} db 数据库
 * @param {string} space 空间
 * @param {string[]} names 要查的实体
 * @param {number} [scan] 最多往前翻多少条记忆
 * @returns {Map<string, number>} 实体名 → 最近一次的时间戳
 */
export function recentLastHits(db, space, names, scan = LAST_SCAN) {
  const want = new Set((names ?? []).map(String))
  const out = new Map()
  if (want.size === 0) return out
  let rows = []
  try {
    rows = db.prepare('SELECT u, a, t FROM entries WHERE space=? ORDER BY t DESC LIMIT ?').all(String(space), scan)
  } catch { return out }
  for (const r of rows) {
    for (const w of new Set(cueWords(`${r.u ?? ''} ${r.a ?? ''}`))) {
      if (want.has(w) && !out.has(w)) out.set(w, Number(r.t) || 0)
    }
    if (out.size === want.size) break
  }
  return out
}

/**
 * 读一张图：实体（含度数与最近出现）+ 实体之间的边。
 *
 * 边一条都不裁：每个实体下面要列它的前 5 条，裁掉哪条都会让某个实体的
 * 「度」和它下面的列表对不上。整表上限 MAX_EDGES=2000，扫一遍很便宜。
 *
 * @param {object} db 数据库
 * @param {{space?:string,limit?:number,sort?:string}} [opts] 参数
 * @returns {{space:string,sort:string,limit:number,total:number,nodes:Array<object>,edges:Array<object>}}
 */
export function readGraph(db, opts = {}) {
  const space = String(opts.space ?? 'default')
  const limit = Math.min(MAX_NODES, Math.max(1, Number(opts.limit) || DEFAULT_NODES))
  const sort = opts.sort === 'degree' ? 'degree' : 'count'
  const out = { space, sort, limit, total: 0, nodes: [], edges: [] }
  let rows = []
  let edgeRows = []
  try {
    rows = db.prepare('SELECT name, n FROM entities WHERE space=?').all(space)
    edgeRows = db.prepare('SELECT a, b, w FROM edges WHERE space=?').all(space)
  } catch { return out } // 表还没建就是空图，不报错

  // 度按整张图算：一个实体连了几条边，不该因为这次只取前 50 个点而变小。
  const degree = new Map()
  for (const e of edgeRows) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1)
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1)
  }
  const degOf = (name) => degree.get(name) ?? 0
  rows.sort((x, y) => (sort === 'degree'
    ? degOf(y.name) - degOf(x.name) || y.n - x.n
    : y.n - x.n || degOf(y.name) - degOf(x.name)))
  const picked = rows.slice(0, limit)
  const last = recentLastHits(db, space, picked.map((r) => r.name))
  const keep = new Set(picked.map((r) => r.name))

  out.total = rows.length
  out.nodes = picked.map((r) => ({
    name: r.name,
    count: Number(r.n) || 0,
    lastHit: last.get(r.name) ?? 0,
    degree: degOf(r.name),
  }))
  out.edges = edgeRows
    .filter((e) => keep.has(e.a) && keep.has(e.b))
    .sort((x, y) => y.w - x.w)
    .map((e) => ({ a: e.a, b: e.b, w: e.w, weight: e.w }))
  return out
}

/**
 * 某个实体名下的最近几条记忆。
 *
 * 实体名本来就是从记忆正文里切出来的线索词，所以 LIKE 就是精确的：
 * 凡是贡献过这个实体的记忆，正文里一定含这串字。
 *
 * @param {object} db 数据库
 * @param {{name?:string,space?:string,limit?:number}} [opts] 参数
 * @returns {Array<{id:number,t:number,u:string,a:string}>} 最近在前
 */
export function entityEntries(db, opts = {}) {
  const name = String(opts.name ?? '').trim()
  if (name === '') return []
  const space = String(opts.space ?? 'default')
  const limit = Math.min(50, Math.max(1, Number(opts.limit) || 10))
  // 名字里的 % 和 _ 是 LIKE 的通配符，转义掉才不会变成「全都匹配」。
  const like = `%${name.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`
  try {
    return db.prepare(
      "SELECT id, u, a, t FROM entries WHERE space=? AND (u LIKE ? ESCAPE '\\' OR a LIKE ? ESCAPE '\\') ORDER BY t DESC LIMIT ?",
    ).all(space, like, like, limit).map((r) => ({
      id: r.id,
      t: Number(r.t) || 0,
      u: clamp(String(r.u ?? ''), SUMMARY_CHARS),
      a: clamp(String(r.a ?? ''), SUMMARY_CHARS),
    }))
  } catch { return [] }
}
