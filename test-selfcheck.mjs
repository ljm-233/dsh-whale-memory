/**
 * 自检 v0.2：验证情绪识别、主动联想打分、记忆合并。
 * 运行：node test-selfcheck.mjs
 */
import assert from 'node:assert/strict'
import { cosine, cueWords, detectEmotions, extractFacts, overlap, pairShadowed, scoreMemory, similarity } from './lib/index.mjs'

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

console.log('\n全部通过')
