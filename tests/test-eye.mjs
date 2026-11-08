/**
 * 眼睛（look / see）—— 接线冒烟
 *
 * 从独立插件 dsh-eye 的 tests/smoke.mjs 搬过来（2026-11-08 合并时），改了三处：
 *   · 入口从 `apply(ctx, config)` 换成 `registerEye(ctx, { config, shotsDir, defineTool })`；
 *   · 配置键加 `eye` 前缀（eyeSee / eyePromptHint …）；
 *   · 存图目录指到临时目录，不再往真实的 ~/.dsh/integrations/dsh-eye/shots 里写。
 *
 * 摄像头相关的那几条会真的抓一帧（设备不在时会自动走 no-device 分支，不算失败）。
 *
 * 跑法：node tests/test-eye.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerEye } from '../lib/domain/eye.mjs'

const shotsDir = mkdtempSync(join(tmpdir(), 'wm-eye-'))

const registered = new Map()
const sections = []

/** 假的工具工厂：这一版 whale-memory 的约定是「拿不到 dsh-tools 就不注册工具」，所以这里给一个真的。 */
const defineTool = (spec) => spec

function fakeCtx({ prepareCall = true } = {}) {
  const outputFor = (options) => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `看到了：${options.messages[0].content[0].text.slice(0, 6)}…` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const llm = {
    async resolveModelInfo(_provider, model) {
      return { inputModalities: model === 'text-only' ? ['text'] : ['text', 'image'] }
    },
    stream: outputFor,
  }
  if (prepareCall) {
    llm.prepareCall = async ({ provider, model, maxTokens }) => ({
      config: { provider, model, maxTokens },
      stream: outputFor,
    })
  }
  const services = {
    tools: { register: (definition) => { registered.set(definition.name, definition) } },
    attachments: {
      async saveImage({ data, mediaType, name }) {
        return { attachmentId: `att-${data.length}`, mediaType, bytes: data.length, width: 640, height: 480, name }
      },
    },
    llm,
    systemPrompt: { section: (section) => sections.push(section) },
  }
  return {
    inject(names, callback) {
      const picked = {}
      let ready = true
      for (const service of names) {
        if (services[service] === undefined) ready = false
        else picked[service] = services[service]
      }
      if (!ready) return
      // 真宿主传进来的是「带这个服务的 ctx」，不是服务本身。
      callback({ ...picked, logger: () => ({ info: () => {} }) })
    },
    logger: () => ({ info: () => {} }),
  }
}

const exec = (model = 'fake-vision') => ({
  signal: undefined,
  agent: {
    options: { provider: 'fake', model },
    session: { id: 'session-test', requestHeader: () => ({ config: { provider: 'fake', model } }) },
  },
})

registerEye(fakeCtx(), { config: { eyeSee: true, eyePromptHint: true }, shotsDir, defineTool })

assert.deepEqual([...registered.keys()].sort(), ['look', 'see'], '应注册 look 与 see')
assert.equal(sections.length, 1, '应注入一条系统提示')

// ── look：真抓一帧 ──────────────────────────────────────────────────────────
const look = registered.get('look')
const shot = await look.execute({}, exec())
if (shot.ok === true) {
  assert.match(shot.path, /shots\/\d{8}-\d{6}-\d{3}\.jpg$|wm-eye-.*\/\d{8}-\d{6}-\d{3}\.jpg$/)
  assert.equal(shot.width, 640)
  assert.ok(shot.bytes > 1000, '帧不该是空的')
  assert.equal(shot.image.mediaType, 'image/jpeg')
  const blocks = look.output.render({}, shot)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[1].type, 'image', '吃图的模型应拿到图片块')
  assert.equal(blocks[1].attachment.attachmentId, shot.image.attachmentId)
} else {
  assert.ok(['busy', 'no-device', 'timeout'].includes(shot.error), `意料外的错误：${JSON.stringify(shot)}`)
  const blocks = look.output.render({}, shot)
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, /没看到/)
}
console.log('look:', JSON.stringify(shot.ok === true ? { path: shot.path, w: shot.width, h: shot.height, bytes: shot.bytes, image: shot.image !== undefined } : shot))

// ── look：设备不存在 ────────────────────────────────────────────────────────
const missing = await look.execute({ device: '/dev/video99' }, exec())
assert.equal(missing.ok, false)
assert.equal(missing.error, 'no-device')
console.log('look(no-device):', JSON.stringify(missing))

// ── look：不吃图的模型 → 只给路径 ───────────────────────────────────────────
const textOnly = await look.execute({}, { ...exec(), agent: { options: { provider: 'fake', model: 'text-only' }, session: { id: 's', requestHeader: () => ({ config: { provider: 'fake', model: 'text-only' } }) } } })
if (textOnly.ok === true && textOnly.image === undefined) console.log('look(不吃图的模型): 只给路径 ok')
else console.log('look(不吃图的模型): 跳过（设备不可用或仍带图）', JSON.stringify(textOnly).slice(0, 160))

// ── see：完整链路（假模型）──────────────────────────────────────────────────
const see = registered.get('see')
const answer = await see.execute({ question: '我现在穿着什么' }, exec())
if (answer.ok === true) {
  assert.match(answer.answer, /看到了/)
  assert.equal(answer.model, 'fake-vision')
  assert.match(answer.path, /\.jpg$/)
  assert.equal(see.output.render({}, answer)[0].text, answer.answer)
} else {
  assert.ok(['busy', 'no-device', 'timeout', 'no-vision', 'no-attachment'].includes(answer.error), `意料外的错误：${JSON.stringify(answer)}`)
}
console.log('see:', JSON.stringify(answer))

// ── see：模型不吃图 → no-vision ─────────────────────────────────────────────
const noVision = await see.execute({ question: 'x' }, { ...exec(), agent: { options: { provider: 'fake', model: 'text-only' }, session: { id: 's', requestHeader: () => ({ config: { provider: 'fake', model: 'text-only' } }) } } })
assert.equal(noVision.error, 'no-vision')
console.log('see(no-vision):', JSON.stringify(noVision))

// ── see：拿不到路由 → no-route ──────────────────────────────────────────────
const noRoute = await see.execute({}, { agent: undefined })
assert.equal(noRoute.error, 'no-route')
console.log('see(no-route):', JSON.stringify(noRoute))

// ── see：路由从 requestContext() 读（没有 requestHeader 也要认）───────────────
const contextOnly = await see.execute({ question: 'q' }, {
  signal: undefined,
  agent: {
    options: {},
    session: {
      id: 'ctx-only',
      requestContext: () => ({ provider: 'fake', model: 'fake-vision' }),
      requestHeader: () => undefined,
    },
  },
})
assert.equal(contextOnly.ok, true, `requestContext 路由应当够用：${JSON.stringify(contextOnly)}`)
console.log('see(requestContext 路由):', JSON.stringify({ ok: contextOnly.ok, model: contextOnly.model }))

// ── 老运行时没有 prepareCall：退回手写 options 也要能跑 ──────────────────────
registered.clear()
registerEye(fakeCtx({ prepareCall: false }), { config: { eyeSee: true }, shotsDir, defineTool })
const fallbackSee = registered.get('see')
const fallback = await fallbackSee.execute({ question: 'q' }, exec())
assert.equal(fallback.ok, true, `没有 prepareCall 时应当退回 llm.stream：${JSON.stringify(fallback)}`)
console.log('see(无 prepareCall 退化):', JSON.stringify({ ok: fallback.ok, model: fallback.model }))

// ── 拿不到 dsh-tools（defineTool = null）→ 整块不注册，但提示词照加 ──────────
registered.clear()
sections.length = 0
registerEye(fakeCtx(), { config: { eyeSee: true, eyePromptHint: true }, shotsDir })
assert.equal(registered.size, 0, '没有 defineTool 时不该注册工具（跟本插件其它工具同一道闸）')
assert.equal(sections.length, 1, '提示词不受工具闸影响')
console.log('无 defineTool: 工具不注册，提示词仍在')

// ── 配置键加 eye 前缀，读的是 eye* 那一批 ──────────────────────────────────
registered.clear()
sections.length = 0
registerEye(fakeCtx(), { config: { eyeSee: false, eyePromptHint: false }, shotsDir, defineTool })
assert.deepEqual([...registered.keys()], ['look'], 'eyeSee=false 时只注册 look')
assert.equal(sections.length, 0, 'eyePromptHint=false 时不加提示词')
console.log('eyeSee/eyePromptHint 关掉: 只留 look、无提示词')

rmSync(shotsDir, { recursive: true, force: true })
console.log('\n冒烟测试全部通过')
