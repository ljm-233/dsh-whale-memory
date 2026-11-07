#!/usr/bin/env node
/**
 * 只读探针：量「旧条目还翻得回来吗」。
 *
 * 干三件事，全是只读，一行都不写库：
 *   1. 候选池：照 lib/recall.mjs 那段 SQL 取冷区候选，看目标条目在不在池里（随机 100 是随机的，所以要跑多轮）；
 *   2. 算命：绕开候选池，直接把目标条目按 lib/axes.mjs 打一次分——「如果它进了池，过不过门槛」；
 *   3. 端到端：池 → 打分 → 过门槛 → 排序 → 截 limit → 按 RECALL_SECTION_CAP 拼卡，看目标进没进卡。
 *
 * 三段分开是为了分清病因：池里没有 ≠ 分低 ≠ 被预算挤掉。
 *
 * 跑法：
 *   node scripts/probe-recall.mjs                      # 默认真库（只读）+ 20 轮
 *   node scripts/probe-recall.mjs --db /tmp/x.db --trials 50
 *   node scripts/probe-recall.mjs --json /tmp/probe.json
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const { scoreEntry, resolveScene } = await import('../lib/axes.mjs')
const { simOf } = await import('../lib/language.mjs')
const { blobToVec, embedTexts } = await import('../lib/vector.mjs')
const { cardLine } = await import('../lib/format.mjs')
const { coldPoolOf } = await import('../lib/recall.mjs')
const {
  AXES_THRESHOLD, IMPORTANT_WEIGHT, RECALL_SECTION_CAP,
} = await import('../lib/constants.mjs')

const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const DB_PATH = argOf('db', process.env.WHALE_DB ?? join(homedir(), '.dsh', 'miyu', 'db', 'memory.db'))
const TRIALS = Math.max(1, Number(argOf('trials', 20)) || 20)
const JSON_OUT = argOf('json', '')

/**
 * 五个用例：全部挑「十天以前、内容明确」的旧条目（t < 2026-10-31 12:00 那一档）。
 * q 是「人会怎么问」——不是条目原文，但带着原文的关键词，跟真实提问一个路数。
 * 库里真没有十天前的条目时，用例自动退化成「最老的五条」，脚本会如实报出实际年龄。
 */
const CASES = [
  { id: 1934, q: '上次让你做主动发消息的功能，后来怎么样了' },
  { id: 1940, q: '以前那段调试乘法表的 Python 代码还记得吗' },
  { id: 1922, q: '记得吗，那天帮我建新仓库把插件放上 github' },
  { id: 1926, q: '上次说的自己梳理记忆的功能后来做完了没' },
  { id: 1921, q: '' }, // q 为空时用条目原文当查询词（最理想的情况）
]

/** emo 列是 JSON 文本，脏了当空——同 recall.mjs。 */
const emoOf = (raw) => {
  try {
    const v = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

const db = new DatabaseSync(DB_PATH, { readOnly: true })
const space = String(db.prepare('SELECT space FROM entries GROUP BY space ORDER BY COUNT(*) DESC').get()?.space ?? 'default')

/** 冷区候选池：**直接用 lib/recall.mjs 的那个**（连同 hot 过滤），不抄 SQL。 */
const cols = 'id,u,a,t,w,emo,vec,tier,hits,imp,(SELECT COUNT(*) FROM entry_evidence v WHERE v.entry_id=entries.id) AS cites'
const coldTotal = db.prepare('SELECT COUNT(*) c FROM entries WHERE hot=0 AND space=?').get(space)?.c ?? 0

const now = Date.now()
const scene = resolveScene(process.env.WHALE_SCENE ?? 'recall', '')
const threshold = AXES_THRESHOLD[scene] ?? AXES_THRESHOLD.recall
const limit = 5 // RECALL_MAX 默认
const hotIds = new Set(db.prepare('SELECT id FROM entries WHERE hot=1 AND space=? ORDER BY t DESC LIMIT ?').all(space, 4).map((r) => r.id))

const rowById = (id) => db.prepare(`SELECT ${cols} FROM entries WHERE id=?`).get(id)
const scoreOf = (row, ctx) => {
  const emo = emoOf(row.emo)
  const entry = { ...row, emo, vec: blobToVec(row.vec) }
  const sim = simOf(entry, ctx)
  const got = scoreEntry(
    { t: row.t, w: row.w, emo, hits: row.hits, tier: row.tier, imp: row.imp },
    { scene, now, sim, cites: row.cites, marked: (row.w ?? 1) >= IMPORTANT_WEIGHT },
  )
  return { sim, ...got }
}

const fmt = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(3) : '--')
const age = (t) => `${((now - Number(t)) / 86400000).toFixed(1)}d`

console.log(`库：${DB_PATH}（只读）  空间：${space}  冷区：${coldTotal} 条  场景：${scene}  门槛：${threshold}`)
console.log(`用例：${CASES.length} 条  每例跑 ${TRIALS} 轮（随机 100 每轮重抽）\n`)

const rows = []
for (const c of CASES) {
  const row = rowById(c.id)
  if (!row) { console.log(`#${c.id} 不在库里（跳过）`); continue }
  const q = c.q === '' ? `${row.u}\n${row.a}` : c.q
  const queryVec = (await embedTexts([q]))?.[0] ?? null
  const ctx = { queryVec, text: q }
  const oracle = scoreOf(row, ctx)

  let inPool = 0
  let inKept = 0
  let bestRank = null
  let poolAxes = null
  for (let i = 0; i < TRIALS; i += 1) {
    const poolQ = coldPoolOf(db, space, q)
    const pool = poolQ.stmt.all(...poolQ.args).filter((r) => !hotIds.has(r.id))
    const has = pool.some((r) => Number(r.id) === Number(c.id))
    if (has) inPool += 1
    // rank 取**过线后的完整名次**（不受 limit 截断影响），这样「排第几」才说得清是被谁顶掉的
    const ranked = pool
      .map((r) => ({ r, ...scoreOf(r, ctx) }))
      .filter((x) => x.score > threshold)
      .sort((a, b) => b.score - a.score)
    const scored = ranked.slice(0, limit)
    const pos = ranked.findIndex((x) => Number(x.r.id) === Number(c.id))
    if (pos >= 0) {
      if (bestRank === null || pos + 1 < bestRank) bestRank = pos + 1
      poolAxes = ranked[pos].axes
      // 预算层：按 RECALL_SECTION_CAP 拼卡，看它有没有被挤掉
      let used = 0
      let kept = false
      for (const x of scored) {
        const line = cardLine(x.r, { keyword: q, score: x.score, now })
        if (line === '') continue
        if (used + line.length + (used === 0 ? 0 : 1) > RECALL_SECTION_CAP) break
        if (Number(x.r.id) === Number(c.id)) kept = true
        used += line.length + (used === 0 ? 0 : 1)
      }
      if (kept) inKept += 1
    }
  }
  const rec = {
    id: c.id, q, ageDays: (now - Number(row.t)) / 86400000, onDisk: true,
    oracle: { score: oracle.score, rel: oracle.axes.rel, imp: oracle.axes.imp, time: oracle.axes.time, sim: oracle.sim, pass: oracle.score > threshold },
    poolAxes, threshold, inPool, inKept, trials: TRIALS, bestRank,
    u: String(row.u ?? '').replace(/\s+/gu, ' ').slice(0, 40),
  }
  rows.push(rec)
  console.log(`#${c.id} ${age(row.t)}｜${rec.u.slice(0, 24)}`)
  console.log(`   问：${q.replace(/\s+/gu, ' ').slice(0, 40)}`)
  console.log(`   算命：rel=${fmt(oracle.axes.rel)} imp=${fmt(oracle.axes.imp)} time=${fmt(oracle.axes.time)} → ${fmt(oracle.score)} ${oracle.score > threshold ? '过线' : '不过线'}（sim=${fmt(oracle.sim)}）`)
  console.log(`   进池：${inPool}/${TRIALS}  过线：${poolAxes ? '是' : '否'}  最好名次：${bestRank ?? '—'}  进卡：${inKept}/${TRIALS}`)
  console.log('')
}

const pass = rows.filter((r) => r.inKept > 0).length
console.log(`端到端命中：${pass}/${rows.length} 条；进过池但没过线的：${rows.filter((r) => r.inPool > 0 && r.oracle.pass === false).length} 条；池外：${rows.filter((r) => r.inPool === 0).length} 条`)
if (JSON_OUT !== '') { writeFileSync(JSON_OUT, JSON.stringify({ db: DB_PATH, space, coldTotal, scene, threshold, rows }, null, 2)); console.log(`JSON → ${JSON_OUT}`) }
