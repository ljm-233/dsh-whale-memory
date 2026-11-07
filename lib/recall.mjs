/**
 * 记忆卡：拼进 runtime-context 的那一份「我是谁 / 记得什么」。
 *
 * 分两层：
 * - 轻查询（声音/交接条/日记/事实/热区/群摘要）同步读 sqlite 和文件——每步组装都要现算，必须便宜。
 * - 重检索（「这一句在说什么」的语义联想）异步算一次，结果按 session 存一小格缓存，card() 只同步读。
 *
 * 为什么不把联想也塞进 card()：card 每步组装都被调一次（一轮 N 步就是 N 次），
 * 而联想要打一次本地嵌入服务、还要扫几百条冷区。放进 card = 同一件事一轮做 N 次；
 * 异步算一次 + 同步读缓存 = 一轮只付一次，且绝不 await、绝不阻塞对话。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  AXES_THRESHOLD, CARD_DAILY_MAX, CARD_MIN_CONFIDENCE, DIARY_INJECT_MAX, IMPORTANT_WEIGHT,
  RECALL_MAX, RECALL_SCENE, RECALL_SECTION_CAP, RECALL_THRESHOLD, SCORE_MODE, TIER_PENALTY, WEIGHT_MAX,
} from './constants.mjs'
import { detectEmotions, cueWords, overlap, scoreMemory, simOf } from './language.mjs'
import { SCENE, resolveScene, scoreEntry } from './axes.mjs'
import { cardLine, clamp } from './format.mjs'
import { dayKeyOf, numCfg } from './shared.mjs'
import { blobToVec, embedTexts } from './vector.mjs'
import { handoverNudge } from './handover.mjs'
import { listFacts } from './facts.mjs'
import { isPrivateSession } from './session.mjs'
import { warmEntries } from './tools.mjs'

/** 联想缓存最多记几个会话；超了丢最老的，别让一张 Map 长成泄漏。 */
const ASSOC_MAX = 8
/** 一轮里算太久还没用上就别用了。 */
const ASSOC_TTL_MS = 10 * 60 * 1000
/** 指纹缓存最多记几份卡；超了丢最老的。 */
const CARD_FP_MAX = 16
/** 指纹多久失效：同一份卡在这个窗口里重复组装都当同一次注入。 */
const CARD_FP_TTL_MS = 10 * 60 * 1000
/** 「踩到热区」的判定：热区条目与本轮消息的二元组重叠度到这条线才算。 */
const HOT_HIT_OVERLAP = 0.2

/**
 * 冷区候选的列：`imp`（重要性人工覆盖）和 `cites`（被引用次数）都不是每个库都有的。
 * 缺了就当 NULL / 0——少两列原料，也比整段联想起不来强。每个库探一次就够（WeakMap 跟着库走）。
 */
const COLD_COLS = new WeakMap()

/**
 * 关键词臂的词：4 字（最具体）+ 2 字（最能兜住换过说法的旧话）+ 拉丁词，最多 14 个。
 *
 * 直接用 `cueWords` 那套 n-gram（它本来就是给「这一句在说什么」用的），不另造分词。
 * 取 4 字和 2 字、跳过 3 字：4 字取多了才有覆盖面（词表是按顺序排的，只取前 4 个会全是句首
 * 「上次说的」这类前缀噪声），而换过说法的旧话（「自己会梳理记忆」对「自己梳理记忆」）
 * 只有 2 字能兜住。实测 5 条旧条目全部落在关键词臂的前 3 名。
 * `%` `_` 是 LIKE 通配符，出现在词里就剥掉——宁可少匹配一个词，也不要让一个词变成通配。
 *
 * @param {string} text 用户说的话
 * @returns {string[]}
 */
export const kwTermsOf = (text) => {
  const all = cueWords(text).map((w) => String(w).replace(/[%_]/gu, '')).filter((w) => w !== '')
  const pick = (test, n) => all.filter(test).slice(0, n)
  return [
    ...pick((w) => w.length === 4, 6),
    ...pick((w) => w.length === 2, 6),
    ...pick((w) => /[a-z]/.test(w), 2),
  ]
}

/**
 * 关键词臂的 SQL 与参数：按「命中了几个词」排序（k DESC），同分才按时间。
 *
 * 为什么按命中词数而不是按 t：热门词（「上次」「自己」）能命中几百条，
 * 按时间取前 200 会被新的挤满，旧的那条照样丢；命中词数才是「这条有多贴这句话」。
 */
export const kwArmOf = (sp, terms) => {
  if (terms.length === 0) return null
  const pats = terms.flatMap((t) => [`%${t}%`, `%${t}%`])
  const likes = terms.map(() => '(u LIKE ? OR a LIKE ?)').join(' OR ')
  const kExpr = terms.map(() => '(u LIKE ?)+(a LIKE ?)').join('+')
  return {
    sql: `SELECT id FROM (SELECT id, (${kExpr}) AS k FROM entries
            WHERE hot=0 AND space=? AND (${likes})
            ORDER BY k DESC, t ASC LIMIT 200)`,
    args: [...pats, sp, ...pats],
  }
}

/**
 * 冷区候选：条目少（≤300）就全取最近 300；多了就取「最近 200 + 关键词命中 ≤200 + 随机 100」。
 *
 * 只用「最近 300」时，真库里所有条目都在七天内 ⇒ time 轴恒为 1.00，换场景没感。
 *
 * 关键词臂（0.28.21 加）：真库冷区 2300+ 条，老条目既进不了「最近 200」，被随机 100 抽中的
 * 概率也只有 ~4%——「十天前说过什么」在**候选池**这一层就丢了，跟打分无关。
 * 这一臂只负责「别丢」，排序照旧交给三轴；没词可取就退回两臂。
 *
 * 导出是为了 scripts/probe-recall.mjs 量的是真东西：把这段 SQL 抄进脚本里，
 * 改代码时它就会悄悄走散（这次差点就拿抄来的旧 SQL 量出一张假表）。
 *
 * @param {object} db 数据库
 * @param {string} sp 空间
 * @param {string} text 这一次用户说的话（关键词臂用它的 n-gram）
 * @returns {{stmt:object, args:any[]}}
 */
export const coldPoolOf = (db, sp, text = '') => {
  if (!COLD_COLS.has(db)) {
    const columnExists = (table, col) => {
      try { return db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().some((c) => c.name === col) } catch { return false }
    }
    const tableExists = (name) => {
      try { return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined } catch { return false }
    }
    const imp = columnExists('entries', 'imp') ? 'imp' : 'NULL AS imp'
    const hits = columnExists('entries', 'hits') ? 'hits' : '0 AS hits'
    const tier = columnExists('entries', 'tier') ? 'tier' : '0 AS tier'
    const cites = tableExists('entry_evidence')
      ? '(SELECT COUNT(*) FROM entry_evidence v WHERE v.entry_id = entries.id) AS cites'
      : '0 AS cites'
    COLD_COLS.set(db, `id,u,a,t,w,emo,vec,${tier},${hits},${imp},${cites}`)
  }
  const cols = COLD_COLS.get(db)
  const coldTotal = (() => {
    try { return db.prepare('SELECT COUNT(*) c FROM entries WHERE hot=0 AND space=?').get(sp)?.c ?? 0 } catch { return 0 }
  })()
  if (coldTotal <= 300) {
    return {
      stmt: db.prepare(`SELECT ${cols} FROM entries WHERE hot=0 AND space=? ORDER BY t DESC LIMIT 300`),
      args: [sp],
    }
  }
  const kw = kwArmOf(sp, kwTermsOf(text))
  const stmt = db.prepare(`SELECT ${cols} FROM entries WHERE id IN (
      SELECT id FROM (SELECT id FROM entries WHERE hot=0 AND space=? ORDER BY t DESC LIMIT 200)
      ${kw === null ? '' : `UNION ${kw.sql}`}
      UNION
      SELECT id FROM (SELECT id FROM entries WHERE hot=0 AND space=? ORDER BY RANDOM() LIMIT 100)
    )`)
  return { stmt, args: kw === null ? [sp, sp] : [sp, ...kw.args, sp] }
}

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
    cardDailyMax, cardMinConfidence,
    scoreMode, recallScene, axesDebug,
    // 工作记忆：卡片底部那一行「手上：…」。空栈返回空串，整行不出现。
    taskLine = () => '',
  } = deps

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
   * session → { turn, lines, ids, scores, limit, hotHit, at }。
   *
   * key 是 session id：群聊、私聊、子 agent 各算各的，不串味。
   * 生命周期只有一轮：associate() 一开头就 turn+1 并清空 lines，
   * 所以上一条用户消息算出来的联想不到下一个回合（key 相同，内容已作废）。
   * ids / scores / hotHit 是置信度的原料——都是这一轮真算出来的数，不另造。
   */
  const ASSOC = new Map()

  /** 层级惩罚：插件配置优先，缺省回落常量，越界夹到 0..1。 */
  const tierPenaltyOf = () => numCfg(tierPenalty?.(), TIER_PENALTY, 0, 1)

  /**
   * 打分公式：`axes`（三维合成，0..1）/ `legacy`（旧公式，2.0 刻度）。
   *
   * 默认 axes；legacy 是 A/B 的一键回退（设置页「打分公式」或环境变量 `WHALE_SCORE_MODE=legacy`，
   * 后者在 index.mjs 里先读）。这两条路**只影响排序分**，进卡的格式、闸门、指纹全一样。
   */
  const scoreModeOf = () => (String(scoreMode?.() ?? SCORE_MODE).toLowerCase() === 'legacy' ? 'legacy' : 'axes')

  /** 这一轮用哪个场景：配置成 auto 就按线索词猜，认不出回落 recall（拼错的字符串不许变成 0 分）。 */
  const sceneFor = (text) => resolveScene(recallScene?.() ?? RECALL_SCENE, text)

  /** 门槛跟着公式走：新分 0..1 按场景各一把尺子；旧分还看那项 recallThreshold（默认 2.0）。 */
  const thresholdFor = (mode, scene) => (mode === 'legacy'
    ? (Number(recallThreshold?.() ?? RECALL_THRESHOLD) || RECALL_THRESHOLD)
    : (AXES_THRESHOLD[scene] ?? AXES_THRESHOLD.recall))

  /**
   * 旧公式：`scoreMemory` 的原始分 × 时间衰减 − 层级惩罚。
   *
   * 这里原样保留（0.28.18 之前的 recall.mjs:136-142 那三行），只为 A/B：
   * 新路径换成三维合成后，切回 legacy 应当与改之前逐条同名次。
   */
  const legacyScore = (base, row, now) => {
    // 时效衰减：相关度相近时新的优先，老记忆最多损失一半排序分（地板 0.5）。
    const days = Math.max(0, (now - row.t) / 86400000)
    const decay = Math.max(0.5, 0.5 ** (days / 30))
    // 层级惩罚：深的往后排，但只是边角分。印象深的（w ≥ 8）不罚。
    const tier = Math.min(Math.max(0, Number(row.tier ?? 0)), 9)
    const penalty = (row.w ?? 1) >= IMPORTANT_WEIGHT ? 0 : tier * tierPenaltyOf()
    return base * decay - penalty
  }

  /** emo 列是 JSON 文本，脏了就当成空——一个坏字段不许把整段联想带走。 */
  const emoOf = (raw) => {
    try {
      const v = JSON.parse(String(raw ?? '[]'))
      return Array.isArray(v) ? v : []
    } catch { return [] }
  }

  /**
   * `axesDebug`（默认关）：把这次 top5 的三轴分解打出来。
   *
   * 只读：不动排序、不写库。它的用途是「判断是不是在乱排」——
   * 看到 rel 很低却排在前面、或者 time 把旧事顶掉，就知道场景/权重选错了。
   */
  const logAxes = (mode, scene, top, threshold) => {
    if (axesDebug?.() !== true) return
    try {
      const cfg = SCENE[scene] ?? SCENE.recall
      const fmt = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '--')
      console.log(`[whale-memory] 三轴分解 mode=${mode} scene=${scene}`
        + ` w=rel${cfg.w.rel}/imp${cfg.w.imp}/time${cfg.w.time} 半衰=${cfg.halfLifeDays}天 门槛=${threshold} top${top.length}`)
      for (const x of top) {
        const a = x.axes ?? {}
        console.log(`[whale-memory]   #${String(x.r.id).slice(-6)} rel=${fmt(a.rel)} imp=${fmt(a.imp)}`
          + ` time=${fmt(a.time)} → ${fmt(x.s)}｜${String(x.r.u ?? '').replace(/\s+/gu, ' ').slice(0, 24)}`)
      }
    } catch { /* 日志不许把联想带崩 */ }
  }

  /** 读当前轮的联想状态；没有、过期、或属于上一轮就当不存在。 */
  const assocStateOf = (sessionId) => {
    const key = String(sessionId ?? '')
    const st = ASSOC.get(key)
    if (!st) return null
    if (Date.now() - st.at > ASSOC_TTL_MS) {
      ASSOC.delete(key)
      return null
    }
    return st
  }

  /**
   * 算这一轮的联想段，算完写缓存。
   *
   * 调用方不 await 它（fire-and-forget）：算不出来、嵌入服务挂了、库坏了，
   * 这一轮就只是没有联想段，对话照常走。
   *
   * @param {string} sessionId 会话 id
   * @param {string} userText 这一轮用户说的话
   * @returns {Promise<string>} 写进缓存的那一份
   */
  const associate = async (sessionId, userText) => {
    const key = String(sessionId ?? '') || 'anon'
    // 先换一轮：同步完成，所以旧联想在新消息落地那一瞬就废掉，正在算的那条也写不进来。
    const turn = (ASSOC.get(key)?.turn ?? 0) + 1
    ASSOC.set(key, { turn, lines: '', ids: [], scores: [], limit: 0, hotHit: false, mode: '', scene: '', threshold: 0, at: Date.now() })
    while (ASSOC.size > ASSOC_MAX) ASSOC.delete(ASSOC.keys().next().value)

    const text = String(userText ?? '').trim()
    // 上限取配置，但整段最多还是 RECALL_MAX 条：卡再短，多了也挤。
    const limit = Math.min(Math.max(0, Number(recallMax?.() ?? RECALL_MAX) || 0), RECALL_MAX)
    if (text === '' || limit === 0) return ''
    try {
      const emotions = detectEmotions(text)
      const cues = cueWords(text)
      const now = Date.now()
      // 只在真要联想时才要向量；服务挂了就退回二元组重叠，不阻塞。
      const queryVec = (await embedTexts([text]))?.[0] ?? null
      if (emotions.length === 0 && cues.length === 0 && queryVec === null) return ''

      const spaceOf = String(space?.() ?? 'default')
      const hotRows = db.prepare('SELECT id,u,a FROM entries WHERE hot=1 AND space=? ORDER BY t DESC LIMIT ?')
        .all(spaceOf, recentPairs())
      const hotIds = new Set(hotRows.map((r) => r.id))
      // 「踩到热区」：热区里的对话和这一句有没有真对上——现成的二元组重叠，不另造相似度。
      const hotHit = hotRows.some((r) => overlap(`${r.u} ${r.a}`, text) >= HOT_HIT_OVERLAP)
      // 候选池：冷区三条臂（最近 / 关键词 / 随机），关键词臂跟着这一次说的话现拼。
      const coldPool = coldPoolOf(db, spaceOf, text)
      const cold = coldPool.stmt.all(...coldPool.args)

      // 打分：三轴分开算、只合一个分（docs/brain-plan.md 第二节）。
      // 场景决定权重与半衰；legacy 走旧公式，两条路都只吐 `s`，下游一个字不用改。
      const mode = scoreModeOf()
      const scene = sceneFor(text)
      const threshold = thresholdFor(mode, scene)

      const scored = cold
        .filter((r) => !hotIds.has(r.id))
        .map((r) => {
          const emo = emoOf(r.emo)
          const entry = { ...r, emo, vec: blobToVec(r.vec) }
          if (mode === 'legacy') {
            const base = scoreMemory(entry, { emotions, text, cues, queryVec, now })
            return { r, s: legacyScore(base, r, now) }
          }
          // rel 用现成的 sim/hits/tier；imp 读 imp 列（NULL = 自动规则）；time 用场景半衰。
          // marked 沿用既有口径：w ≥ IMPORTANT_WEIGHT 就是「印象深刻」。
          const got = scoreEntry(
            { t: r.t, w: r.w, emo, hits: r.hits, tier: r.tier, imp: r.imp },
            {
              scene,
              now,
              sim: simOf(entry, { queryVec, text }),
              cites: r.cites,
              marked: (r.w ?? 1) >= IMPORTANT_WEIGHT,
            },
          )
          return { r, s: got.score, axes: got.axes }
        })
        .filter((x) => x.s > threshold)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)

      logAxes(mode, scene, scored, threshold)

      // 每条只给一张六字段卡（正文另读），整段硬上限 RECALL_SECTION_CAP。
      const cards = []
      // 真正进了卡的条目：指纹和命中计数都只认这些（被预算挤掉的没交出去，不算命中）。
      const keptIds = []
      const keptScores = []
      let used = 0
      for (const x of scored) {
        const line = cardLine(x.r, { keyword: text, score: x.s, now })
        if (line === '') continue
        if (used + line.length + (cards.length === 0 ? 0 : 1) > RECALL_SECTION_CAP) break
        cards.push(line)
        keptIds.push(Number(x.r.id))
        keptScores.push(x.s)
        used += line.length + (cards.length === 0 ? 0 : 1)
      }
      const lines = cards.join('\n')

      // 算的过程中又来了新消息（turn 变了）：这份不属于当前轮，丢掉。
      if (ASSOC.get(key)?.turn !== turn) return ''
      ASSOC.set(key, { turn, lines, ids: keptIds, scores: keptScores, limit, hotHit, mode, scene, threshold, at: Date.now() })
      return lines
    } catch {
      return ''
    }
  }

  /** 交接条跟着数据库放在一起，属于插件自己的数据。 */
  const handoverDir = () => {
    try {
      const p = String(db.prepare('PRAGMA database_list').get()?.file ?? '')
      return p === '' ? memoryDir : dirname(p)
    } catch { return memoryDir }
  }

  /** 声音文件：比记忆更靠前，先定语气再谈事实。 */
  const readVoice = () => {
    try {
      const p = String(db.prepare('PRAGMA database_list').get()?.file ?? '')
      const dir = p === '' ? memoryDir : dirname(p)
      const raw = readFileSync(join(dirname(dir), 'notes', 'VOICE.md'), 'utf8')
      return clamp(raw.replace(/^#.*$/gmu, '').replace(/\n{2,}/gu, '；').trim(), 260)
    } catch { return '' }
  }

  /**
   * 索引指针：只列「有哪些文件、一句话说明」，60 字以内。
   * 目的不是内容，是让我每轮都记得「还有这几份东西可翻」。
   */
  /** 「现在」：所有会话共用的一小段当下，解决私聊/群聊各说各话。 */
  const readNow = () => {
    try {
      const p = String(db.prepare('PRAGMA database_list').get()?.file ?? '')
      const dir = p === '' ? memoryDir : dirname(p)
      const raw = readFileSync(join(dirname(dir), 'db', '现在.md'), 'utf8')
      const body = raw.replace(/^#.*$/gmu, '').replace(/\n{2,}/gu, '；').trim()
      // 2026-11-07：现在页顶部多了「距上次开口 / 昨天 / 今天」三行（约 55 字），
      // 160 会把它挤出卡片的「今天做到的」。宽到 220，但仍留预算给别的段。
      const headLimit = 220
      return body === '' ? '' : clamp(body, headLimit)
    } catch { return '' }
  }

  const readIndexPointer = () => {
    try {
      const p = String(db.prepare('PRAGMA database_list').get()?.file ?? '')
      const dir = p === '' ? memoryDir : dirname(p)
      const raw = readFileSync(join(dirname(dir), 'INDEX.md'), 'utf8')
      // 索引里的表格行：| `路径` | 说明 |
      const rows = [...raw.matchAll(/^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|$/gmu)]
        .slice(0, 12)
        .map((m) => `${m[1]}（${clamp(m[2].replace(/[。；]/gu, ''), 14)}）`)
      return rows.length === 0 ? '' : clamp(`可翻的文件：${rows.join('、')}`, 300)
    } catch { return '' }
  }

  /** 重启后第一件事：读交接条。 */
  const readHandover = () => {
    try {
      const raw = readFileSync(join(handoverDir(), 'HANDOVER.md'), 'utf8')
      const text = raw.replace(/^#.*$/gmu, '').replace(/\n{3,}/gu, '\n\n').trim()
      return text === '' ? '' : clamp(text, 400)
    } catch {
      return ''
    }
  }

  /**
   * 卡片注入的账：一条 JSON 存在 meta 里，跟着库走，不另开文件。
   *
   * 字段：`day` 本地日期、`count` 今天真注入几次、`lastAt` 上次注入时间、
   * `lastFp` 上次指纹、`lastText`（被拦下时沿用它）、`lastSkip`（上次为什么被拦下）。
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
  const fpOf = (text, ids, spaceOf) => {
    let h = 0x811c9dc5
    const feed = (s) => {
      for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
      }
    }
    feed(text)
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

      /** 被拦下来：沿用上次的卡，只把"为什么跳过"记进 meta 和日志。 */
      const skip = (reason, extra) => {
        const stale = lastCard || (typeof state.lastText === 'string' ? state.lastText : '')
        writeInject({
          ...state,
          day: today,
          count,
          lastSkip: { at, reason, conf, threshold: minConf, max: dailyMax, ...extra },
        })
        console.log(`[whale-memory] 卡片跳过（${reason}）：沿用上次 ${stale.length} 字，confidence=${conf.toFixed(3)}`)
        return remember(stale)
      }

      // 同一张卡跨进程幂等：重启 / 新会话首步不该各吃一次额度（今天 01:25 就烧光过 12 次）。
      if (state.day === today && state.lastFp === fp && typeof state.lastText === 'string' && state.lastText) {
        return remember(state.lastText)
      }
      if (dailyMax === 0 || count >= dailyMax) return skip('daily-cap', { count })
      if (conf < minConf) return skip('confidence', {})

      // ---- 三闸全过：这才算"真注入一次"，命中条目每条记一次 ----
      const warmed = warmEntries(db, [...hitIds], numCfg(weightMax?.(), WEIGHT_MAX, 1, 10000, true))
      writeInject({
        day: today,
        count: count + 1,
        lastAt: at,
        lastFp: fp,
        lastText: text,
        lastSkip: state.lastSkip ?? null,
      })
      try { bumpStat('injectChars', text.length) } catch { /* 记不上不影响注入 */ }
      console.log(`[whale-memory] 卡片注入 ${count + 1}/${dailyMax}：fp=${fp}，命中 ${warmed} 条，confidence=${conf.toFixed(3)}`)
      return remember(text)
    } catch { return '' }
  }

  return { card, associate }
}
