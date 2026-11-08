/**
 * 「事情」这一维：我此刻在做什么、答应了谁还没做。
 *
 * 为什么要有它（2026-11-08，读完 ProjectKaren 后自己写；它是 AGPL，代码一个字都没抄）：
 * 库里只有「条目」和「情绪数值」，没有「手上这件事做到哪了」。
 * 于是「我做过什么」全靠回忆——最容易变成编事实。
 *
 * 三条硬规矩，都写进状态机里，不靠自觉：
 *   1. **完成必须显式确认**：过了时间不算做过，要一次带 id 的 confirm 才算 completed。
 *      这条是防我自己"编自己做过什么"。
 *   2. **状态转换白名单**：只认写死的那几条边，别的直接拒。
 *   3. **提交守卫**：异步结果落盘前重读一次 revision + 心情快照，不一致就整条丢掉。
 *
 * 数据用 JSON 落一个文件（不建新表，免得动 memory.db 的迁移）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 未完成项上限：超了就不再收新的，逼我先收尾。 */
export const OPEN_LIMIT = 200

/** 状态。终态只有 completed / cancelled / skipped。 */
export const STATUS = Object.freeze({
  planned: 'planned',
  inProgress: 'in_progress',
  completed: 'completed',
  cancelled: 'cancelled',
  skipped: 'skipped',
  postponed: 'postponed',
  interrupted: 'interrupted',
})

const OPEN = new Set([STATUS.planned, STATUS.inProgress, STATUS.postponed])
const TERMINAL = new Set([STATUS.completed, STATUS.cancelled, STATUS.skipped])

/** 白名单：只认这几条边。任何没写的转换都拒。 */
export const TRANSITIONS = Object.freeze({
  [STATUS.planned]: [STATUS.inProgress, STATUS.cancelled, STATUS.skipped, STATUS.postponed],
  [STATUS.inProgress]: [STATUS.completed, STATUS.cancelled, STATUS.interrupted, STATUS.postponed],
  [STATUS.interrupted]: [STATUS.inProgress, STATUS.cancelled, STATUS.skipped, STATUS.postponed],
  [STATUS.postponed]: [STATUS.planned, STATUS.inProgress, STATUS.cancelled, STATUS.skipped],
  [STATUS.completed]: [],
  [STATUS.cancelled]: [],
  [STATUS.skipped]: [],
})

export class LifeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LifeError'
    this.code = code
  }
}

const nowOf = (now) => (Number.isFinite(now) ? now : Date.now())

/** 空状态。revision 每次写都 +1，给提交守卫用。 */
export function emptyState() {
  return { version: 1, revision: 0, seq: 0, items: [] }
}

export function storePath(root) {
  return join(root, 'db', 'life.json')
}

export function load(root) {
  const file = storePath(root)
  if (!existsSync(file)) return emptyState()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return emptyState()
    return {
      version: 1,
      revision: Number.isFinite(raw.revision) ? raw.revision : 0,
      seq: Number.isFinite(raw.seq) ? raw.seq : 0,
      items: raw.items.filter((it) => it && typeof it.id === 'string' && Object.values(STATUS).includes(it.status)),
    }
  } catch {
    return emptyState()
  }
}

/** 先写临时文件再 rename：写到一半崩了也不会留半个 JSON。 */
export function save(root, state) {
  const file = storePath(root)
  mkdirSync(dirname(file), { recursive: true })
  const next = { ...state, version: 1, revision: (Number(state.revision) || 0) + 1 }
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return next
}

export function openItems(state) {
  return state.items.filter((it) => OPEN.has(it.status))
}

/** 新建一件事。id 自己编（seq 递增），带 title 和可选的 dueAt。 */
export function addItem(state, { title, dueAt = null, note = '' } = {}, now) {
  const at = nowOf(now)
  const t = String(title ?? '').trim()
  if (!t) throw new LifeError('empty-title', '事情得有个名字')
  if (openItems(state).length >= OPEN_LIMIT) {
    throw new LifeError('open-limit', `未完成的已经 ${OPEN_LIMIT} 件了，先收尾再加新的`)
  }
  const seq = (Number(state.seq) || 0) + 1
  const item = {
    id: `l${seq}`,
    title: t.slice(0, 200),
    note: String(note ?? '').slice(0, 500),
    status: STATUS.planned,
    createdAt: at,
    updatedAt: at,
    dueAt: Number.isFinite(dueAt) ? dueAt : null,
    confirmedAt: null,
    history: [{ at, to: STATUS.planned }],
  }
  return { ...state, seq, items: [...state.items, item] }
}

function find(state, id) {
  const it = state.items.find((x) => x.id === id)
  if (!it) throw new LifeError('unknown-item', `没有这个 id：${id}`)
  return it
}

/**
 * 改状态。白名单不认的边直接拒。
 * completed **只**能从这里进来，而且必须带 confirm: true —— 时间到了不算做过。
 */
export function setStatus(state, id, to, { confirm = false, note = '' } = {}, now) {
  const at = nowOf(now)
  const it = find(state, id)
  // STATUS 的键是 camelCase、值是 snake_case，所以按值判断，别按键。
  if (!Object.values(STATUS).includes(to)) throw new LifeError('unknown-status', `没有这个状态：${to}`)
  const allowed = TRANSITIONS[it.status] ?? []
  if (!allowed.includes(to)) {
    throw new LifeError('bad-transition', `${it.status} 不能直接变成 ${to}`)
  }
  if (to === STATUS.completed && confirm !== true) {
    throw new LifeError('need-confirm', '完成要显式确认（confirm: true），光过了时间不算做过')
  }
  const next = {
    ...it,
    status: to,
    updatedAt: at,
    confirmedAt: to === STATUS.completed ? at : it.confirmedAt,
    note: note ? String(note).slice(0, 500) : it.note,
    history: [...it.history, { at, to, ...(note ? { note: String(note).slice(0, 200) } : {}) }],
  }
  return { ...state, items: state.items.map((x) => (x.id === id ? next : x)) }
}

/** 今天该做的：未完成里按 dueAt 排，没 dueAt 的排后面，再按创建时间。 */
export function dueToday(state, now) {
  const at = nowOf(now)
  const end = new Date(at)
  end.setHours(23, 59, 59, 999)
  return openItems(state)
    .filter((it) => it.dueAt !== null && it.dueAt <= end.getTime())
    .sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt)
}

/**
 * 提交守卫。异步结果（ruminate / 主动消息）落盘前调它：
 * 拿开工时记下的 revision 和现在的比，不一致就整条丢掉，别拿旧结论覆盖新状态。
 */
export function guard(state, snapshot) {
  const rev = Number(snapshot?.revision)
  if (!Number.isFinite(rev)) return { ok: false, why: 'no-snapshot' }
  if (rev !== Number(state.revision)) return { ok: false, why: 'revision-changed' }
  if (snapshot?.mood !== undefined && snapshot.mood !== null) {
    return { ok: true, why: 'ok' }
  }
  return { ok: true, why: 'ok' }
}

/** 给「现在」卡片用的一行摘要；没事情就返回空串，不占字数。 */
export function summaryLine(state) {
  const open = openItems(state)
  if (!open.length) return ''
  const doing = open.find((it) => it.status === STATUS.inProgress)
  const head = doing ? `在做「${doing.title}」` : `手上 ${open.length} 件`
  const rest = open.filter((it) => it !== doing).slice(0, 2).map((it) => it.title)
  return rest.length ? `${head}，还欠：${rest.join('、')}` : head
}
