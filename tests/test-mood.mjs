/**
 * 情绪记账的回归：纯函数 5 条（从 /tmp/mood-proto 搬来）+ 记账/开关/接口 3 条。
 *
 * 这里只管「记账 + 查询」：不注入、不联网、不碰真实记忆库，全部落临时目录。
 *
 * 跑法：node tests/test-mood.mjs
 */
process.env.EMBED_URL = 'http://127.0.0.1:1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  applyMoodTurn, applyTurn, decay, ensureMoodTable, initState, note, readMood, say, snapshot,
  BASE_MOOD, DIMS,
} from '../lib/mood.mjs'
import { apply } from '../lib/index.mjs'

const T0 = new Date(2026, 10, 5, 14, 0, 0).getTime() // 本地 2026-11-05 14:00

// ---- 纯函数：涨 / 衰减 / 幂等 / 日上限 / 门槛 ----

test('涨：这一轮被夸 + 高兴 → 总值上去、维度记上、并且说一句', () => {
  const before = initState(T0)
  const { state, inject, changed } = applyTurn(before, {
    at: T0 + 60_000,
    userTexts: ['谢谢你，太好了'],
    kind: 'completed',
    hour: 14,
    turnStreak: 1,
  })
  assert.equal(changed, true)
  assert.equal(state.mood, 52)        // raw 12（6 词 + 4 夸 + 2 跑通）/ 3 = 4
  assert.equal(state.dims.happy, 12)
  assert.ok(state.mood > before.mood)
  assert.equal(inject.yes, true)
  assert.equal(inject.why, 'ok')
  assert.match(inject.text, /这会儿/)
  assert.ok(inject.text.length <= 60, `文案要短：${inject.text}`)
})

test('衰减：3 小时后总值走半个半衰期，单维 90 分钟散一半', () => {
  const s = initState(T0)
  s.mood = 90
  s.dims.happy = 100
  decay(s, T0 + 180 * 60_000)
  assert.ok(Math.abs(s.mood - 69) < 0.001, `mood 应到 69，实际 ${s.mood}`)        // 48 + 42*0.5
  assert.ok(Math.abs(s.dims.happy - 25) < 0.001, `happy 应到 25，实际 ${s.dims.happy}`) // 100*0.5^2

  decay(s, T0 + 25 * 3600_000)
  assert.ok(Math.abs(s.mood - BASE_MOOD) < 0.5, `应回到基线 ${BASE_MOOD}，实际 ${s.mood}`)
  assert.ok(DIMS.every((k) => s.dims[k] < 0.5), '四根情绪都该散干净')
})

test('幂等：同一轮说一次，重复渲染不再开口，重复判定不重复记账', () => {
  const before = initState(T0)
  const sig = { at: T0 + 60_000, userTexts: ['谢谢你，太好了'], kind: 'completed', hour: 14 }

  const first = note(before, sig)
  assert.equal(first.changed, true)
  const one = say(first.state, sig.at)
  assert.equal(one.inject.yes, true)

  // 同一个状态再渲一遍（一轮里每一步都会重渲）→ 不再说
  const two = say(one.state, sig.at + 1_000)
  assert.equal(two.inject.yes, false)
  assert.equal(two.inject.why, 'already')
  assert.equal(two.state.updatedAt, one.state.updatedAt)

  // 同一轮再判一次（时间戳没往前走）→ 状态一点都不动
  const three = note(one.state, sig)
  assert.equal(three.changed, false)
  assert.equal(three.why, 'same-turn')
  assert.equal(three.state.mood, one.state.mood)
  assert.equal(snapshot(three.state).mood, 52)
})

test('日上限：说了六次之后只记账，仍然标成处理过', () => {
  const before = initState(T0)
  before.saidAt = Array.from({ length: 6 }, (_, i) => T0 - i * 1000)
  const { state, inject } = applyTurn(before, {
    at: T0 + 60_000, userTexts: ['谢谢你，太好了'], kind: 'completed', hour: 14,
  })
  assert.equal(inject.yes, false)
  assert.equal(inject.why, 'daily-cap')
  assert.equal(state.injectedFor, state.updatedAt)
  assert.ok(state.mood > before.mood)
  assert.ok(snapshot(state).calm <= 100)
})

test('门槛：只有时间点一个信号（深夜）撑不到置信门槛，只记账', () => {
  const before = initState(T0)
  const { inject } = applyTurn(before, { at: T0 + 60_000, userTexts: [], kind: 'completed', hour: 1 })
  assert.equal(inject.yes, false)
  assert.equal(inject.why, 'low-confidence')
})

// ---- 记账：开关 / 幂等 / 接口 ----

/**
 * 用假的 ctx 把插件搭起来，返回事件钩子和端点表。
 *
 * @param {object} extra 配置覆盖
 * @param {Map} routesOut 端点表（可选）
 * @returns {{handlers:Map, routes:Map, dir:string}}
 */
const mount = (extra = {}, routesOut = new Map()) => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-mood-'))
  const handlers = new Map()
  const effect = (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} }
  const ctx = {
    on: (name, fn) => handlers.set(name, fn),
    inject: (deps, cb) => {
      const stub = { effect }
      if (deps.includes('systemPrompt')) stub.systemPrompt = { section: () => {}, context: () => () => {} }
      if (deps.includes('llm')) stub.llm = {}
      if (deps.includes('agents')) stub.agents = { list: () => [] }
      if (deps.includes('dshIm')) stub.dshIm = {}
      if (deps.includes('webServer')) stub.webServer = { register: (route) => { routesOut.set(route.path, route.handler) } }
      if (deps.includes('tools')) stub.tools = { register: () => {} }
      cb(stub)
    },
    effect,
  }
  apply(ctx, { memoryPath: dir, preferencePath: join(dir, 'PREFERENCE.md'), ...extra })
  return { handlers: handlers, routes: routesOut, dir }
}

/** 走一轮：用户说一句 + 轮末收尾。 */
const runTurn = (handlers, sid, text) => {
  const fire = handlers.get('session/event')
  assert.equal(typeof fire, 'function', '要挂 session/event 钩子')
  fire({ id: sid }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  })
  fire({ id: sid }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
}

/** 数 mood_log 有多少行。 */
const countRows = (dir) => {
  const db = new DatabaseSync(join(dir, 'memory.db'))
  try { return db.prepare('SELECT COUNT(*) c FROM mood_log').get().c } finally { db.close() }
}

test('关掉 moodEnabled：整轮跳过，一行都不写', () => {
  const off = mount({ moodEnabled: false })
  runTurn(off.handlers, 's-off', '谢谢你，太好了')
  assert.equal(countRows(off.dir), 0, '关掉之后不记账')

  // 对照：默认（true）就写一笔
  const on = mount()
  runTurn(on.handlers, 's-on', '谢谢你，太好了')
  assert.equal(countRows(on.dir), 1, '默认开着，一轮一笔')
})

test('mood_log 幂等：同一个 at 记两次只落一行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-mood-idem-'))
  const db = new DatabaseSync(join(dir, 'memory.db'))
  // 平时这两张表由 lib/index.mjs 建；这里手搭一个最小库，只放记账要用的两张。
  db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
  ensureMoodTable(db)
  const at = Date.now()
  const signal = { at, userTexts: ['谢谢你，太好了'], kind: 'completed', hour: 14, turnStreak: 1 }
  const first = applyMoodTurn(db, { space: 'default', signal })
  const again = applyMoodTurn(db, { space: 'default', signal })
  assert.equal(first.logged, true, '第一笔记上')
  assert.equal(again.logged, false, '同一个 at 的第二笔被挡住')
  assert.equal(again.why, 'same-turn')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM mood_log').get().c, 1)
  // 状态只留一条，且没被写两遍
  assert.equal(db.prepare("SELECT COUNT(*) c FROM meta WHERE k='mood.state.default'").get().c, 1)
  db.close()
})

/** 调端点，返回 { status, body }。 */
const call = (routes, path, query = '') => new Promise((ok) => {
  const handler = routes.get(path)
  assert.ok(handler, `没有注册 ${path}`)
  const res = {
    status: 0,
    writeHead(code) { this.status = code; return this },
    end(body) { ok({ status: this.status, body: body === undefined ? undefined : JSON.parse(body) }) },
  }
  handler({ method: 'GET', url: path + query }, res)
})

test('GET /mood：空库返回 {days:[],recent:[]}，参数越界截断不报错', async () => {
  const routes = new Map()
  const { dir } = mount({}, routes)
  const empty = await call(routes, '/dsh-whale-memory/mood', '?days=7')
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body, { days: [], recent: [] }, '空库也要是空的这两个键')

  // 越界参数：不抛、不 400
  const weird = await call(routes, '/dsh-whale-memory/mood', '?days=9999&space=')
  assert.equal(weird.status, 200)
  assert.deepEqual(weird.body, { days: [], recent: [] })

  // 塞一笔进去，结构要对
  const db = new DatabaseSync(join(dir, 'memory.db'))
  const at = Date.now()
  applyMoodTurn(db, { space: 'default', signal: { at, userTexts: ['谢谢你，太好了'], kind: 'completed', hour: 14 } })
  db.close()

  const one = await call(routes, '/dsh-whale-memory/mood', '?days=7')
  assert.equal(one.status, 200)
  assert.equal(one.body.days.length, 1)
  const day = one.body.days[0]
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(day.day), `day 要本地日期键：${day.day}`)
  for (const k of ['mood', 'min', 'max', 'count']) assert.equal(typeof day[k], 'number', `缺 ${k}`)
  assert.equal(day.count, 1)
  assert.equal(one.body.recent.length, 1)
  for (const k of ['at', 'mood', 'reason']) assert.ok(k in one.body.recent[0], `明细缺 ${k}`)
  assert.equal(one.body.recent[0].at, at)
  assert.match(one.body.recent[0].reason, /话里有/)
  console.log('OK /mood 结构')
})
