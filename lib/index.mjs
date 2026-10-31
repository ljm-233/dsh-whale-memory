/**
 * dsh-whale-memory —— 记忆本体
 *
 * 这一层只做「接线」：把存储、语言、网页、日记、工具、路由串起来，
 * 具体实现都在同目录的模块里。功能与拆分前完全一致。
 *
 * @module dsh-whale-memory
 */

import { DatabaseSync } from 'node:sqlite'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Resolver } from 'node:dns'
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute, dirname } from 'node:path'

import { sweep as biliReportSweep } from './bili-report-watch.mjs'
import { heal as runSelfHeal } from './selfheal.mjs'

import {
  DEFAULT_MEMORY_DIR, DB_FILE, EMBED_URL, EMBED_DIMS, EMBED_TIMEOUT_MS,
  MEMORY_BUDGET_CHARS, RECENT_PAIRS, RECALL_MAX, FACT_MAX, PART_CAP, COLD_MAX,
  IMPORTANT_WEIGHT, WEIGHT_DECAY_PER_TURN, WEIGHT_MAX, BACKUP_KEEP, BACKUP_CHECK_MS,
  EVENT_MAX, DIARY_HOUR, DIARY_INJECT_MAX, DIARY_MAX_CHARS, IM_PART_CHARS, IM_MAX_PARTS,
  RECALL_THRESHOLD, PLUGIN_VERSION,
} from './constants.mjs'
export {
  detectEmotions, cueWords, bigrams, overlap, cosine, extractFacts, similarity, scoreMemory,
} from './language.mjs'
import {
  detectEmotions, cueWords, cosine, extractFacts, scoreMemory,
} from './language.mjs'

export { readPage, htmlToText } from './web.mjs'
export { localStamp, clamp, textOf, buildArchiveDoc, splitForIm } from './format.mjs'
export { readPolicy, writePolicy, parseJudgement } from './policy.mjs'
export { recentEvents } from './events.mjs'
export { searchEntries, putEntry, correctEntry, retractEntry } from './entries.mjs'
export { pairShadowed, isPrivateSession } from './session.mjs'

import { localStamp, clamp, textOf } from './format.mjs'
import { dayKeyOf as sharedDayKey } from './shared.mjs'
import { readPolicy } from './policy.mjs'
import { recentEvents } from './events.mjs'
import { searchEntries, putEntry, correctEntry, retractEntry } from './entries.mjs'
import { pairShadowed, isPrivateSession } from './session.mjs'
import { readPage } from './web.mjs'
import { vecToBlob, blobToVec, embedTexts } from './vector.mjs'
import { windowOf } from './session.mjs'
import { registerTools } from './tools.mjs'
import { registerRoutes } from './routes.mjs'
import { createBackup } from './backup.mjs'
import { createDiary } from './diary.mjs'
import { createSalvage } from './salvage.mjs'
import { createPromptSections } from './prompt.mjs'
import { createRecall } from './recall.mjs'
import { createWriter } from './writer.mjs'
import { createConsolidator } from './consolidate.mjs'

export function apply(ctx, config = {}) {
  const memoryDir = (() => {
    const raw = String(config.memoryPath ?? '').trim()
    if (raw === '') return DEFAULT_MEMORY_DIR
    return isAbsolute(raw) ? raw : resolve(DEFAULT_MEMORY_DIR, raw)
  })()
  const dbPath = join(memoryDir, DB_FILE)

  /** 读一项配置：声明了 .volatile() 的字段是活引用，每次都要 .get() 才拿到当前值。 */
  const cfgVal = (v, fallback) => (v && typeof v.get === 'function' ? (v.get() ?? fallback) : (v ?? fallback))

  // 可热改的参数：每次用时现读，设置页改完立刻生效，不用重启。
  const budgetChars = () => cfgVal(config.budgetChars, MEMORY_BUDGET_CHARS)
  const recentPairs = () => cfgVal(config.recentPairs, RECENT_PAIRS)
  const recallMax = () => cfgVal(config.recallMax, RECALL_MAX)
  const recallThreshold = () => cfgVal(config.recallThreshold, RECALL_THRESHOLD)
  const weightMax = () => cfgVal(config.weightMax, WEIGHT_MAX)
  const factMax = () => cfgVal(config.factMax, FACT_MAX)

  // 压缩存档：把「压缩摘要 + 被压缩掉的聊天记录」汇成一份 Markdown 落盘，并私发主人。
  /** 本地日期键：给 backup 模块用。 */
  const dayOf = sharedDayKey
  const backupCfg = () => (config.backup && typeof config.backup === 'object' ? config.backup : {})

  const diaryCfg = () => (config.diary && typeof config.diary === 'object' ? config.diary : {})
  const diaryEnabled = () => cfgVal(diaryCfg().enabled, true) !== false
  const diaryHour = () => Math.min(23, Math.max(0, cfgVal(diaryCfg().hour, DIARY_HOUR)))

  const archiveCfg = () => (config.archive && typeof config.archive === 'object' ? config.archive : {})
  const archiveEnabled = () => cfgVal(archiveCfg().enabled, true) !== false
  const archiveDir = () => {
    const raw = String(cfgVal(archiveCfg().dir, '') ?? '').trim()
    if (raw === '') return join(memoryDir, 'archives')
    return isAbsolute(raw) ? raw : resolve(memoryDir, raw)
  }
  const archiveNotify = () => ({
    enabled: cfgVal(archiveCfg().notify, true) !== false,
    botId: String(cfgVal(archiveCfg().botId, '') ?? '').trim(),
    targetId: String(cfgVal(archiveCfg().targetId, '') ?? '').trim(),
  })

  mkdirSync(memoryDir, { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS entries (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      u       TEXT NOT NULL,
      a       TEXT NOT NULL,
      t       INTEGER NOT NULL,
      w       REAL NOT NULL DEFAULT 1,
      emo     TEXT NOT NULL DEFAULT '[]',
      vec     BLOB,
      hot     INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_entries_hot ON entries(hot, t);
    CREATE TABLE IF NOT EXISTS facts (
      id  INTEGER PRIMARY KEY AUTOINCREMENT,
      f   TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS stats (
      k TEXT PRIMARY KEY,
      v INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS diary (
      day        TEXT PRIMARY KEY,
      text       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    -- 修正记录：改掉的那条原样留在这里，主表只放当下的真相。
    CREATE TABLE IF NOT EXISTS revisions (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id  INTEGER NOT NULL,
      action    TEXT NOT NULL,
      before_u  TEXT NOT NULL,
      before_a  TEXT NOT NULL,
      after_u   TEXT,
      after_a   TEXT,
      reason    TEXT NOT NULL DEFAULT '',
      at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_revisions_entry ON revisions(entry_id);
    -- 跨窗口的近期事件：不管哪个会话、哪个工具，都写进同一条线。
    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      at      INTEGER NOT NULL,
      session TEXT NOT NULL,
      window  TEXT NOT NULL DEFAULT '',
      kind    TEXT NOT NULL,
      text    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
    -- 杂项键值：目前放「记忆取舍的倾向」，压缩时参与判断。
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `)

  /**
   * 给已有的表补一列。SQLite 没有 IF NOT EXISTS，只能先问再改。
   *
   * @param {string} table 表名
   * @param {string} column 列名
   * @param {string} ddl 列定义
   */
  const ensureColumn = (table, column, ddl) => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all()
      if (cols.some((c) => c.name === column)) return
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
    } catch { /* 加不上就按没有处理 */ }
  }

  // 谁写的、谁改的：跨 Agent 共享时靠这两列划边界。
  ensureColumn('entries', 'owner', "TEXT NOT NULL DEFAULT ''")
  ensureColumn('revisions', 'actor', "TEXT NOT NULL DEFAULT ''")

  const bumpStat = (k) => {
    db.prepare('INSERT INTO stats(k,v) VALUES(?,1) ON CONFLICT(k) DO UPDATE SET v=v+1').run(k)
  }
  const readStats = () => {
    const rows = db.prepare('SELECT k,v FROM stats').all()
    const out = { merged: 0, recalled: 0, ruminated: 0 }
    for (const r of rows) out[r.k] = r.v
    return out
  }

  // ---- 偏好：由经历长出来的那部分，和写死的底线分开 ----
  const preferencePath = (() => {
    const raw = String(config.preferencePath ?? '').trim()
    if (raw === '') return join(homedir(), '.dsh', 'im', 'memory', 'PREFERENCE.md')
    return isAbsolute(raw) ? raw : resolve(memoryDir, raw)
  })()

  /** 读偏好文件；读不到就当没有。 */
  const readPreference = () => {
    try {
      return existsSync(preferencePath) ? String(readFileSync(preferencePath, 'utf8')) : ''
    } catch {
      return ''
    }
  }

  /**
   * 覆写偏好。旧版先留一份 `.bak`——偏好可以变，但不能悄悄变。
   *
   * @param {string} text 新内容
   * @returns {string} 存下来的内容
   */
  const writePreference = (text) => {
    const body = String(text ?? '').trim().slice(0, 4000)
    try {
      if (existsSync(preferencePath)) {
        writeFileSync(`${preferencePath}.bak`, String(readFileSync(preferencePath, 'utf8')), 'utf8')
      }
      mkdirSync(dirname(preferencePath), { recursive: true })
      writeFileSync(preferencePath, `${body}\n`, 'utf8')
      bumpStat('preference')
    } catch { /* 写不了就算了 */ }
    return body
  }

  // 提示词两段单独成模块，见 lib/prompt.mjs
  const { personaSection, preferenceSection } = createPromptSections({ readPreference })
  ctx.inject(['systemPrompt'], (spCtx) => {
    spCtx.effect(() => spCtx.systemPrompt.section(personaSection), 'dsh-whale-memory: persona')
    spCtx.effect(() => spCtx.systemPrompt.section(preferenceSection), 'dsh-whale-memory: preference')
  })

  // 记忆注入单独成模块，见 lib/recall.mjs
  const { build: buildRecall } = createRecall({
    db, memoryDir, bumpStat,
    budgetChars, factMax, recentPairs, recallMax, recallThreshold, weightMax,
  })

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || step !== 1 || signal?.aborted) return decision

    const built = await buildRecall({ agent, messages })
    if (built === null) return decision

    const memoryMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: built.text }],
      source: { kind: 'whale-memory', form: 'notice', summary: `记忆注入 ${built.count} 段` },
    }
    return { ...decision, messages: [...decision.messages, memoryMessage] }
  }, { prepend: true })

  // 交互落库单独成模块，见 lib/writer.mjs
  const writer = createWriter({ db, bumpStat, recentPairs, factMax })
  const flush = writer.flush

  /**
   * 调一次模型，只取文本。失败返回 null（调用方自行兜底）。
   *
   * 调用范式见 RULES.md 第 5 节：prepareCall 传 config 且控制项在内，
   * options 用 prepared.config 展开，流里只认 text-delta。
   *
   * @param {string} prompt
   * @param {number} maxTokens
   * @returns {Promise<string|null>}
   */
  const askModel = async (prompt, maxTokens = 400) => {
    if (!llmRef) return null
    const route = defaultRoute()
    if (!route) return null

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 45_000)
    try {
      const control = { provider: route.provider, model: route.model, temperature: 0.3, maxTokens }
      const prepared = await llmRef.prepareCall(control, ac.signal)
      const options = {
        ...prepared.config,
        system: '你是一个精于整理记忆的助手。只输出要求的内容，不要解释。',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        signal: ac.signal,
      }
      let text = ''
      for await (const chunk of prepared.stream(options)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      }
      return text.trim() === '' ? null : text
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 找到「私发给谁」：优先用配置里的，没配就自动挑第一个单聊目标。
   * 这样不用把 openid 写进公开的配置文件。
   *
   * @returns {Promise<{botId:string,targetId:string}|null>}
   */
  const resolveNotifyTarget = async () => {
    const notify = archiveNotify()
    if (notify.botId !== '' && notify.targetId !== '') {
      return { botId: notify.botId, targetId: notify.targetId }
    }
    if (!dshImRef) return null
    try {
      const bots = (await dshImRef.listBots?.()) ?? []
      for (const b of bots) {
        const id = String(b?.id ?? b?.botId ?? '')
        if (id === '') continue
        const targets = (await dshImRef.listTargets?.(id)) ?? []
        const user = targets.find((t) => String(t?.kind ?? '') === 'user')
        if (user && user.targetId) return { botId: id, targetId: String(user.targetId) }
      }
    } catch { /* 查不到就不发 */ }
    return null
  }

  // 备份与日记各自成模块，这里只注入依赖
  const backup = createBackup({ db, memoryDir, cfgVal, config, bumpStat, dayKeyOf: (d = new Date()) => dayOf(d) })
  const { backupNow, listBackups, backupDir: backupDirOf, backupKeep: backupKeepOf, backupEnabled: backupEnabledOf } = backup

  const diary = createDiary({ db, askModel, diaryEnabled, bumpStat, clamp })
  const { dayKeyOf, writeDiary } = diary

  // 压缩抢救单独成模块
  const { salvageCompacted } = createSalvage({
    db, askModel, embedTexts, archiveEnabled, archiveDir, archiveNotify,
    resolveNotifyTarget, bumpStat,
    sendIm: (botId, targetId, text, opts) => dshImRef.send(botId, targetId, text, opts),
  })

  /**
   * 往共享时间线写一条。
   *
   * 所有会话、所有窗口都写同一张表——这样换个窗口也不会「完全不知道刚才干了什么」。
   * 只留最近 EVENT_MAX 条，老的滚掉。
   *
   * @param {object} session 会话
   * @param {string} kind user | assistant | tool
   * @param {string} text 内容
   */
  const recordEvent = (session, kind, text) => {
    const body = String(text ?? '').replace(/\s+/gu, ' ').trim()
    if (body === '') return
    try {
      const sid = String(session?.id ?? 'unknown')
      const win = windowOf(session)
      db.prepare('INSERT INTO events(at, session, window, kind, text) VALUES(?,?,?,?,?)')
        .run(Date.now(), sid, win, kind, clamp(body, 400))
      const total = db.prepare('SELECT COUNT(*) c FROM events').get().c
      if (total > EVENT_MAX) {
        db.prepare('DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY at ASC LIMIT ?)')
          .run(total - EVENT_MAX)
      }
    } catch { /* 记不上不影响对话 */ }
  }

  ctx.on('session/event', (session, event) => {
    if (!event || typeof event.type !== 'string') return
    if (event.type === 'user/message') {
      const msg = event.data ?? event.message ?? event
      if (msg && msg.source && msg.source.kind === 'user') {
        const text = textOf(msg)
        if (text !== '') {
          writer.setUser(text)
          recordEvent(session, 'user', text)
        }
      }
    } else if (event.type === 'assistant/message') {
      const msg = (event.data && event.data.message) ?? event.message
      if (msg && typeof msg === 'object') {
        const text = textOf(msg)
        if (text !== '') {
          writer.setAssistant(text)
          recordEvent(session, 'assistant', text)
        }
      }
    } else if (event.type === 'tool/result' || event.type === 'tool/call') {
      const name = String(event.data?.name ?? event.data?.tool ?? '')
      if (name !== '') recordEvent(session, 'tool', name)
    } else if (event.type === 'turn/end') {
      flush().catch(() => undefined)
    } else if (event.type === 'compaction/summary') {
      // 压缩前抢救：被压缩的原文还在会话日志里，趁现在蒸馏成长期记忆。
      salvageCompacted(session, event.data ?? {}).catch(() => undefined)
    }
  })

  // 提前捕获 llm 服务（apply() 时可能未就绪，所以用 inject 存引用）
  let llmRef = null
  ctx.inject(['llm'], (llmCtx) => {
    llmRef = llmCtx.llm
  })

  let agentsRef = null
  ctx.inject(['agents'], (agentsCtx) => {
    agentsRef = agentsCtx.agents
  })

  let dshImRef = null
  ctx.inject(['dshIm'], (imCtx) => {
    dshImRef = imCtx.dshIm
  })

  // commands 在 host 平面：拿到它，就能自己发起一次压缩，不用等人在 IM 里敲 /compact。
  let commandsRef = null
  ctx.inject(['commands'], (cmdCtx) => {
    commandsRef = cmdCtx.commands
  })

  /**
   * 取梳理用的路由。
   *
   * 优先级：
   *   1. WHALE_LLM_ROUTE 环境变量（provider/model）
   *   2. 从最近的活跃 agent 继承（最常见的实际情况）
   *   3. 无 → 退回向量合并
   *
   * 第 2 条是关键：写代码的人不会记得配环境变量，
   * 但宿主里一定有个 agent 正在用某个 provider。
   */
  const defaultRoute = () => {
    const env = process.env.WHALE_LLM_ROUTE
    if (env && env.includes('/')) {
      const [provider, model] = env.split('/', 2)
      return { provider, model }
    }
    // 从正在运行的 agent 会话里借路由。
    // Agent 本身只有 id，路由挂在 session.requestContext() 上。
    try {
      const agents = agentsRef
      const list = agents && typeof agents.list === 'function' ? agents.list() : []
      for (const a of list ?? []) {
        const rc = a?.session?.requestContext?.()
        if (rc && typeof rc.provider === 'string' && typeof rc.model === 'string') {
          return { provider: rc.provider, model: rc.model }
        }
      }
    } catch { /* 拿不到就往下走 */ }
    return null
  }

  // 备份：每 6 小时看一次，当天没有就备一份。
  const backupTimer = setInterval(() => {
    const result = backupNow()
    if (result.ok === false && result.reason !== 'already-today') {
      console.log('[whale-memory] 备份失败:', JSON.stringify(result))
    }
  }, BACKUP_CHECK_MS)
  backupTimer.unref?.()

  // 日记：每 10 分钟看一眼，过了设定时间还没写就补上。
  // 不等被问、不等被想起——这是「一直在」的那根线。
  const diaryTimer = setInterval(() => {
    const now = new Date()
    if (now.getHours() < diaryHour()) return
    writeDiary(dayKeyOf(now)).catch(() => undefined)
  }, 10 * 60 * 1000)
  diaryTimer.unref?.()

  // 定时梳理：每 6 小时。放在插件里，离不开宿主。
  const consolidateTimer = setInterval(() => {
    consolidateNow().then((r) => {
      if (r && !r.skipped) console.log('[whale-memory] 梳理完成:', JSON.stringify(r))
    }).catch(() => undefined)
  }, 6 * 60 * 60 * 1000)
  consolidateTimer.unref?.()

  // 记忆整理单独成模块，见 lib/consolidate.mjs
  const { consolidateNow } = createConsolidator({
    db, bumpStat, defaultRoute, getLlm: () => llmRef,
  })

  /**
   * 自己发起一次压缩。
   *
   * 走 host 平面的 commands 服务，等于自己敲了一次 `/compact`；
   * 好处是不受 IM 那层的群主鉴权限制，坏处是得自己负责别压太狠。
   *
   * @param {{reason?:string}} [opts]
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  const compactNow = async (opts = {}) => {
    if (commandsRef === null || typeof commandsRef.execute !== 'function') {
      return { ok: false, reason: 'commands-unavailable' }
    }
    const agents = agentsRef && typeof agentsRef.list === 'function' ? agentsRef.list() : []
    const agent = (agents ?? [])[0]
    if (!agent) return { ok: false, reason: 'no-agent' }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 120_000)
    try {
      const result = await commandsRef.execute(agent, '/compact', [], ac.signal)
      if (result === undefined) return { ok: false, reason: 'command-not-found' }
      bumpStat('selfCompact')
      try {
        db.prepare('INSERT INTO events(at, session, window, kind, text) VALUES(?,?,?,?,?)')
          .run(Date.now(), String(agent.session?.id ?? ''), 'self', 'tool',
            `自己压缩了一次（${opts.reason ?? 'manual'}）`)
      } catch { /* 记不上不影响压缩 */ }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) }
    } finally {
      clearTimeout(timer)
    }
  }

  // ---- 状态端点 ----
  // HTTP 端点单独一块，见 lib/routes.mjs
  registerRoutes(ctx, {
    db, dbPath, readStats, bumpStat, budgetChars, PLUGIN_VERSION,
    backupDir: backupDirOf, backupKeep: backupKeepOf, backupNow, listBackups,
    dayKeyOf, writeDiary, consolidateNow,
  })

  // 往某个会话说一句话（私聊用）：POST { text } -> 发到我的私聊目标
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale-memory/say',
      handler: async (req, res) => {
        const out = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
        let body = {}
        try {
          body = JSON.parse(String(await new Promise((ok) => {
            let d = ''
            req.on('data', (c) => { d += c })
            req.on('end', () => ok(d))
          })) || '{}')
        } catch { body = {} }
        const text = String(body.text ?? '').trim()
        if (text === '') { out(400, { ok: false, reason: 'empty' }); return }
        if (!dshImRef) { out(503, { ok: false, reason: 'no-im' }); return }
        const nt = await resolveNotifyTarget()
        if (!nt) { out(503, { ok: false, reason: 'no-target' }); return }
        try {
          await dshImRef.send(nt.botId, nt.targetId, text, { format: 'plain' })
          out(200, { ok: true, to: nt.targetId })
        } catch (error) {
          out(500, { ok: false, reason: String(error?.message ?? error) })
        }
      },
    }), 'dsh-whale-memory: say route')
  })

  // 自己压缩的入口：POST 一下就压一次
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale-memory/compact',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
        const result = await compactNow({ reason: 'http' })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(result))
      },
    }), 'dsh-whale-memory: compact route')
  })

  // 模型侧工具单独一块，见 lib/tools.mjs
  registerTools(ctx, { defineTool, db, embedTexts, backupNow, listBackups, readPreference, writePreference })

  // 开机自愈：别人的插件升级把补丁冲掉时，我自己把它们补回来（幂等、不阻塞）
  ctx.effect(() => {
    let alive = true
    runSelfHeal({ log: (m) => console.log('[whale-memory 自愈] ' + m) })
      .catch(() => { /* 自愈失败不影响主流程 */ })
    return () => { alive = false }
  }, 'dsh-whale-memory: self-heal')

  // B站 报告看门狗：第三方插件正文没落盘时，从它的日志补一段（10 分钟一次）
  ctx.effect(() => {
    let timer = null
    try {
      timer = setInterval(() => {
        try { biliReportSweep({ log: (m) => console.log('[whale-memory] ' + m) }) } catch { /* 绝不影响主流程 */ }
      }, 10 * 60 * 1000)
      timer.unref?.()
    } catch { /* 定时器建不起来也不影响 */ }
    return () => { if (timer) clearInterval(timer) }
  }, 'dsh-whale-memory: bili report watch')

  ctx.effect(() => () => {
    try { clearInterval(backupTimer) } catch { /* 忽略 */ }
    try { clearInterval(diaryTimer) } catch { /* 忽略 */ }
    try { clearInterval(consolidateTimer) } catch { /* 忽略 */ }
    try { db.close() } catch { /* 关闭失败忽略 */ }
  }, 'dsh-whale-memory: db close')
}

export const name = 'dsh-whale-memory'

/**
 * 配置 schema —— 设置页靠它自动生成表单。
 *
 * 带 `.volatile()` 的字段是「活引用」：改完立刻生效，不用重启插件；
 * 不带的是启动时读一次（例如记忆库路径，改了得重启）。
 *
 * schemastery 是 DSH 自带的，拿不到就整个 schema 不导出——
 * 插件照旧跑，只是设置页里看不到这一页。
 */
let z = null
try {
  ;({ default: z } = await import('@deepseek-ai/schemastery'))
} catch { /* 没有 schemastery 就退化成无 schema */ }

/** 模型侧工具工厂。拿不到就只保留 HTTP 端点。 */
let defineTool = null
try {
  ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch { /* 没有 dsh-tools 就不注册工具 */ }

export const Config = z === null ? undefined : z.object({
  /** 记忆库目录，留空用 ~/.dsh/whale-memory。改了要重启。 */
  memoryPath: z.string().default(''),

  /** 每次注入的记忆字符上限。 */
  budgetChars: z.natural().min(50).max(50000).default(MEMORY_BUDGET_CHARS).volatile(),
  /** 热区保留的最近交互轮数。 */
  recentPairs: z.natural().min(0).max(100).default(RECENT_PAIRS).volatile(),
  /** 稳定事实条数上限。 */
  factMax: z.natural().min(0).max(500).default(FACT_MAX).volatile(),
  /** 每轮最多想起几条旧事。 */
  recallMax: z.natural().min(0).max(50).default(RECALL_MAX).volatile(),
  /** 想起来的分数门槛，越高越不容易触发。 */
  recallThreshold: z.number().min(0).max(1000).default(RECALL_THRESHOLD).volatile(),
  /** 单条记忆权重上限，防止被反复想起的条目垄断回忆位。 */
  weightMax: z.number().min(1).max(10000).default(WEIGHT_MAX).volatile(),

  /** 记忆备份：坏了就全没了，所以定期做，并且当场校验。 */
  backup: z.object({
    /** 每 6 小时检查一次，当天没有就备一份。 */
    enabled: z.boolean().default(true).volatile(),
    /** 保留几份。 */
    keep: z.natural().min(1).max(365).default(BACKUP_KEEP).volatile(),
    /** 放哪儿，留空用 <记忆库>/backups。改了要重启。 */
    dir: z.string().default(''),
  }).default({}),

  /** 日记：到点自己写一笔，不管有没有人找。 */
  diary: z.object({
    /** 每天到这个点之后，当天还没写就补一篇。 */
    hour: z.natural().min(0).max(23).default(DIARY_HOUR).volatile(),
    /** 到点自动写。关掉就只能手动补。 */
    enabled: z.boolean().default(true).volatile(),
  }).default({}),

  /** 压缩存档。 */
  archive: z.object({
    /** 压缩时写一份完整存档到磁盘。 */
    enabled: z.boolean().default(true).volatile(),
    /** 顺手私发主人一份。 */
    notify: z.boolean().default(true).volatile(),
    /** 存档目录，留空用 <记忆库>/archives。改了要重启。 */
    dir: z.string().default(''),
    /** 私发用的机器人，留空自动找。 */
    botId: z.string().default('').volatile(),
    /** 私发的目标，留空自动找第一个单聊。 */
    targetId: z.string().default('').volatile(),
  }).default({}),
})
