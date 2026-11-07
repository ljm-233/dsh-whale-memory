/**
 * 三维打分：相关性 / 重要性 / 时间，三轴分开算，查询只出一个分。
 *
 * 纯函数，不碰库、不碰网络、不读文件——所以能直接断言（tests/test-axes.mjs）。
 * 来源是 docs/brain-plan.md 第二节的可执行样张（原型在 /tmp/brain-proto/axes.mjs），
 * 算法与场景权重一个字没改，只把 IMPORTANT_WEIGHT 接到 constants.mjs 的那一份上，
 * 并补了 sceneOf() / detectScene()：认不出的场景名回落 recall，拼错的字符串不许变成 0 分。
 *
 * 边界（半年后别忘，写死的）：
 *   - 三轴**不塞进向量**。向量只代表「这句话在说什么」，塞重要性进去要重建全部向量。
 *   - `axes` 只给测试、调试、「为什么它排第一」看；recall.mjs 排序只取 `score`。
 *     不许拿 axes.time 去做业务判断（「这条太旧了」之类），那会绕开场景权重。
 */
import { IMPORTANT_WEIGHT } from './constants.mjs'

/** 三套场景权重 + 各自的半衰期（天）。权重和恒为 1，改动前先跑测试。 */
export const SCENE = Object.freeze({
  // 日常对话：一句平常的话，旧事别抢戏。
  daily: Object.freeze({ w: Object.freeze({ rel: 0.35, imp: 0.15, time: 0.50 }), halfLifeDays: 7 }),
  // 主动联想：默认路径，和 recall.mjs 旧的 (0.5**(days/30)) 对齐。
  //
  // 0.28.21：rel 0.55→0.65、imp 0.25→0.15（time 不动）。量出来的病：
  // imp 认的是「被想起过 / 有情绪 / 有证据」——库里 63% 的老条目这三样都是空的，imp 恒 0；
  // 而条目标着「被反复想起」（hits≈4）的模板条目 imp 能到 0.19，于是
  // 一段 sim 0.41 的无关模板能压住 sim 0.85 的真命中（probe-recall 里 rank 8 vs 真命中）。
  // 那等于「想得多的」赢「说得对的」。imp 仍参与（0.15），只是不再压过 rel。
  recall: Object.freeze({ w: Object.freeze({ rel: 0.65, imp: 0.15, time: 0.20 }), halfLifeDays: 30 }),
  // 查旧事：十年半衰 = 几乎不衰；重要性权重抬到最高，因为「旧」正是被查的理由。
  'lookup-old': Object.freeze({ w: Object.freeze({ rel: 0.45, imp: 0.45, time: 0.10 }), halfLifeDays: 3650 }),
})

/** 场景名（按固定的顺序，设置页下拉和 /status 都用它）。 */
export const SCENE_NAMES = Object.freeze(Object.keys(SCENE))

/** 和 constants.mjs 的 IMPORTANT_WEIGHT 同一个数：w 到这里算「印象深刻」。 */
export const IMPORTANT_W = IMPORTANT_WEIGHT

/**
 * 「查旧事」的线索词。命中就走 lookup-old——P1 只用规则，不调模型。
 * 这份词表是 docs/brain-plan.md 第二节那一段的原文。
 */
export const LOOKUP_CUES = Object.freeze(['上周', '上次', '以前', '之前', '那个', '后来', '记得吗'])

/** 命中次数归一化的分母：hits=5 封顶就够，再多是本地的口癖不是价值。 */
const HITS_CAP = 5
/** 引用次数（证据条数）归一化的分母。 */
const CITES_CAP = 3
/** 情绪冲击的封顶条数（一轮里两种情绪就够重了）。 */
const EMO_CAP = 2

/** 夹到 0..1；NaN / undefined / Infinity 一律当 0——打分函数不许吐 NaN。 */
const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)

/**
 * 轴一：相关性。语义相似为主，命中频次与层级为辅。
 *
 * @param {{sim?:number, hits?:number, tier?:number}} [input] 三样原料
 * @returns {number} 0..1
 */
export function relevanceAxis(input = {}) {
  const sim = clamp01(input.sim)
  const hits = clamp01(Math.log1p(Math.max(0, Number(input.hits) || 0)) / Math.log1p(HITS_CAP))
  const tier = clamp01(1 - Math.max(0, Number(input.tier) || 0) / 9)
  return clamp01(0.70 * sim + 0.25 * hits + 0.05 * tier)
}

/**
 * 轴二：重要性。只认已有的事后证据，不认「我觉得重要」。
 *
 * 自动规则（全部用库里已有的事后痕迹，不发明新数据）：
 *   - 被想起 / 被写进日记账本的次数 → `w` 累积权重（warmEntries 每被想起一次 +1）
 *   - 被引用（写进证据链 / 账本） → `entry_evidence` 条数
 *   - 情绪冲击 → `emo` 里有几档
 *   - 显式钉住（「印象深刻」）→ `w ≥ IMPORTANT_WEIGHT`，或 `imp` 列人工写了值
 * 人工覆盖优先：人说了重要就是重要，别让规则盖掉人。
 *
 * @param {{w?:number, emotions?:string[], cites?:number, marked?:boolean,
 *          override?:number|null}} [input] 原料
 * @returns {number} 0..1
 */
export function importanceAxis(input = {}) {
  const override = input.override
  if (override !== null && override !== undefined && Number.isFinite(Number(override))) {
    return clamp01(Number(override))
  }
  const sw = clamp01((Number(input.w ?? 1) - 1) / (IMPORTANT_W - 1)) // 被反复想起 → 累积权重
  const se = clamp01((Array.isArray(input.emotions) ? input.emotions.length : 0) / EMO_CAP) // 情绪冲击
  const sc = clamp01((Number(input.cites) || 0) / CITES_CAP) // 被引用/被写进证据
  const sf = input.marked === true ? 1 : 0 // 被显式标记（写进日记/账本/重要）
  return clamp01(0.35 * sw + 0.25 * se + 0.20 * sc + 0.20 * sf)
}

/**
 * 轴三：时间。半衰由场景给，不由条目给。
 *
 * 「查旧事几乎不衰」不是靠把分数压平，是靠在这里换一个十年半衰——
 * 同一个 t，换个场景就是另一个数，存储一个字都不用改。
 *
 * @param {{t?:number, now?:number, halfLifeDays?:number}} [input] 时间与半衰
 * @returns {number} 0..1，1 = 就是现在
 */
export function timeAxis(input = {}) {
  const half = Number(input.halfLifeDays)
  if (!Number.isFinite(half) || half <= 0) return 1
  const ageDays = Math.max(0, (Number(input.now) || 0) - (Number(input.t) || 0)) / 86400000
  return clamp01(0.5 ** (ageDays / half))
}

/** 场景表：认不出的场景一律按 recall，别让拼错的字符串变成意外的 0 分。 */
export function sceneOf(name) {
  return SCENE[String(name ?? '')] ?? SCENE.recall
}

/** 场景名归一到三选一（认不出 → recall）。 */
export function sceneNameOf(name) {
  const key = String(name ?? '')
  return SCENE[key] ? key : 'recall'
}

/**
 * 按关键词猜场景（P1 只认规则，不调模型）。
 *
 * 只在配置成 `auto` 时用；命中线索词 → lookup-old，其余 → recall。
 * `daily` 不在这里出现：它只给「注入给人看的排序」用，不改主动联想。
 *
 * @param {string} text 这一轮用户说的话
 * @returns {'recall'|'lookup-old'}
 */
export function detectScene(text) {
  const s = String(text ?? '')
  return LOOKUP_CUES.some((c) => s.includes(c)) ? 'lookup-old' : 'recall'
}

/** 配置值 → 真正要用的场景名：'auto' 走规则，其余认不出回落 recall。 */
export function resolveScene(configured, text) {
  const raw = String(configured ?? '').trim()
  return raw === 'auto' ? detectScene(text) : sceneNameOf(raw)
}

/**
 * 一次算齐三轴（调试/测试用；线上只取 score）。
 *
 * @param {object} entry 条目（至少要有 t / w / emo / hits / tier）
 * @param {{scene?:string, now?:number, sim?:number, cites?:number, marked?:boolean}} [ctx]
 * @returns {{rel:number, imp:number, time:number}}
 */
export function axesOf(entry = {}, ctx = {}) {
  const scene = sceneOf(ctx.scene)
  return {
    rel: relevanceAxis({ sim: ctx.sim ?? 0, hits: entry.hits, tier: entry.tier }),
    imp: importanceAxis({
      w: entry.w,
      emotions: entry.emo ?? entry.emotions ?? [],
      cites: ctx.cites ?? 0,
      marked: ctx.marked === true,
      override: entry.imp,
    }),
    time: timeAxis({ t: entry.t, now: ctx.now, halfLifeDays: scene.halfLifeDays }),
  }
}

/**
 * 查询入口：三轴进来，一个分出去。
 *
 * @param {object} entry 条目
 * @param {{scene?:string, now?:number, sim?:number, cites?:number, marked?:boolean}} [ctx]
 * @returns {{score:number, scene:string, axes:{rel:number,imp:number,time:number}}}
 */
export function scoreEntry(entry = {}, ctx = {}) {
  const sceneName = sceneNameOf(ctx.scene)
  const scene = sceneOf(sceneName)
  const axes = axesOf(entry, { ...ctx, scene: sceneName })
  const score = scene.w.rel * axes.rel + scene.w.imp * axes.imp + scene.w.time * axes.time
  return { score: clamp01(score), scene: sceneName, axes }
}
