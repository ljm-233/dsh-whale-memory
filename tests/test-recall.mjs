/**
 * 记忆卡的回归：不联网、不碰真实记忆库。
 *
 * 记忆卡现在走 runtime-context（lib/index.mjs 里 ctx.systemPrompt.context），
 * 所以这里只测纯同步那一层：空库给空串、有东西就拼上、库坏了也不抛。
 * 深的检索不在这层（交给 memory_recall 工具，限流测试见 test-routes.mjs）。
 *
 * 跑法：node tests/test-recall.mjs
 */
process.env.EMBED_URL = 'http://127.0.0.1:1'

const { DatabaseSync } = await import('node:sqlite')
const { mkdtempSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { createRecall } = await import('../lib/recall.mjs')
const { cardLine } = await import('../lib/format.mjs')
const { RECALL_CARD_MAX, RECALL_SECTION_CAP } = await import('../lib/constants.mjs')

/** 六字段卡的样子：`#短id 标签 分 MM-DD HH:mm 摘要｜「原句」`。 */
const CARD_RE = /^#[0-9a-f]{1,6} (对话|工具|笔记) -?\d+\.\d \d{2}-\d{2} \d{2}:\d{2} .+｜「.+」$/u

let pass = 0
let fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  OK  ' + name) }
  else { fail += 1; console.log('  NG  ' + name + (extra ? ` — ${extra}` : '')) }
}

const dir = mkdtempSync(join(tmpdir(), 'whale-recall-'))

/** 造一份只带记忆卡要读的那几张表的库。 */
const freshDb = () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, u TEXT, a TEXT, t INTEGER, w REAL DEFAULT 1, emo TEXT DEFAULT '[]', vec BLOB, hot INTEGER DEFAULT 1, space TEXT DEFAULT 'default', hits INTEGER DEFAULT 0, tier INTEGER DEFAULT 0, owner TEXT DEFAULT '');
    CREATE TABLE facts (id INTEGER PRIMARY KEY AUTOINCREMENT, f TEXT, space TEXT DEFAULT 'default',
      valid_from INTEGER NOT NULL DEFAULT 0, valid_until INTEGER);
    CREATE TABLE diary (day TEXT PRIMARY KEY, text TEXT, created_at INTEGER);
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE stats (k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0);
  `)
  return db
}

const depsOf = (db, extra = {}) => ({
  db,
  memoryDir: dir,
  bumpStat: () => {},
  space: () => 'default',
  budgetChars: () => 3000,
  factMax: () => 8,
  recentPairs: () => 4,
  ...extra,
})

// ---- 1. 空库：给空串，不抛 ----
const emptyDb = freshDb()
const emptyCard = createRecall(depsOf(emptyDb)).card
const empty = emptyCard({ session: { id: 'session-test-1' } })
check('空库返回空串', empty === '', JSON.stringify(empty))
check('空串是字符串而不是 null', typeof empty === 'string')

// ---- 2. 有内容就拼上 ----
const db = freshDb()
const now = Date.now()
db.prepare('INSERT INTO facts (f) VALUES (?)').run('主人的名字是 ljm')
db.prepare('INSERT INTO entries (u,a,t,w,emo,vec,hot) VALUES (?,?,?,?,?,?,1)').run('最近在调插件', '嗯', now - 1000, 1, '[]', null)
db.prepare('INSERT INTO diary (day,text,created_at) VALUES (?,?,?)').run('2026-10-30', '今天把插件修好了', now)
writeFileSync(join(dir, 'HANDOVER.md'), '## 我是谁\n米鱼\n## 上次做到哪\n换注入点\n## 下一步\n写测试\n## 别再犯\n别乱改\n')

const bumps = []
const card = createRecall(depsOf(db, { bumpStat: (k) => bumps.push(k) })).card
const text = card({ session: { id: 'session-test-1' } })
check('事实进卡片', text.includes('主人的名字是 ljm'), text.slice(0, 60))
check('热区进卡片', text.includes('最近在调插件'))
check('日记进卡片', text.includes('今天把插件修好了'))
check('交接条进卡片', text.includes('换注入点'))
check('带「严禁编造」的抬头', text.includes('严禁编造'))
// 交接条在注入前会把标题行剥掉（原本的行为），所以四段的标题看不见，nudge 会催一次
check('缺段照旧催补', text.includes('交接条缺'))

// ---- 3. 同一张卡重复组装不重复记账（每步都会组装一次） ----
const before = bumps.filter((k) => k === 'injectChars').length
card({ session: { id: 'session-test-1' } })
card({ session: { id: 'session-test-1' } })
const after = bumps.filter((k) => k === 'injectChars').length
check('同文本只记一次账', after === before, `${before} → ${after}`)

// ---- 4. 预算小就少放，不溢出 ----
const tight = createRecall(depsOf(db, { budgetChars: () => 40 })).card({})
check('预算小的时候不硬塞', tight.length <= 60, String(tight.length))

// ---- 5. 库坏了：空串，不抛 ----
const broken = new DatabaseSync(':memory:')
broken.close()
const bareDir = mkdtempSync(join(tmpdir(), 'whale-recall-bare-'))
let threw = null
let brokenCard = ''
try {
  brokenCard = createRecall(depsOf(broken, { memoryDir: bareDir })).card({})
} catch (error) { threw = error }
check('库坏掉不抛错', threw === null, String(threw))
check('库坏掉返回空串', brokenCard === '', JSON.stringify(brokenCard))

// ---- 6. 没有 agent 也能出卡（诊断性组装时可能拿不到 agent） ----
let noAgent = null
try { noAgent = card() } catch { noAgent = 'threw' }
check('没有 agent 也能出卡', typeof noAgent === 'string' && noAgent.includes('主人的名字是 ljm'))

// ---- 7. 召回限流：一条人类消息之间最多 3 次 ----
{
  const { registerTools } = await import('../lib/tools.mjs')
  const tdb = freshDb()
  tdb.prepare('INSERT INTO entries (u,a,t,w,emo,hot) VALUES (?,?,?,?,?,1)').run('冷区那条', '嗯', Date.now(), 1, '[]')
  tdb.prepare('INSERT INTO entries (u,a,t,w,emo,hot) VALUES (?,?,?,?,?,1)').run('冷区旁边那条', '好', Date.now() - 1000, 1, '[]')

  const reg = new Map()
  const events = new Map()
  const fakeCtx = {
    on: (name, fn) => events.set(name, fn),
    inject: (_deps, cb) => cb({ effect: (fn) => fn(), tools: { register: (tool) => reg.set(tool.name, tool) } }),
  }
  registerTools(fakeCtx, {
    defineTool: (spec) => spec,
    db: tdb,
    embedTexts: async () => null,
    backupNow: () => ({ ok: true }),
    listBackups: () => [],
    readPreference: () => '',
    writePreference: () => '',
    space: () => 'default',
  })

  const recall = reg.get('memory_recall')
  check('注册了 memory_recall', recall !== undefined)
  const exec = (id) => ({ agent: { session: { id } } })

  const first = recall.execute({ keyword: '冷区' }, exec('s-main'))
  check('第 1 次照常查', first.count >= 1 && first.reason !== 'rate-limited')
  check('查得准就给一句「还能再查」', first.hint.includes('还剩 2 次'), first.hint)
  const loose = recall.execute({ keyword: '冷' }, exec('s-main'))
  check('重合度低就不诱导再查', loose.hint === '', loose.hint)
  recall.execute({ keyword: '冷区' }, exec('s-main'))
  const fourth = recall.execute({ keyword: '冷区' }, exec('s-main'))
  check('同一轮第 4 次被拒', fourth.reason === 'rate-limited' && fourth.count === 0, JSON.stringify(fourth))
  const shown = recall.output.render({}, fourth)[0].text
  check('拒绝时那句话对得上', shown.includes('这轮已经查够了'), shown)

  // 计数按会话分开：子 agent / 另一个会话不吃这一轮的额度
  const other = recall.execute({ keyword: '冷区' }, exec('s-other'))
  check('别的会话不受牵连', other.reason !== 'rate-limited' && other.count >= 1, JSON.stringify(other))

  // 新的一条人类消息：计数归零
  const onUser = events.get('session/event')
  check('挂了 session/event 去清零', typeof onUser === 'function')
  onUser({ id: 's-main' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '新问题' }] } })
  const afterReset = recall.execute({ keyword: '冷区' }, exec('s-main'))
  check('新消息后计数归零', afterReset.reason !== 'rate-limited' && afterReset.count >= 1, JSON.stringify(afterReset))
  // 通知类的 user 消息（source 不是 user）不该清零
  recall.execute({ keyword: '冷区' }, exec('s-main'))
  recall.execute({ keyword: '冷区' }, exec('s-main'))
  const blocked = recall.execute({ keyword: '冷区' }, exec('s-main'))
  onUser({ id: 's-main' }, { type: 'user/message', data: { source: { kind: 'notice' } } })
  const stillBlocked = recall.execute({ keyword: '冷区' }, exec('s-main'))
  check('只有真人消息才清零', blocked.reason === 'rate-limited' || stillBlocked.reason === 'rate-limited', JSON.stringify(stillBlocked))
}

// ---- 8. 联想缓存：异步算一次，卡片同步读 ----
{
  const adb = freshDb()
  const t0 = Date.now()
  adb.prepare('INSERT INTO entries (u,a,t,w,emo,vec,hot,tier) VALUES (?,?,?,?,?,?,0,1)')
    .run('插件的注入点换成 context 之后，pre-step 那条路被砍掉了', '嗯，深度联想也一起没了', t0 - 86400000, 1, '[]', null)

  const rec = createRecall(depsOf(adb))
  const ASK = '插件重启之后注入点还有问题吗'
  await rec.associate('session-assoc-1', ASK)
  const withAssoc = rec.card({ session: { id: 'session-assoc-1' } })
  check('缓存命中时卡片含联想段', withAssoc.includes('和这次有关'), withAssoc.slice(0, 80))
  const assocLines = withAssoc.split('\n').filter((l) => l.startsWith('#'))
    .map((l) => l.replace(/）$/u, ''))
  check('联想段里是六字段卡', assocLines.length === 1 && CARD_RE.test(assocLines[0]), JSON.stringify(assocLines))
  check('卡不带整段原文', !withAssoc.includes('那条路被砍掉了'), withAssoc.slice(-120))

  // 别的会话不共用同一格缓存
  const other = rec.card({ session: { id: 'session-assoc-other' } })
  check('别的会话不复用', !other.includes('和这次有关'), other.slice(0, 80))

  // 换了用户消息：上一轮的联想立刻作废（turn+1、lines 清空）
  await rec.associate('session-assoc-1', '今天天气还行')
  const afterNew = rec.card({ session: { id: 'session-assoc-1' } })
  check('用户消息不同则缓存不复用', !afterNew.includes('和这次有关'), afterNew.slice(0, 120))

  // 过期：算完把时钟推过 TTL，缓存自己作废
  await rec.associate('session-assoc-1', ASK)
  check('重新算过就又有了', rec.card({ session: { id: 'session-assoc-1' } }).includes('和这次有关'))
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 11 * 60 * 1000
    const stale = rec.card({ session: { id: 'session-assoc-1' } })
    check('缓存过期则不出现', !stale.includes('和这次有关'), stale.slice(0, 120))
  } finally {
    Date.now = realNow
  }

  // 联想段最多占整卡 1/3：预算 300 时那段最多 100 字，长条目的尾巴必须被切掉
  const bigDb = freshDb()
  for (const i of [1, 2, 3]) {
    bigDb.prepare('INSERT INTO entries (u,a,t,w,emo,vec,hot,tier) VALUES (?,?,?,?,?,?,0,0)')
      .run(`插件注入点第${i}条：${'很长的旧事'.repeat(20)}尾巴标记${i}`, '嗯', Date.now() - i * 3600 * 1000, 3, '[]', null)
  }
  const small = createRecall(depsOf(bigDb, { budgetChars: () => 300 }))
  await small.associate('session-assoc-2', ASK)
  const smallCard = small.card({ session: { id: 'session-assoc-2' } })
  check('整卡不超预算', smallCard.length <= 300, String(smallCard.length))
  check('联想段受 1/3 预算约束', smallCard.includes('和这次有关') && !smallCard.includes('尾巴标记3'), smallCard)
  check('联想段不超 650 字', smallCard.length <= 300, String(smallCard.length))
}

// ---- 9. 召回命中后升热：w+1 / hits+1 / tier-1 ----
{
  const { warmEntries } = await import('../lib/tools.mjs')
  const wdb = freshDb()
  wdb.prepare('INSERT INTO entries (u,a,t,w,emo,hot,hits,tier) VALUES (?,?,?,?,?,1,0,2)')
    .run('一条旧事', '嗯', Date.now(), 3, '[]')
  const id = Number(wdb.prepare('SELECT last_insert_rowid() AS id').get().id)
  const rowOf = () => wdb.prepare('SELECT w,hits,tier FROM entries WHERE id = ?').get(id)

  check('写了几条就回几个数', warmEntries(wdb, [id], 12) === 1)
  let row = rowOf()
  check('w +1', row.w === 4, String(row.w))
  check('hits +1', row.hits === 1, String(row.hits))
  check('tier 浅一层', row.tier === 1, String(row.tier))

  warmEntries(wdb, [id], 12)
  row = rowOf()
  check('tier 到底就停在 0', row.tier === 0 && row.hits === 2, JSON.stringify(row))

  // 一条一次：同一 id 传两遍只加一次
  warmEntries(wdb, [id, id], 12)
  check('同一条一轮只加一次', rowOf().hits === 3, JSON.stringify(rowOf()))

  // 封顶：w 到上限就不再涨
  wdb.prepare('UPDATE entries SET w = 12 WHERE id = ?').run(id)
  warmEntries(wdb, [id], 12)
  check('w 到上限就不再涨', rowOf().w === 12, String(rowOf().w))

  // 库坏了也不能把召回带崩
  const dead = new DatabaseSync(':memory:')
  dead.close()
  let threw = null
  let wrote = -1
  try { wrote = warmEntries(dead, [id], 12) } catch (error) { threw = error }
  check('写不进去就吞掉，不抛', threw === null && wrote === 0, `${threw} / ${wrote}`)
}

// ---- 10. 证据卡：六字段齐、≤120 字；超长按 tag→summary→quote 缩，缩不动就丢 ----
{
  const row = {
    id: 1234567,
    u: '插件的注入点换成 context 之后，pre-step 那条路被砍掉了',
    a: '嗯，深度联想也一起没了',
    t: Date.parse('2026-10-31T17:24:00+08:00'),
    w: 4.24,
  }
  const line = cardLine(row, { keyword: '注入点', score: 4.24 })
  check('卡 ≤120 字', line.length <= RECALL_CARD_MAX, String(line.length))
  check('六字段齐（id/tag/score/summary/time/quote）', CARD_RE.test(line), line)
  check('短 id 取后 6 位', line.startsWith('#234567 '), line)
  check('score 保留一位小数', line.includes(' 4.2 '), line)
  check('time 是 MM-DD HH:mm', line.includes('10-31 17:24'), line)
  check('quote 是命中位置前后的逐字原句', line.includes('「' + '插件的注入点换成 con' + '」'), line)
  check('summary 来自助手侧', line.includes('嗯，深度联想也一起没了'), line)

  // 来源标签
  check('别的 agent 写的是「工具」', cardLine({ ...row, owner: 'other' }, {}).includes(' 工具 '), cardLine({ ...row, owner: 'other' }, {}))
  check('（联想）开头的是「笔记」', cardLine({ ...row, u: '（联想）插件重启' }, {}).includes(' 笔记 '), cardLine({ ...row, u: '（联想）插件重启' }, {}))
  check('普通对话是「对话」', cardLine({ ...row, owner: '' }, {}).includes(' 对话 '), cardLine(row, {}))

  // 缩：先丢 tag，再缩 summary，quote 留到最后
  const tight = cardLine(row, { keyword: '注入点', max: 40 })
  check('超长时先缩 tag', tight.length <= 40 && !tight.includes('对话'), tight)
  check('tag 缩完之后 summary 也缩，quote 还在', tight.includes('嗯｜「插件的注入点换成 con」'), tight)
  check('缩不动就整条丢掉', cardLine(row, { keyword: '注入点', max: 4 }) === '', cardLine(row, { max: 4 }))

  // 查询词压根没出现：quote 退回首 12 字，但仍然是原句切片，不编
  const noHit = cardLine(row, { keyword: '完全不一样的词' })
  check('找不到查询词就给开头那 12 字', noHit.includes('「插件的注入点换成 con」'), noHit)
}

// ---- 11. 联想段：最多 5 条、整段 ≤650 字 ----
{
  const mdb = freshDb()
  const base = Date.now()
  for (let i = 0; i < 9; i += 1) {
    mdb.prepare('INSERT INTO entries (u,a,t,w,emo,vec,hot,tier) VALUES (?,?,?,?,?,?,0,0)')
      .run(`插件注入点第${i}条：${'很长的旧事'.repeat(30)}尾巴标记${i}`, '嗯', base - i * 3600 * 1000, 4, '[]', null)
  }
  const rec = createRecall(depsOf(mdb, { budgetChars: () => 3000 }))
  const ASK2 = '插件注入点还有问题吗'
  const section = await rec.associate('session-section', ASK2)
  const cards = section.split('\n').filter((l) => l !== '')
  check('联想段最多 5 条', cards.length > 0 && cards.length <= 5, String(cards.length))
  check('每条都是六字段卡', cards.every((l) => CARD_RE.test(l)), cards[0])
  check('整段 ≤650 字', section.length <= RECALL_SECTION_CAP, String(section.length))
  check('段里没有整段原文', !section.includes('尾巴标记'), section.slice(0, 120))
}

// ---- 12. memory_recall：默认只回卡，detail:full 才给原文并分页 ----
{
  const { registerTools } = await import('../lib/tools.mjs')
  const db2 = freshDb()
  const longUser = `冷区那条记忆：${'逐字原话'.repeat(40)}片尾`
  db2.prepare('INSERT INTO entries (u,a,t,w,emo,hot,tier) VALUES (?,?,?,?,?,0,0)')
    .run(longUser, `助手那侧：${'回应'.repeat(40)}`, Date.now(), 3, '[]')

  const reg2 = new Map()
  const events2 = new Map()
  registerTools({
    on: (name, fn) => events2.set(name, fn),
    inject: (_deps, cb) => cb({
      effect: (fn) => fn(),
      tools: { register: (tool) => reg2.set(tool.name, tool) },
    }),
  }, {
    defineTool: (spec) => spec,
    db: db2,
    embedTexts: async () => null,
    backupNow: () => ({ ok: true }),
    listBackups: () => [],
    readPreference: () => '',
    writePreference: () => '',
    space: () => 'default',
  })
  const recall = reg2.get('memory_recall')
  const exec = (id) => ({ agent: { session: { id } } })

  // 默认：card
  const cards = recall.execute({ keyword: '冷区那条记忆' }, exec('s-cards'))
  check('默认走 card', cards.detail === 'card', String(cards.detail))
  check('card 里一条卡', cards.items.length === 1 && CARD_RE.test(cards.items[0].card), JSON.stringify(cards.items[0]))
  check('card 不带原文', cards.items.every((it) => it.user === undefined && it.assistant === undefined), JSON.stringify(cards.items[0]))
  const cardText = recall.output.render({}, cards)[0].text
  check('card 渲染里只有卡', cardText.includes('排序分，不是概率') && !cardText.includes('片尾'), cardText)
  check('card 渲染提示去看全文', cardText.includes("detail:'full'"), cardText)

  // full：按字符分页（限流每会话 3 次，所以每次换个会话）
  const full = recall.execute({ keyword: '冷区那条记忆', detail: 'full', limit: 200 }, exec('s-full-a'))
  check('full 带 total', full.detail === 'full' && full.total > 200, String(full.total))
  check('full 一页正好是 limit 个字符', full.text.length === 200 && full.total > 200, String(full.text.length))
  check('full 从 0 开始，nextOffset 接着', full.offset === 0 && full.nextOffset === 200, JSON.stringify([full.offset, full.nextOffset]))
  check('full 第一页就是原文开头', full.text.startsWith('#') && full.text.includes('冷区那条记忆'), full.text.slice(0, 40))

  const mid = recall.execute({ keyword: '冷区那条记忆', detail: 'full', limit: 200, offset: 200 }, exec('s-full-b'))
  const whole = recall.execute({ keyword: '冷区那条记忆', detail: 'full', limit: 8000 }, exec('s-full-c'))
  check('offset 生效', mid.offset === 200 && mid.text === whole.text.slice(200, 400), JSON.stringify([mid.offset, mid.text.length]))
  check('两页接得上', full.text + mid.text === whole.text.slice(0, full.nextOffset + (whole.total - 200)), '拼接对不上')
  check('limit 超过硬上限就按上限给', whole.text.length === whole.total && whole.total <= 8000, String(whole.total))

  // 末尾：nextOffset 是 null，越界就是空页
  const tail = recall.execute({ keyword: '冷区那条记忆', detail: 'full', limit: 8000, offset: whole.total }, exec('s-tail'))
  check('读到末尾 nextOffset 为 null', tail.nextOffset === null && tail.text === '' && tail.offset === whole.total, JSON.stringify(tail).slice(0, 140))

  // 限流和低重合：改造过之后行为不变
  recall.execute({ keyword: '冷区那条记忆' }, exec('s-lim'))
  recall.execute({ keyword: '冷区那条记忆' }, exec('s-lim'))
  recall.execute({ keyword: '冷区那条记忆' }, exec('s-lim'))
  const limited = recall.execute({ keyword: '冷区那条记忆' }, exec('s-lim'))
  check('同一会话第 4 次仍被拒', limited.reason === 'rate-limited' && limited.count === 0, JSON.stringify(limited))
  check('被拒时不带卡', limited.items.length === 0 && limited.detail === 'card', JSON.stringify(limited))
  const low = recall.execute({ keyword: '完全无关的字眼' }, exec('s-low'))
  check('低重合不提示再查', low.hint === '', low.hint)
  check('低重合也可能 0 条', low.count === 0, String(low.count))
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail > 0) process.exit(1)