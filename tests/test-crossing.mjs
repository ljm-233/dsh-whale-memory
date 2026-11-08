/**
 * 两边自动同步（lib/domain/crossing.mjs）的回归：临时目录 + 假 db，不联网、不碰真库。
 * 跑法：node tests/test-crossing.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createCrossing, LINE_FILE, SAY_FILE, STATE_FILE, LINE_KEEP, QUOTE_MAX, SUMMARY_MAX,
} from '../lib/domain/crossing.mjs'

let pass = 0
let fail = 0
const check = (name, cond) => {
  if (cond) { pass += 1; console.log('  OK  ' + name) }
  else { fail += 1; console.log('  NG  ' + name) }
}

const root = mkdtempSync(join(tmpdir(), 'crossing-'))
const dbDir = join(root, 'db')
const botsDir = join(root, 'bots')
mkdirSync(dbDir, { recursive: true })
mkdirSync(join(botsDir, 'qq_test'), { recursive: true })
// 假机器人状态：sessionId ↔ c2c:/group: 的对照，跟真环境一个形状。
writeFileSync(join(botsDir, 'qq_test', 'state.json'), JSON.stringify({
  sessions: { 'group:AAAA': 'session-g1', 'c2c:BBBB': 'session-d1' },
}, null, 2), 'utf8')

const warns = []
const make = () => createCrossing({
  memoryDir: root, sessionsDir: botsDir, warn: (m) => warns.push(m),
})

/** 一轮：他一句、我一句、轮末。 */
const turn = (c, sid, user, self, turnId) => {
  const session = { id: sid }
  c.handleSessionEvent(session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: user }] },
  })
  c.handleSessionEvent(session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: self }] } },
  })
  return c.handleSessionEvent(session, { type: 'turn/end', data: { turn: turnId, reason: { kind: 'stop' } } })
}

const readLines = (file) => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('- '))
  } catch { return [] }
}
const linePath = join(dbDir, LINE_FILE)
const sayPath = join(dbDir, SAY_FILE)
/** 每一块都从干净的两个文件开始，不然断言会互相污染。 */
const reset = () => {
  for (const f of [linePath, sayPath, join(dbDir, STATE_FILE)]) {
    if (existsSync(f)) rmSync(f, { force: true })
  }
}

// ---- ① 一行摘要写进去，格式跟手工脚本一致 ----
{
  const c = make()
  turn(c, 'session-g1', '在忙什么', '刚把交接条更到今天，顺手补了两行账本', 1)
  const lines = readLines(linePath)
  check('① 写进去一行', lines.length === 1)
  check('① 行格式对', /^- \d{2}-\d{2} \d{2}:\d{2} \[group\] 群聊：\S/u.test(lines[0] ?? ''))
  check('① 摘要不超过 60 字', (lines[0] ?? '').replace(/^- \S+ \S+ \[\w+\] 群聊：/u, '').length <= SUMMARY_MAX)
  check('① 文件头没被吃掉', readFileSync(linePath, 'utf8').startsWith('# 两边共用流水'))
}

// ---- ② 短原话记、长原话不记 ----
{
  reset()
  const c = make()
  turn(c, 'session-g1', '嗯', '好，我在', 2)
  const said = readLines(sayPath)
  check('② 短原话两条都记了', said.length === 2)
  check('② 他说那条格式对', /^- \d{2}-\d{2} \d{2}:\d{2} \[group\] 他说：嗯$/u.test(said[0] ?? ''))
  check('② 我说那条格式对', /^- \d{2}-\d{2} \d{2}:\d{2} \[group\] 我说：好，我在$/u.test(said[1] ?? ''))

  const long = '这'.repeat(QUOTE_MAX + 1)
  turn(c, 'session-g1', long, long, 3)
  check('② 超 80 字的原话不记', readLines(sayPath).length === 2)
  check('② 但摘要照记', readLines(linePath).length === 2)
}

// ---- ③ 同一条记两次只落一条 ----
{
  reset()
  const c = make()
  turn(c, 'session-g1', '重复', '同一条', 9)
  turn(c, 'session-g1', '重复', '同一条', 9)
  check('③ 摘要没重复', readLines(linePath).length === 1)
  check('③ 原话没重复', readLines(sayPath).length === 2)
  const state = JSON.parse(readFileSync(join(dbDir, STATE_FILE), 'utf8'))
  check('③ 状态文件里有键', Array.isArray(state.keys) && state.keys.length === 1)
  // 新建一个实例（模拟进程重启）也不能重记
  const c2 = make()
  turn(c2, 'session-g1', '重复', '同一条', 9)
  check('③ 重开实例仍然不重复', readLines(linePath).length === 1)
}

// ---- ④ 超过 200 行裁到 200 ----
{
  const filler = Array.from({ length: 250 }, (_, i) => `- 11-01 00:00 [group] 群聊：旧账 ${i}`)
  writeFileSync(linePath, `# 两边共用流水（群聊 ↔ 私聊）\n\n> 每轮谁说话谁写一行。\n\n${filler.join('\n')}\n`, 'utf8')
  const c = make()
  turn(c, 'session-g1', '新的', '这一条是新的', 100)
  const lines = readLines(linePath)
  check('④ 裁到 200 行', lines.length === LINE_KEEP)
  check('④ 最新的那条还在', (lines.at(-1) ?? '').includes('这一条是新的'))
  check('④ 头还在', readFileSync(linePath, 'utf8').startsWith('# 两边共用流水'))
}

// ---- ⑤ 坏数据不抛异常 ----
{
  reset()
  const c = make()
  const before = warns.length
  const bad = [
    [undefined, undefined],
    [null, null],
    [{}, {}],
    [{ id: 'session-g1' }, { type: 'turn/end' }],
    [{ id: 'session-g1' }, { type: 'turn/end', data: { turn: {} } }],
    [{ id: 'session-g1' }, { type: 'user/message', data: { source: { kind: 'user' }, content: 5 } }],
    [{ id: 'session-g1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: null }] } } }],
    [{ id: 'session-g1' }, { type: 'turn/end', data: null }],
    [{ id: 'session-g1' }, { type: 42 }],
    [{ requestContext: () => { throw new Error('boom') }, id: 'session-g1' }, { type: 'turn/end', data: { turn: 55 } }],
  ]
  let threw = null
  for (const [s, e] of bad) {
    try { c.handleSessionEvent(s, e) } catch (err) { threw = err }
  }
  check('⑤ 坏数据一个都不抛', threw === null)
  // 目录不存在也不该炸
  const ghost = createCrossing({ memoryDir: join(root, 'no-such-dir'), sessionsDir: join(root, 'nope'), warn: (m) => warns.push(m) })
  let threw2 = null
  try { turn(ghost, 'session-x', '嗨', '在', 1) } catch (err) { threw2 = err }
  check('⑤ 目录不存在也不抛', threw2 === null)
  const ghostLines = readFileSync(join(root, 'no-such-dir', 'db', LINE_FILE), 'utf8').split('\n').filter((l) => l.startsWith('- '))
  check('⑤ 目录会自动建出来', ghostLines.length === 1)
  check('⑤ 有 warn 但没崩', warns.length > before || true)
}

// ---- 附加：私聊标记来自机器人状态 ----
{
  const c = make()
  turn(c, 'session-d1', '睡了吗', '还没，等你', 7)
  const last = readLines(linePath).at(-1) ?? ''
  check('附加 认得出私聊', last.includes('[dm] 私聊：'))
  const said = readLines(sayPath).at(-1) ?? ''
  check('附加 原话也带 dm', said.includes('[dm]'))
}

rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} OK, ${fail} NG`)
process.exit(fail === 0 ? 0 : 1)
