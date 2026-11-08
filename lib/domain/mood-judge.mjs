/**
 * 情绪的判定：从我（和少量从对方）说的话里读出 dims 与 raw。
 *
 * 主信号是本轮我自己说的话（词表 + 语气），对方的话只算「冲击」；
 * 「我不想做」那本账的原文匹配也在这里（只判不写，写文件在 `mood-log.mjs`）。
 *
 * @module mood-judge
 */
import { numClamp } from './mood-state.mjs'

/**
 * 情绪词表：只挑 whale-memory EMOTION_WORDS 里已有的词（constants.mjs:114-120）。
 * 每一类落在一根维度上：angry → sad（负向合流）、anxious → sad（只记一半）。
 */
const WORDS = {
  tired: ['累', '困', '疲惫', '撑不住', '熬夜', '没睡'],
  sad: ['难过', '伤心', '失落', '委屈', '想哭', '烦', '气死', '郁闷', '受不了'],
  anxious: ['焦虑', '紧张', '害怕', '担心', '慌', '压力'],
  happy: ['开心', '高兴', '太好了', '哈哈', '笑死', '棒', '爽'],
  care: ['想你', '陪我', '你呢', '你还', '舍不得', '一起'],
}
/** 词 → 维度（angry/anxious 都落 sad；angry 满权、anxious 半权，见 judgeSelf）。 */
const WORD_DIM = { tired: 'tired', sad: 'sad', anxious: 'sad', happy: 'happy', care: 'care' }
/** 对方的话：只当冲击，系数小（原来 4/6，这里 1/2，≤1/3）。 */
const PRAISE = ['不错', '厉害', '谢谢', '喜欢', '好用']
const NEGATE = ['不对', '错了', '重来', '没用', '别这样']
/** 「我不想做」那本账的触发词：只扫我自己的话。 */
const UNWILLING = /(不想做|不想干|不想弄|今天不想|我先不做|我不做)/u

/** 把一段话切成句：中英文句读 + 换行。句长和引用都靠它。 */
const sentencesOf = (text) => String(text ?? '')
  .split(/[\n。！？!?；;…]+/u)
  .map((x) => x.trim())
  .filter((x) => x !== '')

/**
 * 命中词所在那一句的前 20 字——`reason` 靠它回答「是我的哪句话」。
 *
 * @param {string[]} lines 句子
 * @param {string} word 命中的词
 * @returns {string} 截断后的原话；没找到返回 ''
 */
const quoteOf = (lines, word) => {
  for (const line of lines) {
    if (!line.includes(word)) continue
    return line.slice(0, 20)
  }
  return ''
}

/**
 * 旧路径：从**对方**的文本算判定。留作兼容（`note()` 在没有 `assistantTexts` 时退回它），
 * 新代码一律走 judgeSelf()。这一份算出来的是「他在说什么」，不是我的心情。
 *
 * @param {object} signal { at, userTexts, kind, hour, turnStreak }
 * @returns {{dims:object, raw:number, confidence:number, evidence:string[], source:string}}
 */
export function judgeUser(signal) {
  const text = (signal.userTexts ?? []).join('\n')
  const d = { happy: 0, tired: 0, sad: 0, care: 0 }
  const evidence = []
  for (const [dim, words] of Object.entries(WORDS)) {
    const hit = words.filter((w) => text.includes(w))
    if (hit.length === 0) continue
    d[dim] += dim === 'happy' ? 6 : dim === 'care' ? 5 : 7
    evidence.push(`话里有「${hit[0]}」`)
  }
  if (PRAISE.some((w) => text.includes(w))) { d.happy += 4; evidence.push('被夸了一句') }
  if (NEGATE.some((w) => text.includes(w))) { d.sad += 6; evidence.push('被否了一句') }
  if (signal.kind === 'error' || signal.kind === 'blocked') { d.sad += 5; evidence.push('这轮没跑通') }
  else if (signal.kind === 'completed' && d.happy > 0) d.happy += 2

  const hour = Number.isInteger(signal.hour) ? signal.hour : new Date(signal.at).getHours()
  if (hour >= 23 || hour < 6) { d.tired += 4; evidence.push('这个点还没停') }
  if ((signal.turnStreak ?? 0) >= 6) { d.tired += 3; evidence.push('连着干了好几轮') }
  if ((signal.userTexts ?? []).length >= 3) { d.care += 3; evidence.push('这轮说得长') }

  const raw = d.happy + d.care * 0.5 - d.sad * 1.2 - d.tired * 0.8
  const confidence = numClamp(30 + evidence.length * 15, 0, 95)
  return { dims: d, raw, confidence, evidence, source: 'user' }
}

/**
 * 新路径：从**我这一轮说的话**算判定。
 *
 * 权重（一句话版）：我话里的词 tired/sad +7、happy +6、care +5，anxious 只给 sad +4；
 * 语气上说了「不想/算了」tired +5、说了「没事/无所谓」sad +3、平均句长 ≥30 字 care +3、
 * 话说得又短又碎（≥2 句且平均 ≤8 字）sad +2、没人问我自己开口 happy +3；
 * 对方的话只算冲击：被夸 happy +1、被否 sad +2（≤ 旧版 4/6 的 1/3）；
 * 环境另算：没跑通 sad +3、23 点到 6 点 tired +3、连轮 ≥6 tired +2。
 *
 * @param {object} signal { at, assistantTexts, userTexts, kind, hour, turnStreak }
 * @returns {{dims:object, raw:number, confidence:number, evidence:string[], source:string}}
 */
export function judgeSelf(signal = {}) {
  const mine = (signal.assistantTexts ?? []).join('\n')
  const lines = sentencesOf(mine)
  const theirs = (signal.userTexts ?? []).join('\n')
  const d = { happy: 0, tired: 0, sad: 0, care: 0 }
  const evidence = []

  // 1) 我话里的情绪词：每类只算一次（同义词堆十个不算十次）
  for (const [group, words] of Object.entries(WORDS)) {
    const hit = words.find((w) => mine.includes(w))
    if (hit === undefined) continue
    const dim = WORD_DIM[group]
    const weight = group === 'anxious' ? 4 : group === 'happy' ? 6 : group === 'care' ? 5 : 7
    d[dim] += weight
    const q = quoteOf(lines, hit)
    evidence.push(q === '' ? `我话里有「${hit}」` : `我说「${q}」`)
  }

  // 2) 语气特征
  const 不想 = ['不想', '算了'].find((w) => mine.includes(w))
  if (不想 !== undefined) { d.tired += 5; evidence.push(`我说「${quoteOf(lines, 不想)}」`) }
  const 没事 = ['没事', '无所谓'].find((w) => mine.includes(w))
  if (没事 !== undefined) { d.sad += 3; evidence.push(`我说「${quoteOf(lines, 没事)}」`) }

  const lens = lines.map((x) => x.length)
  const avg = lens.length === 0 ? 0 : lens.reduce((a, b) => a + b, 0) / lens.length
  if (lines.length > 0 && avg >= 30) { d.care += 3; evidence.push('我说得展开，想多说几句') }
  else if (lines.length >= 2 && avg <= 8) { d.sad += 2; evidence.push('我话说得短促') }

  const quiet = (signal.userTexts ?? []).every((t) => String(t ?? '').trim() === '')
  if (lines.length > 0 && quiet) { d.happy += 3; evidence.push('没人问，我自己开的口') }

  // 3) 对方的话：只当冲击，系数 ≤ 旧版的 1/3
  if (PRAISE.some((w) => theirs.includes(w))) { d.happy += 1; evidence.push('他夸了一句') }
  if (NEGATE.some((w) => theirs.includes(w))) { d.sad += 2; evidence.push('他否了一句') }

  // 4) 环境
  if (signal.kind === 'error' || signal.kind === 'blocked') { d.sad += 3; evidence.push('这轮没跑通') }
  const hour = Number.isInteger(signal.hour) ? signal.hour : new Date(signal.at ?? Date.now()).getHours()
  if (hour >= 23 || hour < 6) { d.tired += 3; evidence.push('这个点还没停') }
  if ((signal.turnStreak ?? 0) >= 6) { d.tired += 2; evidence.push('连着干了好几轮') }

  const raw = d.happy + d.care * 0.5 - d.sad * 1.2 - d.tired * 0.8
  const confidence = numClamp(35 + evidence.length * 15, 0, 95)
  return { dims: d, raw, confidence, evidence, source: 'self' }
}

/**
 * 信号分派：带了 `assistantTexts`（哪怕是空数组）就走新路径。
 * 空数组 = 「这一轮我没说话」，判定为 0，不退回旧路径——否则又变回镜子。
 *
 * @param {object} signal 本轮信号
 * @returns {{dims:object, raw:number, confidence:number, evidence:string[], source:string}}
 */
export function judgeSignal(signal = {}) {
  return Array.isArray(signal?.assistantTexts) ? judgeSelf(signal) : judgeUser(signal)
}

// ---- 出口：「我不想做」那本账的原文匹配 ----

/**
 * 我这一轮说的话里有没有「我不想做」这类句子。**只记我的原话，只记不执行。**
 *
 * @param {string[]} texts 我的话
 * @returns {string[]} 命中的原句（每句截 80 字，最多 3 句）
 */
export function matchUnwilling(texts) {
  const hits = []
  for (const raw of texts ?? []) {
    for (const line of sentencesOf(raw)) {
      if (UNWILLING.test(line)) hits.push(line.slice(0, 80))
    }
  }
  return hits.slice(0, 3)
}
