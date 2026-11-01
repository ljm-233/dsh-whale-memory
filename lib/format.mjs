/**
 * 格式化：时间戳、截断、消息取文、存档文档、IM 分段。
 */
import {
  IM_PART_CHARS, IM_MAX_PARTS, RECALL_CARD_MAX, RECALL_LINE_CAP, RECALL_QUOTE_CHARS,
} from './constants.mjs'
import { localStamp, clamp, clampText } from './shared.mjs'
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


/**
 * 短 id：数字 id 取后 6 位；不是数字就用 djb2 前 6 位十六进制。
 * 只为了在卡里认得出是哪一条，不保证全局唯一（真要改还得回 memory_recall 拿原 id）。
 *
 * @param {*} id 条目 id
 * @returns {string}
 */
export function shortId(id) {
  const s = String(id ?? '')
  if (/^\d+$/u.test(s)) return s.slice(-6)
  let h = 5381
  for (const ch of s) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0
  return h.toString(16).padStart(6, '0').slice(0, 6)
}

/**
 * 来源标签：别的 Agent 通过 putEntry 写进来的算「工具」；
 * 联想/规律/归档这类二次加工出来的算「笔记」；其余是本人对话。
 *
 * @param {{u?:string, owner?:string}} row 条目
 * @returns {string}
 */
export function sourceTag(row) {
  if (String(row?.owner ?? '').trim() !== '') return '工具'
  return /^（(?:联想|规律|归档)/u.test(String(row?.u ?? '')) ? '笔记' : '对话'
}

/**
 * 用查询词在原文里定位，取命中位置前后共 N 字的逐字原句（不改写、不加省略号）。
 * 找不到就从头取 N 字——宁可给个开头，也别给一句编的。
 *
 * @param {string} text 原文（用户侧 + 助手侧拼起来的那份）
 * @param {string} keyword 查询词
 * @returns {string}
 */
export function quoteOf(text, keyword) {
  const t = String(text ?? '').replace(/\s+/gu, ' ')
  const kw = String(keyword ?? '').trim()
  const idx = kw === '' ? -1 : t.indexOf(kw)
  if (idx < 0) return t.slice(0, RECALL_QUOTE_CHARS)
  const start = Math.max(0, Math.round(idx + kw.length / 2 - RECALL_QUOTE_CHARS / 2))
  return t.slice(start, start + RECALL_QUOTE_CHARS)
}

/** 排序分：保留一位小数。是排序用的相对分，不是概率。 */
export function cardScore(score) {
  return (Math.round((Number(score) || 0) * 10) / 10).toFixed(1)
}

/** 六字段拼成一行。字段少了就把那一段留空，不补占位符。 */
const renderCard = (f) => [
  `#${f.id}`,
  f.tag,
  f.score,
  f.time,
  `${f.summary}｜「${f.quote}」`,
].filter((x) => x !== '').join(' ')

/**
 * 六字段证据卡：`id / tag / score / summary / time / quote` 一行说完一条记忆，正文另读。
 *
 * 整卡超过 RECALL_CARD_MAX 时按 tag → summary → quote 的顺序逐字缩；
 * 缩到三个字段都空了还超，就整条丢掉（返回空串）——宁可少一条，也不给模型一段没有信息量的卡。
 *
 * @param {object} row 条目（id/u/a/t/w/owner）
 * @param {{keyword?:string, score?:number, now?:number, max?:number}} [opts]
 *   `max` 是整卡字数上限，默认 RECALL_CARD_MAX；留着是为了把「缩到多小仍成立」测出来。
 * @returns {string} 卡片行；丢掉的条目返回空串
 */
export function cardLine(row, opts = {}) {
  const u = String(row?.u ?? '')
  const a = String(row?.a ?? '')
  const f = {
    id: shortId(row?.id),
    tag: sourceTag(row),
    score: cardScore(opts.score ?? row?.w),
    time: localStamp(Number(row?.t) || opts.now || Date.now()).slice(5),
    summary: clampText(a !== '' ? a : u, RECALL_LINE_CAP),
    quote: quoteOf(`${u}\n${a}`, opts.keyword),
  }
  const max = Number(opts.max) > 0 ? Number(opts.max) : RECALL_CARD_MAX
  let line = renderCard(f)
  while (line.length > max) {
    const field = ['tag', 'summary', 'quote'].find((k) => f[k] !== '')
    if (field === undefined) return ''
    f[field] = f[field].slice(0, -1)
    line = renderCard(f)
  }
  return line
}
