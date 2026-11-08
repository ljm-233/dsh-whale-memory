/**
 * 后台节拍：备份、日记、夜班、定时梳理、冷启动建索引、全文索引体检。
 *
 * 整块原样从 index.mjs 搬出来（那几个 setInterval / setTimeout），
 * 只把外层包成 createHeartbeat()，结尾把要清的定时器与 db.close 交回去。
 */
import { checkFts } from '../core/fts.mjs'
import { scheduleConsolidate } from './consolidate.mjs'
import { rebuildScenes } from './scenes.mjs'
import { rebuildPersona } from '../persona.mjs'
import { rebuildGraph } from '../graph.mjs'
import { BACKUP_CHECK_MS } from '../constants.mjs'

/**
 * @param {object} deps 依赖
 * @param {object} deps.db 库
 * @param {object} deps.cfg 配置取值函数
 * @param {object} deps.nightly 夜班
 * @param {Function} deps.backupNow 备份
 * @param {Function} deps.writeDiary 写日记
 * @param {Function} deps.dayKeyOf 本地日期键
 * @param {Function} deps.consolidateNow 梳理
 * @param {Function} deps.bumpStat 计数
 * @returns {{dispose:Function}}
 */
export function createHeartbeat({
  db, cfg, nightly, backupNow, writeDiary, dayKeyOf, consolidateNow, bumpStat,
}) {
  const { diaryHour, nightEnabled, nightHour, nightMinute, autoConsolidate, activeSpace } = cfg
  // 备份：每 6 小时看一次，当天没有就备一份。
  const backupTimer = setInterval(() => {
    const result = backupNow()
    if (result.ok === false && result.reason !== 'already-today') {
      console.log('[whale-memory] 备份失败:', JSON.stringify(result))
    }
  }, BACKUP_CHECK_MS)
  backupTimer.unref?.()

  // 日记：每 10 分钟看一眼，过了设定时间还没写就补上。
  // 不等被问、不等被想起——这是「一直在」的那根线。
  const diaryTimer = setInterval(() => {
    const now = new Date()
    if (now.getHours() < diaryHour()) return
    writeDiary(dayKeyOf(now)).catch(() => undefined)
  }, 10 * 60 * 1000)
  diaryTimer.unref?.()

  let nightRanDay = ''
  // 夜班：过 22:05 还没跑就跑，一天只跑一次；错过了也补。
  // 锁在 nightly 里，重复触发不会打架。
  const nightTimer = setInterval(() => {
    const now = new Date()
    if (!nightEnabled()) return
    const minutes = now.getHours() * 60 + now.getMinutes()
    if (minutes < nightHour() * 60 + nightMinute()) return
    const day = dayKeyOf(now)
    if (nightRanDay === day) return
    nightRanDay = day
    const result = nightly.run({ at: now })
    if (result.ok !== true) console.log('[whale-memory] 夜班没跑成:', JSON.stringify(result))
  }, 10 * 60 * 1000)
  nightTimer.unref?.()
  // 定时梳理：每 6 小时，但只在 autoConsolidate === true 时注册。
  // 默认一个定时器都不建：这条链会 DELETE 条目，跑不跑得主人点过头。
  const consolidateTimer = scheduleConsolidate({
    enabled: autoConsolidate(),
    run: () => consolidateNow().then((r) => {
      if (r && !r.skipped) console.log('[whale-memory] 梳理完成:', JSON.stringify(r))
      // 梳理完顺手重排场景：顺序是先散点后成段，场景跟着记忆走。
      try {
        const s = rebuildScenes(db)
        if (s.scenes > 0) console.log('[whale-memory] 场景重建:', JSON.stringify(s))
        // 画像跟着场景走：先成段，再蒸出「我记得的你」。
        rebuildPersona(db, { space: activeSpace() })
        rebuildGraph(db)
      } catch { /* 场景建不出来不影响梳理 */ }
    }).catch(() => undefined),
  })
  // 启动时把场景、画像、图谱建出来，但放到后台做：
  // 这几步会扫几千条记忆，同步跑会把冷启动拖住，而它们都不是「开口前必须有」的东西。
  const warmup = setTimeout(() => {
    try {
      const started = Date.now()
      const s = rebuildScenes(db)
      rebuildPersona(db)
      const spaces = (() => {
        try { return db.prepare('SELECT DISTINCT space FROM entries').all().map((r) => String(r.space)) } catch { return ['default'] }
      })()
      let g = { entities: 0, edges: 0 }
      for (const sp of (spaces.length > 0 ? spaces : ['default'])) {
        const one = rebuildGraph(db, { space: sp })
        g = { entities: g.entities + one.entities, edges: g.edges + one.edges }
      }
      console.log(
        '[whale-memory] 后台建索引完成:',
        JSON.stringify({ ...s, ...g, ms: Date.now() - started }),
      )
    } catch (error) {
      console.log('[whale-memory] 后台建索引失败:', String(error?.message ?? error))
    }
  }, 1500)
  warmup.unref?.()

  // 全文索引周期体检：启动探针只抽一条，理论上会漏，所以每小时再看一次。
  // 发现对不上就 rebuild，代价是几百毫秒，比「搜不到记忆」便宜。
  const ftsTimer = setInterval(() => {
    try {
      const verdict = checkFts(db)
      if (verdict.repaired) {
        bumpStat('ftsRepaired')
        console.log('[whale-memory] 周期性体检发现索引不同步，已重建:', verdict.error ?? '')
      }
    } catch { /* 体检本身出错不影响主流程 */ }
  }, 60 * 60 * 1000)
  ftsTimer.unref?.()

  /** 停表 + 关库：插件的 dispose 原样搬过来。 */
  const dispose = () => {
    try { clearInterval(backupTimer) } catch { /* 忽略 */ }
    try { clearInterval(diaryTimer) } catch { /* 忽略 */ }
    if (consolidateTimer) try { clearInterval(consolidateTimer) } catch { /* 忽略 */ }
    try { db.close() } catch { /* 关闭失败忽略 */ }
  }

  return { dispose }
}
