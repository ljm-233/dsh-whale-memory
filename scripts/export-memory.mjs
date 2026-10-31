#!/usr/bin/env node
/**
 * 导出记忆：把记忆库落成一份可读、可版本化的快照。
 *
 * 用法：
 *   node scripts/export-memory.mjs [--db <memory.db>] [--out <dir>] [--git] [--push]
 *
 * 默认导出到 <记忆库目录>/exports/<时间戳>/，里面是 memory.json（机器读）和
 * memory.md（人读）。加了 --git 就在导出目录里提交；再加 --push 才推远端。
 *
 * 只读源库：用 SQLite 的只读打开，导出不会改动记忆本身。
 */
import { openDb } from '../lib/db-open.mjs'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const memoryDir = resolve(value('--db', join(homedir(), '.dsh', 'whale-memory', 'memory.db')))
const dbPath = memoryDir.endsWith('.db') ? memoryDir : join(memoryDir, 'memory.db')
if (!existsSync(dbPath)) {
  console.error(`找不到记忆库：${dbPath}`)
  process.exit(2)
}

const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
const outDir = resolve(value('--out', join(dbPath, '..', 'exports', stamp)))
mkdirSync(outDir, { recursive: true })

const db = openDb(dbPath, { readOnly: true, timeout: 5000 })
const all = (sql) => {
  try { return db.prepare(sql).all() } catch { return [] }
}

const facts = all('SELECT f FROM facts ORDER BY id').map((r) => r.f)
const diary = all('SELECT day, text FROM diary ORDER BY day').map((r) => ({ day: r.day, text: r.text }))
const scenes = all('SELECT topic, body, n, updated FROM scenes ORDER BY updated')
const entries = all('SELECT id,u,a,t,w,emo,hot,space FROM entries ORDER BY t').map((r) => ({
  id: r.id, at: r.t, user: r.u, assistant: r.a, weight: r.w, emo: JSON.parse(r.emo || '[]'), hot: r.hot, space: r.space ?? 'default',
}))
const stats = Object.fromEntries(all('SELECT k,v FROM stats').map((r) => [r.k, r.v]))
let persona = ''
try { persona = String(db.prepare("SELECT v FROM meta WHERE k='persona'").get()?.v ?? '') } catch { persona = '' }

const bundle = {
  exportedAt: new Date().toISOString(),
  source: dbPath,
  counts: { entries: entries.length, facts: facts.length, diary: diary.length, scenes: scenes.length },
  persona,
  facts,
  scenes,
  diary,
  entries,
  stats,
}

writeFileSync(join(outDir, 'memory.json'), `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')

const fenced = (text) => `\`\`\`\n${text}\n\`\`\``
const md = [
  `# 记忆导出 ${bundle.exportedAt}`,
  '',
  `- 条目 ${entries.length} · 事实 ${facts.length} · 场景 ${scenes.length} · 日记 ${diary.length}`,
  '',
  '## 我记得的你（画像）',
  persona === '' ? '（还没有）' : fenced(persona),
  '',
  '## 事实',
  facts.length === 0 ? '（没有）' : facts.map((f) => `- ${f}`).join('\n'),
  '',
  '## 场景',
  scenes.length === 0 ? '（没有）' : scenes.map((s) => `### ${s.topic}（${s.n} 条）\n${fenced(s.body)}`).join('\n'),
  '',
  '## 日记',
  diary.length === 0 ? '（没有）' : diary.map((d) => `### ${d.day}\n${d.text}`).join('\n\n'),
  '',
  '## 统计',
  fenced(JSON.stringify(stats, null, 2)),
  '',
].join('\n')
writeFileSync(join(outDir, 'memory.md'), md, 'utf8')

console.log(JSON.stringify({ ok: true, outDir, counts: bundle.counts }))

if (flag('--git')) {
  const run = (argv) => spawnSync('git', argv, { cwd: outDir, encoding: 'utf8' })
  if (!existsSync(join(outDir, '.git'))) run(['init', '-q'])
  run(['add', '-A'])
  const commit = run(['commit', '-q', '-m', `memory export ${stamp}`])
  if (commit.status !== 0 && !String(commit.stdout + commit.stderr).includes('nothing to commit')) {
    console.error(commit.stderr.trim())
    process.exit(3)
  }
  console.log(JSON.stringify({ git: 'committed', outDir }))
  if (flag('--push')) {
    const push = run(['push'])
    console.log(JSON.stringify({ git: push.status === 0 ? 'pushed' : 'push-failed', stderr: push.stderr.trim() }))
    if (push.status !== 0) process.exit(4)
  }
}
