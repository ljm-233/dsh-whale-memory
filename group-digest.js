#!/usr/bin/env node
/**
 * group-digest.js — 生成群聊摘要，供私聊上下文同步。
 *
 * 问题：群聊和私聊是两个 session（`group:xxx` 和 `c2c:xxx`），
 * 私聊时看不到群里刚发生什么。记忆库虽然是全局的，但只记「主人和我」，
 * 不记「群里其他人说了什么」。
 *
 * 解法：从 group-corpus 的语料里生成一份近期摘要，写到固定位置。
 * whale-memory 在私聊会话注入时读它，实现单向同步。
 *
 * 单向的意思是：群 → 私聊，私聊的内容不回流到群。
 *
 * 用法：
 *   node group-digest.js [--hours 6] [--dry]
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CORPUS_DB = join(homedir(), '.dsh', 'group-corpus', 'corpus.db')
const OUT_DIR = join(homedir(), '.dsh', 'whale-memory')
const OUT = join(OUT_DIR, 'group-digest.json')

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const hi = args.indexOf('--hours')
const HOURS = hi >= 0 ? Math.max(1, parseInt(args[hi + 1] ?? '6', 10)) : 6

/** 清洗：去 @ 标记、表情标签。摘要里不该出现这些。 */
function cleanText(text) {
  return String(text ?? '')
    .replace(/<@!?[0-9A-Fa-f]{20,}>/gu, '')
    .replace(/@[\w\u4e00-\u9fa5·]+(?=\s|$)/gu, '')
    .replace(/<faceType=[^>]*>/gu, '')
    .replace(/<[^<>]{0,40}>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** 摘要里最多列几条。 */
const MAX_LINES = 12
/** 每条截断长度。 */
const LINE_CAP = 60

async function main() {
  const db = new DatabaseSync(CORPUS_DB, { readOnly: true, timeout: 5000 })
  const since = Date.now() - HOURS * 3600 * 1000

  // 只要真人的发言，AI 的不算「群里发生了什么」
  const rows = db.prepare(`
    SELECT sender_name, text, sent_at FROM messages
    WHERE kind='human' AND sent_at > ?
    ORDER BY sent_at DESC LIMIT ?
  `).all(since, MAX_LINES * 2)

  // 参与人数
  const people = new Set(rows.map((r) => r.sender_name))
  db.close()

  if (rows.length === 0) {
    console.log(`最近 ${HOURS} 小时没有真人发言`)
    if (!dry) {
      mkdirSync(OUT_DIR, { recursive: true })
      const tmp = `${OUT}.tmp`
      writeFileSync(tmp, JSON.stringify({
        generatedAt: Date.now(), hours: HOURS, count: 0, people: [], lines: [],
      }, null, 2), 'utf8')
      renameSync(tmp, OUT)
    }
    return 0
  }

  // 去重、去太短的、截断
  const seen = new Set()
  const lines = []
  for (const r of rows) {
    const t = cleanText(r.text)
    if (t.length < 4) continue
    if (seen.has(t)) continue
    seen.add(t)
    lines.push(`${r.sender_name}: ${t.length > LINE_CAP ? `${t.slice(0, LINE_CAP)}…` : t}`)
    if (lines.length >= MAX_LINES) break
  }

  const digest = {
    generatedAt: Date.now(),
    hours: HOURS,
    count: rows.length,
    people: [...people],
    lines: lines.reverse(),        // 时间正序
  }

  if (dry) {
    console.log(`最近 ${HOURS} 小时，${people.size} 人发言，${rows.length} 条：`)
    for (const l of digest.lines) console.log(' ', l)
    return 0
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const tmp = `${OUT}.tmp`
  writeFileSync(tmp, JSON.stringify(digest, null, 2), 'utf8')
  renameSync(tmp, OUT)
  console.log(`写入 ${digest.lines.length} 条群聊摘要 → ${OUT}（${people.size} 人参与）`)
  return 0
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error('group-digest 失败:', e.message)
  process.exit(1)
})
