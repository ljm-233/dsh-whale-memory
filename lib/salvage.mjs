/**
 * 压缩抢救：把即将被压掉的历史变成长期记忆，顺手存一份完整存档。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildArchiveDoc, splitForIm, clamp, textOf } from './format.mjs'
import { pairShadowed } from './session.mjs'
import { parseJudgement, readPolicy } from './policy.mjs'
import { detectEmotions } from './language.mjs'
import { vecToBlob } from './vector.mjs'

/**
 * 造压缩抢救相关的函数。
 *
 * @param {object} deps
 * @param {object} deps.db 记忆库
 * @param {Function} deps.askModel 调模型
 * @param {Function} deps.embedTexts 嵌入
 * @param {Function} deps.archiveEnabled 存档开关
 * @param {Function} deps.archiveDir 存档目录
 * @param {Function} deps.archiveNotify 私发配置
 * @param {Function} deps.resolveNotifyTarget 找私发目标
 * @param {Function} deps.sendIm 发消息（可空）
 * @param {Function} deps.bumpStat 计数
 * @returns {{salvageCompacted:Function, archiveCompaction:Function}}
 */
export function createSalvage(deps) {
  const {
    db, askModel, embedTexts, archiveEnabled, archiveDir, archiveNotify,
    resolveNotifyTarget, sendIm, bumpStat,
  } = deps

  /**
   * 压缩存档：把压缩摘要 + 被压缩掉的聊天记录汇成一份文档。
   *
   *   1. 写进 archives/YYYYMMDD-HHmmss-<会话>.md
   *   2. 复制一份私发给主人
   *
   * 落盘是主路径，私发是附带——发失败不影响存档。
   *
   * @param {object} session 会话
   * @param {object} data compaction/summary 载荷
   * @param {Array<{u:string,a:string}>} pairs 被压缩掉的对话
   */
  const archiveCompaction = async (session, data, pairs) => {
    const at = new Date()
    const sid = String(session?.id ?? 'unknown')
    const p2 = (n) => String(n).padStart(2, '0')
    const stamp = `${at.getFullYear()}${p2(at.getMonth() + 1)}${p2(at.getDate())}-${p2(at.getHours())}${p2(at.getMinutes())}${p2(at.getSeconds())}`
    const doc = buildArchiveDoc({
      at,
      sessionId: sid,
      summary: textOf({ content: data.summary ?? [] }),
      tokens: Number(data.shadowedTokenCount ?? 0),
      pairs,
    })

    let path = ''
    try {
      const dir = archiveDir()
      mkdirSync(dir, { recursive: true })
      path = join(dir, `${stamp}-${sid.replace(/^session-/, '').replace(/[^\w-]/gu, '').slice(0, 8)}.md`)
      writeFileSync(path, doc, 'utf8')
      bumpStat('archived')
    } catch {
      return { saved: false, sent: false }
    }

    let sent = false
    if (archiveNotify().enabled && typeof sendIm === 'function') {
      const nt = await resolveNotifyTarget()
      if (nt) {
        try {
          for (const part of splitForIm(doc, path)) {
            await sendIm(nt.botId, nt.targetId, part, { format: 'plain' })
          }
          sent = true
          bumpStat('archiveSent')
        } catch { /* 发不出去就算了，文件已经在了 */ }
      }
    }

    return { saved: true, sent, path }
  }

  /**
   * 备份记忆库。
   *
   * 用 `VACUUM INTO` 做原子快照：不用停服务，产出的是一份完整独立的库。
   * 备份完立刻开一次做完整性检查，坏的当场发现——备份的意义在于能恢复，
   * 不是有个文件在那儿。
   *
   * @param {{force?:boolean}} [opts]
   * @returns {{ok:boolean, path?:string, bytes?:number, entries?:number, reason?:string}}
   */
  /**
   * 压缩前抢救：把即将被压缩掉的原文蒸馏成长期记忆。
   *
   * 原理：`compaction/summary` 事件带 `shadowedSeqs`（被替换的表面节点序号），
   * 但这些原文仍留在会话日志里，`session.eventAt(seq)` 能取回。
   * 取回后按块蒸馏成「一句话记忆」，写进冷区——以后靠情绪/线索还能想起。
   *
   * 这样压缩掉的不是记忆，只是上下文。像人一样：具体对话忘了，但那件事记得。
   *
   * @param {object} session 会话（提供 eventAt）
   * @param {object} data compaction/summary 的载荷
   */
  const salvageCompacted = async (session, data) => {
    const seqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : []
    if (seqs.length === 0) return

    // 1. 从日志取回原文，配成 (用户, 助手) 对
    const pairs = pairShadowed((seq) => session.eventAt?.(seq), seqs)
    if (pairs.length === 0) return

    // 1.5 先把整份存档落盘 + 私发主人（不阻塞下面的蒸馏）
    if (archiveEnabled()) {
      archiveCompaction(session, data, pairs).catch(() => undefined)
    }

    // 2. 每 CHUNK 轮蒸馏成一条记忆
    const CHUNK = 8
    let saved = 0
    let dropped = 0
    for (let i = 0; i < pairs.length; i += CHUNK) {
      const chunk = pairs.slice(i, i + CHUNK)
      const raw = chunk
        .map((p) => `用户: ${clamp(p.u, 120)}${p.a === '' ? '' : ` → 你: ${clamp(p.a, 120)}`}`)
        .join('\n')

      // 让模型先判断「值不值得留」，再压成一句话。
      // 判断依据里带上我自己写的取舍倾向——这段经历要不要留，我也该有发言权。
      const policy = readPolicy(db)
      let verdict = { keep: true, line: '' }
      const distilled = await askModel(
        [
          '下面是一段即将被压缩掉的对话。先判断它值不值得留下，再压成一句话。',
          policy === '' ? '' : `\n我自己定的取舍倾向：${policy}`,
          '',
          `对话：\n${raw}`,
          '',
          '只输出 JSON，不要解释：',
          '{"keep": true 或 false, "line": "不超过 40 字的中文，写下这段发生了什么；keep 为 false 时留空"}',
          '值得留的是：做过的决定、改过的东西、吃过的亏、我在意的事。',
          '不值得留的是：纯粹的寒暄、工具输出的重复回显、已经被后面结果覆盖的中间过程。',
        ].filter((x) => x !== '').join('\n'),
        300,
      )
      verdict = parseJudgement(distilled)

      if (verdict.keep === false) {
        dropped += 1
        continue
      }

      let line = verdict.line
      if (line === '') {
        // 机械兜底：第一条用户消息 + 轮数
        const first = chunk[0]?.u ?? ''
        line = `${chunk.length} 轮对话，起于「${clamp(first, 24)}」`
      }

      const vec = (await embedTexts([line]))?.[0] ?? null
      db.prepare('INSERT INTO entries(u,a,t,w,emo,vec,hot) VALUES(?,?,?,?,?,?,0)').run(
        `（归档）${line}`,
        `（压缩前的一段对话，已被压缩出上下文；这是它的大意）\n${clamp(raw, 200)}`,
        Date.now(),
        2,               // 起始权重低，靠反复被想起才变重
        JSON.stringify(detectEmotions(raw)),
        vecToBlob(vec),
      )
      saved += 1
    }
    if (saved > 0) bumpStat('salvaged')
    if (dropped > 0) {
      for (let i = 0; i < dropped; i += 1) bumpStat('forgotten')
    }
  }

  return { salvageCompacted, archiveCompaction }
}
