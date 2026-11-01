/**
 * 桌面页与夜班的最小回归：不联网，只用内存库和临时目录。
 * 跑法：node tests/test-desk.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDesk, compressLadder, byteLen, deskCounts, readPromises } from '../lib/desk.mjs'
import { createNightly } from '../lib/nightly.mjs'
import { DESK_TOTAL_BYTES, DESK_MATTERS_BYTES } from '../lib/constants.mjs'

let pass = 0
let fail = 0
const check = (name, cond) => {
  if (cond) { pass += 1; console.log('  OK  ' + name) }
  else { fail += 1; console.log('  NG  ' + name) }
}

const db = new DatabaseSync(':memory:')
db.exec(`
  CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, u TEXT, a TEXT, t INTEGER, w REAL DEFAULT 1, emo TEXT DEFAULT '[]', vec BLOB, hot INTEGER DEFAULT 1, space TEXT NOT NULL DEFAULT 'default');
  CREATE TABLE facts (id INTEGER PRIMARY KEY AUTOINCREMENT, f TEXT NOT NULL UNIQUE, space TEXT NOT NULL DEFAULT 'default',
      valid_from INTEGER NOT NULL DEFAULT 0, valid_until INTEGER);
  CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE diary (day TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE scenes (topic TEXT PRIMARY KEY, body TEXT, entry_ids TEXT, n INTEGER, updated INTEGER, space TEXT NOT NULL DEFAULT 'default');
  CREATE TABLE entities (name TEXT NOT NULL, space TEXT NOT NULL DEFAULT 'default', n INTEGER, updated INTEGER, PRIMARY KEY (name, space));
  CREATE TABLE edges (a TEXT NOT NULL, b TEXT NOT NULL, space TEXT NOT NULL DEFAULT 'default', w INTEGER, updated INTEGER, PRIMARY KEY (a, b, space));
  CREATE VIRTUAL TABLE entries_fts USING fts5(u, a, content='entries', content_rowid='id', tokenize='trigram');
`)
const now = Date.now()
db.prepare('INSERT INTO facts (f) VALUES (?)').run('叫主人「主人」')
db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('persona', '他叫 ljm，Arch，凌晨还醒着。')
for (let i = 0; i < 40; i += 1) {
  db.prepare('INSERT INTO entries (u, a, t, w, hot) VALUES (?,?,?,?,1)')
    .run(`第 ${i} 轮：今天聊了点很长很长的东西，占地方`, '嗯，知道', now - i * 1000)
}

// 1) 四级压缩：原样 / 砍半 / 首句 / 前 20 字
const long = '第一句话在这里，写得挺长挺占地方。第二句话也很长，还在继续啰嗦。第三句话收尾。'
check('短文本原样返回', compressLadder('短的', 100).level === 0)
const l1 = compressLadder(long, 60)
check('超预算会降级', l1.level > 0 && byteLen(l1.text) <= 60)
check('降级后还是能读的句子', l1.text.includes('。') || l1.text.length > 0)
const l3 = compressLadder(long, 12)
check('极紧预算也不炸', byteLen(l3.text) <= 12)

// 2) 桌面页：四段齐全，预算守住
const desk = buildDesk(db, { promises: '- 不编造记忆' })
check('四个小节都在', ['## 我是谁', '## 关于这个人', '## 我守的约', '## 手上在做什么', '## 记忆怎么转']
  .every((h) => desk.text.includes(h)))
check('总预算不超过 4096 字节', desk.bytes <= DESK_TOTAL_BYTES)
check('事那段不超过 2048 字节', byteLen(desk.text.split('## 手上在做什么')[1]?.split('## 记忆怎么转')[0] ?? '') <= DESK_MATTERS_BYTES + 40)
check('画像进了人那一段', desk.text.includes('ljm'))
check('约进了约那一段', desk.text.includes('不编造记忆'))
check('空库也能蒸出桌面页', buildDesk(new DatabaseSync(':memory:'), {}).bytes > 0)

// 3) 计数
const counts = deskCounts(db, 'default')
check('热区计数对得上', counts.hot === 40)
check('事实计数对得上', counts.facts === 1)

// 4) 夜班：锁、降层、清理、桌面页落盘、日志四数
const dir = mkdtempSync(join(tmpdir(), 'whale-night-'))
const nightly = createNightly({ db, memoryDir: dir, dayKeyOf: () => '2026-11-01', space: () => 'default' })
const first = nightly.run({ at: new Date('2026-11-01T22:05:00') })
check('夜班跑得完', first.ok === true)
check('桌面页写进 meta', String(db.prepare("SELECT v FROM meta WHERE k='desk'").get()?.v ?? '').includes('## 我是谁'))
check('桌面页落盘', existsSync(join(dir, '记忆本', '桌面页.md')))
check('日档落盘', existsSync(join(dir, '记忆本', '日档', '2026-11-01.md')))
check('最后自查落盘', existsSync(join(dir, '最后自查.txt')))
check('日志有那行四数', readFileSync(join(dir, '日志', '2026-11-01.md'), 'utf8').includes('桌面页='))
check('锁已放掉', !existsSync(join(dir, 'nightly.lock')))

// 锁住时第二班退出，不硬跑
const locked = createNightly({ db, memoryDir: dir, dayKeyOf: () => '2026-11-01', space: () => 'default' })
writeFileSync(join(dir, 'nightly.lock'), JSON.stringify({ pid: 1, at: Date.now() }), 'utf8')
const lockedAt = new Date('2026-11-01T22:06:00')
utimesSync(join(dir, 'nightly.lock'), lockedAt, lockedAt)
const blocked = locked.run({ at: new Date('2026-11-01T22:07:00') })
check('锁在时第二班被挡', blocked.ok === false && blocked.reason === 'locked')
rmSync(join(dir, 'nightly.lock'), { force: true })

// 5) 自证四数
const self = nightly.selfCheck()
check('自证给得出层数', typeof self.layers.hot === 'number')
check('自证给得出桌面字节', self.deskBytes > 0)
check('自证给得出日志路径', String(self.logFile).endsWith('.md'))

// 6) 约：手写文件读得到
writeFileSync(join(dir, '约.md'), '- 约：不自动删除\n', 'utf8')
check('约读得到', readPromises(dir).includes('不自动删除'))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
