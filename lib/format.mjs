/**
 * 格式化：时间戳、截断、消息取文、存档文档、IM 分段。
 */
import { IM_PART_CHARS, IM_MAX_PARTS } from './constants.mjs'
import { localStamp, clamp } from './shared.mjs'
export { localStamp, clamp } from './shared.mjs'



/** 从消息取纯文本。 */
export function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((b) => b && b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('\n')
    .trim()
}

/**
 * 把压缩摘要 + 被压缩掉的对话拼成一份 Markdown 存档。
 *
 * @param {{at:Date,sessionId:string,summary:string,tokens:number,pairs:Array<{u:string,a:string}>}} input
 * @returns {string}
 */
export function buildArchiveDoc({ at, sessionId, summary, tokens, pairs }) {
  const transcript = pairs
    .map((p, i) => {
      const head = `### ${i + 1}\n\n**用户**：${p.u}\n`
      return p.a === '' ? head : `${head}\n**我**：${p.a}\n`
    })
    .join('\n')

  return [
    '# 上下文压缩存档',
    '',
    `- 时间：${at.toLocaleString('zh-CN', { hour12: false })}`,
    `- 会话：${sessionId}`,
    `- 压缩掉：${pairs.length} 轮，约 ${tokens.toLocaleString()} token`,
    '',
    '## 压缩摘要',
    '',
    summary === '' ? '（压缩器没有给出摘要）' : summary,
    '',
    '## 聊天记录',
    '',
    transcript,
  ].join('\n')
}

/**
 * 把一份长文切成适合 IM 发送的若干段。
 * 超出上限的部分不硬塞，改为提示本地文件路径。
 *
 * @param {string} text 全文
 * @param {string} path 本地文件路径
 * @returns {string[]}
 */
export function splitForIm(text, path) {
  const parts = []
  for (let i = 0; i < text.length; i += IM_PART_CHARS) {
    parts.push(text.slice(i, i + IM_PART_CHARS))
  }
  if (parts.length === 0) return [text]
  const kept = parts.slice(0, IM_MAX_PARTS)
  const rest = text.length - IM_PART_CHARS * kept.length
  if (rest > 0) {
    kept[kept.length - 1] += `\n\n（后面还有 ${rest} 字，没发完。完整版在：${path}）`
  }
  return kept
}

/** 「什么值得记」的倾向存在 meta 表里的这个键。 */
