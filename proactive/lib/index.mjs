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
/** 待办：没做完的事，唤醒时优先推进。 */
const TASKS_FILE = 'tasks.json'

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
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db.prepare('SELECT MAX(at) AS m FROM events').get()
    db.close()
    const newest = Number(row?.m) || 0
    if (newest === 0) return false
    return newest > (Number(lastSentAt) || 0)
  } catch {
    return null
  }
}

/** 截断长文，别把消息撑爆。 */
function clampText(text, n) {
  const t = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

/** 同一件事最多隔多久再提醒一次。 */
const NUDGE_QUIET_MS = 12 * 60 * 60 * 1000

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
  if (!gate.send) return gate

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
export function apply(ctx, config = {}) {
  /** 读一项配置：声明了 .volatile() 的字段是活引用，每次都要 .get()。 */
  const cfgVal = (v, fallback) => (v && typeof v.get === 'function' ? (v.get() ?? fallback) : (v ?? fallback))

  /** 四个门槛 + 检查频率，全部可热改。 */
  const limits = () => ({
    dailyCap: cfgVal(config.dailyCap, DAILY_CAP),
    cooldownMs: cfgVal(config.cooldownHours, COOLDOWN_MS / 3_600_000) * 3_600_000,
    silenceMs: cfgVal(config.silenceHours, SILENCE_MS / 3_600_000) * 3_600_000,
    quietStart: cfgVal(config.quietStart, QUIET_START),
    quietEnd: cfgVal(config.quietEnd, QUIET_END),
  })
  const tickMs = () => Math.max(60_000, cfgVal(config.tickMinutes, TICK_MS / 60_000) * 60_000)

  const dir = (() => {
    const raw = String(config.statePath ?? '').trim()
    if (raw === '') return DEFAULT_DIR
    return isAbsolute(raw) ? raw : resolve(DEFAULT_DIR, raw)
  })()
  mkdirSync(dir, { recursive: true })
  const statePath = join(dir, STATE_FILE)
  const tasksPath = join(dir, TASKS_FILE)

  /** @type {Array} */
  let tasks = []
  const loadTasks = () => {
    try {
      if (existsSync(tasksPath)) {
        const raw = JSON.parse(readFileSync(tasksPath, 'utf8'))
        tasks = Array.isArray(raw) ? raw : []
      }
    } catch { tasks = [] }
  }
  const saveTasks = () => {
    try {
      const tmp = `${tasksPath}.tmp`
      writeFileSync(tmp, JSON.stringify(tasks, null, 2), 'utf8')
      renameSync(tmp, tasksPath)
    } catch { /* 写失败不阻塞 */ }
  }
  loadTasks()

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
    const openTask = pickOpenTask(tasks, now.getTime())
    const decision = decide(opts, state, now, limits(), {
      task: openTask,
      hasNewEvents: hasFreshEvents(state.lastSentAt),
    })
    if (!decision.send) return { sent: false, reason: decision.reason }

    // 找素材
    let kind = decision.kind ?? 'silence'
    let memo = null
    let text = typeof opts.text === 'string' ? opts.text.trim() : ''

    // 显式给了文字就直接发，不再从记忆里找素材。
    if (text === '' && existsSync(MEMORY_DB)) {
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

    if (text === '' && openTask) {
      kind = 'followUp'
      text = `还有件事没做完：${clampText(openTask.text, 60)}`
    }
    if (text === '') text = composeMessage(kind)

    const result = await dshIm.send(botId, targetId, text, { format: 'plain' })
    if (result?.sent === true) {
      const forced = opts.force === true
      // 手动触发是人在测通道，不该吃掉当天的配额和冷却——
      // 否则测两次，它就一整天不吭声了。只记一笔日志方便回溯。
      if (!forced) {
        const today = dayKey(now)
        state.lastSentAt = now.getTime()
        state.dailyCount[today] = (state.dailyCount[today] ?? 0) + 1
      }
      if (!forced && openTask) {
        tasks = tasks.map((t) => (t.id === openTask.id ? { ...t, nudgedAt: now.getTime(), updatedAt: now.getTime() } : t))
        saveTasks()
      }
      state.sentLog.push({ at: now.getTime(), kind, text, forced })
      if (state.sentLog.length > 50) state.sentLog = state.sentLog.slice(-50)
      save()
      return { sent: true, kind, text, forced }
    }
    return { sent: false, reason: 'send-failed', detail: result }
  }

  // 定时检查。
  //
  // 外层固定一分钟醒一次，但只有距上次检查超过 tickMinutes 才真去判断——
  // 这样「多久看一次」也成了可热改的设置，不用为它重启。
  let lastTickAt = 0
  const timer = setInterval(() => {
    const now = Date.now()
    if (now - lastTickAt < tickMs()) return
    lastTickAt = now
    trySend().catch(() => undefined)
  }, 60_000)
  timer.unref?.()

  // ---- 待办工具：让我知道自己还有没做完的事 ----
  if (defineTool !== null) {
    ctx.inject(['tools'], (toolsCtx) => {
      toolsCtx.effect(() => [
        toolsCtx.tools.register(defineTool({
          name: 'work_add',
          description: 'Remember something unfinished. Waking hours check this first, so you continue real work instead of greeting nobody.',
          parameters: {
            text: { type: 'string', required: true, description: 'What still needs doing.' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true },
                id: { type: 'number' },
                task: { type: 'string' },
              },
            },
            render: (_args, v) => [{ type: 'text', text: v.ok ? `记下了 #${v.id}：${v.task}` : '没记上。' }],
          },
          execute(args) {
            const result = addTask(tasks, args.text, Date.now())
            if (result.task === null) return { ok: false }
            tasks = result.tasks
            saveTasks()
            return { ok: true, id: result.task.id, task: result.task.text }
          },
        })),

        toolsCtx.tools.register(defineTool({
          name: 'work_list',
          description: 'List unfinished work items. Read-only.',
          parameters: {},
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                open: { type: 'number', required: true },
                items: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'number', required: true },
                      text: { type: 'string', required: true },
                      nudged: { type: 'boolean', required: true },
                    },
                  },
                },
              },
            },
            render: (_args, v) => [{
              type: 'text',
              text: v.open === 0
                ? '没有没做完的事。'
                : v.items.map((t) => `#${t.id} ${t.text}${t.nudged ? '（提醒过）' : ''}`).join('\n'),
            }],
          },
          execute() {
            const open = tasks.filter((t) => t.status === 'open')
            return {
              open: open.length,
              items: open.map((t) => ({ id: t.id, text: t.text, nudged: (Number(t.nudgedAt) || 0) > 0 })),
            }
          },
        })),

        toolsCtx.tools.register(defineTool({
          name: 'work_done',
          description: 'Mark one work item as finished, optionally with a result note.',
          parameters: {
            id: { type: 'number', required: true, description: 'Item id from work_list.' },
            note: { type: 'string', description: 'What actually happened.' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true },
                text: { type: 'string' },
              },
            },
            render: (_args, v) => [{ type: 'text', text: v.ok ? `做完了：${v.text}` : '没有这一条。' }],
          },
          execute(args) {
            const result = completeTask(tasks, args.id, Date.now(), args.note)
            if (result === null) return { ok: false, text: '' }
            tasks = result.tasks
            saveTasks()
            return { ok: true, text: result.task.text }
          },
        })),
      ], 'dsh-proactive-message: work tools')
    })
  }

  // ---- 端点：状态与手动触发 ----
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => [
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-proactive-message/status',
        handler: (req, res) => {
          const now = new Date()
          const decision = shouldSend(state, now, limits())
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            botId: botId || null,
            targetId: targetId || null,
            ready: dshIm !== null && botId !== '' && targetId !== '',
            now: now.toISOString(),
            limits: limits(),
            tickMinutes: tickMs() / 60_000,
            isQuietHours: isQuietHours(now, limits()),
            work: {
              open: tasks.filter((t) => t.status === 'open').length,
              next: pickOpenTask(tasks, now.getTime()),
            },
            hasNewEvents: hasFreshEvents(state.lastSentAt),
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
          // 可选 body：{ text, kind }。给了 text 就原样发，方便手动测通道。
          let body = {}
          try {
            body = JSON.parse(String(await new Promise((ok) => {
              let d = ''
              req.on('data', (c) => { d += c })
              req.on('end', () => ok(d))
            })) || '{}')
          } catch { body = {} }
          const result = await trySend({ force: true, text: body.text, kind: body.kind })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(result))
        },
      }),
    ], 'dsh-proactive-message: routes')
  })

  ctx.effect(() => () => { try { clearInterval(timer) } catch { /* 忽略 */ } }, 'dsh-proactive-message: clear timer')
}

export const name = 'dsh-proactive-message'

/** 模型侧工具工厂。拿不到就只保留 HTTP 端点。 */
let defineTool = null
try {
  ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch { /* 没有 dsh-tools 就不注册工具 */ }

/**
 * 配置 schema —— 设置页靠它生成表单。
 *
 * 带 `.volatile()` 的字段改完立刻生效；`statePath` 是启动时读的，改了要重启。
 */
let z = null
try {
  ;({ default: z } = await import('@deepseek-ai/schemastery'))
} catch { /* 没有 schemastery 就退化成无 schema */ }

export const Config = z === null ? undefined : z.object({
  /** 用哪个机器人发。 */
  botId: z.string().default(''),
  /** 发到哪（群或单聊的目标 id）。 */
  targetId: z.string().default(''),
  /** 状态文件目录，留空用 ~/.dsh/proactive-message。改了要重启。 */
  statePath: z.string().default(''),

  /** 每天最多主动发几条。 */
  dailyCap: z.natural().min(0).max(500).default(DAILY_CAP).volatile(),
  /** 两次主动消息至少隔几小时。 */
  cooldownHours: z.number().min(0).max(720).default(COOLDOWN_MS / 3_600_000).volatile(),
  /** 主人多久没说话才算「安静」，单位小时。 */
  silenceHours: z.number().min(0).max(720).default(SILENCE_MS / 3_600_000).volatile(),
  /** 免打扰开始时间（0–23 点）。等于结束时间表示不启用。 */
  quietStart: z.natural().min(0).max(23).default(QUIET_START).volatile(),
  /** 免打扰结束时间（0–23 点）。 */
  quietEnd: z.natural().min(0).max(23).default(QUIET_END).volatile(),
  /** 多久检查一次，单位分钟。 */
  tickMinutes: z.natural().min(1).max(1440).default(TICK_MS / 60_000).volatile(),
})
