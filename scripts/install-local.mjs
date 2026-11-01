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
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyInstall } from './verify-install.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const argProfile = process.argv.indexOf('--profile')
const profile = argProfile !== -1 ? process.argv[argProfile + 1] : join(homedir(), '.dsh', 'profiles', 'web')

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

console.log('\n装好了，重启 dsh 生效（改完代码先跑这条，光重启没用）。')
console.log('验证：curl http://127.0.0.1:3080/dsh-whale-memory/status')
