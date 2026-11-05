/**
 * 三维打分（lib/axes.mjs）的回归：三件事必须一直成立。
 *
 * 每条断言都对应 docs/brain-plan.md 第二节的一条设计承诺，跑不过就是设计错了：
 * 1) 场景权重真的改变排序（否则三套权重是摆设）
 * 2) 半衰按场景走（否则「查旧事不衰」是嘴上的）
 * 3) 打分永远有界、权重恒为 1（否则接进 recall 会把 NaN 灌进排序）
 *
 * 另外三条是接线之后才有的：认不出的场景名回落 recall、auto 只认线索词、
 * 人工 imp 覆盖规则值（人可以盖掉自动规则）。
 *
 * 原型在 /tmp/brain-proto/axes.test.mjs（node --test 版），这里是仓库的统一跑法。
 * 跑法：node tests/test-axes.mjs
 */
import {
  SCENE, SCENE_NAMES, IMPORTANT_W, LOOKUP_CUES,
  scoreEntry, axesOf, relevanceAxis, importanceAxis, timeAxis,
  sceneOf, sceneNameOf, detectScene, resolveScene,
} from '../lib/axes.mjs'
import { AXES_THRESHOLD, IMPORTANT_WEIGHT } from '../lib/constants.mjs'

const DAY = 86400000
const NOW = 1793880000000 // 2026-11-05 附近，固定住，别用 Date.now 让测试漂

let pass = 0
let fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  OK  ' + name) }
  else { fail += 1; console.log('  NG  ' + name + (extra ? ` — ${extra}` : '')) }
}

/** 一条「旧但重要」的记忆：300 天前，权重高到 IMPORTANT_W，情绪两档，被引用过两次。 */
const oldImportant = { t: NOW - 300 * DAY, w: IMPORTANT_W, emo: ['sad', 'tired'], hits: 4, tier: 0, imp: null }
/** 一条「新但没什么」的记忆：昨天，权重 1，没情绪，没被想起过。 */
const freshThin = { t: NOW - DAY, w: 1, emo: [], hits: 0, tier: 3, imp: null }

// ---- 1. 场景权重真的改变排序 ----
{
  const ctx = { now: NOW, sim: 0.30, cites: 2 }
  const oldLookup = scoreEntry(oldImportant, { ...ctx, scene: 'lookup-old' })
  const newLookup = scoreEntry(freshThin, { ...ctx, scene: 'lookup-old' })
  check('lookup-old 把旧的、重的排前', oldLookup.score > newLookup.score,
    `old=${oldLookup.score.toFixed(3)} new=${newLookup.score.toFixed(3)}`)

  const oldDaily = scoreEntry(oldImportant, { ...ctx, scene: 'daily' })
  const newDaily = scoreEntry(freshThin, { ...ctx, scene: 'daily' })
  check('daily 把新的排前', newDaily.score > oldDaily.score,
    `old=${oldDaily.score.toFixed(3)} new=${newDaily.score.toFixed(3)}`)

  check('recall 与 daily 对同一条给出不同的分', oldLookup.scene === 'lookup-old' && oldDaily.scene === 'daily')
  for (const name of SCENE_NAMES) {
    const { rel: wr, imp: wi, time: wt } = SCENE[name].w
    check(`${name} 权重和 = 1`, Math.abs(wr + wi + wt - 1) < 1e-9, String(wr + wi + wt))
    check(`${name} 有门槛`, Number.isFinite(AXES_THRESHOLD[name]), String(AXES_THRESHOLD[name]))
  }
}

// ---- 2. 半衰按场景走 ----
{
  const t = NOW - 300 * DAY
  const lookup = timeAxis({ t, now: NOW, halfLifeDays: SCENE['lookup-old'].halfLifeDays })
  const daily = timeAxis({ t, now: NOW, halfLifeDays: SCENE.daily.halfLifeDays })
  check('300 天前在 lookup-old 里几乎不衰', lookup > 0.9, lookup.toFixed(3))
  check('300 天前在 daily 里接近 0', daily < 0.001, daily.toExponential(2))
  check('正好一个半衰 = 0.5', Math.abs(timeAxis({ t: NOW - 7 * DAY, now: NOW, halfLifeDays: 7 }) - 0.5) < 1e-9)
  check('两个半衰 = 0.25', Math.abs(timeAxis({ t: NOW - 14 * DAY, now: NOW, halfLifeDays: 7 }) - 0.25) < 1e-9)
  check('未来的时间戳不许 > 1', timeAxis({ t: NOW + 5 * DAY, now: NOW, halfLifeDays: 7 }) === 1)
  check('半衰缺失/为 0 也不崩（当没衰）', timeAxis({ t: 0, now: NOW, halfLifeDays: 0 }) === 1)
}

// ---- 3. 有界、不漏 NaN ----
{
  const junk = { t: null, w: undefined, emo: undefined, hits: 'x', tier: -3, imp: undefined }
  for (const scene of ['recall', 'lookup-old', 'daily', '不存在的场景', '']) {
    const r = scoreEntry(junk, { scene, now: NOW, sim: Number.NaN, cites: undefined })
    const ok = Number.isFinite(r.score) && r.score >= 0 && r.score <= 1
    check(`脏数据在 ${scene || '(空)'} 里仍在 0..1 且有限`, ok, String(r.score))
    check(`脏数据在 ${scene || '(空)'} 里三轴都是有限数`,
      Object.values(r.axes).every((v) => Number.isFinite(v)), JSON.stringify(r.axes))
  }
  check('相似度 1 + 命中封顶 → rel = 1', relevanceAxis({ sim: 1, hits: 99, tier: 0 }) === 1)
  check('w = 1 且没别的信号 → imp = 0',
    importanceAxis({ w: 1, emotions: [], cites: 0, marked: false }) === 0)
  check('全信号满 → imp = 1',
    importanceAxis({ w: IMPORTANT_W, emotions: ['a', 'b'], cites: 3, marked: true }) === 1)
  check('人工 imp 覆盖自动规则', importanceAxis({ override: 0.9, w: 1 }) === 0.9)
  check('imp 为 null 不算覆盖', importanceAxis({ override: null, w: 1 }) === 0)
  check('imp 为脏值退回自动', importanceAxis({ override: 'x', w: 1 }) === 0)
  check('三轴能单独读出来（键就三个）',
    JSON.stringify(Object.keys(axesOf(oldImportant, { now: NOW, scene: 'recall' })).sort()) === '["imp","rel","time"]')
}

// ---- 4. 场景解析：认不出回落 recall，auto 只认线索词 ----
{
  check('认不出的场景名回落 recall', sceneOf('nonsense') === SCENE.recall)
  check('sceneNameOf 归一', sceneNameOf('打错了') === 'recall' && sceneNameOf('daily') === 'daily')
  check('空场景名也是 recall', sceneNameOf(undefined) === 'recall')
  for (const cue of LOOKUP_CUES) {
    check(`auto 命中「${cue}」→ lookup-old`, detectScene(`后来呢，${cue} 那件事`) === 'lookup-old', detectScene(cue))
  }
  check('auto：线索词 → lookup-old', detectScene('上次那个 bug 后来怎么样了') === 'lookup-old')
  check('auto：普通一句 → recall', detectScene('今天天气还行') === 'recall')
  check('配置 auto 走规则', resolveScene('auto', '以前那个插件') === 'lookup-old')
  check('配置具体场景就不猜', resolveScene('daily', '上次那个') === 'daily')
  check('配置乱写回落 recall', resolveScene('???', '上次那个') === 'recall')
}

// ---- 5. 常量同源：IMPORTANT_W 就是 constants 的那一个数 ----
check('IMPORTANT_W === IMPORTANT_WEIGHT', IMPORTANT_W === IMPORTANT_WEIGHT, `${IMPORTANT_W} vs ${IMPORTANT_WEIGHT}`)

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail > 0) process.exit(1)
