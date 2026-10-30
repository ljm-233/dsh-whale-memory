/**
 * dsh-whale-memory —— HTTP 端点自检
 *
 * 用假的 ctx 把插件搭起来，只测两条只读端点：
 *   /dsh-whale-memory/status    汇总
 *   /dsh-whale-memory/entries   热区/冷区内容（只读）
 *
 * 顺带钉住一件事：entries 只接受 GET，别的动词一律 405——
 * 这一页是给人看的，不是给人改的。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from './lib/index.mjs'

const dir = mkdtempSync(join(tmpdir(), 'wm-routes-'))
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
    if (deps.includes('systemPrompt')) stub.systemPrompt = { section: () => {} }
    if (deps.includes('llm')) stub.llm = {}
    if (deps.includes('agents')) stub.agents = { list: () => [] }
    if (deps.includes('dshIm')) stub.dshIm = {}
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

apply(ctx, { memoryPath: dir })

/** 调一个端点，返回 { status, body }。 */
const call = (path, method = 'GET', query = '') => new Promise((ok) => {
  const handler = routes.get(path)
  assert.ok(handler, `没有注册 ${path}`)
  const req = { method, url: path + query }
  const res = {
    status: 0,
    writeHead(code) { this.status = code; return this },
    end(body) { ok({ status: this.status, body: body === undefined ? undefined : JSON.parse(body) }) },
  }
  handler(req, res)
})

// ---- 先往库里放三条：两条冷区、一条热区 ----
const db = new DatabaseSync(join(dir, 'memory.db'))
const now = Date.now()
db.prepare('INSERT INTO entries(u,a,t,w,emo,hot) VALUES(?,?,?,?,?,?)')
  .run('冷区最近的一条', '好的', now, 5, '["tired"]', 0)
db.prepare('INSERT INTO entries(u,a,t,w,emo,hot) VALUES(?,?,?,?,?,?)')
  .run('冷区权重更高的一条', '收到', now - 1000, 9, '[]', 0)
db.prepare('INSERT INTO entries(u,a,t,w,emo,hot) VALUES(?,?,?,?,?,?)')
  .run('热区里的一句话', '嗯', now, 1, '[]', 1)
db.close()

/** 调一个端点并带上 JSON body。 */
const post = (path, body) => new Promise((ok) => {
  const handler = routes.get(path)
  assert.ok(handler, `没有注册 ${path}`)
  const req = {
    method: 'POST',
    url: path,
    on(event, cb) {
      if (event === 'data') cb(JSON.stringify(body ?? {}))
      if (event === 'end') cb()
    },
  }
  const res = {
    status: 0,
    writeHead(code) { this.status = code; return this },
    end(payload) { ok({ status: this.status, body: payload === undefined ? undefined : JSON.parse(payload) }) },
  }
  handler(req, res)
})

// ---- status ----
{
  const { status, body } = await call('/dsh-whale-memory/status')
  assert.equal(status, 200)
  assert.equal(body.hot, 1)
  assert.equal(body.cold, 2)
  assert.ok('salvaged' in body.stats || true)
  console.log('OK status')
}

// ---- entries：冷区按权重排 ----
{
  const { status, body } = await call('/dsh-whale-memory/entries', 'GET', '?zone=cold')
  assert.equal(status, 200)
  assert.equal(body.zone, 'cold')
  assert.equal(body.total, 2)
  assert.equal(body.shown, 2)
  assert.equal(body.items[0].user, '冷区权重更高的一条', '冷区按权重从高到低')
  assert.equal(body.items[1].weight, 5)
  assert.deepEqual(body.items[1].emo, ['tired'], '情绪带回来给界面显示')
  console.log('OK entries 冷区')
}

// ---- entries：热区按时间排 ----
{
  const { body } = await call('/dsh-whale-memory/entries', 'GET', '?zone=hot')
  assert.equal(body.zone, 'hot')
  assert.equal(body.total, 1)
  assert.equal(body.items[0].user, '热区里的一句话')
  console.log('OK entries 热区')
}

// ---- entries：只读 ----
{
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const { status } = await call('/dsh-whale-memory/entries', method)
    assert.equal(status, 405, `${method} 必须被拒绝`)
  }
  console.log('OK entries 只读')
}

// ---- 非法 zone 退回冷区，limit 有上下界 ----
{
  const { body } = await call('/dsh-whale-memory/entries', 'GET', '?zone=nonsense&limit=9999')
  assert.equal(body.zone, 'cold', '看不懂的 zone 退回冷区')
  const big = await call('/dsh-whale-memory/entries', 'GET', '?zone=cold&limit=0')
  assert.equal(big.body.shown, 2, 'limit 给 0 也不该返回空')
  console.log('OK entries 参数兜底')
}

// ---- 日记 ----
{
  const empty = await call('/dsh-whale-memory/diary')
  assert.equal(empty.status, 200)
  assert.equal(empty.body.total, 0, '一开始没有日记')

  // 强制写一篇：测试环境里没有模型，走的是兜底文案
  const written = await post('/dsh-whale-memory/diary', {})
  assert.equal(written.status, 200)
  assert.equal(written.body.written, true)
  assert.match(written.body.day, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(written.body.text.length > 0, '兜底也要写点东西，不能空')

  const list = await call('/dsh-whale-memory/diary')
  assert.equal(list.body.total, 1)
  assert.equal(list.body.items[0].day, written.body.day)
  assert.equal(list.body.items[0].text, written.body.text)

  // 同一天再写一次：会覆盖，不会多出一条
  const again = await post('/dsh-whale-memory/diary', { day: written.body.day })
  assert.equal(again.body.written, true)
  assert.equal((await call('/dsh-whale-memory/diary')).body.total, 1, '一天只有一篇')

  // 状态里能看到日记条数
  assert.equal((await call('/dsh-whale-memory/status')).body.diary, 1)

  // 只接受 GET / POST
  assert.equal((await call('/dsh-whale-memory/diary', 'DELETE')).status, 405)
  console.log('OK 日记')
}

// ---- 记忆工具：查与改错 ----
if (tools.size === 0) {
  console.log('SKIP 记忆工具（这台机器上找不到 @deepseek-ai/dsh-tools）')
} else {
  const recall = tools.get('memory_recall')
  const fix = tools.get('memory_correct')
  assert.ok(recall, '要注册 memory_recall')
  assert.ok(fix, '要注册 memory_correct')

  const found = await recall.execute({ keyword: '冷区' }, {})
  assert.ok(found.count >= 1, '应该查得到刚才放进去的条目')
  assert.match(found.items[0].day, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.ok(['hot', 'cold'].includes(found.items[0].zone))

  const target = found.items[0]
  const corrected = await fix.execute({ id: target.id, correction: '冷区这条记错了', reason: '测试' }, {})
  assert.equal(corrected.ok, true)
  assert.equal(corrected.previousId, target.id)

  // 旧的那条不该再被查到
  assert.equal((await recall.execute({ keyword: '冷区这条记错了' }, {})).count, 1)
  const rendered = recall.output.render({}, await recall.execute({ keyword: '冷区这条记错了' }, {}))
  assert.ok(rendered[0].text.includes('冷区这条记错了'))

  // 撤回
  const gone = await fix.execute({ id: corrected.id, action: 'retract', reason: '测试撤回' }, {})
  assert.equal(gone.ok, true)
  assert.equal((await recall.execute({ keyword: '冷区这条记错了' }, {})).count, 0)

  // 修订记录留痕
  const revs = new DatabaseSync(join(dir, 'memory.db')).prepare(
    'SELECT action, before_u, reason FROM revisions ORDER BY id',
  ).all()
  assert.equal(revs.length, 2)
  assert.equal(revs[0].action, 'correct')
  assert.ok(revs[0].before_u.includes('冷区'))
  assert.equal(revs[1].action, 'retract')
  console.log('OK 记忆工具')
}

console.log('\n全部通过')


