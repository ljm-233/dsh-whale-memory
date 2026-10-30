/**
 * 取舍倾向与「这段要不要留」的解析。
 */

const POLICY_KEY = 'memory_policy'

/**
 * 读当前的取舍倾向。没有就返回空串。
 *
 * @param {DatabaseSync} db 记忆库
 * @returns {string}
 */
export function readPolicy(db) {
  try {
    const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(POLICY_KEY)
    return String(row?.v ?? '')
  } catch {
    return ''
  }
}

/**
 * 写下取舍倾向。压缩时这段文字会参与「留不留」的判断。
 *
 * @param {DatabaseSync} db 记忆库
 * @param {string} text 倾向描述
 * @returns {string} 存下来的内容（已截断）
 */
export function writePolicy(db, text) {
  const body = String(text ?? '').replace(/\s+/gu, ' ').trim().slice(0, 600)
  db.prepare(`
    INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v
  `).run(POLICY_KEY, body)
  return body
}

/**
 * 解析「这段要不要留」的回答。
 *
 * 模型偶尔会带解释或多层包裹，所以先找 JSON，再退回逐行判断。
 * 解析不出来就当作「要留」，宁可多记一条，也不要因为格式问题把经历丢了。
 *
 * @param {string|null} raw 模型输出
 * @returns {{keep:boolean, line:string}}
 */
export function parseJudgement(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { keep: true, line: '' }

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      const line = String(parsed.line ?? '').replace(/\s+/gu, ' ').trim().slice(0, 60)
      const keep = parsed.keep !== false
      if (line !== '' || keep === false) return { keep, line }
    } catch { /* 落到下面的兜底 */ }
  }

  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? ''
  return { keep: true, line: firstLine.replace(/\s+/gu, ' ').slice(0, 60) }
}

/**
 * 读共享时间线：最近发生过什么，不分窗口。
 *
 * @param {DatabaseSync} db 记忆库
 * @param {object} opts
 * @param {number} [opts.hours] 只看最近几小时
 * @param {'any'|'user'|'assistant'|'tool'} [opts.kind] 只看某一类
 * @param {string} [opts.session] 只看某个会话
 * @param {number} [opts.limit] 最多几条，1–200，默认 30
 * @returns {Array<{at:number, session:string, window:string, kind:string, text:string}>}
 */
