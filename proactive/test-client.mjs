/**
 * dsh-proactive-message —— 客户端设置页自检
 *
 * 不启浏览器，也不起 DSH：直接模拟客户端模块运行时
 * （`window.__ModuleLoader__` + `require` 表），把 bundle 里的设置页渲染成
 * HTML，检查它读到了配置值、渲染出每一行。
 *
 * react 拿不到就跳过（仓库本身不带依赖，装了 DSH 的环境才有）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * react 只装在 DSH 那边，仓库本身没有依赖。所以按候选基准目录去找，
 * 从最近的开始：环境变量 > 当前 profile > 当前目录。
 */
const loadFrom = (spec) => {
  const bases = [
    process.env.DSH_PROFILE_DIR && join(process.env.DSH_PROFILE_DIR, 'package.json'),
    join(homedir(), '.dsh', 'profiles', 'web', 'package.json'),
    join(process.cwd(), 'package.json'),
  ].filter(Boolean)
  for (const base of bases) {
    try {
      return createRequire(base)(spec)
    } catch { /* 换下一个基准 */ }
  }
  return null
}

const React = loadFrom('react')
if (React === null) {
  console.log('SKIP 客户端设置页（这台机器上找不到 react）')
  process.exit(0)
}
const renderToStaticMarkup = loadFrom('react-dom/server')?.renderToStaticMarkup
if (typeof renderToStaticMarkup !== 'function') {
  console.log('SKIP 客户端设置页（找不到 react-dom/server）')
  process.exit(0)
}
// 组件对 primitives 是可选依赖：拿不到就退回原生 input，这里照样测得下去。
const primitives = loadFrom('@deepseek-ai/dsh-client-ui-primitives')

// ---- 模拟客户端模块运行时 ----
const handoffs = new Map()
globalThis.window = { __ModuleLoader__: { load: (h) => { handoffs.set(h.id, h) } } }
globalThis.fetch = async () => ({ ok: false })

const source = readFileSync(join(here, 'client.js'), 'utf8')
new Function('window', source)(globalThis.window)

const handoff = handoffs.get('dsh-proactive-message')
assert.ok(handoff, 'bundle 必须以插件 id 注册自己')

const requireShim = (spec) => {
  if (spec === 'react') return React
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    if (primitives === null) throw new Error('primitives absent')
    return primitives
  }
  throw new Error(`unexpected Client external ${spec}`)
}
const plugin = handoff.factory(requireShim)
assert.equal(plugin.name, 'dsh-proactive-message')
assert.deepEqual(plugin.inject, ['slots'])
assert.equal(typeof plugin.apply, 'function')

// ---- 模拟 slots / configForms ----
const value = {
  botId: 'qq_x',
  targetId: 'tgt_x',
  statePath: '',
  dailyCap: 2,
  cooldownHours: 6,
  silenceHours: 8,
  quietStart: 23,
  quietEnd: 8,
  tickMinutes: 30,
}
const user = { dailyCap: 5, quietEnd: 9 }
const writes = []

const form = {
  getSnapshot: () => ({
    status: 'ready', value, base: {}, user, revision: 3, writable: true,
  }),
  subscribe: () => () => {},
  set: (field, v) => { writes.push({ op: 'set', path: [field], value: v }); return Promise.resolve(true) },
  unset: (field) => { writes.push({ op: 'unset', path: [field] }); return Promise.resolve(true) },
  mutate: (ops) => { writes.push(...ops); return Promise.resolve(true) },
}

let registration = null
const slots = {
  inject: (_name, cb) => { cb() },
  register: (spec, component) => {
    registration = { spec, component }
    return () => {}
  },
}
const ctx = {
  get: (name) => {
    if (name === 'slots') return slots
    if (name === 'configForms') return { get: (ns) => (ns === 'dsh-proactive-message' ? form : undefined) }
    return undefined
  },
}

plugin.apply(ctx)
assert.ok(registration, '必须往 settings.section 注册一个页面')
assert.equal(registration.spec.name, 'settings.section')
assert.equal(registration.spec.id, 'dsh-proactive-message')
assert.equal(registration.spec.label(), '主动消息')

// ---- 渲染 ----
const html = renderToStaticMarkup(React.createElement(registration.component))

for (const text of ['什么时候可以说话', '免打扰', '检查频率', '每天最多发几条', '每多少分钟检查一次']) {
  assert.ok(html.includes(text), `页面里应该出现「${text}」`)
}
assert.ok(html.includes('value="2"'), '应该渲染出当前值 2')
assert.ok(html.includes('dailyCap · 已改'), '用户改过的项要标出来')
assert.ok(html.includes('quietEnd · 已改'), '改过的免打扰结束时间也要标')
assert.ok(!html.includes('cooldownHours · 已改'), '没改过的项不能误标')
console.log('OK 客户端设置页')

// ---- 写入路径 ----
// 路径 → 写法的映射是纯函数，直接调，不用模拟点击。
const { writePath, resetPath, GROUPS } = plugin.__test
assert.equal(GROUPS.length, 3)
assert.equal(GROUPS.flatMap((g) => g.fields).length, 6, '一共 6 个设置项')

writePath(form, ['dailyCap'], 5)
writePath(form, ['quietEnd'], 9)
resetPath(form, ['dailyCap'])

assert.deepEqual(writes[0], { op: 'set', path: ['dailyCap'], value: 5 }, '字段走 set')
assert.deepEqual(writes[1], { op: 'set', path: ['quietEnd'], value: 9 })
assert.deepEqual(writes[2], { op: 'unset', path: ['dailyCap'] }, '恢复默认走 unset')
console.log('OK 设置页写入路径')

// ---- 服务缺席时不能崩 ----
const bare = { get: () => undefined }
const bareHandoff = handoffs.get('dsh-proactive-message')
bareHandoff.factory(requireShim).apply(bare)
console.log('OK 服务缺席时安全退出')
