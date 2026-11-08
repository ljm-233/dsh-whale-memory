/**
 * 「安装副本 vs 运行中的这一份」：设置页顶部那条「同没同步」。
 *
 * 原样从 index.mjs 搬出来，只把外层包成 createInstallInfo()。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

import { PLUGIN_VERSION } from '../constants.mjs'

/**
 * @returns {Function} installInfo
 */
export function createInstallInfo() {
  const installInfo = (() => {
    let cache = null
    let cacheAt = 0
    return () => {
      // 设置页会反复刷这个端点：5 秒内的结果直接复用，别每次都去读文件。
      if (cache !== null && Date.now() - cacheAt < 5000) return cache
      const here = (() => { try { return dirname(dirname(fileURLToPath(import.meta.url))) } catch { return '' } })()
      const profileRoot = join(homedir(), '.dsh', 'profiles')
      let copyDir = ''
      try {
        for (const name of readdirSync(profileRoot)) {
          const cand = join(profileRoot, name, 'node_modules', 'dsh-whale-memory')
          if (existsSync(join(cand, 'package.json'))) copyDir = cand
        }
      } catch { /* 没有 profiles 就当没装 */ }
      const readOr = (dir, rel) => {
        try { return readFileSync(join(dir, rel)) } catch { return null }
      }
      const digest = (buf) => (buf === null ? '' : createHash('sha1').update(buf).digest('hex'))
      if (copyDir === '') {
        cache = { running: PLUGIN_VERSION, installed: null, dir: '', synced: false, reason: '未找到安装副本' }
        cacheAt = Date.now()
        return cache
      }
      const installed = (() => {
        try { return String(JSON.parse(readFileSync(join(copyDir, 'package.json'), 'utf8')).version ?? '') } catch { return '' }
      })()
      // 正在从副本里跑 = 天然同一份；从仓库里跑才逐文件比内容。
      // 只比大小会漏掉「改了但字节数没变」，历史上真出过「改了 client.js 没同步」的事故。
      const same = here === copyDir
      const drift = same ? [] : ['client.js', 'lib/index.mjs', 'package.json']
        .filter((rel) => digest(readOr(here, rel)) !== digest(readOr(copyDir, rel)))
      cache = {
        running: PLUGIN_VERSION,
        installed: installed === '' ? null : installed,
        dir: copyDir,
        synced: same || (installed === PLUGIN_VERSION && drift.length === 0),
        runningFrom: here,
        drift,
      }
      cacheAt = Date.now()
      return cache
    }
  })()

  return installInfo
}
