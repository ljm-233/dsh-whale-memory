#!/usr/bin/env node
/**
 * 抓「用了却没定义」的名字——拆分时最容易漏的一类错。
 *
 * 手法：拿 TypeScript 以 checkJs 跑一遍（Node 没有公开的 AST 接口），
 * 只看 TS2304（找不到名字），其它类型噪声全部忽略。
 *
 * 没装 tsc 就跳过，不阻塞。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globSync } from 'node:fs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** 找一个能用的 tsc：先看本机，再看 DSH 那套。 */
function findTsc() {
  for (const candidate of [
    process.env.TSC_PATH,
    join(root, 'node_modules', '.bin', 'tsc'),
    '/home/link/deepseek-harness/node_modules/.bin/tsc',
  ]) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

const tsc = findTsc()
if (tsc === null) {
  console.log('SKIP 未定义名字检查（没找到 tsc）')
  process.exit(0)
}

const files = [
  ...globSync('lib/*.mjs', { cwd: root }),
  ...globSync('corpus/lib/*.mjs', { cwd: root }),
  ...globSync('proactive/lib/*.mjs', { cwd: root }),
  // 客户端 bundle 是单文件、手写的，最容易漏掉「用了却没定义」；一并检查。
  'client.js',
].map((f) => join(root, f))

const result = spawnSync(tsc, [
  '--noEmit', '--allowJs', '--checkJs', '--target', 'ES2022',
  '--module', 'ESNext', '--moduleResolution', 'bundler',
  '--skipLibCheck', '--strict', 'false', '--noImplicitAny', 'false',
  ...files,
], { encoding: 'utf8' })

const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n')
  .filter((line) => line.includes('TS2304'))
  // DatabaseSync 等只出现在 JSDoc 类型位置，运行时不解析
  .filter((line) => !/name '(DatabaseSync|process|fetch)'/u.test(line))

if (lines.length > 0) {
  console.error('发现用了却没定义的名字：')
  for (const line of lines) console.error('  ' + line)
  process.exit(1)
}
console.log('OK 未定义名字检查')
