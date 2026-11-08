/**
 * 眼睛 · 抓摄像头一帧
 * ============================================================================
 * 2026-11-08：从独立插件 dsh-eye 的 lib/capture.js 原样搬进来（逻辑一字未改，
 * 只换了文件名和下面的单跑入口）。不依赖宿主服务，可以直接
 * `node lib/domain/eye-capture.mjs` 单跑。
 *
 * 处理两个真问题：
 *   ① 摄像头刚打开的头几帧常常全黑 / 全绿 —— 默认多抓几帧，只留最后一帧；
 *   ② 同一时刻只能有一个 ffmpeg 占设备 —— 用锁文件排队，第二个调用不会
 *      撞出「Device or resource busy」。
 *
 * 任何失败都**返回**结构化结果（{ ok:false, error, detail }），不抛异常。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, unlink,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh')

export const INTEGRATION_DIR = join(DSH_HOME, 'integrations', 'dsh-eye')
export const SHOTS_DIR = join(INTEGRATION_DIR, 'shots')
export const LOCK_FILE = join(INTEGRATION_DIR, 'capture.lock')

export const DEFAULTS = {
  device: '/dev/video0',
  size: '640x480',
  /** 开机丢帧时长（毫秒）。摄像头约 30fps，120ms ≈ 丢 4 帧。 */
  warmupMs: 120,
  /** 等别人放锁最多多久（毫秒）。 */
  lockWaitMs: 8_000,
  /** 一次抓帧的总超时（毫秒）。已验证 25s 够用。 */
  timeoutMs: 25_000,
  /** 保留最近几张。 */
  keep: 20,
}

const FRAME_MS = 33
const LOCK_STALE_MS = 60_000

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

const fail = (error, detail) => ({ ok: false, error, detail: String(detail ?? '') })

/** 把 `640x480` 这类尺寸说清楚；不认识就用默认值并说明。 */
export function normalizeSize(input, fallback = DEFAULTS.size) {
  const raw = typeof input === 'string' ? input.trim().toLowerCase() : ''
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(raw)
  if (match === null) {
    return { size: fallback, width: Number(fallback.split('x')[0]), height: Number(fallback.split('x')[1]), note: raw === '' ? '' : `尺寸「${input}」不认识，用了默认 ${fallback}` }
  }
  const width = Number(match[1])
  const height = Number(match[2])
  if (width < 16 || height < 16 || width > 7680 || height > 4320) {
    return { size: fallback, width: Number(fallback.split('x')[0]), height: Number(fallback.split('x')[1]), note: `尺寸 ${raw} 超出范围，用了默认 ${fallback}` }
  }
  return { size: `${width}x${height}`, width, height, note: '' }
}

/** warmupMs → 要丢掉的帧数。摄像头没有「等一会儿再拍」的开关，等价物就是丢帧。 */
export function discardFrames(warmupMs) {
  const ms = Number.isFinite(Number(warmupMs)) ? Math.max(0, Number(warmupMs)) : DEFAULTS.warmupMs
  return Math.min(90, Math.round(ms / FRAME_MS))
}

/** 从 JPEG 的 SOF 段读真实宽高（比信 `-video_size` 靠谱，设备可能不认你给的尺寸）。 */
export function jpegDimensions(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) { offset += 1; continue }
    const marker = buf[offset + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
    const length = buf.readUInt16BE(offset + 2)
    if (length < 2) return null
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  return null
}

function stamp(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}`
}

/** 拿锁：成功 true，超时 false，其它 IO 错误照原样扔给调用方分类。 */
async function acquireLock(lockFile, waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs)
  for (;;) {
    try {
      await mkdir(dirname(lockFile), { recursive: true })
      const handle = await open(lockFile, 'wx')
      try { await handle.writeFile(String(process.pid)) } finally { await handle.close() }
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // 上一次抓到一半被杀了会留下没人删的锁 —— 超过一分钟就当废纸撕掉。
      try {
        const info = await stat(lockFile)
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) { await unlink(lockFile); continue }
      } catch { continue }
      if (Date.now() >= deadline) return false
      await sleep(120)
    }
  }
}

async function releaseLock(lockFile) {
  try { await unlink(lockFile) } catch { /* 没锁可删也算放掉了 */ }
}

/** 跑一次 ffmpeg，绝不抛：把超时、spawn 失败、退出码全收进结果里。 */
function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let stderr = ''
    let timedOut = false
    const finish = (value) => { if (!settled) { settled = true; resolve(value) } }

    let child
    try {
      child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      finish({ spawnError: error, stderr, timedOut: false })
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* 已经死了 */ }
      // 真 ffmpeg 被杀会立刻 close；但如果 stderr 管道被别的子进程攥着，
      // close 可能迟迟不来 —— 给半秒就不再等，超时就得是超时的样子。
      setTimeout(() => finish({ code: null, stderr, timedOut }), 500)
    }, Math.max(1_000, timeoutMs))

    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 8_000) stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ spawnError: error, stderr, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code, stderr, timedOut })
    })
  })
}

/** ffmpeg 的报错文本 → 我们自己的四类错误。 */
function classify(stderr, timedOut) {
  if (timedOut) return { error: 'timeout', detail: 'ffmpeg 没有在超时时间内返回（设备可能在半死状态）' }
  const text = stderr.trim()
  if (/device or resource busy|resource busy|EBUSY/i.test(text)) {
    return { error: 'busy', detail: '摄像头正被别的进程（或另一个抓帧）占着' }
  }
  if (/no such file or directory|no such device|ENODEV|cannot open device/i.test(text)) {
    return { error: 'no-device', detail: '找不到这个摄像头设备（合盖、外接屏切换、或者设备号变了）' }
  }
  return { error: 'ffmpeg', detail: text === '' ? 'ffmpeg 退出但没留下错误信息' : text.split('\n').slice(-6).join('\n') }
}

/** 只留最近 `keep` 张。失败就安静失败，不耽误已经抓到的图。 */
export async function pruneShots(shotsDir = SHOTS_DIR, keep = DEFAULTS.keep) {
  try {
    const names = (await readdir(shotsDir)).filter((name) => name.endsWith('.jpg')).sort()
    const overflow = names.slice(0, Math.max(0, names.length - keep))
    for (const name of overflow) {
      try { await unlink(join(shotsDir, name)) } catch { /* 别的进程先删了 */ }
    }
    return overflow.length
  } catch {
    return 0
  }
}

/**
 * 抓一帧。
 * @param {object} options
 * @param {string} [options.device] v4l2 设备，默认 /dev/video0
 * @param {string} [options.size] 'WxH'，默认 640x480
 * @param {number} [options.warmupMs] 丢帧时长，默认 120
 * @param {number} [options.timeoutMs] 总超时
 * @param {number} [options.lockWaitMs] 等锁时长
 * @param {number} [options.keep] 保留几张
 * @param {string} [options.shotsDir] 覆盖输出目录（测试用）
 * @returns {Promise<{ok:true,path:string,width:number,height:number,bytes:number,at:string,note:string}|{ok:false,error:string,detail:string}>}
 */
export async function capture(options = {}) {
  const device = typeof options.device === 'string' && options.device.trim() !== '' ? options.device.trim() : DEFAULTS.device
  const { size, note } = normalizeSize(options.size)
  const warmupMs = Number.isFinite(Number(options.warmupMs)) ? Number(options.warmupMs) : DEFAULTS.warmupMs
  const discard = discardFrames(warmupMs)
  const frames = discard + 1
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : DEFAULTS.timeoutMs
  const lockWaitMs = Number.isFinite(Number(options.lockWaitMs)) ? Number(options.lockWaitMs) : DEFAULTS.lockWaitMs
  const keep = Number.isFinite(Number(options.keep)) ? Number(options.keep) : DEFAULTS.keep
  const shotsDir = typeof options.shotsDir === 'string' && options.shotsDir !== '' ? options.shotsDir : SHOTS_DIR

  if (!existsSync(device)) return fail('no-device', `${device} 不存在`)

  let locked = false
  try {
    locked = await acquireLock(LOCK_FILE, lockWaitMs)
  } catch (error) {
    return fail('busy', `拿不到抓帧锁：${error?.message ?? error}`)
  }
  if (!locked) return fail('busy', `排队 ${lockWaitMs}ms 还没轮到（另一个抓帧一直没放锁）`)

  let work = ''
  try {
    await mkdir(shotsDir, { recursive: true })
    work = await mkdtemp(join(tmpdir(), 'dsh-eye-'))
    const pattern = join(work, 'f-%03d.jpg')

    const result = await runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-f', 'v4l2',
      '-video_size', size,
      '-i', device,
      '-frames:v', String(frames),
      '-y', pattern,
    ], timeoutMs)

    if (result.spawnError !== undefined) {
      return fail('ffmpeg', `起不来 ffmpeg：${result.spawnError?.message ?? result.spawnError}`)
    }
    if (result.timedOut) return fail('timeout', 'ffmpeg 超时未返回（设备可能在半死状态）')

    const produced = (await readdir(work)).filter((name) => name.endsWith('.jpg')).sort()
    if (produced.length === 0) {
      const { error, detail } = classify(result.stderr, false)
      return fail(error, result.code === 0 ? 'ffmpeg 退出成功但一张图都没写出来' : detail)
    }
    if (result.code !== 0 && produced.length < frames) {
      // 只抓到前几帧就断了：最后一帧可能是半截的，按错误处理更老实。
      const { error, detail } = classify(result.stderr, false)
      return fail(error, detail)
    }

    const last = join(work, produced[produced.length - 1])
    const bytes = await readFile(last)
    if (bytes.length === 0) return fail('ffmpeg', '抓到的文件是空的')
    const dims = jpegDimensions(bytes)
    if (dims === null) return fail('ffmpeg', '抓到的不是一张能解开的 JPEG')

    const at = new Date()
    const target = join(shotsDir, `${stamp(at)}.jpg`)
    // /tmp 和家目录常常不是同一个文件系统，rename 会 EXDEV —— 用 copy 收尾。
    try {
      await rename(last, target)
    } catch {
      await copyFile(last, target)
    }

    await pruneShots(shotsDir, keep)

    return {
      ok: true,
      path: target,
      width: dims.width,
      height: dims.height,
      bytes: bytes.length,
      at: at.toISOString(),
      note: note === '' ? `丢了 ${discard} 帧再抓` : `${note}；丢了 ${discard} 帧再抓`,
    }
  } catch (error) {
    return fail('ffmpeg', `${error?.message ?? error}`)
  } finally {
    if (work !== '') { try { await rm(work, { recursive: true, force: true }) } catch { /* 临时目录漏了就漏了 */ } }
    if (locked) await releaseLock(LOCK_FILE)
  }
}

/** 直接跑：`node lib/domain/eye-capture.mjs [size]`，用来在不启宿主的情况下验摄像头。 */
if (process.argv[1] !== undefined && basename(process.argv[1]) === 'eye-capture.mjs') {
  const size = process.argv[2]
  const result = await capture(size === undefined ? {} : { size })
  console.log(JSON.stringify(result, null, 2))
  if (result.ok !== true) process.exitCode = 1
}
