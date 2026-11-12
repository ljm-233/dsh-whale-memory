/**
 * 记忆卡的组装与三道闸：指纹幂等 / 日上限 / 置信门槛。
 *
 * 取不到任何东西就返回空串——空串在 runtime-context 里等于不存在，比抛错安全。
 * 闸门顺序不能换：指纹幂等在最前，日上限在置信之前。
 *
 * @module recall-card
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CARD_DAILY_MAX, CARD_MIN_CONFIDENCE, CARD_MIN_GAP_MS, DIARY_INJECT_MAX, RECALL_THRESHOLD, WEIGHT_MAX,
} from '../constants.mjs'
import { clamp } from '../format.mjs'
import { dayKeyOf, numCfg } from '../shared.mjs'
import { handoverNudge } from '../handover.mjs'
import { listFacts } from '../core/facts.mjs'
import { isPrivateSession } from '../session.mjs'
import { warmEntries } from '../surface/tools.mjs'
import { createCardSources } from './recall-assoc.mjs'
import { createScorer } from './recall-score.mjs'

/** 指纹缓存最多记几份卡；超了丢最老的。 */
const CARD_FP_MAX = 16
/** 指纹多久失效：同一份卡在这个窗口里重复组装都当同一次注入。 */
const CARD_FP_TTL_MS = 10 * 60 * 1000

/**
 * 造记忆卡。
 *
 * @param {object} deps 依赖
 * @returns {{card:Function, associate:Function}}
 */
export function createRecall(deps) {
  const {
    db, memoryDir, bumpStat, space, budgetChars, factMax, recentPairs,
    recallMax, recallThreshold, tierPenalty, weightMax,
    cardDailyMax, cardMinConfidence, cardMinGapMs,
    scoreMode, recallScene, axesDebug,
    // 工作记忆：卡片底部那一行「手上：…」。空栈返回空串，整行不出现。
    taskLine = () => '',
  } = deps

  // 打分层：候选池选完之后按三轴（或 legacy）合成一个分。
  const scorer = createScorer({ scoreMode, recallScene, recallThreshold, tierPenalty, axesDebug })
  // 素材层：联想段（异步算、按 session 缓存）+ 声音/现在/索引/交接条（同步读）。
  const { associate, assocStateOf, readVoice, readNow, readIndexPointer, readHandover } = createCardSources({
    db, memoryDir, space, recentPairs, recallMax, scorer,
  })

  /**
   * 上一次真交出去的卡：门槛或日上限把这次拦下来时沿用它。
   * 「跳过」只表示这一轮不带新东西，不该让记忆凭空消失。
   */
  let lastCard = ''

  /**
   * 指纹 → { text, at }：同一份卡不重复算、更不重复计命中。
   *
   * 键 = 注入内容 hash + 本次命中条目 id 集合 + 空间，见 fpOf()。
   * 只活在进程内：一轮 N 步里 text() 被调 N 次，N-1 次都走这里返回；
   * 上限和 TTL 只是别让一张 Map 长成泄漏，不落盘。
   */
  const CARD_FP = new Map()

  /**
   * 卡片注入的账：一条 JSON 存在 meta 里，跟着库走，不另开文件。
   *
   * 字段：`day` 本地日期、`count` 今天真注入几次、`lastAt` 上次注入时间、
   * `lastFp` 上次指纹、`lastText`（跨进程幂等用；被拦下时**不再**沿用它）、`lastSkip`（上次为什么被拦下）。
   */
  const INJECT_KEY = 'cardInject'
  const readInject = () => {
    try {
      const raw = String(db.prepare('SELECT v FROM meta WHERE k = ?').get(INJECT_KEY)?.v ?? '')
      const v = JSON.parse(raw)
      return v && typeof v === 'object' ? v : {}
    } catch { return {} }
  }
  const writeInject = (state) => {
    try {
      db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(INJECT_KEY, JSON.stringify(state))
    } catch { /* 记不上不影响注入 */ }
  }

  /**
   * 卡片指纹：注入内容 hash + 本次命中的条目 id 集合 + 空间。
   *
   * FNV-1a 32 位，零依赖；用途只是「这一步和上一步是不是同一份卡」，不用抗碰撞。
   */
  /**
   * 把卡片里那几行「每步都变」的内容抹成占位符，剩下的才是稳定内容。
   * 只影响指纹，不影响注入出去的文本。
   */
  const stableText = (t) => String(t)
    .replace(/距上次开口[：:][^\n]*/gu, '距上次开口：—')
    .replace(/最后更新[：:][^\n]*/gu, '最后更新：—')
    .replace(/中间断了一段[^\n]*/gu, '')
    .replace(/今天[：:][^\n]*/gu, '今天：—')

  const fpOf = (text, ids, spaceOf) => {
    let h = 0x811c9dc5
    const feed = (s) => {
      for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
      }
    }
    // 2026-11-09：喂 text 之前先把**每步都会变的那几行**抹掉。
    // 「距上次开口 N 小时」「最后更新：…（wake.mjs 自动重算）」这类东西每走一步都不一样，
    // 直接喂进去就是每步一个新指纹、每步算一次新注入，四十次的日配额十几分钟见底
    // （ljm 说的「卡片到上限了」）。剔掉它们之后：真内容变了才会重新生成。
    feed(stableText(text))
    feed('\u0000')
    feed([...ids].sort((a, b) => a - b).join(','))
    feed('\u0000')
    feed(spaceOf)
    return (h >>> 0).toString(16).padStart(8, '0')
  }

  /**
   * 本轮联想的置信度（0~1）。只用手里真有的三样，不另造打分：
   *   - 命中分数：最高分相对「门槛两倍」的占比（s 是 scoreMemory 算出来的原值）
   *   - 条目数：真进卡的几条 / 本轮允许想起几条（recallMax）
   *   - 热区：热区里的对话和这一句有没有真对上（overlap ≥ 0.2，同 tools.mjs 的比例判定）
   * 这一轮压根没有联想（没东西可想起）时不给 0：那不是「没底」，是不需要判断，给 1。
   */
  const confidenceOf = (st) => {
    const scores = st?.scores ?? []
    if (scores.length === 0) return 1
    // 用这一轮真用的那把尺子：三维模式按场景（0.45~0.60），legacy 才算 2.0。
    const threshold = Number(st?.threshold) || Number(recallThreshold?.() ?? RECALL_THRESHOLD) || RECALL_THRESHOLD
    const top = Math.max(...scores)
    const scorePart = Math.min(1, top / (threshold * 2))
    const countPart = Math.min(1, scores.length / Math.max(1, Number(st.limit) || 1))
    const hotPart = st.hotHit ? 1 : 0
    return Math.round((0.5 * scorePart + 0.3 * countPart + 0.2 * hotPart) * 1000) / 1000
  }

  /**
   * 组一段记忆卡文本。取不到任何东西就返回空串——空串在 runtime-context 里等于不存在，
   * 比抛错安全：宁可这一轮没有记忆，也不能把对话卡住。
   *
   * 交出去之前过三道闸，顺序不能换：
   *   1. 指纹幂等：同一份卡重复组装（一轮 N 步就是 N 次）原样返回，绝不再累加 hits / lastHit；
   *   2. 日上限：一天最多真注入 cardDailyMax 次，按本地日期算；
   *   3. 置信门槛：本轮联想拼出来的置信度低于 cardMinConfidence 就不刷新卡片。
   * 后两道拦下来时沿用上一次的卡："跳过"只表示这一轮不带新东西，不是把记忆抹掉。
   *
   * @param {object} [agent] 当前 agent（只为判断私聊，缺了也能跑）
   * @returns {string}
   */
  const card = (agent) => {
    try {
      const parts = []
      const budgetMax = budgetChars()
      let budget = budgetMax
      const push = (label, body) => {
        if (!body) return
        const block = `${label}\n${body}`
        if (block.length > budget) return
        parts.push(block)
        budget -= block.length
      }

      const idx = readIndexPointer()
      if (idx !== '') push('我的文件（想看细节就照名字去翻）：', idx)

      const now = readNow()
      if (now !== '') push('现在（群聊和私聊共用这一段）：', now)

      const voice = readVoice()
      if (voice !== '') push('声音（先读这个，再看记忆）：', voice)

      const handover = readHandover()
      if (handover !== '') {
        const nudge = handoverNudge(handover)
        push('交接条（重启后先看这个）：', handover + (nudge === '' ? '' : `\n（${nudge}）`))
      }

      // 最近的日记：给上下文一点「昨天我也在」的连续性
      try {
        const diaries = db.prepare('SELECT day, text FROM diary ORDER BY day DESC LIMIT ?')
          .all(DIARY_INJECT_MAX).reverse()
        if (diaries.length > 0) {
          push(
            '我最近写下的日记（我自己的记录，不是用户说的话）：',
            diaries.map((d) => `${d.day}：${clamp(d.text, 120)}`).join('\n'),
          )
        }
      } catch { /* 表还没建好就跳过 */ }

      const spaceOf = String(space?.() ?? 'default')

      try {
        // 只注仍然成立的：被改口的事实留在库里，但不该再当当下的事实说。
        const facts = listFacts(db, { space: spaceOf, limit: factMax() }).map((r) => r.f)
        if (facts.length > 0) push('已确认的关于用户的事实：', facts.map((f) => `- ${f}`).join('\n'))
      } catch { /* 同上 */ }

      // 联想段：这一句在说什么相关的旧事。异步算好放缓存，这里只同步读——
      // 不 await、不查向量、不打嵌入服务。没有当前轮的缓存就整段跳过。
      const sessionId = String(agent?.session?.id ?? '')
      const assoc = assocStateOf(sessionId)
      const related = assoc?.lines ?? ''
      if (related !== '') {
        // 最多占整卡 1/3：联想是甜点，不能把热区和事实挤掉。
        const room = Math.min(Math.floor(budgetMax / 3), budget - 60)
        if (room > 40) push('和这次有关、你可能想起来的（不一定用得上，别硬往上贴）：', clamp(related, room))
      }

      try {
        const recent = db.prepare('SELECT u,a FROM entries WHERE hot=1 AND space=? ORDER BY t DESC LIMIT ?')
          .all(spaceOf, recentPairs())
        if (recent.length > 0) {
          push('最近几轮的对话：',
            recent.reverse().map((r) => `用户: ${clamp(r.u, 160)} → 你: ${clamp(r.a, 160)}`).join('\n'))
        }
      } catch { /* 同上 */ }

      // 单向同步：私聊里补一份群聊摘要。群聊会话本身不注（否则重复）。
      if (isPrivateSession(String(agent?.session?.id ?? ''))) {
        try {
          const dg = JSON.parse(readFileSync(join(memoryDir, 'group-digest.json'), 'utf8'))
          // 摘要太旧（超过 12 小时）就不提了，免得说「刚才群里」其实是一天前
          if (Date.now() - (dg.generatedAt ?? 0) < 12 * 3600 * 1000 && Array.isArray(dg.lines) && dg.lines.length > 0) {
            push(
              `群里最近在聊（${dg.people?.length ?? 0} 人，仅供了解，不必主动接话）：`,
              dg.lines.slice(-5).join('\n'),
            )
          }
        } catch { /* 摘要读不了就跳过 */ }
      }

      if (parts.length === 0) return ''
      // 工作记忆那一行：栈顶最多三条未完成（doing 优先），空栈就不出现。
      // 它**在预算之外**——`budget` 已经扣完，这行不参与结算，也就不会挤掉事实/热区。
      let stack = ''
      try { stack = String(taskLine() ?? '').trim() } catch { stack = '' }
      const text = `（记忆参考——只可使用下列已发生的事实，严禁编造：\n\n${parts.join('\n\n')}${stack === '' ? '' : `\n\n${stack}`}）`

      // 本次真正命中的条目：进了卡的那几条联想（热区是"在"，不是"被想起"，不在这里）。
      const hitIds = new Set(assoc?.ids ?? [])
      const fp = fpOf(text, hitIds, spaceOf)
      const at = Date.now()

      /** 记进缓存并交出去：同一指纹在这一步之后的重复调用都走这里返回。 */
      const remember = (t) => {
        lastCard = t
        CARD_FP.set(fp, { text: t, at })
        while (CARD_FP.size > CARD_FP_MAX) CARD_FP.delete(CARD_FP.keys().next().value)
        return t
      }

      // ---- 闸 1：指纹幂等 ----
      const cached = CARD_FP.get(fp)
      if (cached && at - cached.at <= CARD_FP_TTL_MS) return remember(cached.text)
      if (cached) CARD_FP.delete(fp)

      // ---- 闸 2 / 3 要用的状态与信号 ----
      const today = dayKeyOf(new Date())
      const state = readInject()
      const count = state.day === today ? Number(state.count || 0) : 0
      const dailyMax = numCfg(cardDailyMax?.(), CARD_DAILY_MAX, 0, 500, true)
      const minConf = numCfg(cardMinConfidence?.(), CARD_MIN_CONFIDENCE, 0, 1)
      const conf = confidenceOf(assoc)

      /**
       * 被拦下来：**仍然交刚组装好的这一份**，只把"为什么没计额度"记进 meta 和日志。
       *
       * 2026-11-09 改：原来这里返回 `state.lastText`（上次那张卡），本意是省额度，
       * 实际上把「读文件」和「检索」一起冻住了——撞顶之后的每一轮都在读同一张旧卡，
       * 改任何文件都不反映，一整天越到后面越钝。额度该省的是检索，不是看文件。
       * 现在拦下来只表示「这次不记额度」，交出去的永远是刚算出来的 text。
       */
      const skip = (reason, extra) => {
        writeInject({
          ...state,
          day: today,
          count,
          lastCountAt: state.lastCountAt ?? 0,   // 保持不动：间隔按「上次真计数」算
          lastSkip: { at, reason, conf, threshold: minConf, max: dailyMax, ...extra },
        })
        console.log(`[whale-memory] 卡片不计额度（${reason}）：仍是新组装的 ${text.length} 字，confidence=${conf.toFixed(3)}`)
        return remember(text)
      }

      // 同一张卡跨进程幂等：重启 / 新会话首步不该各吃一次额度（今天 01:25 就烧光过 12 次）。
      if (state.day === today && state.lastFp === fp && typeof state.lastText === 'string' && state.lastText) {
        return remember(state.lastText)
      }
      // 2026-11-09：**配额要按「轮」算，不是按「步」算**。
      // DSH 每一步（每次工具调用）都会重建上下文、再问一次卡片；
      // 而每一步命中的记忆条目不一样 → 指纹不一样 → 各自算一次新注入。
      // 结果是我干活的一轮跑了四十多条命令，一天四十次的额度十分钟就烧完了，
      // 而 ljm 那边看到的是「今天什么都没干，卡片就满了」。
      // 加一个最小间隔：距上次真正计数不到 CARD_MIN_GAP_MS 的，照出卡片、只不计数。
      const gapMs = numCfg(cardMinGapMs?.(), CARD_MIN_GAP_MS, 0, 3600_000, true)
      if (gapMs > 0 && count > 0 && at - Number(state.lastCountAt || 0) < gapMs) {
        return skip('too-soon', { count, gapMs })
      }
      if (dailyMax === 0 || count >= dailyMax) return skip('daily-cap', { count })
      if (conf < minConf) return skip('confidence', {})

      // ---- 三闸全过：这才算"真注入一次"，命中条目每条记一次 ----
      const warmed = warmEntries(db, [...hitIds], numCfg(weightMax?.(), WEIGHT_MAX, 1, 10000, true))
      writeInject({
        day: today,
        count: count + 1,
        lastAt: at,
        lastCountAt: at,   // 2026-11-09：这道闸按它算间隔，别拿 lastAt（它写在 skip 里也动）
        lastFp: fp,
        lastText: text,
        lastSkip: state.lastSkip ?? null,
      })
      try { bumpStat('injectChars', text.length) } catch { /* 记不上不影响注入 */ }
      console.log(`[whale-memory] 卡片注入 ${count + 1}/${dailyMax}：fp=${fp}，命中 ${warmed} 条，confidence=${conf.toFixed(3)}`)
      return remember(text)
    } catch (e) {
      // 2026-11-09：这里原来静默吞异常。`CARD_MIN_GAP_MS` 漏了导入时，卡片直接变成空串、
      // 界面上看不出任何错。留一行日志，别让下一次也这么哑。
      console.error('[whale-memory] 卡片组装抛错:', (e && e.message) || e)
      return ''
    }
  }

  return { card, associate }
}
