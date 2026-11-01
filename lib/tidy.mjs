/**
 * 库务整理：补向量、抬热区、压热区。幂等，随时可重跑。
 *
 * 只做加法：补 vec、改 hot。不动正文、不删条目——
 * 淘汰是另一件需要人点头的事，不该混在整理里。
 */
import { HOT_TTL_MS, HOT_ZONE_MAX, HOT_PROMOTE_WEIGHT } from './constants.mjs'
import { numCfg } from './shared.mjs'
import { vecToBlob } from './vector.mjs'

/** 一次问服务要多少条；太大时单条失败会带走整批。 */
const BATCH = 32

/**
 * 老库补列：hits / tier，并把已有的冷条目填成 tier 1（只填一次）。
 *
 * 用 PRAGMA 先问再改，SQLite 没有 ADD COLUMN IF NOT EXISTS。
 * 填层用 meta 里的一枚标记挡着，不然每次启动都会把召回刚抬浅的条目按回去。
 *
 * @param {object} db 记忆库
 * @returns {boolean} 补成功了没有
 */
export function ensureHitColumns(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(entries)').all().map((c) => c.name)
    if (!cols.includes('hits')) db.exec('ALTER TABLE entries ADD COLUMN hits INTEGER NOT NULL DEFAULT 0')
    if (!cols.includes('tier')) db.exec('ALTER TABLE entries ADD COLUMN tier INTEGER NOT NULL DEFAULT 0')
    if (!db.prepare("SELECT v FROM meta WHERE k = 'tierBackfill'").get()) {
      db.exec('UPDATE entries SET tier = 1 WHERE hot = 0 AND tier = 0')
      db.prepare("INSERT INTO meta(k, v) VALUES('tierBackfill', '1')").run()
    }
    return true
  } catch { return false }
}

/**
 * 整理一次。
 *
 * @param {object} db 记忆库
 * @param {object} [opts]
 * @param {Function} [opts.embedTexts] 嵌入函数；不给就跳过补向量
 * @param {boolean} [opts.dryRun] 只算不写
 * @param {number} [opts.now] 当前时间
 * @param {number} [opts.hotMax] 热区上限（最高优先，来自命令行）
 * @param {number} [opts.minW] 抬进热区的最低权重（同上）
 * @param {object} [opts.config] 插件配置；没给 opts.hotMax/minW 时读它，再缺省回落常量
 * @returns {Promise<{missing:number,filled:number,failed:number,hotBefore:number,hotAfter:number,promoted:number,demoted:number,dryRun:boolean}>}
 */
export async function tidyMemory(db, opts = {}) {
  const {
    embedTexts, dryRun = false, now = Date.now(), config,
  } = opts
  // 命令行 > 插件配置 > 常量；越界一律夹到边界。
  const hotMax = numCfg(opts.hotMax ?? config?.hotZoneMax, HOT_ZONE_MAX, 1, 200, true)
  const minW = numCfg(opts.minW ?? config?.hotPromoteWeight, HOT_PROMOTE_WEIGHT, 0, 20)
  const out = {
    missing: 0, filled: 0, failed: 0,
    hotBefore: 0, hotAfter: 0, promoted: 0, demoted: 0, dryRun,
  }

  // ---- 1. 补向量 ----
  const missing = db.prepare('SELECT id, u, a FROM entries WHERE vec IS NULL').all()
  out.missing = missing.length
  if (missing.length > 0 && typeof embedTexts === 'function') {
    const setVec = db.prepare('UPDATE entries SET vec = ? WHERE id = ?')
    for (let i = 0; i < missing.length; i += BATCH) {
      const chunk = missing.slice(i, i + BATCH)
      const vectors = await embedTexts(chunk.map((r) => `${r.u}\n${r.a}`))
      // 服务不在（或整批超时）：剩下的都记失败就走人，别让你等 48 个超时。
      if (!Array.isArray(vectors)) { out.failed += missing.length - i; break }
      chunk.forEach((row, k) => {
        const vec = vectors[k]
        if (!vec || vec.length === 0) { out.failed += 1; return }
        if (dryRun) { out.filled += 1; return }
        try { setVec.run(vecToBlob(vec), row.id); out.filled += 1 } catch { out.failed += 1 }
      })
    }
  } else if (missing.length > 0) {
    out.failed = missing.length
  }

  // ---- 2. 热区治理 ----
  const hotBefore = db.prepare('SELECT COUNT(*) AS n FROM entries WHERE hot = 1').get()
  out.hotBefore = Number(hotBefore?.n ?? 0)

  // 该抬的：最近 7 天、权重够高（默认 3 = 至少被想起过两次）。
  const promote = db.prepare(
    'SELECT id FROM entries WHERE hot = 0 AND t >= ? AND w >= ? ORDER BY w DESC, t DESC',
  ).all(now - HOT_TTL_MS, minW).map((r) => Number(r.id))
  out.promoted = promote.length

  // 抬完之后会超额的：按权重从低往下降，权重相同则老的先降。
  const future = db.prepare(
    'SELECT id, w, t FROM entries WHERE hot = 1 OR (hot = 0 AND t >= ? AND w >= ?)',
  ).all(now - HOT_TTL_MS, minW)
  const over = future.length - hotMax
  const victims = over > 0
    ? [...future].sort((a, b) => ((a.w ?? 1) - (b.w ?? 1)) || ((a.t ?? 0) - (b.t ?? 0))).slice(0, over).map((r) => Number(r.id))
    : []
  out.demoted = victims.length
  out.hotAfter = Math.min(future.length, hotMax)

  if (dryRun) return out

  const up = db.prepare('UPDATE entries SET hot = 1 WHERE id = ?')
  for (const id of promote) {
    try { up.run(id) } catch { /* 单条写不进去不影响别的 */ }
  }
  const down = db.prepare('UPDATE entries SET hot = 0 WHERE id = ?')
  for (const id of victims) {
    try { down.run(id) } catch { /* 同上 */ }
  }
  return out
}

/** 让旧的 hot 标记跟随 tier：tier=0 即热区。两套口径合一，看板不再打架。 */
export function syncHotFromTier(db) {
  const up = db.prepare('UPDATE entries SET hot = 1 WHERE tier = 0 AND hot = 0').run().changes
  const down = db.prepare('UPDATE entries SET hot = 0 WHERE tier > 0 AND hot = 1').run().changes
  return { up, down }
}

/**
 * 重算分层：按 (权重, 时间) 排序，前 hotMax 条进 tier 0，其余 tier 1。
 * hot 由 tier 派生，二者永不各算一套。只改标记，不删任何条目。
 */
export function recomputeTiers(db, hotMax = 30) {
  const cap = Math.min(Math.max(1, Number(hotMax) || 30), 200)
  const ids = db.prepare('SELECT id FROM entries ORDER BY w DESC, t DESC LIMIT ?').all(cap).map((r) => r.id)
  db.exec('UPDATE entries SET tier = 1')
  if (ids.length) {
    const st = db.prepare('UPDATE entries SET tier = 0 WHERE id = ?')
    for (const id of ids) st.run(id)
  }
  const up = db.prepare('UPDATE entries SET hot = 1 WHERE tier = 0 AND hot = 0').run().changes
  const down = db.prepare('UPDATE entries SET hot = 0 WHERE tier > 0 AND hot = 1').run().changes
  return { tier0: ids.length, up, down }
}
