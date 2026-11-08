/**
 * 场景层：把散落的旧事按共同线索收成「一段经历」。
 *
 * 单条记忆是点，场景是线；点多了以后，问一句「上次那个 bug 后来怎样了」，
 * 给模型看的应该是一段，而不是四条各说一半的对话。
 *
 * 这一层不调模型，纯规则聚类：便宜、可重建、结果可解释。
 * 场景按记忆空间分开算，A 空间的旧事不会拼进 B 空间的上下文。
 */
import { cueWords } from '../language.mjs'
import { clamp } from '../format.mjs'

/** 场景正文里每条记忆截多长。 */
const LINE_CAP = 90

/**
 * 「手动删过」记在 meta 里。
 *
 * 不往 scenes 加列：老库不用迁移，键坏了也只是少拦一个主题，
 * 不会让页面或注入报错。
 */
const mutedKey = (space, topic) => `sceneMuted:${space}:${topic}`

/** 场景里存的条目 id 列表；坏掉的当空数组。 */
function parseIds(raw) {
  try {
    const ids = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(ids) ? ids.map(Number).filter((id) => Number.isInteger(id) && id > 0) : []
  } catch { return [] }
}

/**
 * 每一段场景「最近一次被召回」是什么时候。
 *
 * 时间来自 entries.lastHit：`warmEntries` 在那条记忆真被交回给模型时写一笔。
 * 一段场景取它名下记忆里最新的那笔；一条都没被召回过就是 0（页面说「还没被召回」）。
 *
 * @param {object} db 数据库
 * @param {Array<{topic:string,space?:string,entry_ids?:string}>} rows 场景行
 * @returns {Map<string, number>} 键是 `${space}\t${topic}`
 */
export function sceneRecallAt(db, rows) {
  const out = new Map()
  const all = new Set()
  for (const r of rows) for (const id of parseIds(r.entry_ids)) all.add(id)
  const at = new Map()
  if (all.size > 0) {
    try {
      const marks = rows.length === 0 ? [] : db.prepare(
        `SELECT id, lastHit FROM entries WHERE id IN (${[...all].map(() => '?').join(',')})`,
      ).all(...all)
      for (const m of marks) at.set(Number(m.id), Number(m.lastHit) || 0)
    } catch { return out } // 老库还没补 lastHit 列：当没召回
  }
  for (const r of rows) {
    let best = 0
    for (const id of parseIds(r.entry_ids)) best = Math.max(best, at.get(id) ?? 0)
    out.set(`${String(r.space ?? 'default')}\t${r.topic}`, best)
  }
  return out
}

/** 某空间里被手动删掉的场景主题（删了就别在下次重建时又长回来）。 */
function mutedTopics(db, space) {
  const out = new Set()
  try {
    for (const r of db.prepare("SELECT k FROM meta WHERE k LIKE 'sceneMuted:%'").all()) {
      const parts = String(r.k ?? '').split(':')
      if (parts.length < 3) continue
      if (parts[1] !== space) continue
      out.add(parts.slice(2).join(':'))
    }
  } catch { /* 没有 meta 表就当没删过 */ }
  return out
}

/**
 * 手动删掉一条场景，并留一个墓碑：同样的主题不再被重建出来。
 *
 * 场景是派生数据，删掉的只是「这一段」；原文还在 entries 里，
 * 想让它回来就清掉 meta 里对应的 `sceneMuted:*` 键。
 *
 * @param {object} db 数据库
 * @param {{topic:string,space?:string}} opts 参数
 * @returns {{ok:boolean,deleted:number,reason?:string}} 结果
 */
export function deleteScene(db, opts) {
  const topic = String(opts.topic ?? '').trim()
  if (topic === '') return { ok: false, deleted: 0, reason: 'empty-topic' }
  const space = String(opts.space ?? 'default')
  let deleted = 0
  try {
    deleted = Number(db.prepare('DELETE FROM scenes WHERE topic = ?').run(topic).changes ?? 0)
  } catch { return { ok: false, deleted: 0, reason: 'db' } }
  try {
    db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(mutedKey(space, topic), String(Date.now()))
  } catch { /* 墓碑记不上，下次重建可能又长回来——不阻塞删除 */ }
  return { ok: true, deleted }
}

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
  const muted = mutedTopics(db, space)

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
    // 手动删过的主题不再重建：删了就删了，等它自己攒出新的线索再说。
    .filter(([c]) => !muted.has(c))
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
