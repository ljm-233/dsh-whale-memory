/**
 * 常量与词表。
 *
 * 放在单独一个文件，是因为它们被好几个模块要用，
 * 而插件主体只需要「接线」。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PLUGIN_VERSION = '0.28.6'

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
export const RECALL_MAX = 3
/** 稳定事实上限。 */
export const FACT_MAX = 8
/** 单条互动截断长度。 */
export const PART_CAP = 300

/** 召回单条展示上限：比热区短一半，宁可少给细节也别占满预算。 */
export const RECALL_LINE_CAP = 180
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
/** 热区硬上限：再多就不叫「热」了，超出的按权重降级。 */
export const HOT_ZONE_MAX = 30
/** 抬进热区的最低权重：默认权重是 1，被想起一次 +1，所以 3 = 真被反复用过。 */
export const HOT_PROMOTE_WEIGHT = 3
/** 层级惩罚：tier 每深一层，排序分扣这么多。 */
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
/** 主动联想的分数门槛。 */
export const RECALL_THRESHOLD = 2.0

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
