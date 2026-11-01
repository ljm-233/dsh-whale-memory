#!/usr/bin/env node
/**
 * 校验「装进 profile 的那一份」和仓库是不是同一份。
 *
 * 事故（0.28.7）：把「冷热分层」一组加进了 client.js，但只改了仓库，
 * 没同步进 ~/.dsh/profiles/web/node_modules/dsh-whale-memory。
 * dsh 加载的是 node_modules 里那份旧 bundle，所以设置页看不到新组，
 * 而且**重启也没用**——重启读的还是那个旧文件。改完必须同步。
 *
 *   node scripts/verify-install.mjs                     # 默认 profile
 *   node scripts/verify-install.mjs --profile <dir>     # 指定 profile
 *   node scripts/verify-install.mjs --json              # 机器可读
 *
 * 退出码：0 一致（没有副本时打 SKIP 也算 0），1 不一致。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(import.meta.url)
const root = dirname(dirname(here))

/** 三个本地包：仓库目录 → 装进 node_modules 的名字。 */
export const PACKAGES = [
  { dir: root, name: 'dsh-whale-memory' },
  { dir: join(root, 'corpus'), name: 'dsh-group-corpus' },
  { dir: join(root, 'proactive'), name: 'dsh-proactive-message' },
]

/** 安装脚本会复制过去的顶层条目；其余文件不参与比对。 */
const TOP_FILES = ['client.js', 'cordis.patch.yml', 'package.json', 'README.md']

function walk(dir) {
  const out = []
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full))
    else if (e.isFile()) out.push(full)
  }
  return out
}

/**
 * 仓库里这个包应该出现在副本里的全部文件（相对路径，正斜杠）。
 *
 * @param {string} pkgDir 包目录
 * @returns {string[]} 相对路径
 */
export function sourceFiles(pkgDir) {
  const files = []
  for (const name of TOP_FILES) {
    const p = join(pkgDir, name)
    try { if (statSync(p).isFile()) files.push(name) } catch { /* 没有就算了 */ }
  }
  for (const f of walk(join(pkgDir, 'lib'))) files.push(relative(pkgDir, f).split(sep).join('/'))
  return files.sort()
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const stamp = (p) => {
  try { return statSync(p).mtime.toISOString().slice(0, 19).replace('T', ' ') } catch { return '?' }
}

/**
 * 逐个文件比字节。
 *
 * 只要求「仓库里的文件副本都有、且一模一样」；副本多出来的文件不管，
 * 那是 npm 或别的工具留下的，不属于「不同步」。
 *
 * @param {string} [profileDir] profile 目录
 * @returns {{profile:string, ok:boolean, skipped:boolean, reason?:string, packages:Array}}
 */
export function verifyInstall(profileDir = join(homedir(), '.dsh', 'profiles', 'web')) {
  const result = { profile: profileDir, ok: true, skipped: false, packages: [] }
  if (!existsSync(join(profileDir, 'package.json'))) {
    return { ...result, skipped: true, reason: `不是 profile 目录：${profileDir}` }
  }

  for (const pkg of PACKAGES) {
    const target = join(profileDir, 'node_modules', pkg.name)
    const entry = { name: pkg.name, ok: true, files: 0, diffs: [] }
    result.packages.push(entry)

    if (!existsSync(target)) {
      entry.ok = false
      entry.diffs.push({ file: '.', kind: 'missing', detail: '整包没有装进 node_modules' })
      result.ok = false
      continue
    }

    for (const file of sourceFiles(pkg.dir)) {
      const from = join(pkg.dir, file)
      const to = join(target, file)
      let same = false
      let present = false
      try {
        present = statSync(to).isFile()
        if (present) same = Buffer.compare(readFileSync(from), readFileSync(to)) === 0
      } catch { same = false }
      entry.files += 1
      if (same) continue

      const a = readJson(from)
      const b = present ? readJson(to) : null
      const version = a?.version || b?.version
        ? `版本 ${b?.version ?? '?'} → ${a?.version ?? '?'}`
        : (present ? '内容不同' : '副本里没有这个文件')
      entry.diffs.push({
        file,
        kind: present ? 'stale' : 'missing',
        detail: version,
        source: stamp(from),
        installed: present ? stamp(to) : '',
      })
    }

    if (entry.diffs.length > 0) {
      entry.ok = false
      result.ok = false
    }
  }

  return result
}

function main(argv) {
  const at = argv.indexOf('--profile')
  const profile = at !== -1 ? argv[at + 1] : undefined
  const report = verifyInstall(profile)

  if (argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.ok ? 0 : 1)
  }
  if (report.skipped) {
    console.log(`SKIP 安装副本校验（${report.reason}）`)
    process.exit(0)
  }

  for (const pkg of report.packages) {
    console.log(`${pkg.ok ? 'OK  ' : 'FAIL'} ${pkg.name}  ${pkg.files} 个文件`)
    for (const d of pkg.diffs) {
      const when = d.source === '' ? '' : `（仓库 ${d.source}${d.installed === '' ? '' : ` / 副本 ${d.installed}`}）`
      console.log(`     ${d.file}  ${d.kind === 'missing' ? '缺' : '旧'}：${d.detail}${when}`)
    }
  }

  if (!report.ok) {
    console.error('\n副本和仓库不是同一份：先 node scripts/install-local.mjs 再重启，光重启没用。')
    process.exit(1)
  }
  console.log(`\n一致：${report.profile}`)
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2))
}
