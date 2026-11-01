/**
 * 库务整理 + 召回计数的回归：不联网、不碰真实记忆库。
 *
 * 覆盖：补向量（服务在/不在）、dry-run 不写、热区抬升与上限降级、
 * 全程不删条目、召回命中时 hits +1 / tier 回浅一层且一轮只加一次、
 * tier 惩罚不让重要条目沉底。
 *
 * 跑法：node tests/test-memory-tidy.mjs
 */
process.env.EMBED_URL = 'http://127.0.0.1:1'

const { DatabaseSync } = await import('node:sqlite')
const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { tidyMemory, ensureHitColumns } = await import('../lib/tidy.mjs')
const { createRecall } = await import('../lib/recall.mjs')
const { vecToBlob, blobToVec } = await import('../lib/vector.mjs')

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
    CREATE TABLE facts (id INTEGER PRIMARY KEY AUTOINCREMENT, f TEXT, space TEXT DEFAULT 'default');
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

// ---- 4. 召回：hits +1、tier 回浅、一轮只加一次、tier 惩罚只动边角 ----
{
  const db = makeDb()
  const dir = mkdtempSync(join(tmpdir(), 'whale-tidy-'))
  const deep = ins(db, { u: '今天好累，加班到十点 A', t: now - DAY, w: 1, hot: 0, tier: 3 })
  const shallow = ins(db, { u: '今天好累，加班到十点 B', t: now - DAY, w: 1, hot: 0, tier: 0 })
  const important = ins(db, { u: '累的时候记得这是重要的事 C', t: now - 60 * DAY, w: 9, hot: 0, tier: 6 })

  const { build } = createRecall({
    db, memoryDir: dir, bumpStat: () => {}, space: () => 'default',
    budgetChars: () => 8000, factMax: () => 8, recentPairs: () => 0,
    recallMax: () => 3, recallThreshold: () => 0, weightMax: () => 12,
  })
  const msg = (text) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const out = await build({ agent: { session: { id: 's-tidy-1' } }, messages: [msg('今天好累啊')] })
  const text = String(out?.text ?? '')
  const row = (id) => db.prepare('SELECT hits, tier, w FROM entries WHERE id=?').get(id)

  check('召回注入了旧事', text.includes('主动想起') || text.includes('加班到十点'), text.slice(0, 60))
  check('命中后 hits +1', row(shallow).hits + row(deep).hits + row(important).hits >= 1, JSON.stringify([row(shallow), row(deep), row(important)]))
  check('tier 回到浅一层', row(deep).tier === 2 && row(important).tier === 5, JSON.stringify([row(deep).tier, row(important).tier]))

  const hitsAfterFirst = row(deep).hits + row(shallow).hits + row(important).hits
  await build({ agent: { session: { id: 's-tidy-1' } }, messages: [msg('今天好累啊')] })
  check('同一会话再来一轮不再重复加', row(deep).hits + row(shallow).hits + row(important).hits === hitsAfterFirst)

  // tier 惩罚：同权重同时间，浅层排前面；印象深的不受罚。
  const shallowFirst = text.indexOf('B') >= 0 && (text.indexOf('B') < text.indexOf('A') || text.indexOf('A') < 0)
  check('浅层排在深层前面', shallowFirst, text.slice(0, 200))
}

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
