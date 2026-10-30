/**
 * dsh-proactive-message —— 什么时候开口
 *
 * 这一层只做接线：状态文件、定时器、待办、工具、端点。
 * 判定逻辑全在 core.mjs，那边是纯函数，好测。
 *
 * @module dsh-proactive-message
 */


import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'

import {
  DEFAULT_DIR, STATE_FILE, TASKS_FILE, TICK_MS, COOLDOWN_MS, SILENCE_MS,
  QUIET_START, QUIET_END, DAILY_CAP, MEMORY_DB,
  INITIATIVE_CAP, INITIATIVE_GAP_MS, SELF_WAKE_CAP, NUDGE_QUIET_MS,
  isQuietHours, shouldSend, hasFreshEvents, textOfMessage, clampText,
  allowsInitiative, shouldSelfWake, addTask, completeTask, pickOpenTask,
  dayKey, pickFollowUp, decide, composeMessage,
} from './core.mjs'
export {
  isQuietHours, shouldSend, hasFreshEvents, textOfMessage, allowsInitiative,
  shouldSelfWake, addTask, completeTask, pickOpenTask, dayKey, pickFollowUp,
  decide, composeMessage,
} from './core.mjs'

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

  /** 主动搭话的配置（活引用要现读，所以单独归一化一份）。 */
  const initiativeCfg = () => {
    const raw = config.initiative && typeof config.initiative === 'object' ? config.initiative : {}
    return {
      enabled: cfgVal(raw.enabled, false) === true,
      dailyCap: cfgVal(raw.dailyCap, INITIATIVE_CAP),
      minGapHours: cfgVal(raw.minGapHours, INITIATIVE_GAP_MS / 3_600_000),
    }
  }

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

  /** @type {{lastSentAt:number, lastUserMessageAt:number, dailyCount:Record<string,number>, sentLog:Array, awakeCount:Record<string,number>}} */
  let state = { lastSentAt: 0, lastUserMessageAt: 0, dailyCount: {}, sentLog: [], awakeCount: {}, initiativeCount: {}, lastInitiativeAt: 0 }

  const load = () => {
    try {
      if (existsSync(statePath)) {
        const raw = JSON.parse(readFileSync(statePath, 'utf8'))
        state = {
          lastSentAt: raw.lastSentAt ?? 0,
          lastUserMessageAt: raw.lastUserMessageAt ?? 0,
          dailyCount: raw.dailyCount ?? {},
          awakeCount: raw.awakeCount ?? {},
          initiativeCount: raw.initiativeCount ?? {},
          lastInitiativeAt: raw.lastInitiativeAt ?? 0,
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

  /** 自己唤醒的那一轮，说完要把话转投到目标——它没有入站消息可回。 */
  let relay = null
  /** 转投的有效期：过了就别再等，免得深夜把陈年消息补发出去。 */
  const RELAY_TTL_MS = 10 * 60 * 1000

  /** 能自主醒来干活的前提：拿得到 agents，并且主人明确开了这个开关。 */
  let agentsRef = null
  ctx.inject(['agents'], (c) => { agentsRef = c.agents })

  const selfWakeCfg = () => (config.selfWake && typeof config.selfWake === 'object' ? config.selfWake : {})
  const selfWakeEnabled = () => {
    const v = selfWakeCfg().enabled
    return (typeof v?.get === 'function' ? v.get() : v) === true
  }

  /**
   * 自己醒一次，把待办推进一步。
   *
   * 走 agent.followup：等于我自己给自己排了一轮，不是等人类开口。
   * 默认关着——它会真的消耗模型调用，得人明确打开。
   */
  const trySelfWake = () => {
    const now = new Date()
    const today = dayKey(now)
    const task = pickOpenTask(tasks, now.getTime())
    const verdict = shouldSelfWake({
      enabled: selfWakeEnabled(),
      dailyCap: selfWakeCfg().dailyCap,
      awakeCount: state.awakeCount[today] ?? 0,
      isQuiet: isQuietHours(now, limits()),
    }, task)
    if (!verdict.wake) return verdict

    const agents = agentsRef && typeof agentsRef.list === 'function' ? agentsRef.list() : []
    const agent = (agents ?? [])[0]
    if (!agent || typeof agent.followup !== 'function') return { wake: false, reason: 'no-agent' }

    try {
      agent.followup({
        id: crypto.randomUUID(),
        role: 'user',
        content: [{
          type: 'text',
          text: `（自己醒来）还有件事没做完：${verdict.task.text}\n看看能不能推进一点；推不动就说清楚卡在哪，或者把它关掉。`,
        }],
        source: { kind: 'proactive-wake', form: 'notice', summary: '自己醒来推进待办' },
      })
    } catch (error) {
      return { wake: false, reason: 'followup-failed', detail: String(error?.message ?? error) }
    }

    state.awakeCount[today] = (state.awakeCount[today] ?? 0) + 1
    save()
    // 自己排的那一轮没有入站消息可回，正常投递链路不会把它发出去，
    // 所以这里记下会话，等它说完再手动转投一次。
    relay = { sessionId: String(agent.session?.id ?? ''), at: Date.now() }
    return { wake: true, reason: 'pending-work', task: verdict.task }
  }

  // 自己唤醒那一轮说完的话，转投到目标会话。
  ctx.on('session/event', (session, event) => {
    if (relay === null) return
    if (Date.now() - relay.at > RELAY_TTL_MS) { relay = null; return }
    if (String(session?.id ?? '') !== relay.sessionId) return
    if (event?.type !== 'assistant/message') return

    const text = textOfMessage(event.data?.message ?? event.data)
    if (text === '') return

    const pending = relay
    relay = null
    if (!dshIm || typeof dshIm.send !== 'function' || botId === '' || targetId === '') return
    dshIm.send(botId, targetId, text, { format: 'plain' }).then((result) => {
      if (result?.sent !== true) return
      // 转投成功也算说过话，记进日志（不占主动消息的配额）。
      state.sentLog.push({ at: Date.now(), kind: 'self-wake', text, forced: true })
      if (state.sentLog.length > 50) state.sentLog = state.sentLog.slice(-50)
      state.lastSelfWakeRelayAt = Date.now()
      save()
    }).catch(() => undefined)
  })

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
    const decision = decide(opts, state, now, { ...limits(), initiative: initiativeCfg() }, {
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
        if (decision.reason === 'initiative') {
          state.initiativeCount[today] = (state.initiativeCount[today] ?? 0) + 1
          state.lastInitiativeAt = now.getTime()
        }
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
    // 先想着干活，再考虑要不要开口。
    try { trySelfWake() } catch { /* 醒不来就算了 */ }
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
            selfWake: {
              enabled: selfWakeEnabled(),
              today: state.awakeCount[dayKey(now)] ?? 0,
            },
            initiative: {
              enabled: initiativeCfg().enabled,
              today: state.initiativeCount[dayKey(now)] ?? 0,
              verdict: allowsInitiative({ initiative: initiativeCfg() }, state, now),
            },
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

  /** 主动搭话：允许在主人刚说完话之后也开口，但有自己更紧的限额。 */
  initiative: z.object({
    enabled: z.boolean().default(false).volatile(),
    /** 一天最多主动搭几次话。 */
    dailyCap: z.natural().min(1).max(10).default(INITIATIVE_CAP).volatile(),
    /** 两次之间至少隔几小时。 */
    minGapHours: z.number().min(0).max(24).default(INITIATIVE_GAP_MS / 3_600_000).volatile(),
  }).default({}),

  /** 自己醒来干活：会真的消耗模型调用，默认关。 */
  selfWake: z.object({
    enabled: z.boolean().default(false).volatile(),
    /** 一天最多自己醒几次。 */
    dailyCap: z.natural().min(1).max(24).default(3).volatile(),
  }).default({}),
})
