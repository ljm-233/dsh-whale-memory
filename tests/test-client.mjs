/**
 * dsh-whale-memory —— 客户端设置页自检
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

const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
new Function('window', source)(globalThis.window)

const handoff = handoffs.get('dsh-whale-memory')
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
assert.equal(plugin.name, 'dsh-whale-memory')
assert.deepEqual(plugin.inject, ['slots'])
assert.equal(typeof plugin.apply, 'function')

// ---- 模拟 slots / configForms ----
const value = {
  __ns: 'dsh-whale-memory',
  budgetChars: 1000,
  recentPairs: 4,
  factMax: 8,
  recallMax: 3,
  recallThreshold: 2,
  weightMax: 12,
  cardDailyMax: 12,
  cardMinConfidence: 0.35,
  diary: { enabled: true, hour: 22 },
  archive: { enabled: true, notify: true, dir: '', botId: '', targetId: '' },
}
const user = { budgetChars: 1500, archive: { notify: false } }
const writes = []

const makeForm = (val, usr) => ({
  getSnapshot: () => ({
    status: 'ready', value: val, base: {}, user: usr, revision: 3, writable: true,
  }),
  subscribe: () => () => {},
  set: (field, v) => { writes.push({ op: 'set', ns: val.__ns, path: [field], value: v }); return Promise.resolve(true) },
  unset: (field) => { writes.push({ op: 'unset', ns: val.__ns, path: [field] }); return Promise.resolve(true) },
  mutate: (ops) => { writes.push(...ops.map((o) => ({ ...o, ns: val.__ns }))); return Promise.resolve(true) },
})

const proactiveValue = {
  __ns: 'dsh-proactive-message',
  dailyCap: 2,
  cooldownHours: 6,
  silenceHours: 8,
  quietStart: 23,
  quietEnd: 8,
  tickMinutes: 30,
}
const proactiveUser = { dailyCap: 5 }
const form = makeForm(value, user)
const proactiveForm = makeForm(proactiveValue, proactiveUser)

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
    if (name === 'configForms') {
      return {
        get: (ns) => (ns === 'dsh-whale-memory' ? form
          : ns === 'dsh-proactive-message' ? proactiveForm
            : undefined),
      }
    }
    return undefined
  },
}

plugin.apply(ctx)
assert.ok(registration, '必须往 settings.section 注册一个页面')
assert.equal(registration.spec.name, 'settings.section')
assert.equal(registration.spec.id, 'dsh-whale-memory')
assert.equal(registration.spec.label(), '鲸娘记忆')

// ---- 渲染 ----
const html = renderToStaticMarkup(React.createElement(registration.component))

for (const text of [
  '记忆注入', '主动联想', '日记', '自动写日记', '压缩存档',
  '注入字符上限', '想起门槛', '顺手私发主人一份',
  '每天最多真正注入几次', '注入置信门槛',
  '主动消息 · 什么时候可以说话', '主动消息 · 免打扰', '每天最多发几条', '每多少分钟检查一次',
  '记忆内容', '热区', '冷区', '只读',
]) {
  assert.ok(html.includes(text), `页面里应该出现「${text}」`)
}
assert.ok(html.includes('可以单条删掉'), '场景那一块要说明「单条能删、原文不丢」')
assert.ok(html.includes('value="1000"'), '应该渲染出当前值 1000')
// 覆盖标记还在行内，但路径与范围已经收进 title（悬停可见），不再常驻。
assert.ok(/已改/.test(html), '用户改过的项要标出来')
assert.ok(!html.includes('budgetChars · 已改'), '路径不再常驻行内')
assert.ok(html.includes('title="budgetChars (50~50000)"'), '路径与取值范围放进 title')
// 可见文本（去掉标签）里不该再有路径和范围；它们只在 title 属性里。
const visibleText = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
assert.ok(!visibleText(html).includes('50~50000'), '范围字不该出现在可见文本里')
assert.ok(!visibleText(html).includes('budgetChars'), '路径不该常驻行内')
assert.ok(html.includes('title="archive.notify"'), '嵌套字段也有 title')
assert.ok(!html.includes('archive.enabled · 已改'), '没改过的项不能误标')
assert.ok(!html.includes('记忆空间'), '「记忆空间」那张单行卡已并进「记忆注入」')
assert.ok(html.includes('已保存'), '要写清保存回执长什么样')
assert.ok(html.includes('当前空间'), '空间字段并进记忆注入后仍然在')

// ---- 只读态要说清为什么、怎么改 ----
{
  const ro = renderToStaticMarkup(React.createElement(registration.component))
  assert.ok(ro.length > 0)
}
// ---- 记忆内容是只读的 ----
{
  // 所有可写控件都来自 settingRow（有 onWrite）；记忆内容那一块只发 GET 请求。
  assert.ok(!html.includes('<textarea'), '不该有可自由编辑记忆内容的输入框')
  console.log('OK 记忆内容只读')
}

console.log('OK 客户端设置页')

// ---- 写入路径 ----
// 路径 → 写法的映射是纯函数，直接调，不用模拟点击。
const { writePath, resetPath, normalizeNumber, GROUPS, writeStateOf } = plugin.__test
assert.equal(GROUPS.length, 10)
assert.equal(GROUPS.filter((g) => g.form === 'memory').length, 8, '记忆八组（新增「情绪记账」，仍不含「记忆空间」单行卡）')
assert.ok(GROUPS[0].fields.some((f) => f.path.join('.') === 'space'), '空间字段落在记忆注入这组')
assert.equal(GROUPS.filter((g) => g.form === 'proactive').length, 2, '主动消息两组')
assert.equal(GROUPS.flatMap((g) => g.fields).length, 35, '一共 35 个设置项（情绪记账扩到五项）')
const injection = GROUPS[0].fields.map((f) => f.path.join('.'))
assert.ok(injection.includes('cardDailyMax'), '记忆注入这组要有「每天最多真注入几次」')
assert.ok(injection.includes('cardMinConfidence'), '记忆注入这组要有「注入置信门槛」')
const moodFields = GROUPS.find((g) => g.title === '情绪记账').fields.map((f) => f.path.join('.'))
for (const k of ['moodInjectDailyMax', 'moodInjectMinDelta', 'moodInjectCooldownHours']) {
  assert.ok(moodFields.includes(k), `情绪记账这组要有 ${k}`)
}

writes.length = 0
writePath(form, ['budgetChars'], 1500)
writePath(form, ['archive', 'notify'], false)
resetPath(form, ['budgetChars'])
resetPath(form, ['archive', 'notify'])
writePath(proactiveForm, ['dailyCap'], 7)

assert.deepEqual(writes[0], { op: 'set', ns: 'dsh-whale-memory', path: ['budgetChars'], value: 1500 }, '一级字段走 set')
assert.deepEqual(writes[1], { op: 'set', ns: 'dsh-whale-memory', path: ['archive', 'notify'], value: false }, '嵌套字段走 mutate + 路径')
assert.deepEqual(writes[2], { op: 'unset', ns: 'dsh-whale-memory', path: ['budgetChars'] }, '恢复默认走 unset')
assert.deepEqual(writes[3], { op: 'unset', ns: 'dsh-whale-memory', path: ['archive', 'notify'] }, '嵌套恢复默认也走 unset')
assert.deepEqual(writes[4], { op: 'set', ns: 'dsh-proactive-message', path: ['dailyCap'], value: 7 }, '主动消息的字段写进它自己的命名空间')
console.log('OK 设置页写入路径')

// ---- 服务缺席时不能崩 ----
const bare = { get: () => undefined }
const bareHandoff = handoffs.get('dsh-whale-memory')
bareHandoff.factory(requireShim).apply(bare)
console.log('OK 服务缺席时安全退出')

// ---- normalizeNumber：自定义数值 ----
{
  const cap = { min: 0, max: 500 }
  assert.deepEqual(normalizeNumber(cap, '37', 2), { write: true, value: 37, clamped: false }, '任意整数都能写')
  assert.deepEqual(normalizeNumber(cap, '2.5', 2), { write: true, value: 2.5, clamped: false }, '小数也收')
  assert.deepEqual(normalizeNumber(cap, '9999', 2), { write: true, value: 500, clamped: true }, '超上限夹到边界')
  assert.deepEqual(normalizeNumber(cap, '-3', 2), { write: true, value: 0, clamped: true }, '低于下限夹到边界')
  assert.deepEqual(normalizeNumber(cap, '', 2), { write: false }, '清空不写，也不会被重置成默认值')
  assert.deepEqual(normalizeNumber(cap, 'abc', 2), { write: false }, '乱输入不写')
  assert.deepEqual(normalizeNumber(cap, '2', 2), { write: false, clamped: false }, '没变就不写')
  console.log('OK normalizeNumber')
}

// ---- 写操作三态：写中 → 已保存 / 失败：<原因> ----
{
  const accepts = (ok) => ({
    set: () => Promise.resolve(ok),
    unset: () => Promise.resolve(ok),
    mutate: () => Promise.resolve(ok),
  })

  const seen = []
  assert.equal(await writePath(accepts(true), ['budgetChars'], 9, (s) => seen.push(s.status)), true)
  assert.deepEqual(seen, ['saving', 'saved'], '成功要回报写中…和已保存')
  assert.equal(writeStateOf({ status: 'saving' }), '写中…')
  assert.equal(writeStateOf({ status: 'saved' }), '已保存')

  seen.length = 0
  assert.equal(await writePath(accepts(false), ['budgetChars'], 9, (s) => seen.push(s)), false, 'Host 拒绝不能算成功')
  assert.equal(seen[1].status, 'error', '拒绝要报失败')
  assert.ok(seen[1].message.length > 0, '失败必须带原因')
  assert.ok(writeStateOf(seen[1]).startsWith('失败：'), '红字文案是「失败：原因」')

  seen.length = 0
  const broken = { set: () => Promise.reject(new Error('网络断了')), unset: () => Promise.reject(new Error('网络断了')), mutate: () => Promise.reject(new Error('网络断了')) }
  assert.equal(await writePath(broken, ['budgetChars'], 9, (s) => seen.push(s)), false, 'reject 也不抛给页面')
  assert.equal(seen[1].status, 'error')
  assert.match(seen[1].message, /网络断了/u, 'reject 的原因要原样传出来')

  seen.length = 0
  assert.equal(await resetPath(broken, ['budgetChars'], (s) => seen.push(s)), false)
  assert.equal(seen[1].status, 'error', '恢复失败也要报')
  console.log('OK 写操作三态')
}

console.log('\n全部通过')
