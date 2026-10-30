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

import {
  DEFAULT_MEMORY_DIR, DB_FILE, EMBED_URL, EMBED_DIMS, EMBED_TIMEOUT_MS,
  MEMORY_BUDGET_CHARS, RECENT_PAIRS, RECALL_MAX, FACT_MAX, PART_CAP, COLD_MAX,
  IMPORTANT_WEIGHT, WEIGHT_DECAY_PER_TURN, WEIGHT_MAX, BACKUP_KEEP, BACKUP_CHECK_MS,
  EVENT_MAX, DIARY_HOUR, DIARY_INJECT_MAX, DIARY_MAX_CHARS, IM_PART_CHARS, IM_MAX_PARTS,
  RECALL_THRESHOLD,
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

  // ---- 记忆注入 ----
  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || step !== 1 || signal?.aborted) return decision

    const userText = messages
      .filter((m) => m && m.source && m.source.kind === 'user')
      .map(textOf)
      .join('\n')
      .trim()

    const emotions = detectEmotions(userText)
    const cues = userText !== '' ? cueWords(userText) : []
    const now = Date.now()

    // 当前消息向量（有服务就用，没有降级）
    const queryVec = userText !== '' ? (await embedTexts([userText]))?.[0] ?? null : null

    const parts = []
    let budget = budgetChars()
    const push = (label, body) => {
      if (!body) return
      const block = `${label}\n${body}`
      if (block.length > budget) return
      parts.push(block)
      budget -= block.length
    }

    // 最近的日记：给上下文一点「昨天我也在」的连续性
    try {
      const diaries = db.prepare('SELECT day, text FROM diary ORDER BY day DESC LIMIT ?')
        .all(DIARY_INJECT_MAX).reverse()
      if (diaries.length > 0) {
        push(
          '我最近写下的日记（我自己的记录，不是用户说的话）：',
          diaries.map((d) => `${d.day}：${clamp(d.text, 200)}`).join('\n'),
        )
      }
    } catch { /* 表还没建好就跳过 */ }

    const facts = db.prepare('SELECT f FROM facts ORDER BY id DESC LIMIT ?').all(factMax()).map((r) => r.f)
    if (facts.length > 0) push('已确认的关于用户的事实：', facts.map((f) => `- ${f}`).join('\n'))

    const recent = db.prepare('SELECT u,a FROM entries WHERE hot=1 ORDER BY t DESC LIMIT ?').all(recentPairs())
    if (recent.length > 0) {
      push('最近几轮的对话：',
        recent.reverse().map((r) => `用户: ${clamp(r.u, PART_CAP)} → 你: ${clamp(r.a, PART_CAP)}`).join('\n'))
    }

    // ---- 单向同步：私聊里补一份群聊摘要 ----
    //
    // 群聊和私聊是两个 session，私聊看不到群里刚发生什么。
    // 这里只在私聊会话注入，群聊会话不注入（否则重复）。
    // 方向是单向的：群 → 私聊，私聊的内容不回流群聊。
    const sessionId = String(agent?.session?.id ?? '')
    if (isPrivateSession(sessionId)) {
      const digestPath = join(memoryDir, 'group-digest.json')
      try {
        const dg = JSON.parse(readFileSync(digestPath, 'utf8'))
        // 摘要太旧（超过 12 小时）就不提了，免得说「刚才群里」其实是一天前
        if (Date.now() - (dg.generatedAt ?? 0) < 12 * 3600 * 1000 && Array.isArray(dg.lines) && dg.lines.length > 0) {
          push(
            `群里最近在聊（${dg.people?.length ?? 0} 人，仅供了解，不必主动接话）：`,
            dg.lines.slice(-5).join('\n'),
          )
        }
      } catch { /* 摘要读不了就跳过 */ }
    }

    // ---- 主动联想：真向量打分 ----
    if (emotions.length > 0 || cues.length > 0) {
      const hotIds = new Set(recent.map((r) => r.id))
      const cold = db.prepare('SELECT id,u,a,t,w,emo,vec FROM entries WHERE hot=0 ORDER BY t DESC LIMIT 500').all()
      const scored = cold
        .filter((r) => !hotIds.has(r.id))
        .map((r) => ({
          r,
          emo: JSON.parse(r.emo || '[]'),
          vec: blobToVec(r.vec),
        }))
        .map((x) => ({
          ...x,
          s: scoreMemory({ ...x.r, emo: x.emo, vec: x.vec }, { emotions, text: userText, cues, queryVec, now }),
        }))
        .filter((x) => x.s > recallThreshold())
        .sort((a, b) => b.s - a.s)
        .slice(0, recallMax())

      if (scored.length > 0) {
        const kind = emotions.length > 0 ? `情绪(${emotions.join('/')})` : '话题'
        push(
          `主动想起的相关旧事（因${kind}相关而取用；若确实贴合可自然提一句，否则忽略）：`,
          scored.map((x, i) => {
            const w = x.r.w ?? 1
            const tag = w >= IMPORTANT_WEIGHT ? '〔印象深刻〕' : ''
            const noisy = x.r.u.startsWith('（联想）') ? '〔联想·非对话〕' : ''
            return `${i + 1}. ${tag}${noisy}用户: ${clamp(x.r.u, PART_CAP)} → 你: ${clamp(x.r.a, PART_CAP)}`
          }).join('\n'),
        )
        // 被想起 → 权重累积
        const up = db.prepare('UPDATE entries SET w = MIN(w + 1, ?) WHERE id = ?')
        for (const x of scored) up.run(weightMax(), x.r.id)
        bumpStat('recalled')
      }
    }

    if (parts.length === 0) return decision

    const text = `（记忆参考——只可使用下列已发生的事实，严禁编造：\n\n${parts.join('\n\n')}）`
    const memoryMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'whale-memory', form: 'notice', summary: `记忆注入 ${parts.length} 段` },
    }
    return { ...decision, messages: [...decision.messages, memoryMessage] }
  }, { prepend: true })

  // ---- 记录交互 ----
  let pendingUser = ''
  let pendingAssistant = ''

  const flush = async () => {
    if (pendingUser === '' && pendingAssistant === '') return
    const emotions = detectEmotions(pendingUser)
    const vec = pendingUser !== '' ? (await embedTexts([pendingUser]))?.[0] ?? null : null

    const insert = db.prepare('INSERT INTO entries(u,a,t,w,emo,vec,hot) VALUES(?,?,?,?,?,?,1)')
    insert.run(
      clamp(pendingUser, PART_CAP),
      clamp(pendingAssistant, PART_CAP),
      Date.now(),
      1 + emotions.length * 0.5,
      JSON.stringify(emotions),
      vecToBlob(vec),
    )

    if (pendingUser !== '') {
      for (const f of extractFacts(pendingUser)) {
        const exists = db.prepare('SELECT f FROM facts').all().some((r) => similarity(r.f, f) >= 0.6)
        if (!exists) db.prepare('INSERT OR IGNORE INTO facts(f) VALUES(?)').run(f)
      }
      const n = db.prepare('SELECT COUNT(*) c FROM facts').get().c
      if (n > factMax()) {
        db.prepare('DELETE FROM facts WHERE id IN (SELECT id FROM facts ORDER BY id ASC LIMIT ?)').run(n - factMax())
      }
    }

    // 超出热区的降温
    const hotCount = db.prepare('SELECT COUNT(*) c FROM entries WHERE hot=1').get().c
    if (hotCount > recentPairs()) {
      db.prepare(`
        UPDATE entries SET hot=0 WHERE id IN (
          SELECT id FROM entries WHERE hot=1 ORDER BY t ASC LIMIT ?
        )`).run(hotCount - recentPairs())
    }

    // 轻度衰减
    db.prepare(`UPDATE entries SET w = MAX(1, w - ${WEIGHT_DECAY_PER_TURN}) WHERE hot=0 AND w > 1`).run()

    // 合并：低权重按向量聚类，高权重不动
    const coldCount = db.prepare('SELECT COUNT(*) c FROM entries WHERE hot=0').get().c
    if (coldCount > COLD_MAX / 2) {
      const important = db.prepare('SELECT id,u,a,t,w,emo FROM entries WHERE hot=0 AND w >= ?').all(IMPORTANT_WEIGHT)
      const mergeable = db.prepare('SELECT id,u,a,t,w,emo,vec FROM entries WHERE hot=0 AND w < ? ORDER BY t ASC').all(IMPORTANT_WEIGHT)
      const used = new Set()
      const survivors = []
      for (let i = 0; i < mergeable.length; i++) {
        if (used.has(i)) continue
        const base = mergeable[i]
        const baseVec = blobToVec(base.vec)
        const group = [base]
        used.add(i)
        for (let j = i + 1; j < mergeable.length; j++) {
          if (used.has(j)) continue
          const other = mergeable[j]
          const ov = baseVec && blobToVec(other.vec)
            ? cosine(baseVec, blobToVec(other.vec))
            : overlap(base.u, other.u)
          if (ov > 0.62) {        // 余弦相似到 0.62 视为同质，可合并
            group.push(other)
            used.add(j)
          }
        }
        if (group.length === 1) {
          survivors.push(base.id)
        } else {
          group.sort((a, b) => `${b.u}${b.a}`.length - `${a.u}${a.a}`.length)
          const head = group[0]
          const rest = group.slice(1)
          db.prepare('UPDATE entries SET a = ?, w = ?, emo = ? WHERE id = ?').run(
            `${head.a}\n（另有 ${rest.length} 次相近经历，已合并：${rest.map((r) => clamp(r.u, 30)).join('；')}）`,
            Math.max(...group.map((g) => g.w ?? 1)),
            JSON.stringify([...new Set(group.flatMap((g) => JSON.parse(g.emo || '[]')))]),
            head.id,
          )
          for (const r of rest) db.prepare('DELETE FROM entries WHERE id = ?').run(r.id)
          survivors.push(head.id)
          bumpStat('merged')
        }
      }
      // 硬上限兜底
      const still = db.prepare('SELECT COUNT(*) c FROM entries WHERE hot=0').get().c
      if (still > COLD_MAX) {
        db.prepare(`DELETE FROM entries WHERE id IN (
          SELECT id FROM entries WHERE hot=0 AND w < ? ORDER BY t ASC LIMIT ?
        )`).run(IMPORTANT_WEIGHT, still - COLD_MAX)
      }
    }

    pendingUser = ''
    pendingAssistant = ''
  }

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
          pendingUser = text
          recordEvent(session, 'user', text)
        }
      }
    } else if (event.type === 'assistant/message') {
      const msg = (event.data && event.data.message) ?? event.message
      if (msg && typeof msg === 'object') {
        const text = textOf(msg)
        if (text !== '') {
          pendingAssistant = text
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

  // ---- 状态端点 ----
  // HTTP 端点单独一块，见 lib/routes.mjs
  registerRoutes(ctx, {
    db, dbPath, readStats, bumpStat, budgetChars,
    backupDir: backupDirOf, backupKeep: backupKeepOf, backupNow, listBackups,
    dayKeyOf, writeDiary, consolidateNow,
  })

  // 模型侧工具单独一块，见 lib/tools.mjs
  registerTools(ctx, { defineTool, db, embedTexts, backupNow, listBackups, readPreference, writePreference })

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
