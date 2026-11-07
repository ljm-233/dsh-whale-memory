/**
 * 情绪系统的回归：判我自己的话（A）/ 注入四道闸（B）/ 「我不想做」那本账（C）。
 *
 * 全部落临时目录，不联网、不碰真实记忆库。
 *
 * 跑法：node tests/test-mood.mjs
 */
process.env.EMBED_URL = 'http://127.0.0.1:1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  applyMoodTurn, applyTurn, buildSelfLine, decay, ensureMoodTable, initState, judgeSelf, judgeUser,
  loadState, logTurn, matchUnwilling, moodDirective, note, saveState, say,
  BASE_MOOD, DIRECTIVE_TIERS, DIMS, HINT, PER_DAY,
} from '../lib/mood.mjs'
import {
  MOOD_INJECT_COOLDOWN_HOURS, MOOD_INJECT_DAILY_MAX, MOOD_INJECT_MIN_DELTA, MOOD_LINE_CAP,
} from '../lib/constants.mjs'
import { apply } from '../lib/index.mjs'

const T0 = new Date(2026, 10, 5, 14, 0, 0).getTime() // 本地 2026-11-05 14:00
/** 造一个「上一状态」，默认就是 T0 那一刻刚记完账。 */
const st = (over = {}) => ({ ...initState(T0), updatedAt: T0, lastDecayAt: T0, ...over })

// ---- A. 数据源：判我自己的话 ----

test('A1 新路径：我的话里有「累」→ tired 记上，reason 是我的原话', () => {
  const { dims, raw, evidence, source } = judgeSelf({
    at: T0, assistantTexts: ['今天有点累，先歇会儿。'], userTexts: [], kind: 'completed', hour: 14,
  })
  assert.equal(source, 'self')
  assert.equal(dims.tired, 7)
  assert.ok(raw < 0, `累要往下压：raw=${raw}`)
  assert.match(evidence[0], /^我说「今天有点累/)
})

test('A2 新路径走完一轮：总值下去、维度记上、reason 能看出是哪句话', () => {
  const asked = applyTurn(st(), {
    at: T0 + 60_000,
    assistantTexts: ['今天有点累，先歇会儿。'],
    userTexts: ['谢谢你，太好用了'],
    kind: 'completed',
    hour: 14,
    turnStreak: 1,
  })
  assert.equal(asked.changed, true)
  assert.equal(asked.state.mood, 46)                    // raw = 1(夸) - 7*0.8 = -4.6 → /3 → -2
  assert.equal(asked.state.dims.tired, 7)
  assert.equal(asked.state.dims.happy, 1)               // 对方那句夸只算冲击，+1（旧版是 +4）
  assert.equal(asked.state.source, 'self')
  assert.match(asked.state.reason, /^我说「今天有点累/)
  assert.ok(asked.state.reason.length <= 24, `reason 要截短：${asked.state.reason}`)
})

test('A3 冲击系数小：被夸 +1、被否 +2，都不到旧版的 1/3', () => {
  const praised = judgeSelf({ at: T0, assistantTexts: ['嗯。'], userTexts: ['谢谢，真好用'] })
  const denied = judgeSelf({ at: T0, assistantTexts: ['嗯。'], userTexts: ['不对，重来'] })
  assert.equal(praised.dims.happy, 1)
  assert.equal(denied.dims.sad, 2)
  // 旧版对照：同样两句，从对方的话里直接判
  assert.equal(judgeUser({ at: T0, userTexts: ['谢谢，真好用'] }).dims.happy, 4)
  assert.equal(judgeUser({ at: T0, userTexts: ['不对，重来'] }).dims.sad, 6)
  for (const [now, before] of [[1, 4], [2, 6]]) assert.ok(now * 3 <= before, '冲击 ≤ 旧版 1/3')
})

test('A4 语气特征：说「算了」往下沉，自己开的口算一点高兴', () => {
  const tired = judgeSelf({ at: T0, assistantTexts: ['算了，不弄了。'], userTexts: ['再试试？'] })
  assert.ok(tired.dims.tired >= 5, `「算了」要记到 tired：${tired.dims.tired}`)
  const proactive = judgeSelf({ at: T0, assistantTexts: ['我在。'], userTexts: [] })
  assert.equal(proactive.dims.happy, 3)
  assert.ok(proactive.evidence.some((e) => e.includes('自己开的口')))
})

test('兼容：不带 assistantTexts 时仍走旧路径（judgeUser），没有回归', () => {
  const { state, changed } = applyTurn(st(), {
    at: T0 + 60_000, userTexts: ['谢谢你，太好了'], kind: 'completed', hour: 14, turnStreak: 1,
  })
  assert.equal(changed, true)
  assert.equal(state.mood, 52)
  assert.equal(state.dims.happy, 12)
  assert.equal(state.source, 'user')
  assert.match(state.reason, /话里有/)
})

test('衰减：3 小时后总值走半个半衰期，单维 90 分钟散一半', () => {
  const s = initState(T0)
  s.mood = 90
  s.dims.happy = 100
  decay(s, T0 + 180 * 60_000)
  assert.ok(Math.abs(s.mood - 69) < 0.001, `mood 应到 69，实际 ${s.mood}`)        // 48 + 42*0.5
  assert.ok(Math.abs(s.dims.happy - 25) < 0.001, `happy 应到 25，实际 ${s.dims.happy}`) // 100*0.5^2

  decay(s, T0 + 25 * 3600_000)
  assert.ok(Math.abs(s.mood - BASE_MOOD) < 0.5, `应回到基线 ${BASE_MOOD}，实际 ${s.mood}`)
  assert.ok(DIMS.every((k) => s.dims[k] < 0.5), '四根情绪都该散干净')
})

test('幂等：同一轮只判一次，重复判不重复记账', () => {
  const before = st()
  const sig = { at: T0 + 60_000, assistantTexts: ['今天有点累。'], userTexts: [], kind: 'completed', hour: 14 }
  const first = note(before, sig)
  assert.equal(first.changed, true)
  const again = note(first.state, sig)
  assert.equal(again.changed, false)
  assert.equal(again.why, 'same-turn')
  assert.equal(again.state.mood, first.state.mood)
})

// ---- B. 注入四道闸 ----

test('B1 闸①：同一状态只说一次（连着渲 5 次也只有 1 次开口）', () => {
  const s = st({ mood: 70, lastInjectMood: BASE_MOOD, saidAt: [] })
  const one = say(s, T0 + 1000)
  assert.equal(one.inject.yes, true)
  assert.equal(one.inject.text, '今天轻快些。有精神，可以多说两句，别飘')
  for (let i = 2; i <= 5; i += 1) {
    const again = say(one.state, T0 + 1000 * i)
    assert.equal(again.inject.yes, false, `第 ${i} 次不该再说话`)
    assert.equal(again.inject.why, 'already')
    assert.equal(again.state.saidAt.length, 1)
  }
})

test('B2 闸②：日上限 → 只记账不说，lastSkip 写 daily-cap', () => {
  const s = st({ mood: 70, lastInjectMood: BASE_MOOD, saidAt: [T0 - 1000, T0 - 2000] })
  const r = say(s, T0 + 1000, { perDay: 2 })
  assert.equal(r.inject.yes, false)
  assert.equal(r.inject.why, 'daily-cap')
  assert.equal(r.state.lastSkip.reason, 'daily-cap')
  assert.equal(r.state.injectedFor, r.state.updatedAt, '拦下也要标成处理过')
})

test('B3 闸③：幅度不到阈值 → below-delta', () => {
  const s = st({ mood: 52, lastInjectMood: BASE_MOOD, saidAt: [] })
  const r = say(s, T0 + 1000, { minDelta: 8 })
  assert.equal(r.inject.why, 'below-delta')
  // 攒到 9 格就说
  const far = st({ mood: BASE_MOOD + 9, lastInjectMood: BASE_MOOD, saidAt: [] })
  assert.equal(say(far, T0 + 1000, { minDelta: 8 }).inject.yes, true)
})

test('B4 闸④：距上次开口不到冷却时间 → cooldown', () => {
  const s = st({ mood: 70, lastInjectMood: BASE_MOOD, saidAt: [T0 - 30 * 60_000] })
  const r = say(s, T0, { cooldownHours: 3 })
  assert.equal(r.inject.why, 'cooldown')
  assert.equal(r.state.lastSkip.reason, 'cooldown')
  // 过了 3 小时就能说
  assert.equal(say(s, T0 + 3 * 3600_000, { cooldownHours: 3 }).inject.yes, true)
})

test('D1 四档指令：分界 ≤35 / 36–45 / 46–60 / ≥61，各命中一句正确的', () => {
  const [low, midLow, mid, high] = DIRECTIVE_TIERS.map((t) => t.text)
  assert.deepEqual(DIRECTIVE_TIERS.map((t) => t.max), [35, 45, 60, 100], '分界值')
  // 边界扎在两侧：35→低、36→中低、45→中低、46→中、60→中、61→高
  assert.equal(moodDirective(35), low)
  assert.equal(moodDirective(36), midLow)
  assert.equal(moodDirective(45), midLow)
  assert.equal(moodDirective(46), mid)
  assert.equal(moodDirective(60), mid)
  assert.equal(moodDirective(61), high)
  // 档内取值同样对得上（极值也不跑偏）
  for (const m of [0, 20, 34]) assert.equal(moodDirective(m), low, `mood=${m} 该走低档`)
  for (const m of [40, 44]) assert.equal(moodDirective(m), midLow, `mood=${m} 该走中低档`)
  for (const m of [50, 59]) assert.equal(moodDirective(m), mid, `mood=${m} 该走中档`)
  for (const m of [70, 100]) assert.equal(moodDirective(m), high, `mood=${m} 该走高档`)
  // 四档互不相同，且都是「能照着做」的句子（不是状态描述）
  assert.equal(new Set([low, midLow, mid, high]).size, 4)
  assert.equal(low, '句子短一点，别逞强，也别反过来讨好')
  assert.equal(midLow, '话可以少，但别冷')
  assert.equal(mid, '照常说话')
  assert.equal(high, '有精神，可以多说两句，别飘')
})

test('D2 四档都拼进那一行：各档的指令原样出现', () => {
  const line = (mood) => buildSelfLine(st({ mood, dims: { ...initState().dims } }))
  assert.ok(line(20).includes('句子短一点，别逞强，也别反过来讨好'), line(20))
  assert.ok(line(40).includes('话可以少，但别冷'), line(40))
  assert.ok(line(52).includes('照常说话'), line(52))
  assert.ok(line(70).includes('有精神，可以多说两句，别飘'), line(70))
  // 状态描述还在（「这次为什么这么说话」），没有被指令挤掉
  assert.ok(line(20).startsWith('今天很低。'), line(20))
  assert.ok(line(70).startsWith('今天轻快些。'), line(70))
})

test('D3 拼出来的一行：≤40 字、不带数字（四档 × 带不带 accent × 带不带提示）', () => {
  const dimSets = [
    { ...initState().dims },                                  // 不带 accent、不触发提示
    { ...initState().dims, care: 50 },                        // 带 accent
    { ...initState().dims, tired: 30 },                       // 累 → 带提示
    { ...initState().dims, sad: 60, tired: 40 },              // 又沉又累 → 最长的那种
  ]
  for (const mood of [0, 20, 35, 36, 45, 46, 60, 61, 70, 85, 100]) {
    for (const dims of dimSets) {
      const line = buildSelfLine(st({ mood, dims }))
      assert.ok(line.length <= MOOD_LINE_CAP, `超了上限：${line}（${line.length}）`)
      assert.ok(line.length > 0, `不能是空行：mood=${mood}`)
      assert.ok(!/[0-9]/u.test(line), `不带数值：${line}`)
      assert.ok(!line.includes('\n'), `必须是一行：${line}`)
      assert.ok(line.includes(moodDirective(mood)), `四档指令要在里面：${line}`)
    }
  }
})

test('D4 闸门的默认值：一天 4 次、动 6 格、冷却 3 小时（常量只写一处）', () => {
  assert.equal(MOOD_INJECT_DAILY_MAX, 4)
  assert.equal(MOOD_INJECT_MIN_DELTA, 6)
  assert.equal(MOOD_INJECT_COOLDOWN_HOURS, 3)
  assert.equal(PER_DAY, MOOD_INJECT_DAILY_MAX, '旧名跟着走')
  // 默认值真的落在闸上：今天说过 3 次、且都过了冷却 → 第 4 次还能说；满 4 次就只记账
  const h = 3600_000
  const three = st({ mood: 70, lastInjectMood: BASE_MOOD, saidAt: [T0 - 4 * h, T0 - 4 * h + 1, T0 - 4 * h + 2] })
  assert.equal(say(three, T0).inject.yes, true, '第 4 次还能说')
  const four = st({ mood: 70, lastInjectMood: BASE_MOOD, saidAt: [T0 - 5 * h, T0 - 4 * h, T0 - 4 * h + 1, T0 - 4 * h + 2] })
  assert.equal(say(four, T0).inject.why, 'daily-cap', '满 4 次就只记账')
  // 动 6 格就算够：48 → 54 说得出去，48 → 53 还不说
  assert.equal(say(st({ mood: 54, lastInjectMood: BASE_MOOD, saidAt: [] }), T0 + 1000).inject.yes, true)
  assert.equal(say(st({ mood: 53, lastInjectMood: BASE_MOOD, saidAt: [] }), T0 + 1000).inject.why, 'below-delta')
})

test('文案：一行、≤40 字、不带数字；沉或累时带「（不想做可以说）」', () => {
  const line = buildSelfLine(st({ mood: 70, dims: { ...initState().dims, care: 50 } }))
  assert.ok(line.length <= MOOD_LINE_CAP, `一行的硬上限：${line}（${line.length}）`)
  assert.ok(!/[0-9]/u.test(line), `不带数值：${line}`)
  assert.equal(buildSelfLine(st({ mood: 34, dims: { ...initState().dims, tired: 30 } })),
    `今天有点沉，还累。${moodDirective(34)}${HINT}`)
  assert.ok(buildSelfLine(st({ mood: 70 })).startsWith('今天轻快些。'))
  assert.ok(!buildSelfLine(st({ mood: 70 })).includes(HINT), '不沉不累就不带那句提示')
})

// ---- 记账 / 开关 / 接口 ----

/**
 * 用假的 ctx 把插件搭起来，返回事件钩子、端点表和注册过的 context 条目。
 *
 * @param {object} extra 配置覆盖
 * @param {Map} routesOut 端点表（可选）
 * @returns {{handlers:Map, routes:Map, dir:string, contexts:Array}}
 */
const mount = (extra = {}, routesOut = new Map()) => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-mood-'))
  const handlers = new Map()
  const contexts = []
  const effect = (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} }
  const ctx = {
    on: (name, fn) => handlers.set(name, fn),
    inject: (deps, cb) => {
      const stub = { effect }
      if (deps.includes('systemPrompt')) {
        stub.systemPrompt = {
          section: () => {},
          context: (desc) => { contexts.push(desc); return () => {} },
        }
      }
      if (deps.includes('llm')) stub.llm = {}
      if (deps.includes('agents')) stub.agents = { list: () => [] }
      if (deps.includes('dshIm')) stub.dshIm = {}
      if (deps.includes('webServer')) stub.webServer = { register: (route) => { routesOut.set(route.path, route.handler) } }
      if (deps.includes('tools')) stub.tools = { register: () => {} }
      cb(stub)
    },
    effect,
  }
  apply(ctx, { memoryPath: dir, preferencePath: join(dir, 'PREFERENCE.md'), ...extra })
  return { handlers: handlers, routes: routesOut, dir, contexts }
}

/** 走一轮：用户说一句 + 我回一句 + 轮末收尾。 */
const runTurn = (handlers, sid, userText, selfText = '', kind = 'completed') => {
  const fire = handlers.get('session/event')
  assert.equal(typeof fire, 'function', '要挂 session/event 钩子')
  if (userText !== '') {
    fire({ id: sid }, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: userText }] },
    })
  }
  if (selfText !== '') {
    fire({ id: sid }, {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: selfText }] } },
    })
  }
  fire({ id: sid }, { type: 'turn/end', data: { turn: 1, reason: { kind } } })
}

/** 数 mood_log 有多少行。 */
const countRows = (dir) => {
  const db = new DatabaseSync(join(dir, 'memory.db'))
  try { return db.prepare('SELECT COUNT(*) c FROM mood_log').get().c } finally { db.close() }
}

test('端到端 A：turn/end 判的是我的话，mood_log.reason 里是我的原话', () => {
  const { handlers, dir } = mount()
  runTurn(handlers, 's-self', '在吗', '今天有点累，先歇会儿。')
  const db = new DatabaseSync(join(dir, 'memory.db'))
  try {
    const row = db.prepare('SELECT mood, dims, reason FROM mood_log ORDER BY at DESC LIMIT 1').get()
    assert.ok(row, '要落一行账')
    assert.match(row.reason, /^我说「今天有点累/)
    assert.ok(JSON.parse(row.dims).tired >= 7, `tired 要记上：${row.dims}`)
    assert.ok(row.mood < BASE_MOOD, `话里带累，总值该往下：${row.mood}`)
  } finally { db.close() }
})

test('端到端 B：连着渲染 5 次 context 条目 → 只注入 1 次（mood_log.injected 也标上）', () => {
  const { dir, contexts } = mount()
  const desc = contexts.find((d) => d.order === 950)
  assert.ok(desc, '要注册 order 950 的 context 条目')
  assert.equal(desc.name, 'plugin:dsh-whale-memory:mood')

  const now = Date.now()
  const db = new DatabaseSync(join(dir, 'memory.db'))
  try {
    ensureMoodTable(db)
    const seeded = {
      ...initState(now), updatedAt: now, lastDecayAt: now,
      mood: 70, lastInjectMood: BASE_MOOD, injectedFor: 0, saidAt: [],
    }
    saveState(db, 'default', seeded)
    logTurn(db, { at: now, state: seeded, space: 'default', raw: 22, reason: '我说「今天挺好的」' })

    const shown = []
    for (let i = 0; i < 5; i += 1) shown.push(desc.text({}))
    assert.equal(shown.filter((t) => t !== '').length, 1, `5 次渲染只能开口 1 次：${JSON.stringify(shown)}`)
    assert.equal(shown[0], '今天轻快些。有精神，可以多说两句，别飘')
    assert.equal(db.prepare('SELECT COUNT(*) c FROM mood_log WHERE injected=1').get().c, 1, '注入要标在账上')
    assert.equal(loadState(db, 'default', now).saidAt.length, 1)
  } finally { db.close() }
})

test('端到端 B：日上限设 1，两次状态变化只注入 1 次，第二次 lastSkip=daily-cap', () => {
  const { dir, contexts } = mount({ moodInjectDailyMax: 1 })
  const desc = contexts.find((d) => d.order === 950)
  const db = new DatabaseSync(join(dir, 'memory.db'))
  try {
    ensureMoodTable(db)
    // 同一天里演练：10:00 说一次，12:00 又变了一次（冷却还没到，但日上限先拦）
    const base = new Date()
    base.setHours(10, 0, 0, 0)
    const day0 = base.getTime()
    const seed = (mood, at) => {
      // 保留已经说过的次数：日上限数的是「今天开口几次」，不能被重新构造状态抹掉。
      const said = loadState(db, 'default', at).saidAt ?? []
      const s = {
        ...initState(at), updatedAt: at, lastDecayAt: at,
        mood, lastInjectMood: BASE_MOOD, injectedFor: 0, saidAt: said,
      }
      saveState(db, 'default', s)
      logTurn(db, { at, state: s, space: 'default', raw: 0, reason: '我说「今天还行」' })
    }

    seed(70, day0)                         // 第一次变化：够 8 格、没冷却 → 说
    assert.notEqual(desc.text({}), '')
    const later = day0 + 2 * 3600_000      // 2 小时后：冷却没过，但今天已经说满 1 次
    seed(20, later)                        // 第二次变化：幅度 20 格、够大
    assert.equal(desc.text({}), '', '第二次不该说')
    assert.equal(loadState(db, 'default', later).lastSkip.reason, 'daily-cap')
  } finally { db.close() }
})

test('端到端 B：turn/end 只记账、不吃闸——记完账下一帧仍说得出话', () => {
  const { handlers, dir, contexts } = mount()
  const desc = contexts.find((d) => d.order === 950)
  const now = Date.now()
  const db = new DatabaseSync(join(dir, 'memory.db'))
  try {
    ensureMoodTable(db)
    // 已经沉下去了（比上次开口低 8 格），但这一轮还没说过
    saveState(db, 'default', {
      ...initState(now), updatedAt: now - 1000, lastDecayAt: now - 1000,
      mood: 40, lastInjectMood: BASE_MOOD, injectedFor: 0, saidAt: [],
    })
  } finally { db.close() }

  runTurn(handlers, 's-order', '在吗', '今天有点累。')
  const first = desc.text({})
  assert.notEqual(first, '', '记账那一步不该把这次开口吃掉')
  assert.equal(desc.text({}), '', '说过一次就不再说了')
})

test('端到端 C：我说「我今天不想做」→「我不想做.md」多一行，只记录不执行', () => {
  const { handlers, dir } = mount()
  runTurn(handlers, 's-no', '帮我把这个做完', '我今天不想做，先歇会儿。')
  const line = readFileSync(join(dir, '我不想做.md'), 'utf8')
    .split('\n').filter((l) => l.startsWith('- ')).pop()
  assert.ok(line, '要有一行账')
  assert.match(line, /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} 我说：「我今天不想做/)
  // 只记不执行：mood 照常记一行，别的什么都没被改
  assert.equal(countRows(dir), 1)
})

test('端到端 C：关掉记账也照样留痕（那是「我能拒绝」，不是心情）', () => {
  const { handlers, dir } = mount({ moodEnabled: false })
  runTurn(handlers, 's-no2', '帮我看看', '这个我今天不想弄了。')
  const line = readFileSync(join(dir, '我不想做.md'), 'utf8')
    .split('\n').filter((l) => l.startsWith('- ')).pop()
  assert.match(line, /我说：「这个我今天不想弄了」/)
  assert.equal(countRows(dir), 0, '心情一行都不记')
})

test('C 的触发词：只认「不想做/今天不想」这类，不误伤普通句子', () => {
  assert.deepEqual(matchUnwilling(['我先歇会儿。']), [])
  assert.deepEqual(matchUnwilling(['我今天不想做。']), ['我今天不想做'])
  assert.deepEqual(matchUnwilling(['这个我不想弄了。']), ['这个我不想弄了'])
})

test('关掉 moodEnabled：整轮跳过，一行都不写，也不注入', () => {
  const off = mount({ moodEnabled: false })
  runTurn(off.handlers, 's-off', '谢谢你，太好了', '今天真开心。')
  assert.equal(countRows(off.dir), 0, '关掉之后不记账')
  const desc = off.contexts.find((d) => d.order === 950)
  assert.equal(desc.text({}), '', '关掉之后一个字都不往外送')

  // 对照：默认（true）就写一笔
  const on = mount()
  runTurn(on.handlers, 's-on', '谢谢你，太好了', '今天真开心。')
  assert.equal(countRows(on.dir), 1, '默认开着，一轮一笔')
})

test('mood_log 幂等：同一个 at 记两次只落一行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-mood-idem-'))
  const db = new DatabaseSync(join(dir, 'memory.db'))
  // 平时这两张表由 lib/index.mjs 建；这里手搭一个最小库，只放记账要用的两张。
  db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
  ensureMoodTable(db)
  const at = Date.now()
  const signal = { at, assistantTexts: ['今天有点累。'], kind: 'completed', hour: 14, turnStreak: 1 }
  const first = applyMoodTurn(db, { space: 'default', signal })
  const again = applyMoodTurn(db, { space: 'default', signal })
  assert.equal(first.logged, true, '第一笔记上')
  assert.equal(again.logged, false, '同一个 at 的第二笔被挡住')
  assert.equal(again.why, 'same-turn')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM mood_log').get().c, 1)
  // 状态只留一条，且没被写两遍
  assert.equal(db.prepare("SELECT COUNT(*) c FROM meta WHERE k='mood.state.default'").get().c, 1)
  db.close()
})

/** 调端点，返回 { status, body }。 */
const call = (routes, path, query = '') => new Promise((ok) => {
  const handler = routes.get(path)
  assert.ok(handler, `没注册 ${path}`)
  const res = {
    status: 0,
    writeHead(code) { this.status = code; return this },
    end(body) { ok({ status: this.status, body: body === undefined ? undefined : JSON.parse(body) }) },
  }
  handler({ method: 'GET', url: path + query }, res)
})

test('GET /mood：空库返回 {days:[],recent:[]}，参数越界截断不报错', async () => {
  const routes = new Map()
  const { dir } = mount({}, routes)
  const empty = await call(routes, '/dsh-whale-memory/mood', '?days=7')
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body, { days: [], recent: [] }, '空库也要是空的这两个键')

  // 越界参数：不抛、不 400
  const weird = await call(routes, '/dsh-whale-memory/mood', '?days=9999&space=')
  assert.equal(weird.status, 200)
  assert.deepEqual(weird.body, { days: [], recent: [] })

  // 塞一笔进去，结构要对
  const db = new DatabaseSync(join(dir, 'memory.db'))
  const at = Date.now()
  applyMoodTurn(db, { space: 'default', signal: { at, assistantTexts: ['今天有点累。'], kind: 'completed', hour: 14 } })

  const one = await call(routes, '/dsh-whale-memory/mood', '?days=7')
  assert.equal(one.status, 200)
  assert.equal(one.body.days.length, 1)
  const day = one.body.days[0]
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(day.day), `day 要本地日期键：${day.day}`)
  for (const k of ['mood', 'min', 'max', 'count']) assert.equal(typeof day[k], 'number', `缺 ${k}`)
  assert.equal(day.count, 1)
  assert.equal(one.body.recent.length, 1)
  for (const k of ['at', 'mood', 'reason']) assert.ok(k in one.body.recent[0], `明细缺 ${k}`)
  assert.equal(one.body.recent[0].at, at)
  assert.match(one.body.recent[0].reason, /^我说「/)
  db.close()
  console.log('OK /mood 结构')
})
