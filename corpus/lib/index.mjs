/**
 * dsh-group-corpus —— 群聊语料
 *
 * 这一层只做接线：采集、落库、风格画像、工具、端点。
 * 分类与统计的纯函数在 core.mjs。
 *
 * @module dsh-group-corpus
 */

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

/**
 * 模型侧工具工厂。DSH 自带，拿不到就退化成只有 HTTP 端点——
 * 插件照旧跑，只是模型没法自己调。
 */
let defineTool = null
try {
  ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch { /* 没有 dsh-tools 就不注册工具 */ }

import {
  DEFAULT_DIR, DB_FILE, JSONL_FILE, STYLE_FILE,
  DEFAULT_AI_IDS, DEFAULT_HUMAN_IDS, AI_FEATURES, HUMAN_FEATURES,
  classifySender, cleanText, analyzeStyle, renderStyleHint, searchMessages, corpusStats,
} from './core.mjs'
import { localStamp } from './shared.mjs'
export {
  classifySender, cleanText, analyzeStyle, renderStyleHint, searchMessages, corpusStats,
} from './core.mjs'

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
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-group-corpus/history',
        handler: (req, res) => {
          if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return }
          const url = new URL(req.url ?? '/', 'http://dsh.invalid')
          const param = (k) => url.searchParams.get(k)
          const sinceDays = Number(param('sinceDays'))
          const result = searchMessages(db, {
            keyword: param('keyword') ?? '',
            sender: param('sender') ?? '',
            kind: param('kind') ?? 'any',
            sinceDays: Number.isFinite(sinceDays) ? sinceDays : undefined,
            limit: param('limit'),
            order: param('order') ?? 'desc',
          })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            ...result,
            messages: result.messages.map((m) => ({ ...m, day: localStamp(m.at) })),
            ...(param('stats') === '1' ? { stats: corpusStats(db) } : {}),
          }))
        },
      }),
    ], 'dsh-group-corpus: routes')
  })

  // 启动时若有数据，先算一次
  setTimeout(() => { try { rebuildStyle() } catch { /* 忽略 */ } }, 5000)

  // 模型可调用的只读工具：让「自己翻群档」成为正经能力
  registerHistoryTool(ctx, db)

  ctx.effect(() => () => { try { db.close() } catch { /* 忽略 */ } }, 'dsh-group-corpus: close')
}

export const name = 'dsh-group-corpus'

/**
 * 注册模型可调用的只读工具 `group_history`。
 *
 * 有了它，「自己翻群档」就是正经能力，不是拿 bash 去 open 那个 sqlite。
 * 只读：没有任何写路径。
 */
function registerHistoryTool(ctx, db) {
  if (defineTool === null) return
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(() => toolsCtx.tools.register(defineTool({
      name: 'group_history',
      description: 'Read the archived QQ group history. Use it to recall what was said earlier, who said it, or to check whether a topic came up before. Read-only.',
      parameters: {
        keyword: {
          type: 'string',
          description: 'Only messages whose text contains this substring.',
        },
        sender: {
          type: 'string',
          description: 'Only messages whose sender name contains this substring.',
        },
        kind: {
          type: 'string',
          enum: ['any', 'human', 'ai'],
          description: 'Restrict to human messages, AI messages, or both. Defaults to any.',
        },
        sinceDays: {
          type: 'number',
          description: 'Only messages from the last N days.',
        },
        limit: {
          type: 'number',
          description: 'Maximum messages to return, 1-200. Defaults to 30.',
        },
        order: {
          type: 'string',
          enum: ['desc', 'asc'],
          description: 'Newest first (desc, default) or oldest first (asc).',
        },
        stats: {
          type: 'boolean',
          description: 'Also return the corpus overview: time span, per-day counts, top senders.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            total: { type: 'number', required: true, description: 'Matching messages in the archive.' },
            shown: { type: 'number', required: true, description: 'Messages returned in this response.' },
            messages: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  at: { type: 'number', required: true, description: 'Unix milliseconds.' },
                  day: { type: 'string', required: true, description: 'Local YYYY-MM-DD HH:mm.' },
                  sender: { type: 'string', required: true },
                  kind: { type: 'string', required: true, description: 'human or ai.' },
                  text: { type: 'string', required: true },
                },
              },
            },
            stats: { type: 'object', additionalProperties: true },
          },
        },
        render: (_args, value) => {
          const lines = value.messages.length === 0
            ? [`没有匹配的消息（库里有 ${value.total} 条符合条件）。`]
            : [`共 ${value.total} 条匹配，返回 ${value.shown} 条：`, ...value.messages.map(
              (m) => `[${m.day}] ${m.sender}(${m.kind}): ${m.text}`,
            )]
          // 要了概况就得给出来，否则等于没要。
          if (value.stats) {
            const s = value.stats
            lines.push('', `概况：${s.total} 条，${formatSpan(s)}`)
            if (s.byDay.length > 0) {
              lines.push(`每天：${s.byDay.map((d) => `${d.day} ${d.count}`).join(' · ')}`)
            }
            if (s.bySender.length > 0) {
              lines.push(`发言最多的：${s.bySender.slice(0, 5).map((x) => `${x.name} ${x.count}`).join(' · ')}`)
            }
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      execute(args) {
        const result = searchMessages(db, args)
        const out = {
          total: result.total,
          shown: result.shown,
          messages: result.messages.map((m) => ({
            at: m.at,
            day: localStamp(m.at),
            sender: m.sender,
            kind: m.kind,
            text: m.text,
          })),
        }
        if (args.stats === true) out.stats = corpusStats(db)
        return out
      },
    })), 'dsh-group-corpus: history tool')
  })
}

/**
 * 把概况的时间跨度写成人话。
 * @param {{firstAt:number|null,lastAt:number|null}} s
 * @returns {string}
 */
function formatSpan(s) {
  if (!s.firstAt || !s.lastAt) return '库里还是空的'
  return `${localStamp(s.firstAt)} 到 ${localStamp(s.lastAt)}`
}

/** 本地时区的 YYYY-MM-DD HH:mm。 */
