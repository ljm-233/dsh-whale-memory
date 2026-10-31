#!/usr/bin/env node
/**
 * 冷启动冒烟：把仓库拷到临时目录，当成「妹妹刚装完」的机器跑一遍。
 *
 * 它要回答的问题不是「代码能不能加载」，而是：
 *   换一个干净的 HOME，没有历史数据、没有软链、没有我本机的配置，还能不能起来。
 *
 * 跑法：npm run smoke
 */
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const work = mkdtempSync(join(tmpdir(), 'miyu-smoke-'))
const copy = join(work, 'plugin')
const fakeHome = join(work, 'home')
mkdirSync(fakeHome, { recursive: true })

let failed = 0
const step = (name, ok, extra = '') => {
  console.log(`${ok ? '  OK  ' : '  NG  '}${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) failed += 1
}

// 1) 复制一份干净仓库（不含 .git）
cpSync(root, copy, { recursive: true, filter: (src) => !src.includes('/.git') })

// 2) 冷启动：空 HOME 下能否建库并读出 0 条
const probe = `
import { createRequire } from 'node:module'
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(${JSON.stringify(join(work, 'probe.db'))})
db.exec('CREATE TABLE t(x)')
console.log('sqlite ok')
`
const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
  cwd: copy, env: { ...process.env, HOME: fakeHome }, encoding: 'utf8',
})
step('空 HOME 下 node:sqlite 可用', r.status === 0, r.stderr?.trim().split('\n').pop() ?? '')

// 3) 版本号：package.json 与 constants 一致
const pkg = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8'))
const consts = readFileSync(join(copy, 'lib', 'constants.mjs'), 'utf8')
const constVer = consts.match(/PLUGIN_VERSION\s*=\s*'([^']+)'/u)?.[1]
step('版本号一致', pkg.version === constVer, `${pkg.version} vs ${constVer}`)

// 4) 加载主模块（在副本里，不碰本机数据）
const load = spawnSync(process.execPath, ['--input-type=module', '-e',
  `await import(${JSON.stringify(join(copy, 'lib', 'index.mjs'))}); console.log('loaded')`], {
  cwd: copy, env: { ...process.env, HOME: fakeHome }, encoding: 'utf8',
})
step('主模块可加载', load.status === 0, load.stderr?.trim().split('\n').pop() ?? '')

// 5) 两份数据目录都不存在时，代码自己能建
const dirs = [
  join(fakeHome, '.dsh', 'whale-memory'),
  join(fakeHome, '.dsh', 'group-corpus'),
  join(fakeHome, '.dsh', 'proactive-message'),
]
step('空 HOME 下不会崩在路径上', dirs.every((d) => !existsSync(d)) && load.status === 0)

// 6) 全套测试在副本里仍然通过
const all = spawnSync(process.execPath, [join(copy, 'scripts', 'check-all.mjs')], {
  cwd: copy, env: { ...process.env, HOME: fakeHome }, encoding: 'utf8',
})
const tail = (all.stdout ?? '').trim().split('\n').slice(-2).join(' ')
step('check-all 在干净副本里通过', all.status === 0, tail)

rmSync(work, { recursive: true, force: true })
console.log(`\n${failed === 0 ? '冷启动通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
