/**
 * HTTP 端点：只读查询 + 少量手动触发。
 *
 * 整块原样搬出来，只把外层包成 registerRoutes(ctx, deps)，
 * 内部引用的 db / readStats / backupNow 之类都从 deps 解构，名字不变。
 */
import { existsSync } from 'node:fs'
import { readPolicy } from './policy.mjs'
import { recentEvents } from './events.mjs'
import { searchEntries, correctEntry, retractEntry, keywordIds } from './entries.mjs'
import { localStamp } from './format.mjs'
import { EMBED_URL } from './constants.mjs'

/**
 * 注册全部端点。
 *
 * @param {object} ctx 插件上下文
 * @param {object} deps 端点需要的依赖
 */
export function registerRoutes(ctx, deps) {
  const {
    db, dbPath, readStats, bumpStat, budgetChars,
    backupDir, backupKeep, backupNow, listBackups,
    dayKeyOf, writeDiary, consolidateNow,
    PLUGIN_VERSION,
} = deps

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/status',
        handler: async (req, res) => {
          const hot = db.prepare('SELECT COUNT(*) c FROM entries WHERE hot=1').get().c
          const cold = db.prepare('SELECT COUNT(*) c FROM entries WHERE hot=0').get().c
          const important = db.prepare('SELECT COUNT(*) c FROM entries WHERE w >= ?').get().c
          const facts = db.prepare('SELECT COUNT(*) c FROM facts').get().c
          // 探一下向量服务
          let embedOk = false
          try {
            const r = await fetch(`${EMBED_URL}/health`, { signal: AbortSignal.timeout(500) })
            embedOk = r.ok
          } catch { embedOk = false }

          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            pluginVersion: PLUGIN_VERSION,
            space: (() => { try { return String(db.prepare("SELECT space FROM entries ORDER BY t DESC LIMIT 1").get()?.space ?? 'default') } catch { return 'default' } })(),
            dbPath, hot, cold, facts, important,
            embedOk, embedUrl: EMBED_URL,
            stats: readStats(), budgetChars: budgetChars(),
            diary: db.prepare('SELECT COUNT(*) c FROM diary').get().c,
            scenes: (() => { try { return db.prepare('SELECT COUNT(*) c FROM scenes').get().c } catch { return 0 } })(),
            spaces: (() => { try { return db.prepare('SELECT COUNT(DISTINCT space) c FROM entries').get().c } catch { return 0 } })(),
            personaChars: (() => {
              try { return String(db.prepare("SELECT v FROM meta WHERE k='persona'").get()?.v ?? '').length } catch { return 0 }
            })(),
            policy: readPolicy(db),
          }))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/selfcheck',
        handler: (req, res) => {
          if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return }
          // 自证：四个数。说不出来的就是没做，不装。
          let body = { ok: false, reason: 'nightly-unavailable' }
          if (nightly && typeof nightly.selfCheck === 'function') {
            try { body = { ok: true, ...nightly.selfCheck() } } catch (error) { body = { ok: false, reason: String(error?.message ?? error) } }
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/nightly',
        handler: async (req, res) => {
          if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
          let result = { ok: false, reason: 'nightly-unavailable' }
          if (nightly && typeof nightly.run === 'function') {
            try { result = nightly.run({}) } catch (error) { result = { ok: false, reason: String(error?.message ?? error) } }
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(result))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/entries',
        handler: (req, res) => {
          if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return }
          // 只读：看一眼热区/冷区里到底存了什么，不给任何写入口。
          const url = new URL(req.url ?? '/', 'http://dsh.invalid')
          const zone = url.searchParams.get('zone') === 'hot' ? 'hot' : 'cold'
          const space = String(url.searchParams.get('space') ?? (url.searchParams.get('all') === '1' ? '' : 'default'))
          const keyword = String(url.searchParams.get('keyword') ?? '').trim().slice(0, 60)
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50))
          const flag = zone === 'hot' ? 1 : 0

          const where = ['hot = ?']
          const args = [flag]
          if (space !== '') { where.push('space = ?'); args.push(space) }
          if (keyword !== '') {
            const ids = keywordIds(db, keyword)
            if (ids === null) {
              where.push('(u LIKE ? OR a LIKE ?)')
              args.push(`%${keyword}%`, `%${keyword}%`)
            } else if (ids.length === 0) {
              where.push('0')
            } else {
              where.push(`id IN (${ids.map(() => '?').join(',')})`)
              args.push(...ids)
            }
          }
          const clause = `WHERE ${where.join(' AND ')}`

          const total = db.prepare(`SELECT COUNT(*) c FROM entries ${clause}`).get(...args).c
          const rows = db.prepare(`
            SELECT id,u,a,t,w,emo FROM entries
            ${clause}
            ORDER BY ${zone === 'hot' ? 't DESC' : 'w DESC, t DESC'}
            LIMIT ?
          `).all(...args, limit)

          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            zone,
            total,
            shown: rows.length,
            items: rows.map((r) => ({
              id: r.id,
              at: r.t,
              weight: r.w,
              emo: JSON.parse(r.emo || '[]'),
              user: String(r.u ?? '').slice(0, 300),
              assistant: String(r.a ?? '').slice(0, 300),
            })),
          }))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/entries/correct',
        handler: async (req, res) => {
          if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
          const body = await readJsonBody(req)
          if (body === null) {
            res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: false, reason: 'too-large' }))
            return
          }
          const r = correctEntry(db, {
            id: Number(body.id), text: String(body.text ?? ''), assistant: body.assistant,
            reason: String(body.reason ?? 'setting-page'), actor: 'setting-page',
          })
          res.writeHead(r.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(r))
          if (r.ok) bumpStat('corrected')
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/entries/retract',
        handler: async (req, res) => {
          if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
          const body = await readJsonBody(req)
          if (body === null) {
            res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: false, reason: 'too-large' }))
            return
          }
          const r = retractEntry(db, {
            id: Number(body.id), reason: String(body.reason ?? 'setting-page'), actor: 'setting-page',
          })
          res.writeHead(r.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(r))
          if (r.ok) bumpStat('retracted')
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/graph',
        handler: (req, res) => {
          if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return }
          const url = new URL(req.url ?? '/', 'http://dsh.invalid')
          const space = String(url.searchParams.get('space') ?? 'default')
          let nodes = []
          let links = []
          try {
            nodes = db.prepare('SELECT name, n FROM entities WHERE space=? ORDER BY n DESC LIMIT 60').all(space)
            links = db.prepare('SELECT a, b, w FROM edges WHERE space=? ORDER BY w DESC LIMIT 120').all(space)
          } catch { /* 表还没建就返回空 */ }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            nodes: nodes.map((r) => ({ name: r.name, count: r.n })),
            edges: links.map((r) => ({ a: r.a, b: r.b, w: r.w })),
          }))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/trend',
        handler: (req, res) => {
          if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return }
          const url = new URL(req.url ?? '/', 'http://dsh.invalid')
          const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 14))
          const from = new Date(Date.now() - (days - 1) * 86400000)
          const fromKey = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`
          let rows = []
          try {
            rows = db.prepare('SELECT day, k, v FROM daily_stats WHERE day >= ? ORDER BY day ASC').all(fromKey)
          } catch { /* 表还没建就返回空 */ }
          const byDay = new Map()
          for (const r of rows) {
            if (!byDay.has(r.day)) byDay.set(r.day, {})
            byDay.get(r.day)[r.k] = r.v
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            days,
            series: [...byDay.entries()].map(([day, v]) => ({ day, ...v })),
          }))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/spaces',
        handler: (req, res) => {
          if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return }
          let rows = []
          try {
            rows = db.prepare('SELECT space, COUNT(*) c FROM entries GROUP BY space ORDER BY c DESC').all()
          } catch { rows = [] }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ spaces: rows.map((r) => ({ id: r.space, count: r.c })) }))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/scenes',
        handler: (req, res) => {
          if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return }
          let rows = []
          try {
            rows = db.prepare('SELECT topic, body, n, updated FROM scenes ORDER BY updated DESC LIMIT 50').all()
          } catch { rows = [] }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            total: rows.length,
            items: rows.map((r) => ({
              topic: r.topic, body: String(r.body ?? ''), count: r.n, at: r.updated,
            })),
          }))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/persona',
        handler: (req, res) => {
          if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return }
          let text = ''
          try {
            text = String(db.prepare("SELECT v FROM meta WHERE k='persona'").get()?.v ?? '')
          } catch { text = '' }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ text }))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/backups',
        handler: (req, res) => {
          if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ dir: backupDir(), keep: backupKeep(), items: listBackups() }))
            return
          }
          if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }).end(); return }
          // 手动备一份（会覆盖当天的）。恢复永远由人来做，插件不自动回滚。
          const result = backupNow({ force: true })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(result))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/timeline',
        handler: (req, res) => {
          if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return }
          const url = new URL(req.url ?? '/', 'http://dsh.invalid')
          const rows = recentEvents(db, {
            hours: url.searchParams.get('hours') ?? undefined,
            kind: url.searchParams.get('kind') ?? 'any',
            session: url.searchParams.get('session') ?? '',
            limit: url.searchParams.get('limit') ?? undefined,
          })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            count: rows.length,
            items: rows.map((r) => ({ ...r, day: localStamp(r.at) })),
          }))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/diary',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            // 只读：看看都写过什么
            const url = new URL(req.url ?? '/', 'http://dsh.invalid')
            const limit = Math.min(365, Math.max(1, Number(url.searchParams.get('limit')) || 30))
            const total = db.prepare('SELECT COUNT(*) c FROM diary').get().c
            const rows = db.prepare('SELECT day, text, created_at FROM diary ORDER BY day DESC LIMIT ?').all(limit)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({
              total,
              items: rows.map((r) => ({ day: r.day, text: r.text, createdAt: r.created_at })),
            }))
            return
          }
          if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }).end(); return }
          // 手动补写一篇（测试用）。不传 day 就写今天的。
          let body = {}
          try {
            body = JSON.parse(String(await new Promise((ok) => {
              let d = ''
              req.on('data', (c) => { d += c })
              req.on('end', () => ok(d))
            })) || '{}')
          } catch { body = {} }
          const day = typeof body.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.day)
            ? body.day
            : dayKeyOf()
          const result = await writeDiary(day, { force: true })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(result))
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-whale-memory/consolidate',
        handler: async (req, res) => {
          if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
          let body = {}
          try { body = JSON.parse(String(await new Promise((ok) => { let d = ''; req.on('data', (c) => { d += c }); req.on('end', () => ok(d)) })) || '{}') } catch { body = {} }
          const result = await consolidateNow({ dry: body.dry === true, batch: body.batch })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(result))
        },
      }),
      'dsh-whale-memory: status route',
    )
  })
}

/**
 * 读一个小 JSON 请求体：设置页只发几百字节，超过 64KB 直接当非法。
 *
 * @param {import('node:http').IncomingMessage} req 请求
 * @returns {Promise<object>} 解析后的对象，坏了就当空对象
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    let tooBig = false
    req.on('data', (chunk) => {
      if (tooBig) return
      raw += chunk
      // 超过 64KB 就不收了：标记一下，等 end 时交给调用方回 413，别直接掐连接让客户端一脸懵。
      if (raw.length > 65536) { tooBig = true; raw = '' }
    })
    req.on('end', () => resolve(tooBig ? null : (() => {
      try { return JSON.parse(raw || '{}') } catch { return {} }
    })()))
    req.on('error', () => resolve({}))
  })
}
