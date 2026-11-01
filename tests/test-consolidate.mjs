/**
 * 梳理链路的护栏回归：不联网、不碰真实记忆库。
 *
 * 覆盖：定时器默认不注册（只有 autoConsolidate === true 才注册）、
 * 备份失败则一条都不删、删除走事务（中途抛错整批回滚、条目仍在）、
 * 梳理前的备份文件名带时间戳。
 *
 * 跑法：node tests/test-consolidate.mjs
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createConsolidator, scheduleConsolidate, CONSOLIDATE_INTERVAL_MS } from '../lib/consolidate.mjs'
import { createBackup } from '../lib/backup.mjs'

let pass = 0
let fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  OK  ' + name) }
  else { fail += 1; console.log('  NG  ' + name + (extra ? ` — ${extra}` : '')) }
}

const root = mkdtempSync(join(tmpdir(), 'mem-consolidate-'))
const now = Date.now()

/** 造一份最小库（临时文件，VACUUM INTO 要落盘）。 */
const makeDb = (name) => {
  const path = join(root, name)
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, u TEXT NOT NULL, a TEXT NOT NULL, t INTEGER NOT NULL,
      w REAL NOT NULL DEFAULT 1, emo TEXT NOT NULL DEFAULT '[]', vec BLOB,
      hot INTEGER NOT NULL DEFAULT 1, owner TEXT NOT NULL DEFAULT '', space TEXT NOT NULL DEFAULT 'default',
      hits INTEGER NOT NULL DEFAULT 0, tier INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE facts (id INTEGER PRIMARY KEY AUTOINCREMENT, f TEXT NOT NULL UNIQUE, space TEXT NOT NULL DEFAULT 'default',
      valid_from INTEGER NOT NULL DEFAULT 0, valid_until INTEGER);
    CREATE TABLE scenes (topic TEXT PRIMARY KEY, body TEXT NOT NULL, entry_ids TEXT NOT NULL DEFAULT '[]',
      n INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL, space TEXT NOT NULL DEFAULT 'default');
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE stats (k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE daily_stats (day TEXT NOT NULL, k TEXT NOT NULL, v INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, k));
  `)
  return { db, path }
}

const ins = (db, u, extra = '') => {
  db.prepare('INSERT INTO entries (u,a,t,w,emo,hot,space) VALUES (?,?,?,?,?,?,?)')
    .run(u, `回 ${u}${extra}`, now, 1, '[]', 0, 'default')
  return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id)
}
const count = (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM entries').get().n)

/** 假的 llm：一次性吐出给定 JSON。 */
const fakeLlm = (json) => ({
  prepareCall: async () => ({
    config: { provider: 'p', model: 'm' },
    stream: async function* () { yield { type: 'text-delta', text: json } },
  }),
})

const noRoute = () => ({ provider: 'p', model: 'm' })
const okBackup = () => ({ ok: true, path: '/dev/null', entries: 0 })

/** 包一层：第 n 次匹配 sql 的 prepare 直接抛错，用来模拟事务中途炸掉。 */
const flaky = (db, pattern, n) => {
  let seen = 0
  return {
    prepare: (sql) => {
      if (pattern.test(sql)) {
        seen += 1
        if (seen === n) throw new Error('boom')
      }
      return db.prepare(sql)
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  }
}

// ---- 1. 定时器默认不注册 ----
{
  let armed = 0
  const handle = scheduleConsolidate({
    enabled: false,
    run: () => undefined,
    timer: () => { armed += 1; return { unref: () => undefined } },
  })
  check('默认（false）不注册定时器', handle === null && armed === 0)

  const off = scheduleConsolidate({ enabled: undefined, run: () => undefined, timer: () => { armed += 1; return null } })
  check('配置缺省也不注册', off === null && armed === 0)

  let ms = 0
  const on = scheduleConsolidate({
    enabled: true,
    run: () => undefined,
    timer: (_fn, _ms) => { armed += 1; ms = _ms; return { unref: () => undefined } },
  })
  check('autoConsolidate=true 才注册', on !== null && armed === 1)
  check('间隔是 6 小时', ms === CONSOLIDATE_INTERVAL_MS, String(ms))
}

// ---- 2. 备份失败就不删 ----
{
  const { db } = makeDb('backup-fail.db')
  for (const u of ['第一条记忆', '第二条记忆', '第三条记忆', '第四条记忆']) ins(db, u)
  const before = count(db)

  const { consolidateNow } = createConsolidator({
    db,
    bumpStat: () => undefined,
    defaultRoute: noRoute,
    routeFor: noRoute,
    getLlm: () => fakeLlm(JSON.stringify({ merge: [], drop: [1, 2], insight: '' })),
    space: () => 'default',
    backupNow: () => ({ ok: false, reason: 'vacuum-failed' }),
  })
  const r = await consolidateNow()
  check('备份失败直接返回 skipped', r.skipped === 'backup-failed', JSON.stringify(r))
  check('一条都没删', count(db) === before, `${count(db)} / ${before}`)
}

// ---- 3. 没有 backupNow 也不动手 ----
{
  const { db } = makeDb('no-backup.db')
  for (const u of ['甲条记忆', '乙条记忆', '丙条记忆']) ins(db, u)
  const before = count(db)
  const { consolidateNow } = createConsolidator({
    db,
    bumpStat: () => undefined,
    defaultRoute: noRoute,
    routeFor: noRoute,
    getLlm: () => fakeLlm(JSON.stringify({ merge: [], drop: [1], insight: '' })),
    space: () => 'default',
  })
  const r = await consolidateNow()
  check('没接备份函数也拒绝动手', r.skipped === 'backup-failed' && count(db) === before, JSON.stringify(r))
}

// ---- 4. 删除走事务：中途抛错整批回滚 ----
{
  const { db } = makeDb('tx-rollback.db')
  const ids = ['第一条记忆', '第二条记忆', '第三条记忆', '第四条记忆'].map((u) => ins(db, u))
  const before = count(db)
  const { backupNow } = createBackup({
    db,
    memoryDir: root,
    cfgVal: (v, d) => (v ?? d),
    config: {},
    bumpStat: () => undefined,
    dayKeyOf: () => '2026-11-01',
  })

  // 先合两条（第 1 次 DELETE），再删一条（第 2 次 DELETE 抛错）。
  const plan = JSON.stringify({ merge: [{ ids: [ids[0], ids[1]], into: '合并后的一句', reason: '重复' }], drop: [ids[2]], insight: '' })
  const { consolidateNow } = createConsolidator({
    db: flaky(db, /DELETE FROM entries/u, 2),
    bumpStat: () => undefined,
    defaultRoute: noRoute,
    routeFor: noRoute,
    getLlm: () => fakeLlm(plan),
    space: () => 'default',
    backupNow,
  })
  const r = await consolidateNow()
  check('中途抛错返回 tx-failed', r.error === 'tx-failed', JSON.stringify(r))
  check('回滚后条目数不变', count(db) === before, `${count(db)} / ${before}`)
  check('被合掉的那条还在', db.prepare('SELECT COUNT(*) AS n FROM entries WHERE id = ?').get(ids[1]).n === 1)
  const head = db.prepare('SELECT a FROM entries WHERE id = ?').get(ids[0]).a
  check('合并改写也一起回滚了', head === `回 第一条记忆`, head)

  const files = readdirSync(join(root, 'backups'))
  check(
    '梳理前留了带时间戳的备份',
    files.some((f) => /^memory-pre-consolidate-\d+\.db$/u.test(f)),
    files.join(','),
  )
}

// ---- 5. 正常路径：照删、照记账、备份留两份不覆盖 ----
{
  const { db } = makeDb('happy.db')
  const ids = ['这边一条记忆', '那边一条记忆', '第三条记忆', '第四条记忆'].map((u) => ins(db, u))
  const { backupNow } = createBackup({
    db,
    memoryDir: root,
    cfgVal: (v, d) => (v ?? d),
    config: {},
    bumpStat: () => undefined,
    dayKeyOf: () => '2026-11-01',
  })
  const { consolidateNow } = createConsolidator({
    db,
    bumpStat: () => undefined,
    defaultRoute: noRoute,
    routeFor: noRoute,
    getLlm: () => fakeLlm(JSON.stringify({ merge: [], drop: [ids[3]], insight: '' })),
    space: () => 'default',
    backupNow,
  })
  const r = await consolidateNow()
  check('删除照常执行', r.dropped === 1, JSON.stringify(r))
  check('条目确实少了一条', db.prepare('SELECT COUNT(*) AS n FROM entries WHERE id = ?').get(ids[3]).n === 0)
  check('记了 consolidatedAt', Number(db.prepare("SELECT v FROM meta WHERE k='consolidatedAt'").get()?.v) > 0)

  const before = readdirSync(join(root, 'backups')).filter((f) => /^memory-pre-consolidate-/u.test(f)).length
  await consolidateNow()
  const after = readdirSync(join(root, 'backups')).filter((f) => /^memory-pre-consolidate-/u.test(f)).length
  check('每次梳理都新留一份，不覆盖', after === before + 1, `${before} → ${after}`)
}

// 清理
try { rmSync(root, { recursive: true, force: true }) } catch { /* 临时目录删不掉就算了 */ }

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
