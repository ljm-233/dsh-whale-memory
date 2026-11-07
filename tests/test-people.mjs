/**
 * dsh-whale-memory —— 「人」这一维自检
 *
 * 三块，各测各的：
 *   1. 纯查询（lib/people.mjs）：覆盖率口径、只有号的行、排序、越界截断、参数化 SQL；
 *   2. 两个端点（/people、/people/entries）：只读、405、参数截断；
 *   3. 页面纯函数（peopleCountLine / peopleCoverageNote / peopleRow / peopleBody）：
 *      统计行、覆盖率灰字、空状态、展开后的第一条记忆就是记忆内容页那一套行渲染。
 *
 * 第三条需要 react（装在 DSH 那边），拿不到就跳过——和 test-client 一个规矩。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../lib/index.mjs'
import { listPeople, personEntries, coverageOf, PEOPLE_MAX, PEOPLE_ENTRIES_MAX } from '../lib/people.mjs'
import { ensurePersonRow, ensureSpeakerColumns } from '../lib/speaker.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'wm-people-'))
const routes = new Map()

const effect = (fn) => {
  const dispose = fn()
  return typeof dispose === 'function' ? dispose : () => {}
}
const ctx = {
  on: () => {},
  inject: (deps, cb) => {
    const stub = { effect }
    if (deps.includes('webServer')) stub.webServer = { register: (route) => { routes.set(route.path, route.handler) } }
    if (deps.includes('systemPrompt')) stub.systemPrompt = { section: () => {}, context: () => () => {} }
    if (deps.includes('llm')) stub.llm = {}
    if (deps.includes('agents')) stub.agents = { list: () => [] }
    if (deps.includes('dshIm')) stub.dshIm = {}
    if (deps.includes('tools')) stub.tools = { register: () => {} }
    cb(stub)
  },
  effect,
}

apply(ctx, { memoryPath: dir, preferencePath: join(dir, 'PREFERENCE.md') })
const db = new DatabaseSync(join(dir, 'memory.db'))

/** 造一条记忆：谁说的、什么时候、正文。 */
const put = (u, spk, t, extra = {}) => {
  db.prepare('INSERT INTO entries(u,a,t,w,emo,hot,space,spk) VALUES(?,?,?,?,?,?,?,?)')
    .run(u, extra.a ?? '嗯', t, extra.w ?? 3, '[]', extra.hot ?? 0, extra.space ?? 'default', spk)
}
const putPerson = (spk, name, aka = '[]', space = 'default') => {
  db.prepare('INSERT OR REPLACE INTO person(spk,space,name,aka,score,source,updated) VALUES(?,?,?,?,1,?,?)')
    .run(spk, space, name, aka, 'manual', Date.now())
}

const t0 = Date.now()
// 三个人有名字，一个号只有号（认人表里没有），另有两条不知道谁说的（空串）。
putPerson('AAAA1111', 'ljm', '["ljm_QvQ","宝宝"]')
putPerson('BBBB2222', '鲸鱼姬', '[]')
putPerson('CCCC3333', '', '[]') // 认人表里有行但没名字 → 只有号那边
put('ljm 说的第一句', 'AAAA1111', t0 - 9000)
put('ljm 说的第二句', 'AAAA1111', t0 - 3000)
put('ljm 说的第三句', 'AAAA1111', t0 - 1000)
put('鲸鱼姬说的唯一一句', 'BBBB2222', t0 - 5000)
put('没名字那个号说的', 'CCCC3333', t0 - 4000)
put('只有号没进认人表的那句', 'DDDD4444', t0 - 7000)
put('不知道谁说的（空串）', '', t0 - 2000)
put('也不知道谁说的', '', t0 - 6000)

// ---- 1) 覆盖率口径：分母是全库条目，分子是 spk 非空 ----
{
  const cov = coverageOf(db)
  assert.equal(cov.total, 8, '分母是全库条目')
  assert.equal(cov.known, 6, '分子是 spk 非空（空串 = 不知道谁说的，不算到谁头上）')
  assert.equal(Math.round(cov.coverage * 1000) / 1000, 0.75, '覆盖率 6/8')
  // 空库：0/0 = 0，不是 NaN——页面要能直接写这个数。
  const empty = new DatabaseSync(join(dir, 'empty.db'))
  empty.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY, t INTEGER, space TEXT DEFAULT \'default\')')
  assert.deepEqual(coverageOf(empty), { total: 0, known: 0, coverage: 0 }, '空库覆盖率给 0，不给 NaN')
  // 连 spk 列都没有的老库：按 0 报，不抛。
  assert.deepEqual(coverageOf(empty), { total: 0, known: 0, coverage: 0 })
  empty.close()
  console.log('OK 覆盖率口径')
}

// ---- 2) 人列表：认人表的人 + 只有号的人，排序、字段 ----
{
  const out = listPeople(db)
  assert.equal(out.people.length, 4, '三个认人表行（含空名字那个）+ 一个只有号')
  assert.deepEqual(out.people.map((p) => p.spk), ['AAAA1111', 'CCCC3333', 'BBBB2222', 'DDDD4444'], '条目数多的在前（3），同是 1 条时按最近说话排（-4000 / -5000 / -7000）')
  const ljm = out.people[0]
  assert.equal(ljm.name, 'ljm')
  assert.deepEqual(ljm.aka, ['ljm_QvQ', '宝宝'], '又名是 JSON 数组拆出来的')
  assert.equal(ljm.count, 3)
  assert.equal(ljm.lastAt, t0 - 1000, '最近一次 = 名下最新的 t')
  assert.equal(ljm.named, true)
  const only = out.people.find((p) => p.spk === 'DDDD4444')
  assert.equal(only.named, false, '认人表里没有的号 named=false')
  assert.equal(only.name, '')
  assert.equal(out.people.find((p) => p.spk === 'CCCC3333').named, false, '认人表里空名字也算「只有号」')
  assert.equal(out.stats.people, 4)
  assert.equal(out.stats.named, 2, '有名字的两个：ljm、鲸鱼姬')
  assert.equal(out.stats.onlyId, 2, '只有号的两个：认人表里名字是空的 CCCC3333 + 认人表里没有的 DDDD4444')
  assert.equal(out.stats.total, 8)
  assert.equal(out.stats.known, 6)
  console.log('OK 人列表')
}

// ---- 3) 越界截断：0 / 负 / NaN / 超大 ----
{
  assert.equal(listPeople(db, { limit: 0 }).people.length, 4, 'limit=0 退回默认（不是空列表）')
  assert.equal(listPeople(db, { limit: -5 }).people.length, 4, '负数退回默认')
  assert.equal(listPeople(db, { limit: 'abc' }).people.length, 4, 'NaN 退回默认')
  assert.equal(listPeople(db, { limit: 2 }).people.length, 2, 'limit=2 只给两行')
  assert.equal(listPeople(db, { limit: 1e9 }).people.length, 4, '超大值截到上限（人不够，就是全部）')
  assert.equal(PEOPLE_MAX, 200, '上限写死 200，页面拿不动更多')
  console.log('OK 人列表截断')
}

// ---- 4) 一个人名下的记忆：顺序、截断、行形状 ----
{
  const out = personEntries(db, { spk: 'AAAA1111', limit: 10 })
  assert.equal(out.total, 3)
  assert.deepEqual(out.items.map((i) => i.user), ['ljm 说的第三句', 'ljm 说的第二句', 'ljm 说的第一句'], '按时间倒序（最近的在最上面）')
  const row = out.items[0]
  for (const k of ['id', 'at', 'weight', 'emo', 'user', 'assistant', 'space', 'spk', 'imp', 'hits', 'tier', 'lastHit', 'hot']) {
    assert.ok(k in row, `行形状要和 /entries 一致，缺 ${k}`)
    }
  assert.equal(row.spk, 'AAAA1111')
  assert.deepEqual(personEntries(db, { spk: 'AAAA1111', limit: 1 }).items.length, 1)
  assert.equal(personEntries(db, { spk: 'AAAA1111', limit: 9999, }).items.length, 3, '库里只有三条')
  assert.equal(PEOPLE_ENTRIES_MAX, 100, '上限 100')
  assert.equal(personEntries(db, { spk: 'AAAA1111', limit: 0 }).items.length, 3, 'limit=0 退回默认 10')
  console.log('OK 一个人的记忆')
}

// ---- 5) 参数化：认不出的 spk 一律空结果，绝不拼字符串 ----
{
  for (const bad of ['', 'zzzz', "' OR 1=1 --", '　', 'ABCD-EFG']) {
    const out = personEntries(db, { spk: bad })
    assert.deepEqual(out, { spk: '', total: 0, items: [] }, `spk=${JSON.stringify(bad)} 要给空结果`)
  }
  // 小写也认（toSpk 统一大写），但只认前 8 位。
  assert.equal(personEntries(db, { spk: 'aaaa1111' }).items.length, 3, '小写接受')
  // 32 位 openid 也只取前 8 位（toSpk 的口径），不是「认不出」。
  assert.equal(personEntries(db, { spk: 'AAAA11110F0AA3985B2C' }).items.length, 3, '长串截前 8 位')
  // 空间过滤：认人表行按 space 分开。
  putPerson('EEEE5555', '别的空间的人', '[]', 'work')
  assert.equal(listPeople(db, { space: 'work' }).people.length, 1, 'space=work 只剩那一行')
  assert.equal(listPeople(db, { space: 'work' }).people[0].count, 0, 'work 空间里没有他的记忆')
  assert.equal(listPeople(db, { space: 'default' }).people.length, 4, 'default 空间不受影响')
  db.prepare("DELETE FROM person WHERE spk='EEEE5555'").run()
  console.log('OK 参数化与空间')
}

// ---- 6) 端点：只读、405、参数直接进（别在路由里再算一遍） ----
{
  const call = (path, method = 'GET', query = '') => new Promise((ok) => {
    const handler = routes.get(path)
    assert.ok(handler, `没有注册 ${path}`)
    const req = { method, url: path + query }
    const res = {
      status: 0,
      writeHead(code) { this.status = code; return this },
      end(body) { ok({ status: this.status, body: body === undefined ? undefined : JSON.parse(body) }) },
    }
    handler(req, res)
  })

  const ok1 = await call('/dsh-whale-memory/people', 'GET', '?limit=2&space=default')
  assert.equal(ok1.status, 200)
  assert.equal(ok1.body.people.length, 2, 'limit=2 走通了')
  assert.equal(ok1.body.stats.total, 8, 'stats 一起回来（页面顶上一行就靠它）')
  assert.equal(ok1.body.space, 'default')

  const ok2 = await call('/dsh-whale-memory/people/entries', 'GET', '?spk=AAAA1111&limit=2')
  assert.equal(ok2.status, 200)
  assert.equal(ok2.body.spk, 'AAAA1111')
  assert.equal(ok2.body.total, 3)
  assert.equal(ok2.body.items.length, 2, 'limit=2 走通了')

  const bad = await call('/dsh-whale-memory/people/entries', 'GET', '?spk=%27%20OR%201%3D1%20--')
  assert.deepEqual(bad.body.items, [], '带引号的 spk 给空结果（参数化，不拼串）')

  for (const [path, m] of [['/dsh-whale-memory/people', 'POST'], ['/dsh-whale-memory/people/entries', 'POST']]) {
    const r = await call(path, m)
    assert.equal(r.status, 405, `${path} 只收 GET`)
  }
  console.log('OK 两个端点')
}

// ---- 7) 页面纯函数：统计行 / 覆盖率灰字 / 空状态 / 展开第一条 ----
{
  const loadFrom = (spec) => {
    const bases = [
      process.env.DSH_PROFILE_DIR && join(process.env.DSH_PROFILE_DIR, 'package.json'),
      join(process.env.HOME ?? '', '.dsh', 'profiles', 'web', 'package.json'),
      join(process.cwd(), 'package.json'),
    ].filter(Boolean)
    for (const base of bases) {
      try { return createRequire(base)(spec) } catch { /* 换下一个基准 */ }
    }
    return null
  }
  const React = loadFrom('react')
  const renderToStaticMarkup = loadFrom('react-dom/server')?.renderToStaticMarkup
  if (React === null || typeof renderToStaticMarkup !== 'function') {
    console.log('SKIP 「人」页渲染（这台机器上找不到 react / react-dom）')
    process.exit(0)
  }

  const handoffs = new Map()
  globalThis.window = { __ModuleLoader__: { load: (h) => { handoffs.set(h.id, h) } } }
  globalThis.fetch = async () => ({ ok: false })
  new Function('window', readFileSync(join(here, '..', 'client.js'), 'utf8'))(globalThis.window)
  const plugin = handoffs.get('dsh-whale-memory').factory((spec) => {
    if (spec === 'react') return React
    throw new Error(`unexpected Client external ${spec}`)
  })
  const T = plugin.__test
  const html = (el) => renderToStaticMarkup(el)
  const text = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

  // 统计行：三个数一个都不能少。
  assert.equal(T.peopleCountLine({ people: 5, named: 3, onlyId: 2 }), '5 个人 · 有名字 3 · 只有号 2')
  assert.equal(T.peopleCountLine({}), '0 个人 · 有名字 0 · 只有号 0', '脏数据也不吐 NaN')

  // 覆盖率灰字：<60% 才出现，≥60% 不写废话，空库不写。
  assert.equal(T.peopleCoverageNote({ total: 100, coverage: 0.536 }), '覆盖率 53.6%，很多记忆还不知道是谁说的')
  assert.equal(T.peopleCoverageNote({ total: 100, coverage: 0.6 }), null, '刚好 60% 不写')
  assert.equal(T.peopleCoverageNote({ total: 100, coverage: 0.98 }), null, '够高就不写')
  assert.equal(T.peopleCoverageNote({ total: 0, coverage: 0 }), null, '空库不写覆盖率（0/0 没有意义）')
  assert.equal(T.peopleCoverageNote(null), null, '没数据不炸')

  // 还没有人：空状态要写清「等谁、为什么空」。
  const emptyHtml = html(T.peopleBody({ people: [], stats: { people: 0, named: 0, onlyId: 0, total: 0, known: 0, coverage: 0 } }))
  assert.ok(text(emptyHtml).includes('还没有人。等说话人回填跑完再来。'), `空状态原文：${text(emptyHtml)}`)

  // 有数据：统计行 + 灰字 + 名单；第一个人展开后里面就是记忆行。
  const people = [
    { spk: 'AAAA1111', name: 'ljm', aka: ['宝宝'], named: true, count: 3, lastAt: t0 - 1000 },
    { spk: 'DDDD4444', name: '', aka: [], named: false, count: 1, lastAt: t0 - 7000 },
  ]
  const stats = { people: 2, named: 1, onlyId: 1, total: 8, known: 6, coverage: 0.75, silent: 0 }
  const entriesOf = (spk) => (spk !== 'AAAA1111'
    ? null
    : Rewrap(personEntries(db, { spk, limit: 10 }).items))
  /** 页面里那一支就是这条路径：/people/entries 的行 → entryRow。 */
  function Rewrap(items) {
    return React.createElement('ol', null, ...items.map((it) => T.entryRow(it, { open: false })))
  }
  const bodyHtml = html(T.peopleBody({ people, stats }, { openSpk: 'AAAA1111', entriesOf }))
  const bodyText = text(bodyHtml)
  assert.ok(bodyText.includes('2 个人 · 有名字 1 · 只有号 1'), `统计行：${bodyText}`)
  // 75% ≥ 60%：灰字不出现（够完整就不写这句废话）。
  assert.ok(!bodyText.includes('很多记忆还不知道是谁说的'), `75% 不该出现灰字：${bodyText}`)
  // 名单：第一个人 ljm 展开着，第二个人是「只有号」。
  assert.ok(bodyText.includes('▾ ljm'), `第一个人展开着：${bodyText}`)
  assert.ok(bodyText.includes('3 条'), '条目数')
  assert.ok(bodyText.includes('又名 宝宝'), '又名那一行')
  assert.ok(bodyText.includes('▸ DDDD4444'), '只有号的人用 spk 当标题')
  assert.ok(bodyText.includes('认人表里还没对上名字'), '只有号要有提示，不许当成一个人名')
  // 展开的内容就是记忆内容页那一套行：第一条是最近那条。
  assert.ok(bodyText.includes('ljm 说的第三句'), `展开后第一条：${bodyText}`)
  // 三条都在，并且倒序：第一条是最新的那句（展开第一行就是它）。
  assert.ok(bodyText.indexOf('ljm 说的第三句') < bodyText.indexOf('ljm 说的第二句'), '倒序：第三句在第二句前面')
  assert.ok(bodyText.indexOf('ljm 说的第一句') > bodyText.indexOf('ljm 说的第二句'), '最旧的在最后')

  // 覆盖率不足：灰字确实出现，位置在统计行下面、名单上面。
  const low = html(T.peopleBody({ people, stats: { ...stats, covered: 0, coverage: 0.536 } }, {}))
  const lowText = text(low)
  assert.ok(lowText.includes('覆盖率 53.6%，很多记忆还不知道是谁说的'), `灰字原文：${lowText}`)
  assert.ok(lowText.indexOf('2 个人') < lowText.indexOf('覆盖率 53.6%'), '灰字在统计行下面')
  assert.ok(lowText.indexOf('覆盖率 53.6%') < lowText.indexOf('ljm'), '灰字在名单上面')
  console.log('OK 「人」页渲染')
}

// ---- 7) 自动建档：新号补一行空名字的，已有行一个字不动 ----
{
  const N = 'F00D1234'
  assert.equal(db.prepare('SELECT COUNT(*) c FROM person WHERE spk = ?').get(N).c, 0, '这个号先不存在')
  assert.equal(ensurePersonRow(db, N, 'default', 1700000000000), true, '新号补了一行')
  const row = db.prepare('SELECT * FROM person WHERE spk = ?').get(N)
  assert.equal(row.name, '', '名字留空串')
  assert.equal(row.source, 'auto', 'source 记 auto')
  assert.equal(row.score, 1, 'score 跟建表默认一致')
  assert.equal(row.updated, 1700000000000, 'updated 用传进来的毫秒')
  assert.equal(String(row.space), 'default', 'space 跟随那条记忆')
  assert.equal(ensurePersonRow(db, N, 'default', 1700000001000), false, '已有的号不重复插')
  assert.equal(db.prepare('SELECT updated FROM person WHERE spk = ?').get(N).updated, 1700000000000, '已有行一个字不动')
  // 有名字的行：写入路径路过也不许覆盖 name / aka / source。
  ensurePersonRow(db, 'AAAA1111', 'default', 1700000002000)
  const ljm = db.prepare("SELECT name, aka, source FROM person WHERE spk = 'AAAA1111'").get()
  assert.equal(ljm.name, 'ljm', '名字不许被空串顶掉')
  assert.equal(ljm.aka, '["ljm_QvQ","宝宝"]', '又名不许被清空')
  assert.equal(ljm.source, 'manual', '来源不许被改成 auto')
  assert.equal(ensurePersonRow(db, '', 'default'), false, '不知道谁说的（空串）不建档')
  db.prepare('DELETE FROM person WHERE spk = ?').run(N)
  console.log('OK 自动建档')
}

// ---- 8) 多号合并：person_alias 归并后人数变少、条目数合并 ----
{
  const before = listPeople(db).stats
  // DDDD4444 是 BBBB2222 的小号：指过去以后算一个人。
  db.prepare("INSERT OR REPLACE INTO person_alias(space, spk, canonical_spk) VALUES('default','DDDD4444','BBBB2222')").run()
  const after = listPeople(db)
  assert.equal(after.stats.people, before.people - 1, '两个号合成一个人')
  const b = after.people.find((p) => p.spk === 'BBBB2222')
  assert.equal(b.count, 2, '条目数合起来算（各 1 条）')
  assert.equal(after.people.some((p) => p.spk === 'DDDD4444'), false, '小号不再单列一行')
  assert.equal(personEntries(db, { spk: 'DDDD4444' }).total, 2, '点开小号也是这个人的全部记忆')
  assert.equal(personEntries(db, { spk: 'BBBB2222' }).spk, 'BBBB2222', '返回的 spk 是 canonical')
  db.prepare("DELETE FROM person_alias WHERE spk = 'DDDD4444'").run()
  assert.equal(listPeople(db).stats.people, before.people, '删掉映射就回到原样')
  console.log('OK 多号合并')
}

// ---- 9) openid 回填：默认 dry-run 不写，apply 幂等 ----
{
  const d = mkdtempSync(join(tmpdir(), 'wm-openid-'))
  const memDb = join(d, 'memory.db')
  const groupDb = join(d, 'group.db')
  const FULL = `AAAA1111${'B'.repeat(24)}`
  const mem = new DatabaseSync(memDb)
  mem.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY, u TEXT, spk TEXT, t INTEGER)')
  assert.equal(ensureSpeakerColumns(mem), true, '新库补表成功')
  mem.prepare("INSERT INTO person(spk,space,name,aka,score,source,updated) VALUES('AAAA1111','default','ljm','[]',1,'manual',1)").run()
  mem.close()
  const g = new DatabaseSync(groupDb)
  g.exec('CREATE TABLE messages(sender_id TEXT NOT NULL)')
  g.prepare('INSERT INTO messages(sender_id) VALUES(?)').run(FULL)
  g.close()

  const script = join(here, '..', 'scripts', 'backfill-person-openid.mjs')
  const run = (...args) => spawnSync(process.execPath, [script, '--db', memDb, '--group-db', groupDb, ...args], { encoding: 'utf8' })
  const read = () => {
    const db2 = new DatabaseSync(memDb)
    const v = db2.prepare("SELECT openid_full FROM person WHERE spk = 'AAAA1111'").get()?.openid_full ?? null
    db2.close()
    return v
  }

  const dry = run()
  assert.equal(dry.status, 0, `dry-run 跑通：${dry.stderr}`)
  assert.ok(dry.stdout.includes('将要回填 1 行'), `dry-run 要打印将改的行：${dry.stdout}`)
  assert.equal(read(), null, 'dry-run 一个字不写')

  const first = run('--apply')
  assert.equal(first.status, 0, `apply 跑通：${first.stderr}`)
  assert.ok(first.stdout.includes('实写: 1 行'), `第一次 apply 写 1 行：${first.stdout}`)
  assert.equal(read(), FULL, '完整 id 落库')

  const second = run('--apply')
  assert.equal(second.status, 0, `第二次 apply 跑通：${second.stderr}`)
  assert.ok(second.stdout.includes('实写: 0 行'), `幂等：第二次写 0 行：${second.stdout}`)
  assert.ok(second.stdout.includes('已一致: 1'), '第二次要报成「已一致」')
  console.log('OK openid 回填')
}

console.log('\n全部通过')