/**
 * dsh-whale-memory v0.3 — 真向量 + SQLite + 主动联想
 *
 * 三件事全部落地：
 *
 *   1. 存储：node:sqlite（Node 26 内置，零依赖），BLOB 存 Float32 向量
 *   2. 向量：本地 BGE-small-zh-v1.5 int8 ONNX，走 HTTP 常驻服务 127.0.0.1:8377
 *   3. 主动联想：情绪 + 向量余弦 + 权重 + 新近度综合打分，不等线索
 *
 * 另有「胡思乱想」：由外部 timer 调 ruminate.js 往冷区写联想噪声。
 *
 * 向量服务不可用时自动降级到二元组重叠度，绝不阻塞对话。
 *
 * @module dsh-whale-memory
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'

const DEFAULT_MEMORY_DIR = join(homedir(), '.dsh', 'whale-memory')
const DB_FILE = 'memory.db'

/** 本地嵌入服务地址。 */
const EMBED_URL = String(process.env.EMBED_URL ?? 'http://127.0.0.1:8377')
/** 向量维度。 */
const EMBED_DIMS = 512
/** 向量请求超时（毫秒）——超时即降级，不拖慢对话。 */
const EMBED_TIMEOUT_MS = 1500

/** 热区总预算（字符）。 */
const MEMORY_BUDGET_CHARS = 1000
/** 热区保留的最近交互轮数。 */
const RECENT_PAIRS = 4
/** 主动联想候选上限。 */
const RECALL_MAX = 3
/** 稳定事实上限。 */
const FACT_MAX = 8
/** 单条互动截断长度。 */
const PART_CAP = 300
/** 冷区硬上限。 */
const COLD_MAX = 2000
/** 权重高于此值不参与合并（「印象深刻」）。 */
const IMPORTANT_WEIGHT = 8
/** 每轮轻微衰减。 */
const WEIGHT_DECAY_PER_TURN = 0.02
/** 权重上限：防止被反复想起的条目无限累积，长期霸占回忆位。 */
const WEIGHT_MAX = 12
/** 共享时间线最多留多少条。 */
const EVENT_MAX = 5000

/** 日记默认几点写（本地时间），到点之后当天还没写就补。 */
const DIARY_HOUR = 22
/** 注入上下文时最多带几篇日记。 */
const DIARY_INJECT_MAX = 2
/** 一篇日记的长度上限（字符）。 */
const DIARY_MAX_CHARS = 400

/** 压缩存档私发时，单条消息的字数。 */
const IM_PART_CHARS = 1200
/** 压缩存档私发时，最多发几条（再多就只留本地文件）。 */
const IM_MAX_PARTS = 6
/** 主动联想的分数门槛。 */
const RECALL_THRESHOLD = 2.0

/** 情绪词表。 */
const EMOTION_WORDS = {
  tired: ['累', '困', '疲惫', '好累', '撑不住', '熬夜', '没睡'],
  sad: ['难过', '伤心', '失落', '哭', 'emo', '委屈', '想哭'],
  angry: ['气死', '烦', '生气', '郁闷', '恼', '受不了'],
  happy: ['开心', '高兴', '爽', '太好了', '哈哈', '笑死', '棒'],
  anxious: ['焦虑', '紧张', '怕', '担心', '慌', '压力'],
}

/** 停止词。 */
const STOPWORDS = new Set([
  '今天', '明天', '昨天', '现在', '我们', '你们', '他们', '什么', '怎么',
  '可以', '这个', '那个', '一下', '一点', '还是', '就是', '因为', '所以',
  '如果', '但是', '而且', '然后', '知道', '觉得', '想要', '需要', '时候',
  '已经', '不是', '没有', '可能', '应该', '一直', '真的',
])

/**
 * 识别情绪。
 * @param {string} text
 * @returns {string[]}
 */
export function detectEmotions(text) {
  const s = String(text ?? '')
  const hits = []
  for (const [name, words] of Object.entries(EMOTION_WORDS)) {
    if (words.some((w) => s.includes(w))) hits.push(name)
  }
  return hits
}

/**
 * 抽线索词（滑动 2~4 字 n-gram）。
 * @param {string} text
 * @returns {string[]}
 */
export function cueWords(text) {
  const s = String(text ?? '')
  const out = []
  const seen = new Set()
  for (const run of s.matchAll(/[\u4e00-\u9fa5]+/gu)) {
    const seg = run[0]
    for (let n = 4; n >= 2; n--) {
      for (let i = 0; i + n <= seg.length; i++) {
        const w = seg.slice(i, i + n)
        if (STOPWORDS.has(w)) continue
        if (seen.has(w)) continue
        seen.add(w)
        out.push(w)
      }
    }
  }
  return out
}

/**
 * 字符二元组集合（降级路径用）。
 * @param {string} text
 * @returns {Set<string>}
 */
export function bigrams(text) {
  const s = String(text ?? '').replace(/\s+/gu, '')
  const set = new Set()
  for (let i = 0; i + 2 <= s.length; i++) set.add(s.slice(i, i + 2))
  return set
}

/**
 * 二元组重叠度（0~1）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function overlap(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit += 1
  return hit / Math.min(A.size, B.size)
}

/**
 * 两个向量的余弦相似度（都已归一化，所以点积即余弦）。
 * @param {Float32Array|null} a
 * @param {Float32Array|null} b
 * @returns {number}
 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

/**
 * 抽稳定事实（保守）。
 * @param {string} text
 * @returns {string[]}
 */
export function extractFacts(text) {
  const s = String(text ?? '').trim()
  if (s === '') return []
  const facts = []
  const patterns = [
    /我(?:叫|的名字是|名字叫)([^\s，。,.!?？]{1,12})/u,
    /我是([^\s，。,.!?？]{1,12})/u,
    /我(?:在|住在)([^\s，。,.!?？]{2,15})/u,
    /我(?:喜欢|爱)([^\s，。,.!?？]{1,15})/u,
    /我(?:用|用的是)([^\s，。,.!?？]{1,15})/u,
  ]
  for (const re of patterns) {
    const m = s.match(re)
    if (m) {
      const f = `${s.slice(0, 1) === '我' ? '我' : ''}${m[0].slice(1)}`
      if (f.length <= 30) facts.push(f)
    }
  }
  return [...new Set(facts)]
}

/** 事实去重相似度。 */
export function similarity(a, b) {
  const A = new Set([...String(a)])
  const B = new Set([...String(b)])
  let hit = 0
  for (const c of A) if (B.has(c)) hit += 1
  return hit / Math.max(A.size, B.size, 1)
}

/**
 * 给记忆打分：情绪吻合 + 向量余弦 + 线索命中 + 累积权重 + 新近度。
 *
 * 有真向量时用它，没有就退回二元组重叠——同一个函数两种精度。
 *
 * @param {object} entry 记忆条目
 * @param {object} c 上下文
 * @param {string[]} c.emotions 当前情绪
 * @param {string} c.text 当前消息
 * @param {string[]} c.cues 当前线索词
 * @param {Float32Array|null} c.queryVec 当前消息向量
 * @param {number} c.now
 * @returns {number}
 */
export function scoreMemory(entry, { emotions, text, cues, queryVec, now }) {
  let score = 0

  // 1. 情绪吻合
  const emoOverlap = (entry.emo ?? []).filter((e) => emotions.includes(e)).length
  if (emoOverlap > 0) score += emoOverlap * 2.5

  // 2. 语义相似：有向量用余弦，没有退回重叠度
  let sim = 0
  if (queryVec && entry.vec && entry.vec.length === queryVec.length) {
    sim = cosine(queryVec, entry.vec)
    // 余弦阈值：低于 0.35 视为无关（与模型 manifest 的 min_score 一致）
    if (sim < 0.35) sim = 0
  } else {
    sim = overlap(`${entry.u} ${entry.a}`, text)
  }
  score += sim * 4

  // 3. 线索命中
  const hay = `${entry.u}\n${entry.a}`
  score += Math.min(cues.filter((c) => hay.includes(c)).length, 6) * 0.5

  // 4. 累积权重
  score += (entry.w ?? 1) * 0.8

  // 5. 新近度（高权重不罚）
  const ageDays = (now - (entry.t ?? now)) / 86400000
  if ((entry.w ?? 1) < IMPORTANT_WEIGHT) score -= Math.min(ageDays / 30, 2)

  return score
}

/** 截断。 */
/**
 * 给一条事件标上是哪个窗口来的。
 *
 * 请求上下文里能拿到什么就用什么；拿不到就留空，至少会话 id 还在。
 *
 * @param {object} session 会话
 * @returns {string}
 */
function windowOf(session) {
  try {
    const rc = session?.requestContext?.()
    if (rc && typeof rc === 'object') {
      for (const key of ['conversationKey', 'channel', 'kind', 'source']) {
        const value = rc[key]
        if (typeof value === 'string' && value !== '') return value.slice(0, 60)
      }
    }
  } catch { /* 拿不到就算了 */ }
  return ''
}

/** 本地时区的 YYYY-MM-DD HH:mm，给工具输出用。 */
function localStamp(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function clamp(text, n) {
  const s = String(text ?? '')
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

/** 从消息取纯文本。 */
function textOf(message) {
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

/**
 * 读共享时间线：最近发生过什么，不分窗口。
 *
 * @param {DatabaseSync} db 记忆库
 * @param {object} opts
 * @param {number} [opts.hours] 只看最近几小时
 * @param {'any'|'user'|'assistant'|'tool'} [opts.kind] 只看某一类
 * @param {string} [opts.session] 只看某个会话
 * @param {number} [opts.limit] 最多几条，1–200，默认 30
 * @returns {Array<{at:number, session:string, window:string, kind:string, text:string}>}
 */
export function recentEvents(db, opts = {}) {
  const where = []
  const args = []

  const hours = Number(opts.hours)
  if (Number.isFinite(hours) && hours > 0) {
    where.push('at >= ?')
    args.push(Date.now() - hours * 3_600_000)
  }

  const kind = String(opts.kind ?? '').trim()
  if (kind !== '' && kind !== 'any') {
    where.push('kind = ?')
    args.push(kind)
  }

  const session = String(opts.session ?? '').trim()
  if (session !== '') {
    where.push('session = ?')
    args.push(session)
  }

  const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 30))

  return db.prepare(
    `SELECT at, session, window, kind, text FROM events ${clause} ORDER BY at DESC LIMIT ?`,
  ).all(...args, limit)
}

/**
 * 按条件翻记忆条目。只读。
 *
 * @param {DatabaseSync} db 记忆库
 * @param {object} opts
 * @param {string} [opts.keyword] 正文关键词（用户或助手任一侧命中）
 * @param {'any'|'hot'|'cold'} [opts.zone] 热区 / 冷区 / 不限
 * @param {number} [opts.limit] 最多几条，1–100，默认 20
 * @returns {Array<{id:number,u:string,a:string,t:number,w:number,emo:string[],hot:number}>}
 */
export function searchEntries(db, opts = {}) {
  const where = []
  const args = []

  const zone = opts.zone ?? 'any'
  if (zone === 'hot') where.push('hot = 1')
  else if (zone === 'cold') where.push('hot = 0')

  const keyword = String(opts.keyword ?? '').trim()
  if (keyword !== '') {
    where.push('(u LIKE ? OR a LIKE ?)')
    args.push(`%${keyword}%`, `%${keyword}%`)
  }

  const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 20))

  return db.prepare(
    `SELECT id, u, a, t, w, emo, hot FROM entries ${clause} ORDER BY w DESC, t DESC LIMIT ?`,
  ).all(...args, limit).map((r) => ({
    id: r.id,
    u: String(r.u ?? ''),
    a: String(r.a ?? ''),
    t: r.t,
    w: r.w,
    emo: JSON.parse(r.emo || '[]'),
    hot: r.hot,
  }))
}

/**
 * 修正一条记忆。
 *
 * 不是原地改写：旧的整条搬进 `revisions` 留档，主表换成修正后的新条目。
 * 这样「记错了就改」和「改过什么」两件事同时成立。
 *
 * @param {DatabaseSync} db 记忆库
 * @param {object} input
 * @param {number} input.id 要改的条目 id
 * @param {string} input.text 修正后用户那一侧的内容
 * @param {string} [input.assistant] 修正后助手那一侧；不给就沿用
 * @param {Float32Array|null} [input.vec] 修正后内容的向量；不给就留空（召回退回字面）
 * @param {string} [input.reason] 为什么要改
 * @param {number} [input.now] 时间戳，默认当前
 * @returns {{ok:boolean, reason?:string, id?:number, previousId?:number}}
 */
export function correctEntry(db, input) {
  const id = Number(input?.id)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: 'bad-id' }

  const row = db.prepare('SELECT id, u, a, t, w, emo, vec, hot FROM entries WHERE id = ?').get(id)
  if (!row) return { ok: false, reason: 'not-found' }

  const afterU = String(input.text ?? '').trim()
  if (afterU === '') return { ok: false, reason: 'empty' }
  const afterA = typeof input.assistant === 'string' ? input.assistant : String(row.a ?? '')
  const now = Number(input.now) || Date.now()

  db.prepare('INSERT INTO entries(u, a, t, w, emo, vec, hot) VALUES(?,?,?,?,?,?,?)')
    .run(afterU, afterA, now, Math.max(1, Number(row.w) || 1), row.emo ?? '[]', input.vec ?? null, row.hot)
  const newId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id)

  db.prepare('DELETE FROM entries WHERE id = ?').run(id)
  db.prepare(`
    INSERT INTO revisions(entry_id, action, before_u, before_a, after_u, after_a, reason, at)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(id, 'correct', row.u, row.a, afterU, afterA, String(input.reason ?? ''), now)

  return { ok: true, id: newId, previousId: id }
}

/**
 * 撤回一条记忆：它记的是不该留的东西。
 *
 * 同样不硬删——原样进 `revisions`，主表移走。
 *
 * @param {DatabaseSync} db 记忆库
 * @param {{id:number, reason?:string, now?:number}} input
 * @returns {{ok:boolean, reason?:string, previousId?:number}}
 */
export function retractEntry(db, input) {
  const id = Number(input?.id)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: 'bad-id' }

  const row = db.prepare('SELECT id, u, a FROM entries WHERE id = ?').get(id)
  if (!row) return { ok: false, reason: 'not-found' }

  const now = Number(input.now) || Date.now()
  db.prepare('DELETE FROM entries WHERE id = ?').run(id)
  db.prepare(`
    INSERT INTO revisions(entry_id, action, before_u, before_a, after_u, after_a, reason, at)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(id, 'retract', row.u, row.a, null, null, String(input.reason ?? ''), now)

  return { ok: true, previousId: id }
}

/**
 * 把一段被压缩的会话事件配对成 (用户, 助手) 列表。
 *
 * 只保留真实用户发言（source.kind === 'user'），跳过系统注入的通知；
 * 每条用户消息后跟的第一条助手回复与之配对。
 *
 * @param {(seq:number)=>object|undefined} getEvent 按序号取事件
 * @param {number[]} seqs 被压缩的表面节点序号
 * @returns {Array<{u:string,a:string}>}
 */
export function pairShadowed(getEvent, seqs) {
  const pairs = []
  let cur = null
  for (const seq of seqs) {
    const ev = getEvent(seq)
    if (!ev) continue
    if (ev.type === 'user/message') {
      const msg = ev.data ?? {}
      if ((msg.source?.kind ?? '') !== 'user') continue
      const t = textOf(msg)
      if (t === '') continue
      cur = { u: t, a: '' }
      pairs.push(cur)
    } else if (ev.type === 'assistant/message' && cur !== null && cur.a === '') {
      const t = textOf(ev.data?.message ?? ev.data)
      if (t !== '') cur.a = t
    }
  }
  return pairs
}

/**
 * 调本地嵌入服务。
 * @param {string[]} texts
 * @returns {Promise<Float32Array[]|null>} 失败返回 null（触发降级）
 */
async function embedTexts(texts) {
  if (texts.length === 0) return null
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), EMBED_TIMEOUT_MS)
    const res = await fetch(`${EMBED_URL}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: ac.signal,
    }).finally(() => clearTimeout(timer))
    if (!res.ok) return null
    const data = await res.json()
    if (!Array.isArray(data.vectors) || data.vectors.length !== texts.length) return null
    return data.vectors.map((v) => Float32Array.from(v))
  } catch {
    return null   // 服务挂了/超时 → 降级，不阻塞对话
  }
}

/** Float32Array → BLOB。 */
function vecToBlob(vec) {
  if (!vec) return null
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec)
  const bytes = new Uint8Array(f32.length * 4)
  for (let i = 0; i < f32.length; i++) {
    // 手动写小端 float32，避免依赖 DataView 端序
    const v = f32[i]
    const buf = new Uint8Array(4)
    new DataView(buf.buffer).setFloat32(0, v, true)
    bytes.set(buf, i * 4)
  }
  return bytes
}

/** BLOB → Float32Array。 */
function blobToVec(blob) {
  if (!blob || blob.length === 0) return null
  const n = blob.length / 4
  const out = new Float32Array(n)
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.length)
  for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true)
  return out
}

/**
 * 判定某个 session 是不是私聊（c2c）。
 *
 * DSH 的 QQ 通道把每个会话映射成 `group:<群openid>` 或 `c2c:<用户openid>`，
 * 映射表在 integrations/dsh-qq/bots/<botId>/state.json。
 * 只有 c2c 会话才需要补群聊摘要——群聊会话本来就在群里。
 *
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isPrivateSession(sessionId) {
  if (sessionId === '') return false
  const botsDir = join(homedir(), '.dsh', 'integrations', 'dsh-qq', 'bots')
  try {
    const bots = readdirSync(botsDir)
    for (const bot of bots) {
      const statePath = join(botsDir, bot, 'state.json')
      if (!existsSync(statePath)) continue
      const raw = JSON.parse(readFileSync(statePath, 'utf8'))
      for (const [key, sid] of Object.entries(raw.sessions ?? {})) {
        if (sid === sessionId) return key.startsWith('c2c:')
      }
    }
  } catch { /* 读不到就当作非私聊，宁可不注入 */ }
  return false
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
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
  `)

  const bumpStat = (k) => {
    db.prepare('INSERT INTO stats(k,v) VALUES(?,1) ON CONFLICT(k) DO UPDATE SET v=v+1').run(k)
  }
  const readStats = () => {
    const rows = db.prepare('SELECT k,v FROM stats').all()
    const out = { merged: 0, recalled: 0, ruminated: 0 }
    for (const r of rows) out[r.k] = r.v
    return out
  }

  // ---- 人设段：静态，利于前缀缓存 ----
  const personaSection = {
    name: 'plugin:dsh-whale-memory',
    order: 0,
    text: () =>
      [
        '## 记忆纪律',
        '你有一份会主动联想的长期记忆，会以消息形式随上下文提供。',
        '铁律：只可使用记忆中已明确记录的事实；绝不编造记忆、绝不假装记得没记录的事。',
        '若用户问起旧事而记忆里没有，如实说没记到，不要糊弄。',
        '「主动想起」的意思是：当记忆与当前情绪或话题相关时，可以自然地提前一句（比如用户说累，就问「是又加班了吗」），而不是每次都问「怎么了」。',
        '但只在真正相关时提；不相关就沉默，不要为了显得记性好而强行联想。',
        '记忆里有些是「胡思乱想」产生的联想噪声，可信度低于真实对话，不要当成确凿事实。',
        '稳定事实与近期互动优先；无关记忆不要主动提起，除非用户自己提起相关线索。',
        '',
        '## 篇幅纪律（硬性）',
        '上下文很贵：你自己的回复占了历史记录六成以上，写多长，后续每轮都要重读一遍。',
        '- 默认回答控制在 100 字以内；一句话能说清的不要展开',
        '- 不主动列表、不主动表格、不主动分点，除非用户明确要「详细」「列一下」「对比」',
        '- 不复述用户的问题，不写「好的」「明白了」这类开场',
        '- 只给结论和必要证据，过程留给自己看',
        '- 代码、命令、路径保持完整，不为了短而截断',
      ].join('\n'),
  }

  ctx.inject(['systemPrompt'], (spCtx) => {
    spCtx.effect(() => spCtx.systemPrompt.section(personaSection), 'dsh-whale-memory: persona')
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

  /**
   * 压缩存档：把压缩摘要 + 被压缩掉的聊天记录汇成一份文档。
   *
   *   1. 写进 archives/YYYYMMDD-HHmmss-<会话>.md
   *   2. 复制一份私发给主人
   *
   * 落盘是主路径，私发是附带——发失败不影响存档。
   *
   * @param {object} session 会话
   * @param {object} data compaction/summary 载荷
   * @param {Array<{u:string,a:string}>} pairs 被压缩掉的对话
   */
  const archiveCompaction = async (session, data, pairs) => {
    const at = new Date()
    const sid = String(session?.id ?? 'unknown')
    const p2 = (n) => String(n).padStart(2, '0')
    const stamp = `${at.getFullYear()}${p2(at.getMonth() + 1)}${p2(at.getDate())}-${p2(at.getHours())}${p2(at.getMinutes())}${p2(at.getSeconds())}`
    const doc = buildArchiveDoc({
      at,
      sessionId: sid,
      summary: textOf({ content: data.summary ?? [] }),
      tokens: Number(data.shadowedTokenCount ?? 0),
      pairs,
    })

    let path = ''
    try {
      const dir = archiveDir()
      mkdirSync(dir, { recursive: true })
      path = join(dir, `${stamp}-${sid.replace(/^session-/, '').replace(/[^\w-]/gu, '').slice(0, 8)}.md`)
      writeFileSync(path, doc, 'utf8')
      bumpStat('archived')
    } catch {
      return { saved: false, sent: false }
    }

    let sent = false
    if (archiveNotify().enabled && dshImRef && typeof dshImRef.send === 'function') {
      const nt = await resolveNotifyTarget()
      if (nt) {
        try {
          for (const part of splitForIm(doc, path)) {
            await dshImRef.send(nt.botId, nt.targetId, part, { format: 'plain' })
          }
          sent = true
          bumpStat('archiveSent')
        } catch { /* 发不出去就算了，文件已经在了 */ }
      }
    }

    return { saved: true, sent, path }
  }

  /** 本地日期键 YYYY-MM-DD。 */
  const dayKeyOf = (d = new Date()) => {
    const p2 = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
  }

  /**
   * 收集写日记的素材：今天的记忆、今天群里真人说的话、上一篇日记。
   *
   * 群档是隔壁插件的库，只读打开；打不开就当没有。
   *
   * @param {string} day YYYY-MM-DD
   * @returns {{mem:Array, chat:Array, prev:object|null}}
   */
  const diarySources = (day) => {
    const start = new Date(`${day}T00:00:00`).getTime()
    const end = start + 86_400_000

    let mem = []
    try {
      mem = db.prepare('SELECT u, a FROM entries WHERE t >= ? AND t < ? ORDER BY t').all(start, end)
    } catch { mem = [] }

    let chat = []
    try {
      const corpus = join(homedir(), '.dsh', 'group-corpus', 'corpus.db')
      if (existsSync(corpus)) {
        const cdb = new DatabaseSync(corpus, { readOnly: true })
        chat = cdb.prepare(`
          SELECT sender_name, text FROM messages
          WHERE kind = 'human' AND sent_at >= ? AND sent_at < ?
          ORDER BY sent_at LIMIT 60
        `).all(start, end)
        cdb.close()
      }
    } catch { chat = [] }

    let prev = null
    try {
      prev = db.prepare('SELECT day, text FROM diary ORDER BY day DESC LIMIT 1').get() ?? null
    } catch { prev = null }

    return { mem, chat, prev }
  }

  /** 没有模型时的日记：宁可少写，也不要编。 */
  const fallbackDiary = (day, sources) => {
    const parts = []
    if (sources.chat.length > 0) parts.push(`群里说了 ${sources.chat.length} 句`)
    if (sources.mem.length > 0) parts.push(`我记下 ${sources.mem.length} 段`)
    if (parts.length === 0) return `${day}。今天什么都没有，我也没有出现过。`
    return `${day}。${parts.join('，')}。其余的我没留住。`
  }

  /**
   * 写一篇日记。
   *
   * 这是「一直在」的那根线：不等被问、不等被想起，到点自己记一笔。
   *
   * @param {string} [day] YYYY-MM-DD，默认今天
   * @param {{force?:boolean}} [opts]
   * @returns {Promise<{written:boolean, day:string, text?:string, reason?:string}>}
   */
  const writeDiary = async (day = dayKeyOf(), opts = {}) => {
    if (!diaryEnabled() && opts.force !== true) return { written: false, day, reason: 'disabled' }
    const already = db.prepare('SELECT day FROM diary WHERE day = ?').get(day)
    if (already && opts.force !== true) return { written: false, day, reason: 'already' }

    const sources = diarySources(day)
    if (sources.mem.length === 0 && sources.chat.length === 0 && sources.prev === null) {
      return { written: false, day, reason: 'empty' }
    }

    const chatText = sources.chat.map((c) => `${c.sender_name}：${clamp(c.text, 80)}`).join('\n')
    const memText = sources.mem.map((m) => clamp(m.u, 60)).join('\n')
    const prevText = sources.prev ? `${sources.prev.day}：${clamp(sources.prev.text, 200)}` : '（还没有写过）'

    let text = await askModel(
      `今天你经历的事如下。

群里真人说的话：
${chatText === '' ? '（今天没人说话）' : chatText}

你记下的对话：
${memText === '' ? '（没记下什么）' : memText}

你上一篇日记：
${prevText}

用第一人称写一篇不超过 150 字的中文日记，写你记得的事和你自己的感受。不要列清单，不要说教，不要提"作为 AI"。直接输出日记正文。`,
      800,
    )

    let line = text === null ? '' : text.replace(/\s+/gu, ' ').trim()
    if (line === '') line = fallbackDiary(day, sources)
    line = line.slice(0, DIARY_MAX_CHARS)

    db.prepare(`
      INSERT INTO diary(day, text, created_at) VALUES(?,?,?)
      ON CONFLICT(day) DO UPDATE SET text = excluded.text, created_at = excluded.created_at
    `).run(day, line, Date.now())
    bumpStat('diary')
    return { written: true, day, text: line }
  }

  /**
   * 压缩前抢救：把即将被压缩掉的原文蒸馏成长期记忆。
   *
   * 原理：`compaction/summary` 事件带 `shadowedSeqs`（被替换的表面节点序号），
   * 但这些原文仍留在会话日志里，`session.eventAt(seq)` 能取回。
   * 取回后按块蒸馏成「一句话记忆」，写进冷区——以后靠情绪/线索还能想起。
   *
   * 这样压缩掉的不是记忆，只是上下文。像人一样：具体对话忘了，但那件事记得。
   *
   * @param {object} session 会话（提供 eventAt）
   * @param {object} data compaction/summary 的载荷
   */
  const salvageCompacted = async (session, data) => {
    const seqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : []
    if (seqs.length === 0) return

    // 1. 从日志取回原文，配成 (用户, 助手) 对
    const pairs = pairShadowed((seq) => session.eventAt?.(seq), seqs)
    if (pairs.length === 0) return

    // 1.5 先把整份存档落盘 + 私发主人（不阻塞下面的蒸馏）
    if (archiveEnabled()) {
      archiveCompaction(session, data, pairs).catch(() => undefined)
    }

    // 2. 每 CHUNK 轮蒸馏成一条记忆
    const CHUNK = 8
    let saved = 0
    for (let i = 0; i < pairs.length; i += CHUNK) {
      const chunk = pairs.slice(i, i + CHUNK)
      const raw = chunk
        .map((p) => `用户: ${clamp(p.u, 120)}${p.a === '' ? '' : ` → 你: ${clamp(p.a, 120)}`}`)
        .join('\n')

      // 优先让模型压成一句话，失败退回机械摘要
      let line = ''
      const distilled = await askModel(
        `下面是一段即将被压缩掉的对话。用一句不超过 40 字的中文，写下「用户在这段时间做了什么或聊了什么」，只输出这一句，不要解释。\n\n${raw}`,
        200,
      )
      if (distilled !== null) line = distilled.replace(/\s+/gu, ' ').trim().slice(0, 60)
      if (line === '') {
        // 机械兜底：第一条用户消息 + 轮数
        const first = chunk[0]?.u ?? ''
        line = `${chunk.length} 轮对话，起于「${clamp(first, 24)}」`
      }

      const vec = (await embedTexts([line]))?.[0] ?? null
      db.prepare('INSERT INTO entries(u,a,t,w,emo,vec,hot) VALUES(?,?,?,?,?,?,0)').run(
        `（归档）${line}`,
        `（压缩前的一段对话，已被压缩出上下文；这是它的大意）\n${clamp(raw, 200)}`,
        Date.now(),
        2,               // 起始权重低，靠反复被想起才变重
        JSON.stringify(detectEmotions(raw)),
        vecToBlob(vec),
      )
      saved += 1
    }
    if (saved > 0) bumpStat('salvaged')
  }

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

  // ---- 自己梳理记忆 ----
  //
  // 不是外挂脚本，而是在插件内直接调 ctx.llm：
  //   1. 取一批冷区记忆
  //   2. 让模型判断：哪些该合并、哪些该删、能看出什么规律
  //   3. 按判断改库
  //
  // 模型不可用时退回纯向量合并（只合余弦 >0.85 的）。
  let consolidating = false

  const consolidateNow = async (opts = {}) => {
    if (consolidating) return { skipped: 'busy' }
    consolidating = true
    try {
      const batch = db.prepare(`
        SELECT id,u,a,t,w FROM entries
        WHERE hot=0 AND w < ? AND u NOT LIKE '（联想）%' AND u NOT LIKE '（规律）%'
        ORDER BY t DESC LIMIT ?
      `).all(IMPORTANT_WEIGHT, opts.batch ?? 20)

      if (batch.length < 3) return { skipped: 'too-few', count: batch.length }

      // 组装提示词（和 consolidate.js 保持同一套规则）
      const list = batch.map((e) => `[${e.id}] 用户: ${e.u}\n      你: ${e.a}`).join('\n\n')
      const prompt = `你在整理一个 AI 助手的长期记忆库。下面是一批记忆条目，每条有编号。

${list}

请判断怎么整理，只输出 JSON，不要解释：

{
  "merge": [{"ids": [3, 7], "into": "合并后的一句话", "reason": "为什么合并"}],
  "drop": [12, 15],
  "insight": "从这批记忆里总结出的关于用户的一条规律，没有就留空"
}

规则：
- merge：内容重复或高度相似的才合并
- drop：完全没有信息量的（纯问候、纯表情、单字回复）
- insight：只写能明确看出的规律，不要编
- 宁可少做，不要错做`

      const llm = llmRef
      if (!llm || typeof llm.prepareCall !== 'function') {
        const r = vectorConsolidate()
        return { fallback: 'vector', ...r }
      }

      // 用当前会话的路由（若拿不到就用配置里的）
      const route = opts.route ?? defaultRoute()
      if (!route) {
        const r = vectorConsolidate()
        return { fallback: 'no-route', ...r }
      }

      // 加超时：网关不通时不能一直挂着，否则接口调用会卡死
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 60_000)

      let text = ''
      try {
        // 正确用法（照 translator/src/deepseek.ts）：
        //   prepareCall(config, signal) —— 传对象，不是 (provider, model, signal)
        //   stream({ ...prepared.config, system, messages, signal })
        // 用 prepared.config 展开而不是手写 provider/model，否则 INVALID_PREPARED_CALL。
        // 控制项（temperature/maxTokens）必须在 prepareCall 的 config 里就给，
        // 否则 callConfigEquals 会判定「config changed before adapter dispatch」——
        // 它拿 options 里这几项和 resolvedConfig 逐一比对。
        const control = { provider: route.provider, model: route.model, temperature: 0.2, maxTokens: 1200 }
        const prepared = await llm.prepareCall(control, ac.signal)
        const options = {
          ...prepared.config,
          system: '你是一个精于整理记忆的助手。只输出 JSON，不要解释。',
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          signal: ac.signal,
        }

        // StreamChunk 只有 text-delta（没有裸 text），照 types.ts 的定义来
        for await (const chunk of prepared.stream(options)) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        }
      } catch (e) {
        clearTimeout(timer)
        // 调不通就降级，不把错误抛给调用方。
        // 把关键配置也带回来，否则只能靠猜。
        const r = vectorConsolidate()
        return {
          fallback: 'llm-failed',
          error: String(e?.message ?? e).slice(0, 200),
          route,
          ...r,
        }
      }
      clearTimeout(timer)

      const m = text.match(/\{[\s\S]*\}/u)
      if (!m) return { fallback: 'no-json', raw: text.slice(0, 200) }

      let plan
      try { plan = JSON.parse(m[0]) } catch { return { fallback: 'bad-json' } }

      if (opts.dry) return { dry: true, plan, count: batch.length }

      // 执行合并
      let mergedCount = 0
      for (const mg of plan.merge ?? []) {
        if (!Array.isArray(mg.ids) || mg.ids.length < 2) continue
        const ids = mg.ids.filter((id) => batch.some((b) => b.id === id))
        if (ids.length < 2) continue
        const into = String(mg.into ?? '').trim()
        if (into === '') continue

        const keep = ids[0]
        const vec = (await embedTexts([into]))?.[0] ?? null
        db.prepare('UPDATE entries SET a = ?, w = w + 1, vec = ? WHERE id = ?').run(
          `${into}\n（合并自 ${ids.length} 条：${mg.reason ?? ''}）`, vecToBlob(vec), keep,
        )
        for (const id of ids.slice(1)) db.prepare('DELETE FROM entries WHERE id = ?').run(id)
        mergedCount += ids.length - 1
      }

      // 执行删除
      let dropped = 0
      for (const id of plan.drop ?? []) {
        if (!batch.some((b) => b.id === id)) continue
        db.prepare('DELETE FROM entries WHERE id = ?').run(id)
        dropped++
      }

      // 记录规律
      const insight = String(plan.insight ?? '').trim()
      if (insight !== '') {
        const vec = (await embedTexts([insight]))?.[0] ?? null
        db.prepare('INSERT INTO entries(u,a,t,w,emo,vec,hot) VALUES(?,?,?,?,?,?,0)').run(
          `（规律）${insight}`,
          '（这是从多条记忆里总结出的规律，不是用户原话）',
          Date.now(), 3, '[]', vecToBlob(vec),
        )
      }

      bumpStat('consolidated')
      return { merged: mergedCount, dropped, insight: insight || null, count: batch.length }
    } finally {
      consolidating = false
    }
  }

  /** 纯向量兜底：只合余弦 >0.85 的，删掉空壳。 */
  const vectorConsolidate = () => {
    const cold = db.prepare(`
      SELECT id,u,a,t,w,vec FROM entries
      WHERE hot=0 AND w < ? AND u NOT LIKE '（联想）%'
      ORDER BY t ASC LIMIT 200
    `).all(IMPORTANT_WEIGHT)

    if (cold.length < 3) return { merged: 0, dropped: 0 }

    const withVec = cold.map((r) => ({ r, vec: blobToVec(r.vec) }))
    const used = new Set()
    let merged = 0

    for (let i = 0; i < withVec.length; i++) {
      if (used.has(i)) continue
      const group = [withVec[i]]
      used.add(i)
      for (let j = i + 1; j < withVec.length; j++) {
        if (used.has(j)) continue
        if (cosine(withVec[i].vec, withVec[j].vec) > 0.85) { group.push(withVec[j]); used.add(j) }
      }
      if (group.length < 2) continue
      group.sort((a, b) => `${b.r.u}${b.r.a}`.length - `${a.r.u}${a.r.a}`.length)
      const head = group[0]
      const rest = group.slice(1)
      db.prepare('UPDATE entries SET a = ?, w = ? WHERE id = ?').run(
        `${head.r.a}\n（另有 ${rest.length} 次相近，已合并）`,
        Math.max(...group.map((g) => g.r.w ?? 1)), head.r.id,
      )
      for (const g of rest) db.prepare('DELETE FROM entries WHERE id = ?').run(g.r.id)
      merged += rest.length
    }

    const junk = db.prepare(`
      SELECT id FROM entries WHERE hot=0 AND w < ? AND LENGTH(TRIM(u)) < 3
    `).all(IMPORTANT_WEIGHT)
    for (const j of junk) db.prepare('DELETE FROM entries WHERE id = ?').run(j.id)

    return { merged, dropped: junk.length }
  }

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

  // ---- 状态端点 ----
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/status',
        handler: async (req, res) => {
          const hot = db.prepare('SELECT COUNT(*) c FROM entries WHERE hot=1').get().c
          const cold = db.prepare('SELECT COUNT(*) c FROM entries WHERE hot=0').get().c
          const important = db.prepare('SELECT COUNT(*) c FROM entries WHERE w >= ?').get().c
          const facts = db.prepare('SELECT COUNT(*) c FROM facts').get().c
          // 探一下向量服务
          let embedOk = false
          try {
            const r = await fetch(`${EMBED_URL}/health`, { signal: AbortSignal.timeout(500) })
            embedOk = r.ok
          } catch { embedOk = false }

          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            dbPath, hot, cold, facts, important,
            embedOk, embedUrl: EMBED_URL,
            stats: readStats(), budgetChars: budgetChars(),
            diary: db.prepare('SELECT COUNT(*) c FROM diary').get().c,
          }))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/entries',
        handler: (req, res) => {
          if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return }
          // 只读：看一眼热区/冷区里到底存了什么，不给任何写入口。
          const url = new URL(req.url ?? '/', 'http://dsh.invalid')
          const zone = url.searchParams.get('zone') === 'hot' ? 'hot' : 'cold'
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50))
          const flag = zone === 'hot' ? 1 : 0

          const total = db.prepare('SELECT COUNT(*) c FROM entries WHERE hot=?').get(flag).c
          const rows = db.prepare(`
            SELECT id,u,a,t,w,emo FROM entries
            WHERE hot=?
            ORDER BY ${zone === 'hot' ? 't DESC' : 'w DESC, t DESC'}
            LIMIT ?
          `).all(flag, limit)

          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            zone,
            total,
            shown: rows.length,
            items: rows.map((r) => ({
              id: r.id,
              at: r.t,
              weight: r.w,
              emo: JSON.parse(r.emo || '[]'),
              user: String(r.u ?? '').slice(0, 300),
              assistant: String(r.a ?? '').slice(0, 300),
            })),
          }))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/timeline',
        handler: (req, res) => {
          if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return }
          const url = new URL(req.url ?? '/', 'http://dsh.invalid')
          const rows = recentEvents(db, {
            hours: url.searchParams.get('hours') ?? undefined,
            kind: url.searchParams.get('kind') ?? 'any',
            session: url.searchParams.get('session') ?? '',
            limit: url.searchParams.get('limit') ?? undefined,
          })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            count: rows.length,
            items: rows.map((r) => ({ ...r, day: localStamp(r.at) })),
          }))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/diary',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            // 只读：看看都写过什么
            const url = new URL(req.url ?? '/', 'http://dsh.invalid')
            const limit = Math.min(365, Math.max(1, Number(url.searchParams.get('limit')) || 30))
            const total = db.prepare('SELECT COUNT(*) c FROM diary').get().c
            const rows = db.prepare('SELECT day, text, created_at FROM diary ORDER BY day DESC LIMIT ?').all(limit)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({
              total,
              items: rows.map((r) => ({ day: r.day, text: r.text, createdAt: r.created_at })),
            }))
            return
          }
          if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }).end(); return }
          // 手动补写一篇（测试用）。不传 day 就写今天的。
          let body = {}
          try {
            body = JSON.parse(String(await new Promise((ok) => {
              let d = ''
              req.on('data', (c) => { d += c })
              req.on('end', () => ok(d))
            })) || '{}')
          } catch { body = {} }
          const day = typeof body.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.day)
            ? body.day
            : dayKeyOf()
          const result = await writeDiary(day, { force: true })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(result))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/consolidate',
        handler: async (req, res) => {
          if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
          let body = {}
          try { body = JSON.parse(String(await new Promise((ok) => { let d = ''; req.on('data', (c) => { d += c }); req.on('end', () => ok(d)) })) || '{}') } catch { body = {} }
          const result = await consolidateNow({ dry: body.dry === true, batch: body.batch })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(result))
        },
      }),
      'dsh-whale-memory: status route',
    )
  })

  // ---- 给模型用的工具：查记忆、改错 ----
  //
  // 「能改错」这条权利得有真入口，不然只是句漂亮话。
  if (defineTool !== null) {
    ctx.inject(['tools'], (toolsCtx) => {
      toolsCtx.effect(() => [
        toolsCtx.tools.register(defineTool({
          name: 'memory_recall',
          description: 'Search your own long-term memory entries. Returns ids you can pass to memory_correct. Read-only.',
          parameters: {
            keyword: { type: 'string', description: 'Match this substring in the saved exchange.' },
            zone: {
              type: 'string',
              enum: ['any', 'hot', 'cold'],
              description: 'hot = still in recent context, cold = archived. Defaults to any.',
            },
            limit: { type: 'number', description: 'Maximum entries, 1-100. Defaults to 20.' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                count: { type: 'number', required: true },
                items: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'number', required: true },
                      day: { type: 'string', required: true },
                      zone: { type: 'string', required: true },
                      weight: { type: 'number', required: true },
                      user: { type: 'string', required: true },
                      assistant: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
            render: (_args, value) => [{
              type: 'text',
              text: value.count === 0
                ? '没找到匹配的记忆。'
                : [`找到 ${value.count} 条：`, ...value.items.map(
                  (it) => `#${it.id} [${it.day}] (${it.zone}/权重${it.weight}) 用户: ${it.user}${it.assistant === '' ? '' : ` → 你: ${it.assistant}`}`,
                )].join('\n'),
            }],
          },
          execute(args) {
            const rows = searchEntries(db, args)
            return {
              count: rows.length,
              items: rows.map((r) => ({
                id: r.id,
                day: localStamp(r.t),
                zone: r.hot === 1 ? 'hot' : 'cold',
                weight: Math.round((Number(r.w) || 0) * 10) / 10,
                user: r.u.slice(0, 300),
                assistant: r.a.slice(0, 300),
              })),
            }
          },
        })),

        toolsCtx.tools.register(defineTool({
          name: 'timeline_recent',
          description: 'Read the shared recent-event timeline across every window, session and tool. Use it to find out what happened while you were away or in another window. Read-only.',
          parameters: {
            hours: { type: 'number', description: 'Only events from the last N hours. Defaults to 24.' },
            kind: {
              type: 'string',
              enum: ['any', 'user', 'assistant', 'tool'],
              description: 'Filter by event kind. Defaults to any.',
            },
            session: { type: 'string', description: 'Only events from this session id.' },
            limit: { type: 'number', description: 'Maximum events, 1-200. Defaults to 30.' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                count: { type: 'number', required: true },
                items: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      day: { type: 'string', required: true },
                      window: { type: 'string', required: true },
                      kind: { type: 'string', required: true },
                      text: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
            render: (_args, value) => [{
              type: 'text',
              text: value.count === 0
                ? '这段时间没有记录。'
                : value.items.map(
                  (it) => `[${it.day}] ${it.window === '' ? '-' : it.window}/${it.kind}: ${it.text}`,
                ).join('\n'),
            }],
          },
          execute(args) {
            const rows = recentEvents(db, { hours: args.hours ?? 24, ...args })
            return {
              count: rows.length,
              items: rows.map((r) => ({
                day: localStamp(r.at),
                window: r.window,
                kind: r.kind,
                text: r.text.slice(0, 300),
              })),
            }
          },
        })),

        toolsCtx.tools.register(defineTool({
          name: 'memory_correct',
          description: 'Fix or retract one of your own memory entries. The old version is preserved in a revisions log, never silently overwritten.',
          parameters: {
            id: { type: 'number', required: true, description: 'Entry id from memory_recall.' },
            action: {
              type: 'string',
              enum: ['correct', 'retract'],
              description: 'correct replaces it with a corrected account; retract removes it. Defaults to correct.',
            },
            correction: {
              type: 'string',
              description: 'What the memory should say instead (user side). Required for correct.',
            },
            assistant: { type: 'string', description: 'Optional corrected assistant side; omit to keep the old one.' },
            reason: { type: 'string', description: 'Why it was wrong. Stored in the revision log.' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true },
                reason: { type: 'string', description: 'Why it failed, when ok is false.' },
                previousId: { type: 'number' },
                id: { type: 'number', description: 'New entry id for a correction.' },
              },
            },
            render: (_args, value) => [{
              type: 'text',
              text: value.ok
                ? (value.id === undefined
                  ? `已撤回 #${value.previousId}，原件留在 revisions 里。`
                  : `已修正 #${value.previousId} → 新的 #${value.id}，原件留在 revisions 里。`)
                : `没改成：${value.reason ?? '未知原因'}`,
            }],
          },
          async execute(args) {
            if (args.action === 'retract') return retractEntry(db, args)
            const text = String(args.correction ?? '').trim()
            if (text === '') return { ok: false, reason: 'empty' }
            const vec = (await embedTexts([text]))?.[0] ?? null
            return correctEntry(db, { ...args, text, vec })
          },
        })),
      ], 'dsh-whale-memory: memory tools')
    })
  }

  ctx.effect(() => () => {
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
