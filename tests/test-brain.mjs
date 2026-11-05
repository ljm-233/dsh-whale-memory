/**
 * 大脑三件（第一版）的回归：取舍层影子 / 工作记忆 / 反思。
 *
 * 三块都只碰临时目录和 `:memory:` 库，不联网、不碰真实记忆库。
 *
 * 跑法：node tests/test-brain.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureAdmitTable, judge, record, RULES } from '../lib/admission.mjs'
import { ensureTaskTable, parseOpen, stackTop, syncFromNext, taskLine } from '../lib/tasks.mjs'
import { ensureReflectionTable, propose, revert, backupBeforeWrite, ALLOWED_FILE } from '../lib/reflect.mjs'

const db0 = () => new DatabaseSync(':memory:')

// ---- A. 取舍层：三档决策 + reason 能读 ----

test('A1 三档各一条：事实+长度→keep，承诺→log-only，打招呼→drop', () => {
  const keep = judge('我叫林，我在做一个记忆插件，喜欢按天整理旧事')
  const logOnly = judge('记得明天把补丁重打一遍')
  const drop = judge('哈哈')
  assert.equal(keep.decision, 'keep')
  assert.equal(logOnly.decision, 'log-only')
  assert.equal(drop.decision, 'drop')
  // reason 里必须写清命中哪几条规则、原值多少——只存 kind 的账一周后就说不清了
  assert.match(keep.reason, /fact\+3/)
  assert.match(keep.reason, /long\+2/)
  assert.match(keep.reason, /score=5 -> keep/)
  assert.match(logOnly.reason, /promise-todo\+1/)
  assert.match(drop.reason, /greet-only-4/)
  for (const r of [keep, logOnly, drop]) assert.match(r.reason, /^[\w,+-]+ \| len=\d+ dup=[\d.]+ score=-?\d+ -> (keep|log-only|drop)$/u)
})

test('A2 重复度高：分够了也压成 log-only，不记第二遍', () => {
  const hot = ['我这边今天真的很难过，心里堵得慌，一直坐着没动']
  const v = judge('我这边今天真的很难过，心里堵得慌，一直坐着没动', { recent: hot })
  assert.ok(v.dup >= 0.6, `重复度要判出来：${v.dup}`)
  assert.equal(v.decision, 'log-only')
  assert.match(v.reason, /dup-high-3/)
})

test('A3 一次性信息：验证码这类直接 drop（含事实词也不改判）', () => {
  const v = judge('我在登录，验证码是 483920，五分钟内有效')
  assert.equal(v.decision, 'drop')
  assert.match(v.reason, /one-shot-4/)
})

test('A4 影子模式：三行账、applied 全 0、subject 是内容指纹', () => {
  const db = db0()
  ensureAdmitTable(db)
  const inputs = ['我叫林，我在做一个记忆插件，喜欢按天整理旧事', '记得明天把补丁重打一遍', '哈哈']
  for (const t of inputs) record(db, { at: 1_760_000_000_000, text: t, shadow: true })
  const rows = db.prepare('SELECT decision, reason, applied, subject, kind FROM admit ORDER BY id').all()
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((r) => r.decision), ['keep', 'log-only', 'drop'])
  assert.deepEqual(rows.map((r) => r.applied), [0, 0, 0])
  assert.deepEqual(rows.map((r) => r.kind), ['turn', 'turn', 'turn'])
  for (const r of rows) {
    assert.match(r.subject, /^[0-9a-f]{8}$/)
    assert.ok(r.reason.length > 10 && r.reason.length <= 200, `reason 要能读：${r.reason}`)
  }
  // 关掉影子：applied 才写 1，且写入路径该拦的那条能被识别
  const live = record(db, { text: '哈哈', shadow: false })
  assert.equal(live.applied, 1)
  assert.equal(live.decision, 'drop')
})

test('A5 判据表里的每条规则都有名字和理由（不许有匿名规则）', () => {
  for (const r of RULES) {
    assert.ok(/^[a-z-]+$/u.test(r.id), `规则名要能写进 reason：${r.id}`)
    assert.equal(typeof r.test, 'function')
    assert.ok(r.why.length > 0)
  }
})

// ---- B. 工作记忆：单向同步 + 栈顶三条 + 空栈不注入 ----

const writeNext = (dir, body) => {
  const p = join(dir, 'NEXT.md')
  writeFileSync(p, body, 'utf8')
  return p
}

test('B1 同步幂等：跑两次，第二次插入 0 条', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-task-'))
  const nextPath = writeNext(dir, [
    '# 下一步清单',
    '',
    '- [x] 已经做完的',
    '- [ ] 把 ARK 的话带给鲸鱼姬',
    '- [ ] 给雾屋加「看路」',
    '- [ ] 写一份诊断',
  ].join('\n'))
  const db = db0()
  ensureTaskTable(db)
  const r1 = syncFromNext(db, { nextPath, now: 1000 })
  assert.deepEqual([r1.inserted, r1.revived, r1.closed, r1.total], [3, 0, 0, 3])
  const r2 = syncFromNext(db, { nextPath, now: 2000 })
  assert.deepEqual([r2.inserted, r2.revived, r2.closed], [0, 0, 0])
  assert.equal(db.prepare('SELECT COUNT(*) c FROM task').get().c, 3)
  // 勾掉一条再同步：只把它收成 done，其余不动
  writeNext(dir, ['- [ ] 把 ARK 的话带给鲸鱼姬', '- [ ] 给雾屋加「看路」'].join('\n'))
  const r3 = syncFromNext(db, { nextPath, now: 3000 })
  assert.deepEqual([r3.inserted, r3.closed], [0, 1])
})

test('B2 栈顶三条：doing 优先，其次最近动过；最多三条', () => {
  const db = db0()
  ensureTaskTable(db)
  const ins = db.prepare('INSERT INTO task(space,title,status,created_at,updated_at,src) VALUES(?,?,?,?,?,?)')
  ins.run('default', '卡住的那件', 'blocked', 1, 9000, 'NEXT.md')
  ins.run('default', '做得最久的', 'doing', 1, 1000, 'NEXT.md')
  ins.run('default', '刚接手的', 'doing', 1, 5000, 'NEXT.md')
  ins.run('default', '中间这件', 'doing', 1, 3000, 'NEXT.md')
  ins.run('default', '已经做完的', 'done', 1, 9999, 'NEXT.md')
  const top = stackTop(db, { limit: 3 })
  assert.deepEqual(top.map((t) => t.title), ['刚接手的', '中间这件', '做得最久的'])
  // blocked 排在 doing 之后，且一条都没漏掉 done 之外的项
  const all = stackTop(db, { limit: 10 })
  assert.equal(all.length, 4)
  assert.equal(all[3].title, '卡住的那件')
  assert.match(taskLine(db, { limit: 3 }), /^手上：刚接手的 \/ 中间这件 \/ 做得最久的$/u)
})

test('B3 空栈不注入：taskLine 返回空串，卡片里那一行不出现', () => {
  const db = db0()
  ensureTaskTable(db)
  assert.equal(taskLine(db), '')
  const card = `（记忆参考——只可使用下列已发生的事实，严禁编造：\n\n已知：a）`
  assert.equal(card.includes('手上：'), false)
  // 有任务才出现，且只占一行
  db.prepare('INSERT INTO task(space,title,status,created_at,updated_at,src) VALUES(?,?,?,?,?,?)')
    .run('default', '把补丁重打一遍', 'doing', 1, 1, 'NEXT.md')
  const line = taskLine(db)
  assert.equal(line.split('\n').length, 1)
  assert.match(line, /^手上：把补丁重打一遍$/u)
})

test('B4 解析只认未勾选的复选框', () => {
  const items = parseOpen([
    '## 排期',
    '- [x] 做完了',
    '- [ ] 还欠着（等插件重载）',
    '* [ ] 星号也算',
    '- 普通列表项不算',
    '- [ ] 还欠着（等插件重载）',
  ].join('\n'))
  assert.deepEqual(items.map((i) => i.title), ['还欠着（等插件重载）', '星号也算'])
})

// ---- C. 反思：一天一条 / 一周不重复 / .bak ----

test('C1 一天两条被拒', () => {
  const db = db0()
  ensureReflectionTable(db)
  const first = propose(db, { day: '2026-11-05', before: '句子短，别端着', after: '句子短，但别干巴', reason: '被他说了两次' })
  assert.equal(first.ok, true)
  const second = propose(db, { day: '2026-11-05', before: '别列表', after: '不主动列表', reason: '另一次' })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'day-taken')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM reflection').get().c, 1)
})

test('C2 一周内同一条（同 before/after 指纹）被拒，下周可以', () => {
  const db = db0()
  ensureReflectionTable(db)
  const day1 = new Date(2026, 10, 5, 22, 0, 0).getTime()
  const a = propose(db, { day: '2026-11-05', now: day1, before: '不列表', after: '不主动列表' })
  assert.equal(a.ok, true)
  const b = propose(db, { day: '2026-11-07', now: day1 + 2 * 86400_000, before: '不列表 ', after: '不主动列表' })
  assert.equal(b.ok, false)
  assert.equal(b.code, 'repeat')
  const c = propose(db, { day: '2026-11-12', now: day1 + 7 * 86400_000, before: '不列表', after: '不主动列表' })
  assert.equal(c.ok, true)
})

test('C3 只认 notes/VOICE.md；改之前留 .bak，且不自动改文件', () => {
  const db = db0()
  ensureReflectionTable(db)
  const dir = mkdtempSync(join(tmpdir(), 'brain-reflect-'))
  const voice = join(dir, ALLOWED_FILE)
  mkdirSync(join(dir, 'notes'), { recursive: true })
  writeFileSync(voice, '句子短，别端着\n', 'utf8')

  const bad = propose(db, { changedFile: 'notes/USER.md', before: 'a', after: 'b' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'file-not-allowed')

  const at = new Date(2026, 10, 5, 22, 30, 5).getTime()
  const ok = propose(db, {
    day: '2026-11-05', now: at, voicePath: voice,
    before: '句子短，别端着', after: '句子短，但别干巴', reason: '两次被说没感情',
  })
  assert.equal(ok.ok, true)
  assert.ok(existsSync(ok.backup), `要留 .bak：${ok.backup}`)
  assert.match(ok.backup, /VOICE\.md\.bak\.20261105-223005$/u)
  assert.equal(readFileSync(ok.backup, 'utf8'), '句子短，别端着\n')
  // 这一版不自动写：原文一个字都没变，只有表里多一行
  assert.equal(readFileSync(voice, 'utf8'), '句子短，别端着\n')
  assert.equal(readdirSync(join(dir, 'notes')).length, 2)
  assert.equal(db.prepare('SELECT reverted FROM reflection WHERE id=?').get(ok.id).reverted, 0)
  assert.match(ok.message, /未自动写入/u)

  // 撤销只改标记，仍不碰文件
  const rev = revert(db, ok.id)
  assert.equal(rev.ok, true)
  assert.equal(db.prepare('SELECT reverted FROM reflection WHERE id=?').get(ok.id).reverted, 1)
  assert.equal(readFileSync(voice, 'utf8'), '句子短，别端着\n')
})

test('C4 备份：文件不存在就不留（没东西可备）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-bak-'))
  assert.equal(backupBeforeWrite(join(dir, 'nope.md'), 1), '')
  const f = join(dir, 'x.md')
  writeFileSync(f, 'hi', 'utf8')
  const bak = backupBeforeWrite(f, 0)
  assert.ok(bak.startsWith(`${f}.bak.`))
  assert.equal(readFileSync(bak, 'utf8'), 'hi')
})
