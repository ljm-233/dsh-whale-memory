/**
 * 「人」这一维：谁说过话、说过几句、最近一次是什么时候。
 *
 * 两件事必须同时成立，否则这一页就是在撒谎：
 *   1. `person` 表里有名字，但条目未必归得过来（回填只认唯一命中，认不出就是空串）。
 *   2. `entries.spk` 有空串，所以「多少记忆知道是谁说的」要**照实报**，
 *      不许把「不知道谁说的」算成任何一个人。
 *
 * 所以这里出两种行：认人表里有的人（`named`），以及只在记忆里出现过、
 * 认人表还没对上的号（`named=false`，名字显示成 8 位 spk）。
 * 两种都出现，不互相顶替——「只有号」本来就是现状的一部分。
 */
import { toSpk } from './speaker.mjs'

/** 一个人列表最多给这么多行：人不多，但别让一次请求拖出几万行。 */
export const PEOPLE_MAX = 200
/** 一个人名下最多翻这么多条记忆（页面默认只要 10 条）。 */
export const PEOPLE_ENTRIES_MAX = 100

/** 越界截断：NaN / 0 / 负数 / 超大一律夹到 [1, max]。 */
const clampLimit = (raw, fallback, max) => {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, n)
}

/** `aka` 存的是 JSON 数组；坏值当空数组——一个坏字段不许把整页带走。 */
const parseAka = (raw) => {
  try {
    const v = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter((x) => x !== '') : []
  } catch { return [] }
}

/**
 * 多号归并：`person_alias(space, spk, canonical_spk)` 把大小号指到同一个 canonical。
 *
 * 表不存在（老库没迁移）就当没有映射——一个字不改既有行为。
 * 自指、脏值一律忽略：归并表坏一行不许把一页人搅乱。
 *
 * @returns {Map<string,string>} spk → canonical_spk
 */
const aliasMapOf = (db, space = '') => {
  const map = new Map()
  try {
    const rows = db.prepare(`SELECT spk, canonical_spk FROM person_alias${space === '' ? '' : ' WHERE space = ?'}`)
      .all(...(space === '' ? [] : [space]))
    for (const r of rows) {
      const s = toSpk(r.spk)
      const c = toSpk(r.canonical_spk)
      if (s !== '' && c !== '' && s !== c) map.set(s, c)
    }
  } catch { /* 没有这张表：不归并 */ }
  return map
}

/** 归一到 canonical；没有映射就是它自己。 */
const canonOf = (map, spk) => map.get(spk) ?? spk

/**
 * spk 覆盖率：全库（或某个空间）里有多少条记忆知道是谁说的。
 *
 * 口径写死在这里一处：`spk <> ''` 才算知道（`DEFAULT ''` 是「没认出来」，不是 NULL）。
 * `spk` 列不存在（老库没迁移）时按 0 报，不假装有。
 *
 * @returns {{total:number, known:number, coverage:number}}
 */
export function coverageOf(db, opts = {}) {
  const space = String(opts.space ?? '')
  const where = space === '' ? '' : ' WHERE space = ?'
  const args = space === '' ? [] : [space]
  let total = 0
  let known = 0
  try {
    const row = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN spk <> '' THEN 1 ELSE 0 END) known FROM entries${where}`).get(...args)
    total = Number(row?.total ?? 0) || 0
    known = Number(row?.known ?? 0) || 0
  } catch {
    try { total = Number(db.prepare(`SELECT COUNT(*) c FROM entries${where}`).get(...args)?.c ?? 0) || 0 } catch { total = 0 }
    known = 0
  }
  return { total, known, coverage: total === 0 ? 0 : known / total }
}

/**
 * 人列表：认人表里的人 + 记忆里出现过但认人表没有的号。
 *
 * 排序按「条目数多 → 最近说话晚」：先看说话多的人，再看刚说过话的人。
 *
 * @param {object} db 记忆库
 * @param {{limit?:number, space?:string}} [opts]
 * @returns {{people:Array<object>, stats:object, space:string}}
 */
export function listPeople(db, opts = {}) {
  const space = String(opts.space ?? '')
  const limit = clampLimit(opts.limit, 50, PEOPLE_MAX)
  const cov = coverageOf(db, { space })

  // 1) 记忆侧：每个 spk 几条、最近一次什么时候。空串（不知道谁说的）不进这张表。
  //    按 canonical 归并：同一个人两个号，条目数要合起来算，不许拆成两个人。
  const alias = aliasMapOf(db, space)
  const seen = new Map()
  try {
    const rows = db.prepare(`
      SELECT spk, COUNT(*) n, MAX(t) last FROM entries
      WHERE spk <> ''${space === '' ? '' : ' AND space = ?'}
      GROUP BY spk
    `).all(...(space === '' ? [] : [space]))
    for (const r of rows) {
      const raw = toSpk(r.spk)
      if (raw === '') continue
      const spk = canonOf(alias, raw)
      const prev = seen.get(spk)
      seen.set(spk, {
        count: (prev?.count ?? 0) + (Number(r.n) || 0),
        lastAt: Math.max(prev?.lastAt ?? 0, Number(r.last ?? 0) || 0),
      })
    }
  } catch { /* 没有 spk 列：认人表照样列，条目数一律 0 */ }

  // 2) 认人表侧：名字与又名。表不存在时按空处理（老库没迁移）。
  //    大小号两行归一成一行：名字取第一个非空的，又名并集，条目数只算一遍。
  const merged = new Map()
  try {
    const rows = db.prepare(`
      SELECT spk, name, aka FROM person${space === '' ? '' : ' WHERE space = ?'}
    `).all(...(space === '' ? [] : [space]))
    for (const r of rows) {
      const own = toSpk(r.spk)
      if (own === '') continue
      const spk = canonOf(alias, own)
      const name = String(r.name ?? '').trim()
      const aka = parseAka(r.aka)
      const cur = merged.get(spk)
      if (cur === undefined) { merged.set(spk, { name, aka }); continue }
      if (cur.name === '') cur.name = name
      for (const a of aka) if (!cur.aka.includes(a)) cur.aka.push(a)
    }
  } catch { /* 同上 */ }

  const people = []
  const claimed = new Set()
  for (const [spk, row] of merged) {
    claimed.add(spk)
    const hit = seen.get(spk)
    people.push({
      spk,
      name: row.name,
      aka: row.aka,
      named: row.name !== '',
      count: hit?.count ?? 0,
      lastAt: hit?.lastAt ?? 0,
    })
  }

  // 3) 只有号：记忆里有、认人表里没有。不许悄悄丢掉——那正是覆盖率不足的样子。
  for (const [spk, hit] of seen) {
    if (claimed.has(spk)) continue
    people.push({ spk, name: '', aka: [], named: false, count: hit.count, lastAt: hit.lastAt })
  }

  people.sort((a, b) => (b.count - a.count) || (b.lastAt - a.lastAt) || a.spk.localeCompare(b.spk))

  return {
    space,
    people: people.slice(0, limit),
    stats: {
      people: people.length,
      named: people.filter((p) => p.named).length,
      onlyId: people.filter((p) => !p.named).length,
      // 覆盖率照实报：分母是全库条目，分子是知道谁说的那些。
      total: cov.total,
      known: cov.known,
      coverage: cov.coverage,
      // 认人表里有、但还没有一句归到他名下的人：页面据此提示「还没说过话」。
      silent: people.filter((p) => p.count === 0).length,
    },
  }
}

/**
 * 一个人名下最近 N 条记忆。
 *
 * 行形状和 `/dsh-whale-memory/entries` 一模一样（页面直接复用那套行渲染，
 * 不复制第二份字段映射）——两处字段一漂，展开的内容就会和热区/冷区对不上。
 *
 * @param {object} db 记忆库
 * @param {{spk?:string, limit?:number}} [opts]
 * @returns {{spk:string, total:number, items:Array<object>}}
 */
export function personEntries(db, opts = {}) {
  const spk = toSpk(opts.spk)
  const limit = clampLimit(opts.limit, 10, PEOPLE_ENTRIES_MAX)
  if (spk === '') return { spk: '', total: 0, items: [] }
  // 展开一个人就是展开他所有的号：否则列表上写着 5 条、点开只有 3 条。
  const alias = aliasMapOf(db)
  const canon = canonOf(alias, spk)
  const group = [canon, ...[...alias.keys()].filter((s) => alias.get(s) === canon)]
  const marks = group.map(() => '?').join(',')
  let total = 0
  let rows = []
  try {
    total = Number(db.prepare(`SELECT COUNT(*) c FROM entries WHERE spk IN (${marks})`).get(...group)?.c ?? 0) || 0
    rows = db.prepare(`
      SELECT id,u,a,t,w,emo,space,spk,imp,hits,tier,lastHit,hot FROM entries
      WHERE spk IN (${marks}) ORDER BY t DESC LIMIT ?
    `).all(...group, limit)
  } catch {
    try {
      rows = db.prepare(`SELECT id,u,a,t,w,emo FROM entries WHERE spk IN (${marks}) ORDER BY t DESC LIMIT ?`).all(...group, limit)
    } catch { rows = [] }
  }
  return {
    spk: canon,
    total,
    items: rows.map((r) => ({
      id: r.id,
      at: r.t,
      weight: r.w,
      emo: (() => { try { return JSON.parse(r.emo || '[]') } catch { return [] } })(),
      user: String(r.u ?? '').slice(0, 300),
      assistant: String(r.a ?? '').slice(0, 300),
      space: String(r.space ?? 'default'),
      spk: String(r.spk ?? ''),
      imp: r.imp === null || r.imp === undefined ? null : Number(r.imp),
      hits: Number(r.hits ?? 0),
      tier: Number(r.tier ?? 0),
      lastHit: Number(r.lastHit ?? 0),
      hot: Number(r.hot ?? 0) === 1,
    })),
  }
}
