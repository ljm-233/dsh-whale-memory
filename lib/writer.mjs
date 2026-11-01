/**
 * 交互落库：一轮说完，把这一问一答整理成一条记忆。
 *
 * 包含热区挤占、冷区合并、硬上限兜底——都是「记得住但不撑爆」的部分。
 */
const AUTO_MERGE = false
import { PART_CAP, COLD_MAX, IMPORTANT_WEIGHT, WEIGHT_DECAY_PER_TURN, DIARY_INJECT_MAX } from './constants.mjs'
import { detectEmotions, extractFacts, cosine, overlap } from './language.mjs'
import { recordFact } from './facts.mjs'
import { clamp } from './format.mjs'
import { vecToBlob, blobToVec, embedTexts } from './vector.mjs'

/**
 * 造交互记录器。
 *
 * @param {object} deps 依赖
 * @returns {{setUser:Function, setAssistant:Function, flush:Function}}
 */
export function createWriter(deps) {
  const {
    db, bumpStat, recentPairs, factMax, space, hotMax = () => 30,
  } = deps
  const spaceOf = () => String(space?.() ?? 'default')

  let pendingUser = ''
  let pendingAssistant = ''

  /** 记下这一轮用户说了什么。 */
  const setUser = (text) => { pendingUser = text }
  /** 记下这一轮助手说了什么。 */
  const setAssistant = (text) => { pendingAssistant = text }

  const flush = async () => {
    if (pendingUser === '' && pendingAssistant === '') return
    const emotions = detectEmotions(pendingUser)
    const vec = pendingUser !== '' ? (await embedTexts([pendingUser]))?.[0] ?? null : null

    const insert = db.prepare('INSERT INTO entries(u,a,t,w,emo,vec,hot,space) VALUES(?,?,?,?,?,?,1,?)')
    insert.run(
      clamp(pendingUser, PART_CAP),
      clamp(pendingAssistant, PART_CAP),
      Date.now(),
      1 + emotions.length * 0.5,
      JSON.stringify(emotions),
      vecToBlob(vec),
      spaceOf(),
    )

    if (pendingUser !== '') {
      const space = spaceOf()
      // 改口不再并排躺着：旧事实盖上 valid_until，新事实顶上，冲突留一行痕迹。
      for (const f of extractFacts(pendingUser)) recordFact(db, { text: f, space })
      const n = db.prepare('SELECT COUNT(*) c FROM facts WHERE space=?').get(space).c
      if (n > factMax()) {
        db.prepare('DELETE FROM facts WHERE id IN (SELECT id FROM facts WHERE space=? ORDER BY id ASC LIMIT ?)')
          .run(space, n - factMax())
      }
    }

    // 超出热区的降温：上限用 hotMax（设置页可调），排序按权重再按时间，
    // 和 recomputeTiers 同序；以前误用注入窗口 recentPairs()=4，热区永远只剩 4 条。
    const hotCount = db.prepare('SELECT COUNT(*) c FROM entries WHERE hot=1').get().c
    const hotCap = hotMax()
    if (hotCount > hotCap) {
      db.prepare(`
        UPDATE entries SET hot=0 WHERE id IN (
          SELECT id FROM entries WHERE hot=1 ORDER BY w ASC, t ASC LIMIT ?
        )`).run(hotCount - hotCap)
      // 降下来的同步降层级，保持 hot 与 tier 同源
      db.prepare('UPDATE entries SET tier = 1 WHERE hot = 0 AND tier = 0').run()
    }

    // 轻度衰减
    db.prepare(`UPDATE entries SET w = MAX(1, w - ${WEIGHT_DECAY_PER_TURN}) WHERE hot=0 AND w > 1`).run()

    // 合并：低权重按向量聚类，高权重不动
    const coldCount = db.prepare('SELECT COUNT(*) c FROM entries WHERE hot=0').get().c
    // 自动合并默认关闭：中文短句极易过相似阈值，一次能吞掉几百条，且不可逆。
    // 需要时用 scripts/memory-tidy.mjs 手动跑（先备份）。
    if (AUTO_MERGE && coldCount > COLD_MAX / 2) {
      const important = db.prepare('SELECT id,u,a,t,w,emo FROM entries WHERE hot=0 AND w >= ?').all(IMPORTANT_WEIGHT)
      const mergeable = db.prepare('SELECT id,u,a,t,w,emo,vec FROM entries WHERE hot=0 AND w < ? ORDER BY t ASC').all(IMPORTANT_WEIGHT)
      const used = new Set()
      const survivors = []
      for (let i = 0; i < mergeable.length; i++) {
        if (used.has(i)) continue
        const base = mergeable[i]
        const baseVec = blobToVec(base.vec)
        const group = [base]
        used.add(i)
        for (let j = i + 1; j < mergeable.length; j++) {
          if (used.has(j)) continue
          const other = mergeable[j]
          const ov = baseVec && blobToVec(other.vec)
            ? cosine(baseVec, blobToVec(other.vec))
            : overlap(base.u, other.u)
          if (ov > 0.62) {        // 余弦相似到 0.62 视为同质，可合并
            group.push(other)
            used.add(j)
          }
        }
        if (group.length === 1) {
          survivors.push(base.id)
        } else {
          group.sort((a, b) => `${b.u}${b.a}`.length - `${a.u}${a.a}`.length)
          const head = group[0]
          const rest = group.slice(1)
          db.prepare('UPDATE entries SET a = ?, w = ?, emo = ? WHERE id = ?').run(
            `${head.a}\n（另有 ${rest.length} 次相近经历，已合并：${rest.map((r) => clamp(r.u, 30)).join('；')}）`,
            Math.max(...group.map((g) => g.w ?? 1)),
            JSON.stringify([...new Set(group.flatMap((g) => JSON.parse(g.emo || '[]')))]),
            head.id,
          )
          for (const r of rest) db.prepare('DELETE FROM entries WHERE id = ?').run(r.id)
          survivors.push(head.id)
          bumpStat('merged')
        }
      }
      // 硬上限兜底
      const still = db.prepare('SELECT COUNT(*) c FROM entries WHERE hot=0').get().c
      if (still > COLD_MAX) {
        db.prepare(`DELETE FROM entries WHERE id IN (
          SELECT id FROM entries WHERE hot=0 AND w < ? ORDER BY t ASC LIMIT ?
        )`).run(IMPORTANT_WEIGHT, still - COLD_MAX)
      }
    }

    pendingUser = ''
    pendingAssistant = ''
  }

  return { setUser, setAssistant, flush }
}
