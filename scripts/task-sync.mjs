#!/usr/bin/env node
/**
 * NEXT.md → task 表（**单向**）。
 *
 * 只读 `db/NEXT.md` 的未勾选项（`- [ ] …`），插入/更新 `task` 表；
 * 绝不反向写 NEXT.md——双向同步是两套写入打架，最后一定有一边丢（brain-plan 第六节）。
 *
 *   node scripts/task-sync.mjs
 *   node scripts/task-sync.mjs --db /tmp/brain/memory.db --next ~/.dsh/miyu/db/NEXT.md
 *   node scripts/task-sync.mjs --space default --dry-run
 *
 * 幂等：同一份 NEXT 跑两次，第二次三项计数都是 0。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../lib/core/db-open.mjs'
import { ensureTaskTable, parseOpen, syncFromNext, stackTop } from '../lib/tasks.mjs'

const argv = process.argv.slice(2)
const flagValue = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  return argv[i + 1] ?? fallback
}
const dryRun = argv.includes('--dry-run')

const nextPath = flagValue('next', join(homedir(), '.dsh', 'miyu', 'db', 'NEXT.md'))
const dbPath = flagValue('db', process.env.WHALE_DB ?? join(homedir(), '.dsh', 'whale-memory', 'memory.db'))
const space = flagValue('space', 'default')

if (!existsSync(dbPath)) {
  console.log(`库不在这里：${dbPath}`)
  console.log('用 --db 指到已有的 memory.db（或先让插件启动一次建库）。')
  process.exit(0)
}
if (!existsSync(nextPath)) {
  console.log(`NEXT.md 不在这里：${nextPath}（用 --next 指定）`)
  process.exit(0)
}

const db = openDb(dbPath, { timeout: 5000 })
ensureTaskTable(db)

if (dryRun) {
  const md = readFileSync(nextPath, 'utf8')
  const items = parseOpen(md)
  console.log(`[dry-run] NEXT 未完成项 ${items.length} 条：`)
  for (const it of items) console.log(`  - ${it.title}`)
  process.exit(0)
}

const r = syncFromNext(db, { nextPath, space })
console.log(`NEXT：${nextPath}`)
console.log(`库：${dbPath}（空间 ${space}）`)
console.log(`未完成项 ${r.total} 条 → 插入 ${r.inserted} / 复活 ${r.revived} / 收工 ${r.closed}`)
const top = stackTop(db, { space, limit: 3 })
if (top.length > 0) console.log(`栈顶：${top.map((t) => `${t.title}(${t.status})`).join(' / ')}`)
else console.log('栈顶：空')
process.exit(0)
