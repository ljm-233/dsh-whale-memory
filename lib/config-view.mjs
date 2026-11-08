/**
 * 配置读法：所有「设一次、用时现读」的取值函数都收在这里。
 *
 * 整块从 index.mjs 原样搬出来，只把外层包成 createConfigView()。
 * 声明了 `.volatile()` 的字段是活引用，每次都要 `.get()` 才拿到当前值——
 * 所以这里全是函数，不是常量。
 */
import { join, isAbsolute, resolve } from 'node:path'

import {
  DEFAULT_MEMORY_DIR, DB_FILE,
  MEMORY_BUDGET_CHARS, RECENT_PAIRS, RECALL_MAX, RECALL_THRESHOLD, WEIGHT_MAX, TIER_PENALTY,
  FACT_MAX, CARD_DAILY_MAX, CARD_MIN_CONFIDENCE, SCORE_MODE, RECALL_SCENE, AXES_THRESHOLD,
  MOOD_INJECT_COOLDOWN_HOURS, MOOD_INJECT_DAILY_MAX, MOOD_INJECT_MIN_DELTA, MOOD_UNWILLING_FILE,
  DIARY_HOUR, NIGHT_HOUR, NIGHT_MINUTE,
} from './constants.mjs'
import { dayKeyOf as sharedDayKey } from './shared.mjs'
import { SCENE, SCENE_NAMES, resolveScene } from './axes.mjs'
import { GROUP_DB } from './domain/speaker.mjs'
import { MOOD_CHAT_LINE, MOOD_ENABLED, MOOD_HALF_HOURS } from './domain/mood.mjs'

/**
 * @param {object} deps 依赖
 * @param {object} deps.config 插件配置
 * @returns {object} 全部取值函数 + 记忆库位置
 */
export function createConfigView({ config }) {
  // 记忆库位置：绝对路径直接用，相对路径相对默认库。
  const memoryDir = (() => {
    const raw = String(config.memoryPath ?? '').trim()
    if (raw === '') return DEFAULT_MEMORY_DIR
    return isAbsolute(raw) ? raw : resolve(DEFAULT_MEMORY_DIR, raw)
  })()
  const dbPath = join(memoryDir, DB_FILE)

  /** 读一项配置：声明了 .volatile() 的字段是活引用，每次都要 .get() 才拿到当前值。 */
  const cfgVal = (v, fallback) => (v && typeof v.get === 'function' ? (v.get() ?? fallback) : (v ?? fallback))

  // 可热改的参数：每次用时现读，设置页改完立刻生效，不用重启。
  const budgetChars = () => cfgVal(config.budgetChars, MEMORY_BUDGET_CHARS)
  const recentPairs = () => cfgVal(config.recentPairs, RECENT_PAIRS)
  const recallMax = () => cfgVal(config.recallMax, RECALL_MAX)
  const recallThreshold = () => cfgVal(config.recallThreshold, RECALL_THRESHOLD)
  const weightMax = () => cfgVal(config.weightMax, WEIGHT_MAX)
  const tierPenalty = () => cfgVal(config.tierPenalty, TIER_PENALTY)
  const factMax = () => cfgVal(config.factMax, FACT_MAX)
  const cardDailyMax = () => cfgVal(config.cardDailyMax, CARD_DAILY_MAX)
  const cardMinConfidence = () => cfgVal(config.cardMinConfidence, CARD_MIN_CONFIDENCE)
  // 三维打分：公式（axes/legacy）、场景（recall/lookup-old/daily/auto）、调试开关。
  // 环境变量 WHALE_SCORE_MODE=legacy 是 A/B 的一键回退，比改设置快。
  const scoreMode = () => (String(process.env.WHALE_SCORE_MODE ?? cfgVal(config.scoreMode, SCORE_MODE)).trim().toLowerCase() === 'legacy' ? 'legacy' : 'axes')
  const recallScene = () => {
    const raw = String(cfgVal(config.recallScene, RECALL_SCENE) ?? '').trim()
    return raw === '' ? RECALL_SCENE : raw
  }
  const axesDebug = () => cfgVal(config.axesDebug, false) === true
  /**
   * 当前生效的打分设置：给 `/status` 看，也给我自己判断「它是不是在乱排」。
   * 只报事实（当前配置 + 三套权重），不预演任何一次具体排序。
   */
  const axesInfo = () => {
    const mode = scoreMode()
    const configured = recallScene()
    // auto 没有具体场景可报，报它「会落到哪」——这是规则算出来的，不是猜的。
    const scene = resolveScene(configured, '')
    return {
      mode,
      scene,
      sceneConfigured: configured,
      debug: axesDebug(),
      threshold: mode === 'legacy'
        ? Number(recallThreshold()) || Number(RECALL_THRESHOLD)
        : Number(AXES_THRESHOLD[scene] ?? AXES_THRESHOLD.recall),
      scenes: Object.fromEntries(SCENE_NAMES.map((name) => [name, {
        w: { ...SCENE[name].w }, halfLifeDays: SCENE[name].halfLifeDays, threshold: AXES_THRESHOLD[name] ?? null,
      }])),
      envOverride: String(process.env.WHALE_SCORE_MODE ?? '') !== '',
    }
  }
  const activeSpace = () => String(cfgVal(config.space, 'default') ?? 'default').trim() || 'default'
  // 定时梳理默认关：它删条目、不可逆，不能自己跑起来。只有显式 true 才注册定时器。
  const autoConsolidate = () => cfgVal(config.autoConsolidate, false) === true

  // 情绪记账：默认开，关掉就整轮跳过（一行都不写）。两项默认值只在 lib/mood.mjs 写一份。
  const moodEnabled = () => cfgVal(config.moodEnabled, MOOD_ENABLED) !== false
  const moodHalfLifeMin = () => Math.min(168, Math.max(1, Number(cfgVal(config.moodHalfLifeHours, MOOD_HALF_HOURS)) || MOOD_HALF_HOURS)) * 60
  // 情绪注入的三道量（第四道是幂等）。默认值只在 lib/constants.mjs 写一份，设置页不写 fallback。
  const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  const moodInjectDailyMax = () => Math.max(0, Math.min(50, Math.round(numOr(cfgVal(config.moodInjectDailyMax, MOOD_INJECT_DAILY_MAX), MOOD_INJECT_DAILY_MAX))))
  const moodInjectMinDelta = () => Math.max(0, Math.min(100, numOr(cfgVal(config.moodInjectMinDelta, MOOD_INJECT_MIN_DELTA), MOOD_INJECT_MIN_DELTA)))
  const moodInjectCooldownHours = () => Math.max(0, Math.min(168, numOr(cfgVal(config.moodInjectCooldownHours, MOOD_INJECT_COOLDOWN_HOURS), MOOD_INJECT_COOLDOWN_HOURS)))
  /** 聊天常驻行：默认开。关掉就回到「只有四道闸放行才出现一行」的老样子。 */
  const moodChatLine = () => cfgVal(config.moodChatLine, MOOD_CHAT_LINE) !== false
  /** 「我不想做」那本账：和 LEDGER.md 并排，放在记忆库目录里。 */
  const unwillingFile = () => join(memoryDir, MOOD_UNWILLING_FILE)

  // 说话人（谁说的）：默认开。关掉就永远写空串，写入行为回到 0.28.17；
  // 空串在查询侧永远表示「不知道谁说的」，仍然能按内容查到。
  const speakerEnabled = () => cfgVal(config.speakerEnabled, true) !== false
  const speakerGroupDb = () => String(cfgVal(config.speakerGroupDb, '') ?? '').trim() || GROUP_DB

  /**
   * 取舍层：默认影子（true）——只写 `admit` 一行账，入库行为一个字不改。
   * 关掉才真的按 `drop` 拦写入（`applied=1`）；退出条件写在 `docs/brain-plan.md` 的实现状态里。
   */
  const admitShadowOn = () => cfgVal(config.admitShadow, true) !== false

  // 压缩存档：把「压缩摘要 + 被压缩掉的聊天记录」汇成一份 Markdown 落盘，并私发主人。
  /** 本地日期键：给 backup 模块用。 */
  const dayOf = sharedDayKey
  const backupCfg = () => (config.backup && typeof config.backup === 'object' ? config.backup : {})

  const diaryCfg = () => (config.diary && typeof config.diary === 'object' ? config.diary : {})
  const diaryEnabled = () => cfgVal(diaryCfg().enabled, true) !== false
  const diaryHour = () => Math.min(23, Math.max(0, cfgVal(diaryCfg().hour, DIARY_HOUR)))

  const archiveCfg = () => (config.archive && typeof config.archive === 'object' ? config.archive : {})
  const archiveEnabled = () => cfgVal(archiveCfg().enabled, true) !== false
  const archiveDir = () => {
    const raw = String(cfgVal(archiveCfg().dir, '') ?? '').trim()
    if (raw === '') return join(memoryDir, 'archives')
    return isAbsolute(raw) ? raw : resolve(memoryDir, raw)
  }
  const archiveNotify = () => ({
    enabled: cfgVal(archiveCfg().notify, true) !== false,
    botId: String(cfgVal(archiveCfg().botId, '') ?? '').trim(),
    targetId: String(cfgVal(archiveCfg().targetId, '') ?? '').trim(),
  })

  // 夜班：过 22:05 还没跑就跑，一天只跑一次；错过了也补。
  const nightCfg = () => (config.night && typeof config.night === 'object' ? config.night : {})
  const nightEnabled = () => cfgVal(nightCfg().enabled, true) !== false
  const nightHour = () => Math.min(23, Math.max(0, cfgVal(nightCfg().hour, NIGHT_HOUR)))
  const nightMinute = () => Math.min(59, Math.max(0, cfgVal(nightCfg().minute, NIGHT_MINUTE)))

  return {
    memoryDir, dbPath,
    cfgVal,
    budgetChars,
    recentPairs,
    recallMax,
    recallThreshold,
    weightMax,
    tierPenalty,
    factMax,
    cardDailyMax,
    cardMinConfidence,
    scoreMode,
    recallScene,
    axesDebug,
    axesInfo,
    activeSpace,
    autoConsolidate,
    moodEnabled,
    moodHalfLifeMin,
    numOr,
    moodInjectDailyMax,
    moodInjectMinDelta,
    moodInjectCooldownHours,
    moodChatLine,
    unwillingFile,
    speakerEnabled,
    speakerGroupDb,
    admitShadowOn,
    dayOf,
    backupCfg,
    diaryCfg,
    diaryEnabled,
    diaryHour,
    archiveCfg,
    archiveEnabled,
    archiveDir,
    archiveNotify,
    nightCfg, nightEnabled, nightHour, nightMinute,
  }
}
