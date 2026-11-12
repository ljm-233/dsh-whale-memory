/**
 * 本地文本文件：偏好（PREFERENCE.md）与硬规矩（db/规矩.md）。
 *
 * 原样从 index.mjs 搬出来，只把外层包成 createLocalFiles()。
 */
import { mkdirSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute, dirname } from 'node:path'

/**
 * @param {object} deps 依赖
 * @param {object} deps.config 插件配置
 * @param {string} deps.memoryDir 记忆库目录
 * @param {Function} deps.bumpStat 计数
 * @param {object} deps.db 记忆库句柄（用来拿真实库路径）
 * @returns {{preferencePath:string, readPreference:Function, writePreference:Function, readRules:Function}}
 */
export function createLocalFiles({ config, memoryDir, bumpStat, db }) {
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
  /**
   * 硬规矩：`db/规矩.md` 一轮读一次。读不到就整段落空，但要喊一声。
   *
   * 2026-11-11 审计修：原来写的是 `join(memoryDir, '..', 'db', '规矩.md')`，
   * 而 memoryDir 是符号链接（~/.dsh/whale-memory -> ~/.dsh/miyu/plugins/whale-memory），
   * path.join 不做符号链接解析，拼出来是 ~/.dsh/miyu/plugins/db/规矩.md —— 不存在。
   * 结果 rulesSection 每轮返回空串、被宿主静默过滤，硬规矩段从加进来那天起一次没进过上下文。
   * 现在从真实库文件往上推，并且读不到时打 warn。
   */
  const readRules = () => {
    let f = null
    try {
      const p = String(db?.prepare?.('PRAGMA database_list')?.get?.()?.file ?? '')
      if (p !== '') f = join(dirname(p), '规矩.md')
    } catch { /* 拿不到库路径就走回退 */ }
    if (f === null) {
      try {
        f = join(dirname(dirname(realpathSync(memoryDir))), 'db', '规矩.md')
      } catch {
        f = join(memoryDir, '..', 'db', '规矩.md')
      }
    }
    try {
      if (!existsSync(f)) {
        console.warn(`[whale-memory] 硬规矩读不到：${f}`)
        return ''
      }
      return String(readFileSync(f, 'utf8'))
    } catch (exc) {
      console.warn(`[whale-memory] 硬规矩读取失败：${f} ${exc?.message ?? exc}`)
      return ''
    }
  }

  return { preferencePath, readPreference, writePreference, readRules }
}
