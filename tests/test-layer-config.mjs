/**
 * 分层配置的「一处定义」自检。
 *
 * 这几件事都是一次手误就能悄悄破坏、而且平时看不出来的：
 *   - 版本号在 `constants.mjs` 里又写死一份（发布时忘了改）
 *   - `groupDump.intervalMinutes` 少了 `.volatile()`（设置页改了不生效，还没人报错）
 *   - zod schema / 设置页的 fallback 各自又带一套默认值（跟 `LAYER_DEFAULTS` 漂移）
 *
 * 所以直接读源码断言，不依赖 schemastery 在不在（这台机器上它常常解析不到）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LAYER_DEFAULTS, loadLayerConfig } from '../lib/dump-config.mjs'
import { PLUGIN_VERSION } from '../lib/constants.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (p) => readFileSync(join(root, p), 'utf8')

// ---- 1) 版本号只有 package.json 一处 ----
const pkg = JSON.parse(read('package.json'))
assert.equal(PLUGIN_VERSION, pkg.version, 'constants 报出来的版本要等于 package.json 的')
const consts = read('lib/constants.mjs')
assert.ok(!/PLUGIN_VERSION\s*=\s*['"`]/.test(consts), 'constants.mjs 里不能再写死版本号字符串')
console.log(`OK 版本号单一来源 ${pkg.version}`)

// ---- 2) 分层设置项全部 volatile ----
const index = read('lib/index.mjs')
const schemaBlock = (name) => {
  const from = index.indexOf(`${name}: z.object({`)
  assert.ok(from > 0, `index.mjs 里应该还有 ${name} 这一组`)
  const to = index.indexOf('}).default({})', from)
  assert.ok(to > from, `${name} 那一组的结尾应该还能找到`)
  return index.slice(from, to)
}
const LAYER_FIELDS = {
  groupDump: ['enabled', 'intervalMinutes', 'dir'],
  weekly: ['enabled', 'startDay'],
}
for (const [group, keys] of Object.entries(LAYER_FIELDS)) {
  const src = schemaBlock(group)
  for (const key of keys) {
    const line = src.split('\n').find((l) => l.trim().startsWith(`${key}:`))
    assert.ok(line, `${group}.${key} 应该还在 schema 里`)
    assert.ok(/\.volatile\(\)/.test(line), `${group}.${key} 必须带 .volatile()（intervalMinutes 原来就漏了这一项）`)
  }
}
console.log(`OK 分层设置项 ${Object.values(LAYER_FIELDS).flat().length} 项全部 volatile`)

// ---- 3) 默认值只剩 LAYER_DEFAULTS 一份 ----
for (const ref of [
  'LAYER_DEFAULTS.groupDump.enabled',
  'LAYER_DEFAULTS.groupDump.intervalMinutes',
  'LAYER_DEFAULTS.groupDump.dir',
  'LAYER_DEFAULTS.weekly.enabled',
  'LAYER_DEFAULTS.weekly.startDay',
]) {
  assert.ok(index.includes(`.default(${ref})`), `schema 默认值要引用 ${ref}`)
}
const gdSrc = schemaBlock('groupDump')
assert.ok(!/intervalMinutes: .*\.default\(\d\)/.test(gdSrc), 'intervalMinutes 不能再写死数字默认值')
assert.ok(!/dir: z\.string\(\)\.default\('/.test(gdSrc), 'groupDump.dir 不能再写死目录默认值')
const wkSrc = schemaBlock('weekly')
assert.ok(!/startDay: .*\.default\(\d\)/.test(wkSrc), 'weekly.startDay 不能再写死数字默认值')

// 设置页那边也不许自带 fallback：那是第二份默认值
const client = read('client.js')
// 这一组在重新分组后叫「落盘与周记」（分区：记忆怎么收）。
const layerStart = client.indexOf("title: '落盘与周记'")
assert.ok(layerStart > 0, '设置页里应该还有「落盘与周记」这一组')
const layerFields = client.slice(layerStart, client.indexOf(']', layerStart))
assert.ok(!/fallback:/.test(layerFields), '这几项不该再写 fallback——schema 已有 default')
console.log('OK 默认值只在 LAYER_DEFAULTS')

// ---- 4) 没配置时读回来的就是那一份，配了就以配置为准 ----
{
  const none = {
    configFile: join(root, 'no-such-config.json'),
    profileFile: join(root, 'no-such-profile.yml'),
  }
  const bare = loadLayerConfig(none)
  assert.equal(bare.source, 'defaults')
  assert.equal(bare.groupDump.intervalMinutes, LAYER_DEFAULTS.groupDump.intervalMinutes, '没配置时就该是 LAYER_DEFAULTS 的值')
  assert.equal(bare.groupDump.enabled, LAYER_DEFAULTS.groupDump.enabled)
  assert.equal(bare.weekly.startDay, LAYER_DEFAULTS.weekly.startDay)

  const tuned = loadLayerConfig({
    configFile: join(dirname(fileURLToPath(import.meta.url)), 'fixtures-layer-config.json'),
    profileFile: none.profileFile,
  })
  assert.equal(tuned.groupDump.intervalMinutes, 25, '显式配了就以配置为准（默认值不参与覆盖）')
}
console.log('OK 改设置 → 读回来 → 脚本按它跑')

console.log('OK 分层配置')
