/**
 * dsh-group-corpus —— 工具与端点自检
 *
 * 用假的 ctx 把插件搭起来，检查两件事：
 *   1. `group_history` 工具确实注册了，参数和输出符合约定
 *   2. `/dsh-group-corpus/history` 只读，能按条件翻档
 *
 * `@deepseek-ai/dsh-tools` 只有装了 DSH 的环境里才有；仓库本身没有依赖，
 * 所以拿不到时整个测试跳过。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from './lib/index.mjs'

const dir = mkdtempSync(join(tmpdir(), 'corpus-tool-'))
const routes = new Map()
const tools = new Map()

const effect = (fn) => {
  const dispose = fn()
  return typeof dispose === 'function' ? dispose : () => {}
}
const ctx = {
  on: () => {},
  inject: (deps, cb) => {
    const stub = { effect }
    if (deps.includes('webServer')) {
      stub.webServer = { register: (route) => { routes.set(route.path, route.handler) } }
    }
    if (deps.includes('tools')) {
      stub.tools = { register: (tool) => { tools.set(tool.name, tool) } }
    }
    cb(stub)
  },
  effect,
}

apply(ctx, { corpusPath: dir })

if (!tools.has('group_history')) {
  console.log('SKIP 工具自检（这台机器上找不到 @deepseek-ai/dsh-tools）')
  process.exit(0)
}

// ---- 造数据 ----
const db = new DatabaseSync(join(dir, 'corpus.db'))
const ins = db.prepare('INSERT INTO messages(platform_id,sender_id,sender_name,kind,text,sent_at,ingested_at) VALUES(?,?,?,?,?,?,?)')
const now = Date.now()
const early = now - 3 * 86_400_000
ins.run('p1', 'u1', 'ljm_QvQ', 'human', '第一天，我还没给限制', early, now)
ins.run('p2', 'u2', '辛会', 'human', '怎么又不回答了', early + 60_000, now)
ins.run('p3', 'u3', 'Miyu', 'ai', '已经跑完了', early + 120_000, now)
ins.run('p4', 'u1', 'ljm_QvQ', 'human', '今天聊聊记忆', now, now)
db.close()

const tool = tools.get('group_history')
/** 跑一次工具。 */
const run = (args) => tool.execute(args, {})

// ---- 工具的形状 ----
{
  assert.equal(typeof tool.execute, 'function')
  assert.ok(tool.description.includes('Read the archived QQ group history'), '描述要说清楚这是只读的群档')
  // defineTool 会把参数包成 JSON Schema，所以要从 properties 里看。
  const props = tool.parameters.properties
  for (const key of ['keyword', 'sender', 'kind', 'sinceDays', 'limit', 'order', 'stats']) {
    assert.ok(props[key], `参数应该有 ${key}`)
  }
  assert.deepEqual(props.kind.enum, ['any', 'human', 'ai'])
  assert.equal(tool.output.schema.properties.shown.type, 'number')
  console.log('OK 工具形状')
}

// ---- 工具的返回 ----
{
  const all = await run({})
  assert.equal(all.total, 4)
  assert.equal(all.shown, 4)
  assert.equal(all.messages[0].text, '今天聊聊记忆', '默认新到旧')
  assert.match(all.messages[0].day, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'day 是给人看的本地时间')
  assert.equal(all.messages[0].kind, 'human')

  const kw = await run({ keyword: '回答' })
  assert.equal(kw.total, 1)
  assert.equal(kw.messages[0].sender, '辛会')

  assert.equal((await run({ kind: 'ai' })).total, 1)
  assert.equal((await run({ sender: 'ljm' })).total, 2)
  assert.equal((await run({ sinceDays: 1 })).total, 1)
  assert.equal((await run({ order: 'asc', limit: 1 })).messages[0].text, '第一天，我还没给限制')

  // 概况
  const withStats = await run({ stats: true })
  assert.equal(withStats.stats.total, 4)
  assert.ok(Array.isArray(withStats.stats.byDay))
  assert.ok(withStats.stats.bySender.length >= 3)

  // 渲染成文字
  const rendered = tool.output.render({}, withStats)
  assert.equal(rendered[0].type, 'text')
  assert.ok(rendered[0].text.includes('共 4 条匹配'))
  assert.ok(rendered[0].text.includes('辛会(human): 怎么又不回答了'))
  assert.ok(rendered[0].text.includes('概况：4 条'), '要了 stats 就得把概况写出来')
  assert.ok(rendered[0].text.includes('每天：'), '概况里要有按天的分布')
  assert.ok(rendered[0].text.includes('发言最多的：ljm_QvQ 2'))

  // 空结果也要说人话
  const none = await run({ keyword: '根本没这回事' })
  assert.equal(none.total, 0)
  assert.ok(tool.output.render({}, none)[0].text.includes('没有匹配的消息'))
  console.log('OK 工具返回')
}

// ---- HTTP 端点 ----
const call = (query, method = 'GET') => new Promise((ok) => {
  const handler = routes.get('/dsh-group-corpus/history')
  assert.ok(handler, '没有注册 history 端点')
  const res = {
    status: 0,
    writeHead(code) { this.status = code; return this },
    end(body) { ok({ status: this.status, body: body === undefined ? undefined : JSON.parse(body) }) },
  }
  handler({ method, url: '/dsh-group-corpus/history' + query }, res)
})

{
  const { status, body } = await call('?keyword=回答')
  assert.equal(status, 200)
  assert.equal(body.total, 1)
  assert.match(body.messages[0].day, /^\d{4}-\d{2}-\d{2}/)

  const stats = await call('?stats=1')
  assert.equal(stats.body.stats.total, 4)

  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await call('', method)).status, 405, `${method} 必须被拒绝`)
  }
  console.log('OK 端点只读')
}

console.log('\n全部通过')
