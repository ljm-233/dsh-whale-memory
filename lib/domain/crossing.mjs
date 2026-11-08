/**
 * 两边（群聊 ↔ 私聊）自动同步。
 *
 * 背景：同一个我跑在两个会话里，两份上下文互不相识。原来靠 `scripts/sync-line.sh` /
 * `scripts/sync-say.sh` 手工写，忘了就断。这一块把它接到 `session/event` 的 `turn/end` 上：
 *
 *   1. 轮末把这一轮压成一行（≤60 字），带 [group]/[dm] 标记，append 到 `db/两边.md`；
 *   2. 这一轮里不超过 80 字的原话，各记一条到 `db/两边-原话.md`（长了不搬，免得整篇搬来搬去）；
 *   3. 同一条消息不记两遍：sessionId + turn 做键，落在 `db/.crossing-state.json`；
 *   4. 容量：`两边.md` 留最近 200 行，`两边-原话.md` 留最近 100 条，append 之后裁；
 *   5. 任何异常吞掉记一条 warn——同步失败不该让这一轮崩。
 *
 * 格式一个字都没动：`wake.mjs` 按「以 `- ` 开头」的行/条去解析这两个文件，
 * 写出来的每一行仍是 `- MM-DD HH:MM [group|dm] 群聊：…` / `- MM-DD HH:MM [group|dm] 我说：…`。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { textOf } from '../format.mjs'
import { windowOf } from '../session.mjs'

/** 两个共用文件（相对记忆库）。 */
export const LINE_FILE = '两边.md'
export const SAY_FILE = '两边-原话.md'
/** 去重状态。 */
export const STATE_FILE = '.crossing-state.json'

/** 摘要一行最多多少字（不含 `- 时间 [标记] ` 前缀）；原话最多多少字。 */
export const SUMMARY_MAX = 60
export const QUOTE_MAX = 80
/** 两个文件各留多少（行 / 条）。 */
export const LINE_KEEP = 200
export const SAY_KEEP = 100
/** 去重键最多记多少条（只防重放，不防久）。 */
export const KEY_KEEP = 500

/** 建文件时才用的头（跟手工脚本写的一模一样，只为了让新库看起来一致）。 */
const LINE_HEAD = '# 两边共用流水（群聊 ↔ 私聊）\n\n> 每轮谁说话谁写一行。最近 8 行会被 wake.mjs 算进「现在」。\n\n'
const SAY_HEAD = '# 两边原话（最近 20 条）\n\n> 群聊/私聊各记各的，另一边下一轮读得到。只留最近 20 条。\n\n'

/** 群档默认位置：QQ 机器人把 会话 id ↔ 「c2c:/group:」的对照写在这里。 */
const DEFAULT_SESSIONS_DIR = join(homedir(), '.dsh', 'integrations', 'dsh-qq', 'bots')

/** 空白压成单空格：写进「一行」的东西不能带换行，否则一条变好几条。 */
const flat = (text) => String(text ?? '').replace(/\s+/gu, ' ').trim()

/** 句读：截断时优先切在这里，别把一句话从中间剁开。 */
const BREAK_CHARS = '；。！？…，,;!?'

/**
 * 把一段话压成一行：先压空白，再按长度截。
 *
 * @param {string} text 原话
 * @param {number} max 最多多少字
 * @returns {string} 一行
 */
export function oneLine(text, max = SUMMARY_MAX) {
  const s = flat(text)
  if (s.length <= max) return s
  const floor = Math.max(1, Math.floor(max * 0.4))
  const head = s.slice(0, max - 1)
  let cut = -1
  for (let i = head.length - 1; i >= floor; i -= 1) {
    if (BREAK_CHARS.includes(head[i])) { cut = i; break }
  }
  if (cut < 0) return `${head}…`
  return `${head.slice(0, cut + 1)}…`
}

/**
 * 事件里的消息体：`data` 自带 content 就是它（user/message 的形状），
 * 否则往 `data.message` / `event.message` 里找（assistant/message 的形状）。
 *
 * @param {object} event 会话事件
 * @returns {object|null} 消息体
 */
export function pickMessage(event) {
  const cand = event?.data ?? event?.message ?? event
  if (!cand || typeof cand !== 'object') return null
  if (Array.isArray(cand.content)) return cand
  const inner = cand.message ?? event?.message
  return inner && typeof inner === 'object' ? inner : cand
}

/** 本地时间戳，格式与手工脚本一致（`MM-DD HH:MM`）。 */
export function stampOf(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 从会话的窗口标记认来源。`windowOf()` 会先试 `conversationKey/channel/kind/source`，
 * 里面只要出现 `c2c`/`dm` 就当私聊，出现 `group` 就当群聊。
 *
 * @param {string} sig 窗口标记
 * @returns {'group'|'dm'|''} 认不出给空串
 */
export function classifyWindow(sig) {
  const s = String(sig ?? '').toLowerCase()
  if (s === '') return ''
  if (s.includes('c2c') || s.includes('private') || s.includes('dm') || s.includes('single')) return 'dm'
  if (s.includes('group') || s.includes('channel') || s.includes('room')) return 'group'
  return ''
}

/**
 * 扫机器人状态里的 `sessions: {"c2c:…"|"group:…": sessionId}`，得到 sessionId → 来源。
 * 读不到就是空表，调用方自己兜底。
 *
 * @param {string} dir bots 目录
 * @returns {Map<string,'group'|'dm'>} 对照
 */
export function scanSessions(dir) {
  const out = new Map()
  let bots = []
  try { bots = readdirSync(dir) } catch { return out }
  for (const bot of bots) {
    const p = join(dir, bot, 'state.json')
    if (!existsSync(p)) continue
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'))
      for (const [key, sid] of Object.entries(raw?.sessions ?? {})) {
        if (typeof sid !== 'string' || sid === '') continue
        const k = key.toLowerCase()
        if (k.startsWith('c2c:')) out.set(sid, 'dm')
        else if (k.startsWith('group:') || k.startsWith('group_') || k.startsWith('guild')) out.set(sid, 'group')
      }
    } catch { /* 一个机器人的状态读不出来，不影响别的 */ }
  }
  return out
}

/**
 * 裁剪：保留文件头（第一条 `- ` 之前的行）+ 最近 keep 条。
 * 没超就一次都不写——省掉多余的 IO，也少一次跟另一边抢 rename 的机会。
 *
 * @param {string} file 文件
 * @param {number} keep 留几条
 * @returns {number} 裁完剩几条
 */
export function trimFile(file, keep) {
  const raw = readFileSync(file, 'utf8')
  const lines = raw.split('\n').filter((l) => l !== '')
  const head = []
  let i = 0
  for (; i < lines.length; i += 1) {
    if (lines[i].startsWith('- ')) break
    head.push(lines[i])
  }
  const entries = lines.slice(i).filter((l) => l.startsWith('- '))
  if (entries.length <= keep) return entries.length
  const tmp = `${file}.crossing-tmp`
  writeFileSync(tmp, `${[...head, ...entries.slice(-keep)].join('\n')}\n`, 'utf8')
  renameSync(tmp, file)
  return keep
}

/**
 * 两边同步器。
 *
 * @param {object} deps 依赖
 * @param {string} deps.memoryDir 记忆库目录（两个文件在它下面的 db/）
 * @param {string} [deps.sessionsDir] 机器人状态目录（测试可指到临时目录）
 * @param {Function} [deps.warn] 记一条 warn
 * @param {Function} [deps.now] 取当前时间（测试用）
 * @returns {{handleSessionEvent:Function, sourceOf:Function, noteTurn:Function}} 句柄
 */
export function createCrossing({
  memoryDir, sessionsDir = DEFAULT_SESSIONS_DIR, warn = () => {}, now = () => new Date(),
}) {
  const dbDir = join(String(memoryDir ?? ''), 'db')
  const linePath = join(dbDir, LINE_FILE)
  const sayPath = join(dbDir, SAY_FILE)
  const statePath = join(dbDir, STATE_FILE)

  // 这一轮攒的话，按会话分开（两个窗口不串味）。
  const turns = new Map()
  // 去重键（懒加载）。
  let keys = null
  // 来源对照缓存：sessionId → { at, ch }。
  const srcCache = new Map()
  const SRC_TTL_MS = 60 * 1000

  const warnOnce = (err) => {
    try { warn(`同步没成：${err?.message ?? err}`) } catch { /* warn 自己别再炸一次 */ }
  }

  const loadKeys = () => {
    if (keys !== null) return keys
    keys = []
    try {
      const raw = JSON.parse(readFileSync(statePath, 'utf8'))
      if (Array.isArray(raw?.keys)) keys = raw.keys.filter((k) => typeof k === 'string').slice(-KEY_KEEP)
    } catch { /* 没有状态文件是常态 */ }
    return keys
  }

  const saveKeys = () => {
    try {
      mkdirSync(dbDir, { recursive: true })
      writeFileSync(statePath, `${JSON.stringify({ v: 1, keys: keys.slice(-KEY_KEEP) })}\n`, 'utf8')
    } catch (err) { warnOnce(err) }
  }

  /** 认来源：先看会话自带的窗口标记，再查机器人状态，最后默认群聊。 */
  const sourceOf = (session, sid) => {
    const byWindow = classifyWindow(windowOf(session))
    if (byWindow !== '') return byWindow
    const hit = srcCache.get(sid)
    const at = Date.now()
    if (hit && at - hit.at < SRC_TTL_MS) return hit.ch
    let ch = 'group'
    try {
      const found = scanSessions(sessionsDir).get(sid)
      if (found === 'dm' || found === 'group') ch = found
    } catch (err) { warnOnce(err) }
    srcCache.set(sid, { at, ch })
    return ch
  }

  const append = (file, head, line, keep) => {
    mkdirSync(dbDir, { recursive: true })
    if (!existsSync(file)) writeFileSync(file, head, 'utf8')
    appendFileSync(file, `${line}\n`, 'utf8')
    trimFile(file, keep)
  }

  const bufOf = (sid) => turns.get(sid) ?? { user: [], self: [] }

  /** 轮末：落一行摘要 + 短原话。任何异常都咽掉。 */
  const noteTurn = (session, event) => {
    const sid = String(session?.id ?? 'unknown')
    const buf = bufOf(sid)
    turns.delete(sid)
    const userText = flat(buf.user.join(' '))
    const selfText = flat(buf.self.join(' '))
    if (userText === '' && selfText === '') return ''

    // 去重键：sessionId + turn（宿主没有 turn 时退回「这一轮的原话」当键，同样稳定）。
    const turn = event?.data?.turn
    const key = turn === undefined || turn === null
      ? `${sid}#${selfText.slice(0, 40)}|${userText.slice(0, 40)}`
      : `${sid}#${turn}`
    const seen = loadKeys()
    if (seen.includes(key)) return ''

    const ch = sourceOf(session, sid)
    const tag = ch === 'dm' ? '私聊' : '群聊'
    const body = selfText !== '' ? oneLine(selfText, SUMMARY_MAX - tag.length - 1) : oneLine(`他：${userText}`, SUMMARY_MAX - tag.length - 1)
    const at = now()
    const line = `- ${stampOf(at)} [${ch}] ${tag}：${body}`
    append(linePath, LINE_HEAD, line, LINE_KEEP)

    // 原话：只记短的。两边各记各的，跟 `sync-say.sh` 的「他说/我说」一致。
    for (const [who, text] of [['他', userText], ['我', selfText]]) {
      if (text === '' || text.length > QUOTE_MAX) continue
      append(sayPath, SAY_HEAD, `- ${stampOf(at)} [${ch}] ${who}说：${text}`, SAY_KEEP)
    }

    seen.push(key)
    if (seen.length > KEY_KEEP) seen.splice(0, seen.length - KEY_KEEP)
    saveKeys()
    return line
  }

  const handleSessionEvent = (session, event) => {
    try {
      if (!event || typeof event.type !== 'string') return
      const sid = String(session?.id ?? 'unknown')
      if (event.type === 'user/message') {
        // 宿主给的是 `data` 直接带 content 的 UserMessage；两种形状都认，别因为一层嵌套漏读。
        const msg = pickMessage(event)
        if (!msg || msg.source?.kind !== 'user') return
        const text = textOf(msg)
        if (text === '') return
        const t = bufOf(sid)
        turns.set(sid, { ...t, user: [...t.user.slice(-1), String(text).slice(0, 1000)] })
      } else if (event.type === 'assistant/message') {
        const msg = pickMessage(event)
        if (!msg || typeof msg !== 'object') return
        const text = textOf(msg)
        if (text === '') return
        const t = bufOf(sid)
        turns.set(sid, { ...t, self: [...t.self.slice(-2), String(text).slice(0, 2000)] })
      } else if (event.type === 'turn/end') {
        noteTurn(session, event)
      }
    } catch (err) { warnOnce(err) }
  }

  return { handleSessionEvent, noteTurn, sourceOf }
}
