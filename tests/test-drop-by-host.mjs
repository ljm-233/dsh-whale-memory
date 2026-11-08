/**
 * 定时叫醒 —— 接线冒烟：拿一个假 ctx 把 registerDropBy 跑一遍，证明「接线」这一段是真的通的。
 *
 * 从独立插件 dsh-drop-by 的 tests/smoke-host.mjs 搬过来（2026-11-08 合并时），改了三处：
 *   · 入口 `apply(ctx, config)` → `registerDropBy(ctx, { config, stateFile, defineTool })`；
 *   · `session/event` 不再自己 ctx.on —— 用返回的 `handleSessionEvent`，因为 whale-memory
 *     只有**一个** session/event 监听（测试桩是单监听 map，多挂会互相顶掉）；
 *   · 配置键加 `wake` 前缀；状态文件指到临时目录（`stateFile`）。
 *
 * 验的是这四件（不叫醒真会话、不进真 dsh）：
 *   ① 用 ctx.interval 起定时（不是裸 setInterval）
 *   ② followup 的载荷对：role/content/source.kind = drop-by
 *   ③ 工具 drop_by_at 注册上了，execute 能落盘、能拒绝越界分钟数
 *   ④ 同一分钟内 tick 两次只叫醒一次；别人说话会把待触发的闲置线拉回来
 *
 * 跑法：node tests/test-drop-by-host.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerDropBy } from '../lib/domain/drop-by.mjs'

const dir = mkdtempSync(join(tmpdir(), 'dropby-smoke-'))
const stateFile = join(dir, 'wake', 'state.json')
console.log(`stateFile=${stateFile}`)

let pass = 0
const ok = (label, fn) => { fn(); pass += 1; console.log(`  ✓ ${label}`) }

// ── 假 ctx ────────────────────────────────────────────────────────────────
const intervals = []
const registered = []
const followed = []
const logs = []

const fakeCtx = {
  inject(services, cb) {
    const scope = {}
    for (const key of services) {
      if (key === 'agents') scope.agents = { get: (id) => (id === 'sess-1' ? agent : undefined) }
      if (key === 'tools') scope.tools = { register: (tool) => registered.push(tool) }
      if (key === 'systemPrompt') scope.systemPrompt = { section: () => () => {} }
      // 2026-11-08：定时改成走 inject 拿 timer 服务（真宿主里 ctx.interval 是访问器，
      // 读一下就抛 `cannot get property "timer" without inject`）。这里补上同一个服务。
      if (key === 'timer') scope.timer = { setInterval: (cb, ms) => { intervals.push({ cb, ms }); return () => {} } }
    }
    cb(scope)
  },
  interval(cb, ms) { intervals.push({ cb, ms }); return () => {} },
  logger() { return { info: (m) => logs.push(m), warn: (m) => logs.push(m) } },
}

const agent = {
  status: 'idle',
  session: { id: 'sess-1' },
  followup(msg) { followed.push(msg) },
}

// ── 起 ────────────────────────────────────────────────────────────────────
const { handleSessionEvent: fire } = registerDropBy(fakeCtx, {
  config: {
    wakeEnabled: true, wakeIntervalMinutes: 20, wakeIdleMinutes: 45, wakeMinGapMinutes: 45,
    wakeMaxPerHour: 6, wakeQuietFrom: 0, wakeQuietTo: 0, wakePromptHint: false,
  },
  stateFile,
  defineTool: (spec) => spec,
})

const tick = intervals[0]?.cb

ok('用 timer 服务起定时，默认 20 分钟', () => {
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].ms, 20 * 60_000)
})

ok('返回了 handleSessionEvent（不再自己 ctx.on）', () => assert.equal(typeof fire, 'function'))

// ── 工具 ──────────────────────────────────────────────────────────────────
const tool = registered.find((t) => t.name === 'drop_by_at')
ok('注册了 drop_by_at', () => {
  assert.ok(tool, '没注册上')
  // 2026-11-08：parameters 改成 schemastery 属性表（外层 type:'object' 会让 defineTool 抛
  // 「parameters.type must be a value schema object」），所以这里直接查有没有 minutes 这个键。
  assert.ok(tool.parameters.minutes, 'parameters 里应有 minutes')
  assert.equal(tool.parameters.minutes.type, 'integer')
})

const before = Date.now()
const out = await tool.execute({ minutes: 5, why: '过五分钟再问一句' }, {
  agent: { id: 'sess-1', session: { id: 'sess-1' } },
})

ok('execute 返回「5 分钟后」并写进 state.json', () => {
  const at = Date.parse(out.at)
  assert.ok(Math.abs(at - (before + 5 * 60_000)) < 5_000, `到点时间偏了：${out.at}`)
  const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(raw.nextAt, at)
  assert.equal(raw.nextWhy, '过五分钟再问一句')
  assert.equal(raw.sessionId, 'sess-1')
  assert.match(out.atLocal, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})

ok('minutes 越界直接报错（3 / 300）', async () => {
  await assert.rejects(() => tool.execute({ minutes: 3, why: '' }, { agent: { session: { id: 'sess-1' } } }), /5–240/)
  await assert.rejects(() => tool.execute({ minutes: 300, why: '' }, { agent: { session: { id: 'sess-1' } } }), /5–240/)
})

// ── 闲置 → 叫醒 ───────────────────────────────────────────────────────────
// 状态住在模块内存里，改文件没用；把进程时钟往前拨两小时，
// 下一个 tick 就必然判闲（不改配置、不等真时间）。拨了就一直用这个钟。
const realNow = Date.now
let clock = realNow()
Date.now = () => clock
clock += 120 * 60_000

tick()

ok('闲置够久 → followup 叫醒，载荷是 user 消息 + source.kind=drop-by', () => {
  assert.equal(followed.length, 1)
  const msg = followed[0]
  assert.equal(msg.role, 'user')
  assert.equal(msg.content[0].type, 'text')
  assert.match(msg.content[0].text, /定时器把你叫醒了/)
  assert.match(msg.content[0].text, /不要复述/)
  assert.equal(msg.source.kind, 'drop-by')
  assert.ok(typeof msg.id === 'string' && msg.id.length > 10)
})

ok('叫醒后 lastFiredAt / idle 线都写回了文件', () => {
  const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.ok(raw.lastFiredAt > 0)
  assert.equal(raw.visits, 1)
  assert.equal(raw.fireLog.length, 1)
})

ok('同一分钟内再 tick 一次不会重复叫醒', () => {
  tick()
  assert.equal(followed.length, 1)
})

// ── 别人说话 → 拉回闲置线 + 预约作废 ──────────────────────────────────────
fire({ id: 'sess-1' }, {
  type: 'user/message',
  data: { content: [{ type: 'text', text: '在吗' }], source: { kind: 'user' } },
})

ok('别人说话：otherAt 更新、sessionId 记住', () => {
  const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.ok(Date.now() - raw.otherAt < 5_000)
  assert.equal(raw.sessionId, 'sess-1')
})

ok('自己发的（source.kind=drop-by）不算「别人说话」', () => {
  const rawBefore = JSON.parse(readFileSync(stateFile, 'utf8'))
  const stamp = rawBefore.otherAt
  fire({ id: 'sess-1' }, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '（旁白）' }], source: { kind: 'drop-by', form: 'notice' } },
  })
  const rawAfter = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(rawAfter.otherAt, stamp)
})

ok('工具结果（tool/result）也不动状态', () => {
  const rawBefore = JSON.parse(readFileSync(stateFile, 'utf8'))
  fire({ id: 'sess-1' }, { type: 'tool/result', data: { name: 'bash' } })
  const rawAfter = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(rawAfter.otherAt, rawBefore.otherAt)
  assert.equal(rawAfter.selfAt, rawBefore.selfAt)
})

ok('安静不足 45 分钟 → 不叫醒', () => {
  const n = followed.length
  tick()
  assert.equal(followed.length, n)
})

// ── 没有 defineTool 时整块不注册（跟本插件其它工具同一道闸）─────────────────
{
  const bare = []
  const ctx2 = {
    inject(services, cb) {
      const scope = {}
      for (const key of services) if (key === 'tools') scope.tools = { register: (t) => bare.push(t) }
      cb(scope)
    },
    logger() { return { info: () => {} } },
  }
  const r = registerDropBy(ctx2, { config: { wakePromptHint: false }, stateFile: join(dir, 'x.json') })
  ok('没有 dsh-tools：drop_by_at 用裸对象注册，handleSessionEvent 照旧给', () => {
    assert.ok(bare.length >= 1, 'defineTool 拿不到时退回恒等包装，工具仍然注册')
    assert.equal(bare[0]?.name, 'drop_by_at')
    assert.equal(typeof r.handleSessionEvent, 'function')
  })
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n冒烟通过：${pass} 项`)
