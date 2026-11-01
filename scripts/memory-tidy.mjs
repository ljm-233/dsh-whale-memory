#!/usr/bin/env node
/**
 * 库务整理：补向量、抬热区、压热区。幂等，随时可重跑。
 *
 * 用法：
 *   node scripts/memory-tidy.mjs [--db <memory.db>] [--dry-run] [--min-w 3] [--hot-max 30]
 *
 * 只补不删：vec 空着的补上，最近 7 天权重够高的抬进热区，
 * 热区超上限时按权重从低往下降（降级，不是删）。
 * 嵌入服务不在时补向量那步记失败就继续，剩下的步骤照跑。
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openDb } from '../lib/db-open.mjs'
import { tidyMemory } from '../lib/tidy.mjs'
import { embedTexts } from '../lib/vector.mjs'
import { DEFAULT_MEMORY_DIR, DB_FILE, HOT_ZONE_MAX, HOT_PROMOTE_WEIGHT } from '../lib/constants.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const raw = resolve(value('--db', join(DEFAULT_MEMORY_DIR, DB_FILE)))
const dbPath = raw.endsWith('.db') ? raw : join(raw, DB_FILE)
if (!existsSync(dbPath)) {
  console.error(`找不到记忆库：${dbPath}`)
  process.exit(2)
}

const db = openDb(dbPath, { timeout: 5000 })
const dryRun = flag('--dry-run')

const result = await tidyMemory(db, {
  embedTexts,
  dryRun,
  now: Date.now(),
  hotMax: Number(value('--hot-max', HOT_ZONE_MAX)) || HOT_ZONE_MAX,
  minW: Number(value('--min-w', HOT_PROMOTE_WEIGHT)) || HOT_PROMOTE_WEIGHT,
})

console.log(
  `${dryRun ? '[dry-run] ' : ''}补向量 ${result.filled}/${result.missing} 条，失败 ${result.failed} 条；` +
  `热区 ${result.hotBefore} → ${result.hotAfter} 条（升 ${result.promoted}，降 ${result.demoted}）`,
)
