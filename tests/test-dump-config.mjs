#!/usr/bin/env node
/**
 * 记忆分层配置（lib/dump-config.mjs）的单元测试。
 *
 * 四种情况：默认 / 关掉 / 改间隔 / 改目录，外加 profile yml 解析。
 * 全部在 /tmp 里造文件，不碰真实配置。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LAYER_DEFAULTS, loadLayerConfig, readProfileYamlFlat } from '../lib/dump-config.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dir = join(tmpdir(), `dump-config-test-${process.pid}`)
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const write = (name, body) => {
  const p = join(dir, name)
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  return p
}

// ---- 默认值 ----
{
  const cfg = loadLayerConfig({ profileFile: join(dir, 'nope.yml') })
  assert.equal(cfg.source, 'defaults')
  assert.deepEqual(cfg.groupDump, { ...LAYER_DEFAULTS.groupDump, dir: cfg.groupDump.dir })
  assert.equal(cfg.groupDump.enabled, true)
  assert.equal(cfg.groupDump.intervalMinutes, 10)
  assert.ok(cfg.groupDump.dir.endsWith('/.dsh/miyu/logs'), `默认导出目录：${cfg.groupDump.dir}`)
  assert.equal(cfg.weekly.enabled, true)
  assert.equal(cfg.weekly.startDay, 1)
  console.log('OK 默认值')
}

// ---- 关掉 ----
{
  const p = write('off.json', { groupDump: { enabled: false }, weekly: { enabled: false } })
  const cfg = loadLayerConfig({ configFile: p })
  assert.equal(cfg.groupDump.enabled, false)
  assert.equal(cfg.weekly.enabled, false)
  console.log('OK 关掉')
}

// ---- 改间隔（夹到 1–1440）----
{
  const p = write('interval.json', { groupDump: { intervalMinutes: 30 } })
  assert.equal(loadLayerConfig({ configFile: p }).groupDump.intervalMinutes, 30)
  const over = write('interval-over.json', { groupDump: { intervalMinutes: 99999 } })
  assert.equal(loadLayerConfig({ configFile: over }).groupDump.intervalMinutes, 1440, '超上限夹回 1440')
  console.log('OK 改间隔')
}

// ---- 改目录（含 ~ 展开）----
{
  const p = write('dir.json', { groupDump: { dir: '/tmp/whatever/logs' } })
  assert.equal(loadLayerConfig({ configFile: p }).groupDump.dir, '/tmp/whatever/logs')
  const tilde = write('dir-tilde.json', { groupDump: { dir: '~/custom/logs' } })
  assert.ok(!loadLayerConfig({ configFile: tilde }).groupDump.dir.includes('~'), '~ 要展开')
  console.log('OK 改目录')
}

// ---- 周记起始日 ----
{
  const p = write('week.json', { weekly: { startDay: 7 } })
  assert.equal(loadLayerConfig({ configFile: p }).weekly.startDay, 7)
  const bad = write('week-bad.json', { weekly: { startDay: 99 } })
  assert.equal(loadLayerConfig({ configFile: bad }).weekly.startDay, 7, '越界夹到 7')
  console.log('OK 周记起始日')
}

// ---- profile yml：只认本插件那段，别把别的插件读进来 ----
{
  const yml = write(
    'profile.yml',
    ['- id: dsh-whale-memory', '  config:', '    groupDump:', '      enabled: false', '      intervalMinutes: 25', '    weekly:', '      startDay: 3', '- id: dsh-proactive-message', '  config:', '    weekly:', '      startDay: 5', ''].join('\n'),
  )
  const flat = readProfileYamlFlat(yml)
  assert.equal(flat['groupDump.enabled'], false)
  assert.equal(flat['groupDump.intervalMinutes'], 25)
  assert.equal(flat['weekly.startDay'], 3, '不能被下一个插件的同名键盖掉')
  const cfg = loadLayerConfig({ profileFile: yml })
  assert.equal(cfg.groupDump.enabled, false)
  assert.equal(cfg.weekly.startDay, 3)
  console.log('OK profile yml 解析')
}

// ---- 关掉时脚本真的什么都不干 ----
{
  const p = write('off2.json', { groupDump: { enabled: false, dir: join(dir, 'out') } })
  const out = execFileSync(process.execPath, [join(root, 'scripts/dump-group.mjs'), '--config', p], { encoding: 'utf8' })
  assert.match(out, /已关闭/)
  const files = execFileSync('bash', ['-lc', `ls ${join(dir, 'out')} 2>/dev/null | wc -l`], { encoding: 'utf8' }).trim()
  assert.equal(files, '0', '关掉时不该建目录/写文件')
  console.log('OK 关闭即跳过')
}

rmSync(dir, { recursive: true, force: true })
console.log('\n全部通过')
