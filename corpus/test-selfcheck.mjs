/**
 * 自检：分类器与风格分析。
 * 运行：node test-selfcheck.mjs
 */
import assert from 'node:assert/strict'
import { analyzeStyle, classifySender, cleanText, renderStyleHint } from './lib/index.mjs'
import { judgeExemplar } from './exemplars.js'

const cfg = {
  aiIds: ['42FFF41FEA18578BC2EC06861D1930A0', '1C282365D18006B61447EB7ACB963F60'],
  humanIds: ['8F0AA3985B0632ACDFE34F4778F881D1'],
}

// ---- 白名单优先 ----
{
  const ai = classifySender({ senderId: cfg.aiIds[0], text: '随便说一句' }, cfg)
  assert.equal(ai.kind, 'ai', '白名单 AI 应直接判定')
  assert.ok(ai.reasons.includes('openid-whitelist'))

  const human = classifySender({ senderId: '8F0AA3985B0632ACDFE34F4778F881D1', text: '```code```\n|表格|' }, cfg)
  assert.equal(human.kind, 'human', '真人即使带 AI 特征也不该被判 AI')
  console.log('OK 白名单优先')
}

// ---- 文本特征：AI 风格强特征 ----
{
  const aiLike = classifySender({
    senderId: 'unknown-id',
    text: '这是一个测试\n\n```js\nconst x = 1\n```\n\n| 项目 | 值 |\n|---|---|\n| a | b |\n\n**加粗** **再加粗** **继续加粗**',
  }, cfg)
  assert.equal(aiLike.kind, 'ai', `强 AI 特征应判定为 ai，实际 score=${aiLike.score}`)
  console.log('OK AI 强特征')
}

// ---- 文本特征：默认真人 ----
{
  // 未知 openid 的普通短句：判 unknown（不污染真人语料）
  const plain = classifySender({ senderId: 'unknown-id', text: '今天开会好烦' }, cfg)
  assert.equal(plain.kind, 'unknown', '未知 id 的普通短句应判 unknown')

  const typo = classifySender({ senderId: 'unknown-id', text: '卧槽哈哈哈' }, cfg)
  assert.equal(typo.kind, 'human')
  console.log('OK 默认真人')
}

// ---- 风格分析 ----
{
  const msgs = [
    { kind: 'human', text: '哈哈' },
    { kind: 'human', text: '好的吧' },
    { kind: 'human', text: '今天好累啊' },
    { kind: 'human', text: '嗯' },
    { kind: 'human', text: '这个真的绝了！' },
    { kind: 'ai', text: '**这是 AI 说的**，很长很长的一段分析。' },
  ]
  const style = analyzeStyle(msgs)
  assert.ok(style !== null, '有真人样本时应产出 style')
  assert.equal(style.sampleSize, 4, '统计 human（清洗后太短的会被剔除）')
  assert.ok(style.length.median > 0, '中位数应 > 0')
  assert.ok(style.markdown.usesBold === 0, '样本里真人没用加粗')
  console.log('OK analyzeStyle')
}

// ---- 风格提示词渲染 ----
{
  const style = analyzeStyle([
    { kind: 'human', text: '哈哈' },
    { kind: 'human', text: '哎好累啊' },
    { kind: 'human', text: '睡觉了' },
  ])
  const hint = renderStyleHint(style)
  assert.ok(hint.includes('群聊说话风格参考'), '应包含标题')
  assert.ok(hint.includes('中位数'), '应包含长度统计')
  console.log('OK renderStyleHint')
}

// ---- cleanText：去 @ 与表情标签 ----
{
  assert.equal(cleanText('<@FACE655901D7509DE0F67BDAC852E6FC> 今天好累啊'), '今天好累啊')
  assert.equal(cleanText('好的<faceType=1,faceId="14",ext="abc">'), '好的')
  assert.equal(cleanText('@Miyu 你说呢'), '你说呢')
  console.log('OK cleanText')
}

// ---- 句尾统计不该被 @ 标记污染 ----
{
  const msgs = [
    { kind: 'human', text: '<@FACE655901D7509DE0F67BDAC852E6FC> 哈哈' },
    { kind: 'human', text: '好的吧' },
    { kind: 'human', text: '<@1C282365D18006B61447EB7ACB963F60>' },  // 纯 @，清洗后为空
    { kind: 'human', text: '嗯嗯' },
  ]
  const style = analyzeStyle(msgs)
  const tails = style.commonTails.map((t) => t.word)
  assert.ok(!tails.some((w) => w.includes('>')), `句尾不该含尖括号，实际: ${tails}`)
  assert.ok(!tails.some((w) => /^[0-9A-Fa-f]+$/u.test(w)), `句尾不该含 openid 片段，实际: ${tails}`)
  console.log('OK 句尾无污染')
}

// ---- judgeExemplar：范例筛选 ----
{
  // 真人表达：留下
  assert.ok(judgeExemplar('我…终于…下…课了').ok, '感叹应通过')
  assert.ok(judgeExemplar('同时三个对话还是太烧心了').ok, '吐槽应通过')
  assert.ok(judgeExemplar('提弗洛斯太肥美了').ok, '感慨应通过')

  // 指令句：排除
  assert.ok(!judgeExemplar('肥鱼，打开崩坏星穹铁道').ok, '点名+命令应排除')
  assert.ok(!judgeExemplar('你可以添加一个戳戳吗').ok, '功能需求应排除')
  assert.ok(!judgeExemplar('帮我查一下今天天气').ok, '祈使应排除')

  // 其他噪声：排除
  assert.ok(!judgeExemplar('哈哈哈哈哈哈').ok, '纯重复应排除')
  assert.ok(!judgeExemplar('短').ok, '太短应排除')
  assert.ok(!judgeExemplar('const x = 1;').ok, '非中文应排除')
  console.log('OK judgeExemplar')
}

// ---- 范例注入到提示词 ----
{
  const style = analyzeStyle([
    { kind: 'human', text: '我今天好累啊' },
    { kind: 'human', text: '睡觉了' },
    { kind: 'human', text: '哈哈' },
  ])
  const hint = renderStyleHint(style, [{ name: 'x', text: '我…终于…下…课了' }])
  assert.ok(hint.includes('群里真人说话的实例'), '应包含范例段')
  assert.ok(hint.includes('我…终于…下…课了'), '应包含范例原文')

  const noEx = renderStyleHint(style, [])
  assert.ok(!noEx.includes('群里真人说话的实例'), '没范例时不该有这一段')
  console.log('OK 范例注入')
}

console.log('\n全部通过')
