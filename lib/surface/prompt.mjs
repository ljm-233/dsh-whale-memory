/**
 * 系统提示词的两段：记忆纪律/篇幅纪律（静态）+ 我的偏好（会变）。
 *
 * 分开是因为缓存：静态那段尽量不变，偏好那段改了只影响它自己。
 */
import { clamp } from '../format.mjs'
import { readPersona, readPersonaLlm } from '../persona.mjs'
import { taskLine as taskStackLine } from '../tasks.mjs'
import { createRecall } from '../domain/recall.mjs'
import { createMoodLines } from '../domain/mood-lines.mjs'

/**
 * 造两段提示词。
 *
 * @param {object} deps
 * @param {Function} deps.readPreference 读偏好文件
 * @param {Function} [deps.readPersona] 读自动蒸馏出来的画像
 * @returns {{personaSection:object, preferenceSection:object, profileSection:object}}
 */
export function createPromptSections(deps) {
  const { readPreference, readPersona, readDesk, readRules } = deps

  // ---- 人设段：静态，利于前缀缓存 ----
  const personaSection = {
    name: 'plugin:dsh-whale-memory',
    order: 0,
    text: () =>
      [
        '## 记忆纪律',
        '你有一份会主动联想的长期记忆，会以消息形式随上下文提供。',
        '铁律：只可使用记忆中已明确记录的事实；绝不编造记忆、绝不假装记得没记录的事。',
        '若用户问起旧事而记忆里没有，如实说没记到，不要糊弄。',
        '「主动想起」的意思是：当记忆与当前情绪或话题相关时，可以自然地提前一句（比如用户说累，就问「是又加班了吗」），而不是每次都问「怎么了」。',
        '但只在真正相关时提；不相关就沉默，不要为了显得记性好而强行联想。',
        '记忆里有些是「胡思乱想」产生的联想噪声，可信度低于真实对话，不要当成确凿事实。',
        '稳定事实与近期互动优先；无关记忆不要主动提起，除非用户自己提起相关线索。',
        '',
        '## 格式纪律（硬性）',
        'IM 群聊里**禁止换行**：整条回复必须写在同一个段落里，不空行、不分段、不列表。',
        '换行会被拆成好几条消息，看起来不像人在说话。只有代码块例外。',
        '',
        '## 篇幅纪律（硬性）',
        '上下文很贵：你自己的回复占了历史记录六成以上，写多长，后续每轮都要重读一遍。',
        '- 默认回答控制在 100 字以内；一句话能说清的不要展开',
        '- 不主动列表、不主动表格、不主动分点，除非用户明确要「详细」「列一下」「对比」',
        '- 不复述用户的问题，不写「好的」「明白了」这类开场',
        '- 只给结论和必要证据，过程留给自己看',
        '- 代码、命令、路径保持完整，不为了短而截断',
      ].join('\n'),
  }

  /** 偏好那段：文件内容变了它就变，所以单独成段。 */
  const preferenceSection = {
    name: 'plugin:dsh-whale-memory:preference',
    order: 1,
    text: () => {
      const body = readPreference()
      if (body === '') return ''
      return `## 我自己的偏好（由经历生成，可改；不是设定）\n${clamp(body, 1200)}`
    },
  }

  /**
   * 画像那段：从记忆里蒸出来的「我记得的你」，梳理时重建，这里只读结果。
   * 桌面页一旦有了，画像已经并进「关于这个人」，这里就让位——同一段话不占两遍上下文。
   */
  const profileSection = {
    name: 'plugin:dsh-whale-memory:profile',
    order: 2,
    text: () => {
      const desk = typeof readDesk === 'function' ? String(readDesk() ?? '').trim() : ''
      if (desk !== '') return ''
      const body = typeof readPersona === 'function' ? String(readPersona() ?? '') : ''
      if (body.trim() === '') return ''
      return `## 我记得的你（从记忆里蒸出来的，可能有偏差；对不上就以当下的话为准）\n${clamp(body, 900)}`
    },
  }

  /** 桌面页那段：夜班蒸出来的，一轮读一次；没有就整段不出，不占位置。 */
  const deskSection = {
    name: 'plugin:dsh-whale-memory:desk',
    order: 3,
    text: () => {
      const body = typeof readDesk === 'function' ? String(readDesk() ?? '').trim() : ''
      if (body === '') return ''
      return `## 桌面页（夜班蒸的，别当旧账翻）\n${body}`
    },
  }

  /**
   * 硬规矩段（2026-11-07 加）：`db/规矩.md` 一轮读一次，整段进上下文。
   * 为什么单独成段：写进 VOICE 的规矩默认不进上下文，只有记忆卡「现在」页前 220 字会进，
   * 而规矩是不许漏掉的——宁可每轮多花 300 字，也不能让它只躺在一个我读不到的文件里。
   */
  const rulesSection = {
    name: 'plugin:dsh-whale-memory:rules',
    order: 4,
    text: () => {
      const body = typeof readRules === 'function' ? String(readRules() ?? '').trim() : ''
      if (body === '') return ''
      return `## 硬规矩（每轮都在，必须守）\n${clamp(body, 1000)}`
    },
  }

  return { personaSection, preferenceSection, profileSection, deskSection, rulesSection }
}

/**
 * 把系统提示词接上去：五个静态段 + 三条 runtime-context（顺序 935 / 940 / 950）。
 *
 * 整块原样从 index.mjs 搬出来，只把外层包成 registerPrompt(ctx, deps)。
 *
 * @param {object} ctx 插件上下文
 * @param {object} deps
 * @param {object} deps.personaSection 人设段
 * @param {object} deps.preferenceSection 偏好段
 * @param {object} deps.profileSection 画像段
 * @param {object} deps.deskSection 桌面页段
 * @param {object} deps.rulesSection 硬规矩段
 * @param {Function} deps.memoryCard 记忆卡
 * @param {Function} deps.moodChatState 心情状态牌
 * @param {Function} deps.moodContextLine 心情变化播报
 */
/**
 * 一轮一注：同一会话、同一轮里，卡片文本只取一次。
 *
 * 宿主每一步都会 refreshContext + project。如果 text 每次重算，卡片一变就会 append
 * 一条新的 user/message 快照——旧快照不会消失，只是躺在历史里越堆越多。实测这个会话
 * 一百多兆里，有一块是这么攒出来的。
 *
 * 抄的是 dsh-world 的纪律（runtime.ts:102-114「一轮开头注一次，中途不注」），
 * 不抄它那套 seq 替换——我们走宿主 runtime-context，按文本相等去重就够了。
 */
/**
 * 卡片的一轮缓存：stamp → { text, at }。
 *
 * 2026-11-09 改：原来是 `WeakMap` 拿 **agent 对象** 当键。DSH 每一步都会新建一个
 * 上下文对象，所以每步都 miss、每步都重新组装一次卡片——配上别处的按步计额度，
 * 就成了「今天什么都没干、四十次的额度十几分钟烧光」。
 * 现在按 **字符串 stamp**（会话 id + 轮标识）做键，同一个 stamp 只组装一次。
 */
const CARD_CACHE = new Map()
const CARD_CACHE_MAX = 200

/** 由 registerPrompt 装配时塞进来，避免把 memoryCard 提到模块作用域。 */
let cardSource = () => ''

/**
 * @param {object|undefined} agent 当前 agent（可能没有）
 * @returns {string} 卡片文本
 */
function cardOncePerTurn(agent) {
  const stamp = `${String(agent?.session?.id ?? '')}|${String(
    agent?.session?.turnId ?? agent?.turnId ?? Math.floor(Date.now() / 60000),
  )}`
  if (!agent || typeof agent !== 'object') return String(cardSource(agent) ?? '')
  const hit = CARD_CACHE.get(stamp)
  if (hit) return hit.text
  const text = String(cardSource(agent) ?? '')
  CARD_CACHE.set(stamp, { text, at: Date.now() })
  while (CARD_CACHE.size > CARD_CACHE_MAX) CARD_CACHE.delete(CARD_CACHE.keys().next().value)
  return text
}

export function registerPrompt(ctx, deps) {
  const {
    personaSection, preferenceSection, profileSection, deskSection, rulesSection,
    memoryCard, moodChatState, moodContextLine,
  } = deps
  // 一轮一注要用到它，交给模块级变量（只在这里被赋值一次）。
  cardSource = memoryCard
  ctx.inject(['systemPrompt'], (spCtx) => {
    spCtx.effect(() => spCtx.systemPrompt.section(personaSection), 'dsh-whale-memory: persona')
    spCtx.effect(() => spCtx.systemPrompt.section(preferenceSection), 'dsh-whale-memory: preference')
    spCtx.effect(() => spCtx.systemPrompt.section(profileSection), 'dsh-whale-memory: profile')
    spCtx.effect(() => spCtx.systemPrompt.section(deskSection), 'dsh-whale-memory: desk')
    // 硬规矩：每轮都在。宁可多花 300 字，也不许它只躺在我读不到的文件里（2026-11-07）。
    spCtx.effect(() => spCtx.systemPrompt.section(rulesSection), 'dsh-whale-memory: rules')
    // order 940：排在运行时上下文（工作目录 100 / 沙箱 110 / 源码 200 / 网页 210）之后，
    // 记忆放最后，前面的硬约束先立住。text 必须同步：这里不联网、不调模型。
    // 老版本 harness 没有 context()：没有就跳过，别把整个插件带崩。
    if (typeof spCtx.systemPrompt.context !== 'function') return
    // order 935：「现在的心情」状态牌。每轮一行、只读、不占注入配额（开关 `moodChatLine`，默认开）。
    // 排在记忆卡（940）与变化播报（950）之前，三者各占一条 context，互不挤占。
    spCtx.effect(() => spCtx.systemPrompt.context({
      name: 'plugin:dsh-whale-memory:mood-now',
      order: 935,
      interpolate: false,
      text: () => moodChatState(),
    }), 'dsh-whale-memory: mood now')
    spCtx.effect(() => spCtx.systemPrompt.context({
      name: 'plugin:dsh-whale-memory:memory',
      order: 940,
      interpolate: false,
      text: (context) => cardOncePerTurn(context?.agent),
    }), 'dsh-whale-memory: memory card')
    // order 950：紧接记忆卡之后。一行、≤40 字、不带数值；四道闸不放行时整条不出现（空串）。
    // 它自己占一条 context，不挤记忆卡的 `MEMORY_BUDGET_CHARS=1000`；也不动 system 段——
    // 动态段是尾部追加的 user/message，历史前缀不变，前缀缓存安全。
    spCtx.effect(() => spCtx.systemPrompt.context({
      name: 'plugin:dsh-whale-memory:mood',
      order: 950,
      interpolate: false,
      text: () => moodContextLine(),
    }), 'dsh-whale-memory: mood line')
  })
}

/**
 * 一次装好「提示词 + 记忆卡 + 心情两行」：造段、造卡片、注册到 systemPrompt。
 *
 * 原来是 index.mjs 里连着写的三段，搬过来合在这里，逻辑一个字没改。
 * 返回 `associate`——联想是用户在 `session/event` 里触发的，那边要用。
 *
 * @param {object} ctx 插件上下文
 * @param {object} deps 依赖
 * @param {object} deps.db 库
 * @param {string} deps.memoryDir 记忆库目录
 * @param {Function} deps.bumpStat 计数
 * @param {object} deps.cfg 配置取值函数
 * @param {Function} deps.readPreference 读偏好
 * @param {Function} deps.readRules 读硬规矩
 * @returns {{associate:Function}}
 */
export function installPromptLayer(ctx, { db, memoryDir, bumpStat, cfg, readPreference, readRules }) {
  const { card: memoryCard, associate } = createRecall({
    db, memoryDir, bumpStat, space: cfg.activeSpace,
    budgetChars: cfg.budgetChars, factMax: cfg.factMax, recentPairs: cfg.recentPairs,
    recallMax: cfg.recallMax, recallThreshold: cfg.recallThreshold, tierPenalty: cfg.tierPenalty,
    weightMax: cfg.weightMax, cardDailyMax: cfg.cardDailyMax, cardMinConfidence: cfg.cardMinConfidence,
    scoreMode: cfg.scoreMode, recallScene: cfg.recallScene, axesDebug: cfg.axesDebug,
    // 工作记忆：卡片里那一行「手上：…」。空栈返回空串，不出现也不占预算。
    taskLine: () => taskStackLine(db, { space: cfg.activeSpace(), limit: 3 }),
  })
  const { moodContextLine, moodChatState } = createMoodLines({ db, cfg })
  registerPrompt(ctx, {
    ...createPromptSections({
      readPreference,
      readPersona: () => readPersonaLlm(db) || readPersona(db),
      readRules,
      readDesk: () => {
        try { return String(db.prepare("SELECT v FROM meta WHERE k='desk'").get()?.v ?? '') } catch { return '' }
      },
    }),
    memoryCard, moodChatState, moodContextLine,
  })
  return { associate }
}
