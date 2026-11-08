/**
 * 定时叫醒 —— 自测（离线）：不连 dsh、不叫醒任何会话，只把能离线证明的三件事钉死。
 *
 * 从独立插件 dsh-drop-by 的 tests/selftest.mjs 搬过来（2026-11-08 合并时），
 * 只改了 import 路径：lib/decide.js → lib/domain/drop-by-decide.mjs、
 * lib/state.js → lib/domain/drop-by-state.mjs、buildFrame 从 lib/domain/drop-by.mjs。
 *
 *   a) 预约 5 分钟后，state.json 里写对了（含原子写、目录不存在也能建）
 *   b) 闲置判定生效（够久才醒；刚说过话不算闲；自己说完也算互动）
 *   c) 防抖在生效（同一分钟、每小时 6 次上限、停到整点、预约之后有人说话就作废）
 *
 * 跑法：node tests/test-drop-by.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  normalizeConfig, decide, scheduleAppointment, afterFire, clearAppointment,
  nextHourStart, recentFires, inQuietHours, MINUTE_MS,
} from '../lib/domain/drop-by-decide.mjs'
import { emptyState, loadState, saveState, stateFileFor } from '../lib/domain/drop-by-state.mjs'
import { buildFrame } from '../lib/domain/drop-by.mjs'

const cfg = normalizeConfig({ quietFrom: 0, quietTo: 0 }) // 自测里关掉免打扰，免得按真实钟点飘
const T0 = Date.UTC(2026, 10, 8, 4, 0, 0)                 // 固定一个时刻，别用 Date.now() 漂

let pass = 0
const ok = (label, fn) => {
  fn()
  pass += 1
  console.log(`  ✓ ${label}`)
}

console.log('0) 状态文件跟着记忆库走')
{
  const dir = mkdtempSync(join(tmpdir(), 'dropby-path-'))
  ok('给了记忆库 → <记忆库>/wake/state.json', () => {
    assert.equal(stateFileFor(dir), join(dir, 'wake', 'state.json'))
  })
  ok('不给记忆库 → 退回并进来之前的老位置（integrations/dsh-drop-by）', () => {
    assert.match(stateFileFor(''), /integrations\/dsh-drop-by\/state\.json$/)
  })
  rmSync(dir, { recursive: true, force: true })
}

console.log('a) 预约 5 分钟后：状态写对了')
{
  const dir = mkdtempSync(join(tmpdir(), 'dropby-'))
  const file = join(dir, 'nested', 'state.json')   // 故意用不存在的子目录
  const base = emptyState(T0 - 10 * MINUTE_MS)
  const { state, at } = scheduleAppointment(base, T0, 5, '过五分钟再看看他在干嘛', cfg)

  ok('到点时间 = 现在 + 5 分钟', () => assert.equal(at, T0 + 5 * MINUTE_MS))
  ok('nextAt / nextWhy / nextSetAt 写对', () => {
    assert.equal(state.nextAt, T0 + 5 * MINUTE_MS)
    assert.equal(state.nextWhy, '过五分钟再看看他在干嘛')
    assert.equal(state.nextSetAt, T0)
  })
  ok('原子写落盘并读回来（目录不存在也建得出来）', () => {
    assert.equal(saveState(state, file), true)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(raw.nextAt, T0 + 5 * MINUTE_MS)
    const back = loadState(file, T0)
    assert.equal(back.nextAt, T0 + 5 * MINUTE_MS)
    assert.equal(back.nextWhy, '过五分钟再看看他在干嘛')
  })
  ok('不到点不醒', () => {
    const d = decide(state, T0 + 4 * MINUTE_MS, cfg)
    assert.equal(d.wake, false)
  })
  ok('到点醒，且判定为预约', () => {
    const d = decide(state, T0 + 5 * MINUTE_MS, cfg)
    assert.equal(d.wake, true)
    assert.equal(d.kind, 'appointment')
    assert.equal(d.why, '过五分钟再看看他在干嘛')
  })
  ok('旁白句子里带上预约的理由，且明说不许复述', () => {
    const d = decide(state, T0 + 5 * MINUTE_MS, cfg)
    const frame = buildFrame({ ...d, at: state.nextAt })
    assert.match(frame, /预约/)
    assert.match(frame, /过五分钟再看看他在干嘛/)
    assert.match(frame, /不要复述/)
  })
  ok('超出 5–240 直接报错', () => {
    assert.throws(() => scheduleAppointment(base, T0, 4, '', cfg), /5–240/)
    assert.throws(() => scheduleAppointment(base, T0, 241, '', cfg), /5–240/)
  })
  ok('触发后预约被用掉，不会同一条预约醒两次', () => {
    const after = afterFire(state, T0 + 5 * MINUTE_MS, 'appointment')
    assert.equal(after.nextAt, 0)
    assert.equal(after.lastFiredAt, T0 + 5 * MINUTE_MS)
    const again = decide(after, T0 + 6 * MINUTE_MS, cfg)
    assert.equal(again.wake, false)   // 要么 same-minute 要么 not-idle，反正不会再醒
  })
  rmSync(dir, { recursive: true, force: true })
}

console.log('b) 闲置判定')
{
  const fresh = (over = {}) => ({ ...emptyState(T0 - 300 * MINUTE_MS), ...over })

  ok('安静 50 分钟 > 闲置线 45 → 醒', () => {
    const d = decide(fresh({ otherAt: T0 - 50 * MINUTE_MS }), T0, cfg)
    assert.equal(d.wake, true)
    assert.equal(d.kind, 'idle')
    assert.equal(d.idleMinutes, 50)
  })
  ok('安静 10 分钟 → 不醒', () => {
    const d = decide(fresh({ otherAt: T0 - 10 * MINUTE_MS }), T0, cfg)
    assert.equal(d.wake, false)
    assert.equal(d.reason, 'not-idle')
  })
  ok('「我自己刚说完」也算互动，不立刻再醒', () => {
    const d = decide(fresh({ otherAt: T0 - 90 * MINUTE_MS, selfAt: T0 - 3 * MINUTE_MS }), T0, cfg)
    assert.equal(d.wake, false)
    assert.equal(d.reason, 'not-idle')
  })
  ok('闲置唤醒后把闲置线拉到现在（下个 tick 不会又醒）', () => {
    const st = afterFire(fresh({ otherAt: T0 - 50 * MINUTE_MS }), T0, 'idle')
    assert.equal(st.selfAt, T0)
    assert.equal(decide(st, T0 + 20 * MINUTE_MS, cfg).wake, false)
  })
  ok('刚起来还没任何互动 → 用 startedAt 兜底，不会一上来就醒', () => {
    const d = decide(emptyState(T0), T0 + MINUTE_MS, cfg)
    assert.equal(d.wake, false)
  })
  ok('免打扰时段挡住闲置唤醒（2–8 点）', () => {
    const quiet = normalizeConfig({ quietFrom: 2, quietTo: 8 })
    // 用本地钟点构造，避开时区差异
    const at3am = new Date(2026, 10, 8, 3, 0, 0).getTime()
    const atNoon = new Date(2026, 10, 8, 12, 0, 0).getTime()
    const st = { ...emptyState(at3am - 300 * MINUTE_MS), otherAt: at3am - 50 * MINUTE_MS }
    assert.equal(inQuietHours(at3am, quiet), true)
    assert.equal(decide(st, at3am, quiet).reason, 'quiet-hours')
    assert.equal(decide(st, atNoon, quiet).wake, true)
  })
}

console.log('c) 防抖')
{
  const idleState = (over = {}) => ({
    ...emptyState(T0 - 600 * MINUTE_MS), otherAt: T0 - 120 * MINUTE_MS, ...over,
  })

  ok('同一分钟内不重复触发', () => {
    const d = decide(idleState({ lastFiredAt: T0 - 30_000 }), T0, cfg)
    assert.equal(d.wake, false)
    assert.equal(d.reason, 'same-minute')
  })
  ok('一小时已经醒了 6 次 → 停到下一个整点', () => {
    const log = [1, 2, 3, 4, 5, 6].map((i) => T0 - i * 9 * MINUTE_MS)
    const d = decide(idleState({ fireLog: log, lastFiredAt: T0 - 9 * MINUTE_MS }), T0, cfg)
    assert.equal(d.wake, false)
    assert.equal(d.reason, 'hourly-cap')
    assert.equal(d.pauseUntil, nextHourStart(T0))
  })
  ok('停到整点期间就算预约到点也不醒', () => {
    const paused = idleState({ pausedUntil: nextHourStart(T0), nextAt: T0 - MINUTE_MS, nextSetAt: T0 - 10 * MINUTE_MS })
    const d = decide(paused, T0, cfg)
    assert.equal(d.wake, false)
    assert.equal(d.reason, 'paused')
  })
  ok('过了整点自动恢复', () => {
    const paused = idleState({ pausedUntil: nextHourStart(T0), lastFiredAt: T0 - 40 * MINUTE_MS })
    const d = decide(paused, nextHourStart(T0) + MINUTE_MS, cfg)
    assert.equal(d.wake, true)
    assert.equal(d.kind, 'idle')
  })
  ok('一小时外的旧记录不算数', () => {
    assert.equal(recentFires({ fireLog: [T0 - 61 * MINUTE_MS, T0 - 59 * MINUTE_MS] }, T0).length, 1)
  })
  ok('预约之后有人说话 → 预约作废、不醒', () => {
    const st = idleState({ nextAt: T0 - MINUTE_MS, nextSetAt: T0 - 10 * MINUTE_MS, otherAt: T0 - 2 * MINUTE_MS })
    const d = decide(st, T0, cfg)
    assert.equal(d.wake, false)
    assert.equal(d.reason, 'superseded')
    assert.equal(clearAppointment(st).nextAt, 0)
  })
  ok('两次叫醒之间有最小间隔（醒来没说话也不会连着醒）', () => {
    const st = idleState({ lastFiredAt: T0 - 10 * MINUTE_MS })   // 10 分钟前叫醒过，之后没人说话
    const d = decide(st, T0, cfg)
    assert.equal(d.wake, false)
    assert.equal(d.reason, 'min-gap')
  })
}

console.log(`\n全部通过：${pass} 项`)
