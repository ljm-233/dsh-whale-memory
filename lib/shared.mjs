/**
 * 三个插件共用的零碎工具。
 *
 * 这个文件是唯一的源；各包里的 `lib/shared.mjs` 由 scripts/sync-shared.mjs
 * 复制生成，测试会校验三者字节一致。
 *
 * 为什么要复制而不是跨包 import：三个包各自独立发布安装，
 * 互相依赖会让单独装一个就崩。
 */

/**
 * 本地时区的 `YYYY-MM-DD HH:mm`。
 * @param {number} ms 毫秒时间戳
 * @returns {string}
 */
export function localStamp(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 本地日期键 `YYYY-MM-DD`。
 * @param {Date} [d] 时间，默认现在
 * @returns {string}
 */
export function dayKeyOf(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 截断长文。
 * @param {string} text 原文
 * @param {number} n 上限
 * @returns {string}
 */
export function clamp(text, n) {
  const t = String(text ?? '')
  if (t.length <= n) return t
  // 2026-11-11 审计修：原来是按字符硬切，实测切出过 `（`~ 这种半个反引号、
  // 还有 `## 思考` 这种半个标题 —— 模型每轮读到的最后一句都是半截语法。
  // 现在往回退到最近的换行或分号，退得太远（<60%）才接受硬切。
  const cut = t.slice(0, n - 1)
  const k = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('；'))
  return `${(k > n * 0.6 ? cut.slice(0, k) : cut)}…`
}

/**
 * 截断并压平空白（给消息用，不要换行）。
 * @param {string} text 原文
 * @param {number} n 上限
 * @returns {string}
 */
export function clampText(text, n) {
  const t = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

/**
 * 读一项插件配置。声明了 `.volatile()` 的字段是活引用，每次要用 `.get()`。
 * @param {*} v 配置值
 * @param {*} fallback 缺省
 * @returns {*}
 */
export function cfgVal(v, fallback) {
  return v && typeof v.get === 'function' ? (v.get() ?? fallback) : (v ?? fallback)
}

/**
 * 读一项数字配置：缺省或非法回落 fallback（常量），越界夹到边界。
 * @param {*} v 配置值
 * @param {number} fallback 缺省值
 * @param {number} min 下界
 * @param {number} max 上界
 * @param {boolean} [int] 取整
 * @returns {number}
 */
export function numCfg(v, fallback, min, max, int = false) {
  const raw = Number(cfgVal(v, fallback))
  const n = Math.min(max, Math.max(min, Number.isFinite(raw) ? raw : fallback))
  return int ? Math.round(n) : n
}
