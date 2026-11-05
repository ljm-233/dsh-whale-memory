/**
 * 记忆分层（第二层自动落盘 / 第三层周记）的配置读取。
 *
 * 设置页里改的就是这份配置，`scripts/dump-group.mjs` 和 `scripts/weekly-digest.mjs`
 * 都从这里取，不各写一套默认值。
 *
 * 取值优先级：`--config <file.json>`（显式指定，测试用）> 活动 profile 的
 * `cordis.patch.yml` 里 `- id: dsh-whale-memory` 那段 > 这里的默认值。
 *
 * 不引 YAML 库（零依赖是这仓库的底线）：只认本插件那一段的缩进键值。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 唯一一份默认值。 */
export const LAYER_DEFAULTS = {
  groupDump: { enabled: true, intervalMinutes: 10, dir: '~/.dsh/miyu/logs' },
  weekly: { enabled: true, startDay: 1 },
}

const DEFAULT_PROFILE = () => join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml')

/** 展开 `~`；相对路径相对家目录。 */
export function expandHome(p) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  if (s === '~') return homedir()
  if (s.startsWith('~/')) return join(homedir(), s.slice(2))
  return resolve(s)
}

const scalar = (raw) => {
  const s = raw.trim()
  if (!s) return ''
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if (/^(['"]).*\1$/.test(s)) return s.slice(1, -1)
  return s
}

/**
 * 从 cordis patch 里抽本插件 `config:` 那段，拍平成 `a.b.c -> 值`。
 * 只认 `- id: dsh-whale-memory` 到下一个顶层条目之间的行。
 */
export function readProfileYamlFlat(file) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n')
    const from = lines.findIndex((l) => /^-\s*id:\s*dsh-whale-memory\s*$/.test(l))
    // 没有 `- id:` 的裸配置（--config 直接给一段 yml）就整份当 config 块
    return from < 0 ? readConfigBlock(lines, 0, -1) : readConfigBlock(lines, from + 1, null)
  } catch {
    return {}
  }
}

/** 从 start 行往后读 config 块；configIndent 为 null 表示「找 config: 那行」。 */
function readConfigBlock(lines, start, configIndent) {
  {
    const out = {}
    const stack = [] // [{ indent, key }]
    let inConfig = configIndent !== null
    for (const line of lines.slice(start)) {
      if (/^-\s/.test(line)) break // 下一个插件条目
      if (!line.trim() || /^\s*#/.test(line)) continue
      const indent = line.length - line.trimStart().length
      const m = /^(.+?):(?:\s*(.*))?$/.exec(line.trim())
      if (!m) continue
      const key = m[1].trim()
      const val = m[2] ?? ''
      if (!inConfig) {
        if (key === 'config') {
          inConfig = true
          configIndent = indent
        }
        continue
      }
      if (indent <= configIndent) break
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
      if (val === '') {
        stack.push({ indent, key })
      } else {
        out[[...stack.map((s) => s.key), key].join('.')] = scalar(val)
      }
    }
    return out
  }
}

/** JSON 配置（测试/手工）也拍平成同一套点号键。 */
export function readJsonFlat(file) {
  try {
    const walk = (obj, prefix, out) => {
      for (const [k, v] of Object.entries(obj ?? {})) {
        const path = prefix ? `${prefix}.${k}` : k
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path, out)
        else out[path] = v
      }
      return out
    }
    return walk(JSON.parse(readFileSync(file, 'utf8')), '', {})
  } catch {
    return {}
  }
}

/**
 * 读配置。返回解析好的、带绝对路径的一份，脚本直接拿去用。
 *
 * @param {{configFile?:string, profileFile?:string}} [opts]
 */
export function loadLayerConfig(opts = {}) {
  const configFile = opts.configFile ?? ''
  const profileFile = opts.profileFile ?? DEFAULT_PROFILE()
  let flat = {}
  let source = 'defaults'
  if (configFile && existsSync(configFile)) {
    // .json 走 JSON；其余当 yml（跟 profile 那份同一套解析）
    flat = /\.json$/i.test(configFile) ? readJsonFlat(configFile) : readProfileYamlFlat(configFile)
    source = `file:${configFile}`
  } else if (existsSync(profileFile)) {
    const fromProfile = readProfileYamlFlat(profileFile)
    if (Object.keys(fromProfile).length) {
      flat = fromProfile
      source = `profile:${profileFile}`
    }
  }

  const get = (path, def) => {
    const v = flat[path]
    return v === undefined || v === '' ? def : v
  }
  const bool = (path, def) => {
    const v = get(path, def)
    return v === true || v === 'true' || v === 1 || v === '1'
  }
  const int = (path, def, min, max) => {
    const n = Math.trunc(Number(get(path, def)))
    if (!Number.isFinite(n)) return def
    return Math.min(max, Math.max(min, n))
  }

  const dirRaw = get('groupDump.dir', LAYER_DEFAULTS.groupDump.dir)
  // 显式配了目录就听配置的；没配时 MIYU_BASE 还能顶上来（离线测试/换机器用）
  const envBase = process.env.MIYU_BASE ?? ''
  const dir =
    dirRaw === LAYER_DEFAULTS.groupDump.dir && envBase
      ? join(resolve(envBase), 'logs')
      : expandHome(dirRaw)

  return {
    source,
    groupDump: {
      enabled: bool('groupDump.enabled', LAYER_DEFAULTS.groupDump.enabled),
      intervalMinutes: int('groupDump.intervalMinutes', LAYER_DEFAULTS.groupDump.intervalMinutes, 1, 1440),
      dir,
    },
    weekly: {
      enabled: bool('weekly.enabled', LAYER_DEFAULTS.weekly.enabled),
      startDay: int('weekly.startDay', LAYER_DEFAULTS.weekly.startDay, 1, 7),
    },
  }
}
