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
