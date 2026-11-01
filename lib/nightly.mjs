/**
 * 夜班：一天一次，把白天的乱账结清，再写下一份能交货的东西。
 *
 * 顺序是固定的：备份 → 结算 → 降层 → 清理 → 重建场景/画像/图谱 →
 * 蒸桌面页 → 写日档 → 写日志（末尾一行四数）。中途断了就断在哪儿写哪儿，
 * 但锁一定放掉，不然第二天没人敢跑。
 *
 * 锁不认主人，只认时间：30 分钟内有人占着就退出，超过就当死锁拆掉重来。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDesk, deskCounts, readPromises, writeDeskFile } from './desk.mjs'
import { COLD_TTL_MS, HOT_ZONE_MAX, HOT_TTL_MS, IMPORTANT_WEIGHT, NIGHT_LOCK_MS } from './constants.mjs'
import { rebuildScenes } from './scenes.mjs'
import { rebuildPersona } from './persona.mjs'
import { rebuildGraph } from './graph.mjs'

/** 一天的第一毫秒。 */
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/**
 * 造夜班。所有真实状态都从库里读，函数本身不缓存。
 *
 * @param {object} deps
 * @param {object} deps.db 记忆库
 * @param {string} deps.memoryDir 记忆目录
 * @param {Function} deps.dayKeyOf 本地日期键
 * @param {Function} [deps.backupNow] 备份函数
 * @param {Function} [deps.space] 当前记忆空间
 * @param {Function} [deps.log] 打日志
 * @returns {{run:Function, selfCheck:Function, lockPath:Function}}
 */
export function createNightly(deps) {
  const { db, memoryDir, dayKeyOf, backupNow, space = () => 'default', log = () => undefined } = deps

  const lockPath = () => join(memoryDir, 'nightly.lock')
  const booksDir = () => join(memoryDir, '记忆本')
  const logsDir = () => join(memoryDir, '日志')

  /** 拿锁；拿不到返回原因，不抛。 */
  const acquire = (now = Date.now()) => {
    const path = lockPath()
    try {
      if (existsSync(path)) {
        const stat = statSync(path)
        const held = now - stat.mtimeMs
        if (held >= 0 && held < NIGHT_LOCK_MS) return { ok: false, reason: 'locked', heldMs: held }
        rmSync(path, { force: true })
      }
      mkdirSync(memoryDir, { recursive: true })
      writeFileSync(path, JSON.stringify({ pid: process.pid, at: now }), 'utf8')
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: 'lock-error', error: String(error?.message ?? error) }
    }
  }

  const release = () => {
    try { rmSync(lockPath(), { force: true }) } catch { /* 放不掉也只能这样 */ }
  }

  /** 结算：热的降温、冷的加权上浮、太老的清掉。只动分层，不删事实。 */
  const settle = (now, sp, allowPrune = false) => {
    const result = { demoted: 0, promoted: 0, pruned: 0 }
    try {
      // 分层唯一口径：tier 由 (权重, 时间) 排出来，hot 跟着 tier 走。
      const r = recomputeTiers(db, HOT_ZONE_MAX)
      result.promoted = r.up
      result.demoted = r.down
    } catch { result.demoted = 0; result.promoted = 0 }
    // 默认不删任何条目：分层只降温与上浮，事实永不自动销毁。
    // 需要腾地方时用 scripts/memory-tidy.mjs --prune 手动跑，且必须带 --yes。
    if (allowPrune === true) {
      try {
        result.pruned = db.prepare(
          'DELETE FROM entries WHERE hot = 0 AND space = ? AND t < ? AND w < ?',
        ).run(sp, now - COLD_TTL_MS, 3).changes
      } catch { result.pruned = 0 }
    }
    return result
  }

  /** 写一份文件，父目录不在就建。 */
  const writeFile = (path, text) => {
    try {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, text, 'utf8')
      return true
    } catch { return false }
  }

  const readIfExists = (path) => {
    try { return existsSync(path) ? readFileSync(path, 'utf8') : '' } catch { return '' }
  }

  /**
   * 跑一班。返回的就是自证要报的那几个数。
   *
   * @param {object} [opts]
   * @param {Date} [opts.at] 假装现在是几点（测试用）
   * @param {boolean} [opts.force] 无视锁强行跑
   * @returns {object} 结果
   */
  const run = (opts = {}) => {
    const at = opts.at instanceof Date ? opts.at : new Date()
    const now = at.getTime()
    const day = dayKeyOf(at)
    const sp = String(space() ?? 'default')

    const gate = opts.force === true ? { ok: true } : acquire(now)
    if (!gate.ok) return { ok: false, reason: gate.reason, heldMs: gate.heldMs ?? 0 }

    const started = Date.now()
    const report = {
      ok: true, day, space: sp, backup: 'skipped', settle: { demoted: 0, promoted: 0, pruned: 0 },
      deskBytes: 0, deskLevels: {}, merged: 0, layers: {}, logFile: '', ms: 0, errors: [],
    }
    try {
      // 1. 备份：当天没有就备一份；已有就算跳过，不算错。
      if (typeof backupNow === 'function') {
        try {
          const b = backupNow()
          report.backup = b?.ok === true ? 'ok' : (b?.reason ?? 'failed')
        } catch (error) { report.errors.push(`backup:${String(error?.message ?? error)}`) }
      }

      // 2. 结算 + 3. 降层 + 4. 清理
      report.settle = settle(now, sp)

      // 5. 重建：先散点后成段，画像跟着场景走。
      try { rebuildScenes(db) } catch (error) { report.errors.push(`scenes:${String(error?.message ?? error)}`) }
      try { rebuildPersona(db, { space: sp }) } catch (error) { report.errors.push(`persona:${String(error?.message ?? error)}`) }
      try { rebuildGraph(db, { space: sp }) } catch (error) { report.errors.push(`graph:${String(error?.message ?? error)}`) }

      // 6. 桌面页：库里存一份（每轮注入），磁盘上也落一份（人看）。
      const desk = buildDesk(db, { space: sp, promises: readPromises(memoryDir) })
      report.deskBytes = desk.bytes
      report.deskLevels = desk.levels
      try {
        db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('desk', desk.text)
        db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('deskAt', String(now))
      } catch (error) { report.errors.push(`desk-meta:${String(error?.message ?? error)}`) }
      writeDeskFile(memoryDir, desk.text)

      // 7. 日档：今天这一页，按五段写。素材不全就留空，不编。
      report.merged = (() => {
        try {
          return Number(db.prepare('SELECT COUNT(*) c FROM entries WHERE t >= ? AND space = ?').get(dayStart(at), sp)?.c ?? 0)
        } catch { return 0 }
      })()
      const diaryText = (() => {
        try { return String(db.prepare('SELECT text FROM diary WHERE day = ?').get(day)?.text ?? '') } catch { return '' }
      })()
      const dayFile = join(booksDir(), '日档', `${day}.md`)
      const dayPage = [
        `# ${day}`,
        '',
        '- 触点：' + (diaryText === '' ? '（日记还没写）' : '见下'),
        '',
        diaryText === '' ? '' : diaryText,
        '',
        `- 变：今日新进 ${report.merged} 条，热区 ${deskCounts(db, sp).hot} 条。`,
        '- 我的回：',
        '- 回声：',
      ].join('\n')
      writeFile(dayFile, `${dayPage}\n`)

      // 8. 长期：只提炼「我变了什么」，没有新东西就不硬写。
      const longFile = join(booksDir(), '长期.md')
      if (!existsSync(longFile)) writeFile(longFile, '# 长期\n\n> 只提炼「我变了什么」，不是流水账。\n')

      // 9. 索引：让人知道本子在哪。
      writeFile(join(booksDir(), '索引.md'), [
        '# 记忆本索引', '',
        '- `桌面页.md` 每轮读的那一页（由夜班生成）',
        '- `日档/YYYY-MM-DD.md` 一天一份',
        '- `长期.md` 只写变化',
        '- `总体/` 会话全文导出',
        '',
      ].join('\n'))

      // 10. 日志：末尾一行四数，报不出来等于没做。
      report.layers = deskCounts(db, sp)
      const logFile = join(logsDir(), `${day}.md`)
      const previous = readIfExists(logFile)
      const header = previous === '' ? `# ${day} 日志\n\n` : previous
      const line = `L1=${report.layers.hot} L2=${report.layers.cold} 事实=${report.layers.facts} | 桌面页=${report.deskBytes} 字节 | 今晚并入=${report.merged} | 总体=未导出 | ${new Date(now).toLocaleTimeString('zh-CN', { hour12: false })}`
      writeFile(logFile, `${header}${line}\n`)

      // 11. 最后自查：写下这次跑完的时间和数字，下次一读就知道有没有断。
      writeFile(join(memoryDir, '最后自查.txt'), [
        `上次夜班：${new Date(now).toLocaleString('zh-CN', { hour12: false })}`,
        `层：热 ${report.layers.hot} / 冷 ${report.layers.cold} / 事实 ${report.layers.facts}`,
        `桌面页：${report.deskBytes} 字节`,
        `并入：${report.merged}`,
        `日志：${logFile}`,
        `耗时：${Date.now() - started}ms`,
        '',
      ].join('\n'))

      report.logFile = logFile
      report.ms = Date.now() - started
      log(`[whale-memory] 夜班完成 ${JSON.stringify({ hot: report.layers.hot, cold: report.layers.cold, desk: report.deskBytes, merged: report.merged })}`)
    } catch (error) {
      report.ok = false
      report.errors.push(String(error?.message ?? error))
    } finally {
      release()
    }
    return report
  }

  /**
   * 自证：四个数，说不上来的就是没做。
   *
   * @returns {{layers:object, deskBytes:number, mergedTonight:number, logFile:string, lastRun:string}}
   */
  const selfCheck = () => {
    const sp = String(space() ?? 'default')
    const layers = deskCounts(db, sp)
    const desk = (() => {
      try { return String(db.prepare("SELECT v FROM meta WHERE k='desk'").get()?.v ?? '') } catch { return '' }
    })()
    const lastRun = (() => {
      try { return String(db.prepare("SELECT v FROM meta WHERE k='deskAt'").get()?.v ?? '') } catch { return '' }
    })()
    const day = dayKeyOf()
    const todayMerged = (() => {
      try {
        return Number(db.prepare('SELECT COUNT(*) c FROM entries WHERE t >= ? AND space = ?').get(dayStart(new Date()), sp)?.c ?? 0)
      } catch { return 0 }
    })()
    return {
      layers,
      deskBytes: Buffer.byteLength(desk, 'utf8'),
      mergedTonight: todayMerged,
      logFile: join(logsDir(), `${day}.md`),
      lastRun,
    }
  }

  return { run, selfCheck, lockPath }
}
