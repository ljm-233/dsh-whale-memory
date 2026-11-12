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

  // 2026-11-12 23:1x：分批发。原来一次把整批塞进一个请求——35 条实测要 1142ms，
  // 而 EMBED_TIMEOUT_MS 是 1500ms，负载稍高就超时，整批全废
  // （memory-tidy 报「补向量 0/35，失败 35」就是这么来的，dry-run 看不出来）。
  // 现在每批 8 条（实测 ~250ms），单批失败只放弃这一批，不再拖垮整次整理。
  const BATCH = 8
  const out = []
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH)
    const got = await embedChunk(chunk)
    if (!got) return null
    out.push(...got)
  }

  if (single !== null) {
    if (EMBED_CACHE.size >= EMBED_CACHE_MAX) EMBED_CACHE.clear()
    EMBED_CACHE.set(single, out[0])
  }
  return out
}

/**
 * 一批（≤8 条）打一次嵌入服务。失败返回 null，调用方决定降级。
 * 单独抽出来只为了 embedTexts 里那个分批循环好读。
 */
async function embedChunk(texts) {
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

