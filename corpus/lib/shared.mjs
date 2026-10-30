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
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
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
