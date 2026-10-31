/**
 * 开机自愈：把「别人的插件被升级冲掉」的那几处补丁，在我自己启动时重打一遍。
 *
 * 起因：@xmanrui/dsh-im 一升级，唤醒词和两道 bot 过滤就没了 ⇒ 群里收不到消息；
 * 以前靠手跑脚本，忘了就坏一整天。现在挂在我的 apply 里，幂等、静默、不阻塞启动。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 顺序有讲究：唤醒词 → bot 过滤第一道 → 第二道。缺一道群里就哑。 */
const PATCHES = ['patch-wakeword.py', 'patch-wakeword-cn.py', 'patch-botfilter.py', 'patch-botfilter2.py']

/**
 * 跑一遍全部自愈补丁。
 *
 * @param {{ scriptsDir?: string, log?: (msg: string) => void, python?: string }} [options]
 * @returns {Promise<Array<{patch: string, ok: boolean, out: string}>>}
 */
export const heal = async (options = {}) => {
  const scriptsDir = options.scriptsDir ?? join(homedir(), '.dsh', 'im', 'whale-memory', 'scripts')
  const log = options.log ?? (() => {})
  const python = options.python ?? 'python3'
  const results = []

  for (const patch of PATCHES) {
    const file = join(scriptsDir, patch)
    if (!existsSync(file)) {
      results.push({ patch, ok: true, out: 'skip: 没这个补丁' })
      continue
    }
    try {
      const out = await new Promise((resolve) => {
        let buf = ''
        const child = spawn(python, [file], { stdio: ['ignore', 'pipe', 'pipe'] })
        const timer = setTimeout(() => { try { child.kill() } catch { /* 忽略 */ } }, 30_000)
        child.stdout?.on('data', (c) => { buf += c })
        child.stderr?.on('data', (c) => { buf += c })
        child.on('close', () => { clearTimeout(timer); resolve(buf.trim()) })
        child.on('error', (e) => { clearTimeout(timer); resolve('spawn 失败: ' + String(e?.message ?? e)) })
      })
      results.push({ patch, ok: true, out })
      if (!out.includes('SKIP')) log(`${patch}: ${out.split('\n').pop()}`)
    } catch (error) {
      results.push({ patch, ok: false, out: String(error?.message ?? error) })
    }
  }
  return results
}
