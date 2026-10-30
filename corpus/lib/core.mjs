/**
 * 语料的判定核心：分类、清洗、风格统计、查询统计。
 *
 * 全是纯函数（查询那两条只读 db），接线留在 index.mjs。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_DIR = join(homedir(), '.dsh', 'group-corpus')
export const DB_FILE = 'corpus.db'
export const JSONL_FILE = 'messages.jsonl'
export const STYLE_FILE = 'style-profile.json'

/** 已知的 AI openid（从群归档实测得出）。 */
export const DEFAULT_AI_IDS = [
  '42FFF41FEA18578BC2EC06861D1930A0', // Miyu (miyu-agent)
  '1C282365D18006B61447EB7ACB963F60', // 大肥鱼（另一条 agent）
]

/** 已确认的真人 openid（从群归档实测）。 */
export const DEFAULT_HUMAN_IDS = [
  '8F0AA3985B0632ACDFE34F4778F881D1', // ljm_QvQ
  'D073B690D65940C7601F32AC0DCE0F38', // 梁 / 大肥鱼（同一人切换）
  '1F7AF24BA5272BD93E0C12506F4DC80D', // 辛会
  'A0E7134000EF4DA19722C820EA7EAA1E', // 白磷
  '4AC8E018B54B5B9438FA7F0DF5BE3646', // LinorInk
  '4B7F7DACABE4917BF7429CA216B34A6D', // 星羽テンゲン
  '95893600BDCA207E6D05AC03756AE3E9', // 子鱼
]

/** AI 文本特征权重。命中越多越可能是 AI。 */
export const AI_FEATURES = [
  { name: 'table', test: (t) => /\|[^\n]*\|/u.test(t), weight: 3 },
  { name: 'code-block', test: (t) => t.includes('```'), weight: 4 },
  { name: 'md-link', test: (t) => /\[[^\]]+\]\(https?:/u.test(t), weight: 2 },
  { name: 'bold-heavy', test: (t) => (t.match(/\*\*/gu) ?? []).length >= 3, weight: 2 },
  { name: 'very-long', test: (t) => t.length > 800, weight: 2 },
  { name: 'perfect-punct', test: (t) => t.length > 100 && /[。！？]$/u.test(t) && !/[\u4e00-\u9fa5]{1,3}。/u.test(t), weight: 1 },
  { name: 'ai-self-ref', test: (t) => /(我是.{0,6}(AI|助手|机器人|模型))|(作为.{0,6}(AI|助手))/u.test(t), weight: 5 },
]

/** 真人特征（用于反向确认，权重更高）。 */
export const HUMAN_FEATURES = [
  { name: 'typo-or-colloquial', test: (t) => /(卧槽|草|诶|哎|哈哈|嗯|啊|哦|嘛|呀|啦|吧)$/u.test(t), weight: 2 },
  { name: 'very-short', test: (t) => t.length <= 6, weight: 1 },
  { name: 'emoji-only', test: (t) => /^[\u{1F300}-\u{1FAFF}\u2600-\u27BF\s]+$/u.test(t), weight: 3 },
  { name: 'no-ending-punct', test: (t) => t.length > 10 && t.length < 200 && !/[。！？.!?]$/u.test(t), weight: 1 },
]

/**
 * 判定一条消息的发送者类型。
 *
 * 顺序：显式白名单 > 文本特征评分 > 回退为 unknown。
 *
 * @param {object} msg {senderId, text}
 * @param {object} cfg {aiIds: string[], humanIds: string[]}
 * @returns {{kind: 'ai'|'human'|'unknown', score: number, reasons: string[]}}
 */
export function classifySender(msg, cfg) {
  const sid = String(msg.senderId ?? '')
  const text = String(msg.text ?? '')

  // 白名单优先：AI 名单先查，真人名单次之。两者都是显式事实，胜过任何文本猜测。
  if (cfg.aiIds.includes(sid)) return { kind: 'ai', score: 99, reasons: ['openid-whitelist'] }
  if (cfg.humanIds.includes(sid)) return { kind: 'human', score: -99, reasons: ['openid-whitelist'] }

  // 未知 openid 才走特征判断；且此时默认当「未知」而不是「真人」，
  // 因为往上加语料时，宁可标 unknown 也不要把 AI 的话学成真人。
  if (text === '') return { kind: 'unknown', score: 0, reasons: ['empty'] }

  let aiScore = 0
  const reasons = []
  for (const f of AI_FEATURES) {
    if (f.test(text)) { aiScore += f.weight; reasons.push(`+${f.name}`) }
  }

  if (aiScore >= 6) return { kind: 'ai', score: aiScore, reasons: [...reasons, 'heuristic-strong'] }

  let humanScore = 0
  for (const f of HUMAN_FEATURES) {
    if (f.test(text)) { humanScore += f.weight; reasons.push(`-${f.name}`) }
  }

  // 真人特征明显 → 判真人
  if (humanScore >= 2 && aiScore < 3) {
    return { kind: 'human', score: aiScore - humanScore, reasons: [...reasons, 'heuristic-human'] }
  }

  // 其余：未知。宁可标 none，也不要污染真人语料。
  return { kind: 'unknown', score: aiScore - humanScore, reasons: [...reasons, 'unresolved'] }
}

/**
 * 清洗语料文本：去掉 @ 标记、表情标签、控制字符。
 *
 * 不做清洗的话，``<@FACE6559…>`` 的尾巴会统计成高频「句尾」，
 * 学出来的风格全是噪声。
 *
 * @param {string} text
 * @returns {string}
 */
export function cleanText(text) {
  return String(text ?? '')
    // <@OPENID> 和 @昵称
    .replace(/<@!?[0-9A-Fa-f]{20,}>/gu, '')
    .replace(/@[\w\u4e00-\u9fa5·]+(?=\s|$)/gu, '')
    // <faceType=..,faceId="..",ext=".."> 这类表情标签
    .replace(/<faceType=[^>]*>/gu, '')
    // 残留的尖括号片段
    .replace(/<[^<>]{0,40}>/gu, '')
    // 控制字符
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    // 多余空白
    .replace(/\s+/gu, ' ')
    .trim()
}

/** 从真人语料里提取说话风格特征。 */
export function analyzeStyle(messages) {
  const human = messages.filter((m) => m.kind === 'human')
  if (human.length === 0) return null

  const texts = human
    .map((m) => cleanText(m.text))
    .filter((t) => t.length >= 2)          // 清洗后太短的（纯 @、纯表情）不要
  if (texts.length === 0) return null

  const lens = texts.map((t) => t.length).sort((a, b) => a - b)
  const pct = (p) => lens[Math.floor(lens.length * p)] ?? 0

  const count = (re) => texts.filter((t) => re.test(t)).length
  const total = texts.length

  // 常用语气词（结尾）：只取纯中文的两字尾，排除符号和字母
  const tailWords = new Map()
  for (const t of texts) {
    const tail = t.slice(-2)
    if (!/^[\u4e00-\u9fa5]{2}$/u.test(tail)) continue
    tailWords.set(tail, (tailWords.get(tail) ?? 0) + 1)
  }
  // 只排掉话题名词，保留真正的语气词。
  // 「肥鱼」「表情包」这类是群里聊的话题，学来没意义；「了吗」「一下」这种才是语气。
  const TOPIC_TAILS = new Set([
    '肥鱼', '表情', '情包', '消息', '聊天', '东西', '问题',
  ])
  const topTails = [...tailWords.entries()]
    .filter(([w, n]) => n >= 3 && !TOPIC_TAILS.has(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w, n]) => ({ word: w, count: n }))

  return {
    sampleSize: total,
    length: {
      median: pct(0.5), p25: pct(0.25), p75: pct(0.75), max: lens[lens.length - 1] ?? 0,
    },
    punctuation: {
      noEndingPunctPct: +(count(/[^。！？.!?]$/u) / total * 100).toFixed(1),
      usesExclaim: +(count(/[！!]/u) / total * 100).toFixed(1),
      usesQuestion: +(count(/[？?]/u) / total * 100).toFixed(1),
      usesEllipsis: +(count(/(\.\.\.|…)/u) / total * 100).toFixed(1),
    },
    markdown: {
      usesBold: +(count(/\*\*/u) / total * 100).toFixed(1),
      usesList: +(count(/^\s*[-*]\s/mu) / total * 100).toFixed(1),
      usesCode: +(count(/`/u) / total * 100).toFixed(1),
      usesTable: +(count(/\|/u) / total * 100).toFixed(1),
    },
    commonTails: topTails,
    generatedAt: Date.now(),
  }
}

/** 把 style profile 渲染成可注入的提示词片段。 */
export function renderStyleHint(style, exemplars = []) {
  if (!style) return ''
  const { length, punctuation, markdown, commonTails } = style
  const lines = [
    '## 群聊说话风格参考',
    `（基于群内 ${style.sampleSize} 条真人发言统计，不是硬性规则，仅供参考）`,
    '',
    `- 长度：中位数 ${length.median} 字，一半的消息在 ${length.p25}~${length.p75} 字之间`,
    `- 句末不加标点的占 ${punctuation.noEndingPunctPct}%，用感叹号 ${punctuation.usesExclaim}%，用问号 ${punctuation.usesQuestion}%`,
    `- 几乎不用 Markdown：加粗 ${markdown.usesBold}%，代码 ${markdown.usesCode}%，表格 ${markdown.usesTable}%`,
  ]
  if (commonTails.length > 0) {
    const tails = commonTails.map((t) => `「${t.word}」`).join('、')
    lines.push(`- 常见句尾：${tails}`)
  }
  lines.push('', '要求：像群里的人那样说话。别端着，别用表格和列表，短句为主。')

  // 范例：这是「学说话」的关键——统计告诉你怎么说，范例告诉你什么味道
  const ex = (exemplars ?? []).filter((e) => e && typeof e.text === 'string' && e.text.length > 0).slice(0, 4)
  if (ex.length > 0) {
    lines.push('', '群里真人说话的实例（学它们的语气，不要照抄内容）：')
    for (const e of ex) lines.push(`- ${e.text}`)
  }

  return lines.join('\n')
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
/**
 * 按条件翻群档。只读。
 *
 * @param {DatabaseSync} db 语料库
 * @param {object} opts
 * @param {string} [opts.keyword] 正文关键词
 * @param {string} [opts.sender] 发言人名字片段
 * @param {'any'|'human'|'ai'} [opts.kind] 只看真人或只看 AI
 * @param {number} [opts.sinceDays] 最近几天
 * @param {number} [opts.since] 起始时间（毫秒时间戳）
 * @param {number} [opts.until] 截止时间（毫秒时间戳）
 * @param {'asc'|'desc'} [opts.order] 时间顺序，默认新到旧
 * @param {number} [opts.limit] 最多几条，1–200，默认 30
 * @returns {{total:number, shown:number, messages:Array<{at:number,sender:string,kind:string,text:string}>}}
 */
export function searchMessages(db, opts = {}) {
  const where = []
  const args = []

  const kind = opts.kind ?? 'any'
  if (kind === 'human' || kind === 'ai') {
    where.push('kind = ?')
    args.push(kind)
  }

  const keyword = String(opts.keyword ?? '').trim()
  if (keyword !== '') {
    where.push('text LIKE ?')
    args.push(`%${keyword}%`)
  }

  const sender = String(opts.sender ?? '').trim()
  if (sender !== '') {
    where.push('sender_name LIKE ?')
    args.push(`%${sender}%`)
  }

  const days = Number(opts.sinceDays)
  if (Number.isFinite(days) && days > 0) {
    where.push('sent_at >= ?')
    args.push(Date.now() - days * 86_400_000)
  }

  for (const key of ['since', 'until']) {
    const value = Number(opts[key])
    if (!Number.isFinite(value) || value <= 0) continue
    where.push(`sent_at ${key === 'since' ? '>=' : '<='} ?`)
    args.push(value)
  }

  const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 30))
  const descending = (opts.order ?? 'desc') !== 'asc'

  const total = db.prepare(`SELECT COUNT(*) c FROM messages ${clause}`).get(...args).c
  const rows = db.prepare(
    `SELECT sender_name, kind, text, sent_at FROM messages ${clause}
     ORDER BY sent_at ${descending ? 'DESC' : 'ASC'} LIMIT ?`,
  ).all(...args, limit)

  return {
    total,
    shown: rows.length,
    messages: rows.map((r) => ({
      at: r.sent_at,
      sender: String(r.sender_name ?? ''),
      kind: String(r.kind ?? ''),
      text: String(r.text ?? '').slice(0, 500),
    })),
  }
}

/**
 * 群档的整体概况：时间跨度、每天多少条、谁说了多少。
 *
 * @param {DatabaseSync} db 语料库
 * @returns {object}
 */
export function corpusStats(db) {
  const span = db.prepare('SELECT MIN(sent_at) a, MAX(sent_at) b, COUNT(*) n FROM messages').get()
  const byDay = db.prepare(`
    SELECT strftime('%Y-%m-%d', sent_at / 1000, 'unixepoch', 'localtime') d, COUNT(*) c
    FROM messages GROUP BY d ORDER BY d
  `).all()
  const bySender = db.prepare(`
    SELECT sender_name, kind, COUNT(*) c FROM messages
    GROUP BY sender_name, kind ORDER BY c DESC LIMIT 20
  `).all()

  return {
    total: span.n,
    firstAt: span.a,
    lastAt: span.b,
    byDay: byDay.map((r) => ({ day: r.d, count: r.c })),
    bySender: bySender.map((r) => ({ name: r.sender_name, kind: r.kind, count: r.c })),
  }
}
