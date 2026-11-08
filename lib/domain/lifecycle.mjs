/**
 * 开机自愈、B站报告看门狗、收摊（停表 + 关库）。
 *
 * 原样从 index.mjs 搬出来，只把外层包成 registerLifecycle()。
 */
import { sweep as biliReportSweep } from '../bili-report-watch.mjs'
import { heal as runSelfHeal } from '../selfheal.mjs'

/**
 * @param {object} ctx 插件上下文
 * @param {object} deps 依赖
 * @param {Function} deps.dispose 停表 + 关库
 */
export function registerLifecycle(ctx, { dispose }) {
  // 开机自愈：别人的插件升级把补丁冲掉时，我自己把它们补回来（幂等、不阻塞）
  ctx.effect(() => {
    let alive = true
    runSelfHeal({ log: (m) => console.log('[whale-memory 自愈] ' + m) })
      .catch(() => { /* 自愈失败不影响主流程 */ })
    return () => { alive = false }
  }, 'dsh-whale-memory: self-heal')

  // B站 报告看门狗：第三方插件正文没落盘时，从它的日志补一段（10 分钟一次）
  ctx.effect(() => {
    let timer = null
    try {
      timer = setInterval(() => {
        try { biliReportSweep({ log: (m) => console.log('[whale-memory] ' + m) }) } catch { /* 绝不影响主流程 */ }
      }, 10 * 60 * 1000)
      timer.unref?.()
    } catch { /* 定时器建不起来也不影响 */ }
    return () => { if (timer) clearInterval(timer) }
  }, 'dsh-whale-memory: bili report watch')

  ctx.effect(() => dispose, 'dsh-whale-memory: db close')
}
