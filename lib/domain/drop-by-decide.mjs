/**
 * 定时叫醒 · 判定逻辑（纯函数，不碰文件、不碰时钟、不碰 ctx）
 * ============================================================================
 * 2026-11-08：从独立插件 dsh-drop-by 的 lib/decide.js 原样搬进来，逻辑一字未改。
 *
 * 谁来决定「什么时候开口」？——模型。这里只做三件枯燥的事：
 *   ① 把配置洗干净（配置可能活引用，每次现读）；
 *   ② 看预约到点没有、闲置够不够久；
 *   ③ 把防抖（同一分钟 / 每小时上限 / 暂停）挡在前面。
 *
 * 其余（写状态、叫醒会话、注册工具）都在 lib/domain/drop-by.mjs。
 */

export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000

export const DEFAULTS = Object.freeze({
  enabled: true,
  // 多久看一次表（分钟）
  intervalMinutes: 20,
  // 安静多久算「闲得够久」（分钟）
  idleMinutes: 45,
  // 两次叫醒之间至少隔多久（分钟）：防止一次没说话就每个 tick 都再来一遍
  minGapMinutes: 45,
  // 一小时最多叫醒几次，超了就停到下一个整点
  maxPerHour: 6,
  // 免打扰时段（小时，24 制；from === to 表示不管）
  quietFrom: 2,
  quietTo: 8,
  // 预约的时长范围（分钟）
  appointmentMinMinutes: 5,
  appointmentMaxMinutes: 240,
})

const num = (value, fallback, min, max) => {
  const raw = typeof value?.get === 'function' ? value.get() : value
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

const bool = (value, fallback) => {
  const raw = typeof value?.get === 'function' ? value.get() : value
  return typeof raw === 'boolean' ? raw : fallback
}

/**
 * 把配置归一化。字段可能是 schemastery 的活引用（.get()），所以每次都现读。
 * @param {object} raw 插件配置
 * @returns {{enabled:boolean,intervalMinutes:number,idleMinutes:number,minGapMinutes:number,maxPerHour:number,quietFrom:number,quietTo:number,appointmentMinMinutes:number,appointmentMaxMinutes:number}}
 */
export function normalizeConfig(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: bool(c.enabled, DEFAULTS.enabled),
    intervalMinutes: num(c.intervalMinutes, DEFAULTS.intervalMinutes, 1, 240),
    idleMinutes: num(c.idleMinutes, DEFAULTS.idleMinutes, 1, 1440),
    minGapMinutes: num(c.minGapMinutes, DEFAULTS.minGapMinutes, 1, 1440),
    maxPerHour: Math.trunc(num(c.maxPerHour, DEFAULTS.maxPerHour, 1, 60)),
    quietFrom: Math.trunc(num(c.quietFrom, DEFAULTS.quietFrom, 0, 24)),
    quietTo: Math.trunc(num(c.quietTo, DEFAULTS.quietTo, 0, 24)),
    appointmentMinMinutes: Math.trunc(num(c.appointmentMinMinutes, DEFAULTS.appointmentMinMinutes, 1, 1440)),
    appointmentMaxMinutes: Math.trunc(num(c.appointmentMaxMinutes, DEFAULTS.appointmentMaxMinutes, 1, 1440)),
  }
}

/** 下一个整点（防抖超限时停到这儿）。 */
export function nextHourStart(now) {
  const d = new Date(now)
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  return d.getTime()
}

/** 最近一小时内真正触发过几次（顺便丢掉过期的记录）。 */
export function recentFires(state, now) {
  const log = Array.isArray(state?.fireLog) ? state.fireLog : []
  return log
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t > 0 && now - t < HOUR_MS)
    .sort((a, b) => a - b)
}

/**
 * 免打扰：from === to 视为不启用。
 * from < to 是普通区间，from > to 是跨零点（例如 23 → 8）。
 */
export function inQuietHours(now, cfg) {
  const from = Math.trunc(cfg.quietFrom)
  const to = Math.trunc(cfg.quietTo)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false
  const hour = new Date(now).getHours()
  return from < to ? hour >= from && hour < to : hour >= from || hour < to
}

/** 「最近一次互动」= 别人说的 / 我说的 / 插件起来的，取最晚那个。 */
export function activityAt(state) {
  return Math.max(
    Number(state?.otherAt ?? 0) || 0,
    Number(state?.selfAt ?? 0) || 0,
    Number(state?.startedAt ?? 0) || 0,
  )
}

/**
 * 该不该叫醒。
 *
 * 不叫醒时返回 reason，方便自测和日志对账；叫醒时带 kind（appointment / idle）。
 * 纯函数：不改 state，只读。
 *
 * @param {object} state 落盘状态
 * @param {number} now 毫秒时间戳
 * @param {object} cfg normalizeConfig() 的结果
 * @returns {{wake:boolean,kind:'appointment'|'idle'|null,reason:string,why?:string,idleMinutes?:number,pauseUntil:number,fires:number[]}}
 */
export function decide(state, now, cfg) {
  const fires = recentFires(state, now)
  const pauseUntil = Number(state?.pausedUntil ?? 0) || 0
  const skip = (reason, extra = {}) => ({ wake: false, kind: null, reason, pauseUntil, fires, ...extra })

  if (!cfg.enabled) return skip('disabled')
  // 防抖①：同一分钟只触发一次
  if (now - (Number(state?.lastFiredAt ?? 0) || 0) < MINUTE_MS) return skip('same-minute')
  // 防抖②：被停到整点
  if (pauseUntil > now) return skip('paused')
  // 防抖③：一小时配额用光 → 停到下一个整点
  if (fires.length >= cfg.maxPerHour) return { ...skip('hourly-cap'), pauseUntil: nextHourStart(now) }

  // 预约优先：这是模型自己排的时间，到点就醒。
  const nextAt = Number(state?.nextAt ?? 0) || 0
  if (nextAt > 0 && now >= nextAt) {
    // 预约之后有人说话了 → 这轮已经续上了，预约作废
    if ((Number(state?.otherAt ?? 0) || 0) > (Number(state?.nextSetAt ?? 0) || 0)) {
      return skip('superseded')
    }
    return { wake: true, kind: 'appointment', reason: 'appointment', why: String(state?.nextWhy ?? ''), pauseUntil, fires }
  }

  // 闲置：安静够久了，而且离上次叫醒也隔够了
  const idleMs = now - activityAt(state)
  if (idleMs < cfg.idleMinutes * MINUTE_MS) return skip('not-idle')
  if (now - (Number(state?.lastFiredAt ?? 0) || 0) < cfg.minGapMinutes * MINUTE_MS) return skip('min-gap')
  if (inQuietHours(now, cfg)) return skip('quiet-hours')
  return { wake: true, kind: 'idle', reason: 'idle', idleMinutes: Math.round(idleMs / MINUTE_MS), pauseUntil, fires }
}

/**
 * 预约：模型通过工具自己排时间。返回新状态（不改入参）。
 *
 * @param {object} state 当前状态
 * @param {number} now 毫秒时间戳
 * @param {number} minutes 多少分钟后（cfg.appointmentMinMinutes..appointmentMaxMinutes）
 * @param {string} why 一句话理由
 * @param {object} cfg normalizeConfig() 的结果
 * @returns {{state:object, at:number}} at = 到点时间戳
 */
export function scheduleAppointment(state, now, minutes, why, cfg) {
  const m = Math.trunc(Number(minutes))
  if (!Number.isFinite(m) || m < cfg.appointmentMinMinutes || m > cfg.appointmentMaxMinutes) {
    throw new Error(
      `minutes 必须是 ${cfg.appointmentMinMinutes}–${cfg.appointmentMaxMinutes} 之间的整数（收到 ${String(minutes)}）`,
    )
  }
  const at = now + m * MINUTE_MS
  return {
    at,
    state: {
      ...state,
      nextAt: at,
      nextWhy: String(why ?? '').trim().slice(0, 200),
      nextSetAt: now,
      // 排了新预约就把「停到整点」解开：这是显式要求，不是自动触发
      pausedUntil: 0,
    },
  }
}

/** 触发之后记一笔：时间、次数、清掉已用掉的预约。不改入参。 */
export function afterFire(state, now, kind) {
  const fires = [...recentFires(state, now), now]
  return {
    ...state,
    lastFiredAt: now,
    fireLog: fires.slice(-40),
    // 闲置唤醒等于「我自己开口了」，把闲置线拉到此刻，免得下个 tick 又判闲
    selfAt: kind === 'idle' ? now : (Number(state.selfAt ?? 0) || 0),
    nextAt: 0,
    nextWhy: '',
    nextSetAt: 0,
  }
}

/** 预约作废（被别人打断），只清预约，不动别的。 */
export function clearAppointment(state) {
  return { ...state, nextAt: 0, nextWhy: '', nextSetAt: 0 }
}
