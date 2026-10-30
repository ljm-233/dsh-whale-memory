#!/usr/bin/env node
/**
 * 把三个插件装进一个 profile（默认 ~/.dsh/profiles/web）。
 *
 * dsh 更新或 pnpm 重装时，手工复制进去的包会被清掉——
 * 这个脚本用来一条命令恢复，顺便把 bundles 名单补全。
 *
 *   node scripts/install-local.mjs            # 装进默认 profile
 *   node scripts/install-local.mjs --profile /path/to/web
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

console.log('\n装好了，重启 dsh 生效。')
console.log('验证：curl http://127.0.0.1:3080/dsh-whale-memory/status')
