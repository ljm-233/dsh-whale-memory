/**
 * 读网页：绕开本机代理给的假地址。
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Resolver } from 'node:dns'

const PUBLIC_DNS = ['223.5.5.5', '119.29.29.29']
/** 网页读取的 UA：有些站点对脚本 UA 直接拦。 */
const WEB_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/**
 * 用公共 DNS 把域名解析成真实地址。
 *
 * @param {string} host 域名
 * @returns {Promise<string|null>} 解析不到返回 null
 */
export async function resolveReal(host) {
  for (const server of PUBLIC_DNS) {
    try {
      const resolver = new Resolver({ timeout: 2500, tries: 1 })
      resolver.setServers([server])
      const v4 = await resolver.resolve4(host)
      if (v4.length > 0) return v4[0]
    } catch { /* 换下一个 */ }
  }
  return null
}

/**
 * 把 HTML 拍成纯文本。够用就行，不做完整的解析器。
 *
 * @param {string} html 原始内容
 * @returns {string}
 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#(\d+);/gu, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n\s*\n\s*\n+/gu, '\n\n')
    .trim()
}

/**
 * 读一个网页。绕开本机代理的假 IP，直接连真实地址。
 *
 * @param {string} url 目标
 * @param {{maxChars?:number, timeoutMs?:number, redirects?:number}} [opts]
 * @returns {Promise<{ok:boolean, status?:number, url?:string, text?:string, bytes?:number, reason?:string}>}
 */
export async function readPage(url, opts = {}) {
  const maxChars = Math.min(20_000, Math.max(200, Number(opts.maxChars) || 4000))
  const timeoutMs = Number(opts.timeoutMs) || 12_000
  const redirects = Number(opts.redirects) || 0

  let target
  try {
    target = new URL(url)
  } catch {
    return { ok: false, reason: 'bad-url' }
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return { ok: false, reason: 'unsupported-scheme' }

  const secure = target.protocol === 'https:'
  const ip = await resolveReal(target.hostname)

  return await new Promise((ok) => {
    const options = {
      method: 'GET',
      path: `${target.pathname}${target.search}`,
      headers: {
        host: target.hostname,
        'user-agent': WEB_UA,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'accept-encoding': 'identity',
      },
      timeout: timeoutMs,
    }
    if (ip !== null) {
      options.host = ip
      options.servername = target.hostname
      options.lookup = (_hostname, _o, cb) => cb(null, ip, 4)
    } else {
      options.host = target.hostname
    }

    const request = (secure ? httpsRequest : httpRequest)(options, (res) => {
      const status = Number(res.statusCode) || 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && typeof location === 'string' && redirects < 3) {
        res.resume()
        const next = new URL(location, target).href
        readPage(next, { ...opts, redirects: redirects + 1 }).then(ok)
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        const text = htmlToText(body).slice(0, maxChars)
        ok({ ok: true, status, url: target.href, text, bytes: body.length })
      })
    })

    request.on('timeout', () => { request.destroy(new Error('timeout')) })
    request.on('error', (error) => ok({ ok: false, reason: String(error?.message ?? error) }))
    request.end()
  })
}

/** 本地时区的 YYYY-MM-DD HH:mm，给工具输出用。 */
