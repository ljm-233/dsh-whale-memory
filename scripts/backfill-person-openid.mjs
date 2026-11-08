#!/usr/bin/env node
/**
 * 回填认人表的完整 openid（`person.openid_full`）。
 *
 * 库里只存 openid 前 8 位（`person.spk` 是主键，不动）；完整 id 只有群档里有
 * ——`messages.sender_id`。这里把前 8 位配上唯一的那条完整 id，写进 `openid_full`。
 *
 * 三条规矩：
 *   ① 只认 32 位十六进制的完整 id（群档里混进别的东西就当没有）。
 *   ② 同一个前 8 位对上**多条不同**的完整 id = 歧义：跳过，报出来，不猜。
 *   ③ 只填空（NULL / 空串）；已有值且不同的算冲突，只报告不覆盖——幂等靠这一条。
 *
 * 默认 dry-run 只打印将要改的行。
 *
 *   node scripts/backfill-person-openid.mjs                          # 只读打开真实库
 *   node scripts/backfill-person-openid.mjs --db /tmp/p0/memory.db --apply
 *   node scripts/backfill-person-openid.mjs --group-db /path/group-history.sqlite
 *
 * ⚠️ `--apply` 前先复制一份：`cp ~/.dsh/miyu/db/memory.db /tmp/p0/memory.db`。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../lib/core/db-open.mjs'
import { GROUP_DB, ensureSpeakerColumns, toSpk } from '../lib/domain/speaker.mjs'

const DEFAULT_DB = join(homedir(), '.dsh', 'miyu', 'db', 'memory.db')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (argv[i + 1] ?? fallback)
}

if (flag('help') || argv.includes('-h')) {
  console.log(`用法: node scripts/backfill-person-openid.mjs [选项]

  --db <file>        记忆库（默认 ${DEFAULT_DB}）
  --group-db <file>  群档（默认 ${GROUP_DB}）
  --dry-run          只打印将要改的行（默认）
  --apply            真写：只更新 person.openid_full 一列
  --migrate          先补 person.openid_full 列（幂等；库副本上跑 dry-run 时需要）
  --help, -h         看这段
`)
  process.exit(0)
}

const apply = flag('apply')
const migrate = flag('migrate') || apply
const dbPath = value('db', DEFAULT_DB)
const groupDb = value('group-db', GROUP_DB)

if (!existsSync(dbPath)) {
  console.error(`记忆库不存在: ${dbPath}`)
  process.exit(2)
}
if (!existsSync(groupDb)) {
  console.error(`群档不存在: ${groupDb}（完整 id 只有那里有）`)
  process.exit(2)
}

const db = openDb(dbPath, apply || migrate ? { timeout: 5000 } : { readOnly: true, timeout: 5000 })
if (apply || migrate) ensureSpeakerColumns(db)

const pcols = db.prepare("SELECT name FROM pragma_table_info('person')").all().map((c) => c.name)
if (pcols.length === 0) {
  console.error('这条库还没有 person 表：先让插件启动一次（ensureSpeakerColumns）再来回填。')
  process.exit(2)
}
if (!pcols.includes('openid_full')) {
  console.error('这条库的 person 表还没有 openid_full 列：加 --migrate（或 --apply）再跑。')
  process.exit(2)
}

// 1) 群档：前 8 位 → 该前缀下所有完整 id（理论上正好 1 条）。
const full = new Map()
const group = openDb(groupDb, { readOnly: true, timeout: 5000 })
try {
  for (const r of group.prepare("SELECT DISTINCT sender_id FROM messages WHERE sender_id <> ''").all()) {
    const id = String(r.sender_id ?? '').trim()
    if (!/^[0-9A-Fa-f]{32}$/.test(id)) continue
    const spk = toSpk(id)
    if (spk === '') continue
    if (!full.has(spk)) full.set(spk, new Set())
    full.get(spk).add(id.toUpperCase())
  }
} finally {
  try { group.close() } catch { /* 只读连接，关不上也不影响 */ }
}

// 2) 认人表：逐行对。
const stats = { persons: 0, matched: 0, filled: 0, same: 0, conflict: 0, ambiguous: 0, missing: 0 }
const todo = []
const conflicts = []
for (const r of db.prepare('SELECT spk, space, name, openid_full FROM person ORDER BY space, spk').all()) {
  stats.persons += 1
  const spk = toSpk(r.spk)
  const ids = spk === '' ? undefined : full.get(spk)
  if (ids === undefined || ids.size === 0) { stats.missing += 1; continue }
  if (ids.size > 1) { stats.ambiguous += 1; todo.push({ ...r, spk, next: null, why: `歧义：${ids.size} 个完整 id` }); continue }
  stats.matched += 1
  const next = [...ids][0]
  const cur = String(r.openid_full ?? '').trim().toUpperCase()
  if (cur === next) { stats.same += 1; continue }
  if (cur !== '') { stats.conflict += 1; conflicts.push({ ...r, spk, cur, next }); continue }
  todo.push({ ...r, spk, next, why: '' })
}

const label = (r) => `${r.spk}  ${String(r.space ?? '')}  ${String(r.name ?? '') || '(无名)'}`
console.log(`库: ${dbPath}`)
console.log(`群档: ${groupDb}（sender ${full.size} 个前 8 位）`)
console.log(`模式: ${apply ? 'apply（真写 openid_full）' : 'dry-run（只打印）'}`)
console.log(`person 行: ${stats.persons}  对上群档: ${stats.matched}  已一致: ${stats.same}  群档里没有: ${stats.missing}`)
console.log(`\n-- 将要回填 ${todo.length} 行 --`)
for (const r of todo) {
  if (r.next === null) { console.log(`  跳过  ${label(r)}  ${r.why}`); continue }
  console.log(`  ${label(r)}  →  ${r.next}`)
}
if (conflicts.length > 0) {
  console.log(`\n-- 冲突 ${conflicts.length} 行（已有值且不同，不覆盖） --`)
  for (const c of conflicts) console.log(`  ${label(c)}  已有 ${c.cur}  群档 ${c.next}`)
}

if (apply) {
  const writable = todo.filter((r) => r.next !== null)
  const update = db.prepare("UPDATE person SET openid_full = ? WHERE spk = ? AND space = ? AND (openid_full IS NULL OR openid_full = '')")
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const r of writable) stats.filled += Number(update.run(r.next, r.spk, String(r.space ?? 'default')).changes ?? 0)
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* 已经回滚 */ }
    console.error(`回填中断: ${err?.message ?? err}`)
    process.exit(1)
  }
  console.log(`\n实写: ${stats.filled} 行（只动 openid_full）`)
} else {
  console.log('\n没有写库。要真写：先复制一份库，再加 --apply。')
}
