/**
 * dsh-whale-memory —— 记忆本体
 *
 * 这一层只做「接线」：归一化配置、开库、把各块装配到 ctx 上。
 * 具体实现都在 core / domain / surface 三层里，功能与拆分前完全一致。
 *
 * @module dsh-whale-memory
 */

// ---- 对外契约：下面这些名字和拆分前一模一样，别的包与测试都从这里拿 ----
export {
  detectEmotions, cueWords, bigrams, overlap, cosine, extractFacts, similarity, scoreMemory,
} from './language.mjs'
export { readPage, htmlToText } from './web.mjs'
export { localStamp, clamp, textOf, buildArchiveDoc, splitForIm } from './format.mjs'
export { readPolicy, writePolicy, parseJudgement } from './policy.mjs'
export { recentEvents } from './events.mjs'
export { searchEntries, putEntry, correctEntry, retractEntry } from './core/entries.mjs'
export { pairShadowed, isPrivateSession } from './session.mjs'

import {
  PLUGIN_VERSION,
  MEMORY_BUDGET_CHARS, RECENT_PAIRS, RECALL_MAX, FACT_MAX, WEIGHT_MAX, RECALL_THRESHOLD,
  CARD_DAILY_MAX, CARD_MIN_CONFIDENCE, SCORE_MODE, RECALL_SCENE, HOT_ZONE_MAX, HOT_PROMOTE_WEIGHT,
  TIER_PENALTY, BACKUP_KEEP, DIARY_HOUR, NIGHT_HOUR, NIGHT_MINUTE,
  MOOD_INJECT_COOLDOWN_HOURS, MOOD_INJECT_DAILY_MAX, MOOD_INJECT_MIN_DELTA,
} from './constants.mjs'
import { LAYER_DEFAULTS } from './dump-config.mjs'
import { MOOD_CHAT_LINE, MOOD_ENABLED, MOOD_HALF_HOURS, readMood } from './domain/mood.mjs'
import { embedTexts } from './vector.mjs'

import { createConfigView } from './config-view.mjs'
import { openMemory } from './core/schema.mjs'
import { createStats } from './core/stats.mjs'
import { createLocalFiles } from './domain/local-files.mjs'
import { createModelAccess, createNotifyTarget } from './domain/model.mjs'
import { createRuntime } from './domain/runtime.mjs'
import { registerLifecycle } from './domain/lifecycle.mjs'
import { createCrossing } from './domain/crossing.mjs'
// 2026-11-08：眼睛（look / see）与定时叫醒（drop_by_at）从两个独立插件并进来。
import { registerEye } from './domain/eye.mjs'
import { registerDropBy } from './domain/drop-by.mjs'
import { installPromptLayer } from './surface/prompt.mjs'
import { registerRoutes } from './surface/routes.mjs'
import { registerTools } from './surface/tools.mjs'
import { registerArchiveTools } from './surface/tools-archive.mjs'
import { createInstallInfo } from './surface/install-info.mjs'

export function apply(ctx, config = {}) {
  // 配置读法（含记忆库位置）：全是「用时现读」的函数，设置页改完不用重启。
  const cfg = createConfigView({ config })
  const { memoryDir, dbPath, cfgVal, activeSpace, dayOf } = cfg

  // 存储：开库 + 建表 + 迁移旧库 + 全文索引体检。
  const db = openMemory({ memoryDir, dbPath, config, space: cfg.activeSpace })
  const { bumpStat, readStats } = createStats({ db, dayOf })
  const { readPreference, writePreference, readRules } = createLocalFiles({ config, memoryDir, bumpStat })

  // 服务句柄：apply() 时它们可能还没就绪，所以用 inject 存引用。
  let llmRef = null
  let agentsRef = null
  let dshImRef = null
  let commandsRef = null
  ctx.inject(['llm'], (llmCtx) => { llmRef = llmCtx.llm })
  ctx.inject(['agents'], (agentsCtx) => { agentsRef = agentsCtx.agents })
  ctx.inject(['dshIm'], (imCtx) => { dshImRef = imCtx.dshIm })
  // commands 在 host 平面：拿到它就能自己发起一次压缩，不用等人在 IM 里敲 /compact。
  ctx.inject(['commands'], (cmdCtx) => { commandsRef = cmdCtx.commands })

  // 模型与路由（含「私发给谁」）
  const { askModel, routeFor, defaultRoute } = createModelAccess({
    config, cfgVal, getLlm: () => llmRef, getAgents: () => agentsRef,
  })
  const resolveNotifyTarget = createNotifyTarget({ archiveNotify: cfg.archiveNotify, getIm: () => dshImRef })

  // 系统提示词 + 记忆卡 + 心情两行（935 心情牌 / 940 记忆卡 / 950 心情变化）
  const { associate } = installPromptLayer(ctx, { db, memoryDir, bumpStat, cfg, readPreference, readRules })

  // 运行期：写入器、备份、日记、夜班、压缩抢救、每一轮、整理、节拍、自压缩。
  const rt = createRuntime({
    db, config, cfg, memoryDir, bumpStat, cfgVal, dayOf, askModel, routeFor, defaultRoute,
    resolveNotifyTarget, getIm: () => dshImRef, getLlm: () => llmRef, getAgents: () => agentsRef,
    getCommands: () => commandsRef, embedTexts, associate,
  })
  // 两边自动同步（群聊 ↔ 私聊）：轮末记一行摘要 + 短原话，见 lib/domain/crossing.mjs。
  // 原来靠手工脚本写，忘了就断；现在跟每一轮那条钩子串在同一个监听里，只挂一个 session/event。
  // 出错只 warn，绝不挡这一轮。
  const crossing = createCrossing({ memoryDir, warn: (msg) => {
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(`crossing: ${msg}`)
      else console.warn(`crossing: ${msg}`)
    } catch { /* 连日志都别炸 */ }
  } })
  // 定时叫醒也只听这一个监听（它以前是自己 ctx.on；插件内的测试桩是单监听 map，
  // 多挂一个会把前一个顶掉，所以统一在这里转调）。
  const wakeStateFile = (() => {
    const v = config.wakeStateFile
    const t = String((v && typeof v.get === 'function' ? v.get() : v) ?? '').trim()
    return t === '' ? undefined : t
  })()
  const dropBy = registerDropBy(ctx, { config, memoryDir, stateFile: wakeStateFile, defineTool })

  ctx.on('session/event', (session, event) => {
    rt.handleSessionEvent(session, event)
    crossing.handleSessionEvent(session, event)
    dropBy.handleSessionEvent(session, event)
  })

  // HTTP 端点：单独一块，见 lib/surface/routes.mjs。
  registerRoutes(ctx, {
    db, dbPath, readStats, bumpStat, budgetChars: cfg.budgetChars, PLUGIN_VERSION,
    memoryDir, rebuildDesk: rt.nightly.rebuildDesk, configuredSpace: activeSpace, axesInfo: cfg.axesInfo,
    admitShadow: cfg.admitShadowOn, installInfo: createInstallInfo(),
    // 画像页要照卡片的口径列出「关于你的事实」实际取到的几条，所以把 factMax 一起递下去。
    factMax: cfg.factMax,
    readMood,
    backupDir: rt.backupDir, backupKeep: rt.backupKeep, backupNow: rt.backupNow, listBackups: rt.listBackups,
    dayKeyOf: rt.dayKeyOf, writeDiary: rt.writeDiary, nightly: rt.nightly, consolidateNow: rt.consolidateAll,
    resolveNotifyTarget, getIm: () => dshImRef, compactNow: rt.compactNow,
  })

  // 模型侧工具：单独一块，见 lib/surface/tools.mjs。
  registerTools(ctx, {
    defineTool, db, embedTexts, backupNow: rt.backupNow, listBackups: rt.listBackups,
    readPreference, writePreference, space: activeSpace, weightMax: cfg.weightMax,
  })

  // 2026-11-08：翻旧账那一对（memory_find / memory_read）——查归查、读归读。
  registerArchiveTools(ctx, { defineTool, db, spaceOf: activeSpace })

  // 眼睛：look / see 两个工具 + 一行提示。抓帧逻辑在 lib/domain/eye-capture.mjs。
  registerEye(ctx, { config, defineTool })

  // 开机自愈 / B站报告看门狗 / 收摊（停表 + 关库）。
  registerLifecycle(ctx, { dispose: rt.heartbeat.dispose })
}

export const name = 'dsh-whale-memory'

/**
 * 配置 schema —— 设置页靠它自动生成表单。
 *
 * 带 `.volatile()` 的字段是「活引用」：改完下一次读配置就读到新值，不用重启插件。
 * 不带的是插件加载时读一次再缓存（memoryPath、llm、备份/存档目录这类），改了要重启。
 * `groupDump.intervalMinutes` 插件自己从不读（只给 install-local 渲染 systemd timer 用），
 * 标 volatile 是为了跟同组的项一致——它真正的生效点是「脚本下次启动自己读配置」。
 *
 * schemastery 是 DSH 自带的，拿不到就整个 schema 不导出——
 * 插件照旧跑，只是设置页里看不到这一页。
 */
let z = null
try {
  ;({ default: z } = await import('@deepseek-ai/schemastery'))
} catch { /* 没有 schemastery 就退化成无 schema */ }

/** 模型侧工具工厂。拿不到就只保留 HTTP 端点。 */
let defineTool = null
try {
  ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch { /* 没有 dsh-tools 就不注册工具 */ }

export const Config = z === null ? undefined : z.object({
  memoryPath: z.string().default(''), // 记忆库目录，留空用 ~/.dsh/whale-memory。改了要重启。
  /** 蒸馏按层路由：便宜的模型跑 L1，强的跑 L3；留空跟随默认路由。 */
  llm: z.object({
    l1: z.string().default(''), // "provider/model"；l1 = 合并/抽取
    l2: z.string().default(''),
    l3: z.string().default(''), // 画像；persona 不填就用 l3
  }).default({}),

  space: z.string().default('default').volatile(), // 记忆空间：同一份库按空间隔离。热改，改完下一轮生效。
  budgetChars: z.natural().min(50).max(50000).default(MEMORY_BUDGET_CHARS).volatile(), // 每次注入的记忆字符上限
  recentPairs: z.natural().min(0).max(100).default(RECENT_PAIRS).volatile(), // 热区保留的最近交互轮数
  factMax: z.natural().min(0).max(500).default(FACT_MAX).volatile(), // 稳定事实条数上限
  recallMax: z.natural().min(0).max(50).default(RECALL_MAX).volatile(), // 每轮最多想起几条旧事
  recallThreshold: z.number().min(0).max(1000).default(RECALL_THRESHOLD).volatile(), // 想起来的分数门槛，越高越不容易触发
  weightMax: z.number().min(1).max(10000).default(WEIGHT_MAX).volatile(), // 单条权重上限，防止被反复想起的条目垄断回忆位

  // 记忆卡的闸门：一天最多真注入几次、联想置信度低于多少就不刷新卡片。默认值只在 constants.mjs 写一份。
  cardDailyMax: z.natural().min(0).max(500).default(CARD_DAILY_MAX).volatile(),
  cardMinConfidence: z.number().min(0).max(1).default(CARD_MIN_CONFIDENCE).volatile(),

  // 三维打分：选公式 / 场景 / 打不打印分解。权重与半衰只写在 lib/axes.mjs 的 SCENE 一份。
  // 环境变量 WHALE_SCORE_MODE 优先于 scoreMode（A/B 一键回退）。
  scoreMode: z.string().default(SCORE_MODE).volatile(), // enum 不可用：见 normalizeScoreMode
  recallScene: z.string().default(RECALL_SCENE).volatile(), // enum 不可用：见 resolveScene
  axesDebug: z.boolean().default(false).volatile(), // 调试：开了在日志里打本次 top5 的三轴分解。默认关。

  // 说话人：写入时给每条记忆带上「谁说的」（只存 openid 前 8 位）。默认开；关掉就永远写空串。
  speakerEnabled: z.boolean().default(true).volatile(),
  speakerGroupDb: z.string().default(''), // 群档路径（对齐用的只读库），留空用 ~/.dsh/integrations/dsh-im/group-history.sqlite

  // 取舍层影子模式：默认 true —— 只往 `admit` 记一行账（applied=0），入库行为一个字不改。
  // 关掉才真的按判据拦写入（applied=1，判成 drop 的那一轮不落库）。
  admitShadow: z.boolean().default(true).volatile(),

  // 情绪：每轮结束判一次**我自己的话**，写进 `mood_log`；渲染时最多说一句。关掉整轮跳过。
  moodEnabled: z.boolean().default(MOOD_ENABLED).volatile(),
  moodHalfLifeHours: z.natural().min(1).max(168).default(MOOD_HALF_HOURS).volatile(),
  // 注入四道闸里的三道（第四道是幂等）：日上限 / 幅度 / 冷却。
  moodInjectDailyMax: z.natural().min(0).max(50).default(MOOD_INJECT_DAILY_MAX).volatile(),
  moodInjectMinDelta: z.number().min(0).max(100).default(MOOD_INJECT_MIN_DELTA).volatile(),
  moodInjectCooldownHours: z.number().min(0).max(168).default(MOOD_INJECT_COOLDOWN_HOURS).volatile(),
  // 聊天常驻行「现在的心情」（order 935）：每轮一行、只读，不占 `moodInjectDailyMax` 配额。默认开。
  moodChatLine: z.boolean().default(MOOD_CHAT_LINE).volatile(),

  // 冷热分层：热区留多少条、多重才抬进来、深一层扣多少分。热改，下一轮就生效。
  hotZoneMax: z.natural().min(1).max(200).default(HOT_ZONE_MAX).volatile(),
  hotPromoteWeight: z.natural().min(0).max(20).default(HOT_PROMOTE_WEIGHT).volatile(),
  tierPenalty: z.number().min(0).max(1).default(TIER_PENALTY).volatile(),

  // 定时梳理（每 6 小时）。默认关：它会合并、删除条目，不可逆。打开后重启插件才注册定时器；
  // 手动触发不受这一项限制，但动手之前都会先强制备份一份。
  autoConsolidate: z.boolean().default(false).volatile(),

  /** 记忆备份：坏了就全没了，所以定期做，并且当场校验。 */
  backup: z.object({
    enabled: z.boolean().default(true).volatile(), // 每 6 小时检查一次，当天没有就备一份
    keep: z.natural().min(1).max(365).default(BACKUP_KEEP).volatile(), // 保留几份
    dir: z.string().default(''), // 放哪儿，留空用 <记忆库>/backups。改了要重启
  }).default({}),

  /** 日记：到点自己写一笔，不管有没有人找。 */
  diary: z.object({
    hour: z.natural().min(0).max(23).default(DIARY_HOUR).volatile(), // 每天到这个点之后，当天还没写就补一篇
    enabled: z.boolean().default(true).volatile(), // 到点自动写；关掉只能手动补
  }).default({}),

  /** 压缩存档：把「压缩摘要 + 被压掉的聊天」落成 Markdown，并私发主人。 */
  archive: z.object({
    enabled: z.boolean().default(true).volatile(), // 压缩时写一份完整存档到磁盘
    notify: z.boolean().default(true).volatile(), // 顺手私发主人一份
    dir: z.string().default(''), // 存档目录，留空用 <记忆库>/archives。改了要重启
    botId: z.string().default('').volatile(), // 私发用的机器人，留空自动找
    targetId: z.string().default('').volatile(), // 私发的目标，留空自动找第一个单聊
  }).default({}),

  /** 夜班：一天一次结账，蒸出桌面页。 */
  night: z.object({
    enabled: z.boolean().default(true).volatile(), // 到点自动跑；关掉只能手动触发
    hour: z.natural().min(0).max(23).default(NIGHT_HOUR).volatile(), // 几点开（本地时间）
    minute: z.natural().min(0).max(59).default(NIGHT_MINUTE).volatile(), // 几分开
  }).default({}),

  /**
   * 第二层自动落盘：群聊按天落成「全量-YYYY-MM-DD.md」。
   * `scripts/dump-group.mjs` 读这一份（与 weekly 共用 lib/dump-config.mjs），设置页改了下一轮脚本就按新的跑。
   */
  groupDump: z.object({
    enabled: z.boolean().default(LAYER_DEFAULTS.groupDump.enabled).volatile(), // 关掉就只打印一行「已关闭」
    // 定时器每几分钟跑一次（渲染 systemd timer 用；插件自己不读，下一轮脚本才生效）。
    intervalMinutes: z.natural().min(1).max(1440).default(LAYER_DEFAULTS.groupDump.intervalMinutes).volatile(),
    dir: z.string().default(LAYER_DEFAULTS.groupDump.dir).volatile(), // 导出目录，默认 ~/.dsh/miyu/logs
  }).default({}),

  /**
   * 自唤醒（systemd 那条线）：这几项只写镜像文件 `~/.dsh/miyu/wake/config.json`，
   * 由 `scripts/wake-run.sh` 每半小时读一次；插件自己不跑定时器。
   */
  wakeSelf: z.object({
    enabled: z.boolean().default(true).volatile(), // 关掉就一次都不叫醒
    quietFromMinute: z.natural().min(0).max(1440).default(0).volatile(), // 静默从几点开始（整点，跨午夜也认）
    quietToMinute: z.natural().min(0).max(1440).default(540).volatile(), // 到几点结束
    cooldownMinutes: z.natural().min(0).max(1440).default(90).volatile(), // 两次之间至少隔多少分钟
    dailyQuota: z.natural().min(0).max(50).default(3).volatile(), // 一天最多真开口几次
    hitRate: z.natural().min(1).max(100).default(40).volatile(), // 掷骰命中率（1–100）
    target: z.string().default('tgt_bca96e94052d7c32').volatile(), // 发到哪：私聊或群
  }).default({}),

  /**
   * 眼睛（摄像头）：look / see 两个工具的参数。键加 `eye` 前缀，免得和现有的 mood / card 那批键撞车。
   * 2026-11-08 从独立插件 dsh-eye 并进来，默认值与那边一致。
   */
  eyeDevice: z.string().default('/dev/video0'), // 摄像头设备号
  eyeSize: z.string().default('640x480').volatile(), // 抓帧分辨率
  eyeWarmupMs: z.natural().min(0).max(2000).default(120).volatile(), // 开机丢帧：头几帧常全黑或全绿
  eyeLockWaitMs: z.natural().min(0).max(60000).default(8000).volatile(), // 等别人放锁最多多久
  eyeTimeoutMs: z.natural().min(500).max(60000).default(12000).volatile(), // 单次抓帧超时
  eyeKeep: z.natural().min(1).max(500).default(20).volatile(), // 保留最近几张，多了自动删
  eyeSee: z.boolean().default(true).volatile(), // 关掉就只留 look
  eyeSeeMaxTokens: z.natural().min(32).max(4000).default(300).volatile(), // see 回答的字数上限
  eyePromptHint: z.boolean().default(true).volatile(), // 启动时在提示词里加一句「你可以看」

  /**
   * 定时叫醒：drop_by_at + 定时器。键加 `wake` 前缀（另有 wakeSelf 那组是 systemd 那条线，别混）。
   * 2026-11-08 从独立插件 dsh-drop-by 并进来，默认值与那边一致。
   */
  wakeEnabled: z.boolean().default(true).volatile(), // 总开关：关掉就只剩工具，不会有人来叫
  wakeIntervalMinutes: z.natural().min(1).max(240).default(20), // 多久看一次表（改了要重载插件）
  wakeIdleMinutes: z.natural().min(1).max(1440).default(45).volatile(), // 安静多久才考虑叫醒
  wakeMinGapMinutes: z.natural().min(1).max(1440).default(45).volatile(), // 两次叫醒之间最少隔多久
  wakeMaxPerHour: z.natural().min(1).max(60).default(6).volatile(), // 一小时次数上限，超了停到下一整点
  wakeQuietFrom: z.natural().min(0).max(24).default(2).volatile(), // 安静时段开始（只挡自动醒，不挡预约）
  wakeQuietTo: z.natural().min(0).max(24).default(8).volatile(), // 安静时段结束；和开始相同就关掉这段
  wakeAppointmentMinMinutes: z.natural().min(1).max(1440).default(5).volatile(), // 预约最早几分钟后
  wakeAppointmentMaxMinutes: z.natural().min(1).max(1440).default(240).volatile(), // 预约最晚几分钟后
  wakePromptHint: z.boolean().default(true).volatile(), // 启动时在提示词里加一句「你可以排个点」
  wakeStateFile: z.string().default('').volatile(), // 状态文件，留空=跟着记忆库走（<记忆库>/wake/state.json）

  /** 第三层周记：只统计，不调模型。 */
  weekly: z.object({
    enabled: z.boolean().default(LAYER_DEFAULTS.weekly.enabled).volatile(), // 关掉就打印一行「已关闭」
    startDay: z.natural().min(1).max(7).default(LAYER_DEFAULTS.weekly.startDay).volatile(), // 一周从周几算：1=周一 … 7=周日
  }).default({}),
})
