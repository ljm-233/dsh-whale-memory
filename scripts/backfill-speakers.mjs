#!/usr/bin/env node
/**
 * 回填说话人（`entries.spk`）：给老条目补「谁说的」。
 *
 * 三条规则，按顺序，命中一条就停：
 *   ① 正文里已有的痕迹：`<@OPENID…>` 前缀、`<dsh_im_source>{"senderId":…}`。
 *   ② 群档 `group-history.sqlite` 里 ±10 分钟窗内的**唯一**对齐。
 *   ③ 歧义（多命中）与无解：留空。不猜。
 *
 * 只写 `spk` 一列，别的列一个字不动。默认 `--dry-run`，只统计不落盘。
 *
 *   node scripts/backfill-speakers.mjs                       # 只读打开真实库，出统计
 *   node scripts/backfill-speakers.mjs --db /tmp/p0/memory.db --apply
 *   node scripts/backfill-speakers.mjs --limit 200 --apply --db /tmp/p0/memory.db
 *
 * ⚠️ `--apply` 前先把库复制一份：`cp ~/.dsh/miyu/db/memory.db /tmp/p0/memory.db`。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../lib/db-open.mjs'
import {
  GROUP_DB, WINDOW_MS, alignSpeaker, ensureSpeakerColumns, readGroupWindow, regexSpeaker,
} from '../lib/speaker.mjs'

const DEFAULT_DB = join(homedir(), '.dsh', 'miyu', 'db', 'memory.db')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (argv[i + 1] ?? fallback)
}

if (flag('help') || argv.includes('-h')) {
  console.log(`用法: node scripts/backfill-speakers.mjs [选项]

  --db <file>        记忆库（默认 ${DEFAULT_DB}）
  --group-db <file>  群档（默认 ${GROUP_DB}）
  --limit <n>        只处理最近 n 条候选（按 t 倒序）
  --dry-run          只统计，不写库（默认）
  --apply            真写：只更新 spk 一列
  --migrate          先补 spk/imp 列与 person 表（幂等，只加列不动数据；库副本上跑 dry-run 时需要）
  --help, -h         看这段

先复制一份再 apply：cp ~/.dsh/miyu/db/memory.db /tmp/p0/memory.db
`)
  process.exit(0)
}

const apply = flag('apply')
const migrate = flag('migrate') || apply
const dbPath = value('db', DEFAULT_DB)
const groupDb = value('group-db', GROUP_DB)
const limit = Math.max(0, Math.trunc(Number(value('limit', '0')) || 0))

if (!existsSync(dbPath)) {
  console.error(`记忆库不存在: ${dbPath}`)
  process.exit(2)
}
if (!existsSync(groupDb)) console.log(`群档不存在，只能走正则: ${groupDb}`)

const db = openDb(dbPath, apply || migrate ? { timeout: 5000 } : { readOnly: true, timeout: 5000 })
// 只读打开时不能 ALTER；apply/--migrate 模式顺手把列补上（幂等，只加列不动数据）。
if (apply || migrate) ensureSpeakerColumns(db)

const cols = db.prepare('PRAGMA table_info(entries)').all().map((c) => c.name)
if (!cols.includes('spk')) {
  console.error('这条库还没有 spk 列：先让插件启动一次（ensureSpeakerColumns）再来回填。')
  process.exit(2)
}

const total = db.prepare("SELECT COUNT(*) c FROM entries WHERE u <> ''").get().c
const sql = `SELECT id, u, t FROM entries WHERE u <> '' AND spk = '' ORDER BY t DESC${limit > 0 ? ' LIMIT ?' : ''}`
const rows = limit > 0 ? db.prepare(sql).all(limit) : db.prepare(sql).all()
const coveredBefore = db.prepare("SELECT COUNT(*) c FROM entries WHERE spk IS NOT NULL AND spk <> ''").get().c

const stats = {
  total, candidates: rows.length, coveredBefore,
  regex: 0, aligned: 0, ambiguous: 0, none: 0, short: 0, applied: 0,
}

const cache = new Map() // 同一分钟内的条目共用一次窗口查询
const windowOf = (t) => {
  const key = Math.floor(t / WINDOW_MS)
  if (!cache.has(key)) cache.set(key, readGroupWindow(groupDb, t))
  return cache.get(key)
}

const update = apply ? db.prepare("UPDATE entries SET spk = ? WHERE id = ? AND spk = ''") : null
if (apply) db.exec('BEGIN IMMEDIATE')

try {
  for (const r of rows) {
    let spk = regexSpeaker(r.u)
    if (spk !== '') {
      stats.regex += 1
    } else {
      const verdict = alignSpeaker(windowOf(r.t), r.u)
      if (verdict.reason === 'match') { spk = verdict.spk; stats.aligned += 1 }
      else if (verdict.reason === 'ambiguous') stats.ambiguous += 1
      else if (verdict.reason === 'short') stats.short += 1
      else stats.none += 1
    }
    if (spk !== '' && update) {
      update.run(spk, r.id)
      stats.applied += 1
    }
  }
  if (apply) db.exec('COMMIT')
} catch (err) {
  if (apply) { try { db.exec('ROLLBACK') } catch { /* 已经回滚 */ } }
  console.error(`回填中断: ${err?.message ?? err}`)
  process.exit(1)
}

const coveredAfter = db.prepare("SELECT COUNT(*) c FROM entries WHERE spk IS NOT NULL AND spk <> ''").get().c
const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '0.0%')
const resolved = stats.regex + stats.aligned
const empty = stats.ambiguous + stats.none + stats.short

console.log(`库: ${dbPath}`)
console.log(`群档: ${groupDb}`)
console.log(`模式: ${apply ? 'apply（真写 spk）' : 'dry-run（只统计）'}`)
console.log(`候选: ${stats.candidates} 条（u 非空且 spk 为空${limit > 0 ? `，限 ${limit}` : ''}）`)
console.log(`\n-- 命中统计（候选内） --`)
console.log(`正则命中: ${stats.regex}  ${pct(stats.regex, stats.candidates)}`)
console.log(`对齐命中: ${stats.aligned}  ${pct(stats.aligned, stats.candidates)}`)
console.log(`歧义    : ${stats.ambiguous}`)
console.log(`无解    : ${stats.none}`)
console.log(`太短不判: ${stats.short}`)
console.log(`\n-- 覆盖率 --`)
console.log(`候选内最终覆盖: ${resolved} / ${stats.candidates} = ${pct(resolved, stats.candidates)}`)
console.log(`已留空        : ${empty} / ${stats.candidates} = ${pct(empty, stats.candidates)}`)
console.log(`全库覆盖: 处理前 ${stats.coveredBefore} / ${total} = ${pct(stats.coveredBefore, total)}`)
console.log(`          处理后 ${coveredAfter} / ${total} = ${pct(coveredAfter, total)}`)
if (apply) console.log(`\n实写: ${stats.applied} 行（只动 spk）`)
else console.log('\n没有写库。要真写：先复制一份库，再加 --apply。')

db.close()
