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
import { mkdirSync, existsSync } from 'node:fs'
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
const MEMORY_BUDGET_CHARS = 1600
/** 热区保留的最近交互轮数。 */
const RECENT_PAIRS = 6
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
      ].join('\n'),
  }

  ctx.inject(['systemPrompt'], (spCtx) => {
    spCtx.effect(() => spCtx.systemPrompt.section(personaSection), 'dsh-whale-memory: persona')
  })

  // ---- 记忆注入 ----
  ctx.on('agent/pre-step', async ({ messages, step, signal }, next) => {
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
    let budget = MEMORY_BUDGET_CHARS
    const push = (label, body) => {
      if (!body) return
      const block = `${label}\n${body}`
      if (block.length > budget) return
      parts.push(block)
      budget -= block.length
    }

    const facts = db.prepare('SELECT f FROM facts ORDER BY id DESC LIMIT ?').all(FACT_MAX).map((r) => r.f)
    if (facts.length > 0) push('已确认的关于用户的事实：', facts.map((f) => `- ${f}`).join('\n'))

    const recent = db.prepare('SELECT u,a FROM entries WHERE hot=1 ORDER BY t DESC LIMIT ?').all(RECENT_PAIRS)
    if (recent.length > 0) {
      push('最近几轮的对话：',
        recent.reverse().map((r) => `用户: ${clamp(r.u, PART_CAP)} → 你: ${clamp(r.a, PART_CAP)}`).join('\n'))
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
        .filter((x) => x.s > RECALL_THRESHOLD)
        .sort((a, b) => b.s - a.s)
        .slice(0, RECALL_MAX)

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
        const up = db.prepare('UPDATE entries SET w = w + 1 WHERE id = ?')
        for (const x of scored) up.run(x.r.id)
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
      if (n > FACT_MAX) {
        db.prepare('DELETE FROM facts WHERE id IN (SELECT id FROM facts ORDER BY id ASC LIMIT ?)').run(n - FACT_MAX)
      }
    }

    // 超出热区的降温
    const hotCount = db.prepare('SELECT COUNT(*) c FROM entries WHERE hot=1').get().c
    if (hotCount > RECENT_PAIRS) {
      db.prepare(`
        UPDATE entries SET hot=0 WHERE id IN (
          SELECT id FROM entries WHERE hot=1 ORDER BY t ASC LIMIT ?
        )`).run(hotCount - RECENT_PAIRS)
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

  ctx.on('session/event', (session, event) => {
    if (!event || typeof event.type !== 'string') return
    if (event.type === 'user/message') {
      const msg = event.data ?? event.message ?? event
      if (msg && msg.source && msg.source.kind === 'user') {
        const text = textOf(msg)
        if (text !== '') pendingUser = text
      }
    } else if (event.type === 'assistant/message') {
      const msg = (event.data && event.data.message) ?? event.message
      if (msg && typeof msg === 'object') {
        const text = textOf(msg)
        if (text !== '') pendingAssistant = text
      }
    } else if (event.type === 'turn/end') {
      flush().catch(() => undefined)
    }
  })

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
            stats: readStats(), budgetChars: MEMORY_BUDGET_CHARS,
          }))
        },
      }),
      'dsh-whale-memory: status route',
    )
  })

  ctx.effect(() => () => { try { db.close() } catch { /* 关闭失败忽略 */ } }, 'dsh-whale-memory: db close')
}

export const name = 'dsh-whale-memory'
