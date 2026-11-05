#!/usr/bin/env node
/**
 * 第二层自动落盘：把群聊增量导出成人可读的全量日志（插件自带版，node 实现）。
 *
 * 行为与原型 `~/.dsh/miyu/scripts/dump-group.py` 一致：
 *   - 数据源只读打开 `~/.dsh/integrations/dsh-im/group-history.sqlite`
 *   - 游标用 `messages.rowid`（`messages.id` 是 uuid，不能当游标），存 `<导出目录>/.last-id`
 *   - 每行 `HH:MM:SS 昵称：正文`，按本地日期（Asia/Shanghai，固定 +08:00）分文件：
 *     `全量-YYYY-MM-DD.md`
 *   - 首次运行只导当天，不回溯历史；重复跑不重复写（幂等）
 *   - 退出码永远 0，错误写 stderr，留在 journal 里
 *
 * 配置（与周记共用一份，见 lib/dump-config.mjs；设置页「自动落盘 / 周记」那几项）：
 *   groupDump.enabled          关掉就打印一行「已关闭」并退出
 *   groupDump.dir              导出目录，默认 ~/.dsh/miyu/logs
 *   groupDump.intervalMinutes  只影响 systemd 定时器渲染，脚本本身不管间隔
 *
 *   node scripts/dump-group.mjs [--config <file.json>]
 * 环境变量（测试/迁移用）：MIYU_BASE、DSH_GROUP_DB
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadLayerConfig } from '../lib/dump-config.mjs'

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000 // Asia/Shanghai，无夏令时

const argv = process.argv.slice(2)
const flagValue = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] ?? '') : ''
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log('用法: node scripts/dump-group.mjs [--config <file.json>]')
  console.log('  配置来自设置页（groupDump.*），或 profile 的 cordis.patch.yml，或内置默认值')
  process.exit(0)
}

const p2 = (n) => String(n).padStart(2, '0')
const shifted = (ms) => new Date(ms + TZ_OFFSET_MS)
const dateKey = (ms) => {
  const d = shifted(ms)
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
}
const timeKey = (ms) => {
  const d = shifted(ms)
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
}

/** 正文里换行压成 ↵，空正文写（空）。 */
function clean(s) {
  let v = String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '↵')
  v = v.trim()
  return v || '（空）'
}

/** node:sqlite 是 Node ≥22.5 内置；够不上就返回 null，让调用方打一行提示走人。 */
async function loadSqlite() {
  const [maj, min] = process.versions.node.split('.').map(Number)
  const ok = maj > 22 || (maj === 22 && min >= 5)
  if (!ok) return null
  try {
    const mod = await import('node:sqlite')
    return mod.DatabaseSync ? mod : null
  } catch {
    return null
  }
}

/** 只读打开：优先 readOnly 选项，不认识就退回 PRAGMA query_only。 */
function openReadOnly(DatabaseSync, path) {
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA query_only = 1')
    } catch {
      /* 设不上也照跑，反正只发 SELECT */
    }
    return db
  }
}

async function main() {
  const cfg = loadLayerConfig({ configFile: flagValue('--config') })
  if (!cfg.groupDump.enabled) {
    console.log('自动落盘已关闭（设置页「自动落盘」），本轮跳过')
    return
  }

  const logdir = cfg.groupDump.dir
  const state = join(logdir, '.last-id')
  const dbPath = process.env.DSH_GROUP_DB || join(homedir(), '.dsh', 'integrations', 'dsh-im', 'group-history.sqlite')
  if (!existsSync(dbPath)) {
    console.log(`no database (${dbPath}), skip`)
    return
  }
  const sqlite = await loadSqlite()
  if (!sqlite) {
    console.log(`node:sqlite 不可用（当前 Node ${process.versions.node}，需要 ≥22.5 或 ≥24），本轮跳过`)
    return
  }

  mkdirSync(logdir, { recursive: true })
  let lastId = null
  try {
    const n = Number.parseInt(readFileSync(state, 'utf8').trim(), 10)
    lastId = Number.isFinite(n) ? n : null
  } catch {
    lastId = null
  }
  const first = lastId === null

  const db = openReadOnly(sqlite.DatabaseSync, dbPath)
  let rows = []
  try {
    if (first) {
      // 首次：只导当天，不回溯历史
      const now = shifted(Date.now())
      const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - TZ_OFFSET_MS
      rows = db
        .prepare('SELECT rowid, sender_name, sent_at, text FROM messages WHERE sent_at >= ? ORDER BY sent_at, rowid')
        .all(startMs)
    } else {
      rows = db
        .prepare('SELECT rowid, sender_name, sent_at, text FROM messages WHERE rowid > ? ORDER BY sent_at, rowid')
        .all(lastId)
    }
  } finally {
    try {
      db.close()
    } catch {
      /* 关不上不影响结果 */
    }
  }

  if (!rows.length) {
    console.log(`no new rows (last_id=${lastId})`)
    return
  }

  const written = {}
  let maxRowid = lastId ?? 0
  for (const row of rows) {
    const rowid = Number(row.rowid)
    const ms = Number(row.sent_at)
    const file = `全量-${dateKey(ms)}.md`
    const who = String(row.sender_name ?? '').trim() || '（未知）'
    writeFileSync(join(logdir, file), `${timeKey(ms)} ${clean(who)}：${clean(row.text)}\n`, { encoding: 'utf8', flag: 'a' })
    written[file] = (written[file] ?? 0) + 1
    if (rowid > maxRowid) maxRowid = rowid
  }

  const tmp = `${state}.tmp`
  writeFileSync(tmp, String(Math.trunc(maxRowid)), 'utf8')
  renameSync(tmp, state)

  const from = lastId === null ? 'none' : String(lastId)
  console.log(`wrote ${rows.length} rows ${JSON.stringify(written)} (last_id ${from} -> ${maxRowid})`)
  console.log(`导出目录：${logdir}`)
}

try {
  await main()
} catch (err) {
  console.error(`dump-group error: ${err && err.stack ? err.stack : String(err)}`)
}
process.exit(0)
