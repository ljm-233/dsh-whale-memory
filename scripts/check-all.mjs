#!/usr/bin/env node
/**
 * 一口气跑完三个包的所有自检。
 *
 * 顺序有讲究：先校验共用工具三份副本一致，再逐包跑语法与用例——
 * 副本不一致时后面全是白跑。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const steps = [
  ['共用工具副本', ['node', [join(root, 'scripts', 'sync-shared.mjs'), '--check']]],
  // 装进 profile 的那份和仓库一致吗：不一致说明改了没同步，重启也不会生效。
  ['安装副本一致', ['node', [join(root, 'scripts', 'verify-install.mjs')]]],
  ['未定义名字', ['node', [join(root, 'scripts', 'lint-undefined.mjs')]], true],
  ['主插件 语法+用例', ['node', [join(root, 'lib', 'index.mjs')]]],
  ['主插件 selfcheck', ['node', [join(root, 'tests', 'test-selfcheck.mjs')]]],
  ['主插件 端点', ['node', [join(root, 'tests', 'test-routes.mjs')]]],
  ['主插件 设置页', ['node', [join(root, 'tests', 'test-client.mjs')]]],
  ['新模块 看门狗', ['node', [join(root, 'tests', 'test-new-modules.mjs')]]],
  ['语料 selfcheck', ['node', [join(root, 'corpus', 'test-selfcheck.mjs')]]],
  ['语料 工具', ['node', [join(root, 'corpus', 'test-tool.mjs')]]],
  ['主动消息 selfcheck', ['node', [join(root, 'proactive', 'test-selfcheck.mjs')]]],
]

let failed = 0
for (const [label, command, soft] of steps) {
  const [cmd, args] = command
  // lib/index.mjs 只是 import 一遍，确认能加载
  const realArgs = args[0].endsWith('lib/index.mjs') ? ['--input-type=module', '-e', `await import(${JSON.stringify(args[0])})`] : args
  const result = spawnSync(cmd, realArgs, { cwd: root, encoding: 'utf8' })
  const ok = result.status === 0
  // 软步骤：缺工具时跳过，不算失败
  if (!ok && soft === true && `${result.stdout ?? ''}${result.stderr ?? ''}`.includes('SKIP')) {
    console.log(`SKIP ${label}`)
    continue
  }
  if (!ok) failed += 1
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n')
    if (detail !== '') console.log(detail)
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
