/**
 * 自检 v0.2：验证情绪识别、主动联想打分、记忆合并。
 * 运行：node test-selfcheck.mjs
 */
import assert from 'node:assert/strict'
import { buildArchiveDoc, correctEntry, htmlToText, isPrivateSession, parseJudgement, putEntry, readPolicy, recentEvents, writePolicy, cosine, cueWords, detectEmotions, extractFacts, overlap, pairShadowed, retractEntry, scoreMemory, searchEntries, similarity, splitForIm } from './lib/index.mjs'
import { DatabaseSync } from 'node:sqlite'

// ---- detectEmotions ----
{
  assert.deepEqual(detectEmotions('今天好累啊'), ['tired'])
  assert.deepEqual(detectEmotions('笑死我了'), ['happy'])
  assert.deepEqual(detectEmotions('明天开会'), [])
  const many = detectEmotions('又累又焦虑')
  assert.ok(many.includes('tired') && many.includes('anxious'), `应同时识别，实际 ${many}`)
  console.log('OK detectEmotions')
}

// ---- cueWords ----
{
  const words = cueWords('你还记得去年在杭州下雨那天那家咖啡店吗')
  assert.ok(words.includes('杭州'), `应抽到「杭州」，实际: ${words}`)
  assert.ok(words.length > 0, '应产出线索词')
  const plain = cueWords('今天怎么样')
  assert.ok(plain.every((w) => !['今天', '怎么'].includes(w)), `过滤停止词失败: ${plain}`)
  console.log('OK cueWords')
}

// ---- overlap：二元组重叠度 ----
{
  const hi = overlap('上次加班到很晚', '今天又加班了')
  assert.ok(hi >= 0.2, `同话题应有一定重叠，实际 ${hi}`)
  const lo = overlap('上次加班到很晚', '明天天气怎么样')
  assert.ok(lo < 0.15, `不同话题应几乎无重叠，实际 ${lo}`)
  console.log('OK overlap')
}

// ---- scoreMemory：主动联想的核心 ----
{
  const now = Date.now()
  const tiredEntry = { u: '最近天天加班，累死了', a: '辛苦了', t: now - 3 * 86400000, w: 3, emo: ['tired'] }
  const weatherEntry = { u: '明天天气怎么样', a: '晴', t: now - 3 * 86400000, w: 1, emo: [] }

  // 用户说「累」——加班那条应该被想起
  const sTired = scoreMemory(tiredEntry, { emotions: ['tired'], text: '今天好累', cues: [], now })
  const sWeather = scoreMemory(weatherEntry, { emotions: ['tired'], text: '今天好累', cues: [], now })
  assert.ok(sTired > sWeather, `加班记忆(${sTired}) 应高于天气记忆(${sWeather})`)
  assert.ok(sTired > 2, `应超过召回门槛，实际 ${sTired}`)

  // 情绪无关时，不该乱联想
  const sNone = scoreMemory(tiredEntry, { emotions: [], text: '明天开会', cues: [], now })
  assert.ok(sNone < sTired, `无情绪关联时应降分，实际 ${sNone}`)

  // 高权重的旧事不该被新近度惩罚压下去
  const oldImportant = { u: '那件事', a: 'x', t: now - 365 * 86400000, w: 10, emo: [] }
  const newTrivial = { u: '那件事', a: 'x', t: now, w: 1, emo: [] }
  const sOld = scoreMemory(oldImportant, { emotions: [], text: '那件事', cues: [], now })
  const sNew = scoreMemory(newTrivial, { emotions: [], text: '那件事', cues: [], now })
  assert.ok(sOld > sNew, `印象深刻的老事(${sOld}) 应高于琐碎的新事(${sNew})`)
  console.log('OK scoreMemory')
}

// ---- extractFacts / similarity ----
{
  assert.deepEqual(extractFacts('我叫小明'), ['我叫小明'])
  assert.deepEqual(extractFacts('今天天气不错'), [])
  assert.ok(similarity('叫小明', '叫小明') === 1)
  assert.ok(similarity('叫小明', '住在北京') < 0.3)
  console.log('OK extractFacts / similarity')
}

// ---- cosine：向量路径 ----
{
  const a = Float32Array.from([1, 0, 0])
  const b = Float32Array.from([1, 0, 0])
  const c = Float32Array.from([0, 1, 0])
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6, '同向应=1')
  assert.ok(Math.abs(cosine(a, c)) < 1e-6, '正交应=0')
  assert.equal(cosine(null, a), 0, 'null 应返回 0')
  assert.equal(cosine(a, Float32Array.from([1, 2])), 0, '长度不等应返回 0')
  console.log('OK cosine')
}

// ---- scoreMemory 用向量时的行为 ----
{
  const now = Date.now()
  const q = Float32Array.from([1, 0, 0, 0])
  const near = { u: 'x', a: 'y', t: now, w: 2, emo: [], vec: Float32Array.from([0.9, 0.1, 0, 0]) }
  const far = { u: 'x', a: 'y', t: now, w: 2, emo: [], vec: Float32Array.from([0, 1, 0, 0]) }
  const sNear = scoreMemory(near, { emotions: [], text: '', cues: [], queryVec: q, now })
  const sFar = scoreMemory(far, { emotions: [], text: '', cues: [], queryVec: q, now })
  assert.ok(sNear > sFar, `近邻向量(${sNear}) 应高于正交向量(${sFar})`)
  console.log('OK scoreMemory(vector)')
}

// ---- pairShadowed：压缩前抢救的配对逻辑 ----
{
  const mkUser = (t, kind = 'user') => ({
    type: 'user/message',
    data: { source: { kind }, content: [{ type: 'text', text: t }] },
  })
  const mkAssistant = (t) => ({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: t }] } },
  })

  const evs = {
    1: mkUser('运行时上下文快照', 'runtime-context'),   // 注入，应跳过
    2: mkUser('帮我建个仓库'),
    3: mkAssistant('好，我先看看'),
    4: mkUser('第二个问题'),
    5: mkAssistant('第二个回答'),
    6: { type: 'tool/result', data: {} },              // 工具结果，应跳过
  }
  const pairs = pairShadowed((s) => evs[s], [1, 2, 3, 4, 5, 6])
  assert.equal(pairs.length, 2, `应配出 2 对，实际 ${pairs.length}`)
  assert.equal(pairs[0].u, '帮我建个仓库')
  assert.equal(pairs[0].a, '好，我先看看')
  assert.equal(pairs[1].a, '第二个回答')

  // 只有用户没助手回复的情况
  const onlyUser = pairShadowed((s) => ({ 1: mkUser('孤独的一句') })[s], [1])
  assert.equal(onlyUser.length, 1)
  assert.equal(onlyUser[0].a, '', '无回复时应为空串')

  // 空输入
  assert.deepEqual(pairShadowed(() => undefined, []), [])
  assert.deepEqual(pairShadowed(() => undefined, [99]), [], '取不到事件应返回空')
  console.log('OK pairShadowed')
}

// ---- buildArchiveDoc：压缩存档 ----
{
  const doc = buildArchiveDoc({
    at: new Date('2026-10-30T09:00:00Z'),
    sessionId: 'session-abc12345',
    summary: '用户测试了压缩存档。',
    tokens: 1234,
    pairs: [{ u: '先存档', a: '好' }, { u: '再私发', a: '' }],
  })
  assert.match(doc, /^# 上下文压缩存档/)
  assert.match(doc, /压缩掉：2 轮，约 1,234 token/)
  assert.match(doc, /## 压缩摘要\n\n用户测试了压缩存档。/)
  assert.match(doc, /### 1\n\n\*\*用户\*\*：先存档\n\n\*\*我\*\*：好/)
  assert.match(doc, /\*\*用户\*\*：再私发\n/, '没有回复时也不该崩')

  const empty = buildArchiveDoc({
    at: new Date('2026-10-30T09:00:00Z'), sessionId: 's', summary: '', tokens: 0, pairs: [],
  })
  assert.match(empty, /（压缩器没有给出摘要）/)
  console.log('OK buildArchiveDoc')
}

// ---- splitForIm：分段发送 ----
{
  const short = splitForIm('abc', '/tmp/x.md')
  assert.deepEqual(short, ['abc'], '短文不该被切')

  const long = splitForIm('甲'.repeat(1200 * 20), '/tmp/x.md')
  assert.equal(long.length, 6, '最多 6 段')
  assert.match(long[5], /后面还有 \d+ 字，没发完。完整版在：\/tmp\/x\.md）$/)

  const exact = splitForIm('乙'.repeat(1200 * 3), '/tmp/y.md')
  assert.equal(exact.length, 3)
  assert.doesNotMatch(exact[2], /没发完/, '正好整除时不该提示截断')
  console.log('OK splitForIm')
}

// ---- 记忆检索与修正 ----
{
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, u TEXT NOT NULL, a TEXT NOT NULL,
    t INTEGER NOT NULL, w REAL NOT NULL DEFAULT 1, emo TEXT NOT NULL DEFAULT '[]',
    vec BLOB, hot INTEGER NOT NULL DEFAULT 1, owner TEXT NOT NULL DEFAULT '')`)
  db.exec(`CREATE TABLE revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER NOT NULL, action TEXT NOT NULL,
    before_u TEXT NOT NULL, before_a TEXT NOT NULL, after_u TEXT, after_a TEXT,
    reason TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, actor TEXT NOT NULL DEFAULT '')`)
  const now = Date.now()
  const ins = db.prepare('INSERT INTO entries(u,a,t,w,emo,hot) VALUES(?,?,?,?,?,?)')
  ins.run('主人说过喜欢咖啡', '嗯', now - 1000, 5, '["happy"]', 0)
  ins.run('主人说最近很累', '辛苦了', now, 3, '["tired"]', 1)

  // 检索
  assert.equal(searchEntries(db, { keyword: '咖啡' }).length, 1)
  assert.equal(searchEntries(db, { keyword: '主人' }).length, 2)
  assert.equal(searchEntries(db, { zone: 'hot' }).length, 1)
  assert.equal(searchEntries(db, { zone: 'cold' })[0].u, '主人说过喜欢咖啡', '冷区按权重排')
  assert.equal(searchEntries(db, { keyword: '根本没这句' }).length, 0)

  // 修正：旧的进 revisions，主表换成新的
  const target = searchEntries(db, { keyword: '咖啡' })[0]
  const fixed = correctEntry(db, {
    id: target.id, text: '主人说过不喜欢咖啡', assistant: '记错了', reason: '主人纠正过',
  })
  assert.equal(fixed.ok, true)
  assert.equal(fixed.previousId, target.id)
  assert.notEqual(fixed.id, target.id)

  assert.equal(searchEntries(db, { keyword: '咖啡' }).length, 1)
  assert.equal(searchEntries(db, { keyword: '咖啡' })[0].u, '主人说过不喜欢咖啡')
  assert.equal(searchEntries(db, { keyword: '咖啡' })[0].a, '记错了')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM entries').get().c, 2, '修正不该让条目变多')

  const rev = db.prepare('SELECT action,before_u,after_u,reason FROM revisions').get()
  assert.equal(rev.action, 'correct')
  assert.equal(rev.before_u, '主人说过喜欢咖啡', '原件留在修订记录里')
  assert.equal(rev.after_u, '主人说过不喜欢咖啡')
  assert.equal(rev.reason, '主人纠正过')

  // 撤回
  const gone = retractEntry(db, { id: fixed.id, reason: '不该记' })
  assert.equal(gone.ok, true)
  assert.equal(searchEntries(db, { keyword: '咖啡' }).length, 0, '撤回后主表里没有它')
  assert.equal(db.prepare("SELECT COUNT(*) c FROM revisions WHERE action='retract'").get().c, 1)

  // 边界
  assert.equal(correctEntry(db, { id: 9999, text: 'x' }).ok, false)
  assert.equal(correctEntry(db, { id: 0, text: 'x' }).reason, 'bad-id')
  assert.equal(correctEntry(db, { id: target.id, text: '' }).reason, 'not-found', '旧 id 已经不存在')
  assert.equal(retractEntry(db, { id: 9999 }).reason, 'not-found')
  console.log('OK 记忆检索与修正')
}

// ---- 共享时间线 ----
{
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
    session TEXT NOT NULL, window TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL, text TEXT NOT NULL)`)
  const now = Date.now()
  const ins = db.prepare('INSERT INTO events(at,session,window,kind,text) VALUES(?,?,?,?,?)')
  ins.run(now - 3 * 3600_000, 's1', 'qq/group', 'user', '在群里问了一句')
  ins.run(now - 2 * 3600_000, 's1', 'qq/group', 'assistant', '答了')
  ins.run(now - 30 * 60_000, 's2', 'web/main', 'user', '换个窗口继续')
  ins.run(now, 's2', 'web/main', 'tool', 'group_history')

  const all = recentEvents(db, { hours: 24 })
  assert.equal(all.length, 4, '不同窗口的事件都在同一条线上')
  assert.equal(all[0].text, 'group_history', '新到旧')

  assert.equal(recentEvents(db, { hours: 24, kind: 'user' }).length, 2)
  assert.equal(recentEvents(db, { hours: 24, kind: 'tool' }).length, 1)
  assert.equal(recentEvents(db, { hours: 24, session: 's2' }).length, 2)
  assert.equal(recentEvents(db, { hours: 1 }).length, 2, '最近一小时只有两条')
  assert.equal(recentEvents(db, { hours: 24, limit: 2 }).length, 2)

  // 两个窗口各自看到的是同一条线
  const fromS1 = recentEvents(db, { hours: 24, session: 's1' })
  assert.ok(fromS1.every((e) => e.session === 's1'))
  assert.equal(recentEvents(db, {}).length, 4, '不给 hours 就是全都要')
  console.log('OK 共享时间线')
}

// ---- 记忆取舍倾向 ----
{
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')

  assert.equal(readPolicy(db), '', '一开始没有倾向')
  const saved = writePolicy(db, '  做过的决定和我犯过的错值得留   寒暄不必  ')
  assert.equal(saved, '做过的决定和我犯过的错值得留 寒暄不必', '空白会收敛')
  assert.equal(readPolicy(db), saved)

  writePolicy(db, '改成：只留改坏过的东西')
  assert.equal(readPolicy(db), '改成：只留改坏过的东西', '再写一次是覆盖')
  assert.ok(writePolicy(db, 'x'.repeat(2000)).length === 600, '超长截断')
  console.log('OK 取舍倾向')
}

// ---- parseJudgement：压缩时留不留 ----
{
  assert.deepEqual(parseJudgement('{"keep": true, "line": "改完设置页的数值输入"}'),
    { keep: true, line: '改完设置页的数值输入' })
  assert.deepEqual(parseJudgement('{"keep": false, "line": ""}'), { keep: false, line: '' })
  // 带解释的包裹也要能解析
  assert.deepEqual(parseJudgement('判断如下：\n{"keep": true, "line": "推了一次代码"}\n以上'),
    { keep: true, line: '推了一次代码' })
  // 解析不了就宁可留下
  assert.deepEqual(parseJudgement('这段挺重要的吧'), { keep: true, line: '这段挺重要的吧' })
  assert.deepEqual(parseJudgement(''), { keep: true, line: '' })
  assert.deepEqual(parseJudgement(null), { keep: true, line: '' })
  console.log('OK parseJudgement')
}

// ---- 跨 Agent 的写边界 ----
{
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, u TEXT NOT NULL, a TEXT NOT NULL,
    t INTEGER NOT NULL, w REAL NOT NULL DEFAULT 1, emo TEXT NOT NULL DEFAULT '[]',
    vec BLOB, hot INTEGER NOT NULL DEFAULT 1, owner TEXT NOT NULL DEFAULT '')`)
  db.exec(`CREATE TABLE revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER NOT NULL, action TEXT NOT NULL,
    before_u TEXT NOT NULL, before_a TEXT NOT NULL, after_u TEXT, after_a TEXT,
    reason TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, actor TEXT NOT NULL DEFAULT '')`)

  // 别人的写入必须自报家门
  assert.equal(putEntry(db, { user: '我自己的事' }).reason, 'owner-required')
  const foreign = putEntry(db, { owner: 'bot-other', user: '别人记的一件事' })
  assert.equal(foreign.ok, true)
  assert.equal(searchEntries(db, { owner: 'bot-other' }).length, 1)
  assert.equal(searchEntries(db, {}).length, 1, '别人写的，我也读得到——读是共享的')

  // 别人写的，不能被我随便改
  const blocked = correctEntry(db, { id: foreign.id, text: '被我改了', actor: '' })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'not-yours')

  // 显式允许才改得动，并且记下是谁改的
  const allowed = correctEntry(db, {
    id: foreign.id, text: '经允许改过', actor: 'me', allowForeign: true, reason: '对方同意了',
  })
  assert.equal(allowed.ok, true)
  const rev = db.prepare('SELECT actor, action FROM revisions ORDER BY id DESC LIMIT 1').get()
  assert.equal(rev.actor, 'me', '改别人写的要记下是谁动的手')
  assert.equal(rev.action, 'correct')

  // 自己写的自己随便改
  const mine = putEntry(db, { owner: 'me', user: '我自己的事' })
  assert.equal(correctEntry(db, { id: mine.id, text: '改了', actor: 'me' }).ok, true)
  console.log('OK 写边界')
}

// ---- htmlToText ----
{
  const html = '<html><head><style>p{color:red}</style><script>var x=1</script></head>' +
    '<body><h1>标题</h1><p>一段&nbsp;话 &amp; 符号</p><!-- 注释 --></body></html>'
  const text = htmlToText(html)
  assert.ok(!text.includes('color:red'), '样式要丢掉')
  assert.ok(!text.includes('var x=1'), '脚本要丢掉')
  assert.ok(text.includes('标题'))
  assert.ok(text.includes('一段 话 & 符号'), '实体要还原')
  assert.equal(htmlToText(''), '')
  assert.equal(htmlToText(null), '')
  console.log('OK htmlToText')
}

// ---- isPrivateSession：不该抛，也不该把群聊当私聊 ----
{
  assert.equal(isPrivateSession(''), false, '空会话直接否')
  assert.equal(isPrivateSession('session-unknown'), false, '查不到就当作非私聊')
  assert.equal(typeof isPrivateSession('c2c:whatever'), 'boolean', '必须是布尔，不能抛')
  console.log('OK isPrivateSession')
}

console.log('\n全部通过')
