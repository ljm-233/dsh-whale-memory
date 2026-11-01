/**
 * 库务整理 + 召回计数的回归：不联网、不碰真实记忆库。
 *
 * 覆盖：补向量（服务在/不在）、dry-run 不写、热区抬升与上限降级、
 * 全程不删条目。
 *
 * 召回打分的分段（hits/tier 在命中时抬升）已随记忆卡改走 runtime-context 一起去掉，
 * 那条路径不再写库，回归搬到 tests/test-recall.mjs。
 *
 * 跑法：node tests/test-memory-tidy.mjs
 */
process.env.EMBED_URL = 'http://127.0.0.1:1'

const { DatabaseSync } = await import('node:sqlite')
const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { tidyMemory, ensureHitColumns } = await import('../lib/tidy.mjs')
const { vecToBlob, blobToVec } = await import('../lib/vector.mjs')
const { numCfg } = await import('../lib/shared.mjs')
const { HOT_ZONE_MAX, HOT_PROMOTE_WEIGHT, TIER_PENALTY } = await import('../lib/constants.mjs')

let pass = 0
let fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  OK  ' + name) }
  else { fail += 1; console.log('  NG  ' + name + (extra ? ` — ${extra}` : '')) }
}

const DAY = 86400000
const now = Date.now()

/** 造一份最小库（列和真库一致，含 hits/tier）。 */
const makeDb = () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, u TEXT NOT NULL, a TEXT NOT NULL, t INTEGER NOT NULL,
      w REAL NOT NULL DEFAULT 1, emo TEXT NOT NULL DEFAULT '[]', vec BLOB,
      hot INTEGER NOT NULL DEFAULT 1, owner TEXT NOT NULL DEFAULT '', space TEXT NOT NULL DEFAULT 'default',
      hits INTEGER NOT NULL DEFAULT 0, tier INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE facts (id INTEGER PRIMARY KEY AUTOINCREMENT, f TEXT, space TEXT DEFAULT 'default',
      valid_from INTEGER NOT NULL DEFAULT 0, valid_until INTEGER);
    CREATE TABLE diary (day TEXT PRIMARY KEY, text TEXT, created_at INTEGER);
    CREATE TABLE scenes (topic TEXT PRIMARY KEY, body TEXT, entry_ids TEXT, n INTEGER, updated INTEGER, space TEXT DEFAULT 'default');
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE recall_seen (session TEXT NOT NULL, entry_id INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (session, entry_id));
    CREATE TABLE stats (k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0);
  `)
  return db
}
const ins = (db, row) => {
  db.prepare('INSERT INTO entries (u,a,t,w,emo,vec,hot,space,tier) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(row.u, row.a ?? '嗯', row.t ?? now, row.w ?? 1, JSON.stringify(row.emo ?? []),
      row.vec ?? null, row.hot ?? 0, 'default', row.tier ?? 0)
  return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id)
}
const count = (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM entries').get().n)

// 假的嵌入函数：给每条一个固定向量，不碰网络。
const fakeEmbed = async (texts) => texts.map(() => Float32Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)))

// ---- 0. 老库补列：hits / tier，冷条目填成 1 层，只填一次 ----
{
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, u TEXT NOT NULL, a TEXT NOT NULL,
      t INTEGER NOT NULL, w REAL NOT NULL DEFAULT 1, emo TEXT NOT NULL DEFAULT '[]', vec BLOB,
      hot INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `)
  db.prepare('INSERT INTO entries (u,a,t,hot) VALUES (?,?,?,1)').run('热的', '嗯', now)
  db.prepare('INSERT INTO entries (u,a,t,hot) VALUES (?,?,?,0)').run('冷的', '嗯', now)
  check('补列成功', ensureHitColumns(db) === true)
  const cols = db.prepare('PRAGMA table_info(entries)').all().map((c) => c.name)
  check('hits/tier 都加上了', cols.includes('hits') && cols.includes('tier'), cols.join(','))
  check('默认值 0', db.prepare('SELECT SUM(hits) h, SUM(tier) t FROM entries').get().t === 1)
  const coldTier = () => db.prepare("SELECT tier FROM entries WHERE u='冷的'").get().tier
  check('冷条目填进 1 层', coldTier() === 1)
  // 召回把它抬浅之后，重跑迁移不能按回去
  db.prepare('UPDATE entries SET tier = 0 WHERE u = ?').run('冷的')
  ensureHitColumns(db)
  check('再跑迁移不覆盖已有层级（幂等）', coldTier() === 0 && ensureHitColumns(db) === true)
}

// ---- 1. 补向量：服务不在时记失败、不中断 ----
{
  const db = makeDb()
  ins(db, { u: '第一条', vec: null })
  ins(db, { u: '第二条', vec: null })
  const r = await tidyMemory(db, { now })
  check('没有嵌入函数 → 全记失败', r.failed === 2 && r.filled === 0, JSON.stringify(r))
  check('失败也不影响热区那步', typeof r.hotAfter === 'number')
  check('失败时没写坏库', db.prepare('SELECT COUNT(*) AS n FROM entries WHERE vec IS NULL').get().n === 2)

  const r2 = await tidyMemory(db, { now, embedTexts: async () => null })
  check('服务返回 null → 记失败不抛', r2.failed === 2 && r2.filled === 0)
}

// ---- 2. 补向量：成功、幂等、dry-run 不写 ----
{
  const db = makeDb()
  const id = ins(db, { u: '要补向量的那条', vec: null })
  const dry = await tidyMemory(db, { now, embedTexts: fakeEmbed, dryRun: true })
  check('dry-run 报告会补几条', dry.filled === 1 && dry.missing === 1, JSON.stringify(dry))
  check('dry-run 真的没写', db.prepare('SELECT vec FROM entries WHERE id=?').get(id).vec === null)

  const real = await tidyMemory(db, { now, embedTexts: fakeEmbed })
  const stored = blobToVec(db.prepare('SELECT vec FROM entries WHERE id=?').get(id).vec)
  check('真跑写进了 512 维向量', stored !== null && stored.length === 512, String(stored?.length))
  check('真跑计数对得上', real.filled === 1 && real.failed === 0, JSON.stringify(real))

  const again = await tidyMemory(db, { now, embedTexts: fakeEmbed })
  check('再跑一遍是空的（幂等）', again.missing === 0 && again.filled === 0, JSON.stringify(again))
}

// ---- 3. 热区：抬升条件、上限降级、不删 ----
{
  const db = makeDb()
  ins(db, { u: '新且权重高', t: now - 2 * DAY, w: 4, hot: 0 })
  ins(db, { u: '新但权重低', t: now - 2 * DAY, w: 1, hot: 0 })
  ins(db, { u: '权重高但老了', t: now - 30 * DAY, w: 6, hot: 0 })
  const before = count(db)
  const r = await tidyMemory(db, { now, embedTexts: async () => null })
  const hot = db.prepare("SELECT u FROM entries WHERE hot=1 ORDER BY u").all().map((x) => x.u)
  check('只抬最近 7 天且权重够高的', r.promoted === 1 && hot.length === 1 && hot[0] === '新且权重高', JSON.stringify(hot))
  check('热区条数报得对', r.hotBefore === 0 && r.hotAfter === 1)
  check('整理不删条目', count(db) === before)
}
{
  const db = makeDb()
  for (let i = 0; i < 40; i++) ins(db, { u: `热${i}`, t: now - DAY, w: 1 + i * 0.1, hot: 1 })
  const before = count(db)
  const r = await tidyMemory(db, { now, embedTexts: async () => null, hotMax: 30 })
  const hotN = Number(db.prepare('SELECT COUNT(*) AS n FROM entries WHERE hot=1').get().n)
  const lowest = db.prepare('SELECT hot FROM entries WHERE w <= 1.05').all()
  check('超过上限降到 30 条', hotN === 30 && r.hotAfter === 30, `${hotN}`)
  check('降的是权重最低的', r.demoted === 10 && lowest.every((x) => x.hot === 0))
  check('压热区也不删条目', count(db) === before)
}

// ---- 5. 分层三参数：默认等于常量、config 覆盖、越界夹边界、命令行最优先 ----
{
  const db = makeDb()
  for (let i = 0; i < 40; i++) ins(db, { u: `热${i}`, t: now - DAY, w: 1, hot: 1 })
  const r = await tidyMemory(db, { now, embedTexts: async () => null })
  check('默认热区上限 = 常量', r.hotAfter === HOT_ZONE_MAX, `${r.hotAfter} vs ${HOT_ZONE_MAX}`)

  const db2 = makeDb()
  ins(db2, { u: '刚到门槛', t: now - DAY, w: HOT_PROMOTE_WEIGHT, hot: 0 })
  ins(db2, { u: '差一点', t: now - DAY, w: HOT_PROMOTE_WEIGHT - 1, hot: 0 })
  const r2 = await tidyMemory(db2, { now, embedTexts: async () => null })
  const hot2 = db2.prepare('SELECT u FROM entries WHERE hot=1').all().map((x) => x.u)
  check('默认抬升门槛 = 常量', r2.promoted === 1 && hot2[0] === '刚到门槛', JSON.stringify(hot2))
  check('默认层级惩罚 = 常量', numCfg(undefined, TIER_PENALTY, 0, 1) === TIER_PENALTY)
}
{
  const db = makeDb()
  for (let i = 0; i < 8; i++) ins(db, { u: `热${i}`, t: now - DAY, w: 1, hot: 1 })
  ins(db, { u: '权重只有 1 的新条目', t: now - DAY, w: 1, hot: 0 })
  const r = await tidyMemory(db, {
    now, embedTexts: async () => null,
    config: { hotZoneMax: 5, hotPromoteWeight: 1 },
  })
  const hotN = Number(db.prepare('SELECT COUNT(*) AS n FROM entries WHERE hot=1').get().n)
  check('config 的热区上限生效', r.hotAfter === 5 && hotN === 5, `${hotN}`)
  check('config 的抬升门槛生效', r.promoted === 1 && r.demoted === 4, JSON.stringify(r))
}
{
  const db = makeDb()
  for (let i = 0; i < 250; i++) ins(db, { u: `热${i}`, t: now - DAY, w: 1, hot: 1 })
  const r = await tidyMemory(db, {
    now, embedTexts: async () => null,
    config: { hotZoneMax: 9999, hotPromoteWeight: -5 },
  })
  check('hotZoneMax 越界夹到 200', r.hotAfter === 200, `${r.hotAfter}`)
  check('hotPromoteWeight 越界夹到 0', numCfg(-5, HOT_PROMOTE_WEIGHT, 0, 20) === 0)
  check('tierPenalty 越界夹到 0..1', numCfg(5, TIER_PENALTY, 0, 1) === 1 && numCfg(-1, TIER_PENALTY, 0, 1) === 0)
  const r2 = await tidyMemory(db, {
    now, embedTexts: async () => null, hotMax: 3, config: { hotZoneMax: 9999 },
  })
  check('命令行参数优先于 config', r2.hotAfter === 3, `${r2.hotAfter}`)
}

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
