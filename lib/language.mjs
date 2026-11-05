/**
 * 语言侧：情绪识别、线索词、相似度、记忆打分。
 *
 * 全是纯函数，不碰库、不碰网络。
 */
import { EMOTION_WORDS, STOPWORDS, IMPORTANT_WEIGHT } from './constants.mjs'

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
const CUE_CACHE = new Map()
/** 缓存上限：够覆盖一轮里的几句话，别无限长。 */
const CUE_CACHE_MAX = 256

export function cueWords(text) {
  const key = String(text ?? '')
  const hit = CUE_CACHE.get(key)
  if (hit !== undefined) return hit
  const value = cueWordsUncached(key)
  if (CUE_CACHE.size >= CUE_CACHE_MAX) CUE_CACHE.clear()
  CUE_CACHE.set(key, value)
  return value
}

/**
 * 真正干活的那版：抽线索词（滑动 2~4 字 n-gram + 拉丁词）。
 * @param {string} text
 * @returns {string[]}
 */
function cueWordsUncached(text) {
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
  // 拉丁词单独抽：中文 n-gram 那套对 bot、deepseek 这类词完全失明，
  // 而它们恰恰是排查和项目话题的主线索。统一小写，去重后再进词表。
  for (const run of s.matchAll(/[A-Za-z][A-Za-z0-9_-]{1,}/g)) {
    const w = run[0].toLowerCase()
    if (STOPWORDS.has(w) || seen.has(w)) continue
    seen.add(w)
    out.push(w)
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
 * 语义相似度（0..1）：有真向量用余弦，没有就退回二元组重叠。
 *
 * 一个定义两处用：旧公式 scoreMemory 和新公式的 rel 轴都用它，
 * 免得「两种精度」变成两套口径——A/B 的时候比的是权重，不是相似度算法。
 *
 * @param {{u?:string, a?:string, vec?:Float32Array|null}} entry 条目
 * @param {{queryVec?:Float32Array|null, text?:string}} c 这一轮的查询
 * @returns {number}
 */
export function simOf(entry, { queryVec, text }) {
  if (queryVec && entry.vec && entry.vec.length === queryVec.length) {
    const sim = cosine(queryVec, entry.vec)
    // 余弦阈值：低于 0.35 视为无关（与模型 manifest 的 min_score 一致）
    return sim < 0.35 ? 0 : sim
  }
  return overlap(`${entry.u ?? ''} ${entry.a ?? ''}`, String(text ?? ''))
}

/**
 * 给记忆打分：情绪吻合 + 向量余弦 + 线索命中 + 累积权重 + 新近度。
 *
 * 有真向量时用它，没有就退回二元组重叠——同一个函数两种精度。
 *
 * 这是**旧公式**（legacy）：`lib/recall.mjs` 的 `scoreMode=legacy` 还走它做 A/B，
 * 新路径是 `lib/axes.mjs` 的三轴合成（0..1 刻度）。
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
  score += simOf(entry, { queryVec, text }) * 4

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
