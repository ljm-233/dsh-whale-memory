/**
 * 自检：主动消息的决策逻辑。
 *
 * 重点测「不发」的各种情况——打扰用户比漏发更糟。
 * 运行：node test-selfcheck.mjs
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { addTask, allowsInitiative, completeTask, composeMessage, dayKey, decide, hasFreshEvents, isQuietHours, pickFollowUp, pickOpenTask, shouldSelfWake, shouldSend } from './lib/index.mjs'

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

// ---- 门槛可配置 ----
{
  const noon = at(12)
  const fresh = { lastSentAt: 0, lastUserMessageAt: 0, dailyCount: {} }

  // 免打扰时段能改
  assert.equal(isQuietHours(at(3)), true, '默认 3 点属于免打扰')
  assert.equal(isQuietHours(at(3), { quietStart: 1, quietEnd: 5 }), true)
  assert.equal(isQuietHours(at(12), { quietStart: 1, quietEnd: 5 }), false)
  assert.equal(isQuietHours(at(9), { quietStart: 23, quietEnd: 8 }), false)
  assert.equal(isQuietHours(at(12), { quietStart: 0, quietEnd: 0 }), false, '起止相同表示不启用')

  // 每日上限能改
  const sent2 = { ...fresh, dailyCount: { [dayKey(noon)]: 2 } }
  assert.equal(shouldSend(sent2, noon, { dailyCap: 2 }).reason, 'daily-cap')
  assert.equal(shouldSend(sent2, noon, { dailyCap: 5 }).send, true, '上限调到 5 就该能发')

  // 冷却和沉默时长能改
  const recent = { ...fresh, lastSentAt: noon.getTime() - 2 * 3_600_000 }
  assert.equal(shouldSend(recent, noon, {}).reason, 'cooldown', '默认 6 小时冷却')
  assert.equal(shouldSend(recent, noon, { cooldownMs: 1 * 3_600_000 }).send, true, '冷却改成 1 小时就放行')

  const spoke = { ...fresh, lastUserMessageAt: noon.getTime() - 2 * 3_600_000 }
  assert.equal(shouldSend(spoke, noon, {}).reason, 'user-active')
  assert.equal(shouldSend(spoke, noon, { silenceMs: 1 * 3_600_000 }).send, true, '沉默门槛改成 1 小时就放行')
  console.log('OK 门槛可配置')
}

// ---- 待办：自主唤醒的依据 ----
{
  let tasks = []
  const first = addTask(tasks, '把设置页的日记开关做完', 1000)
  assert.ok(first.task, '应该记下一条')
  assert.equal(first.task.id, 1)
  assert.equal(first.task.status, 'open')
  tasks = first.tasks

  const second = addTask(tasks, '给语料插件补一个按天统计', 2000)
  tasks = second.tasks
  assert.equal(second.task.id, 2)

  assert.equal(addTask(tasks, '   ', 3000).task, null, '空白不记')

  // 挑最前面的那条
  assert.equal(pickOpenTask(tasks, 5000).id, 1)

  // 提醒过之后，12 小时内不再挑它
  tasks = tasks.map((t) => (t.id === 1 ? { ...t, nudgedAt: 5000 } : t))
  assert.equal(pickOpenTask(tasks, 5000 + 3600_000).id, 2, '刚提醒过的先跳过')
  assert.equal(pickOpenTask(tasks, 5000 + 13 * 3600_000).id, 1, '过了 12 小时又能提醒')

  // 做完就不再是待办
  const done = completeTask(tasks, 1, 9000, '已经推上去了')
  assert.equal(done.task.status, 'done')
  assert.equal(done.task.note, '已经推上去了')
  tasks = done.tasks
  assert.equal(pickOpenTask(tasks, 9000).id, 2)
  assert.equal(completeTask(tasks, 999, 9000), null)
  console.log('OK 待办')
}

// ---- decide：有待办就先推进，没动静就休息 ----
{
  const now = at(14)
  const idle = { lastSentAt: 0, lastUserMessageAt: 0, dailyCount: {} }

  const withTask = decide({}, idle, now, {}, { task: { id: 1, text: 'x' }, hasNewEvents: true })
  assert.equal(withTask.send, true)
  assert.equal(withTask.reason, 'pending-work', '有事没做完就优先推进它')

  const nothing = decide({}, idle, now, {}, { task: null, hasNewEvents: false })
  assert.equal(nothing.send, false)
  assert.equal(nothing.reason, 'resting', '既没事也没新动静，就该休息')

  // 有新动静还是可以说一句
  assert.equal(decide({}, idle, now, {}, { task: null, hasNewEvents: true }).send, true)
  // 不确定有没有新动静时，不当作「没有」
  assert.equal(decide({}, idle, now, {}, { task: null, hasNewEvents: null }).send, true)
  // 关掉「自己决定休息」就退回老行为
  assert.equal(decide({}, idle, now, { restWhenIdle: false }, { task: null, hasNewEvents: false }).send, true)
  // 手动触发无视一切
  assert.equal(decide({ force: true }, idle, now, {}, { hasNewEvents: false }).reason, 'forced')
  console.log('OK decide 自主判断')
}

// ---- hasFreshEvents：有没有新动静 ----
{
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'proactive-'))
  const path = join(dir, 'memory.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL)')
  db.prepare('INSERT INTO events(at) VALUES(?)').run(5000)
  db.close()

  assert.equal(hasFreshEvents(4000, path), true, '上次说话之后有新事件')
  assert.equal(hasFreshEvents(5000, path), false, '正好同一时刻不算新的')
  assert.equal(hasFreshEvents(6000, path), false)
  assert.equal(hasFreshEvents(0, '/nonexistent/memory.db'), null, '读不到就说不知道，别当成没有')
  console.log('OK 新动静判断')
}

// ---- 自己醒来干活 ----
{
  const task = { id: 1, text: '把写边界的用例补全', status: 'open' }

  assert.equal(shouldSelfWake({}, task).reason, 'disabled', '默认关着')
  assert.equal(shouldSelfWake({ enabled: false }, task).reason, 'disabled')

  assert.equal(shouldSelfWake({ enabled: true }, task).wake, true)
  assert.equal(shouldSelfWake({ enabled: true }, null).reason, 'no-task', '没正事就别叫自己起来')
  assert.equal(shouldSelfWake({ enabled: true, isQuiet: true }, task).reason, 'quiet-hours', '半夜不叫醒自己写代码')
  assert.equal(shouldSelfWake({ enabled: true, awakeCount: 3 }, task).reason, 'daily-cap', '默认一天三次')
  assert.equal(shouldSelfWake({ enabled: true, awakeCount: 3, dailyCap: 5 }, task).wake, true, '上限可调')
  assert.equal(shouldSelfWake({ enabled: true }, task).task.text, '把写边界的用例补全')
  console.log('OK 自己醒来')
}

// ---- 主动搭话：越过「主人刚说过话」这一条 ----
{
  const now = at(14)
  const active = { lastSentAt: 0, lastUserMessageAt: now.getTime() - 60_000, dailyCount: {}, initiativeCount: {}, lastInitiativeAt: 0 }
  const cfg = (extra = {}) => ({ initiative: { enabled: true, dailyCap: 2, minGapHours: 3 }, ...extra })

  // 没开：还是老样子，主人刚说完就不打扰
  assert.equal(decide({}, active, now, {}, {}).reason, 'user-active')

  // 开了：可以主动搭一句
  const r = decide({}, active, now, cfg(), {})
  assert.equal(r.send, true)
  assert.equal(r.reason, 'initiative', '只有这一条门槛被越过')

  // 但自己的限额照旧
  const used = { ...active, initiativeCount: { [dayKey(now)]: 2 } }
  assert.equal(decide({}, used, now, cfg(), {}).reason, 'user-active', '一天两次用完就老实待着')

  // 间隔也照旧
  const recent = { ...active, lastInitiativeAt: now.getTime() - 30 * 60_000 }
  assert.equal(decide({}, recent, now, cfg(), {}).reason, 'user-active', '半小时内不连搭')

  // 免打扰不被越过
  const quiet = decide({}, active, at(23, 30), cfg(), {})
  assert.equal(quiet.send, false)
  assert.equal(quiet.reason, 'quiet-hours', '免打扰是底线，主动搭话也越不过去')

  assert.equal(allowsInitiative({ initiative: { enabled: false } }, active, now).reason, 'initiative-off')
  assert.equal(allowsInitiative(cfg(), active, now).allow, true)
  console.log('OK 主动搭话')
}

console.log('\n全部通过')
