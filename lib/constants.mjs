/**
 * 常量与词表。
 *
 * 放在单独一个文件，是因为它们被好几个模块要用，
 * 而插件主体只需要「接线」。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 版本号只在 `package.json` 里写一次，这里读回来（导出名不变，别处照旧 import）。
 * 用 readFileSync 而不是 JSON import：零依赖，也不带实验性警告。
 */
export const PLUGIN_VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
).version

export const DEFAULT_MEMORY_DIR = join(homedir(), '.dsh', 'whale-memory')
export const DB_FILE = 'memory.db'

/** 本地嵌入服务地址。 */
export const EMBED_URL = String(process.env.EMBED_URL ?? 'http://127.0.0.1:8377')
/** 向量维度。 */
export const EMBED_DIMS = 512
/** 向量请求超时（毫秒）——超时即降级，不拖慢对话。 */
export const EMBED_TIMEOUT_MS = 1500

/** 热区总预算（字符）。 */
export const MEMORY_BUDGET_CHARS = 1000
/** 热区保留的最近交互轮数。 */
export const RECENT_PAIRS = 4
/** 主动联想候选上限。 */
export const RECALL_MAX = 5
/** 稳定事实上限。 */
export const FACT_MAX = 8
/** 单条互动截断长度。 */
export const PART_CAP = 300

/** 证据卡里的摘要上限：卡只给「这条在说什么」，原文要另读。 */
export const RECALL_LINE_CAP = 30
/** 单张证据卡的总长上限；超了按 tag→summary→quote 逐字缩，缩不动整条丢掉。 */
export const RECALL_CARD_MAX = 120
/** 整段联想的上限。 */
export const RECALL_SECTION_CAP = 650
/** 卡里那句逐字原句取几个字（命中位置前后合计）。 */
export const RECALL_QUOTE_CHARS = 12
/** memory_recall 的 detail:full 每页默认多少字符。 */
export const RECALL_PAGE_DEFAULT = 2000
/** 单页硬上限：再多就分批读，别让一次调用把上下文撑爆。 */
export const RECALL_PAGE_MAX = 8000
/** 冷区硬上限。 */
export const COLD_MAX = 2000
/** 权重高于此值不参与合并（「印象深刻」）。 */
export const IMPORTANT_WEIGHT = 8
/** 每轮轻微衰减。 */
export const WEIGHT_DECAY_PER_TURN = 0.02
/** 权重上限：防止被反复想起的条目无限累积，长期霸占回忆位。 */
export const WEIGHT_MAX = 12
/** 备份保留几份。 */
export const BACKUP_KEEP = 14
/** 多久检查一次该不该备份（毫秒）。 */
export const BACKUP_CHECK_MS = 6 * 60 * 60 * 1000

/** 共享时间线最多留多少条。 */
export const EVENT_MAX = 5000

/** 桌面页总预算（UTF-8 字节）。 */
export const DESK_TOTAL_BYTES = 4096
/** 桌面页里「事」那一段的预算（字节）。 */
export const DESK_MATTERS_BYTES = 2048
/** 桌面页里「人」那一段的预算（字节）。 */
export const DESK_PEOPLE_BYTES = 900
/** 桌面页里「约」那一段的预算（字节）。 */
export const DESK_PROMISE_BYTES = 600

/** 夜班默认几点开（本地时间）。 */
export const NIGHT_HOUR = 22
/** 夜班默认几分开。 */
export const NIGHT_MINUTE = 5
/** 夜班锁多久算死锁（毫秒）。 */
export const NIGHT_LOCK_MS = 30 * 60 * 1000
/** 冷区多久没动就该走（毫秒）。 */
export const COLD_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 热区多久没动就该降到冷区（毫秒）。 */
export const HOT_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 热区硬上限：再多就不叫「热」了，超出的按权重降级。默认值，可被配置覆盖（hotZoneMax）。 */
export const HOT_ZONE_MAX = 30
/** 抬进热区的最低权重：默认权重是 1，被想起一次 +1，所以 3 = 真被反复用过。默认值，可被配置覆盖（hotPromoteWeight）。 */
export const HOT_PROMOTE_WEIGHT = 3
/** 层级惩罚：tier 每深一层，排序分扣这么多。默认值，可被配置覆盖（tierPenalty）。 */
export const TIER_PENALTY = 0.15

/** 日记默认几点写（本地时间），到点之后当天还没写就补。 */
export const DIARY_HOUR = 22
/** 注入上下文时最多带几篇日记。 */
export const DIARY_INJECT_MAX = 2
/** 一篇日记的长度上限（字符）。 */
export const DIARY_MAX_CHARS = 400

/** 压缩存档私发时，单条消息的字数。 */
export const IM_PART_CHARS = 1200
/** 压缩存档私发时，最多发几条（再多就只留本地文件）。 */
export const IM_MAX_PARTS = 6
/** 主动联想的分数门槛（旧刻度：scoreMemory 的原始分，0..~8）。只有 legacy 模式还看它。 */
export const RECALL_THRESHOLD = 2.0

/**
 * 三维打分（docs/brain-plan.md 第二节）。权重与半衰只写在 `lib/axes.mjs` 的 SCENE 一份，
 * 这里只放「用哪套公式」「门槛多少」「要不要打印分解」三样。
 */
/** 打分公式：axes = 相关性/重要性/时间三轴合成；legacy = 旧公式（A/B 用）。环境变量 WHALE_SCORE_MODE 优先。 */
export const SCORE_MODE = 'axes'
/** 默认场景。auto = 按关键词猜（见 axes.mjs 的 detectScene）。 */
export const RECALL_SCENE = 'recall'
/**
 * 新分数在 0..1，旧的 2.0 这把尺子不能再用，按场景各配一个刻度。
 * 数偏紧（要两条轴同时像样才过线）是有意的：主动联想宁可安静，也不要噪音。
 *
 * **门槛不是随手定的数：= 该场景「imp=0 条目」的理论上限 × 0.80**（0.28.22 起写死这个比例）。
 * 上限由 `lib/axes.mjs` 决定：rel 轴天花板 = 0.70·sim + 0.25·hits + 0.05·tier，
 * 没被想起过（hits=0）、tier=0 的条目就算 sim=1.00 也只有 0.750（那 0.25 是留给
 * 「以前被想起过」的，一条没被想过的旧事永远拿不到）；而库里 63% 的老条目 imp 也是 0。
 * 所以一条 imp=0 的条目最多只能到 `w.rel × 0.750 + w.time × time`（lookup-old 十年半衰 ⇒ time≈1）：
 *   recall      0.65×0.750 + 0.20 = 0.6875 → ×0.80 = 0.55
 *   lookup-old  0.45×0.750 + 0.10 = 0.4375 → ×0.80 = 0.35   ← **0.28.22：0.45 → 0.35**
 *   daily       0.35×0.750 + 0.50 = 0.7625 → ×0.80 ≈ 0.61，取 0.60（略严一点）
 * 0.28.21 之前 lookup-old 是 0.45 > 上限 0.4375 ⇒ 那种条目**一条都翻不出来**（「查旧事」永远空手）。
 * 0.80 不是新发明的数：recall 那格一直是它（0.55 / 0.6875），只是 lookup-old 落了单。
 * 这条不变式有测试钉着（tests/test-axes.mjs 第 6 节），以后调权重忘了调门槛会当场红。
 */
export const AXES_THRESHOLD = Object.freeze({
  recall: 0.55,
  'lookup-old': 0.35,
  daily: 0.60,
})
/** 调试开关：开了在日志里打印本次 top5 的三轴分解。默认关（日志是给人看的，不是刷的）。 */
export const AXES_DEBUG = false
/** 记忆卡一天最多真正注入几次（指纹变了、真写了 hits/lastHit 才算一次）。0 = 当天不再注入。默认值，可被配置覆盖（cardDailyMax）。 */
/**
 * 卡片一天最多「重新组装」几次。
 *
 * 2026-11-09 由 12 提到 40：撞顶之后 skip() 会**沿用 lastText**，
 * 也就是整轮读同一张旧卡——一天跑一两百轮时，95% 的轮次读的都是冻住的上下文。
 * 表现就是「改了文件没反映、越晚越钝、同一个错反复犯」。
 * 40 次仍然省，但足够让当天的改动都跟得上。
 */
export const CARD_DAILY_MAX = 40
/** 记忆卡的置信门槛：本轮联想拼出来的置信度低于它就不刷新卡片。默认值，可被配置覆盖（cardMinConfidence）。 */
export const CARD_MIN_CONFIDENCE = 0.35

/**
 * 情绪注入的三道量（第四道是 `injectedFor === updatedAt` 幂等，不需要配置）。
 *
 * 默认值只在这里写一份：schema（lib/index.mjs）与设置页（client.js）都读这一份，
 * 设置页不写 fallback。改这里就等于改默认值。
 */
/** 一天最多主动说几次心情。4 次 = 上午 / 下午 / 收工前后，各有一次位置；再多就变背景音。 */
export const MOOD_INJECT_DAILY_MAX = 4
/** 总值比「上次开口时」动了几格才算够格说。一轮的步长只有 2~4，6 = 攒两轮。 */
export const MOOD_INJECT_MIN_DELTA = 6
/** 两次开口至少隔几小时。 */
export const MOOD_INJECT_COOLDOWN_HOURS = 3
/** 低于这条线算「沉」，卡片里带一句「（不想做可以说）」。 */
export const MOOD_LOW = 40
/** tired 高过这条线也算「累」，同样带那句提示。 */
export const MOOD_TIRED_ALERT = 25
/** 情绪行硬上限（字符）：一行、不带数值。 */
export const MOOD_LINE_CAP = 40
/** 「不想做」那本账的文件名，放在记忆库目录（和 LEDGER.md 并排）。 */
export const MOOD_UNWILLING_FILE = '我不想做.md'

/** 情绪词表。 */
export const EMOTION_WORDS = {
  tired: ['累', '困', '疲惫', '好累', '撑不住', '熬夜', '没睡'],
  sad: ['难过', '伤心', '失落', '哭', 'emo', '委屈', '想哭'],
  angry: ['气死', '烦', '生气', '郁闷', '恼', '受不了'],
  happy: ['开心', '高兴', '爽', '太好了', '哈哈', '笑死', '棒'],
  anxious: ['焦虑', '紧张', '怕', '担心', '慌', '压力'],
}

/** 停止词。 */
export const STOPWORDS = new Set([
  '今天', '明天', '昨天', '现在', '我们', '你们', '他们', '什么', '怎么',
  '可以', '这个', '那个', '一下', '一点', '还是', '就是', '因为', '所以',
  '如果', '但是', '而且', '然后', '知道', '觉得', '想要', '需要', '时候',
  '已经', '不是', '没有', '可能', '应该', '一直', '真的',
])

/**
 * 识别情绪。
 * @param {string} text
 * @returns {string[]}
 */
