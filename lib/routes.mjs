/**
 * HTTP 端点：只读查询 + 少量手动触发。
 *
 * 整块原样搬出来，只把外层包成 registerRoutes(ctx, deps)，
 * 内部引用的 db / readStats / backupNow 之类都从 deps 解构，名字不变。
 */
import { existsSync } from 'node:fs'
import { readPolicy } from './policy.mjs'
import { recentEvents } from './events.mjs'
import { searchEntries } from './entries.mjs'
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
            dbPath, hot, cold, facts, important,
            embedOk, embedUrl: EMBED_URL,
            stats: readStats(), budgetChars: budgetChars(),
            diary: db.prepare('SELECT COUNT(*) c FROM diary').get().c,
            policy: readPolicy(db),
          }))
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
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50))
          const flag = zone === 'hot' ? 1 : 0

          const total = db.prepare('SELECT COUNT(*) c FROM entries WHERE hot=?').get(flag).c
          const rows = db.prepare(`
            SELECT id,u,a,t,w,emo FROM entries
            WHERE hot=?
            ORDER BY ${zone === 'hot' ? 't DESC' : 'w DESC, t DESC'}
            LIMIT ?
          `).all(flag, limit)

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
