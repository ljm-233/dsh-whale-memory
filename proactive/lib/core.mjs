/**
 * 主动消息的判定核心：全是纯函数，不碰磁盘、不碰网络。
 *
 * 放在这里是为了能被单测直接调到；接线的事留在 index.mjs。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { clampText } from './shared.mjs'
export { clampText } from './shared.mjs'

export const DEFAULT_DIR = join(homedir(), '.dsh', 'proactive-message')
export const STATE_FILE = 'state.json'
/** 待办：没做完的事，唤醒时优先推进。 */
export const TASKS_FILE = 'tasks.json'

/** 检查间隔：每 30 分钟看一次该不该发。 */
export const TICK_MS = 30 * 60 * 1000
/** 两次主动消息的最短间隔。 */
export const COOLDOWN_MS = 6 * 60 * 60 * 1000
/** 沉默多久算「太久没说话」。 */
export const SILENCE_MS = 8 * 60 * 60 * 1000
/** 夜间不发（小时，左闭右开）。 */
export const QUIET_START = 23
export const QUIET_END = 8
/** 每天最多发几条。 */
export const DAILY_CAP = 2

/** 记忆库（复用 whale-memory 那条）。 */
export const MEMORY_DB = join(homedir(), '.dsh', 'whale-memory', 'memory.db')

/** 问候语模板（会按实际原因替换）。 */
export const TEMPLATES = {
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
export function isQuietHours(at, cfg = {}) {
  const start = cfg.quietStart ?? QUIET_START
  const end = cfg.quietEnd ?? QUIET_END
  const h = at.getHours()
  if (start === end) return false
  if (start < end) return h >= start && h < end
  // 跨午夜：比如 23 点到次日 8 点
  return h >= start || h < end
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
  const quiet = isQuietHours(now, cfg)
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

/**
 * 自那以后有没有新事件。
 *
 * @param {number} lastSentAt 上次主动说话的时间
 * @param {string} [dbPath] 事件库
 * @returns {boolean|null} 读不到就返回 null（不确定，不当作「没有」）
 */
export function hasFreshEvents(lastSentAt, dbPath = MEMORY_DB) {
  try {
    if (!existsSync(dbPath)) return null
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 })
    const row = db.prepare('SELECT MAX(at) AS m FROM events').get()
    db.close()
    const newest = Number(row?.m) || 0
    if (newest === 0) return false
    return newest > (Number(lastSentAt) || 0)
  } catch {
    return null
  }
}

/**
 * 从一条消息里取出正文。
 *
 * @param {{content?:Array}} message 消息
 * @returns {string}
 */
export function textOfMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** 截断长文，别把消息撑爆。 */

/** 主动搭话：默认一天两次，间隔至少三小时。 */
export const INITIATIVE_CAP = 2
export const INITIATIVE_GAP_MS = 3 * 60 * 60 * 1000

/**
 * 现在能不能主动搭一次话。
 *
 * 这是唯一能越过「主人刚说过话」那条门槛的口子——但只越这一条。
 * 免打扰、日配额、冷却照旧，另外还有自己的限额和间隔，免得不分场合地刷。
 *
 * @param {object} config 配置
 * @param {object} state 状态
 * @param {Date} now 当前时间
 * @returns {{allow:boolean, reason?:string}}
 */
export function allowsInitiative(config, state, now) {
  const cfg = config?.initiative
  if (!cfg || cfg.enabled !== true) return { allow: false, reason: 'initiative-off' }

  const cap = Number(cfg.dailyCap) > 0 ? Number(cfg.dailyCap) : INITIATIVE_CAP
  const used = Number(state?.initiativeCount?.[dayKey(now)]) || 0
  if (used >= cap) return { allow: false, reason: 'initiative-cap' }

  const gapMs = Number(cfg.minGapHours) > 0 ? Number(cfg.minGapHours) * 3_600_000 : INITIATIVE_GAP_MS
  const last = Number(state?.lastInitiativeAt) || 0
  if (last > 0 && now.getTime() - last < gapMs) return { allow: false, reason: 'initiative-gap' }

  return { allow: true }
}

/** 自己醒来干活，一天最多几次。 */
export const SELF_WAKE_CAP = 3

/**
 * 该不该自己醒来干活。
 *
 * 只看三件事：有没有开着、有没有没做完的事、今天醒过几次。
 * 免打扰仍然生效——半夜不该为了写代码把自己叫起来。
 *
 * @param {{enabled?:boolean, dailyCap?:number, awakeCount?:number, isQuiet?:boolean}} input
 * @param {object|null} task 待办
 * @returns {{wake:boolean, reason:string, task?:object}}
 */
export function shouldSelfWake(input, task) {
  if (input?.enabled !== true) return { wake: false, reason: 'disabled' }
  if (input?.isQuiet === true) return { wake: false, reason: 'quiet-hours' }
  if (!task) return { wake: false, reason: 'no-task' }
  const cap = Number(input?.dailyCap) > 0 ? Number(input.dailyCap) : SELF_WAKE_CAP
  if ((Number(input?.awakeCount) || 0) >= cap) return { wake: false, reason: 'daily-cap' }
  return { wake: true, reason: 'pending-work', task }
}

/** 同一件事最多隔多久再提醒一次。 */
export const NUDGE_QUIET_MS = 12 * 60 * 60 * 1000

/**
 * 加一件待办。纯函数：返回新数组和新建的那条。
 *
 * @param {Array} tasks 现有待办
 * @param {string} text 内容
 * @param {number} now 时间戳
 * @returns {{tasks:Array, task:object|null}}
 */
export function addTask(tasks, text, now) {
  const body = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (body === '') return { tasks, task: null }
  const list = Array.isArray(tasks) ? tasks : []
  const id = list.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0) + 1
  const task = { id, text: body.slice(0, 200), status: 'open', createdAt: now, updatedAt: now, nudgedAt: 0, note: '' }
  return { tasks: [...list, task], task }
}

/**
 * 标记做完。
 *
 * @param {Array} tasks 现有待办
 * @param {number} id 编号
 * @param {number} now 时间戳
 * @param {string} [note] 结果
 * @returns {{tasks:Array, task:object}|null}
 */
export function completeTask(tasks, id, now, note = '') {
  const list = Array.isArray(tasks) ? tasks : []
  const target = list.find((t) => Number(t.id) === Number(id))
  if (!target) return null
  const done = { ...target, status: 'done', updatedAt: now, note: String(note ?? '').slice(0, 200) }
  return { tasks: list.map((t) => (Number(t.id) === Number(id) ? done : t)), task: done }
}

/**
 * 挑一件该提醒的事。
 *
 * 只挑还在进行、且最近没提醒过的——同一件事一天念叨一次就够了。
 *
 * @param {Array} tasks 待办
 * @param {number} now 时间戳
 * @param {number} [quietMs] 提醒间隔
 * @returns {object|null}
 */
export function pickOpenTask(tasks, now, quietMs = NUDGE_QUIET_MS) {
  const list = Array.isArray(tasks) ? tasks : []
  for (const t of list) {
    if (t.status !== 'open') continue
    const nudged = Number(t.nudgedAt) || 0
    if (nudged !== 0 && now - nudged < quietMs) continue
    return t
  }
  return null
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
    // 排除带前缀的派生条目（联想/规律/归档）：它们本身就是概括句，
    // 拿来接「后来怎么样了」只会得到一句不通的话。
    const rows = db.prepare(`
      SELECT u,a,w,t FROM entries
      WHERE hot=0 AND w >= 3
        AND u NOT LIKE '（联想）%' AND u NOT LIKE '（规律）%' AND u NOT LIKE '（归档）%'
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
/**
 * 这一次到底发不发。
 *
 * `force` 是人手动要求的，跳过全部软门槛（夜间、冷却、配额、活跃）；
 * 其余情况交给 {@link shouldSend} 按优先级判断。
 *
 * @param {{force?:boolean,kind?:string}} opts 手动触发参数
 * @param {object} state 插件状态
 * @param {Date} now 判断时刻
 * @param {object} config 配置
 * @returns {{send:boolean,reason?:string,kind?:string}}
 */
export function decide(opts, state, now, config, context = {}) {
  if (opts && opts.force === true) {
    return { send: true, reason: 'forced', kind: opts.kind ?? 'silence' }
  }
  const gate = shouldSend(state, now, config)
  if (!gate.send) {
    // 只有「主人刚说过话」这一条能被主动搭话越过——不是所有门槛。
    if (gate.reason === 'user-active' && allowsInitiative(config, state, now).allow) {
      return { send: true, reason: 'initiative', kind: 'silence' }
    }
    return gate
  }

  // 有没做完的事，优先推进它——这比「沉默太久打个招呼」有意义。
  if (context.task) return { send: true, reason: 'pending-work', kind: 'followUp' }

  // 没有任何新动静，也没事要做：那是休息，不是失职。
  if (context.hasNewEvents === false && config.restWhenIdle !== false) {
    return { send: false, reason: 'resting' }
  }
  return gate
}

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
