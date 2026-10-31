#!/usr/bin/env node
/**
 * 把 dsh-bili-whale 的登录态桥接给 SurfCore。
 *
 * 为什么需要它：SurfCore 的扫码登录走无头 Edge（Windows-only），
 * 在 Linux 上 findEdge() 找不到就直接报错。而 dsh-bili-whale 自己画二维码、
 * 跨平台可用。所以：在「养鱼」扫码登录 → 跑这个脚本把凭据搬过去。
 *
 *   node bili-bridge.mjs           # 搬运并校验
 *   node bili-bridge.mjs --check   # 只看两边状态
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const SRC = join(homedir(), '.bili-ai', 'credentials.json')
const DST = join(homedir(), '.dsh', 'surfcore', 'bili', 'owner-credentials.json')
const checkOnly = process.argv.includes('--check')

const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

const src = readJson(SRC)
if (src === null) {
  console.error(`源头凭据不在：${SRC}`)
  console.error('先去 Web 设置 → 养鱼 → 扫码登录，再回来跑这个脚本。')
  process.exit(1)
}
if (!src.sessdata) {
  console.error('源头凭据里没有 sessdata，可能登录没成功。')
  process.exit(1)
}

/** 问 B站 这是谁（只用来填 mid/name，失败不阻塞搬运）。 */
async function nav() {
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        cookie: `SESSDATA=${src.sessdata}; bili_jct=${src.bili_jct ?? ''}; buvid3=${src.buvid3 ?? ''}`,
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        referer: 'https://www.bilibili.com/',
      },
      signal: AbortSignal.timeout(8000),
    })
    const j = await r.json()
    return j?.data?.isLogin ? { mid: String(j.data.mid), name: String(j.data.uname ?? '') } : null
  } catch {
    return null
  }
}

const account = await nav()
const payload = {
  version: 1,
  sessdata: src.sessdata,
  bili_jct: src.bili_jct ?? '',
  buvid3: src.buvid3 ?? '',
  mid: account?.mid ?? String(src.mid ?? ''),
  name: account?.name ?? String(src.name ?? ''),
  savedAt: new Date().toISOString(),
}

console.log('源头：', SRC)
console.log('目标：', DST)
console.log('账号：', account === null ? '（nav 没问出来，沿用旧值，不影响 cookie 本身）' : `${payload.name} (${payload.mid})`)

if (checkOnly) {
  console.log('已存在目标文件：', existsSync(DST))
  process.exit(0)
}

mkdirSync(dirname(DST), { recursive: true })
const tmp = `${DST}.tmp-${process.pid}`
writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
renameSync(tmp, DST)
console.log('已写入 SurfCore 凭据。去 SurfCore 页点「核查」应该就通了。')
