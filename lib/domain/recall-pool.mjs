/**
 * 记忆卡的候选池：冷区三条臂（最近 / 关键词 / 随机）拼出「这一轮有哪些旧事可挑」。
 *
 * 纯 SQL 构造，无副作用、不读配置；挑哪些、怎么排序交给 `recall-score.mjs`。
 * `coldPoolOf` 导出是为了 `scripts/probe-recall.mjs` 量的是真东西，别在脚本里抄 SQL。
 *
 * @module recall-pool
 */
import { cueWords } from '../language.mjs'

/**
 * 冷区候选的列：`imp`（重要性人工覆盖）和 `cites`（被引用次数）都不是每个库都有的。
 * 缺了就当 NULL / 0——少两列原料，也比整段联想起不来强。每个库探一次就够（WeakMap 跟着库走）。
 */
const COLD_COLS = new WeakMap()

/**
 * 关键词臂的词：4 字（最具体）+ 2 字（最能兜住换过说法的旧话）+ 拉丁词，最多 14 个。
 *
 * 直接用 `cueWords` 那套 n-gram（它本来就是给「这一句在说什么」用的），不另造分词。
 * 取 4 字和 2 字、跳过 3 字：4 字取多了才有覆盖面（词表是按顺序排的，只取前 4 个会全是句首
 * 「上次说的」这类前缀噪声），而换过说法的旧话（「自己会梳理记忆」对「自己梳理记忆」）
 * 只有 2 字能兜住。实测 5 条旧条目全部落在关键词臂的前 3 名。
 * `%` `_` 是 LIKE 通配符，出现在词里就剥掉——宁可少匹配一个词，也不要让一个词变成通配。
 *
 * @param {string} text 用户说的话
 * @returns {string[]}
 */
export const kwTermsOf = (text) => {
  const all = cueWords(text).map((w) => String(w).replace(/[%_]/gu, '')).filter((w) => w !== '')
  const pick = (test, n) => all.filter(test).slice(0, n)
  return [
    ...pick((w) => w.length === 4, 6),
    ...pick((w) => w.length === 2, 6),
    ...pick((w) => /[a-z]/.test(w), 2),
  ]
}

/**
 * 关键词臂的 SQL 与参数：按「命中了几个词」排序（k DESC），同分才按时间。
 *
 * 为什么按命中词数而不是按 t：热门词（「上次」「自己」）能命中几百条，
 * 按时间取前 200 会被新的挤满，旧的那条照样丢；命中词数才是「这条有多贴这句话」。
 */
export const kwArmOf = (sp, terms) => {
  if (terms.length === 0) return null
  const pats = terms.flatMap((t) => [`%${t}%`, `%${t}%`])
  const likes = terms.map(() => '(u LIKE ? OR a LIKE ?)').join(' OR ')
  const kExpr = terms.map(() => '(u LIKE ?)+(a LIKE ?)').join('+')
  return {
    sql: `SELECT id FROM (SELECT id, (${kExpr}) AS k FROM entries
            WHERE hot=0 AND space=? AND (${likes})
            ORDER BY k DESC, t ASC LIMIT 200)`,
    args: [...pats, sp, ...pats],
  }
}

/**
 * 冷区候选：条目少（≤300）就全取最近 300；多了就取「最近 200 + 关键词命中 ≤200 + 随机 100」。
 *
 * 只用「最近 300」时，真库里所有条目都在七天内 ⇒ time 轴恒为 1.00，换场景没感。
 *
 * 关键词臂（0.28.21 加）：真库冷区 2300+ 条，老条目既进不了「最近 200」，被随机 100 抽中的
 * 概率也只有 ~4%——「十天前说过什么」在**候选池**这一层就丢了，跟打分无关。
 * 这一臂只负责「别丢」，排序照旧交给三轴；没词可取就退回两臂。
 *
 * 导出是为了 scripts/probe-recall.mjs 量的是真东西：把这段 SQL 抄进脚本里，
 * 改代码时它就会悄悄走散（这次差点就拿抄来的旧 SQL 量出一张假表）。
 *
 * @param {object} db 数据库
 * @param {string} sp 空间
 * @param {string} text 这一次用户说的话（关键词臂用它的 n-gram）
 * @returns {{stmt:object, args:any[]}}
 */
export const coldPoolOf = (db, sp, text = '') => {
  if (!COLD_COLS.has(db)) {
    const columnExists = (table, col) => {
      try { return db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().some((c) => c.name === col) } catch { return false }
    }
    const tableExists = (name) => {
      try { return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined } catch { return false }
    }
    const imp = columnExists('entries', 'imp') ? 'imp' : 'NULL AS imp'
    const hits = columnExists('entries', 'hits') ? 'hits' : '0 AS hits'
    const tier = columnExists('entries', 'tier') ? 'tier' : '0 AS tier'
    const cites = tableExists('entry_evidence')
      ? '(SELECT COUNT(*) FROM entry_evidence v WHERE v.entry_id = entries.id) AS cites'
      : '0 AS cites'
    COLD_COLS.set(db, `id,u,a,t,w,emo,vec,${tier},${hits},${imp},${cites}`)
  }
  const cols = COLD_COLS.get(db)
  const coldTotal = (() => {
    try { return db.prepare('SELECT COUNT(*) c FROM entries WHERE hot=0 AND space=?').get(sp)?.c ?? 0 } catch { return 0 }
  })()
  if (coldTotal <= 300) {
    return {
      stmt: db.prepare(`SELECT ${cols} FROM entries WHERE hot=0 AND space=? ORDER BY t DESC LIMIT 300`),
      args: [sp],
    }
  }
  const kw = kwArmOf(sp, kwTermsOf(text))
  const stmt = db.prepare(`SELECT ${cols} FROM entries WHERE id IN (
      SELECT id FROM (SELECT id FROM entries WHERE hot=0 AND space=? ORDER BY t DESC LIMIT 200)
      ${kw === null ? '' : `UNION ${kw.sql}`}
      UNION
      SELECT id FROM (SELECT id FROM entries WHERE hot=0 AND space=? ORDER BY RANDOM() LIMIT 100)
    )`)
  return { stmt, args: kw === null ? [sp, sp] : [sp, ...kw.args, sp] }
}
