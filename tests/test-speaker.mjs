/**
 * 说话人（`entries.spk`）的回归：写入侧 / 对齐三种分支 / person 同名不冲突。
 *
 * 全部落临时目录，不联网、不碰真实记忆库，也不碰真实群档（自己造一份假的）。
 *
 * 跑法：node tests/test-speaker.mjs
 */
process.env.EMBED_URL = 'http://127.0.0.1:1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  alignSpeaker, ensureSpeakerColumns, normUserText, regexSpeaker, toSpk,
} from '../lib/domain/speaker.mjs'
import { apply } from '../lib/index.mjs'

const LJM = '8F0AA3985B0632ACDFE34F4778F881D1'
const FISH = '1C282365D18006B61447EB7ACB963F60'

/** 造一份假的群档：只建被对齐用到的那张表。 */
const fakeGroupDb = (dir, rows) => {
  const path = join(dir, 'group-history.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE messages (
    sender_id TEXT NOT NULL, text TEXT NOT NULL, sent_at INTEGER NOT NULL)`)
  const ins = db.prepare('INSERT INTO messages(sender_id,text,sent_at) VALUES(?,?,?)')
  for (const [sender, text, at] of rows) ins.run(sender, text, at)
  db.close()
  return path
}

/** 用假 ctx 把插件搭起来（和 test-mood.mjs 一个路子）。 */
const mount = (extra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-speaker-'))
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
      if (deps.includes('webServer')) stub.webServer = { register: () => {} }
      if (deps.includes('tools')) stub.tools = { register: () => {} }
      cb(stub)
    },
    effect,
  }
  apply(ctx, { memoryPath: dir, preferencePath: join(dir, 'PREFERENCE.md'), ...extra })
  return { handlers, dir }
}

/** 走一轮：用户说一句 + 我回一句 + 轮末收尾。 */
const runTurn = (handlers, text, sid = 's1') => {
  const fire = handlers.get('session/event')
  assert.equal(typeof fire, 'function', '要挂 session/event 钩子')
  fire({ id: sid }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  })
  fire({ id: sid }, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '嗯。' }] } },
  })
  fire({ id: sid }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
}

/** 读最近一条条目的 spk：落库是异步的（要等向量那次请求），所以轮询到出现为止。 */
const lastSpk = async (dir) => {
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 100))
    const db = new DatabaseSync(join(dir, 'memory.db'))
    try {
      const row = db.prepare('SELECT spk, u FROM entries ORDER BY id DESC LIMIT 1').get()
      if (row) return row
    } finally { db.close() }
  }
  return { spk: '', u: '' }
}

// ---- A. 纯函数 ----

test('A1 toSpk 只留 8 位大写十六进制，脏值一律空串', () => {
  assert.equal(toSpk(LJM), '8F0AA398')
  assert.equal(toSpk('8f0aa398'), '8F0AA398')
  assert.equal(toSpk('ljm_QvQ'), '')
  assert.equal(toSpk(''), '')
  assert.equal(toSpk(null), '')
})

test('A2 正则：`<@OPENID…>` 前缀与 `"senderId"` 都只取前 8 位', () => {
  assert.equal(regexSpeaker(`<@${FISH}> 你们写了日记没`), '1C282365')
  assert.equal(regexSpeaker(`<dsh_im_source>{"channel":"qq","senderId":"${LJM}"}</dsh_im_source> 在吗`), '8F0AA398')
  assert.equal(regexSpeaker('普通的一句话'), '')
})

test('A3 归一化：注入块与 @ 前缀是信封，不是说的话', () => {
  assert.equal(
    normUserText(`<dsh_im_source>{"senderId":"${LJM}"}</dsh_im_source>\n\n<@${FISH}> 你好呀`),
    '你好呀',
  )
})

test('A4 对齐只会认唯一说话人：歧义与零命中都留空', () => {
  const text = '今天这条鱼有点沉'
  // 唯一
  assert.deepEqual(alignSpeaker([{ sender_id: LJM, text: '今天这条鱼有点沉' }], text).spk, '8F0AA398')
  // 同一个人说了两遍：还是唯一
  assert.deepEqual(
    alignSpeaker([{ sender_id: LJM, text }, { sender_id: LJM, text: text }], text).spk,
    '8F0AA398',
  )
  // 两个人同文：歧义 → 空
  const ambiguous = alignSpeaker([{ sender_id: LJM, text }, { sender_id: FISH, text }], text)
  assert.deepEqual(ambiguous, { spk: '', reason: 'ambiguous' })
  // 对不上：空
  assert.deepEqual(alignSpeaker([{ sender_id: LJM, text: '完全别的一句话呢' }], text), { spk: '', reason: 'none' })
  // 太短不判
  assert.deepEqual(alignSpeaker([{ sender_id: LJM, text: '好' }], '好'), { spk: '', reason: 'short' })
})

// ---- B. 写入侧 ----

test('B1 写入带说话人：群档唯一对齐 → entries.spk 是 8 位', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-speaker-g-'))
  const gdb = fakeGroupDb(dir, [[LJM, '米鱼，把这条记下来', Date.now()]])
  const { handlers, dir: memDir } = mount({ speakerGroupDb: gdb })
  runTurn(handlers, '米鱼，把这条记下来')
  const row = await lastSpk(memDir)
  assert.equal(row.spk, '8F0AA398')
  assert.match(row.u, /把这条记下来/)
})

test('B2 归一对不上就不写：宁可留空，不许猜', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-speaker-m-'))
  const gdb = fakeGroupDb(dir, [[LJM, '完全无关的一句', Date.now()]])
  const { handlers, dir: memDir } = mount({ speakerGroupDb: gdb })
  runTurn(handlers, '这句在群档里没有')
  const row = await lastSpk(memDir)
  assert.equal(row.spk, '')
})

test('B3 歧义（同期两人同文）也不写', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-speaker-a-'))
  const now = Date.now()
  const gdb = fakeGroupDb(dir, [[LJM, '你听见了吗', now], [FISH, '你听见了吗', now + 1000]])
  const { handlers, dir: memDir } = mount({ speakerGroupDb: gdb })
  runTurn(handlers, '你听见了吗')
  const row = await lastSpk(memDir)
  assert.equal(row.spk, '')
})

test('B4 正文自带 `senderId` 时直接认，不用查群档', async () => {
  const { handlers, dir: memDir } = mount({ speakerGroupDb: join(tmpdir(), 'nope.sqlite') })
  runTurn(handlers, `<dsh_im_source>{"senderId":"${FISH}"}</dsh_im_source> 在吗`)
  const row = await lastSpk(memDir)
  assert.equal(row.spk, '1C282365')
})

test('B5 开关关掉：一行都不带说话人（写入行为回到 0.28.17）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-speaker-off-'))
  const gdb = fakeGroupDb(dir, [[LJM, '关掉开关也照样有这句', Date.now()]])
  const { handlers, dir: memDir } = mount({ speakerGroupDb: gdb, speakerEnabled: false })
  runTurn(handlers, '关掉开关也照样有这句')
  const row = await lastSpk(memDir)
  assert.equal(row.spk, '')
})

// ---- C. person ----

test('C1 person 表：名字不设唯一，ARK/梁 两个 spk 同名能共存', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-person-'))
  const db = new DatabaseSync(join(dir, 'memory.db'))
  try {
    db.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, u TEXT NOT NULL, t INTEGER NOT NULL)')
    assert.equal(ensureSpeakerColumns(db), true)
    const ins = db.prepare('INSERT INTO person(spk,space,name,aka,score,updated) VALUES(?,?,?,?,?,?)')
    ins.run('E8721C3C', 'default', 'ARK', '["哎嘿"]', 1, Date.now())
    ins.run('D073B690', 'default', 'ARK', '["梁"]', 1, Date.now())
    const n = db.prepare("SELECT COUNT(*) c FROM person WHERE name='ARK'").get().c
    assert.equal(n, 2)
    // 主键是 (spk, space)：同一 spk 同一空间不能重复
    assert.throws(() => ins.run('E8721C3C', 'default', 'ARK', '[]', 1, Date.now()))
    // 重复执行安全
    assert.equal(ensureSpeakerColumns(db), true)
    // 老库补列后默认值是空串 / NULL
    db.prepare('INSERT INTO entries(u,t) VALUES(?,?)').run('老条目', Date.now())
    const row = db.prepare('SELECT spk, imp FROM entries LIMIT 1').get()
    assert.equal(row.spk, '')
    assert.equal(row.imp, null)
  } finally { db.close() }
})

// ---- D. 老库没迁移（没有 spk 列）：写入要退化成不带 spk，而不是整条丢 ----

test('D1 没有 spk 列时 writer 照样落库（降级，不抛）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-nospk-'))
  const db = new DatabaseSync(join(dir, 'memory.db'))
  try {
    // 只建最小 schema：刻意不带 spk/imp——模拟插件还没跑过 ensureSpeakerColumns。
    db.exec(`CREATE TABLE entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, u TEXT NOT NULL, a TEXT NOT NULL,
      t INTEGER NOT NULL, w REAL NOT NULL DEFAULT 1, emo TEXT NOT NULL DEFAULT '[]',
      vec BLOB, hot INTEGER NOT NULL DEFAULT 1, owner TEXT NOT NULL DEFAULT '',
      space TEXT NOT NULL DEFAULT 'default')`)
    // 写入路径还会抽事实：把 facts 表也建出来，测的才是「缺 spk」这一件事。
    db.exec(`CREATE TABLE facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, f TEXT NOT NULL, space TEXT NOT NULL DEFAULT 'default',
      t INTEGER NOT NULL, valid_from INTEGER NOT NULL DEFAULT 0, valid_until INTEGER)`)
    const { createWriter } = await import('../lib/writer.mjs')
    const writer = createWriter({
      db, bumpStat: () => {}, recentPairs: () => 4, factMax: () => 4,
      space: () => 'default', speakerOf: () => 'deadbeef',
    })
    writer.setUser('这条要落进去')
    writer.setAssistant('好')
    await writer.flush()
    const row = db.prepare('SELECT u, a FROM entries').get()
    assert.equal(row?.u, '这条要落进去', '缺 spk 列不该让整条记忆消失')
    assert.equal(row?.a, '好')
  } finally { db.close() }
})
