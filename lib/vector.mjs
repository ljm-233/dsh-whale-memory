/**
 * 向量与嵌入服务客户端。
 */
import { EMBED_URL, EMBED_DIMS, EMBED_TIMEOUT_MS } from './constants.mjs'

export function vecToBlob(vec) {
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
export function blobToVec(blob) {
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

const EMBED_CACHE = new Map()
const EMBED_CACHE_MAX = 64

/**
 * 编码一段文本，带一层小缓存：同一句话在同一轮里会被问到多次（图谱/场景/召回），
 * 没必要每次都打一次服务。
 *
 * @param {string[]} texts 文本
 * @returns {Promise<Float32Array[]|null>} 向量
 */
export async function embedTexts(texts) {
  if (texts.length === 0) return null

  const single = texts.length === 1 ? texts[0] : null
  if (single !== null && EMBED_CACHE.has(single)) return [EMBED_CACHE.get(single)]

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
    const out = data.vectors.map((v) => Float32Array.from(v))
    if (single !== null) {
      if (EMBED_CACHE.size >= EMBED_CACHE_MAX) EMBED_CACHE.clear()
      EMBED_CACHE.set(single, out[0])
    }
    return out
  } catch {
    return null   // 服务挂了/超时 → 降级，不阻塞对话
  }
}
