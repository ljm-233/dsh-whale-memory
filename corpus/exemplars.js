#!/usr/bin/env node
/**
 * exemplars.js — 从真人语料里挑出「说话范例」。
 *
 * 难点：群里的消息一大半是在给 AI 下命令（「你可以添加一个戳戳」），
 * 那些不能当说话范例——学来只会变得更像指挥者。
 *
 * 所以要做两轮筛选：
 *   1. 排掉指令句（含「你」「给我」「请你」开头，或祈使动词）
 *   2. 保留「自足的表达」：感叹、吐槽、闲聊、陈述
 *
 * 输出到 exemplars.json，供 style hint 使用。
 *
 * 用法：
 *   node exemplars.js [--count 12] [--dry]
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cleanText } from './lib/index.mjs'

const DB_PATH = join(homedir(), '.dsh', 'group-corpus', 'corpus.db')
const OUT = join(homedir(), '.dsh', 'group-corpus', 'exemplars.json')

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const ci = args.indexOf('--count')
const count = ci >= 0 ? Math.max(3, parseInt(args[ci + 1] ?? '12', 10)) : 12

/** 指令句特征：这些不是「说话」，是「下命令」。 */
const IMPERATIVE_PATTERNS = [
  /^你[^，。]{0,10}(帮|给|做|加|改|看|查|试|写|弄|跑|算)/u,
  /^(帮|给|请|麻烦|试试|看看|查查|算算)/u,
  /(吗|吧|呢)$/u,                        // 问句/请求句，不是表达
  /^(切换|添加|删除|修改|打开|关闭|启动|停止)/u,
  /(可以|能不能|可不可以)[^，。]{0,8}(吗|么)/u,
  // 点名某个 bot 再下命令：这类是「指令 + 称呼」，不是说话
  /^(肥鱼|大肥鱼|miyu|Miyu|鲸鱼娘)[，,：:]\s*(打开|关闭|帮我|给我|做|加|改|查|试|写|弄|跑|算)/u,
  // 祈使开头：直接以动词起句的多半是命令
  /^(打开|关闭|启动|停止|播放|暂停|查一下|看一下|试一下|跑一下)/u,
  // 功能需求句（「可以加个…」「能不能…」）
  /(加个|添加一个|做一个|改成|换成|调成)/u,
]

/** 自足表达特征：感叹、吐槽、陈述——这些才是「像人说话」。 */
const EXPRESSIVE_PATTERNS = [
  { re: /(累|困|烦|气|难受|崩|唉|哎)/u, w: 2 },
  { re: /(哈哈|笑死|绝了|真的|太|好家伙)/u, w: 2 },
  { re: /(我|咱|俺)/u, w: 1 },
  { re: /[！!…]/u, w: 1 },
]

/**
 * 判断一条消息能不能当「说话范例」。
 * @param {string} text 已清洗
 * @returns {{ok: boolean, reason: string, score: number}}
 */
export function judgeExemplar(text) {
  const t = String(text ?? '').trim()
  if (t.length < 6 || t.length > 40) return { ok: false, reason: 'length', score: 0 }
  // 单句才算范例：出现多个句末标点说明是复合句
  if ((t.match(/[。！？!?]/gu) ?? []).length > 1) return { ok: false, reason: 'multi-sentence', score: 0 }

  // 必须基本是中文（含标点），别把代码和路径混进来
  if (!/^[\u4e00-\u9fa5，。！？、…：；\s]+$/u.test(t)) return { ok: false, reason: 'not-chinese', score: 0 }

  for (const p of IMPERATIVE_PATTERNS) {
    if (p.test(t)) return { ok: false, reason: 'imperative', score: 0 }
  }

  let score = 0
  for (const f of EXPRESSIVE_PATTERNS) {
    if (f.re.test(t)) score += f.w
  }

  // 纯重复字符（哈哈哈哈哈哈）不算范例，学不到东西
  if (/(.)\1{4,}/u.test(t)) return { ok: false, reason: 'repetitive', score: 0 }

  // 完全没表达性的平铺陈述，也给个基础分（有时平淡的句子也像人）
  if (score === 0) score = 0.5

  return { ok: score >= 1, reason: 'ok', score }
}

async function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const rows = db.prepare(`
    SELECT sender_name, text, sent_at FROM messages
    WHERE kind='human' ORDER BY sent_at DESC LIMIT 2000
  `).all()

  const seen = new Set()
  const picked = []
  for (const r of rows) {
    const t = cleanText(r.text)
    if (seen.has(t)) continue        // 去重，同样的话说两遍没必要
    const v = judgeExemplar(t)
    if (!v.ok) continue
    seen.add(t)
    picked.push({ name: r.sender_name, text: t, score: v.score, at: r.sent_at })
  }

  // 按分数优先，但保留多样性：太相似的开头只留一条
  picked.sort((a, b) => b.score - a.score)
  const diverse = []
  const prefixes = new Set()
  for (const p of picked) {
    const prefix = p.text.slice(0, 3)
    if (prefixes.has(prefix)) continue
    prefixes.add(prefix)
    diverse.push(p)
    if (diverse.length >= count) break
  }

  db.close()

  if (dry) {
    console.log(`DRY RUN — 候选 ${picked.length} 条，选出 ${diverse.length} 条：`)
    for (const p of diverse) console.log(`  [${p.name}] ${p.text}`)
    return 0
  }

  mkdirSync(join(homedir(), '.dsh', 'group-corpus'), { recursive: true })
  writeFileSync(OUT, JSON.stringify({
    count: diverse.length,
    generatedAt: Date.now(),
    exemplars: diverse.map((p) => ({ name: p.name, text: p.text })),
  }, null, 2), 'utf8')

  console.log(`写入 ${diverse.length} 条范例 → ${OUT}`)
  for (const p of diverse) console.log(`  [${p.name}] ${p.text}`)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c)).catch((e) => {
    console.error('exemplars 失败:', e.message)
    process.exit(1)
  })
}
