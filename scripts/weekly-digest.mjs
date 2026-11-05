#!/usr/bin/env node
/**
 * 第三层：周记（只统计，不调模型）。
 *
 * 输入：`<导出目录>/全量-YYYY-MM-DD.md`（第二层落盘，一天一文件）
 *       `<导出目录>/../diary/whale-diary.md`（日记，用来数这周写了几天的日记）
 *       `<导出目录>/../db/LEDGER.md`（活账本，捞该周的日期行）
 * 输出：`<导出目录>/../diary/周记-YYYY-Www.md`（同周重跑覆盖）
 *
 * 四块：本周几天 / 每天多少条 / 谁说得最多 / 我在这周里做了什么。
 * 不做摘要、不调 LLM——同样的输入永远得到同样的文件。
 *
 * 配置（与落盘共用一份，见 lib/dump-config.mjs）：
 *   weekly.enabled    关掉就打印一行「已关闭」并退出
 *   weekly.startDay   一周从周几算（1=周一 … 7=周日，默认 1）
 *   groupDump.dir     群档目录，周记跟着它走
 *
 *   node scripts/weekly-digest.mjs [--week 2026-W45] [--base <miyu 根>] [--config <file.json>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadLayerConfig } from '../lib/dump-config.mjs'

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000
const p2 = (n) => String(n).padStart(2, '0')
const shifted = (ms) => new Date(ms + TZ_OFFSET_MS)
const dateKey = (d) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`

const argv = process.argv.slice(2)
const flagValue = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] ?? '') : ''
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log('用法: node scripts/weekly-digest.mjs [--week YYYY-Www] [--base <miyu 根>] [--config <file.json>]')
  console.log('  默认：配置里的导出目录（~/.dsh/miyu/logs）+ 当前这一周（起始日按 weekly.startDay）')
  process.exit(0)
}

/** ISO 周编号：返回 { year, week }，以传入的那一天为准。 */
function isoWeekOf(utcDay) {
  const d = new Date(Date.UTC(utcDay.getUTCFullYear(), utcDay.getUTCMonth(), utcDay.getUTCDate()))
  const dow = d.getUTCDay() || 7
  const thursday = new Date(d)
  thursday.setUTCDate(d.getUTCDate() + 4 - dow)
  const year = thursday.getUTCFullYear()
  const yearStart = new Date(Date.UTC(year, 0, 1))
  const week = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7)
  return { year, week }
}

/** `--week 2026-W45` → 该 ISO 周的周一。 */
function isoWeekMonday(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const dow = jan4.getUTCDay() || 7
  const monday = new Date(jan4)
  monday.setUTCDate(jan4.getUTCDate() - (dow - 1) + (week - 1) * 7)
  return monday
}

/**
 * 算窗口起点：
 *   - 给了 --week：就是那个 ISO 周的周一（显式指定优先，忽略 startDay）
 *   - 没给：从今天往前退到最近的 startDay（1=周一 … 7=周日）
 */
function windowStart(spec, startDay) {
  if (spec) {
    const m = /^(\d{4})-W(\d{1,2})$/.exec(spec.trim())
    if (!m) throw new Error(`--week 要写成 YYYY-Www，收到 ${spec}`)
    return isoWeekMonday(Number(m[1]), Number(m[2]))
  }
  const today = shifted(Date.now())
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  const dow = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() - ((dow - startDay + 7) % 7))
  return d
}

const LINE_RE = /^(\d{2}:\d{2}:\d{2}) (.*?)：(.*)$/

function main() {
  const cfg = loadLayerConfig({ configFile: flagValue('--config') })
  if (!cfg.weekly.enabled) {
    console.log('周记已关闭（设置页「周记」），本轮跳过')
    return
  }

  const baseOverride = flagValue('--base')
  const logdir = baseOverride ? join(resolve(baseOverride), 'logs') : cfg.groupDump.dir
  const baseDir = dirname(logdir)

  const start = windowStart(flagValue('--week'), cfg.weekly.startDay)
  const days = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(start)
    d.setUTCDate(start.getUTCDate() + i)
    days.push(dateKey(d))
  }
  const from = days[0]
  const to = days[6]
  const { year, week } = isoWeekOf(start)

  // —— 每天多少条 / 谁说得最多 ——
  const perDay = []
  const speakers = new Map()
  let total = 0
  for (const day of days) {
    const file = join(logdir, `全量-${day}.md`)
    let count = 0
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        count++
        const m = LINE_RE.exec(line)
        const who = m && m[2].trim() ? m[2].trim() : '（未知）'
        speakers.set(who, (speakers.get(who) ?? 0) + 1)
      }
    }
    perDay.push({ day, count })
    total += count
  }
  const activeDays = perDay.filter((d) => d.count > 0)
  const ranked = [...speakers.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  // —— 我在这周里做了什么：活账本的该周日期行 ——
  const ledgerPath = join(baseDir, 'db', 'LEDGER.md')
  const ledgerRows = []
  if (existsSync(ledgerPath)) {
    for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
      const m = /^- (\d{4}-\d{2}-\d{2}) (.*)$/.exec(line)
      if (m && m[1] >= from && m[1] <= to) ledgerRows.push(line.trim())
    }
  }

  // —— 日记写没写（只数，不总结） ——
  const diaryPath = join(baseDir, 'diary', 'whale-diary.md')
  const diaryDays = new Set()
  if (existsSync(diaryPath)) {
    for (const line of readFileSync(diaryPath, 'utf8').split('\n')) {
      const m = /^## (\d{4}-\d{2}-\d{2})/.exec(line)
      if (m && m[1] >= from && m[1] <= to) diaryDays.add(m[1])
    }
  }

  const out = []
  out.push(`# 周记 ${year}-W${p2(week)}（${from} ~ ${to}）`)
  out.push('')
  out.push('## 本周几天')
  out.push(`- 有群档的天数：${activeDays.length} / 7 天（${activeDays.map((d) => d.day.slice(5)).join('、') || '无'}）`)
  out.push(`- 写日记的天数：${diaryDays.size} 天`)
  out.push('')
  out.push('## 每天多少条')
  if (activeDays.length) {
    for (const d of perDay) out.push(`- ${d.day}：${d.count} 条`)
  } else {
    out.push('- 这周还没有群档（第二层没跑，或都空着）')
  }
  out.push('')
  out.push('## 谁说得最多')
  if (ranked.length) {
    for (const [who, n] of ranked.slice(0, 10)) {
      const pct = total ? ((n / total) * 100).toFixed(1) : '0.0'
      out.push(`- ${who}：${n} 条（${pct}%）`)
    }
    if (ranked.length > 10) {
      const rest = ranked.slice(10)
      const restPct = total ? ((rest.reduce((s, [, n]) => s + n, 0) / total) * 100).toFixed(1) : '0.0'
      out.push(`- 另有 ${rest.length} 人没列，占 ${restPct}%`)
    }
  } else {
    out.push('- 这周没有可统计的发言')
  }
  out.push('')
  out.push('## 我在这周里做了什么')
  if (ledgerRows.length) {
    for (const row of ledgerRows) out.push(row)
  } else {
    out.push('- 活账本这周没有记录')
  }
  out.push('')
  out.push(
    `统计：合计 ${total} 条 / ${ranked.length} 人 / 有档 ${activeDays.length} 天 / 账本 ${ledgerRows.length} 行 / 日记 ${diaryDays.size} 天`,
  )
  out.push('')

  const diaryDir = join(baseDir, 'diary')
  mkdirSync(diaryDir, { recursive: true })
  const target = join(diaryDir, `周记-${year}-W${p2(week)}.md`)
  writeFileSync(target, out.join('\n'), 'utf8')
  console.log(`wrote ${target}`)
  console.log(out[out.length - 2])
}

try {
  main()
} catch (err) {
  console.error(`weekly-digest error: ${err && err.stack ? err.stack : String(err)}`)
}
process.exit(0)
