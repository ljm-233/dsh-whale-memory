/**
 * 自检：分类器与风格分析。
 * 运行：node test-selfcheck.mjs
 */
import assert from 'node:assert/strict'
import { analyzeStyle, classifySender, renderStyleHint } from './lib/index.mjs'

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
  assert.equal(style.sampleSize, 5, '只统计 human')
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

console.log('\n全部通过')
