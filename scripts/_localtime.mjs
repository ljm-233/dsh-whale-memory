/**
 * 两个导出脚本（`dump-group.mjs`、`weekly-digest.mjs`）共用的本地时间工具。
 *
 * 之前这两段是逐字复制的，改一处忘一处就会让「群档文件名」和「周记窗口」
 * 用上不同的时区/格式化——那种错不会报错，只会悄悄错一天。
 *
 * 口径固定：Asia/Shanghai，+08:00，无夏令时（换算方式与以前完全一致：
 * 先加偏移再看 UTC 字段，不依赖运行机器的 TZ）。
 */

/** Asia/Shanghai 的固定偏移（毫秒）。 */
export const TZ_OFFSET_MS = 8 * 60 * 60 * 1000 // Asia/Shanghai，无夏令时

/** 两位补零。 */
export const p2 = (n) => String(n).padStart(2, '0')

/** epoch 毫秒 → 已经挪到东八区的那根 Date（读它的 UTC 字段就是本地时间）。 */
export const shifted = (ms) => new Date(ms + TZ_OFFSET_MS)

/** epoch 毫秒 → `YYYY-MM-DD`（东八区）。 */
export const dateKey = (ms) => {
  const d = shifted(ms)
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
}

/** epoch 毫秒 → `HH:MM:SS`（东八区）。 */
export const timeKey = (ms) => {
  const d = shifted(ms)
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
}

/**
 * 取 `--name value` 里的那个值；没有这个开关就空串。
 * 默认读 `process.argv`，与两个脚本原来的行为一致。
 *
 * @param {string} name 例如 `--config`
 * @param {string[]} [argv]
 */
export const flagValue = (name, argv = process.argv.slice(2)) => {
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] ?? '') : ''
}
