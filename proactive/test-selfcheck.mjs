/**
 * 自检：主动消息的决策逻辑。
 *
 * 重点测「不发」的各种情况——打扰用户比漏发更糟。
 * 运行：node test-selfcheck.mjs
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { composeMessage, dayKey, decide, isQuietHours, pickFollowUp, shouldSend } from './lib/index.mjs'

/** 造一个固定的时间点，避免测试依赖当前时刻。 */
const at = (h, m = 0) => new Date(2026, 9, 30, h, m, 0)

const baseState = { lastSentAt: 0, lastUserMessageAt: 0, dailyCount: {} }

// ---- isQuietHours：夜间不发 ----
{
  assert.ok(isQuietHours(at(23, 30)), '23:30 应静默')
  assert.ok(isQuietHours(at(2)), '凌晨 2 点应静默')
  assert.ok(isQuietHours(at(7, 59)), '7:59 应静默')
  assert.ok(!isQuietHours(at(8)), '8:00 应可发')
  assert.ok(!isQuietHours(at(14)), '下午应可发')
  assert.ok(!isQuietHours(at(22, 30)), '22:30 应可发')
  console.log('OK isQuietHours')
}

// ---- shouldSend：该发的情形 ----
{
  // 从未聊过、白天、无记录 → 发
  const r = shouldSend(baseState, at(14))
  assert.equal(r.send, true, `白天空闲应发，实际 ${r.reason}`)

  // 用户沉默超过阈值 → 发
  const now = at(14)
  const stale = { ...baseState, lastUserMessageAt: now.getTime() - 10 * 3600 * 1000 }
  const r2 = shouldSend(stale, now)
  assert.equal(r2.send, true, '沉默 10 小时应发')
  assert.equal(r2.kind, 'silence')
  console.log('OK 该发')
}

// ---- shouldSend：不该发的各种情况 ----
{
  const now = at(14)

  // 静默时段
  const rQuiet = shouldSend(baseState, at(23, 30))
  assert.equal(rQuiet.send, false)
  assert.equal(rQuiet.reason, 'quiet-hours')

  // 冷却期内
  const cooling = { ...baseState, lastSentAt: now.getTime() - 3600 * 1000 }
  const rCool = shouldSend(cooling, now)
  assert.equal(rCool.send, false, '冷却期内不该发')
  assert.equal(rCool.reason, 'cooldown')

  // 用户刚说话
  const active = { ...baseState, lastUserMessageAt: now.getTime() - 60 * 1000 }
  const rActive = shouldSend(active, now)
  assert.equal(rActive.send, false, '用户正在活跃不该发')
  assert.equal(rActive.reason, 'user-active')

  // 今日配额用完
  const full = { ...baseState, dailyCount: { [dayKey(now)]: 2 } }
  const rFull = shouldSend(full, now)
  assert.equal(rFull.send, false, '配额用完不该发')
  assert.equal(rFull.reason, 'daily-cap')
  console.log('OK 不该发')
}

// ---- 优先级：静默时段高于一切 ----
{
  // 即使用户沉默很久，夜里也不发
  const now = at(23, 30)
  const stale = { ...baseState, lastUserMessageAt: now.getTime() - 20 * 3600 * 1000 }
  const r = shouldSend(stale, now)
  assert.equal(r.send, false)
  assert.equal(r.reason, 'quiet-hours', '夜间优先级最高')
  console.log('OK 优先级')
}

// ---- dayKey ----
{
  assert.equal(dayKey(at(14)), '2026-10-30')
  assert.equal(dayKey(at(0, 5)), '2026-10-30')
  console.log('OK dayKey')
}

// ---- composeMessage：不空、不超长 ----
{
  for (const kind of ['silence', 'greeting']) {
    const t = composeMessage(kind)
    assert.ok(t.length > 0, `${kind} 不该为空`)
    assert.ok(t.length < 40, `${kind} 应短，实际 ${t.length} 字`)
  }

  // followUp 带记忆时，应引用记忆内容
  const m = composeMessage('followUp', { u: '上次说的那个咖啡店' })
  assert.ok(m.includes('咖啡店'), `应引用记忆，实际: ${m}`)

  // 记忆内容太短时，退回通用问候
  const m2 = composeMessage('followUp', { u: '嗯' })
  assert.ok(m2.length > 0, '应退回通用问候')
  console.log('OK composeMessage')
}

// ---- decide：手动触发跳过全部门槛 ----
{
  const now = at(14)
  const active = { ...baseState, lastUserMessageAt: now.getTime() - 60_000 }
  assert.equal(shouldSend(active, now).send, false, '正常判断下主人刚说过话，不发')

  const forced = decide({ force: true }, active, now)
  assert.equal(forced.send, true, '手动触发应该无视「主人活跃」')
  assert.equal(forced.reason, 'forced')

  // 夜间也一样能手动发——这是人自己的选择，不是定时器的自作主张
  const quiet = decide({ force: true }, baseState, at(23, 30))
  assert.equal(quiet.send, true, '手动触发应该无视静默时段')

  // 没给 force 就走正常判断
  assert.equal(decide({}, active, now).send, false)
  assert.equal(decide(undefined, baseState, now).send, true)
  console.log('OK decide')
}

// ---- pickFollowUp：派生条目不能当素材 ----
{
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY, u TEXT, a TEXT, w REAL, t INTEGER, hot INTEGER)')
  const now = Date.now()
  const ins = db.prepare('INSERT INTO entries(u,a,w,t,hot) VALUES(?,?,?,?,0)')
  ins.run('（归档）用户反复重启服务，调试群聊语料插…', '大意', 9, now)
  ins.run('（规律）用户习惯用极简指令推进工作', '规律', 9, now)
  ins.run('（联想）这两件事好像有点关系', '联想', 9, now)
  ins.run('明天要不要把那台机器重装一遍', '先别', 5, now)

  const picked = pickFollowUp(db)
  assert.ok(picked, '应该挑到一条')
  assert.equal(picked.u, '明天要不要把那台机器重装一遍', '派生条目（归档/规律/联想）都要跳过')

  // 只剩派生条目时，宁可返回 null，也不能拼出一句不通的话
  const onlyDerived = new DatabaseSync(':memory:')
  onlyDerived.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY, u TEXT, a TEXT, w REAL, t INTEGER, hot INTEGER)')
  onlyDerived.prepare('INSERT INTO entries(u,a,w,t,hot) VALUES(?,?,?,?,0)')
    .run('（归档）用户反复重启服务…', '大意', 9, now)
  assert.equal(pickFollowUp(onlyDerived), null)
  console.log('OK pickFollowUp')
}

console.log('\n全部通过')
