/**
 * 「事情」这一维的回归：状态机白名单、完成要确认、未完成上限、提交守卫。
 * 全部落临时目录，不碰真实数据。跑法：node tests/test-life.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OPEN_LIMIT, STATUS, LifeError, addItem, dueToday, emptyState, guard, load, openItems,
  save, setStatus, summaryLine, storePath,
} from '../lib/life.mjs'

const T = new Date(2026, 10, 8, 9, 0, 0).getTime()

test('新建一件事：planned，id 递增，revision 只由 save 推进', () => {
  let s = emptyState()
  s = addItem(s, { title: '写 lib/life.mjs' }, T)
  assert.equal(s.items[0].id, 'l1')
  assert.equal(s.items[0].status, STATUS.planned)
  assert.equal(s.revision, 0)
  s = addItem(s, { title: '雾屋加一层' }, T)
  assert.equal(s.items[1].id, 'l2')
})

test('空标题拒收', () => {
  assert.throws(() => addItem(emptyState(), { title: '   ' }, T), (e) => e instanceof LifeError && e.code === 'empty-title')
})

test('白名单：planned 不能直接 completed', () => {
  let s = addItem(emptyState(), { title: 'x' }, T)
  assert.throws(() => setStatus(s, 'l1', STATUS.completed, { confirm: true }, T),
    (e) => e.code === 'bad-transition')
})

test('完成必须显式确认——过了时间不算做过', () => {
  let s = addItem(emptyState(), { title: 'x' }, T)
  s = setStatus(s, 'l1', STATUS.inProgress, {}, T)
  assert.throws(() => setStatus(s, 'l1', STATUS.completed, {}, T), (e) => e.code === 'need-confirm')
  s = setStatus(s, 'l1', STATUS.completed, { confirm: true }, T + 1000)
  assert.equal(s.items[0].status, STATUS.completed)
  assert.equal(s.items[0].confirmedAt, T + 1000)
  assert.equal(s.items[0].history.length, 3)
})

test('终态不能再动', () => {
  let s = addItem(emptyState(), { title: 'x' }, T)
  s = setStatus(s, 'l1', STATUS.cancelled, {}, T)
  assert.throws(() => setStatus(s, 'l1', STATUS.inProgress, {}, T), (e) => e.code === 'bad-transition')
})

test('interrupted 可以接着做', () => {
  let s = addItem(emptyState(), { title: 'x' }, T)
  s = setStatus(s, 'l1', STATUS.inProgress, {}, T)
  s = setStatus(s, 'l1', STATUS.interrupted, {}, T)
  s = setStatus(s, 'l1', STATUS.inProgress, {}, T)
  assert.equal(s.items[0].status, STATUS.inProgress)
})

test(`未完成上限 ${OPEN_LIMIT}：到顶后拒收新事`, () => {
  let s = emptyState()
  for (let i = 0; i < OPEN_LIMIT; i++) s = addItem(s, { title: `t${i}` }, T)
  assert.throws(() => addItem(s, { title: 'overflow' }, T), (e) => e.code === 'open-limit')
})

test('dueToday 只挑今天到期的，按时间排', () => {
  let s = emptyState()
  s = addItem(s, { title: '晚的', dueAt: T + 3600_000 }, T)
  s = addItem(s, { title: '早的', dueAt: T + 60_000 }, T)
  s = addItem(s, { title: '明天的', dueAt: T + 48 * 3600_000 }, T)
  s = addItem(s, { title: '没日期' }, T)
  const due = dueToday(s, T).map((it) => it.title)
  assert.deepEqual(due, ['早的', '晚的'])
})

test('提交守卫：revision 变了就丢', () => {
  const root = mkdtempSync(join(tmpdir(), 'life-'))
  let s = emptyState()
  s = addItem(s, { title: 'x' }, T)
  const snap = { revision: s.revision }
  s = save(root, s)
  assert.equal(guard(s, snap).ok, false)
  assert.equal(guard(s, { revision: s.revision }).ok, true)
})

test('存盘再读回来，状态一样', () => {
  const root = mkdtempSync(join(tmpdir(), 'life-'))
  let s = addItem(emptyState(), { title: '写一篇' }, T)
  s = save(root, s)
  const back = load(root)
  assert.equal(back.items[0].title, '写一篇')
  assert.equal(back.revision, 1)
  assert.ok(JSON.parse(readFileSync(storePath(root), 'utf8')).items.length === 1)
})

test('坏文件当空状态，不炸', () => {
  const root = mkdtempSync(join(tmpdir(), 'life-'))
  save(root, addItem(emptyState(), { title: 'x' }, T))
  writeFileSync(storePath(root), '{坏', 'utf8')
  assert.deepEqual(load(root).items, [])
})

test('summaryLine：在做 X，还欠两件', () => {
  let s = emptyState()
  s = addItem(s, { title: 'A' }, T)
  s = addItem(s, { title: 'B' }, T)
  s = setStatus(s, 'l1', STATUS.inProgress, {}, T)
  assert.equal(summaryLine(s), '在做「A」，还欠：B')
  assert.equal(summaryLine(emptyState()), '')
  assert.equal(openItems(s).length, 2)
})
