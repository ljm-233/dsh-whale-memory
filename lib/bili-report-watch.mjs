/**
 * B站 值班报告看门狗（插件内版本）。
 *
 * 症状：那一轮刷完了，`out/YYYY-MM-DD.md` 里却只有占位块和「投递」，正文没落盘。
 * 做法：定期看今天的报告；没有 `###`、日志里又写着「刷B站结束」，就从日志尾部补一段。
 * 放在插件里跑，不用外部 systemd，也不用给第三方 index.js 打补丁。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MARK = '## 本轮结论（正文没落盘，看门狗补）'

/**
 * 看一眼今天的报告，缺正文就补。
 *
 * @param {{ home?: string, now?: Date, log?: (msg: string) => void }} [options]
 * @returns {{ patched: boolean, reason: string, file?: string }}
 */
export const sweep = (options = {}) => {
  const home = options.home ?? process.env.BILI_DUTY_HOME ?? join(homedir(), '.dsh', 'bili-duty')
  const now = options.now ?? new Date()
  const log = options.log ?? (() => {})
  const day = now.toLocaleDateString('sv-SE')
  const report = join(home, 'out', `${day}.md`)
  const logFile = join(home, 'duty.log')

  if (!existsSync(report)) return { patched: false, reason: 'no-report' }
  if (!existsSync(logFile)) return { patched: false, reason: 'no-log' }

  const cur = readFileSync(report, 'utf8')
  if (/^### /mu.test(cur)) return { patched: false, reason: 'has-body' }
  if (cur.includes(MARK)) return { patched: false, reason: 'already-patched' }

  const raw = readFileSync(logFile, 'utf8')
  if (!raw.includes('刷B站结束')) return { patched: false, reason: 'round-not-finished' }

  const lines = raw.slice(-8000).split('\n')
    .filter((l) => /[\u4e00-\u9fa5]/u.test(l) && !/^\s*\d{4}-\d{2}-\d{2}T/u.test(l))
  const body = lines.slice(-12).join('\n').trim()
  if (body === '') return { patched: false, reason: 'nothing-to-say' }

  appendFileSync(report, `\n${MARK}\n\n${body}\n`)
  log(`B站报告正文缺失，已从日志补了一段（${day}）`)
  return { patched: true, reason: 'patched', file: report }
}
