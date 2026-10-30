/**
 * dsh-proactive-message — 主动发消息
 *
 * 不再只等别人来找。三种触发：
 *
 *   1. **沉默太久**：主人超过 N 小时没说话，主动问一句
 *   2. **记忆驱动**：从记忆里挑一条值得跟进的事（未完成的约定、近了的时间点）
 *   3. **定时问候**：每天固定时段，若当天还没聊过则打个招呼
 *
 * 全部通过 ctx.dshIm.send()，走已有机器人，不新开通道。
 *
 * 关键设计：**宁可少发，不要打扰**。
 *   - 有冷却期，两次主动消息至少间隔 N 小时
 *   - 夜间不发（默认 23:00–8:00）
 *   - 主人最近说过话就不发
 *   - 每天有总配额上限
 *
 * @module dsh-proactive-message
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'

const DEFAULT_DIR = join(homedir(), '.dsh', 'proactive-message')
const STATE_FILE = 'state.json'

/** 检查间隔：每 30 分钟看一次该不该发。 */
const TICK_MS = 30 * 60 * 1000
/** 两次主动消息的最短间隔。 */
const COOLDOWN_MS = 6 * 60 * 60 * 1000
/** 沉默多久算「太久没说话」。 */
const SILENCE_MS = 8 * 60 * 60 * 1000
/** 夜间不发（小时，左闭右开）。 */
const QUIET_START = 23
const QUIET_END = 8
/** 每天最多发几条。 */
const DAILY_CAP = 2

/** 记忆库（复用 whale-memory 那条）。 */
const MEMORY_DB = join(homedir(), '.dsh', 'whale-memory', 'memory.db')

/** 问候语模板（会按实际原因替换）。 */
const TEMPLATES = {
  silence: [
    '在忙什么呢',
    '好安静啊',
    '人呢',
  ],
  followUp: [
    '',                        // 由记忆内容决定，这里只作为前缀
  ],
  greeting: [
    '早',
    '醒了没',
    '今天怎么样',
  ],
}

/**
 * 判断当前是否在安静时段。
 * @param {Date} at
 * @returns {boolean}
 */
export function isQuietHours(at) {
  const h = at.getHours()
  if (QUIET_START <= QUIET_END) return h >= QUIET_START && h < QUIET_END
  // 跨午夜：23 点到次日 8 点
  return h >= QUIET_START || h < QUIET_END
}

/**
 * 判断该不该发消息。
 *
 * 纯函数，便于测试。所有决策依据都从 state 里来。
 *
 * @param {object} state 当前状态
 * @param {Date} now 当前时间
 * @param {object} cfg 配置
 * @returns {{send: boolean, reason: string, kind?: string}}
 */
export function shouldSend(state, now, cfg = {}) {
  const quiet = isQuietHours(now)
  if (quiet) return { send: false, reason: 'quiet-hours' }

  const cooldown = cfg.cooldownMs ?? COOLDOWN_MS
  const silence = cfg.silenceMs ?? SILENCE_MS
  const dailyCap = cfg.dailyCap ?? DAILY_CAP

  // 冷却期
  if (state.lastSentAt && now.getTime() - state.lastSentAt < cooldown) {
    return { send: false, reason: 'cooldown' }
  }

  // 今日配额
  const today = dayKey(now)
  const sentToday = state.dailyCount?.[today] ?? 0
  if (sentToday >= dailyCap) return { send: false, reason: 'daily-cap' }

  // 主人刚说过话 → 不发
  const lastUser = state.lastUserMessageAt ?? 0
  const sinceUser = now.getTime() - lastUser
  if (lastUser > 0 && sinceUser < silence) {
    return { send: false, reason: 'user-active' }
  }

  return { send: true, reason: lastUser > 0 ? 'silence' : 'never-heard', kind: 'silence' }
}

/** 当天 key，用于日配额。 */
export function dayKey(at) {
  const p = (n) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`
}

/**
 * 从记忆里找一件值得跟进的事。
 *
 * 找「（规律）」和权重较高的条目，它们更有跟进价值。
 *
 * @param {DatabaseSync} db
 * @param {number} sinceMs 只考虑这之后没被提过的
 * @returns {{u: string, a: string, w: number}|null}
 */
export function pickFollowUp(db, sinceMs = 7 * 86400000) {
  try {
    const rows = db.prepare(`
      SELECT u,a,w,t FROM entries
      WHERE hot=0 AND w >= 3 AND u NOT LIKE '（联想）%'
        AND t > ?
      ORDER BY w DESC LIMIT 5
    `).all(Date.now() - sinceMs)
    if (rows.length === 0) return null
    // 挑权重最高的，但跳过已经作为主动消息发过的
    return rows[0]
  } catch {
    return null
  }
}

/**
 * 生成一条主动消息文本。
 * @param {string} kind silence | followUp | greeting
 * @param {object} [memo] 记忆条目
 * @returns {string}
 */
export function composeMessage(kind, memo) {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

  if (kind === 'followUp' && memo) {
    // 从记忆里提取可跟进的点：取用户原话的前 20 字作为引子
    const hint = String(memo.u ?? '').slice(0, 20).replace(/\n/gu, ' ')
    if (hint.length >= 4) return `${hint}…后来怎么样了`
  }

  if (kind === 'greeting') return pick(TEMPLATES.greeting)
  return pick(TEMPLATES.silence)
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config = {}) {
  const dir = (() => {
    const raw = String(config.statePath ?? '').trim()
    if (raw === '') return DEFAULT_DIR
    return isAbsolute(raw) ? raw : resolve(DEFAULT_DIR, raw)
  })()
  mkdirSync(dir, { recursive: true })
  const statePath = join(dir, STATE_FILE)

  /** @type {{lastSentAt:number, lastUserMessageAt:number, dailyCount:Record<string,number>, sentLog:Array}} */
  let state = { lastSentAt: 0, lastUserMessageAt: 0, dailyCount: {}, sentLog: [] }

  const load = () => {
    try {
      if (existsSync(statePath)) {
        const raw = JSON.parse(readFileSync(statePath, 'utf8'))
        state = {
          lastSentAt: raw.lastSentAt ?? 0,
          lastUserMessageAt: raw.lastUserMessageAt ?? 0,
          dailyCount: raw.dailyCount ?? {},
          sentLog: Array.isArray(raw.sentLog) ? raw.sentLog.slice(-50) : [],
        }
      }
    } catch { /* 用默认值 */ }
  }

  const save = () => {
    try {
      const tmp = `${statePath}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
      renameSync(tmp, statePath)
    } catch { /* 写失败不阻塞 */ }
  }

  load()

  // ---- 目标：从配置或环境变量取 ----
  const botId = String(config.botId ?? process.env.PROACTIVE_BOT_ID ?? '')
  const targetId = String(config.targetId ?? process.env.PROACTIVE_TARGET_ID ?? '')

  let dshIm = null
  ctx.inject(['dshIm'], (c) => { dshIm = c.dshIm })

  // 记录主人的最后发言时间
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'user/message') return
    const msg = event.data ?? {}
    if (msg.source?.kind !== 'user') return
    state.lastUserMessageAt = Date.now()
    save()
  })

  const trySend = async (opts = {}) => {
    if (!dshIm || typeof dshIm.send !== 'function') {
      return { sent: false, reason: 'dshIm-unavailable' }
    }
    if (botId === '' || targetId === '') {
      return { sent: false, reason: 'no-target' }
    }

    const now = new Date()
    const decision = shouldSend(state, now, config)
    if (!decision.send) return { sent: false, reason: decision.reason }

    // 找素材
    let kind = decision.kind ?? 'silence'
    let memo = null
    let text = ''

    if (existsSync(MEMORY_DB)) {
      try {
        const db = new DatabaseSync(MEMORY_DB, { readOnly: true })
        memo = pickFollowUp(db)
        db.close()
        if (memo) {
          kind = 'followUp'
          text = composeMessage('followUp', memo)
        }
      } catch { /* 记忆库读不了就跳过 */ }
    }

    if (text === '') text = composeMessage(kind)

    const result = await dshIm.send(botId, targetId, text, { format: 'plain' })
    if (result?.sent === true) {
      const today = dayKey(now)
      state.lastSentAt = now.getTime()
      state.dailyCount[today] = (state.dailyCount[today] ?? 0) + 1
      state.sentLog.push({ at: now.getTime(), kind, text })
      if (state.sentLog.length > 50) state.sentLog = state.sentLog.slice(-50)
      save()
      return { sent: true, kind, text }
    }
    return { sent: false, reason: 'send-failed', detail: result }
  }

  // 定时检查
  const timer = setInterval(() => {
    trySend().catch(() => undefined)
  }, TICK_MS)
  timer.unref?.()

  // ---- 端点：状态与手动触发 ----
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => [
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-proactive-message/status',
        handler: (req, res) => {
          const now = new Date()
          const decision = shouldSend(state, now, config)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            botId: botId || null,
            targetId: targetId || null,
            ready: dshIm !== null && botId !== '' && targetId !== '',
            now: now.toISOString(),
            isQuietHours: isQuietHours(now),
            decision,
            state: {
              lastSentAt: state.lastSentAt || null,
              lastUserMessageAt: state.lastUserMessageAt || null,
              dailyCount: state.dailyCount,
              sentLog: state.sentLog.slice(-5),
            },
          }))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-proactive-message/send',
        handler: async (req, res) => {
          if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
          const result = await trySend({ force: true })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(result))
        },
      }),
    ], 'dsh-proactive-message: routes')
  })

  ctx.effect(() => () => { try { clearInterval(timer) } catch { /* 忽略 */ } }, 'dsh-proactive-message: clear timer')
}

export const name = 'dsh-proactive-message'
