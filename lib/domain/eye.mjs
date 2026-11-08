/**
 * 眼睛 · look / see 两个工具
 * ============================================================================
 * 2026-11-08：从独立插件 dsh-eye（~/.dsh/plugins/dsh-eye/index.js）并进来。
 * 工具的**名字、参数、返回结构、错误码全部一字未改**，改的只有三件事：
 *
 *   ① 入口从 `apply(ctx, config)` 变成 `registerEye(ctx, { config, shotsDir })`，
 *      由 lib/index.mjs 装配时调用（不再是自己一个插件）；
 *   ② 配置键加了 `eye` 前缀（eyeDevice / eyeSize / …），免得跟 whale-memory
 *      现有的 mood* / card* 撞车；读的时候会剥开 schemastery 的活引用（.get()）；
 *   ③ 抓帧逻辑搬去 lib/domain/eye-capture.mjs（原 lib/capture.js，逻辑未改）。
 *
 * 硬约束（照抄原注释）：
 *   · 服务一律 ctx.inject(['x'], cb)，不用 ctx.get()；
 *   · 抓不到不抛异常，返回 { ok:false, error, detail }，会话照常继续；
 *   · 单实例：并发抓帧由 eye-capture 的文件锁排队。
 * ============================================================================
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { capture, DEFAULTS } from './eye-capture.mjs'

const VERSION = '0.1.0'

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
}

const SHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    path: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    bytes: { type: 'integer' },
    at: { type: 'string' },
    note: { type: 'string' },
    image: IMAGE_VALUE_SCHEMA,
    error: { type: 'string' },
    detail: { type: 'string' },
  },
}

/** 剥开 schemastery 的活引用；配置每次现读（设置页改完不用重启）。 */
const raw = (value) => (value && typeof value.get === 'function' ? value.get() : value)

export function normalizeConfig(config = {}) {
  const pickString = (value, fallback) => (typeof raw(value) === 'string' && String(raw(value)).trim() !== '' ? String(raw(value)).trim() : fallback)
  const pickNumber = (value, fallback) => (Number.isFinite(Number(raw(value))) ? Number(raw(value)) : fallback)
  return {
    device: pickString(config.eyeDevice, DEFAULTS.device),
    size: pickString(config.eyeSize, DEFAULTS.size),
    warmupMs: pickNumber(config.eyeWarmupMs, DEFAULTS.warmupMs),
    lockWaitMs: pickNumber(config.eyeLockWaitMs, DEFAULTS.lockWaitMs),
    timeoutMs: pickNumber(config.eyeTimeoutMs, 12_000),
    keep: pickNumber(config.eyeKeep, DEFAULTS.keep),
    see: raw(config.eyeSee) !== false,
    seeMaxTokens: pickNumber(config.eyeSeeMaxTokens, 300),
    promptHint: raw(config.eyePromptHint) !== false,
  }
}

/** 会话当前路由：最新解析出来的 route 元数据，退回到请求头里的 config，再退到 agent 默认。 */
function resolveRoute(exec) {
  let context
  let header
  try { context = exec?.agent?.session?.requestContext?.() } catch { context = undefined }
  try { header = exec?.agent?.session?.requestHeader?.() } catch { header = undefined }
  const provider = context?.provider ?? header?.config?.provider ?? exec?.agent?.options?.provider
  const model = context?.model ?? header?.config?.model ?? exec?.agent?.options?.model
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return null
  return { provider, model }
}

const ERROR_TEXT = {
  busy: '摄像头正忙着（别人占着，或者另一个抓帧还没放锁）',
  'no-device': '没找到摄像头设备（合盖 / 外接屏切换 / 设备号变了）',
  timeout: '抓帧超时了，设备像是卡住',
  ffmpeg: 'ffmpeg 抓帧失败',
}

/**
 * 把 look / see 挂到宿主上。
 *
 * @param {object} ctx 插件 ctx
 * @param {object} [options]
 * @param {object} [options.config] 插件配置（带 eye* 前缀的键）
 * @param {string} [options.shotsDir] 覆盖存图目录（测试用；不传就用 ~/.dsh/integrations/dsh-eye/shots）
 * @param {Function|null} [options.defineTool] 宿主自带的工具工厂。跟 lib/surface/tools.mjs 同一道闸：
 *   拿不到 @deepseek-ai/dsh-tools 就整块不注册（否则用裸 node 跑本仓库测试时，工具表会只冒出
 *   look/see 而没有 memory_*，tests/test-routes.mjs 的 tools.size === 0 分支就错位了）。
 */
export function registerEye(ctx, { config = {}, shotsDir, defineTool = null } = {}) {
  const cfg = () => normalizeConfig(config)
  const log = (msg) => {
    // 2026-11-08：原来只走 ctx.logger，可它是 cordis 的服务访问器——不是函数时
    // `ctx.logger?.(...)` 整句静默短路，于是「为什么没注册」永远打不出来。
    // 这里加一条 console.error 兜底：至少启动时能在终端看见。[eye] 前缀方便你 grep。
    try { console.error(`[eye] ${msg}`) } catch { /* 连 stderr 都没有就算了 */ }
    try { ctx.logger?.('eye')?.info?.(`[eye] ${msg}`) } catch { /* 记日志不该影响主流程 */ }
  }

  // ── 服务探测：apply 时可能都没就绪，所以一律走 inject ──────────────────────
  let attachments = null
  let llm = null
  ctx.inject(['attachments'], (c) => { attachments = c.attachments })
  ctx.inject(['llm'], (c) => { llm = c.llm })

  /** 当前路由吃不吃图。不确定就当不吃 —— 硬塞会给整条请求埋雷。 */
  async function routeTakesImages(route, signal) {
    if (llm === null || route === null) return false
    try {
      const info = await llm.resolveModelInfo(route.provider, route.model, signal)
      return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
    } catch {
      return false
    }
  }

  /** 把抓到的 JPEG 存成宿主附件，失败就返回 null（降级成只给路径）。 */
  async function saveShot(path) {
    if (attachments === null || typeof attachments.saveImage !== 'function') return null
    try {
      const data = await readFile(path)
      const ref = await attachments.saveImage({
        data: new Uint8Array(data),
        mediaType: 'image/jpeg',
        name: basename(path),
      })
      return {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...typeof ref.name === 'string' && ref.name !== '' ? { name: ref.name } : {},
      }
    } catch (error) {
      log(`存附件失败，退回只给路径：${String(error?.message ?? error)}`)
      return null
    }
  }

  async function shoot(args) {
    const c = cfg()
    return capture({
      device: typeof args?.device === 'string' ? args.device : c.device,
      size: typeof args?.size === 'string' ? args.size : c.size,
      warmupMs: args?.warmupMs === undefined ? c.warmupMs : args.warmupMs,
      lockWaitMs: c.lockWaitMs,
      timeoutMs: c.timeoutMs,
      keep: c.keep,
      ...shotsDir === undefined ? {} : { shotsDir },
    })
  }

  ctx.inject(['tools'], (toolsCtx) => {
    log(`tools 回调进来了；defineTool=${typeof defineTool}；register=${typeof toolsCtx?.tools?.register}`)
    if (typeof toolsCtx?.tools?.register !== 'function') {
      log('拿不到 tools.register，look/see 没注册（宿主的工具服务没起）')
      return
    }
    // 2026-11-08：defineTool 只是宿主给的一层包装（补默认字段），不是注册的前提。
    // 拿不到就退回恒等函数——裸对象同样能 tools.register，别再让整对工具消失。
    const mk = typeof defineTool === 'function' ? defineTool : ((spec) => spec)
    if (typeof defineTool !== 'function') log('拿不到 @deepseek-ai/dsh-tools，look/see 用裸对象注册')

    // ── look ────────────────────────────────────────────────────────────────
    toolsCtx.tools.register(mk({
      name: 'look',
      description:
        '抓摄像头当前这一帧，返回文件路径，并把这张图直接放进工具结果里让你看见。'
        + '想问「现在面前是什么样」「我穿的是哪件」这类事就用它，不用自己去敲 ffmpeg。'
        + '默认抓 /dev/video0 的 640x480，并且先丢几帧再取（摄像头刚打开的头几帧常常全黑）。'
        + '抓不到会返回 { ok:false, error, detail }，不会中断会话；error 是 busy / no-device / timeout / ffmpeg 之一。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { type: 'string', description: 'v4l2 设备路径，默认 /dev/video0。' },
          size: { type: 'string', description: '分辨率 WxH，默认 640x480。' },
          warmupMs: { type: 'integer', description: `开机等多久再取帧（毫秒，默认 ${DEFAULTS.warmupMs}）；摄像头约 30fps，120ms ≈ 丢 4 帧。` },
        },
      },
      timeoutMs: 40_000,
      output: {
        schema: SHOT_SCHEMA,
        render: (args, value) => {
          if (value.ok !== true) {
            return [{ type: 'text', text: `没看到：${ERROR_TEXT[value.error] ?? value.error}。${value.detail === '' ? '' : `\n${value.detail}`}` }]
          }
          const head = `看到了：${value.path}（${value.width}×${value.height}，${value.bytes} 字节，${value.at}）`
          const blocks = [{ type: 'text', text: value.image === undefined ? `${head}\n当前模型不吃图，用 read_image 打开这个路径看。` : head }]
          if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image })
          return blocks
        },
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const shot = await shoot(args)
        if (shot.ok !== true) return { ok: false, error: shot.error, detail: shot.detail }

        const route = resolveRoute(exec)
        const takesImages = await routeTakesImages(route, exec?.signal)
        const image = takesImages ? await saveShot(shot.path) : null
        log(`抓了一帧：${shot.path}（${shot.width}×${shot.height}）${image === null ? '，只给路径' : '，已附图'}`)
        return {
          ok: true,
          path: shot.path,
          width: shot.width,
          height: shot.height,
          bytes: shot.bytes,
          at: shot.at,
          note: shot.note,
          ...image === null ? {} : { image },
        }
      },
    }))

    // ── see ─────────────────────────────────────────────────────────────────
    if (cfg().see) {
      toolsCtx.tools.register(mk({
        name: 'see',
        description:
          '抓一帧，然后让当前模型自己看着这张图回答 question（不给问题就描述看到了什么），直接返回答案文字。'
          + '好处是不用两轮：一次调用就拿到「看到 + 说出」的结果。'
          + '要求当前模型声明支持图片输入；不支持时返回 { ok:false, error:"no-vision" }，不会假装看见了。'
          + '抓不到摄像头时同样返回结构化错误。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            question: { type: 'string', description: '想问这张图什么。省略就让它描述看到的东西。' },
            device: { type: 'string', description: 'v4l2 设备路径，默认 /dev/video0。' },
            size: { type: 'string', description: '分辨率 WxH，默认 640x480。' },
            warmupMs: { type: 'integer', description: '开机等多久再取帧（毫秒）。' },
          },
        },
        timeoutMs: 60_000,
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              path: { type: 'string' },
              answer: { type: 'string' },
              model: { type: 'string' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              ms: { type: 'integer' },
              error: { type: 'string' },
              detail: { type: 'string' },
            },
          },
          render: (args, value) => {
            if (value.ok !== true) {
              const known = ERROR_TEXT[value.error] ?? (value.error === 'no-vision' ? '当前模型不吃图，see 用不了' : value.error)
              return [{ type: 'text', text: `没看到：${known}。${value.detail === '' ? '' : `\n${value.detail}`}` }]
            }
            return [{ type: 'text', text: value.answer }]
          },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          const signal = exec?.signal
          const route = resolveRoute(exec)
          if (route === null) {
            return { ok: false, error: 'no-route', detail: '拿不到当前会话的 provider/model，see 没法自己调模型' }
          }
          if (llm === null || typeof llm.stream !== 'function') {
            return { ok: false, error: 'no-llm', detail: '宿主没有挂 llm 服务' }
          }
          if (!(await routeTakesImages(route, signal))) {
            return { ok: false, error: 'no-vision', detail: `模型 ${route.model} 没声明图片输入；用 look 拿路径，再看这张图` }
          }

          const startedAt = Date.now()
          const shot = await shoot(args)
          if (shot.ok !== true) return { ok: false, error: shot.error, detail: shot.detail }

          const image = await saveShot(shot.path)
          if (image === null) {
            return { ok: false, error: 'no-attachment', detail: `图抓到了（${shot.path}），但存不成附件，see 递不进模型` }
          }

          const question = typeof args?.question === 'string' && args.question.trim() !== ''
            ? args.question.trim()
            : '这是我眼前摄像头刚拍到的一帧。说说你看到了什么。'
          const c = cfg()
          // 先让运行时把这次调用「定下来」（落 maxTokens 等默认值并校验），
          // 定不下来（老版本没有 prepareCall）就退回手写 options。
          let prepared = null
          if (typeof llm.prepareCall === 'function') {
            try {
              prepared = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: c.seeMaxTokens }, signal)
            } catch (error) {
              return { ok: false, error: 'llm', detail: `这次调用没被接受：${String(error?.message ?? error)}（图在 ${shot.path}）` }
            }
          }
          const base = prepared?.config ?? { provider: route.provider, model: route.model, maxTokens: c.seeMaxTokens }
          const messages = [{
            role: 'user',
            content: [
              { type: 'text', text: question },
              { type: 'image', attachment: image },
            ],
          }]
          const options = {
            ...base,
            messages,
            ...exec?.agent?.session?.id === undefined ? {} : { sessionId: exec.agent.session.id },
            ...signal === undefined ? {} : { signal },
          }
          let answer = ''
          let finishKind = 'stop'
          try {
            const stream = typeof prepared?.stream === 'function' ? prepared.stream(options) : llm.stream(options)
            for await (const chunk of stream) {
              if (chunk?.type === 'text-delta') answer += chunk.text
              if (chunk?.type === 'finish') finishKind = chunk.reason?.kind ?? 'stop'
            }
          } catch (error) {
            return { ok: false, error: 'llm', detail: `${String(error?.message ?? error)}（图在 ${shot.path}）` }
          }

          if (finishKind === 'error' || finishKind === 'aborted') {
            return { ok: false, error: finishKind, detail: `模型调用中断了（图在 ${shot.path}）` }
          }
          if (answer.trim() === '') {
            return { ok: false, error: 'empty', detail: `模型没说话（图在 ${shot.path}）` }
          }
          log(`see 回答完成：${route.model}，${shot.path}`)
          return {
            ok: true,
            path: shot.path,
            answer: answer.trim(),
            model: route.model,
            width: shot.width,
            height: shot.height,
            ms: Date.now() - startedAt,
          }
        },
      }))
    }

    log(`工具已注册：look${cfg().see ? ' / see' : ''}（设备 ${cfg().device}，尺寸 ${cfg().size}）`)
  })

  // ── 一行提示，让模型知道有眼睛可用（可关） ──────────────────────────────
  if (cfg().promptHint) {
    ctx.inject(['systemPrompt'], (c) => {
      if (typeof c?.systemPrompt?.section !== 'function') return
      c.systemPrompt.section({
        name: 'eye:hint',
        order: 910,
        text: '（你可以用 look 抓摄像头这一帧看见眼前的东西，用 see 连「抓 + 说出」一次做完。不用自己敲 ffmpeg。）',
      })
    })
  }

  log(`加载 v${VERSION}：设备 ${cfg().device}，尺寸 ${cfg().size}，丢帧 ${cfg().warmupMs}ms，see ${cfg().see ? '开' : '关'}`)
}
