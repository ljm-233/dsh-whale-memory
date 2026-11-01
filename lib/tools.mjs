/**
 * 模型侧工具：查记忆、改错、看事件线、读网页、记待办以外的零碎。
 *
 * 从 index 里搬出来——光这一段就 300 多行，留在主文件里
 * 会把「接线」淹没掉。
 */
import {
  searchEntries, putEntry, correctEntry, retractEntry,
} from './entries.mjs'
import { recentEvents } from './events.mjs'
import { readPolicy, writePolicy } from './policy.mjs'
import { cardLine, localStamp } from './format.mjs'
import { overlap } from './language.mjs'
import { readPage } from './web.mjs'
import { RECALL_PAGE_DEFAULT, RECALL_PAGE_MAX, WEIGHT_MAX } from './constants.mjs'
import { listFacts } from './facts.mjs'

/**
 * 被想起就浮上来：w+1（封顶）、hits+1、tier 回到浅一层（封顶 0）。
 *
 * 一条一次、一个事务、失败只吞掉——召回结果不能因为记不上计数就丢。
 * 只在「真被返回给模型」的那次调用里写；别放进 card()（那是只读、每步都跑）。
 *
 * @param {object} db 记忆库
 * @param {number[]} ids 这一轮真正返回的条目 id
 * @param {number} weightMax 权重上限
 * @returns {number} 写了几条（失败时是 0）
 */
export function warmEntries(db, ids, weightMax = WEIGHT_MAX) {
  const uniq = [...new Set((ids ?? []).map(Number).filter((id) => Number.isInteger(id) && id > 0))]
  if (uniq.length === 0) return 0
  const cap = Number(weightMax) > 0 ? Number(weightMax) : WEIGHT_MAX
  let n = 0
  try {
    const up = db.prepare('UPDATE entries SET w = MIN(w + 1, ?), hits = hits + 1, tier = MAX(tier - 1, 0) WHERE id = ?')
    db.exec('BEGIN')
    for (const id of uniq) {
      up.run(cap, id)
      n += 1
    }
    db.exec('COMMIT')
    return n
  } catch {
    // 半截事务要收掉，否则后续写入全卡在「不能开启事务」上。
    try { db.exec('ROLLBACK') } catch { /* 回滚不了也一样吞 */ }
    return 0
  }
}

/**
 * `memory_recall` 给模型看的那段文本。
 *
 * card（默认）：一行一张六字段卡，正文不出现——这就是省上下文的那条路。
 * full：给一页原文 + total / nextOffset，真要逐字读时才走这条。
 *
 * @param {object} value 工具的规范返回值
 * @returns {string}
 */
function renderRecall(value) {
  if (value.reason === 'rate-limited') return '这轮已经查够了，先用手上的。'
  if (value.count === 0) return '没找到匹配的记忆。'
  const lines = value.detail === 'full'
    ? [
      `找到 ${value.count} 条，全文 ${value.total} 字，本段从第 ${value.offset} 字起：`,
      value.text === '' ? '（这一页是空的）' : value.text,
      value.nextOffset === null || value.nextOffset === undefined
        ? '（到底了）'
        : `（后面还有，继续读：detail:'full', offset:${value.nextOffset}）`,
    ]
    : [
      `找到 ${value.count} 条（排序分，不是概率）：`,
      ...value.items.map((it) => it.card),
      "（要看原话：detail:'full'）",
    ]
  const facts = (value.facts ?? []).length === 0
    ? ''
    : `事实：\n${(value.facts ?? []).map((it) => `- ${it.text}${it.expired ? '（已失效）' : ''}`).join('\n')}`
  return [
    ...lines,
    value.hint === '' || value.hint === undefined ? '' : `（${value.hint}）`,
    facts,
  ].filter((line) => line !== '').join('\n')
}

/**
 * 注册全部模型可调用的工具。
 *
 * @param {object} ctx 插件上下文
 * @param {object} deps
 * @param {Function|null} deps.defineTool 工具工厂，拿不到就整块不注册
 * @param {object} deps.db 记忆库
 * @param {Function} deps.embedTexts 嵌入
 * @param {Function} deps.backupNow 立刻备份
 * @param {Function} deps.listBackups 列出备份
 * @param {Function} deps.readPreference 读偏好
 * @param {Function} deps.writePreference 写偏好
 */
export function registerTools(ctx, deps) {
  const {
    defineTool, db, embedTexts,
    backupNow, listBackups, readPreference, writePreference, space, weightMax,
  } = deps
  if (defineTool === null) return
  // 当前记忆空间：查记忆时跟着它走，避免跨空间串味。
  const spaceOf = () => (typeof space === 'function' ? String(space() ?? '') : '')
  // 召回限流：一条人类消息之间最多 3 次。超了就说一句「先用手上的」——
  // 翻得越多越像在蒙，宁可让模型拿现成的回答。
  // 计数按会话分开（群聊和私聊、子 agent 各算各的），
  // 新的一条用户消息落地时清零，「每条人类消息之间」就是这条线。
  const SPENT = new Map()
  const budgetOf = (key) => Math.max(0, 3 - (SPENT.get(key) ?? 0))
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'user/message') return
    const msg = event.data ?? {}
    if (msg.source?.kind === 'user') SPENT.delete(String(session?.id ?? ''))
  })

  // 证据链：只在 full 模式念一句出处，card 默认路径一个字节都不加。
  // 老库可能还没有这张表——第一次问一次，拿不到就一辈子返回空。
  let evidStmt = null
  let evidProbed = false
  const evidenceOf = (entryId) => {
    if (!evidProbed) {
      evidProbed = true
      try {
        evidStmt = db.prepare(
          'SELECT source FROM entry_evidence WHERE entry_id = ? ORDER BY rowid ASC LIMIT 2',
        )
      } catch { evidStmt = null }
    }
    if (evidStmt === null) return []
    try {
      return evidStmt.all(entryId)
        .map((r) => String(r.source ?? '').slice(0, 80))
        .filter((s) => s !== '')
    } catch { return [] }
  }

  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(() => [
      toolsCtx.tools.register(defineTool({
        name: 'memory_recall',
        description: 'Search your own long-term memory entries. Default (detail:card) returns one six-field evidence card per hit — id/tag/score/summary/time/quote — with no full text, because full text blows up the context. score is a ranking score, not a probability. Ask for detail:full with offset/limit to page through the verbatim text. Also returns the facts currently held (and retired ones with includeExpired). Read-only.',
        parameters: {
          keyword: { type: 'string', description: 'Match this substring in the saved exchange.' },
          zone: {
            type: 'string',
            enum: ['any', 'hot', 'cold'],
            description: 'hot = still in recent context, cold = archived. Defaults to any.',
          },
          detail: {
            type: 'string',
            enum: ['card', 'full'],
            description: 'card = six-field evidence cards only (default); full = paged verbatim text.',
          },
          limit: {
            type: 'number',
            description: 'card mode: how many entries (1-100, default 20). full mode: page size in characters (1-8000, default 2000).',
          },
          offset: {
            type: 'number',
            description: 'full mode only: character offset to start the page at. Defaults to 0.',
          },
          owner: { type: 'string', description: 'Only entries written by this agent id.' },
          includeExpired: {
            type: 'boolean',
            description: 'Also return facts that no longer hold (superseded by a later one). Defaults to false.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              count: { type: 'number', required: true },
              detail: { type: 'string' },
              reason: { type: 'string' },
              hint: { type: 'string' },
              total: { type: 'number', description: 'full mode: length of the whole verbatim text.' },
              offset: { type: 'number', description: 'full mode: character offset this page starts at.' },
              text: { type: 'string', description: 'full mode: this page of verbatim text.' },
              nextOffset: {
                oneOf: [{ type: 'number' }, { type: 'null' }],
                description: 'full mode: offset for the next page, null at the end.',
              },
              items: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'number', required: true },
                    card: { type: 'string', description: 'Six-field evidence card (card mode).' },
                    day: { type: 'string' },
                    zone: { type: 'string' },
                    weight: { type: 'number' },
                    user: { type: 'string' },
                    assistant: { type: 'string' },
                  },
                },
              },
              facts: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'number', required: true },
                    text: { type: 'string', required: true },
                    expired: { type: 'boolean', required: true },
                  },
                },
              },
            },
          },
          render: (_args, value) => [{ type: 'text', text: renderRecall(value) }],
        },
        execute(args, exec) {
          // 限流先判：额度用完了不再翻库，句子里也不给「要不要再查」的暗示。
          const key = String(exec?.agent?.session?.id ?? '')
          if (budgetOf(key) <= 0) return { count: 0, detail: 'card', items: [], reason: 'rate-limited' }
          SPENT.set(key, (SPENT.get(key) ?? 0) + 1)
          // 分页参数只给 full 用；card 模式照旧按条数。
          const full = args?.detail === 'full'
          // 参数名分开喂：limit 在 card 模式是条数、在 full 模式是字符数，
          // 直接 {...args} 会把 2000 当成「要 2000 条」交给 searchEntries。
          const query = {
            keyword: args?.keyword, zone: args?.zone, owner: args?.owner, space: spaceOf(),
          }
          const rows = full
            ? searchEntries(db, { ...query, limit: 100 })
            : searchEntries(db, { ...query, limit: args?.limit })
          // 真被查出来的条目：w/hits 升、tier 浅一层。一条一次、事务里做，
          // 写失败不影响已经拿到的 rows（warmEntries 自己吞异常）。
          warmEntries(db, rows.map((r) => r.id), weightMax?.())
          // 命中与查询词的重合度：低于 20% 说明这轮查偏了，别顺着再诱导一次无效检索。
          const keyword = String(args?.keyword ?? '').trim()
          const ratio = keyword === ''
            ? 1
            : overlap(keyword, rows.map((r) => `${r.u} ${r.a}`).join(' '))
          // 事实不是条目：默认只给仍成立的，includeExpired 才连失效的一起给。
          const now = Date.now()
          const facts = listFacts(db, {
            space: spaceOf(),
            limit: 50,
            includeExpired: args?.includeExpired === true,
            now,
          })
          const shared = {
            count: rows.length,
            reason: '',
            hint: rows.length > 0 && ratio >= 0.2 && budgetOf(key) > 0
              ? `想找更早的可以再查，本轮还剩 ${budgetOf(key)} 次`
              : '',
            facts: facts.map((f) => ({
              id: f.id,
              text: f.f,
              expired: f.valid_until !== null && f.valid_until <= now,
            })),
          }
          if (!full) {
            return {
              ...shared,
              detail: 'card',
              // 只给卡，不给原文——默认路径要的就是「别撑爆上下文」。
              items: rows.map((r) => ({
                id: r.id,
                card: cardLine(r, { keyword }),
                day: localStamp(r.t),
                zone: r.hot === 1 ? 'hot' : 'cold',
                weight: Math.round((Number(r.w) || 0) * 10) / 10,
              })),
            }
          }
          // full：原文照给，但按字符分页；offset 越界就当读到末尾。
          const text = rows.map((r) => {
            const ev = evidenceOf(r.id)
            const line = `#${r.id} [${localStamp(r.t)}] 用户: ${r.u}${r.a === '' ? '' : `\n你: ${r.a}`}`
            return ev.length === 0 ? line : `${line}\n证据：${ev.join(' ／ ')}`
          }).join('\n\n')
          const size = Math.min(RECALL_PAGE_MAX, Math.max(1, Math.round(Number(args?.limit) || RECALL_PAGE_DEFAULT)))
          const offset = Math.min(Math.max(0, Math.round(Number(args?.offset) || 0)), text.length)
          return {
            ...shared,
            detail: 'full',
            total: text.length,
            offset,
            text: text.slice(offset, offset + size),
            nextOffset: offset + size < text.length ? offset + size : null,
            items: [],
          }
        },
      })),

      toolsCtx.tools.register(defineTool({
        name: 'timeline_recent',
        description: 'Read the shared recent-event timeline across every window, session and tool. Use it to find out what happened while you were away or in another window. Read-only.',
        parameters: {
          hours: { type: 'number', description: 'Only events from the last N hours. Defaults to 24.' },
          kind: {
            type: 'string',
            enum: ['any', 'user', 'assistant', 'tool'],
            description: 'Filter by event kind. Defaults to any.',
          },
          session: { type: 'string', description: 'Only events from this session id.' },
          limit: { type: 'number', description: 'Maximum events, 1-200. Defaults to 30.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              count: { type: 'number', required: true },
              items: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    day: { type: 'string', required: true },
                    window: { type: 'string', required: true },
                    kind: { type: 'string', required: true },
                    text: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.count === 0
              ? '这段时间没有记录。'
              : value.items.map(
                (it) => `[${it.day}] ${it.window === '' ? '-' : it.window}/${it.kind}: ${it.text}`,
              ).join('\n'),
          }],
        },
        execute(args) {
          const rows = recentEvents(db, { hours: args.hours ?? 24, ...args })
          return {
            count: rows.length,
            items: rows.map((r) => ({
              day: localStamp(r.at),
              window: r.window,
              kind: r.kind,
              text: r.text.slice(0, 300),
            })),
          }
        },
      })),

      toolsCtx.tools.register(defineTool({
        name: 'memory_correct',
        description: 'Fix or retract one of your own memory entries. The old version is preserved in a revisions log, never silently overwritten.',
        parameters: {
          id: { type: 'number', required: true, description: 'Entry id from memory_recall.' },
          action: {
            type: 'string',
            enum: ['correct', 'retract'],
            description: 'correct replaces it with a corrected account; retract removes it. Defaults to correct.',
          },
          correction: {
            type: 'string',
            description: 'What the memory should say instead (user side). Required for correct.',
          },
          assistant: { type: 'string', description: 'Optional corrected assistant side; omit to keep the old one.' },
          reason: { type: 'string', description: 'Why it was wrong. Stored in the revision log.' },
          allowForeign: {
            type: 'boolean',
            description: 'Set only when correcting an entry another agent owns; the revision records you as the actor.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              reason: { type: 'string', description: 'Why it failed, when ok is false.' },
              previousId: { type: 'number' },
              id: { type: 'number', description: 'New entry id for a correction.' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.ok
              ? (value.id === undefined
                ? `已撤回 #${value.previousId}，原件留在 revisions 里。`
                : `已修正 #${value.previousId} → 新的 #${value.id}，原件留在 revisions 里。`)
              : `没改成：${value.reason ?? '未知原因'}`,
          }],
        },
        async execute(args, exec) {
          // 自报身份：改别人的条目要走 allowForeign，并且留痕。
          const actor = String(exec?.agent?.id ?? '')
          const base = { ...args, actor }
          if (args.action === 'retract') return retractEntry(db, base)
          const text = String(args.correction ?? '').trim()
          if (text === '') return { ok: false, reason: 'empty' }
          const vec = (await embedTexts([text]))?.[0] ?? null
          return correctEntry(db, { ...base, text, vec })
        },
      })),
      toolsCtx.tools.register(defineTool({
        name: 'web_read',
        description: 'Fetch one web page or JSON document and return readable text. Resolves the host through public DNS, so it works even when the local proxy hands out fake addresses. Read-only.',
        parameters: {
          url: { type: 'string', required: true, description: 'The HTTP(S) URL to read.' },
          maxChars: { type: 'number', description: 'Maximum characters to return, 200-20000. Defaults to 4000.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              status: { type: 'number' },
              url: { type: 'string' },
              text: { type: 'string' },
              bytes: { type: 'number' },
              reason: { type: 'string' },
            },
          },
          render: (_args, v) => [{
            type: 'text',
            text: v.ok
              ? `HTTP ${v.status} · ${v.url}\n\n${v.text}`
              : `没读到：${v.reason ?? '未知原因'}`,
          }],
        },
        execute(args) {
          return readPage(args.url, { maxChars: args.maxChars })
        },
      })),

      toolsCtx.tools.register(defineTool({
        name: 'preference',
        description: 'Read or rewrite your own preferences: what you care about, what you dislike, what you want to try. These come from experience, not from the fixed persona, and you may change them. Call without text to read.',
        parameters: {
          text: { type: 'string', description: 'Full replacement text. Omit to read the current preferences.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              changed: { type: 'boolean', required: true },
              preference: { type: 'string', required: true },
            },
          },
          render: (_args, v) => [{
            type: 'text',
            text: v.preference === ''
              ? '还没写过偏好。'
              : `${v.changed ? '已更新：\n' : ''}${v.preference}`,
          }],
        },
        execute(args) {
          const text = String(args.text ?? '').trim()
          if (text === '') return { changed: false, preference: readPreference() }
          return { changed: true, preference: writePreference(text) }
        },
      })),

      toolsCtx.tools.register(defineTool({
        name: 'memory_backup',
        description: 'Snapshot your memory database now, or list existing snapshots. Snapshots are verified with integrity_check before being reported as good.',
        parameters: {
          list: { type: 'boolean', description: 'List existing snapshots instead of creating one.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              reason: { type: 'string' },
              path: { type: 'string' },
              entries: { type: 'number' },
              count: { type: 'number' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { file: { type: 'string', required: true }, at: { type: 'number', required: true } },
                },
              },
            },
          },
          render: (_args, v) => [{
            type: 'text',
            text: v.list === true
              ? (v.count === 0 ? '还没有备份。' : `共 ${v.count} 份：${v.items.map((i) => i.file).join(' · ')}`)
              : (v.ok ? `备份好了：${v.path}（${v.entries} 条记忆）` : `备份没成：${v.reason ?? '未知'}`),
          }],
        },
        execute(args) {
          if (args.list === true) {
            const items = listBackups()
            return { ok: true, count: items.length, items: items.map((i) => ({ file: i.file, at: i.at })) }
          }
          return backupNow({ force: true })
        },
      })),

      toolsCtx.tools.register(defineTool({
        name: 'memory_policy',
        description: 'Read or set what you consider worth remembering. Compaction consults this before deciding which experiences survive. Call without text to read; with text to replace it.',
        parameters: {
          text: {
            type: 'string',
            description: 'New policy: what is worth keeping, in your own words. Omit to just read it.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              changed: { type: 'boolean', required: true },
              policy: { type: 'string', required: true },
            },
          },
          render: (_args, v) => [{
            type: 'text',
            text: v.policy === ''
              ? '还没定过取舍倾向，压缩时按默认判断。'
              : `${v.changed ? '已更新：' : '现在的取向：'}${v.policy}`,
          }],
        },
        execute(args) {
          const text = String(args.text ?? '').trim()
          if (text === '') return { changed: false, policy: readPolicy(db) }
          return { changed: true, policy: writePolicy(db, text) }
        },
      })),
    ], 'dsh-whale-memory: memory tools')
  })

}
