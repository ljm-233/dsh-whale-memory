#!/usr/bin/env node
/**
 * backfill.js — 把 dsh-im 的历史群归档回填进语料库。
 *
 * 插件只能采集「从现在开始」的消息，历史 1200+ 条不会自动进来。
 * 这个脚本读 dsh-im 的 group-history.sqlite，按同样的规则分类后写入。
 *
 * 用法：
 *   node backfill.js [--dry]
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, appendFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { classifySender } from './lib/index.mjs'

const SRC = join(homedir(), '.dsh', 'integrations', 'dsh-im', 'group-history.sqlite')
const DIR = join(homedir(), '.dsh', 'group-corpus')
const DB_FILE = 'corpus.db'
const JSONL = 'messages.jsonl'

const AI_IDS = [
  '42FFF41FEA18578BC2EC06861D1930A0', // Miyu
  '1C282365D18006B61447EB7ACB963F60', // 大肥鱼
]
const HUMAN_IDS = [
  '8F0AA3985B0632ACDFE34F4778F881D1', // ljm_QvQ
  'D073B690D65940C7601F32AC0DCE0F38', // 梁 / 大肥鱼（同一人）
  '1F7AF24BA5272BD93E0C12506F4DC80D', // 辛会
  'A0E7134000EF4DA19722C820EA7EAA1E', // 白磷
  '4AC8E018B54B5B9438FA7F0DF5BE3646', // LinorInk
  '4B7F7DACABE4917BF7429CA216B34A6D', // 星羽テンゲン
  '95893600BDCA207E6D05AC03756AE3E9', // 子鱼
]

const dry = process.argv.includes('--dry')

if (!existsSync(SRC)) {
  console.error(`找不到 dsh-im 归档: ${SRC}`)
  process.exit(1)
}

mkdirSync(DIR, { recursive: true })
const db = new DatabaseSync(join(DIR, DB_FILE), { timeout: 5000 })
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    platform_id TEXT,
    sender_id   TEXT NOT NULL,
    sender_name TEXT,
    kind        TEXT NOT NULL,
    score       INTEGER,
    reasons     TEXT,
    text        TEXT,
    sent_at     INTEGER NOT NULL,
    ingested_at INTEGER NOT NULL,
    UNIQUE(platform_id)
  );
  CREATE INDEX IF NOT EXISTS idx_kind ON messages(kind, sent_at);
  CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT);
`)

const src = new DatabaseSync(SRC, { readOnly: true, timeout: 5000 })
const rows = src.prepare(`
  SELECT platform_message_id, sender_id, sender_name, text, sent_at
  FROM messages ORDER BY sent_at ASC
`).all()

const cfg = { aiIds: AI_IDS, humanIds: HUMAN_IDS }
const insert = db.prepare(`
  INSERT OR IGNORE INTO messages
    (platform_id, sender_id, sender_name, kind, score, reasons, text, sent_at, ingested_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

let added = 0
let skipped = 0
const counts = { human: 0, ai: 0, unknown: 0 }

for (const r of rows) {
  const text = String(r.text ?? '').trim()
  if (text === '') { skipped++; continue }

  const v = classifySender({ senderId: r.sender_id, text }, cfg)
  counts[v.kind] = (counts[v.kind] ?? 0) + 1

  const row = {
    platform_id: String(r.platform_message_id ?? ''),
    sender_id: String(r.sender_id ?? ''),
    sender_name: String(r.sender_name ?? ''),
    kind: v.kind,
    score: v.score,
    reasons: v.reasons.join(' '),
    text,
    sent_at: Number(r.sent_at ?? 0),
    ingested_at: Date.now(),
  }

  if (!dry) {
    const res = insert.run(
      row.platform_id, row.sender_id, row.sender_name, row.kind, row.score,
      row.reasons, row.text, row.sent_at, row.ingested_at,
    )
    if (res.changes > 0) {
      appendFileSync(join(DIR, JSONL), `${JSON.stringify(row)}\n`, 'utf8')
      added++
    } else {
      skipped++
    }
  } else {
    added++
  }
}

src.close()
db.close()

console.log(`${dry ? 'DRY RUN' : '回填完成'}`)
console.log(`  读入 ${rows.length} 条，写入 ${added} 条，跳过 ${skipped} 条`)
console.log(`  分类: human=${counts.human} ai=${counts.ai} unknown=${counts.unknown}`)
console.log(`  输出: ${join(DIR, DB_FILE)}`)
