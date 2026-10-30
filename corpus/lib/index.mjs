/**
 * dsh-group-corpus — 群聊语料采集与说话风格学习
 *
 * 三件事：
 *   1. 接收群里**所有**消息（不只 @ 我的），落盘到 JSONL + SQLite
 *   2. 分清**真人**和 **AI**：openid 白名单 + 文本特征启发式
 *   3. 从真人语料里学习说话风格，产出可注入的 style profile
 *
 * 为什么不直接用 dsh-im 的归档：
 *   那个库是插件内部用的，只存「实际投递的消息」，且不区分人和 AI。
 *   这个插件用自己的库，专门为「学说话」优化。
 *
 * @module dsh-group-corpus
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'

const DEFAULT_DIR = join(homedir(), '.dsh', 'group-corpus')
const DB_FILE = 'corpus.db'
const JSONL_FILE = 'messages.jsonl'
const STYLE_FILE = 'style-profile.json'

/** 已知的 AI openid（从群归档实测得出）。 */
const DEFAULT_AI_IDS = [
  '42FFF41FEA18578BC2EC06861D1930A0', // Miyu (miyu-agent)
  '1C282365D18006B61447EB7ACB963F60', // 大肥鱼（另一条 agent）
]

/** 已确认的真人 openid（从群归档实测）。 */
const DEFAULT_HUMAN_IDS = [
  '8F0AA3985B0632ACDFE34F4778F881D1', // ljm_QvQ
  'D073B690D65940C7601F32AC0DCE0F38', // 梁 / 大肥鱼（同一人切换）
  '1F7AF24BA5272BD93E0C12506F4DC80D', // 辛会
  'A0E7134000EF4DA19722C820EA7EAA1E', // 白磷
  '4AC8E018B54B5B9438FA7F0DF5BE3646', // LinorInk
  '4B7F7DACABE4917BF7429CA216B34A6D', // 星羽テンゲン
  '95893600BDCA207E6D05AC03756AE3E9', // 子鱼
]

/** AI 文本特征权重。命中越多越可能是 AI。 */
const AI_FEATURES = [
  { name: 'table', test: (t) => /\|[^\n]*\|/u.test(t), weight: 3 },
  { name: 'code-block', test: (t) => t.includes('```'), weight: 4 },
  { name: 'md-link', test: (t) => /\[[^\]]+\]\(https?:/u.test(t), weight: 2 },
  { name: 'bold-heavy', test: (t) => (t.match(/\*\*/gu) ?? []).length >= 3, weight: 2 },
  { name: 'very-long', test: (t) => t.length > 800, weight: 2 },
  { name: 'perfect-punct', test: (t) => t.length > 100 && /[。！？]$/u.test(t) && !/[\u4e00-\u9fa5]{1,3}。/u.test(t), weight: 1 },
  { name: 'ai-self-ref', test: (t) => /(我是.{0,6}(AI|助手|机器人|模型))|(作为.{0,6}(AI|助手))/u.test(t), weight: 5 },
]

/** 真人特征（用于反向确认，权重更高）。 */
const HUMAN_FEATURES = [
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
export function apply(ctx, config = {}) {
  const dir = (() => {
    const raw = String(config.corpusPath ?? '').trim()
    if (raw === '') return DEFAULT_DIR
    return isAbsolute(raw) ? raw : resolve(DEFAULT_DIR, raw)
  })()
  mkdirSync(dir, { recursive: true })

  const db = new DatabaseSync(join(dir, DB_FILE))
  const jsonl = join(dir, JSONL_FILE)

  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS messages (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      platform_id TEXT,
      sender_id TEXT NOT NULL,
      sender_name TEXT,
      kind      TEXT NOT NULL,
      score     INTEGER,
      reasons   TEXT,
      text      TEXT,
      sent_at   INTEGER NOT NULL,
      ingested_at INTEGER NOT NULL,
      UNIQUE(platform_id)
    );
    CREATE INDEX IF NOT EXISTS idx_kind ON messages(kind, sent_at);
    CREATE TABLE IF NOT EXISTS config (
      k TEXT PRIMARY KEY, v TEXT
    );
  `)

  // 允许通过 config 覆盖白名单
  const aiIds = Array.isArray(config.aiIds) && config.aiIds.length > 0
    ? config.aiIds.map(String)
    : DEFAULT_AI_IDS
  const humanIds = Array.isArray(config.humanIds) && config.humanIds.length > 0
    ? config.humanIds.map(String)
    : DEFAULT_HUMAN_IDS
  const cfg = { aiIds, humanIds }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages
      (platform_id, sender_id, sender_name, kind, score, reasons, text, sent_at, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  /** 写入一条消息：JSONL 追加 + SQLite 插入。 */
  const ingest = (msg) => {
    const text = String(msg.text ?? '').trim()
    if (text === '') return false

    const verdict = classifySender({ senderId: msg.senderId, text }, cfg)
    const row = {
      platform_id: String(msg.platformMessageId ?? msg.id ?? ''),
      sender_id: String(msg.senderId ?? ''),
      sender_name: String(msg.senderName ?? ''),
      kind: verdict.kind,
      score: verdict.score,
      reasons: verdict.reasons.join(' '),
      text,
      sent_at: Number(msg.sentAt ?? Date.now()),
      ingested_at: Date.now(),
    }

    insert.run(
      row.platform_id, row.sender_id, row.sender_name, row.kind, row.score,
      row.reasons, row.text, row.sent_at, row.ingested_at,
    )
    appendFileSync(jsonl, `${JSON.stringify(row)}\n`, 'utf8')
    return true
  }

  // ---- 挂到 dsh-im 的消息流 ----
  //
  // 实测的真实结构是**两条消息**：
  //   1. source.kind = 'plugin:dsh-im'，内容是 <dsh_im_source>{...}</dsh_im_source>
  //   2. source.kind = 'user'，内容是这个人真正说的话
  //
  // 所以要跨两条配对：先记住元数据，等下一条 user 消息来了再落库。
  let pendingMeta = null

  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'user/message') return
    const msg = event.data ?? {}
    const source = msg.source
    if (!source) return

    const text = Array.isArray(msg.content)
      ? msg.content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n')
      : ''

    // 第一段：IM 元数据
    if (source.kind === 'plugin:dsh-im') {
      const m = text.match(/<dsh_im_source>([\s\S]*?)<\/dsh_im_source>/u)
      if (!m) return
      try {
        const meta = JSON.parse(m[1])
        if (meta.conversationType === 'group') {
          pendingMeta = { meta, at: Date.now() }
        }
      } catch { /* 解析失败忽略 */ }
      return
    }

    // 第二段：真正的话
    if (source.kind === 'user' && pendingMeta) {
      // 超过 10 秒的配对视为过期，避免错配
      if (Date.now() - pendingMeta.at > 10_000) { pendingMeta = null; return }
      const body = text.replace(/<dsh_im_source>[\s\S]*?<\/dsh_im_source>/u, '').trim()
      const { meta } = pendingMeta
      pendingMeta = null
      if (body === '') return

      ingest({
        platformMessageId: msg.id,
        senderId: meta.senderId,
        senderName: meta.senderName,
        text: body,
        sentAt: Date.now(),
      })
    }
  })

  // ---- 定时重算风格画像 ----
  const rebuildStyle = () => {
    const rows = db.prepare('SELECT kind, text FROM messages WHERE kind IN (\'human\',\'ai\') ORDER BY sent_at DESC LIMIT 2000').all()
    const style = analyzeStyle(rows.map((r) => ({ kind: r.kind, text: r.text })))
    if (style) {
      const tmp = join(dir, `${STYLE_FILE}.tmp`)
      writeFileSync(tmp, JSON.stringify(style, null, 2), 'utf8')
      renameSync(tmp, join(dir, STYLE_FILE))
    }
    return style
  }

  // ---- 风格注入：每轮首步把真人说话特征塞进上下文 ----
  ctx.on('agent/pre-step', async ({ step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || step !== 1 || signal?.aborted) return decision

    const stylePath = join(dir, STYLE_FILE)
    if (!existsSync(stylePath)) return decision

    let style
    try { style = JSON.parse(readFileSync(stylePath, 'utf8')) } catch { return decision }
    // 样本太少不注入，免得学歪
    if (!style || style.sampleSize < 30) return decision

    // 读范例（可能不存在，不存在就只用统计）
    let exemplars = []
    try {
      const ep = join(dir, 'exemplars.json')
      if (existsSync(ep)) exemplars = JSON.parse(readFileSync(ep, 'utf8')).exemplars ?? []
    } catch { /* 忽略 */ }

    const hint = renderStyleHint(style, exemplars)
    if (hint === '') return decision

    return {
      ...decision,
      messages: [...decision.messages, {
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `（${hint}）` }],
        source: { kind: 'group-corpus', form: 'notice', summary: '说话风格参考' },
      }],
    }
  }, { prepend: true })

  // ---- 状态与手动重建端点 ----
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => [
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-group-corpus/status',
        handler: (req, res) => {
          const counts = {}
          for (const r of db.prepare('SELECT kind, COUNT(*) c FROM messages GROUP BY kind').all()) counts[r.kind] = r.c
          const stylePath = join(dir, STYLE_FILE)
          let style = null
          try { if (existsSync(stylePath)) style = JSON.parse(readFileSync(stylePath, 'utf8')) } catch { /* 忽略 */ }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            dir, jsonl, dbPath: join(dir, DB_FILE),
            counts, total: Object.values(counts).reduce((a, b) => a + b, 0),
            style: style ? {
              sampleSize: style.sampleSize,
              median: style.length.median,
              noEndingPunct: style.punctuation.noEndingPunctPct,
            } : null,
          }))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-group-corpus/rebuild',
        handler: (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST' }).end()
            return
          }
          const style = rebuildStyle()
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, style }))
        },
      }),
    ], 'dsh-group-corpus: routes')
  })

  // 启动时若有数据，先算一次
  setTimeout(() => { try { rebuildStyle() } catch { /* 忽略 */ } }, 5000)

  ctx.effect(() => () => { try { db.close() } catch { /* 忽略 */ } }, 'dsh-group-corpus: close')
}

export const name = 'dsh-group-corpus'
