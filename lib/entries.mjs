import { isCorrupt, rebuildFts } from './fts.mjs'

/**
 * 记忆条目的读写、修正、撤回，以及跨 Agent 的写边界。
 */

/**
 * 用 FTS 找命中关键字的 id。
 *
 * trigram 分词要求至少 3 个字，短查询直接返回 null 让调用方退回 LIKE。
 *
 * @param {object} db 数据库
 * @param {string} keyword 关键字
 * @returns {number[]|null} 命中的 id；不可用时 null
 */
export function keywordIds(db, keyword) {
  const text = String(keyword ?? '').trim()
  if (text.length < 3) return null
  const query = () => {
    const quoted = `"${text.replace(/"/gu, '""')}"`
    return db.prepare('SELECT rowid AS id FROM entries_fts WHERE entries_fts MATCH ? LIMIT 500')
      .all(quoted).map((r) => Number(r.id))
  }
  // 中文 trigram 只认连续片段：「重启插件」搜不到「重启了…插件」。
  // 命中为空时按两字一组拆开做交集，比整串 LIKE 宽容得多。
  const chunked = () => {
    const chunks = []
    for (let i = 0; i + 2 <= text.length; i += 2) chunks.push(text.slice(i, i + 2))
    if (chunks.length === 0) return null
    const clause = chunks.map(() => '(u LIKE ? OR a LIKE ?)').join(' AND ')
    const args = []
    for (const c of chunks) args.push(`%${c}%`, `%${c}%`)
    try {
      return db.prepare(`SELECT id FROM entries WHERE ${clause} LIMIT 500`).all(...args).map((r) => Number(r.id))
    } catch {
      return null
    }
  }

  try {
    const hits = query()
    return hits.length > 0 ? hits : chunked()
  } catch (error) {
    // 索引和正文对不上时先重建一次再试；还不行就让调用方退回 LIKE。
    if (isCorrupt(error) && rebuildFts(db)) {
      try { return query() } catch { return null }
    }
    return null
  }
}

export function searchEntries(db, opts = {}) {
  const where = []
  const args = []

  const zone = opts.zone ?? 'any'
  if (zone === 'hot') where.push('hot = 1')
  else if (zone === 'cold') where.push('hot = 0')

  const keyword = String(opts.keyword ?? '').trim()
  if (keyword !== '') {
    const ids = keywordIds(db, keyword)
    if (ids === null) {
      where.push('(u LIKE ? OR a LIKE ?)')
      args.push(`%${keyword}%`, `%${keyword}%`)
    } else if (ids.length === 0) {
      where.push('0')
    } else {
      where.push(`id IN (${ids.map(() => '?').join(',')})`)
      args.push(...ids)
    }
  }

  const owner = String(opts.owner ?? '').trim()
  if (owner !== '') {
    where.push('owner = ?')
    args.push(owner)
  }

  // 空间过滤：空串表示跨空间查（显式要全部时才这么传）。
  const space = opts.space === undefined ? undefined : String(opts.space)
  if (space !== undefined && space !== '') {
    where.push('space = ?')
    args.push(space)
  }

  const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 20))

  return db.prepare(
    `SELECT id, u, a, t, w, emo, hot, owner FROM entries ${clause} ORDER BY w DESC, t DESC LIMIT ?`,
  ).all(...args, limit).map((r) => ({
    id: r.id,
    u: String(r.u ?? ''),
    a: String(r.a ?? ''),
    t: r.t,
    w: r.w,
    emo: JSON.parse(r.emo || '[]'),
    hot: r.hot,
    owner: String(r.owner ?? ''),
  }))
}

/**
 * 跨 Agent 的写边界：自己能改自己的，别人的要显式允许。
 *
 * `owner` 为空表示「本人的记忆」（也就是这一份库的主人）。
 *
 * @param {{owner?:string}} row 目标条目
 * @param {{actor?:string, allowForeign?:boolean}} input 调用方
 * @returns {{ok:boolean, reason?:string}}
 */
function checkForeign(row, input = {}) {
  const owner = String(row?.owner ?? '')
  if (owner === '') return { ok: true }
  const actor = String(input.actor ?? '')
  if (actor === owner) return { ok: true }
  if (input.allowForeign === true) return { ok: true }
  return { ok: false, reason: 'not-yours' }
}

/**
 * 写一条记忆。给「别的 Agent」用的入口：必须自报 owner，否则不许写。
 *
 * @param {DatabaseSync} db 记忆库
 * @param {object} input
 * @param {string} input.owner 写入方标识；空串表示本人
 * @param {string} input.user 用户侧内容
 * @param {string} [input.assistant] 助手侧内容
 * @param {Float32Array|null} [input.vec] 向量
 * @param {number} [input.now] 时间戳
 * @param {boolean} [input.hot] 是否进热区
 * @returns {{ok:boolean, id?:number, reason?:string}}
 */
export function putEntry(db, input) {
  const owner = String(input?.owner ?? '').trim()
  const user = String(input?.user ?? '').trim()
  if (user === '') return { ok: false, reason: 'empty' }
  // 这是给「别人」用的入口：必须自报家门，不能匿名往这份记忆里塞东西。
  if (owner === '') return { ok: false, reason: 'owner-required' }

  db.prepare('INSERT INTO entries(u, a, t, w, emo, vec, hot, owner) VALUES(?,?,?,?,?,?,?,?)')
    .run(user, String(input?.assistant ?? ''), Number(input?.now) || Date.now(),
      Number(input?.w) || 1, '[]', input?.vec ?? null, input?.hot === false ? 0 : 1, owner)
  const id = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id)
  return { ok: true, id }
}

/**
 * 修正一条记忆。
 *
 * 不是原地改写：旧的整条搬进 `revisions` 留档，主表换成修正后的新条目。
 * 这样「记错了就改」和「改过什么」两件事同时成立。
 *
 * @param {DatabaseSync} db 记忆库
 * @param {object} input
 * @param {number} input.id 要改的条目 id
 * @param {string} input.text 修正后用户那一侧的内容
 * @param {string} [input.assistant] 修正后助手那一侧；不给就沿用
 * @param {Float32Array|null} [input.vec] 修正后内容的向量；不给就留空（召回退回字面）
 * @param {string} [input.reason] 为什么要改
 * @param {number} [input.now] 时间戳，默认当前
 * @returns {{ok:boolean, reason?:string, id?:number, previousId?:number}}
 */
export function correctEntry(db, input) {
  const id = Number(input?.id)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: 'bad-id' }

  const row = db.prepare('SELECT id, u, a, t, w, emo, vec, hot, owner FROM entries WHERE id = ?').get(id)
  if (!row) return { ok: false, reason: 'not-found' }

  const guard = checkForeign(row, input)
  if (!guard.ok) return guard

  // 改记忆也要限长：接口能收 64KB，但不该让一条记忆长到把上下文挤爆。
  const afterU = String(input.text ?? '').trim().slice(0, 2000)
  if (afterU === '') return { ok: false, reason: 'empty' }
  const afterA = typeof input.assistant === 'string' ? input.assistant : String(row.a ?? '')
  const now = Number(input.now) || Date.now()

  db.prepare('INSERT INTO entries(u, a, t, w, emo, vec, hot) VALUES(?,?,?,?,?,?,?)')
    .run(afterU, afterA, now, Math.max(1, Number(row.w) || 1), row.emo ?? '[]', input.vec ?? null, row.hot)
  const newId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id)

  db.prepare('DELETE FROM entries WHERE id = ?').run(id)
  db.prepare(`
    INSERT INTO revisions(entry_id, action, before_u, before_a, after_u, after_a, reason, at, actor)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(id, 'correct', row.u, row.a, afterU, afterA, String(input.reason ?? ''), now, String(input.actor ?? ''))

  return { ok: true, id: newId, previousId: id }
}

/**
 * 撤回一条记忆：它记的是不该留的东西。
 *
 * 同样不硬删——原样进 `revisions`，主表移走。
 *
 * @param {DatabaseSync} db 记忆库
 * @param {{id:number, reason?:string, now?:number}} input
 * @returns {{ok:boolean, reason?:string, previousId?:number}}
 */
export function retractEntry(db, input) {
  const id = Number(input?.id)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: 'bad-id' }

  const row = db.prepare('SELECT id, u, a, owner FROM entries WHERE id = ?').get(id)
  if (!row) return { ok: false, reason: 'not-found' }

  const guard = checkForeign(row, input)
  if (!guard.ok) return guard

  const now = Number(input.now) || Date.now()
  db.prepare('DELETE FROM entries WHERE id = ?').run(id)
  db.prepare(`
    INSERT INTO revisions(entry_id, action, before_u, before_a, after_u, after_a, reason, at, actor)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(id, 'retract', row.u, row.a, null, null, String(input.reason ?? ''), now, String(input.actor ?? ''))

  return { ok: true, previousId: id }
}

/**
 * 把一段被压缩的会话事件配对成 (用户, 助手) 列表。
 *
 * 只保留真实用户发言（source.kind === 'user'），跳过系统注入的通知；
 * 每条用户消息后跟的第一条助手回复与之配对。
 *
 * @param {(seq:number)=>object|undefined} getEvent 按序号取事件
 * @param {number[]} seqs 被压缩的表面节点序号
 * @returns {Array<{u:string,a:string}>}
 */
