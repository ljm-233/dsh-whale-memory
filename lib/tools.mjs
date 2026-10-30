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
import { localStamp } from './format.mjs'
import { readPage } from './web.mjs'

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
    backupNow, listBackups, readPreference, writePreference,
  } = deps
  if (defineTool === null) return

ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(() => [
      toolsCtx.tools.register(defineTool({
        name: 'memory_recall',
        description: 'Search your own long-term memory entries. Returns ids you can pass to memory_correct. Read-only.',
        parameters: {
          keyword: { type: 'string', description: 'Match this substring in the saved exchange.' },
          zone: {
            type: 'string',
            enum: ['any', 'hot', 'cold'],
            description: 'hot = still in recent context, cold = archived. Defaults to any.',
          },
          limit: { type: 'number', description: 'Maximum entries, 1-100. Defaults to 20.' },
          owner: { type: 'string', description: 'Only entries written by this agent id.' },
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
                    id: { type: 'number', required: true },
                    day: { type: 'string', required: true },
                    zone: { type: 'string', required: true },
                    weight: { type: 'number', required: true },
                    user: { type: 'string', required: true },
                    assistant: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.count === 0
              ? '没找到匹配的记忆。'
              : [`找到 ${value.count} 条：`, ...value.items.map(
                (it) => `#${it.id} [${it.day}] (${it.zone}/权重${it.weight}) 用户: ${it.user}${it.assistant === '' ? '' : ` → 你: ${it.assistant}`}`,
              )].join('\n'),
          }],
        },
        execute(args) {
          const rows = searchEntries(db, args)
          return {
            count: rows.length,
            items: rows.map((r) => ({
              id: r.id,
              day: localStamp(r.t),
              zone: r.hot === 1 ? 'hot' : 'cold',
              weight: Math.round((Number(r.w) || 0) * 10) / 10,
              user: r.u.slice(0, 300),
              assistant: r.a.slice(0, 300),
            })),
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
