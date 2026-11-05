#!/usr/bin/env node
/**
 * 把三个插件装进一个 profile（默认 ~/.dsh/profiles/web）。
 *
 * dsh 更新或 pnpm 重装时，手工复制进去的包会被清掉——
 * 这个脚本用来一条命令恢复，顺便把 bundles 名单补全。
 *
 * 这也是「改完代码之后那条命令」：复制完立刻逐文件比对 repo 与副本
 * （client.js / lib/* / package.json），不一致就非零退出。0.28.7 那次事故
 * 就是改了 client.js 没同步——设置页永远看不到新东西，而且重启也没用，
 * 因为重启读的还是 node_modules 里那份旧文件。
 *
 *   node scripts/install-local.mjs            # 同步进默认 profile 并自校验
 *   node scripts/install-local.mjs --profile /path/to/web
 *   node scripts/install-local.mjs --with-group-dump
 *        # 额外的第二层落盘：把 scripts/systemd/*.tpl 渲染进
 *        # ~/.config/systemd/user/ 再 `systemctl --user enable --now dsh-group-dump.timer`
 *        # 不加这个开关，行为与以前完全一样（不碰 systemd）
 *   node scripts/install-local.mjs --render-units /tmp/x
 *        # 只渲染 unit 模板到给定目录，不装包、不碰 systemd（测试用）
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyInstall } from './verify-install.mjs'
import { loadLayerConfig } from '../lib/dump-config.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const flagValue = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  return argv[i + 1] ?? fallback
}

if (flag('help') || argv.includes('-h')) {
  console.log(`用法: node scripts/install-local.mjs [选项]

  --profile <dir>        目标 profile（默认 ~/.dsh/profiles/web）
  --with-group-dump      顺带装第二层落盘定时器（写 ~/.config/systemd/user/ 并 enable --now）
  --render-units <dir>   只把 unit 模板渲染到 <dir>，不装包、不动 systemd
  --config <file.json>   换一份配置来渲染（默认读设置页那份）
  --help, -h             看这段
`)
  process.exit(0)
}

const GROUP_DUMP_UNITS = ['dsh-group-dump.service', 'dsh-group-dump.timer']
const TEMPLATE_DIR = join(root, 'scripts', 'systemd')
const CANONICAL_ROOT = join(homedir(), '.dsh', 'im', 'whale-memory')

/**
 * 渲染 scripts/systemd/*.tpl 到 outDir。
 * 占位符：`__HOME__` → 家目录，`__NODE__` → 当前 node 可执行文件，
 *         `__INTERVAL_MIN__` → 设置页里的落盘间隔分钟数。
 */
function renderGroupDumpUnits(outDir, opts = {}) {
  const home = opts.home ?? homedir()
  const nodePath = opts.node ?? process.execPath
  const layerCfg = loadLayerConfig({ configFile: opts.configFile ?? flagValue('config') })
  const interval = opts.intervalMinutes ?? layerCfg.groupDump.intervalMinutes
  mkdirSync(outDir, { recursive: true })
  const written = []
  for (const name of GROUP_DUMP_UNITS) {
    const tpl = readFileSync(join(TEMPLATE_DIR, `${name}.tpl`), 'utf8')
    let body = tpl
      .replaceAll('__HOME__', home)
      .replaceAll('__NODE__', nodePath)
      .replaceAll('__INTERVAL_MIN__', String(interval))
    if (root !== CANONICAL_ROOT) {
      body = body.split(CANONICAL_ROOT).join(root)
    }
    const target = join(outDir, name)
    writeFileSync(target, body, 'utf8')
    written.push(target)
  }
  return written
}

const renderDir = flagValue('render-units')
if (renderDir) {
  for (const f of renderGroupDumpUnits(renderDir)) console.log(`渲染 ${f}`)
  console.log('只渲染，没装包、没碰 systemd。')
  process.exit(0)
}

const profile = flagValue('profile') ?? join(homedir(), '.dsh', 'profiles', 'web')

const packages = [
  { dir: root, name: 'dsh-whale-memory' },
  { dir: join(root, 'corpus'), name: 'dsh-group-corpus' },
  { dir: join(root, 'proactive'), name: 'dsh-proactive-message' },
]

if (!existsSync(join(profile, 'package.json'))) {
  console.error(`不是 profile 目录：${profile}`)
  process.exit(1)
}

const nodeModules = join(profile, 'node_modules')
mkdirSync(nodeModules, { recursive: true })

for (const pkg of packages) {
  const target = join(nodeModules, pkg.name)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const entry of ['lib', 'client.js', 'cordis.patch.yml', 'package.json', 'README.md']) {
    const source = join(pkg.dir, entry)
    if (existsSync(source)) cpSync(source, join(target, entry), { recursive: true })
  }
  console.log(`装入 ${pkg.name}`)
}

// bundles 名单：缺谁补谁，位置放在 dsh-proactive-message 前后
const manifestPath = join(profile, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const bundles = manifest.dsh?.profile?.bundles
if (!Array.isArray(bundles)) {
  console.error('package.json 里没有 dsh.profile.bundles，先确认这是 DSH profile')
  process.exit(1)
}
for (const pkg of packages) {
  if (!bundles.includes(pkg.name)) {
    bundles.push(pkg.name)
    console.log(`补进 bundles：${pkg.name}`)
  }
}
manifest.dsh.profile.bundles = bundles
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

// 同步完立刻自证：副本是不是刚复制的这一份。不一致就说清楚哪个文件、谁新谁旧。
const report = verifyInstall(profile)
if (!report.ok) {
  console.error('\n同步后校验不通过：')
  for (const pkg of report.packages) {
    for (const d of pkg.diffs) {
      console.error(`  ${pkg.name}/${d.file}  ${d.kind === 'missing' ? '缺' : '旧'}：${d.detail}`)
    }
  }
  console.error('副本和仓库不是同一份，别当它已经生效。')
  process.exit(1)
}
const total = report.packages.reduce((n, p) => n + p.files, 0)
console.log(`校验通过：${report.packages.length} 个包 / ${total} 个文件与仓库一致`)

// 可选：第二层自动落盘的 systemd 单元（不给 --with-group-dump 就一个字都不动）
if (flag('with-group-dump')) {
  const unitDir = join(homedir(), '.config', 'systemd', 'user')
  const files = renderGroupDumpUnits(unitDir, { home: homedir(), node: process.execPath })
  for (const f of files) console.log(`渲染 ${f}`)
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' })
    execFileSync('systemctl', ['--user', 'enable', '--now', 'dsh-group-dump.timer'], { stdio: 'inherit' })
    console.log('group-dump 定时器已启用（systemctl --user list-timers dsh-group-dump.timer 可查）')
  } catch (err) {
    console.error(`systemd 操作失败，unit 已渲染但没启用：${err?.message ?? err}`)
    console.error('手动：systemctl --user daemon-reload && systemctl --user enable --now dsh-group-dump.timer')
  }
}

console.log('\n装好了，重启 dsh 生效（改完代码先跑这条，光重启没用）。')
console.log('验证：curl http://127.0.0.1:3080/dsh-whale-memory/status')
