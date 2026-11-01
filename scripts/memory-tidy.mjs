#!/usr/bin/env node
/**
 * 库务整理：补向量、抬热区、压热区。幂等，随时可重跑。
 *
 * 用法：
 *   node scripts/memory-tidy.mjs [--db <memory.db>] [--dry-run] [--min-w 3] [--hot-max 30] [--config <cordis.patch.yml>]
 *
 * 取值优先级：命令行参数 > 活动 profile 里的插件配置（设置页改的那份）> 常量。
 *
 * 只补不删：vec 空着的补上，最近 7 天权重够高的抬进热区，
 * 热区超上限时按权重从低往下降（降级，不是删）。
 * 嵌入服务不在时补向量那步记失败就继续，剩下的步骤照跑。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '../lib/db-open.mjs'
import { tidyMemory } from '../lib/tidy.mjs'
import { embedTexts } from '../lib/vector.mjs'
import { DEFAULT_MEMORY_DIR, DB_FILE, HOT_ZONE_MAX, HOT_PROMOTE_WEIGHT } from '../lib/constants.mjs'
import { numCfg } from '../lib/shared.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

/**
 * 从活动 profile 的 cordis patch 里读本插件那段配置。
 *
 * 只认 `- id: dsh-whale-memory` 之后、下一个顶层条目之前的几行，
 * 不引 YAML 库（零依赖是这仓库的底线）。加别的 profile 再传 --config。
 */
const readProfileConfig = (file) => {
  try {
    const lines = readFileSync(file, 'utf8').split('\n')
    const from = lines.findIndex((l) => /^-\s*id:\s*dsh-whale-memory\s*$/.test(l))
    if (from < 0) return {}
    const block = []
    for (const l of lines.slice(from + 1)) {
      if (/^-\s/.test(l)) break
      block.push(l)
    }
    const pick = (key) => {
      const hit = block.find((l) => new RegExp(`^\\s+${key}:\\s*\\S`).test(l))
      return hit === undefined ? undefined : Number(hit.split(':').slice(1).join(':').trim())
    }
    return { hotZoneMax: pick('hotZoneMax'), hotPromoteWeight: pick('hotPromoteWeight') }
  } catch { return {} }
}

const profileCfg = readProfileConfig(value('--config', join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml')))

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
  hotMax: numCfg(value('--hot-max', profileCfg.hotZoneMax), HOT_ZONE_MAX, 1, 200, true),
  minW: numCfg(value('--min-w', profileCfg.hotPromoteWeight), HOT_PROMOTE_WEIGHT, 0, 20),
})

console.log(
  `${dryRun ? '[dry-run] ' : ''}补向量 ${result.filled}/${result.missing} 条，失败 ${result.failed} 条；` +
  `热区 ${result.hotBefore} → ${result.hotAfter} 条（升 ${result.promoted}，降 ${result.demoted}）`,
)
