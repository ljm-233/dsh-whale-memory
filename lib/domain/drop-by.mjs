/**
 * 定时叫醒 · 接线（原来是独立插件 dsh-drop-by）
 * ============================================================================
 * 2026-11-08：从 ~/.dsh/plugins/dsh-drop-by/index.js 并进 whale-memory。
 * 工具的**名字、参数、返回结构**和叫醒时的载荷一字未改，改的只有三件事：
 *
 *   ① 入口从 `apply(ctx, config)` 变成 `registerDropBy(ctx, { config, memoryDir })`，
 *      由 lib/index.mjs 装配时调用；
 *   ② `session/event` 监听不再自己 `ctx.on` —— registerDropBy 返回
 *      `handleSessionEvent(session, event)`，由 index.mjs 串进**现有那一个**监听里。
 *      原因：whale-memory 的测试桩（test-mood / test-speaker）把事件表做成单监听
 *      map，多挂一个会把前一个顶掉，今晚已经踩过一次。
 *   ③ 配置键加了 `wake` 前缀（wakeEnabled / wakeIntervalMinutes / …），
 *      状态文件跟着记忆库走（见 drop-by-state.mjs 的说明）。
 *
 * 它只负责：
 *   ① ctx.interval 定期看表（默认 20 分钟一次，不用裸 setInterval）；
 *   ② 从事件里认「别人发来的 user/message」，维护 otherAt / selfAt / sessionId；
 *   ③ 到条件了用 agents.get(SESSION_ID).followup(...) 叫醒会话自己 ——
 *      followup 只负责叫醒，台词由模型自己写，所以那一句是「旁白」不是台词；
 *   ④ 工具 drop_by_at({minutes, why})：模型自己排「过几分钟叫醒我」；
 *   ⑤ 状态原子写盘；⑥ 防抖：同一分钟不重复、一小时最多 6 次、超了停到下一个整点。
 * ============================================================================
 */
import { randomUUID } from 'node:crypto'

import {
  DEFAULTS, MINUTE_MS,
  normalizeConfig, decide, scheduleAppointment, afterFire, clearAppointment,
} from './drop-by-decide.mjs'
import { loadState, saveState, stateFileFor } from './drop-by-state.mjs'

const VERSION = '0.1.0'

/** 叫醒时垫在前面那句「旁白」。模型不该照抄，只该拿它当背景。 */
const FRAME_HEAD = '（这一轮不是别人发来的，是定时器把你叫醒了。'
const FRAME_TAIL = '没人等你回话，也没有待办在催。想说什么就用你自己的话开口；不想说就把这轮留空、直接结束，别为了「醒都醒了」硬凑一句。不要复述括号里的这段。）'

/**
 * 配置键改名表：`wake*` 前缀 ↔ decide.mjs 里那套不带前缀的字段名。
 * 值是原样的（可能是 schemastery 的活引用），normalizeConfig 自己会 `.get()`。
 */
const CONFIG_KEYS = {
  enabled: 'wakeEnabled',
  intervalMinutes: 'wakeIntervalMinutes',
  idleMinutes: 'wakeIdleMinutes',
  minGapMinutes: 'wakeMinGapMinutes',
  maxPerHour: 'wakeMaxPerHour',
  quietFrom: 'wakeQuietFrom',
  quietTo: 'wakeQuietTo',
  appointmentMinMinutes: 'wakeAppointmentMinMinutes',
  appointmentMaxMinutes: 'wakeAppointmentMaxMinutes',
}

/** 把这批 `wake*` 键摘出来，拼成 decide.mjs 认的那份配置。 */
export function pickWakeConfig(config = {}) {
  const out = {}
  for (const [plain, prefixed] of Object.entries(CONFIG_KEYS)) out[plain] = config[prefixed]
  return out
}

const localStamp = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 叫醒用的那句话：旁白 + 为什么现在醒。 */
export function buildFrame(decision) {
  const why = decision.kind === 'appointment'
    ? `你在 ${localStamp(decision.at ?? Date.now())} 给自己预约了这一刻${decision.why ? `，当时的理由：${decision.why}` : ''}。`
    : `已经安静了 ${decision.idleMinutes ?? '?'} 分钟。`
  return `${FRAME_HEAD}${why}${FRAME_TAIL}`
}

/**
 * 把定时叫醒挂到宿主上。
 *
 * @param {object} ctx 插件 ctx
 * @param {object} [options]
 * @param {object} [options.config] 插件配置（带 wake* 前缀的键）
 * @param {string} [options.memoryDir] 记忆库目录：状态文件落在 `<它>/wake/state.json`
 * @param {string} [options.stateFile] 直接指定状态文件（测试用，优先于 memoryDir）
 * @param {Function|null} [options.defineTool] 宿主自带的工具工厂。跟 lib/surface/tools.mjs 同一道闸：
 *   拿不到 @deepseek-ai/dsh-tools 就整块不注册（否则用裸 node 跑本仓库测试时，工具表会只冒出
 *   drop_by_at 而没有 memory_*，tests/test-routes.mjs 的 tools.size === 0 分支就错位了）。
 * @returns {{handleSessionEvent:(session:object,event:object)=>void, stateFile:string}}
 */
export function registerDropBy(ctx, { config = {}, memoryDir, stateFile, defineTool = null } = {}) {
  /** 配置里没有 wakeSessionId，只有老插件那种直接给 sessionId 的写法还认。 */
  const sessionFallback = config.sessionId
  const cfg = () => normalizeConfig(pickWakeConfig({ ...config }))
  const log = (msg) => {
    try { ctx.logger?.('drop-by')?.info?.(`[drop-by] ${msg}`) } catch { /* 记日志不该影响主流程 */ }
  }

  const file = typeof stateFile === 'string' && stateFile.trim() !== '' ? stateFile.trim() : stateFileFor(memoryDir)
  let state = loadState(file)
  const save = () => { saveState(state, file) }

  // ── 服务探测：apply 时可能都没就绪，所以一律走 inject ──────────────────────
  let agents = null
  ctx.inject(['agents'], (c) => { agents = c.agents })

  // ── 主循环：ctx.interval，不是裸 setInterval ──────────────────────────────
  const tick = () => {
    try { runTick() } catch (e) { log(`tick 出错：${String(e?.message ?? e)}`) }
  }

  // 2026-11-08：原来这里先 `typeof ctx.interval === 'function'` 再调它——但在 cordis 里
  // `ctx.interval` 是 timer 服务的属性访问器，**读一下就会抛**
  // `cannot get property "timer" without inject`，整个 apply 就在这一行崩掉，
  // 后面的 HTTP 端点一条都没注册（表现成设置页全 404）。
  // 正确姿势是走 inject 拿服务，别去探属性。
  ctx.inject(['timer'], (c) => {
    try {
      const every = Math.max(1, cfg().intervalMinutes) * MINUTE_MS
      const h = c.timer.setInterval(tick, every)
      log(`定时器已起：每 ${Math.max(1, cfg().intervalMinutes)} 分钟看一次表`)
      return () => { try { h?.() } catch { /* 已经停了 */ } }
    } catch (e) {
      log(`定时器起不来（${String(e?.message ?? e)}），定时叫醒停用；drop_by_at 仍可写状态`)
      return undefined
    }
  })

  function runTick() {
    const c = cfg()
    const now = Date.now()
    const decision = decide(state, now, c)

    if (decision.reason === 'superseded') {
      // 预约排好之后有人说话了：这轮已经续上，预约作废
      state = clearAppointment(state)
      save()
      log('预约作废：设完之后有人说话了')
      return
    }
    if (decision.reason === 'hourly-cap' && decision.pauseUntil !== state.pausedUntil) {
      state = { ...state, pausedUntil: decision.pauseUntil }
      save()
      log(`一小时内叫醒次数到顶（${c.maxPerHour}），停到 ${localStamp(decision.pauseUntil)}`)
      return
    }
    if (!decision.wake) return

    const targetId = String(state.sessionId || sessionFallback || '')
    const agent = targetId === '' ? undefined : agents?.get?.(targetId)
    if (!agent || typeof agent.followup !== 'function') {
      log(`没有可叫醒的会话（sessionId=${targetId || '空'}），这一轮跳过`)
      return
    }

    // 正在跑就别叠一层；预约留着，下个 tick 再试
    if (agent.status === 'running') {
      log('会话还在跑，等它空闲再说')
      return
    }

    const frame = buildFrame({ ...decision, at: state.nextAt })
    try {
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: frame }],
        source: {
          kind: 'drop-by',
          form: 'notice',
          summary: decision.kind === 'appointment' ? '自己预约的点到了' : '闲得够久了',
        },
      })
    } catch (e) {
      log(`followup 失败：${String(e?.message ?? e)}`)
      return
    }

    state = afterFire(state, now, decision.kind)
    state.visits = (Number(state.visits) || 0) + 1
    save()
    log(`叫醒了（${decision.kind === 'appointment' ? `预约：${decision.why || '没写理由'}` : `闲置 ${decision.idleMinutes} 分钟`}）`)
  }

  /**
   * 听事件：只有「别人发来的 user/message」才算互动。
   * 由 lib/index.mjs 那**唯一一个** session/event 监听转调，不自己 ctx.on。
   */
  function handleSessionEvent(session, event) {
    const type = event?.type
    if (typeof type !== 'string') return
    const sid = String(session?.id ?? '')
    const now = Date.now()

    if (type === 'user/message') {
      const data = event.data ?? {}
      const msg = data.message ?? data
      const source = data.source ?? msg?.source
      // 自己发的（drop-by / proactive-wake / steer）、工具结果都不算别人说话
      // 2026-11-08：只认真人。别的插件也会往会话里写 user/message，
      // 那些不是「有人来找我」，判成互动会误叫醒（dsh-world 就是例子）。
      if (source?.kind !== 'user') return
      const from = String(source?.from ?? data.from ?? '')
      if (/^dsh-world/.test(String(source?.plugin ?? '')) || /^dsh-world/.test(from)) return
      state = {
        ...state,
        otherAt: now,
        sessionId: sid === '' ? state.sessionId : sid,
      }
      // 有人开口 = 预约的目的已经达到，约到哪个点都不必再叫
      if (Number(state.nextAt) > 0) state = clearAppointment(state)
      save()
      return
    }

    if (type === 'assistant/message') {
      const data = event.data ?? {}
      const msg = data.message ?? data
      if (msg?.interrupted === true) return
      state = { ...state, selfAt: now }
      if (sid !== '' && state.sessionId === '') state = { ...state, sessionId: sid }
      save()
    }
  }

  // ── 工具：drop_by_at —— 「过几分钟之后叫醒我」 ────────────────────────────
  ctx.inject(['tools'], (toolsCtx) => {
    if (typeof toolsCtx?.tools?.register !== 'function') {
      log('拿不到 tools.register，drop_by_at 没注册（宿主的工具服务没起）')
      return
    }
    // 同上：defineTool 是可选的包装，不是注册前提。
    const mk = typeof defineTool === 'function' ? defineTool : ((spec) => spec)
    toolsCtx.tools.register(mk({
      name: 'drop_by_at',
      description:
        '自己预约「过几分钟之后叫醒我」。这是把「什么时候开口」交给你的那个工具：想到一句还没说完的话、'
        + '想隔一会儿再问、或者想在一段时间后自己回来看一眼，就用它排一个点。到点你会被当成一条用户消息叫醒'
        + '（旁白提示、不是你自己的台词），到时候想说什么由你现写，不想说就留空。'
        + 'minutes 是 5–240 分钟；why 一句话记进状态，方便你到点知道自己为什么醒。'
        + '同一时间只有一个预约，再排一次会覆盖上一个。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          minutes: {
            type: 'integer',
            description: `多少分钟之后叫醒你（${DEFAULTS.appointmentMinMinutes}–${DEFAULTS.appointmentMaxMinutes}）。`,
          },
          why: {
            type: 'string',
            description: '一句话：到那时想做什么 / 为什么排这个点。会写进状态文件，到点时回给你看。',
          },
        },
        required: ['minutes'],
      },
      timeoutMs: 15_000,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            at: { type: 'string', description: '到点时间（ISO）。' },
            atLocal: { type: 'string', description: '到点时间（本地，给人看的）。' },
            minutes: { type: 'integer' },
            why: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ok', 'at', 'atLocal', 'minutes', 'why', 'note'],
        },
        render: (_args, value) => [{
          type: 'text',
          text: `已排好：${value.atLocal}（${value.minutes} 分钟后）${value.why === '' ? '' : `，理由：${value.why}`}。到点我自己会醒。`,
        }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const c = cfg()
        const now = Date.now()
        if (exec?.agent?.session?.id && String(exec.agent.session.id) !== state.sessionId) {
          state = { ...state, sessionId: String(exec.agent.session.id) }
        }
        const next = scheduleAppointment(state, now, args?.minutes, args?.why, c)
        state = next.state
        save()
        log(`预约：${localStamp(next.at)}（${state.nextWhy || '没写理由'}）`)
        return {
          ok: true,
          at: new Date(next.at).toISOString(),
          atLocal: localStamp(next.at),
          minutes: Math.trunc(Number(args?.minutes)),
          why: state.nextWhy,
          note: '到点会有一条旁白把你叫醒，台词你自己写；在此之前谁说话就把预约作废。',
        }
      },
    }))
    log(`工具已注册：drop_by_at（状态 ${file}）`)
  })

  // ── 一行提示，让模型知道这个工具是给它用的（可关） ────────────────────────
  const promptHint = config.wakePromptHint && typeof config.wakePromptHint.get === 'function'
    ? config.wakePromptHint.get()
    : config.wakePromptHint
  if (promptHint !== false) {
    ctx.inject(['systemPrompt'], (c) => {
      if (typeof c?.systemPrompt?.section !== 'function') return
      c.systemPrompt.section({
        name: 'drop-by:hint',
        order: 900,
        text: '（你可以用 drop_by_at 给自己排「过一会儿再开口」的时间。想说话而没人接话时，排个点比干等更省事。）',
      })
    })
  }

  log(`加载 v${VERSION}：间隔 ${cfg().intervalMinutes} 分钟，闲置线 ${cfg().idleMinutes} 分钟，状态 ${file}`)
  return { handleSessionEvent, stateFile: file }
}
