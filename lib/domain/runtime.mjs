/**
 * 运行期那一摞：写入器、备份、日记、夜班、压缩抢救、每一轮、整理、节拍、自压缩。
 *
 * 原来是 index.mjs 里连着摆的十几段，按「apply() 时造一次、活到进程结束」收在这里。
 * 逻辑一个字没改：依赖从参数进来，句柄一次交回去。
 */
import { clamp } from '../format.mjs'
import { createBackup } from '../core/backup.mjs'
import { createDiary } from '../diary.mjs'
import { createNightly } from '../nightly.mjs'
import { createSalvage } from '../salvage.mjs'
import { createConsolidator, createConsolidateAll } from './consolidate.mjs'
import { createWriterFor } from './writer-wire.mjs'
import { createTurnRecorder } from './turns.mjs'
import { createHeartbeat } from './heartbeat.mjs'
import { createSelfCompact } from './self-compact.mjs'

/**
 * @param {object} deps 依赖
 * @param {object} deps.db 库
 * @param {object} deps.config 插件配置
 * @param {object} deps.cfg 配置取值函数
 * @param {string} deps.memoryDir 记忆库目录
 * @param {Function} deps.bumpStat 计数
 * @param {Function} deps.cfgVal 读一项配置
 * @param {Function} deps.dayOf 本地日期键
 * @param {Function} deps.askModel 调模型
 * @param {Function} deps.routeFor 按层取路由
 * @param {Function} deps.defaultRoute 默认路由
 * @param {Function} deps.resolveNotifyTarget 私发目标
 * @param {Function} deps.getIm 拿 dshIm
 * @param {Function} deps.getLlm 拿 llm
 * @param {Function} deps.getAgents 拿 agents
 * @param {Function} deps.getCommands 拿 commands
 * @param {Function} deps.embedTexts 向量
 * @param {Function} deps.associate 联想
 * @returns {object} 运行期句柄
 */
export function createRuntime({
  db, config, cfg, memoryDir, bumpStat, cfgVal, dayOf, askModel, routeFor, defaultRoute,
  resolveNotifyTarget, getIm, getLlm, getAgents, getCommands, embedTexts, associate,
}) {
  const { activeSpace } = cfg

  // 交互落库（含说话人解析与取舍层影子），模块见 lib/domain/writer-wire.mjs。
  const writer = createWriterFor({ db, config, cfg, bumpStat })

  // 备份：坏了就全没了，所以定期做，并且当场校验。
  const backup = createBackup({ db, memoryDir, cfgVal, config, bumpStat, dayKeyOf: (d = new Date()) => dayOf(d) })
  const { backupNow, listBackups, backupDir, backupKeep } = backup

  const { dayKeyOf, writeDiary } = createDiary({ db, askModel, diaryEnabled: cfg.diaryEnabled, bumpStat, clamp })
  // 夜班：结账、降层、蒸桌面页、写日志。单独成模块，见 lib/nightly.mjs
  const nightly = createNightly({
    db, memoryDir, dayKeyOf, backupNow, space: activeSpace, log: (line) => console.log(line),
  })
  // 压缩抢救：单独成模块，见 lib/salvage.mjs
  const { salvageCompacted } = createSalvage({
    db, askModel, embedTexts, archiveEnabled: cfg.archiveEnabled, archiveDir: cfg.archiveDir,
    archiveNotify: cfg.archiveNotify, resolveNotifyTarget, bumpStat,
    sendIm: (botId, targetId, text, opts) => getIm().send(botId, targetId, text, opts),
  })

  // 每一轮：共享时间线、情绪记账、联想、压缩抢救（session/event 钩子）。
  const { handleSessionEvent } = createTurnRecorder({ db, writer, cfg, dayKeyOf, associate, salvageCompacted })

  // 记忆整理：单独成模块，见 lib/domain/consolidate.mjs
  const { consolidateNow } = createConsolidator({
    db, bumpStat, defaultRoute, routeFor, getLlm, space: activeSpace, backupNow,
  })
  const consolidateAll = createConsolidateAll({ db, consolidateNow, space: activeSpace })

  // 后台节拍：备份、日记、夜班、定时梳理、冷启动建索引、索引体检。
  const heartbeat = createHeartbeat({
    db, cfg, nightly, backupNow, writeDiary, dayKeyOf, consolidateNow, bumpStat,
  })
  /** 自己压缩的入口：走 host 平面的 commands，等于自己敲了一次 /compact。 */
  const compactNow = createSelfCompact({ db, bumpStat, getCommands, getAgents })

  return {
    writer, backupNow, listBackups, backupDir, backupKeep,
    dayKeyOf, writeDiary, nightly, handleSessionEvent,
    consolidateNow, consolidateAll, heartbeat, compactNow,
  }
}
