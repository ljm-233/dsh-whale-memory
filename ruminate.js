#!/usr/bin/env node
/**
 * ruminate.js — 「胡思乱想」
 *
 * 不是常驻后台任务，而是由 systemd timer 定时拉起的一次性脚本。
 *
 * 做的事：
 *   1. 从冷区随机挑几条记忆
 *   2. 用真向量找它们之间的共同点/关联
 *   3. 拼一句「联想」写回冷区，标 hot=0、权重低、u 以「（联想）」开头
 *
 * 目的：给记忆库加噪声，让联想有不确定性，像人一样不是每次都精确命中。
 *
 * 用法：
 *   node ruminate.js [--count 2] [--dry]
 */

import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DB_PATH = String(process.env.WHALE_DB ?? join(homedir(), '.dsh', 'whale-memory', 'memory.db'))
const EMBED_URL = String(process.env.EMBED_URL ?? 'http://127.0.0.1:8377')
/** 每次最多生成几条联想。 */
const DEFAULT_COUNT = 2
/** 联想条目的起始权重（比真实对话低，所以会先被合并掉）。 */
const RUMINATION_WEIGHT = 0.8

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const countArg = args.indexOf('--count')
const count = countArg >= 0 ? Math.max(1, parseInt(args[countArg + 1] ?? '2', 10)) : DEFAULT_COUNT

/** BLOB → Float32Array。 */
function blobToVec(blob) {
  if (!blob || blob.length === 0) return null
  const n = blob.length / 4
  const out = new Float32Array(n)
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.length)
  for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true)
  return out
}

/** 余弦。 */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

/** 调嵌入服务。 */
async function embed(texts) {
  try {
    const res = await fetch(`${EMBED_URL}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.vectors.map((v) => Float32Array.from(v))
  } catch {
    return null
  }
}

/** 从记忆文本里挑一个「像实体」的词作为联想的连接点。
 *
 * 难点：中文没有空格，机械切 n-gram 会切出「最近天天」这种半截词。
 * 折中做法：优先取能当名词的片段——
 *   - 先按标点/空格分句，只在短句里找
 *   - 排除以副词、连词、代词开头的片段
 *   - 优选中段偏后的片段（中文话题词常在句中）
 */
function pickEntity(text) {
  const s = String(text ?? '')
  // 分句后取整个短句，而不是硬切 n-gram。
  // 中文没有词边界，机械切片必然切出半截词；整句反而更难出错。
  const clauses = s
    .split(/[，。,.!?？；;\n]/u)
    .map((c) => c.trim())
    .filter((c) => c.length >= 3 && c.length <= 18)
    .filter((c) => /[\u4e00-\u9fa5]/u.test(c))

  if (clauses.length === 0) return null
  // 每句裁掉开头的时间/人称前缀，留下更像「事情」的部分
  const cleaned = clauses
    .map((c) => c.replace(/^(最近|今天|明天|昨天|现在|我们|你们|他们|上次|那天|突然)/u, '').trim())
    .filter((c) => c.length >= 3)

  if (cleaned.length === 0) return null
  const pool = cleaned.length > 4 ? cleaned.slice(0, 4) : cleaned
  return pool[Math.floor(Math.random() * pool.length)]
}

async function main() {
  if (!(await import('node:fs')).existsSync(DB_PATH)) {
    console.log('记忆库不存在，跳过')
    return 0
  }
  // 和宿主抢同一把写锁：默认 timeout 是 0，一碰就 database is locked。
  // 给 5 秒缓冲，并且失败时由下面的重试兜一层。
  const db = new DatabaseSync(DB_PATH, { timeout: 5000 })
  db.exec('PRAGMA busy_timeout = 5000')

  // 只从冷区、且非联想产生的条目里挑
  const cold = db.prepare(`
    SELECT id,u,a,t,w,emo,vec FROM entries
    WHERE hot=0 AND u NOT LIKE '（联想）%'
    ORDER BY RANDOM() LIMIT 12
  `).all()

  if (cold.length < 2) {
    console.log(`冷区记忆不足（${cold.length} 条），跳过`)
    db.close()
    return 0
  }

  const withVec = cold.map((r) => ({ r, vec: blobToVec(r.vec), emo: JSON.parse(r.emo || '[]') }))

  // 找一对「有点相关但不完全相同」的记忆：余弦在 0.4~0.8 之间
  let pair = null
  let bestMid = Infinity
  for (let i = 0; i < withVec.length; i++) {
    for (let j = i + 1; j < withVec.length; j++) {
      const a = withVec[i], b = withVec[j]
      const sim = a.vec && b.vec ? cosine(a.vec, b.vec) : 0
      if (sim < 0.4 || sim > 0.8) continue
      // 越接近 0.6 越理想：既相关又不重复
      const mid = Math.abs(sim - 0.6)
      if (mid < bestMid) { bestMid = mid; pair = [a, b] }
    }
  }

  if (!pair) {
    // 没有合适的向量对，退化为随机抽两条做弱关联
    const shuffled = withVec.sort(() => Math.random() - 0.5)
    pair = [shuffled[0], shuffled[1]]
  }

  const [p1, p2] = pair
  const e1 = pickEntity(p1.r.u)
  const e2 = pickEntity(p2.r.u)
  if (!e1 && !e2) {
    console.log('抽不到实体词，跳过')
    db.close()
    return 0
  }

  const templates = [
    `这两件事好像有点关系：${e1 ?? '一件'}那次，和${e2 ?? '另一件'}那次。`,
    `突然想起${e1 ?? '某件事'}，不知道跟${e2 ?? '另一件事'}是不是同一回事。`,
    `${e1 ?? '这事'}过了这么久，还是偶尔会想起来。和${e2 ?? '别的事'}搅在一起了。`,
    `如果把${e1 ?? '那件事'}和${e2 ?? '这件事'}连起来看，好像能看出点什么。`,
  ]
  const thought = templates[Math.floor(Math.random() * templates.length)]

  const entries = []
  for (let i = 0; i < count; i++) {
    const t = i === 0 ? thought : `${thought}（第${i + 1}个念头）`
    const vecs = await embed([t])
    entries.push({
      u: `（联想）${t}`,
      a: `（这是独处时自己冒出来的念头，不是用户说的话）`,
      t: Date.now(),
      w: RUMINATION_WEIGHT,
      emo: JSON.stringify([...new Set([...p1.emo, ...p2.emo])]),
      vec: vecs?.[0] ?? null,
    })
  }

  if (dry) {
    console.log('DRY RUN，将写入：')
    for (const e of entries) console.log(' ', e.u)
    db.close()
    return 0
  }

  const f32ToBlob = (vec) => {
    if (!vec) return null
    const bytes = new Uint8Array(vec.length * 4)
    const dv = new DataView(bytes.buffer)
    for (let i = 0; i < vec.length; i++) dv.setFloat32(i * 4, vec[i], true)
    return bytes
  }

  const ins = db.prepare('INSERT INTO entries(u,a,t,w,emo,vec,hot) VALUES(?,?,?,?,?,?,0)')
  for (const e of entries) ins.run(e.u, e.a, e.t, e.w, e.emo, f32ToBlob(e.vec))
  db.prepare('INSERT INTO stats(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=v+?')
    .run('ruminated', entries.length, entries.length)

  console.log(`写入 ${entries.length} 条联想：`)
  for (const e of entries) console.log(' ', e.u)
  db.close()
  return 0
}

/**
 * 跑一次；锁没抢到就退避重试，最多三次。
 *
 * 定时任务失败一次不值得让 systemd 记成 failed，重试完还不行再报。
 *
 * @returns {Promise<number>} 退出码
 */
async function runWithRetry(attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await main()
    } catch (e) {
      const locked = String(e?.message ?? '').includes('database is locked')
      if (!locked || i === attempts - 1) throw e
      const wait = 1000 * (i + 1)
      console.log(`库被占着，${wait}ms 后重试（第 ${i + 1} 次）`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  return 0
}

runWithRetry().then((code) => process.exit(code)).catch((e) => {
  console.error('ruminate 失败:', e.message)
  process.exit(1)
})
