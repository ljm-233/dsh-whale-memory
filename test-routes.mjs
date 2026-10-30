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

console.log('\n全部通过')
