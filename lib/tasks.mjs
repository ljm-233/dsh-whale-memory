/**
 * 工作记忆：手上正在做什么。
 *
 * 来源只有一处：`db/NEXT.md` 的未勾选项。**单向**——NEXT 是源，`task` 表是ware；
 * 这里绝不反向写 NEXT.md（双向同步是两套写入打架，最后一定有一边丢，见 brain-plan 第六节）。
 *
 * 注入只在记忆卡里加**一行**（`taskLine()`），空栈就不出现，也不占 `MEMORY_BUDGET_CHARS`。
 */
import { readFileSync } from 'node:fs'

/** 一条任务最多显示几个字：栈顶那行是提示，不是清单。 */
const TITLE_CAP = 22
/** 整行硬上限：再长就把记忆卡挤没了（它不占 budgetChars，但也不该白烧上下文）。 */
const LINE_CAP = 96

/**
 * 建表。挂 `ensure*` 迁移段，老库补表、新库建表。
 *
 * @param {object} db 记忆库
 */
export function ensureTaskTable(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        space      TEXT NOT NULL DEFAULT 'default',
        title      TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'doing',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        src        TEXT NOT NULL DEFAULT 'NEXT.md'
      );
      CREATE INDEX IF NOT EXISTS idx_task_status ON task(space, status, updated_at);
    `)
  } catch { /* 建不出表就当没有工作记忆 */ }
}

/**
 * 从 NEXT.md 正文里取未完成项（`- [ ] ...`）。
 *
 * 只认复选框这一种写法：别的行是标题、说明、时间表，不是待办。
 *
 * @param {string} md NEXT.md 正文
 * @returns {Array<{title:string, line:number}>}
 */
export function parseOpen(md) {
  const out = []
  const seen = new Set()
  const lines = String(md ?? '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*[-*]\s*\[\s\]\s+(.+?)\s*$/u.exec(lines[i])
    if (!m) continue
    const title = m[1].replace(/\*\*/g, '').trim()
    if (title === '' || seen.has(title)) continue
    seen.add(title)
    out.push({ title, line: i + 1 })
  }
  return out
}

/**
 * 把 NEXT.md 的未完成项同步进 `task` 表。
 *
 * 幂等：同一份 NEXT 跑两次，第二次 `inserted` / `revived` / `closed` 全是 0。
 * 没变就不动 `updated_at`——跑脚本不该让任务「最近动过」，栈序才不会自己跳。
 *
 * @param {object} db 记忆库
 * @param {{nextPath:string, space?:string, now?:number, readFile?:Function}} [opts]
 * @returns {{inserted:number, revived:number, closed:number, total:number, missing:boolean}}
 */
export function syncFromNext(db, opts = {}) {
  const space = String(opts.space ?? 'default')
  const now = Number(opts.now ?? Date.now())
  const src = 'NEXT.md'
  const readFile = typeof opts.readFile === 'function' ? opts.readFile : readFileSync
  let md = ''
  try {
    md = String(readFile(String(opts.nextPath ?? ''), 'utf8'))
  } catch {
    return { inserted: 0, revived: 0, closed: 0, total: 0, missing: true }
  }

  const items = parseOpen(md)
  const find = db.prepare('SELECT id, status FROM task WHERE space=? AND src=? AND title=?')
  const insert = db.prepare('INSERT INTO task(space,title,status,created_at,updated_at,src) VALUES(?,?,?,?,?,?)')
  const revive = db.prepare("UPDATE task SET status='doing', updated_at=? WHERE id=?")
  let inserted = 0
  let revived = 0
  for (const it of items) {
    const row = find.get(space, src, it.title)
    if (!row) {
      insert.run(space, it.title, 'doing', now, now, src)
      inserted += 1
    } else if (row.status === 'done') {
      revive.run(now, row.id)
      revived += 1
    }
  }

  // NEXT 里划掉/删掉的，收进 done——不然栈顶会一直挂着已经做完的事。
  const keep = new Set(items.map((i) => i.title))
  let closed = 0
  try {
    const open = db.prepare("SELECT id, title FROM task WHERE space=? AND src=? AND status IN ('doing','blocked')")
      .all(space, src)
    const done = db.prepare("UPDATE task SET status='done', updated_at=? WHERE id=?")
    for (const row of open) {
      if (keep.has(row.title)) continue
      done.run(now, row.id)
      closed += 1
    }
  } catch { /* 收尾失败不影响已插入的部分 */ }

  return { inserted, revived, closed, total: items.length, missing: false }
}

/**
 * 栈顶：正在做的最上面，其次按最近动过排序。
 *
 * @param {object} db 记忆库
 * @param {{space?:string, limit?:number}} [opts]
 * @returns {Array<{id:number, title:string, status:string, updated_at:number}>}
 */
export function stackTop(db, opts = {}) {
  const space = String(opts.space ?? 'default')
  const limit = Math.max(0, Math.min(10, Number(opts.limit ?? 3) || 3))
  if (limit === 0) return []
  try {
    return db.prepare(`
      SELECT id, title, status, updated_at FROM task
      WHERE space=? AND status IN ('doing','blocked')
      ORDER BY (status='doing') DESC, updated_at DESC, id DESC
      LIMIT ?
    `).all(space, limit)
  } catch { return [] }
}

/**
 * 记忆卡里那一行。空栈返回空串——空串在 runtime-context 里等于不存在。
 *
 * @param {object} db 记忆库
 * @param {{space?:string, limit?:number}} [opts]
 * @returns {string}
 */
export function taskLine(db, opts = {}) {
  const rows = stackTop(db, opts)
  if (rows.length === 0) return ''
  const body = rows.map((r) => {
    const t = String(r.title ?? '').trim()
    if (t === '') return ''
    const head = r.status === 'blocked' ? '（卡住）' : ''
    return head + (t.length > TITLE_CAP ? `${t.slice(0, TITLE_CAP)}…` : t)
  }).filter((s) => s !== '').join(' / ')
  if (body === '') return ''
  return `手上：${body.length > LINE_CAP ? `${body.slice(0, LINE_CAP)}…` : body}`
}
