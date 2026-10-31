/**
 * 召回注入主路径的回归：不联网、不碰真实记忆库。
 *
 * 覆盖：事实/热区/日记进上下文、主动联想块、同会话去重、
 * 以及「自己醒来」那条分支。向量服务故意指向死端口，验证降级路径。
 *
 * 跑法：node tests/test-recall.mjs
 */
process.env.EMBED_URL = 'http://127.0.0.1:1'

const { DatabaseSync } = await import('node:sqlite')
const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { createRecall } = await import('../lib/recall.mjs')

let pass = 0
let fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  OK  ' + name) }
  else { fail += 1; console.log('  NG  ' + name + (extra ? ` — ${extra}` : '')) }
}

const dir = mkdtempSync(join(tmpdir(), 'whale-recall-'))
const db = new DatabaseSync(':memory:')
db.exec(`
  CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, u TEXT, a TEXT, t INTEGER, w REAL DEFAULT 1, emo TEXT DEFAULT '[]', vec BLOB, hot INTEGER DEFAULT 1, space TEXT DEFAULT 'default');
  CREATE TABLE facts (id INTEGER PRIMARY KEY AUTOINCREMENT, f TEXT, space TEXT DEFAULT 'default');
  CREATE TABLE diary (day TEXT PRIMARY KEY, text TEXT, created_at INTEGER);
  CREATE TABLE scenes (topic TEXT PRIMARY KEY, body TEXT, entry_ids TEXT, n INTEGER, updated INTEGER, space TEXT DEFAULT 'default');
  CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE recall_seen (session TEXT NOT NULL, entry_id INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (session, entry_id));
  CREATE TABLE stats (k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0);
`)

const now = Date.now()
db.prepare('INSERT INTO facts (f) VALUES (?)').run('主人的名字是 ljm')
db.prepare('INSERT INTO entries (u,a,t,w,emo,vec,hot) VALUES (?,?,?,?,?,?,1)').run('最近在调插件', '嗯', now - 1000, 1, '[]', null)
db.prepare('INSERT INTO entries (u,a,t,w,emo,vec,hot) VALUES (?,?,?,?,?,?,0)').run('今天好累，加班到现在', '早点睡', now - 86400000, 1, '["tired"]', null)
db.prepare('INSERT INTO diary (day,text,created_at) VALUES (?,?,?)').run('2026-10-30', '今天把插件修好了', now)

const deps = {
  db,
  memoryDir: dir,
  bumpStat: () => {},
  space: () => 'default',
  budgetChars: () => 3000,
  factMax: () => 8,
  recentPairs: () => 4,
  recallMax: () => 3,
  recallThreshold: () => 0,
  weightMax: () => 12,
}
const { build } = createRecall(deps)
const userMessage = (text) => ({
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
})

const first = await build({ agent: { session: { id: 'session-test-1' } }, messages: [userMessage('今天好累啊，又加班')] })
check('有注入结果', first !== null && typeof first.text === 'string')
check('事实进上下文', first?.text.includes('主人的名字是 ljm'))
check('热区进上下文', first?.text.includes('最近在调插件'))
check('日记进上下文', first?.text.includes('今天把插件修好了'))
check('情绪触发主动联想', first?.text.includes('主动想起的相关旧事'), first?.text.slice(0, 80))

// 同一会话第二次：那条旧记忆已经给过，不该再注入
const second = await build({ agent: { session: { id: 'session-test-1' } }, messages: [userMessage('今天好累啊，又加班')] })
check('同会话去重生效', second === null || !second.text.includes('加班到现在'))

// 另一个会话还能拿到
const other = await build({ agent: { session: { id: 'session-test-2' } }, messages: [userMessage('今天好累啊，又加班')] })
check('换会话重新可见', other !== null && other.text.includes('加班到现在'))

// 自己醒来的分支：没有入站消息
const selfWake = await build({ agent: { session: { id: 'session-test-3' } }, messages: [] })
check('自唤醒走另一条提示', selfWake !== null && selfWake.text.includes('你自己醒的'), selfWake?.text.slice(0, 60))

// 没有可注入内容时返回 null
const emptyDb = new DatabaseSync(':memory:')
emptyDb.exec(`
  CREATE TABLE entries (id INTEGER PRIMARY KEY, u TEXT, a TEXT, t INTEGER, w REAL, emo TEXT, vec BLOB, hot INTEGER, space TEXT);
  CREATE TABLE facts (id INTEGER PRIMARY KEY, f TEXT, space TEXT DEFAULT 'default');
  CREATE TABLE diary (day TEXT PRIMARY KEY, text TEXT, created_at INTEGER);
  CREATE TABLE scenes (topic TEXT PRIMARY KEY, body TEXT, entry_ids TEXT, n INTEGER, updated INTEGER, space TEXT DEFAULT 'default');
  CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE recall_seen (session TEXT, entry_id INTEGER, at INTEGER, PRIMARY KEY (session, entry_id));
  CREATE TABLE stats (k TEXT PRIMARY KEY, v INTEGER);
`)
const emptyBuild = createRecall({ ...deps, db: emptyDb }).build
const empty = await emptyBuild({ agent: { session: { id: 's' } }, messages: [userMessage('你好')] })
check('没内容时返回 null', empty === null)

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail > 0) process.exit(1)
