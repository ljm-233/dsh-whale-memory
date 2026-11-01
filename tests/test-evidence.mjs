/**
 * 证据链（lineage）的回归：不联网、不碰真实记忆库。
 *
 * 覆盖：新条目落库后 `entry_evidence` 有两行（user / assistant，都指回 entry_id）、
 * 原文超过 500 字会被截断、`memory_recall` 的 full 模式出现「证据：」、
 * 默认 card 模式一个字节都不多、`countOrphanEvidence` 只数不删。
 *
 * 跑法：node tests/test-evidence.mjs
 */
process.env.EMBED_URL = 'http://127.0.0.1:1'

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../lib/index.mjs'
import { createWriter } from '../lib/writer.mjs'
import { registerTools } from '../lib/tools.mjs'
import { countOrphanEvidence } from '../lib/tidy.mjs'

let pass = 0
let fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  OK  ' + name) }
  else { fail += 1; console.log('  NG  ' + name + (extra ? ` — ${extra}` : '')) }
}

const dir = mkdtempSync(join(tmpdir(), 'wm-evidence-'))
const tools = new Map()

const effect = (fn) => {
  const dispose = fn()
  return typeof dispose === 'function' ? dispose : () => {}
}
const ctx = {
  on: () => {},
  inject: (deps, cb) => {
    const stub = { effect }
    if (deps.includes('systemPrompt')) {
      stub.systemPrompt = { section: () => {}, context: () => () => {} }
    }
    if (deps.includes('llm')) stub.llm = {}
    if (deps.includes('agents')) stub.agents = { list: () => [] }
    if (deps.includes('dshIm')) stub.dshIm = {}
    if (deps.includes('webServer')) stub.webServer = { register: () => {} }
    if (deps.includes('tools')) stub.tools = { register: (tool) => { tools.set(tool.name, tool) } }
    cb(stub)
  },
  effect,
}
apply(ctx, { memoryPath: dir, preferencePath: join(dir, 'PREFERENCE.md') })

// 真链路要自己开一条连接：apply 那条常驻，互不干扰。
const db = new DatabaseSync(join(dir, 'memory.db'))
const writer = createWriter({
  db,
  bumpStat: () => {},
  recentPairs: () => 4,
  factMax: () => 8,
  space: () => 'default',
  hotMax: () => 30,
})

// ---- 1. 表建出来了，且 entries 的列没被改 ----
{
  const cols = db.prepare('PRAGMA table_info(entry_evidence)').all().map((c) => c.name)
  check('entry_evidence 有四个字段', JSON.stringify(cols) === JSON.stringify(['entry_id', 'source', 'source_kind', 'created']), JSON.stringify(cols))
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='entry_evidence'").all()
  check('entry_id 上有索引', idx.some((r) => r.name === 'idx_entry_evidence_entry'), JSON.stringify(idx))
  check('空的证据表不报错', countOrphanEvidence(db) === 0)
}

// ---- 2. 落库一行条目 → 两行证据 ----
const USER_LINE = '我把旧照片都扫了一遍，放在书柜第二层'
const BOT_LINE = '扫完记得备份，别只留一份在那台机器上'
{
  writer.setUser(USER_LINE)
  writer.setAssistant(BOT_LINE)
  await writer.flush()

  const entry = db.prepare('SELECT MAX(id) id FROM entries').get()
  const rows = db.prepare('SELECT entry_id, source, source_kind, created FROM entry_evidence ORDER BY rowid').all()
  check('新条目写了两行证据', rows.length === 2, JSON.stringify(rows.length))
  check('两行都指回 entry_id', rows.every((r) => Number(r.entry_id) === Number(entry.id)), JSON.stringify(rows))
  check('user 在前、assistant 在后', rows[0]?.source_kind === 'user' && rows[1]?.source_kind === 'assistant', JSON.stringify(rows.map((r) => r.source_kind)))
  check('存的是原话不是摘要', rows[0]?.source === USER_LINE && rows[1]?.source === BOT_LINE, JSON.stringify(rows.map((r) => r.source)))
  check('证据带时间', rows.every((r) => Number(r.created) > 0))

  // 只有一半（比如没接到回复）也只写一行，不硬凑
  writer.setUser('只说了半句')
  await writer.flush()
  const half = db.prepare('SELECT source_kind FROM entry_evidence ORDER BY rowid').all().map((r) => r.source_kind)
  check('缺一条就只写一条', half.length === 3 && half[2] === 'user', JSON.stringify(half))
}

// ---- 3. 超长原文截到 500 字 ----
{
  writer.setUser('长'.repeat(900))
  writer.setAssistant('短回复')
  await writer.flush()
  const last = db.prepare('SELECT source FROM entry_evidence ORDER BY rowid DESC LIMIT 1').get()
  check('证据截到 500 字以内', String(last.source).length <= 500, String(last.source.length))
}

// ---- 4. memory_recall：full 有证据行，card 一点都不多 ----
{
  // 这台机器不一定装了 @deepseek-ai/dsh-tools；defineTool 给个直通壳就能验到工具本体。
  const toolCtx = {
    ...ctx,
    inject: (deps, cb) => {
      const stub = { effect }
      if (deps.includes('tools')) stub.tools = { register: (t) => tools.set(t.name, t) }
      cb(stub)
    },
  }
  registerTools(toolCtx, { defineTool: (def) => def, db, space: () => 'default' })
  const tool = tools.get('memory_recall')
  assert.ok(tool, '要注册 memory_recall')
  const full = tool.execute({ keyword: '旧照片', detail: 'full' }, { agent: { session: { id: 's-evidence-full' } } })
  check('full 模式出现「证据：」', String(full.text).includes('证据：'), JSON.stringify(String(full.text).slice(0, 120)))
  check('证据里是原话开头', String(full.text).includes('我把旧照片都扫了一遍'), JSON.stringify(String(full.text).slice(0, 160)))
  check('同一条最多两条证据', String(full.text).split('证据：').length - 1 === 1, String(full.text))

  const card = tool.execute({ keyword: '旧照片' }, { agent: { session: { id: 's-evidence-card' } } })
  const dumped = JSON.stringify(card.items)
  check('card 模式不带证据行', !dumped.includes('证据：'), dumped.slice(0, 120))
  check('card 还是六字段卡', /^#[0-9a-f]{1,6} /u.test(String(card.items[0]?.card ?? '')), String(card.items[0]?.card))
}

// ---- 5. 计数只读：数得出来，不删行 ----
{
  db.prepare('INSERT INTO entry_evidence(entry_id, source, source_kind, created) VALUES(?,?,?,?)')
    .run(999999, '孤儿证据', 'user', Date.now())
  const before = Number(db.prepare('SELECT COUNT(*) c FROM entry_evidence').get().c)
  check('数出孤儿证据', countOrphanEvidence(db) === 1, String(countOrphanEvidence(db)))
  check('没删任何行', Number(db.prepare('SELECT COUNT(*) c FROM entry_evidence').get().c) === before)
}

db.close()
console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
