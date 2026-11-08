/**
 * 定时叫醒 · 落盘：一个 JSON，原子写（临时文件 + rename）
 * ============================================================================
 * 2026-11-08：从独立插件 dsh-drop-by 的 lib/state.js 搬进来。逻辑未改，
 * 只加了一件事：状态文件默认跟着**记忆库**走（`stateFileFor(memoryDir)`）。
 *
 * 为什么不再固定写 ~/.dsh/integrations/dsh-drop-by/state.json：
 * whale-memory 的每个测试都用一个临时 memoryPath，状态跟着库走就天然隔离——
 * 否则跑一次 test-mood / test-speaker 就会把真实状态里的 otherAt 改成「刚有人
 * 说过话」、把 sessionId 写成测试会话，甚至把待触发的预约清掉。
 * 老文件还在，第一次读不到新文件时会从老位置搬过来（见 loadState）。
 *
 * 目录不存在就 recursive 建，写失败只吞不抛 —— 状态坏掉不该把插件带崩，
 * 大不了这一轮不叫醒。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = (process.env.DSH_HOME ?? '').trim() === ''
  ? join(homedir(), '.dsh')
  : process.env.DSH_HOME.trim()

/** 并进来之前的老位置（还认它，只为了搬家）。 */
export const HOME_DIR = DSH_HOME
export const LEGACY_STATE_DIR = join(DSH_HOME, 'integrations', 'dsh-drop-by')
export const LEGACY_STATE_FILE = join(LEGACY_STATE_DIR, 'state.json')

/**
 * 这次用哪个文件：给了记忆库就用 `<记忆库>/wake/state.json`，
 * 没给（老调用方式）才退回 integrations 那个老位置。
 */
export function stateFileFor(memoryDir) {
  const dir = typeof memoryDir === 'string' ? memoryDir.trim() : ''
  return dir === '' ? LEGACY_STATE_FILE : join(dir, 'wake', 'state.json')
}

/** 状态骨架：字段全给默认值，读的时候按字段合并，老文件缺字段也不会炸。 */
export function emptyState(now = Date.now()) {
  return {
    version: 1,
    startedAt: now,
    // 最近一次「别人」发来的消息
    otherAt: 0,
    // 最近一次我说完
    selfAt: 0,
    // 最近一次叫醒
    lastFiredAt: 0,
    // 近一小时叫醒记录（时间戳数组）
    fireLog: [],
    // 模型自己排的预约
    nextAt: 0,
    nextWhy: '',
    nextSetAt: 0,
    // 防抖超限后停到这儿
    pausedUntil: 0,
    // 要叫醒哪个会话
    sessionId: '',
    // 累计触发次数（只给人看）
    visits: 0,
  }
}

const FIELDS = Object.keys(emptyState(0))

/**
 * 读状态；文件坏了 / 没有都退化成空状态。
 *
 * 搬家兼容：新位置没有、老位置有 → 读老的那份（下一次 save 就写到新位置）。
 */
export function loadState(file = LEGACY_STATE_FILE, now = Date.now()) {
  const base = emptyState(now)
  try {
    if (!existsSync(file)) {
      if (file !== LEGACY_STATE_FILE && existsSync(LEGACY_STATE_FILE)) return loadState(LEGACY_STATE_FILE, now)
      return base
    }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw === null || typeof raw !== 'object') return base
    const out = { ...base }
    for (const key of FIELDS) {
      if (raw[key] === undefined) continue
      out[key] = raw[key]
    }
    if (!Array.isArray(out.fireLog)) out.fireLog = []
    return out
  } catch {
    return base
  }
}

/** 原子写：同目录临时文件 → rename。目录不存在先建。 */
export function saveState(state, file = LEGACY_STATE_FILE) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}
