/**
 * 会话相关的纯函数：被压缩节点的配对、私聊判定、窗口标记。
 */
import { textOf } from './format.mjs'

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

export function windowOf(session) {
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
