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
// Host 的 schema 默认层：行尾那块「默认 X」只从这一层读，客户端不写死默认值。
const base = {
  budgetChars: 4000, recentPairs: 6, cardDailyMax: 12, recallMax: 5, space: 'default',
  moodEnabled: true, moodInjectDailyMax: 6, hotZoneMax: 30,
  groupDump: { enabled: true, intervalMinutes: 10, dir: '' },
  weekly: { enabled: true, startDay: 1 },
}
const writes = []

const makeForm = (val, usr, bs = {}) => ({
  getSnapshot: () => ({
    status: 'ready', value: val, base: bs, user: usr, revision: 3, writable: true,
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
const form = makeForm(value, user, base)
const proactiveForm = makeForm(proactiveValue, proactiveUser, { dailyCap: 2 })

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

/** 去标签后的可见文本：量「读了几个字」用。 */
const visibleText = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

for (const text of [
  // 五个区（按「我要干什么」分）+ 顶部锚点导航
  '它现在怎么想我', '记忆怎么收', '记忆内容', '怎么被叫醒', '危险与诊断',
  // 常用项：默认就摊开，不用点
  '记账开关', '一天最多说几次', '注入字符上限', '当前空间',
  '热区保留轮数', '每天最多注入几次', '每轮最多想起几条',
  '群聊自动落盘', '落盘间隔', '周记', '备份一份',
  // 记忆内容那一栏（现在自己占一页）
  '热区', '冷区', '场景', '画像', '图谱', '空间',
]) {
  assert.ok(html.includes(text), `页面里应该出现「${text}」`)
}
assert.ok(html.includes('value="1000"'), '应该渲染出当前值 1000')
assert.ok(/已改/.test(html), '用户改过的项要标出来')
assert.ok(!html.includes('budgetChars · 已改'), '路径不再常驻行内')
assert.ok(/title="[^"]*budgetChars \(50–50000\)"/.test(html), '路径与取值范围放进 title')
assert.ok(!visibleText(html).includes('budgetChars'), '路径仍然不常驻行内')
assert.ok(/title="[^"]*groupDump\.intervalMinutes[^"]*"/.test(html), '嵌套字段也有 title（常用里的那一行）')
assert.ok(!html.includes('archive.enabled · 已改'), '没改过的项不能误标')
assert.ok(!html.includes('记忆空间'), '「记忆空间」那张单行卡已并进注入与空间')
assert.ok(html.includes('当前空间'), '空间字段并进注入与空间后仍然在')

// ---- 一行三块：名称 / 控件 / 极短后缀 ----
{
  // 行尾后缀只允许「默认 X」或「已改」，不许再并排单位·范围·覆盖态。
  const nodes = html.split(/<[^>]+>/).map((x) => x.trim()).filter(Boolean)
  const withDefault = nodes.filter((t) => t.includes('默认'))
  assert.ok(withDefault.length > 0, '每行要有「默认 X」这一块')
  assert.equal(withDefault.filter((t) => t.includes('·')).length, 0, '后缀里不能同时出现「·」和「默认」')
  assert.ok(!visibleText(html).includes('范围 '), '范围不再常驻行内（进 title）')
  // 单位写进名称的括号里
  assert.ok(html.includes('注入字符上限（字）'), '单位写在名称后的括号里')
  assert.ok(html.includes('落盘间隔（分钟）'), '嵌套字段也带单位')
}

// ---- 常用 / 高级两层 ----
{
  const { GROUPS: G, ACTIONS: A } = plugin.__test
  const fields = G.flatMap((g) => g.fields)
  const core = fields.filter((f) => f.tier === 'core')
  const coreActions = A.filter((a) => a.tier === 'core')
  assert.ok(fields.length === 40, '一共 40 个设置项（数量不变，只分层）')
  assert.ok(core.length + coreActions.length <= 14, '常用区合计 ≤14 项')
  assert.equal(core.length + coreActions.length, 13, '常用 13 项（12 个字段 + 备份按钮）')
  for (const key of ['budgetChars', 'space', 'recentPairs', 'cardDailyMax', 'recallMax',
    'moodEnabled', 'moodInjectDailyMax', 'groupDump.enabled', 'groupDump.intervalMinutes', 'weekly.enabled']) {
    assert.ok(core.some((f) => f.path.join('.') === key), `${key} 应该在常用里`)
  }
  assert.deepEqual(A.filter((a) => a.tier === 'core').map((a) => a.id), ['backup'], '备份按钮在常用里')
  // 高级默认折叠：没点之前，高级里的东西一个都不渲染
  assert.ok(html.includes('高级（3 项）'), '现在区的高级入口')
  assert.ok(html.includes('高级（14 项）'), '记忆怎么收的高级入口')
  assert.ok(html.includes('高级（7 项）'), '怎么被叫醒的高级入口')
  assert.ok(html.includes('高级（6 项）'), '诊断区的高级入口')
  assert.ok(!html.includes('收起高级'), '默认是折叠的')
  for (const hidden of ['打分公式', '自动写日记', '导出目录', '影子模式', '免打扰起点', '心情半衰期', '热区条数上限']) {
    assert.ok(!html.includes(hidden), `高级项「${hidden}」默认不渲染`)
  }
  assert.ok(/title="[^"]*scoreMode/.test(html) === false, '诊断项默认收起，首屏不渲染')
  assert.ok(!html.includes('展开诊断'), '「展开诊断」按钮已被「高级」入口取代')
}

// ---- 说明一行、≤25 字 ----
{
  const { GROUPS: G } = plugin.__test
  const fields = G.flatMap((g) => g.fields)
  const tooLong = fields.filter((f) => [...f.desc].length > 25)
  assert.deepEqual(tooLong.map((f) => f.path.join('.')), [], '每项说明 ≤25 字')
  assert.ok(fields.every((f) => typeof f.long === 'string' && [...f.long].length > 10), '长解释挪进 long（渲染成 title 悬停）')
  for (const g of G) assert.ok([...g.hint].length <= 30, `${g.title} 的组说明 ≤30 字`)
  for (const z of plugin.__test.ZONES) assert.ok([...z.hint].length <= 30, `${z.title} 的区说明 ≤30 字`)
  for (const f of fields) {
    if (f.kind === 'int' || f.kind === 'num') assert.match(f.label, /（.+）$/, `${f.path.join('.')} 的单位要写进名称括号`)
  }
}

// ---- 状态条压到 4 格，取不到数据写「—」 ----
{
  const { statusChipsOf } = plugin.__test
  const empty = statusChipsOf(null, null, undefined)
  assert.equal(empty.length, 4, '状态条只有 4 格')
  assert.deepEqual(empty.map((c) => c.label), ['版本', '条目', '今日注入', '情绪'])
  assert.ok(empty.every((c) => c.value === '—'), '取不到数据写「—」')
  const full = statusChipsOf(
    { pluginVersion: '0.28.18', hot: 41, cold: 1914, cardInject: { day: new Date().toISOString().slice(0, 10), count: 3 } },
    { recent: [{ mood: 62, reason: '今天话短' }] }, 12)
  assert.deepEqual(full.map((c) => c.value), ['v0.28.18', '1955 条', '3 / 12', '62'])
  assert.equal(full[1].hint, '热 41 · 冷 1914')
  // 页面上一个问号都不许有：以前六格全是「?」，看着像坏了。
  assert.equal((visibleText(html).match(/[?？]/g) ?? []).length, 0, '页面上不能出现「?」')
}

// ---- 页签：条 / 高亮 / 隐藏而不卸载 / hash 与 localStorage ----
{
  const { ZONES: Z, TAB_KEY, parseTabHash, tabOf } = plugin.__test

  // 1) 键名与 slug 是写死的契约：改了就换一条书签，得让测试叫一声。
  assert.equal(TAB_KEY, 'whale-memory.settings.tab', 'localStorage 的键名')
  assert.deepEqual(Z.map((z) => z.slug), ['mood', 'memory', 'content', 'wake', 'diag'], '五条页签的 hash 名字，按顺序')
  assert.deepEqual(Z.map((z) => z.id), ['now', 'intake', 'content', 'wake', 'diag'], '记忆内容排在「记忆怎么收」后面')

  // 2) 页签条：五个名字按顺序、每个都是 role="tab"。
  const barStart = html.indexOf('role="tablist"')
  assert.ok(barStart > 0, '页签条要有 role="tablist"')
  const barHtml = html.slice(barStart, html.indexOf('</div>', barStart))
  assert.deepEqual([
    ...barHtml.matchAll(/role="tab"[^>]*>([^<]+)</g),
  ].map((m) => m[1]), ['它现在怎么想我', '记忆怎么收', '记忆内容', '怎么被叫醒', '危险与诊断'], '页签条五个名字按顺序')
  assert.ok(/id="dsh-whale-memory-tab-mood"[^>]*aria-selected="true"/.test(html), '默认停在第一页（mood 高亮）')
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1, '只有一条页签是高亮的')
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1, '只有当前页签进 Tab 序列（其余 tabindex=-1）')
  assert.equal((html.match(/tabindex="-1"/g) ?? []).length, 4, '其余四条页签 tabindex=-1')

  // 3) 四页都渲染，只给非当前页加 hidden——卸载会把没保存的草稿丢掉。
  const panels = {}
  for (const m of html.matchAll(/<section\b[^>]*>/g)) {
    const slug = /id="dsh-whale-memory-panel-([a-z]+)"/.exec(m[0])?.[1]
    if (slug === undefined) continue
    assert.ok(m[0].includes('role="tabpanel"'), `${slug} 面板带 role="tabpanel"`)
    assert.ok(m[0].includes(`aria-labelledby="dsh-whale-memory-tab-${slug}"`), `${slug} 面板指向自己的页签`)
    panels[slug] = { html: html.slice(m.index + m[0].length, html.indexOf('</section>', m.index)), hidden: /\shidden(=""|\s|>)/.test(m[0]) }
  }
  assert.deepEqual(Object.keys(panels), ['mood', 'memory', 'content', 'wake', 'diag'], '五页都在 DOM 里')
  assert.equal(panels.mood.hidden, false, '当前页不 hidden')
  for (const slug of ['memory', 'content', 'wake', 'diag']) assert.equal(panels[slug].hidden, true, `${slug} 是隐藏而不是没渲染`)

  // 4) 隐藏页里的控件照样在——切回来时草稿还在。
  assert.ok(panels.memory.html.includes('注入字符上限'), '隐藏的页里控件仍在（只隐藏不卸载）')
  // 这一套假件里 fetch 一律失败，所以预览走「读不到状态」那一支——文案换，位置不变。
  assert.ok(panels.mood.html.includes('下面是配置项'), '第一页有只读预览')
  assert.ok(panels.diag.html.includes('下面是配置项'), '诊断页有自己那条计数（spk 覆盖率，读不到时写读不到）')
  // 「记忆内容」一页：库里的东西搬过来了，第一页不再有列表。
  for (const text of ['热区', '冷区', '场景', '画像', '图谱', '空间']) {
    assert.ok(panels.content.html.includes(text), `记忆内容页要有「${text}」`)
  }
  assert.ok(panels.content.html.includes('全部空间'), '记忆内容页有空间的全部/单空间开关')
  assert.ok(!panels.mood.html.includes('全部空间'), '第一页不再挂记忆列表')
  assert.ok(!panels.mood.html.includes('冷区'), '第一页不再挂冷区列表')

  // 5) 状态条只在第一页：其余页一个「今日注入」都不许有。
  assert.ok(panels.mood.html.includes('今日注入'), '状态条在第一页顶部')
  for (const slug of ['memory', 'content', 'wake', 'diag']) {
    assert.ok(!panels[slug].html.includes('今日注入'), `${slug} 页不重复状态条`)
  }

  // 6) hash 与 localStorage 都是纯函数：四条 slug、区 id 别名、脏数据。
  assert.equal(parseTabHash('#tab=mood'), 'now')
  assert.equal(parseTabHash('#tab=memory'), 'intake')
  assert.equal(parseTabHash('#tab=content'), 'content', '记忆内容页的 hash')
  assert.equal(parseTabHash('#tab=wake'), 'wake')
  assert.equal(parseTabHash('#tab=diag'), 'diag')
  assert.equal(parseTabHash('#tab=intake'), 'intake', '老书签用区 id 也认')
  assert.equal(parseTabHash('#tab=memory&x=1'), 'intake', '带别的参数也认')
  assert.equal(parseTabHash('tab=wake'), 'wake', '不带 # 也认')
  assert.equal(parseTabHash('#nope'), undefined, '认不出返回 undefined（不抛）')
  assert.equal(parseTabHash(''), undefined)
  assert.equal(parseTabHash(undefined), undefined)
  assert.equal(tabOf('content'), 'content', '记忆内容页 slug → 区 id')
  assert.equal(tabOf('mood'), 'now', 'slug → 区 id')
  assert.equal(tabOf('DIAG'), 'diag', '大小写不敏感')
  assert.equal(tabOf(undefined), 'now', '认不出回第一页')
  assert.equal(tabOf('乱写'), 'now', '脏数据回第一页')

  // 7) 每页的常用/高级项数（页签不搬字段，只分页）。
  const countOf = (zoneId) => {
    const fields = plugin.__test.GROUPS.filter((g) => (g.zone ?? 'intake') === zoneId).flatMap((g) => g.fields)
    const core = fields.filter((f) => f.tier === 'core').length
      + (zoneId === 'diag' ? plugin.__test.ACTIONS.filter((a) => a.tier === 'core').length : 0)
    const adv = fields.length - fields.filter((f) => f.tier === 'core').length
      + (zoneId === 'diag' ? plugin.__test.ACTIONS.filter((a) => a.tier === 'adv').length : 0)
    return { core, adv }
  }
  assert.deepEqual(Z.map((z) => countOf(z.id)), [
    { core: 2, adv: 3 }, { core: 8, adv: 14 }, { core: 0, adv: 0 }, { core: 2, adv: 7 }, { core: 1, adv: 6 },
  ], '五页的常用/高级项数（记忆内容一页没有配置项）')
  assert.ok(Z.every((z) => countOf(z.id).core <= 14), '每页常用 ≤14 项')
}

// ---- 记忆内容：一条记忆两行（摘要 + 元信息）、热冷色条、空状态 ----
{
  const { entryRow, entryMetaText, countBar, emptyBox, sameDay } = plugin.__test
  const nowMs = Date.now()
  const item = {
    id: 7, at: nowMs - 60000, weight: 3.2, emo: ['tired'], user: '这一句是摘要，点开才看全文',
    assistant: '嗯，我在。', space: 'default', spk: 'abcdef123456', imp: null,
    hits: 4, tier: 1, lastHit: nowMs, hot: false,
  }
  const meta = entryMetaText(item)
  for (const part of ['default', 'abcdef12', '命中 4 次', 'tier 1', '最后想起', '冷区']) {
    assert.ok(meta.includes(part), `元信息要有「${part}」：${meta}`)
  }
  assert.ok(!meta.includes('abcdef123'), 'spk 只取前 8 位')
  assert.ok(!meta.includes('\n'), '元信息一行排完')
  assert.ok(!meta.includes('重要度'), 'imp 为 NULL 时收起态不写「重要度」（不占位）')
  assert.ok(!meta.includes('未知'), '没来源时不再写「未知」占位')

  // 真库里 spk 全空、imp 全 NULL、tier 0：收起时正好四段。
  const bare = entryMetaText({ ...item, spk: '', imp: null, tier: 0, hits: 0, lastHit: 0, hot: false })
  assert.equal(bare, 'default · 命中 0 次 · 还没被想起 · 冷区', `四段：${bare}`)

  // 三个可选字段都有值时的收起态：来源 8 位 + 重要度 + tier 都出现。
  const rich = entryMetaText({ ...item, spk: '8F0AA398xxxx', imp: 0.87, tier: 2 })
  for (const part of ['来源 8F0AA398', '重要度 0.87', 'tier 2', '命中 4 次', '最后想起']) {
    assert.ok(rich.includes(part), `有值才显示「${part}」：${rich}`)
  }
  assert.ok(!rich.includes('8F0AA398x'), '收起态来源只给前 8 位')

  // 点开：补全字段（来源全量、重要度自动/数值、写入与 tier 变动时间）。
  const opened = entryMetaText({ ...item, spk: '', imp: null }, { open: true })
  for (const part of ['来源 没记', '重要度 自动', 'tier 1', '写入', 'tier 变动']) {
    assert.ok(opened.includes(part), `展开态要补「${part}」：${opened}`)
  }
  assert.ok(entryMetaText({ ...item, spk: '8F0AA398xxxx', imp: 0.87, tier: 2 }, { open: true }).includes('来源 8F0AA398xxxx'),
    '展开态来源给全 12 位')

  // 收起：正好两行（摘要 / 元信息），全文不出现。
  const closed = renderToStaticMarkup(entryRow(item, { open: false }))
  const closedText = visibleText(closed).trim()
  assert.ok(closedText.includes('这一句是摘要'), '第一行是摘要')
  assert.ok(closedText.includes('命中 4 次'), '第二行是元信息')
  assert.ok(!closedText.includes('嗯，我在。'), '收着的时候不摊全文')
  assert.ok(!closedText.includes('撤回'), '收着的时候不显示写入口')
  assert.equal((closed.match(/nowrap/g) ?? []).length >= 2, true, '两行都按一行排（nowrap）')

  // 展开：全文 + 写入口都出来，摘要行仍是同一句。
  const open = renderToStaticMarkup(entryRow(item, { open: true }))
  const openText = visibleText(open).trim()
  assert.ok(openText.includes('这一句是摘要'), '展开后摘要还在')
  assert.ok(openText.includes('嗯，我在。'), '展开后能看到助手那句')
  assert.ok(openText.includes('改') && openText.includes('撤回'), '展开后才有改/撤回')
  assert.ok(openText.includes('重要度 自动') && openText.includes('tier 变动'), '展开后第二行补全字段')
  assert.ok(open.includes('pre-wrap'), '展开的第二行允许折行')

  // imp 有值写数值；NULL 只在展开态说「自动」。
  assert.ok(entryMetaText({ ...item, imp: 6 }).includes('重要度 6'), 'imp 有值写数值')
  assert.ok(!entryMetaText({ ...item, imp: null }).includes('自动'), '收起态 imp 为 NULL 不写')
  assert.ok(entryMetaText({ ...item, imp: null }, { open: true }).includes('自动'), '展开态 imp 为 NULL 写「自动」')
  // 没命中过 / 热区 也说得出来。
  const cold = entryMetaText({ ...item, lastHit: 0, hot: true, hits: 0 })
  assert.ok(cold.includes('还没被想起') && cold.includes('热区'), '没命中过与热区都要写出来')

  // 热冷色条：两段按条数分宽，数字写在旁边。
  const bar = renderToStaticMarkup(countBar({ hot: 30, cold: 1914 }))
  assert.ok(bar.includes('flex:30 1 0'), '热区那段按 30 分宽')
  assert.ok(bar.includes('flex:1914 1 0'), '冷区那段按 1914 分宽')
  assert.ok(visibleText(bar).includes('热 30') && visibleText(bar).includes('冷 1914'), '条旁边写数字')
  assert.equal(renderToStaticMarkup(countBar({ hot: 0, cold: 0 })), '', '两边都是 0 时不出色条')

  // 空状态：一句「还没有」+ 一句为什么。
  const empty = visibleText(renderToStaticMarkup(emptyBox('热区是空的。', '热区为空：最近没有命中。')))
  assert.ok(empty.includes('热区是空的。'), '空状态第一句说「还没有什么」')
  assert.ok(empty.includes('最近没有命中'), '空状态第二句说为什么')

  // 「今天触发过没有」按本地日历日算。
  assert.equal(sameDay(nowMs), true, '现在算今天')
  assert.equal(sameDay(0), false, '没命中过不算今天')
  assert.equal(sameDay(nowMs - 86400000), false, '昨天不算今天')
  console.log('OK 记忆内容两行/色条/空状态')
}

// ---- 记忆内容只读 + 只读态要说清怎么改 ----
{
  assert.ok(!html.includes('<textarea'), '不该有可自由编辑记忆内容的输入框')
  const roForm = (val) => ({
    getSnapshot: () => ({ status: 'ready', value: val, base: {}, user: {}, revision: 1, writable: false }),
    subscribe: () => () => {},
    set: () => Promise.resolve(false),
    unset: () => Promise.resolve(false),
    mutate: () => Promise.resolve(false),
  })
  let roReg = null
  const roSlots = { inject: (_n, cb) => cb(), register: (_spec, comp) => { roReg = comp; return () => {} } }
  plugin.apply({
    get: (name) => (name === 'slots' ? roSlots
      : name === 'configForms' ? { get: (ns) => roForm(ns === 'dsh-whale-memory' ? value : proactiveValue) }
        : undefined),
  })
  const roHtml = renderToStaticMarkup(React.createElement(roReg))
  assert.ok(roHtml.includes('writable=false'), '只读态要写清「为什么灰、去改哪个文件」')
  assert.ok(roHtml.includes('disabled'), '只读时控件要灰掉')
}

// ---- 写入路径 ----
// 路径 → 写法的映射是纯函数，直接调，不用模拟点击。
const { writePath, resetPath, normalizeNumber, GROUPS, writeStateOf } = plugin.__test
assert.equal(GROUPS.length, 12, '按「我要干什么」分成 12 个小节')
assert.equal(new Set(GROUPS.map((g) => g.zone)).size, 4, '四区：现状 / 收 / 叫醒 / 诊断')
assert.equal(GROUPS.filter((g) => g.form === 'memory').length, 10, '记忆十组（含「入库取舍」与「打分与调试」）')
assert.ok(GROUPS.find((g) => g.title === '注入与空间').fields.some((f) => f.path.join('.') === 'space'), '空间字段落在注入与空间这一组')
assert.equal(GROUPS.filter((g) => g.form === 'proactive').length, 2, '主动消息两组')
assert.equal(GROUPS.flatMap((g) => g.fields).length, 40, '一共 40 个设置项（含 admitShadow / speakerEnabled）')
// 每一项都要「一行说明 + 一段长解释」，另外带 tier（常用/高级）。
for (const field of GROUPS.flatMap((g) => g.fields)) {
  assert.ok(typeof field.desc === 'string' && field.desc.length > 0, `${field.path.join('.')} 缺一行说明`)
  assert.ok(field.tier === 'core' || field.tier === 'adv', `${field.path.join('.')} 缺 tier`)
  if (field.kind === 'bool') assert.ok(typeof field.long === 'string' && field.long.includes('开'), `${field.path.join('.')} 开关缺「开/关会影响什么」`)
}
const injection = GROUPS.find((g) => g.title === '注入与空间').fields.map((f) => f.path.join('.'))
assert.ok(injection.includes('cardDailyMax'), '注入与空间这组要有「每天最多真注入几次」')
assert.ok(injection.includes('cardMinConfidence'), '注入与空间这组要有「注入置信门槛」')
// 三维打分：公式与场景都是下拉（kind: 'select'），调试开关是 bool。
const diagFields = GROUPS.find((g) => g.title === '打分与调试').fields
for (const k of ['scoreMode', 'recallScene', 'axesDebug', 'speakerEnabled']) {
  assert.ok(diagFields.map((f) => f.path.join('.')).includes(k), `诊断这组要有 ${k}`)
}
assert.ok(diagFields.some((f) => f.path.join('.') === 'recallScene' && f.kind === 'select' && f.options.length >= 4),
  '打分场景是下拉，至少四个选项（recall / lookup-old / daily / auto）')
assert.ok(diagFields.some((f) => f.path.join('.') === 'scoreMode' && f.kind === 'select' && f.options.length === 2),
  '打分公式是下拉，两个选项（axes / legacy）')
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
