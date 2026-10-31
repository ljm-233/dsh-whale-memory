/**
 * 桌面页：一轮读一次的那一页，也是整套记忆的「正面」。
 *
 * 它不存细节，只放四样：我是谁、关于这个人、我守的约、手上在做什么。
 * 全部内容都从库（唯一真相）里蒸出来，蒸完过预算：总字节 ≤4096，
 * 其中「事」那一段 ≤2048；人和约只缩不删，缩的规矩固定四级，
 * 所以同一份记忆每次缩出来的都是同一句，不会今天一个说法明天一个说法。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clamp } from './format.mjs'
import { DESK_TOTAL_BYTES, DESK_MATTERS_BYTES, DESK_PEOPLE_BYTES, DESK_PROMISE_BYTES, IMPORTANT_WEIGHT } from './constants.mjs'

/** UTF-8 字节数——预算按字节算，不按字符算。 */
export const byteLen = (text) => Buffer.byteLength(String(text ?? ''), 'utf8')

/** 桌面页里固定不变的那一节：记忆怎么转。 */
export const HOW_MEMORY_MOVES = [
  '## 记忆怎么转',
  '- 开场自报：每天第一次开口先说三句——昨天投了几条命中、昨天日档写没写、长期动没动。',
  '- 补检：隔 60 分钟做四眼——自查戳、昨天日志字节数、待并入空不空、日志有没有；缺啥补啥，再改戳。',
  '- 翻本子：桌面页给日期 → 只开那天的纸 → 搜关键词，不许整读。',
  '- 收尾自报：22:35 在日志末尾补三行——日档、总体、长期（+N 条或今天没变）。',
].join('\n')

const SENTENCE_END = /[。！？；\n]/

/**
 * 四级压缩：原句 → 取前半句子 → 取第一句 → 去修饰取前 20 字。
 *
 * 只按句子砍，不按字砍，所以读起来还是人话；四级都超预算才硬截。
 *
 * @param {string} text 原文
 * @param {number} max 预算（UTF-8 字节）
 * @returns {{text:string, level:number}} 压缩结果与用到的级数（0 表示原样）
 */
export function compressLadder(text, max) {
  const raw = String(text ?? '').trim()
  if (raw === '' || byteLen(raw) <= max) return { text: raw, level: 0 }

  const sentences = []
  let current = ''
  for (const ch of raw) {
    current += ch
    if (SENTENCE_END.test(ch)) {
      sentences.push(current)
      current = ''
    }
  }
  if (current !== '') sentences.push(current)

  // 一级：砍掉后半的句子，留前半。
  const half = sentences.slice(0, Math.max(1, Math.ceil(sentences.length / 2))).join('')
  if (byteLen(half) <= max) return { text: half, level: 1 }

  // 二级：只留第一句。
  const first = sentences[0] ?? raw
  if (byteLen(first) <= max) return { text: first, level: 2 }

  // 三级：去掉开头的虚词，再取前 20 字。
  const bare = first.replace(/^(其实|而且|然后|不过|但是|所以|因为|就是|反正|说起来)[，,]?/u, '')
  const twenty = Array.from(bare).slice(0, 20).join('')
  if (byteLen(twenty) <= max) return { text: twenty, level: 3 }

  // 四级：预算比 20 字还紧，只能硬截。
  return { text: clamp(bare, Math.max(1, Math.floor(max / 3))), level: 4 }
}

/** 读一份可手改的文本（约.md 之类）；不存在就当空。 */
function readOptionalFile(path) {
  try {
    if (!existsSync(path)) return ''
    return readFileSync(path, 'utf8').trim()
  } catch { return '' }
}

/**
 * 从库里蒸出桌面页。
 *
 * @param {object} db 记忆库
 * @param {object} [opts]
 * @param {string} [opts.space] 记忆空间
 * @param {string} [opts.promises] 契约文本（手写的约）
 * @param {string} [opts.selfIntro] 「我是谁」那一行
 * @returns {{text:string, bytes:number, counts:object, levels:object}}
 */
export function buildDesk(db, opts = {}) {
  const space = String(opts.space ?? 'default')
  const counts = { people: 0, promises: 0, matters: 0 }
  const levels = { people: 0, promises: 0, matters: 0 }

  // 人：画像蒸出来的那一段，读不到就留空，不编。
  let people = String(opts.persona ?? '').trim()
  if (people === '') {
    try {
      people = String(db.prepare("SELECT v FROM meta WHERE k='persona'").get()?.v ?? '').trim()
    } catch { people = '' }
  }
  const intro = String(opts.selfIntro ?? '米鱼（Miyu）。这只身体跑在 Arch 上，记忆在库里，不在上下文里。').trim()
  let peopleBlock = [`## 我是谁`, intro, '', `## 关于这个人`, people === '' ? '（还没蒸出来）' : people].join('\n')
  const peopleFit = compressLadder(peopleBlock, DESK_PEOPLE_BYTES)
  peopleBlock = peopleFit.text
  levels.people = peopleFit.level
  counts.people = people === '' ? 0 : people.split(/\n/u).filter((l) => l.trim() !== '').length

  // 约：手写、只认文件，不自动生成，也永不自动删。
  const promisesRaw = String(opts.promises ?? '').trim()
  let promisesBlock = ['## 我守的约', promisesRaw === '' ? '（还没写）' : promisesRaw].join('\n')
  const promiseFit = compressLadder(promisesBlock, DESK_PROMISE_BYTES)
  promisesBlock = promiseFit.text
  levels.promises = promiseFit.level
  counts.promises = promisesRaw === '' ? 0 : promisesRaw.split(/\n/u).filter((l) => l.trim() !== '').length

  // 事：手上在做什么。热区里最近的、还压得住的几条。
  let matters = ''
  try {
    const rows = db.prepare(
      'SELECT u, a, w, t FROM entries WHERE space = ? AND hot = 1 ORDER BY t DESC LIMIT 12',
    ).all(space).filter((r) => !String(r.u ?? '').startsWith('（归档）'))
    matters = rows.map((r, i) => {
      const when = new Date(Number(r.t)).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
      return `${i + 1}. [${when}] ${clamp(String(r.u ?? '').replace(/\s+/gu, ' ').trim(), 40)} → ${clamp(String(r.a ?? '').replace(/\s+/gu, ' ').trim(), 30)}`
    }).join('\n')
    counts.matters = rows.length
  } catch { matters = '' }
  let mattersBlock = ['## 手上在做什么', matters === '' ? '（热区是空的）' : matters].join('\n')
  const matterFit = compressLadder(mattersBlock, DESK_MATTERS_BYTES)
  mattersBlock = matterFit.text
  levels.matters = matterFit.level

  let text = [peopleBlock, promisesBlock, mattersBlock, HOW_MEMORY_MOVES].join('\n\n')
  // 总预算最后兜一次：超了就先缩「事」，人和约最后才动。
  if (byteLen(text) > DESK_TOTAL_BYTES) {
    const spare = Math.max(400, DESK_TOTAL_BYTES - byteLen([peopleBlock, promisesBlock, HOW_MEMORY_MOVES].join('\n\n')))
    mattersBlock = compressLadder(mattersBlock, spare).text
    text = [peopleBlock, promisesBlock, mattersBlock, HOW_MEMORY_MOVES].join('\n\n')
  }
  return { text, bytes: byteLen(text), counts, levels }
}

/**
 * 把桌面页落到磁盘，顺手写成一份可读文件。
 *
 * @param {string} memoryDir 记忆目录
 * @param {string} text 桌面页正文
 * @returns {string} 文件路径
 */
export function writeDeskFile(memoryDir, text) {
  const dir = join(memoryDir, '记忆本')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, '桌面页.md')
  writeFileSync(path, `${text}\n`, 'utf8')
  return path
}

/**
 * 读手写的约（memoryDir/约.md）。
 *
 * @param {string} memoryDir 记忆目录
 * @returns {string}
 */
export function readPromises(memoryDir) {
  return readOptionalFile(join(memoryDir, '约.md'))
}

/**
 * 桌面页的条目数：给自证用。
 *
 * @param {object} db 记忆库
 * @param {string} [space] 记忆空间
 * @returns {{hot:number, cold:number, facts:number, important:number}}
 */
export function deskCounts(db, space = 'default') {
  const one = (sql, ...args) => {
    try { return Number(db.prepare(sql).get(...args)?.c ?? 0) } catch { return 0 }
  }
  return {
    hot: one('SELECT COUNT(*) c FROM entries WHERE hot = 1 AND space = ?', space),
    cold: one('SELECT COUNT(*) c FROM entries WHERE hot = 0 AND space = ?', space),
    facts: one('SELECT COUNT(*) c FROM facts WHERE space = ?', space),
    important: one('SELECT COUNT(*) c FROM entries WHERE w >= ? AND space = ?', IMPORTANT_WEIGHT, space),
  }
}
