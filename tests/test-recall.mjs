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
    CREATE TABLE facts (id INTEGER PRIMARY KEY AUTOINCREMENT, f TEXT, space TEXT DEFAULT 'default');
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
  check('联想段带上了那条旧事', withAssoc.includes('pre-step'), withAssoc.slice(0, 200))

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

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail > 0) process.exit(1)
