/**
 * 记忆备份：VACUUM INTO 快照 + 当场校验 + 轮转。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import { openDb } from './db-open.mjs'
import { BACKUP_KEEP } from './constants.mjs'

/**
 * 造一对备份函数，绑到某一份记忆库上。
 *
 * @param {object} deps
 * @param {object} deps.db 记忆库
 * @param {string} deps.memoryDir 记忆目录
 * @param {Function} deps.cfgVal 读配置
 * @param {object} deps.config 插件配置
 * @param {Function} deps.bumpStat 计一次数
 * @param {Function} deps.dayKeyOf 本地日期键
 * @returns {{backupNow:Function, listBackups:Function, backupDir:Function, backupKeep:Function, backupEnabled:Function}}
 */
export function createBackup(deps) {
  const { db, memoryDir, cfgVal, config, bumpStat, dayKeyOf } = deps

  const backupCfg = () => (config.backup && typeof config.backup === 'object' ? config.backup : {})
  const backupEnabled = () => cfgVal(backupCfg().enabled, true) !== false
  const backupKeep = () => Math.min(365, Math.max(1, cfgVal(backupCfg().keep, BACKUP_KEEP)))
  const backupDir = () => {
    const raw = String(cfgVal(backupCfg().dir, '') ?? '').trim()
    if (raw === '') return join(memoryDir, 'backups')
    return isAbsolute(raw) ? raw : resolve(memoryDir, raw)
  }

  const backupNow = (opts = {}) => {
    if (!backupEnabled() && opts.force !== true) return { ok: false, reason: 'disabled' }

    const dir = backupDir()
    mkdirSync(dir, { recursive: true })

    const day = dayKeyOf()
    const target = join(dir, `memory-${day}.db`)
    if (existsSync(target) && opts.force !== true) {
      return { ok: false, reason: 'already-today', path: target }
    }

    const path = existsSync(target) ? join(dir, `memory-${day}-${Date.now()}.db`) : target
    try {
      // Windows 路径里的反斜杠在 SQL 字面量里会被原样保留，但统一成正斜杠
      // 更稳妥：SQLite 在 Windows 上同样接受 '/'。
      const sqlPath = path.replace(/\\/gu, '/').replace(/'/gu, "''")
      db.exec(`VACUUM INTO '${sqlPath}'`)
    } catch (error) {
      return { ok: false, reason: 'vacuum-failed', detail: String(error?.message ?? error) }
    }

    // 校验：能打开、能过 integrity_check、条目数对得上
    try {
      const copy = openDb(path, { readOnly: true, timeout: 5000 })
      const integrity = copy.prepare('PRAGMA integrity_check').get()
      const entries = copy.prepare('SELECT COUNT(*) c FROM entries').get().c
      copy.close()
      const verdict = String(Object.values(integrity ?? {})[0] ?? '')
      if (verdict !== 'ok') {
        return { ok: false, reason: 'integrity-failed', path, detail: verdict }
      }

      // 轮转：只留最近 N 份
      const files = readdirSync(dir).filter((f) => /^memory-.*\.db$/u.test(f)).sort()
      for (const old of files.slice(0, Math.max(0, files.length - backupKeep()))) {
        try { rmSync(join(dir, old)) } catch { /* 删不掉就留着 */ }
      }

      const bytes = statSync(path).size
      bumpStat('backup')
      return { ok: true, path, bytes, entries }
    } catch (error) {
      return { ok: false, reason: 'verify-failed', path, detail: String(error?.message ?? error) }
    }
  }

  /** 列出已有备份，新到旧。 */
  const listBackups = () => {
    const dir = backupDir()
    try {
      return readdirSync(dir)
        .filter((f) => /^memory-.*\.db$/u.test(f))
        .sort()
        .reverse()
        .map((f) => {
          const path = join(dir, f)
          const st = statSync(path)
          return { file: f, bytes: st.size, at: st.mtimeMs }
        })
    } catch {
      return []
    }
  }

  return { backupNow, listBackups, backupDir, backupKeep, backupEnabled }
}
