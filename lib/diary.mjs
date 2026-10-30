/**
 * 日记：到点自己写一笔，不管有没有人找。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 注入上下文时最多带几篇日记。 */
export const DIARY_INJECT_MAX = 2
/** 一篇日记的长度上限（字符）。 */
export const DIARY_MAX_CHARS = 400

/**
 * 造日记相关函数。
 *
 * @param {object} deps
 * @param {object} deps.db 记忆库
 * @param {Function} deps.askModel 调模型
 * @param {Function} deps.diaryEnabled 是否开启
 * @param {Function} deps.bumpStat 计数
 * @param {Function} deps.clamp 截断
 * @returns {{dayKeyOf:Function, writeDiary:Function, diarySources:Function}}
 */
export function createDiary(deps) {
  const { db, askModel, diaryEnabled, bumpStat, clamp } = deps

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

  return { dayKeyOf, writeDiary, diarySources }
}
