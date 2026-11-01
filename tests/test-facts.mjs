/**
 * 事实有效期 + 冲突留痕的回归：不联网、不碰真实记忆库。
 *
 * 覆盖：老库补两列（不丢行、不重复回填）、默认只取仍成立的事实、
 * includeExpired 能取到失效的、相似但不一致写冲突并让旧事实失效、
 * 完全一致不新增行也不写冲突、两个查询入口（memory_recall / conflicts 路由）不抛错。
 *
 * 跑法：node tests/test-facts.mjs
 */
process.env.EMBED_URL = 'http://127.0.0.1:1'

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ensureFactColumns, listFacts, recordFact, recentConflicts,
} from '../lib/facts.mjs'
import { apply } from '../lib/index.mjs'
import { registerTools } from '../lib/tools.mjs'

let pass = 0
let fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  OK  ' + name) }
  else { fail += 1; console.log('  NG  ' + name + (extra ? ` — ${extra}` : '')) }
}

const T0 = Date.now() - 3000
const T1 = T0 + 1000
const T2 = T0 + 2000

/** 老库：facts 只有 id/f/space，没有有效期。 */
const legacy = () => {
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE facts (id INTEGER PRIMARY KEY AUTOINCREMENT, f TEXT NOT NULL UNIQUE, space TEXT NOT NULL DEFAULT 'default')")
  db.prepare('INSERT INTO facts(f, space) VALUES(?, ?)').run('我住在杭州', 'default')
  db.prepare('INSERT INTO facts(f, space) VALUES(?, ?)').run('我是男孩子', 'default')
  return db
}

// ---- 1. 老库迁移：补列、回填、不丢行 ----
{
  const db = legacy()
  assert.equal(ensureFactColumns(db, T0), true)
  const cols = db.prepare('PRAGMA table_info(facts)').all().map((c) => c.name)
  check('补出 valid_from', cols.includes('valid_from'))
  check('补出 valid_until', cols.includes('valid_until'))
  check('冲突表建好了', db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fact_conflicts'").get() !== undefined)
  check('老行一条不丢', Number(db.prepare('SELECT COUNT(*) c FROM facts').get().c) === 2)
  const rows = db.prepare('SELECT f, valid_from, valid_until FROM facts ORDER BY id').all()
  check('老行 valid_from 回填成现在', rows.every((r) => Number(r.valid_from) === T0), JSON.stringify(rows))
  check('老行 valid_until 留空（仍成立）', rows.every((r) => r.valid_until === null))
  // 重跑一次不该把回填时间往后推（不然老事实会一直「刚写下」）
  ensureFactColumns(db, T1)
  check('重跑不重复回填', Number(db.prepare('SELECT valid_from FROM facts ORDER BY id LIMIT 1').get().valid_from) === T0)
}

// ---- 2. 写事实：一致跳过、改口留痕 ----
{
  const db = legacy()
  ensureFactColumns(db, T0)
  const first = recordFact(db, { text: '我叫阿鱼', space: 'default', now: T0 })
  check('新事实写得进去', first.written === true && first.conflict === false)
  const countBefore = Number(db.prepare('SELECT COUNT(*) c FROM facts').get().c)

  const same = recordFact(db, { text: '我叫阿鱼', space: 'default', now: T1 })
  check('完全一致不新增行', same.written === false)
  check('完全一致不写冲突', same.conflict === false)
  check('完全一致后行数不变', Number(db.prepare('SELECT COUNT(*) c FROM facts').get().c) === countBefore)
  check('完全一致后冲突表还是空', recentConflicts(db).length === 0)

  const changed = recordFact(db, { text: '我叫阿猫', space: 'default', now: T2 })
  check('相似但不一致算改口', changed.written === true && changed.conflict === true)
  const oldRow = db.prepare("SELECT valid_until FROM facts WHERE f = '我叫阿鱼'").get()
  check('旧事实被盖上 valid_until', Number(oldRow?.valid_until) === T2, JSON.stringify(oldRow))
  const conflicts = recentConflicts(db)
  check('冲突记录写了一条', conflicts.length === 1)
  check('冲突带新旧文本摘要', conflicts[0].evidence.includes('我叫阿鱼') && conflicts[0].evidence.includes('我叫阿猫'), conflicts[0]?.evidence)
  check('冲突带时间', Number(conflicts[0].created) === T2)

  const active = listFacts(db, { space: 'default', now: T2 + 1 }).map((r) => r.f)
  check('默认只给仍成立的', !active.includes('我叫阿鱼') && active.includes('我叫阿猫'), JSON.stringify(active))
  const all = listFacts(db, { space: 'default', now: T2 + 1, includeExpired: true }).map((r) => r.f)
  check('includeExpired 能取到失效的', all.includes('我叫阿鱼') && all.includes('我叫阿猫'), JSON.stringify(all))
  check('失效只是不参与默认查询，行还在', Number(db.prepare('SELECT COUNT(*) c FROM facts').get().c) === countBefore + 1)
}

// ---- 3. 真链路：记忆卡默认不注失效事实，两个入口不抛错 ----
const dir = mkdtempSync(join(tmpdir(), 'wm-facts-'))
const routes = new Map()
const tools = new Map()
const contexts = new Map()

const effect = (fn) => {
  const dispose = fn()
  return typeof dispose === 'function' ? dispose : () => {}
}
const ctx = {
  on: () => {},
  inject: (deps, cb) => {
    const stub = { effect }
    if (deps.includes('systemPrompt')) {
      stub.systemPrompt = { section: () => {}, context: (c) => { contexts.set(c.name, c); return () => {} } }
    }
    if (deps.includes('llm')) stub.llm = {}
    if (deps.includes('agents')) stub.agents = { list: () => [] }
    if (deps.includes('dshIm')) stub.dshIm = {}
    if (deps.includes('webServer')) stub.webServer = { register: (route) => { routes.set(route.path, route.handler) } }
    if (deps.includes('tools')) stub.tools = { register: (tool) => { tools.set(tool.name, tool) } }
    cb(stub)
  },
  effect,
}
apply(ctx, { memoryPath: dir, preferencePath: join(dir, 'PREFERENCE.md') })

const now = Date.now()
{
  const db = new DatabaseSync(join(dir, 'memory.db'))
  db.prepare('INSERT INTO facts(f, space, valid_from, valid_until) VALUES(?,?,?,?)')
    .run('旧说法已经被改口了', 'default', now - 5000, now - 1000)
  db.prepare('INSERT INTO facts(f, space, valid_from, valid_until) VALUES(?,?,?,?)')
    .run('现在仍然成立的事实', 'default', now - 4000, null)
  db.close()
}

// ---- 3a. 注入：记忆卡只带仍成立的 ----
{
  const card = contexts.get('plugin:dsh-whale-memory:memory')
  assert.ok(card, '要注册记忆卡的 context')
  const text = card.text({ agent: { session: { id: 's-facts-card' } } })
  check('卡片里有仍成立的事实', text.includes('现在仍然成立的事实'))
  check('卡片里没有失效的旧说法', !text.includes('旧说法已经被改口了'))
}

// ---- 3b. memory_recall：includeExpired 能取到 ----
{
  // 这台机器不一定装了 @deepseek-ai/dsh-tools；defineTool 给个直通壳就能验到工具本体。
  const toolDb = new DatabaseSync(join(dir, 'memory.db'))
  const toolCtx = {
    ...ctx,
    inject: (deps, cb) => {
      const stub = { effect }
      if (deps.includes('tools')) stub.tools = { register: (t) => tools.set(t.name, t) }
      cb(stub)
    },
  }
  registerTools(toolCtx, { defineTool: (def) => def, db: toolDb, space: () => 'default' })
  const tool = tools.get('memory_recall')
  assert.ok(tool, '要注册 memory_recall')
  const plain = tool.execute({}, { agent: { session: { id: 's-facts-plain' } } })
  const texts = (plain.facts ?? []).map((f) => f.text)
  check('默认不带失效事实', texts.includes('现在仍然成立的事实') && !texts.includes('旧说法已经被改口了'), JSON.stringify(texts))
  const historic = tool.execute({ includeExpired: true }, { agent: { session: { id: 's-facts-history' } } })
  const allTexts = (historic.facts ?? []).map((f) => f.text)
  const expired = (historic.facts ?? []).find((f) => f.text === '旧说法已经被改口了')
  check('includeExpired 取到失效事实', allTexts.includes('旧说法已经被改口了'), JSON.stringify(allTexts))
  check('失效事实标了 expired', expired?.expired === true)
  toolDb.close()
}

// ---- 3c. /conflicts 路由：只读、不抛、带新旧文本与时间 ----
const call = (path, method = 'GET', query = '') => new Promise((ok) => {
  const handler = routes.get(path)
  assert.ok(handler, `没有注册 ${path}`)
  const res = {
    status: 0,
    writeHead(code) { this.status = code; return this },
    end(body) { ok({ status: this.status, body: body === undefined ? undefined : JSON.parse(body) }) },
  }
  handler({ method, url: path + query }, res)
})
{
  // 造一条真冲突：让写事实的路径自己判出来
  const db = new DatabaseSync(join(dir, 'memory.db'))
  recordFact(db, { text: '我喜欢蓝色', space: 'default', now: now + 10 })
  recordFact(db, { text: '我喜欢绿色', space: 'default', now: now + 20 })
  db.close()

  const empty = await call('/dsh-whale-memory/conflicts', 'GET', '?limit=5')
  check('路由返回 200', empty.status === 200)
  check('路由看到冲突', empty.body.count === 1 && empty.body.items.length === 1, JSON.stringify(empty.body))
  const item = empty.body.items[0]
  check('冲突带新旧文本', item.oldText === '我喜欢蓝色' && item.newText === '我喜欢绿色', JSON.stringify(item))
  check('冲突带日期', /^\d{4}-\d{2}-\d{2}/u.test(String(item.day)))
  check('冲突只读', (await call('/dsh-whale-memory/conflicts', 'POST')).status === 405)
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
