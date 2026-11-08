/**
 * 纯向量兜底：模型不可用时只按余弦判断重复，把相近的合掉、把空壳删掉。
 *
 * 写库仍然走调用方给的事务包装，跟模型那条路共用一套 inTx / stampConsolidated。
 */
import { IMPORTANT_WEIGHT } from '../constants.mjs'
import { blobToVec } from '../vector.mjs'
import { cosine } from '../language.mjs'

/**
 * 只合余弦 >0.85 的，删掉空壳。
 *
 * @param {object} deps
 * @param {object} deps.db 记忆库
 * @param {Function} deps.inTx 事务包装（里面不许有 await）
 * @param {Function} deps.stampConsolidated 记时间
 * @returns {{merged:number, dropped:number, error?:string}}
 */
export function vectorConsolidate({ db, inTx, stampConsolidated }) {
  const cold = db.prepare(`
    SELECT id,u,a,t,w,vec FROM entries
    WHERE hot=0 AND w < ? AND u NOT LIKE '（联想）%'
    ORDER BY t ASC LIMIT 200
  `).all(IMPORTANT_WEIGHT)

  if (cold.length < 3) return { merged: 0, dropped: 0 }

  const withVec = cold.map((r) => ({ r, vec: blobToVec(r.vec) }))
  const used = new Set()

  try {
    const out = inTx(() => {
      let merged = 0
      for (let i = 0; i < withVec.length; i++) {
        if (used.has(i)) continue
        const group = [withVec[i]]
        used.add(i)
        for (let j = i + 1; j < withVec.length; j++) {
          if (used.has(j)) continue
          if (cosine(withVec[i].vec, withVec[j].vec) > 0.85) { group.push(withVec[j]); used.add(j) }
        }
        if (group.length < 2) continue
        group.sort((a, b) => `${b.r.u}${b.r.a}`.length - `${a.r.u}${a.r.a}`.length)
        const head = group[0]
        const rest = group.slice(1)
        db.prepare('UPDATE entries SET a = ?, w = ? WHERE id = ?').run(
          `${head.r.a}\n（另有 ${rest.length} 次相近，已合并）`,
          Math.max(...group.map((g) => g.r.w ?? 1)), head.r.id,
        )
        for (const g of rest) db.prepare('DELETE FROM entries WHERE id = ?').run(g.r.id)
        merged += rest.length
      }

      const junk = db.prepare(`
        SELECT id FROM entries WHERE hot=0 AND w < ? AND LENGTH(TRIM(u)) < 3
      `).all(IMPORTANT_WEIGHT)
      for (const j of junk) db.prepare('DELETE FROM entries WHERE id = ?').run(j.id)

      return { merged, dropped: junk.length }
    })
    stampConsolidated()
    return out
  } catch (error) {
    return { merged: 0, dropped: 0, error: String(error?.message ?? error).slice(0, 200) }
  }
}
