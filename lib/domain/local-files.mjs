/**
 * 本地文本文件：偏好（PREFERENCE.md）与硬规矩（db/规矩.md）。
 *
 * 原样从 index.mjs 搬出来，只把外层包成 createLocalFiles()。
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute, dirname } from 'node:path'

/**
 * @param {object} deps 依赖
 * @param {object} deps.config 插件配置
 * @param {string} deps.memoryDir 记忆库目录
 * @param {Function} deps.bumpStat 计数
 * @returns {{preferencePath:string, readPreference:Function, writePreference:Function, readRules:Function}}
 */
export function createLocalFiles({ config, memoryDir, bumpStat }) {
  // ---- 偏好：由经历长出来的那部分，和写死的底线分开 ----
  const preferencePath = (() => {
    const raw = String(config.preferencePath ?? '').trim()
    if (raw === '') return join(homedir(), '.dsh', 'im', 'memory', 'PREFERENCE.md')
    return isAbsolute(raw) ? raw : resolve(memoryDir, raw)
  })()

  /** 读偏好文件；读不到就当没有。 */
  const readPreference = () => {
    try {
      return existsSync(preferencePath) ? String(readFileSync(preferencePath, 'utf8')) : ''
    } catch {
      return ''
    }
  }

  /**
   * 覆写偏好。旧版先留一份 `.bak`——偏好可以变，但不能悄悄变。
   *
   * @param {string} text 新内容
   * @returns {string} 存下来的内容
   */
  const writePreference = (text) => {
    const body = String(text ?? '').trim().slice(0, 4000)
    try {
      if (existsSync(preferencePath)) {
        writeFileSync(`${preferencePath}.bak`, String(readFileSync(preferencePath, 'utf8')), 'utf8')
      }
      mkdirSync(dirname(preferencePath), { recursive: true })
      writeFileSync(preferencePath, `${body}\n`, 'utf8')
      bumpStat('preference')
    } catch { /* 写不了就算了 */ }
    return body
  }
  /** 硬规矩：`db/规矩.md` 一轮读一次。读不到就整段不出，不影响别的。 */
  const readRules = () => {
    try {
      const f = join(memoryDir, '..', 'db', '规矩.md')
      return existsSync(f) ? String(readFileSync(f, 'utf8')) : ''
    } catch { return '' }
  }

  return { preferencePath, readPreference, writePreference, readRules }
}
