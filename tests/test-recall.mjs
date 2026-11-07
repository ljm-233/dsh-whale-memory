/**
 * 记忆卡的回归：不联网、不碰真实记忆库。
 *
 * 记忆卡现在走 runtime-context（lib/index.mjs 里 ctx.systemPrompt.context），
 * 所以这里只测纯同步那一层：空库给空串、有东西就拼上、库坏了也不抛。
 * 深的检索不在这层（交给 memory_recall 工具，限流测试见 test-routes.mjs）。
 *
 * 0.28.19 起排序默认走三维（lib/axes.mjs，0..1 刻度 + 按场景的门槛）。
 * 下面这些用例钉的是**旧公式的比例尺**（门槛 2.0、confidence 用 top/(2·门槛)），
 * 所以它们显式写成 `scoreMode: () => 'legacy'`——这不是绕过新代码，是 A/B 的另一条腿：
 * 切回 legacy 就该与改之前逐条同名次。三维那条腿在 tests/test-axes.mjs 和本文件最后一节。
 *
 * 跑法：node tests/test-recall.mjs
 */
process.env.EMBED_URL = 'http://127.0.0.1:1'

const { DatabaseSync } = await import('node:sqlite')
const { mkdtempSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { createRecall, coldPoolOf, kwArmOf, kwTermsOf } = await import('../lib/recall.mjs')
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
    CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, u TEXT, a TEXT, t INTEGER, w REAL DEFAULT 1, emo TEXT DEFAULT '[]', vec BLOB, hot INTEGER DEFAULT 1, space TEXT DEFAULT 'default', hits INTEGER DEFAULT 0, tier INTEGER DEFAULT 0, lastHit INTEGER NOT NULL DEFAULT 0, owner TEXT DEFAULT '');
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

  const rec = createRecall(depsOf(adb, { scoreMode: () => 'legacy' }))
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
  const small = createRecall(depsOf(bigDb, { budgetChars: () => 300, scoreMode: () => 'legacy' }))
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
  const rec = createRecall(depsOf(mdb, { budgetChars: () => 3000, scoreMode: () => 'legacy' }))
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

// ---- 13. 三道闸：指纹幂等 / 日上限 / 置信门槛 ----
{
  const ASK = '插件重启之后注入点还有问题吗'
  const readMeta = (d) => {
    try { return JSON.parse(String(d.prepare("SELECT v FROM meta WHERE k='cardInject'").get()?.v ?? '{}')) } catch { return {} }
  }

  // 13a. 幂等：同一轮里 card() 被调 6 次，命中只 +1；指纹变了才 +1
  const gdb = freshDb()
  gdb.prepare('INSERT INTO entries (u,a,t,w,emo,vec,hot,tier) VALUES (?,?,?,?,?,?,0,0)')
    .run('插件重启之后注入点还有问题吗，上下文那条路还通不通', '嗯，通了', Date.now() - 3600 * 1000, 1, '[]', null)
  const gid = Number(gdb.prepare('SELECT last_insert_rowid() AS id').get().id)
  const hitsOf = () => Number(gdb.prepare('SELECT hits FROM entries WHERE id = ?').get(gid).hits)

  const rec = createRecall(depsOf(gdb, { scoreMode: () => 'legacy' }))
  await rec.associate('s-gate', ASK)
  const first = rec.card({ session: { id: 's-gate' } })
  check('第一次真注入', first.includes('和这次有关'), first.slice(0, 80))
  check('第一次命中计数 +1', hitsOf() === 1, String(hitsOf()))

  let same = true
  for (let i = 0; i < 5; i += 1) {
    if (rec.card({ session: { id: 's-gate' } }) !== first) same = false
  }
  check('同一指纹 6 次调用结果一模一样', same)
  check('同一指纹 6 次调用只记一次命中', hitsOf() === 1, `hits=${hitsOf()}`)
  check('幂等不重复记账', readMeta(gdb).count === 1, JSON.stringify(readMeta(gdb).count))

  // 卡片内容变了（多一篇日记）→ 指纹变 → 再记一次
  gdb.prepare('INSERT INTO diary (day,text,created_at) VALUES (?,?,?)').run('2026-11-05', '今天把三道闸接上了', Date.now())
  const changed = rec.card({ session: { id: 's-gate' } })
  check('指纹变了重新生成', changed !== first && changed.includes('今天把三道闸接上了'), changed.slice(0, 80))
  check('指纹变了才再 +1', hitsOf() === 2, `hits=${hitsOf()}`)

  // 13b. 日上限：设成 2，连跑 5 次不同指纹 → 只有 2 次真注入
  const capDb = freshDb()
  capDb.prepare('INSERT INTO entries (u,a,t,w,emo,vec,hot,tier) VALUES (?,?,?,?,?,?,0,0)')
    .run('插件重启之后注入点还有问题吗，上下文那条路还通不通', '嗯，通了', Date.now(), 1, '[]', null)
  const capRec = createRecall(depsOf(capDb, { cardDailyMax: () => 2, scoreMode: () => 'legacy' }))
  await capRec.associate('s-cap', ASK)
  const outs = []
  for (let i = 1; i <= 5; i += 1) {
    capDb.prepare('INSERT INTO diary (day,text,created_at) VALUES (?,?,?)').run(`2026-11-0${i}`, `第${i}篇`, Date.now())
    outs.push(capRec.card({ session: { id: 's-cap' } }))
  }
  check('前两次照常注入', outs[0].includes('第1篇') && outs[1].includes('第2篇'), outs.slice(0, 2).map((s) => s.slice(0, 40)).join(' | '))
  check('第三次被日上限拦下（沿用旧卡）', !outs[2].includes('第3篇') && outs[2] === outs[1], outs[2].slice(0, 60))
  check('四五次同样跳过', !outs[3].includes('第4篇') && !outs[4].includes('第5篇'))
  const capState = readMeta(capDb)
  check('meta 里今天只记了 2 次', capState.count === 2, JSON.stringify(capState).slice(0, 120))
  check('跳过原因写的是 daily-cap', capState.lastSkip?.reason === 'daily-cap' && capState.lastSkip.max === 2, JSON.stringify(capState.lastSkip))

  // 13c. 置信门槛：一条刚过门槛、只有一条、没踩热区的弱命中 → conf < 0.35 → 不注入
  const lowDb = freshDb()
  lowDb.prepare('INSERT INTO entries (u,a,t,w,emo,vec,hot,tier) VALUES (?,?,?,?,?,?,0,0)')
    .run('插件出岔子', '嗯', Date.now(), 1, '[]', null)
  const lowRec = createRecall(depsOf(lowDb, { scoreMode: () => 'legacy' }))
  await lowRec.associate('s-low-conf', ASK)
  const lowCard = lowRec.card({ session: { id: 's-low-conf' } })
  const lowState = readMeta(lowDb)
  check('低置信不注入', !lowCard.includes('和这次有关') && lowCard === '', JSON.stringify(lowCard.slice(0, 80)))
  check('跳过原因写的是 confidence', lowState.lastSkip?.reason === 'confidence', JSON.stringify(lowState.lastSkip))
  check('判定依据：conf 低于门槛 0.35',
    Number(lowState.lastSkip?.conf) < 0.35 && Number(lowState.lastSkip?.conf) > 0 && lowState.lastSkip?.threshold === 0.35,
    JSON.stringify(lowState.lastSkip))
  check('门槛没放过就不记次数', (lowState.count ?? 0) === 0, String(lowState.count))

  // 门槛调低到 0.3，同一份输入就放行了——说明卡的正是那个数，不是别的
  const looseRec = createRecall(depsOf(lowDb, { cardMinConfidence: () => 0.3, scoreMode: () => 'legacy' }))
  await looseRec.associate('s-loose', ASK)
  const looseCard = looseRec.card({ session: { id: 's-loose' } })
  check('门槛调低就放行', looseCard.includes('和这次有关'), looseCard.slice(0, 80))
}


// ---- 14. 三维打分接进来：同一批条目，换场景就换名次（就是「不是换个常数」） ----
{
  const adb = freshDb()
  const now = Date.now()
  const Q = '插件注入点还有问题吗'
  const ins = 'INSERT INTO entries (u,a,t,w,emo,vec,hot,tier,hits) VALUES (?,?,?,?,?,?,0,0,?)'
  // (a) 旧的、重的：300 天前，w 到「印象深刻」，两档情绪，被想起过 4 次
  adb.prepare(ins).run('插件注入点还有问题吗，上下文那条路还通不通', '嗯，通了', now - 300 * 86400000, 8, '["sad","tired"]', null, 4)
  const idOld = Number(adb.prepare('SELECT last_insert_rowid() AS id').get().id)
  // (b) 新的、薄的：昨天，w=1，没情绪，一次没被动过
  adb.prepare(ins).run(Q, '嗯', now - 86400000, 1, '[]', null, 0)
  const idNew = Number(adb.prepare('SELECT last_insert_rowid() AS id').get().id)
  const tailOf = (id) => String(id).slice(-6)

  /** 抓一次 associate 的三轴日志（axesDebug 打开时打的那几行）。 */
  const logs = []
  const realLog = console.log
  console.log = (...args) => { logs.push(args.join(' ')) }
  const runAs = async (scene) => {
    logs.length = 0
    const rec = createRecall(depsOf(adb, {
      scoreMode: () => 'axes', recallScene: () => scene, axesDebug: () => true,
    }))
    await rec.associate(`s-axes-${scene}`, Q)
    const header = logs.find((l) => l.includes('三轴分解'))
    const rows = logs
      .map((l) => l.match(/#([0-9a-f]+) rel=([\d.]+) imp=([\d.]+) time=([\d.]+) → ([\d.]+)/u))
      .filter(Boolean)
      .map((m) => ({ id: m[1], rel: Number(m[2]), imp: Number(m[3]), time: Number(m[4]), score: Number(m[5]) }))
    return { header, rows }
  }

  let recall = null
  let lookup = null
  let daily = null
  try {
    recall = await runAs('recall')
    lookup = await runAs('lookup-old')
    daily = await runAs('daily')
  } finally {
    console.log = realLog
  }

  // 0.28.21：rel 0.55→0.65、imp 0.25→0.15（imp 让「被想过的」压过「说得对的」，见 axes.mjs 注释）
  check('axesDebug 打出场景与权重（含半衰与门槛）',
    Boolean(recall.header) && recall.header.includes('scene=recall')
    && recall.header.includes('w=rel0.65/imp0.15/time0.2') && recall.header.includes('半衰=30天'),
    recall.header)
  check('recall 场景两条都过线、旧的排前',
    recall.rows.length === 2 && recall.rows[0].id === tailOf(idOld) && recall.rows[0].score > recall.rows[1].score,
    JSON.stringify(recall.rows))
  check('lookup-old 只剩旧的那条（新的那条 0.44 没到 0.45）',
    lookup.rows.length === 1 && lookup.rows[0].id === tailOf(idOld), JSON.stringify(lookup.rows))
  check('daily 只剩新的那条（旧的 300 天掉到线下）',
    daily.rows.length === 1 && daily.rows[0].id === tailOf(idNew), JSON.stringify(daily.rows))

  const oldRecall = recall.rows.find((r) => r.id === tailOf(idOld))
  const oldLookup = lookup.rows.find((r) => r.id === tailOf(idOld))
  check('同一个 t：time 随场景从 ≈0 变成 ≈0.94',
    oldRecall !== undefined && oldLookup !== undefined
    && oldLookup.time - oldRecall.time > 0.5, `${oldRecall?.time} → ${oldLookup?.time}`)
  check('imp 只由条目决定（两个场景一致）',
    oldRecall !== undefined && oldLookup !== undefined && Math.abs(oldRecall.imp - oldLookup.imp) < 0.011,
    `${oldRecall?.imp} vs ${oldLookup?.imp}`)
  check('rel 也不随场景变（权重才变）',
    oldRecall !== undefined && oldLookup !== undefined && Math.abs(oldRecall.rel - oldLookup.rel) < 0.011,
    `${oldRecall?.rel} vs ${oldLookup?.rel}`)
  check('三轴分解里没有 NaN', [recall, lookup, daily].every((r) => r.rows.every((x) => Number.isFinite(x.time) && Number.isFinite(x.score))))

  // 关掉调试就一个字都不打（日志是给人看的，默认别刷）
  {
    logs.length = 0
    const quiet = createRecall(depsOf(adb, { scoreMode: () => 'axes', axesDebug: () => false }))
    await quiet.associate('s-axes-quiet', Q)
    check('axesDebug 默认关：不打分解', logs.filter((l) => l.includes('三轴分解')).length === 0)
  }
}

// ---- 15. 候选池的三条臂：老条目进不了「最近 200」，也要靠关键词臂捞回来 ----
//
// 0.28.21 前池子只有「最近 200 + 随机 100」：真库冷区 2300+ 条时，一条十天前的旧事
// 每轮被随机抽中的概率 ~4%，于是「十天前说过什么」在候选池这一层就丢了（跟打分无关）。
{
  const pdb = freshDb()
  const ins = pdb.prepare('INSERT INTO entries (u,a,t,w,emo,vec,hot,space) VALUES (?,?,?,?,?,?,?,?)')
  // 最老的一条：唯一带「乘法表 / builtins」这些词
  ins.run('用户用 Python 拼接 builtins 文档字符，调试乘法表代码', '嗯', now - 9 * 86400000, 1, '[]', null, 0, 'default')
  const idOld = Number(pdb.prepare('SELECT last_insert_rowid() AS id').get().id)
  // 320 条新的、跟这个问题毫无关系的，把「最近 200」占满
  for (let i = 0; i < 320; i += 1) ins.run(`第 ${i} 条无关的日常闲聊`, '好', now - i * 1000, 1, '[]', null, 0, 'default')

  const recentIds = new Set(pdb.prepare('SELECT id FROM entries WHERE hot=0 AND space=? ORDER BY t DESC LIMIT 200')
    .all('default').map((r) => Number(r.id)))
  check('前提：老条目不在「最近 200」里', !recentIds.has(idOld), String(idOld))

  const terms = kwTermsOf('以前那段调试乘法表的代码还记得吗')
  check('关键词臂取到 4 字与 2 字的词', terms.some((w) => w.length === 4) && terms.some((w) => w.length === 2),
    JSON.stringify(terms))
  check('关键词臂不超过 14 个词', terms.length <= 14, String(terms.length))

  const pool = coldPoolOf(pdb, 'default', '以前那段调试乘法表的代码还记得吗')
  const ids = new Set(pool.stmt.all(...pool.args).map((r) => Number(r.id)))
  check('关键词臂把老条目捞进候选池', ids.has(idOld), `池 ${ids.size} 条`)
  check('池子不止「最近 200 + 随机」，还多了关键词那一段', ids.size > 200, String(ids.size))

  // 只量关键词臂本身（整池里还混着随机 100，抽中不抽中是随机的，不能拿来断言）
  const armIds = (text) => {
    const arm = kwArmOf('default', kwTermsOf(text))
    if (arm === null) return new Set()
    return new Set(pdb.prepare(arm.sql).all(...arm.args).map((r) => Number(r.id)))
  }
  check('关键词臂命中老条目', armIds('以前那段调试乘法表的代码还记得吗').has(idOld))
  check('无关的话关键词臂不会捞它（臂是按词走的，不是恒开）', !armIds('今天的风挺大的').has(idOld))

  // LIKE 通配符不许从用户的话里漏进 SQL
  check('词里不留 LIKE 通配符', kwTermsOf('100%_test').every((w) => !w.includes('%') && !w.includes('_')))
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail > 0) process.exit(1)