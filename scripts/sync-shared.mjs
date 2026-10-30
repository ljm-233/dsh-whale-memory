#!/usr/bin/env node
/**
 * 把 shared/helpers.mjs 复制到三个包的 lib/ 下。
 *
 * 单一源，生成三份副本——这样每个包都能独立安装，
 * 又不会各写一份慢慢长歪。测试里会校验副本与源一致。
 */
import { copyFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'shared', 'helpers.mjs')
const targets = [
  join(root, 'lib', 'shared.mjs'),
  join(root, 'corpus', 'lib', 'shared.mjs'),
  join(root, 'proactive', 'lib', 'shared.mjs'),
]

if (process.argv.includes('--check')) {
  const expected = readFileSync(source, 'utf8')
  let bad = 0
  for (const target of targets) {
    let actual = ''
    try { actual = readFileSync(target, 'utf8') } catch { /* 缺文件 */ }
    if (actual !== expected) { console.error(`不一致: ${target}`); bad += 1 }
  }
  if (bad > 0) process.exit(1)
  console.log('三份副本都与源一致')
} else {
  for (const target of targets) copyFileSync(source, target)
  console.log('已同步到三个包')
}
