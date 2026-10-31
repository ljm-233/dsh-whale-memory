/**
 * 画像层：把「我记得的你」从记忆里蒸出来，稳定地放在系统提示里。
 *
 * 和偏好文件的分工：偏好是我自己认的（可手改），画像是从事实里长出来的（可重建）。
 * 两者都不该每轮现算——画像在梳理时重建，注入时只读一行 meta。
 */
import { clamp } from './format.mjs'
import { cueWords } from './language.mjs'

/** 画像在 meta 表里的键。 */
const KEY = 'persona'

/**
 * 从当前记忆里蒸一张画像（纯规则，不调模型）。
 *
 * 组成：稳定事实 → 高频线索 → 场景主题 → 情绪分布。
 * 只写「看得出来」的，不做性格判断，避免把人写成一个标签。
 *
 * @param {object} db 数据库
 * @param {{maxFacts?:number,maxTopics?:number}} [opts] 参数
 * @returns {string} 画像正文，没东西可写时为空串
 */
export function distillPersona(db, opts = {}) {
  const maxFacts = opts.maxFacts ?? 10
  const space = String(opts.space ?? 'default')
  const maxTopics = opts.maxTopics ?? 5
  const lines = []

  let facts = []
  try {
    facts = db.prepare('SELECT f FROM facts WHERE space=? ORDER BY id DESC LIMIT ?').all(space, maxFacts).map((r) => r.f)
  } catch { /* 表没建好就跳过 */ }
  if (facts.length > 0) lines.push(`已知：${facts.join('；')}`)

  // 高频线索：近 300 条冷记忆里反复出现的词，代表聊得最多的事。
  let topics = []
  try {
    const rows = db.prepare('SELECT u FROM entries ORDER BY t DESC LIMIT 300').all()
    const freq = new Map()
    for (const r of rows) {
      for (const c of new Set(cueWords(String(r.u ?? '')))) {
        if (c.length < 2) continue
        freq.set(c, (freq.get(c) ?? 0) + 1)
      }
    }
    topics = [...freq.entries()]
      .filter(([c, n]) => n >= 3 && c.length >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxTopics)
      .map(([c]) => c)
  } catch { /* 忽略 */ }
  if (topics.length > 0) lines.push(`常聊：${topics.join('、')}`)

  try {
    const scenes = db.prepare('SELECT topic FROM scenes ORDER BY updated DESC LIMIT ?').all(maxTopics)
    if (scenes.length > 0) lines.push(`成段的旧事：${scenes.map((s) => s.topic).join('、')}`)
  } catch { /* 忽略 */ }

  try {
    const rows = db.prepare("SELECT emo FROM entries WHERE emo != '[]' ORDER BY t DESC LIMIT 200").all()
    const count = new Map()
    for (const r of rows) {
      for (const e of JSON.parse(r.emo || '[]')) count.set(e, (count.get(e) ?? 0) + 1)
    }
    const top = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    if (top.length > 0) lines.push(`情绪底色：${top.map(([e, n]) => `${e}(${n})`).join('、')}`)
  } catch { /* 忽略 */ }

  return clamp(lines.join('\n'), 800)
}

/**
 * 重建画像并写回 meta。
 *
 * @param {object} db 数据库
 * @returns {string} 新的画像正文
 */
export function rebuildPersona(db, opts = {}) {
  const text = distillPersona(db, opts)
  try {
    db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(KEY, text)
  } catch { /* 写不进就只在内存里用 */ }
  return text
}

/**
 * 读上一次重建的画像。
 *
 * @param {object} db 数据库
 * @returns {string}
 */
export function readPersona(db) {
  try {
    return String(db.prepare('SELECT v FROM meta WHERE k = ?').get(KEY)?.v ?? '')
  } catch { return '' }
}

/**
 * 读模型写的那版画像（可能不存在）。
 *
 * @param {object} db 数据库
 * @returns {string}
 */
export function readPersonaLlm(db) {
  try {
    return String(db.prepare("SELECT v FROM meta WHERE k='personaLLM'").get()?.v ?? '')
  } catch { return '' }
}
