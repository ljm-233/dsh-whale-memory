/**
 * 记忆卡的打分：rel / imp / time 三轴合成一个分（或 legacy 旧公式），按场景取门槛。
 *
 * 两条公式只影响排序分；进卡的格式、闸门、指纹全一样（见 `recall-card.mjs`）。
 * 场景、权重、半衰只在 `axes.mjs` 的 SCENE 里写一份，这里只选、不算。
 *
 * @module recall-score
 */
import {
  AXES_THRESHOLD, IMPORTANT_WEIGHT, RECALL_SCENE, RECALL_THRESHOLD, SCORE_MODE, TIER_PENALTY,
} from '../constants.mjs'
import { scoreMemory, simOf } from '../language.mjs'
import { SCENE, resolveScene, scoreEntry } from '../axes.mjs'
import { numCfg } from '../shared.mjs'
import { blobToVec } from '../vector.mjs'

/**
 * 造一个打分器：配置是活引用（每次用时现读），所以这里只包一层，不缓存取值。
 *
 * @param {object} deps 依赖
 * @returns {{scoreModeOf:Function, sceneFor:Function, thresholdFor:Function, legacyScore:Function, emoOf:Function, logAxes:Function, scoreCold:Function}}
 */
export function createScorer({ scoreMode, recallScene, recallThreshold, tierPenalty, axesDebug }) {

  /* ---- 打分公式与场景 ---- */

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

  /* ---- 候选池 → 分数：过滤热区、合一个分、卡门槛、截前 limit 条 ---- */

  /**
   * 把候选池打成一组「带分候选」。`mode` / `scene` / `threshold` 一起返回，
   * 因为下游的置信度要拿**这一轮真用的那把尺子**去算，不能事后另猜。
   *
   * @param {object} ctx { cold, hotIds, emotions, cues, text, queryVec, now, limit }
   * @returns {{scored:Array, mode:string, scene:string, threshold:number}}
   */
  const scoreCold = ({ cold, hotIds, emotions, cues, text, queryVec, now, limit }) => {
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
    return { scored, mode, scene, threshold }
  }

  return { scoreModeOf, sceneFor, thresholdFor, legacyScore, emoOf, logAxes, scoreCold }
}
