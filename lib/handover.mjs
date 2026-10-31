/**
 * 交接条的骨架检查。
 *
 * 只靠「记得写」是靠不住的：压缩一次，上一段的具体经过就散了。
 * 所以交接条固定四段，缺哪段就在注入时提醒补哪段 —— 提醒而不是代写，
 * 因为代写出来的东西是格式，不是我的经历。
 */
export const HANDOVER_SECTIONS = ['## 我是谁', '## 上次做到哪', '## 下一步', '## 别再犯']

/**
 * 找出交接条缺了哪几段。
 *
 * @param {string} text 交接条正文
 * @returns {string[]} 缺失的段标题
 */
export const missingSections = (text) => {
  const body = String(text ?? '')
  return HANDOVER_SECTIONS.filter((h) => !body.includes(h))
}

/**
 * 生成给注入用的提醒行；四段齐了返回空串。
 *
 * @param {string} text 交接条正文
 * @returns {string}
 */
export const handoverNudge = (text) => {
  const missing = missingSections(text)
  if (missing.length === 0) return ''
  return `交接条缺 ${missing.join('、')}；收工前按 templates/HANDOVER.md 补齐，别留到下个我。`
}
