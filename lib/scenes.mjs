/**
 * 场景层：把散落的旧事按共同线索收成「一段经历」。
 *
 * 单条记忆是点，场景是线；点多了以后，问一句「上次那个 bug 后来怎样了」，
 * 给模型看的应该是一段，而不是四条各说一半的对话。
 *
 * 这一层不调模型，纯规则聚类：便宜、可重建、结果可解释。
 * 场景按记忆空间分开算，A 空间的旧事不会拼进 B 空间的上下文。
 */
import { cueWords } from './language.mjs'
import { clamp } from './format.mjs'

/** 场景正文里每条记忆截多长。 */
const LINE_CAP = 90

/**
 * 列出库里出现过的记忆空间。
 *
 * @param {object} db 数据库
 * @returns {string[]} 空间名
 */
function listSpaces(db) {
  try {
    const rows = db.prepare('SELECT DISTINCT space FROM entries').all()
    const names = rows.map((r) => String(r.space ?? 'default')).filter(Boolean)
    return names.length > 0 ? names : ['default']
  } catch {
    return ['default']
  }
}

/**
 * 重建场景表：按线索词把近期的冷记忆归堆，够大的堆写成一条场景。
 *
 * @param {object} db 数据库
 * @param {{maxScenes?:number,minCluster?:number,scan?:number,space?:string,incremental?:boolean}} opts 参数
 * @returns {{scenes:number,clustered:number,skipped?:string}} 结果
 */
export function rebuildScenes(db, opts = {}) {
  const spaces = opts.space ? [String(opts.space)] : listSpaces(db)
  let scenes = 0
  let clustered = 0
  let skipped = null
  for (const space of spaces) {
    const r = rebuildForSpace(db, { ...opts, space })
    scenes += r.scenes
    clustered += r.clustered
    if (r.skipped) skipped = r.skipped
  }
  return skipped && scenes === 0 ? { scenes, clustered, skipped } : { scenes, clustered }
}

/**
 * 单个空间的重建。
 *
 * @param {object} db 数据库
 * @param {{maxScenes?:number,minCluster?:number,scan?:number,space:string,incremental?:boolean}} opts 参数
 * @returns {{scenes:number,clustered:number,skipped?:string}} 结果
 */
function rebuildForSpace(db, opts) {
  const maxScenes = opts.maxScenes ?? 12
  const minCluster = opts.minCluster ?? 2
  const scan = opts.scan ?? 800
  const space = opts.space
  const markKey = `scenesMaxId:${space}`

  const readMark = () => {
    try { return Number(db.prepare('SELECT v FROM meta WHERE k=?').get(markKey)?.v ?? 0) } catch { return 0 }
  }
  const writeMark = (id) => {
    try { db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(markKey, String(id)) } catch { /* 记不上就下次全量 */ }
  }

  const maxId = (() => {
    try { return Number(db.prepare('SELECT MAX(id) AS m FROM entries WHERE space=?').get(space)?.m ?? 0) } catch { return 0 }
  })()
  const mark = readMark()
  if (opts.incremental !== false && maxId === mark) return { scenes: 0, clustered: 0, skipped: 'no-new' }

  const fresh = opts.incremental !== false && mark > 0
    ? (() => {
      try {
        return db.prepare('SELECT id,u,a,t,w FROM entries WHERE id > ? AND hot=0 AND space=? ORDER BY t ASC LIMIT 200')
          .all(mark, space)
      } catch { return [] }
    })()
    : []

  // 新记忆不多、场景已经有的时候：按线索并进现有场景，不做全量重排。
  if (opts.incremental !== false && mark > 0 && fresh.length > 0 && fresh.length < 50) {
    const existing = (() => {
      try { return db.prepare('SELECT topic, body, entry_ids, n FROM scenes WHERE space=?').all(space) } catch { return [] }
    })()
    if (existing.length > 0) {
      const byTopic = new Map(existing.map((r) => [r.topic, r]))
      let touched = 0
      for (const row of fresh) {
        const cues = cueWords(`${row.u}\n${row.a}`)
        if (cues.length === 0) continue
        const hit = cues.find((c) => byTopic.has(c))
        if (!hit) continue
        const scene = byTopic.get(hit)
        const lines = String(scene.body ?? '').split('\n').filter(Boolean)
        const line = `- ${clamp(String(row.u ?? ''), LINE_CAP)}`
        if (lines.includes(line)) continue
        lines.push(line)
        const body = lines.slice(-8).join('\n')
        const ids = JSON.parse(scene.entry_ids || '[]')
        ids.push(row.id)
        db.prepare('UPDATE scenes SET body = ?, entry_ids = ?, n = ?, updated = ? WHERE topic = ? AND space = ?')
          .run(body, JSON.stringify(ids.slice(-40)), ids.length, Date.now(), hit, space)
        scene.body = body
        scene.entry_ids = JSON.stringify(ids)
        scene.n = ids.length
        touched += 1
      }
      writeMark(maxId)
      if (touched > 0) return { scenes: touched, clustered: fresh.length }
      return { scenes: 0, clustered: 0 }
    }
  }

  const rows = db
    .prepare('SELECT id,u,a,t,w,emo FROM entries WHERE hot=0 AND space=? ORDER BY t DESC LIMIT ?')
    .all(space, scan)

  // 每条记忆抽线索词；抽不出的不参与聚类。
  const items = rows.map((r) => ({
    r,
    cues: new Set(cueWords(`${r.u}\n${r.a}`)),
  })).filter((x) => x.cues.size > 0)

  // 线索词 → 出现次数，用来挑「够粗」的主线，避免被一次性的人名带走。
  const freq = new Map()
  for (const x of items) for (const c of x.cues) freq.set(c, (freq.get(c) ?? 0) + 1)
  const topics = [...freq.entries()]
    .filter(([, n]) => n >= minCluster)
    // 长串 openid / 十六进制 id 不是话题，别让它们占掉场景名额。
    .filter(([c]) => !/^[0-9a-f]{12,}$/iu.test(c) && !/^\d{8,}$/u.test(c) && !(c.length > 12 && /^[a-z0-9]+$/u.test(c)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxScenes * 2)
    .map(([c]) => c)

  const clusters = new Map(topics.map((t) => [t, []]))
  for (const x of items) {
    let best = ''
    let bestScore = 0
    for (const t of topics) {
      if (!x.cues.has(t)) continue
      const s = (freq.get(t) ?? 0) + (x.r.w ?? 1)
      if (s > bestScore) { best = t; bestScore = s }
    }
    if (best !== '') clusters.get(best).push(x.r)
  }

  const now = Date.now()
  db.prepare('DELETE FROM scenes WHERE space = ?').run(space)
  const ins = db.prepare(
    'INSERT OR REPLACE INTO scenes (topic, body, entry_ids, n, updated, space) VALUES (?,?,?,?,?,?)',
  )

  let made = 0
  let clustered = 0
  for (const [topic, list] of clusters) {
    if (list.length < minCluster) continue
    if (made >= maxScenes) break
    const picked = list.sort((a, b) => (b.w ?? 1) - (a.w ?? 1) || b.t - a.t).slice(0, 6)
    const body = picked
      .sort((a, b) => a.t - b.t)
      .map((r) => `- ${clamp(String(r.u ?? ''), LINE_CAP)}`)
      .join('\n')
    ins.run(topic, body, JSON.stringify(picked.map((r) => r.id)), picked.length, now, space)
    made += 1
    clustered += picked.length
  }
  writeMark(maxId)
  return { scenes: made, clustered }
}

/**
 * 按本轮的话找一条最贴的场景。
 *
 * @param {object} db 数据库
 * @param {{text:string,space?:string,limit?:number,minScore?:number}} opts 参数
 * @returns {Array<{topic:string,body:string,n:number}>} 命中的场景
 */
export function matchScenes(db, opts) {
  const text = String(opts.text ?? '')
  if (text === '') return []
  const cues = new Set(cueWords(text))
  if (cues.size === 0) return []

  const space = String(opts.space ?? 'default')
  let rows = []
  try {
    rows = db.prepare('SELECT topic, body, n, updated FROM scenes WHERE space=?').all(space)
  } catch {
    try { rows = db.prepare('SELECT topic, body, n, updated FROM scenes').all() } catch { return [] }
  }

  return rows
    .map((r) => ({
      ...r,
      score: cueWords(`${r.topic} ${r.body}`).filter((c) => cues.has(c)).length,
    }))
    .filter((r) => r.score >= (opts.minScore ?? 1))
    .sort((a, b) => b.score - a.score || b.updated - a.updated)
    .slice(0, opts.limit ?? 1)
}
