/**
 * 建库与迁移：打开 db、建表、补列、对索引。
 *
 * 整块从 index.mjs 原样搬出来，只把外层包成 openMemory()，
 * 内部引用的 memoryDir / config / space 从参数来，名字与顺序不变。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { openDb } from './db-open.mjs'
import { numCfg } from '../shared.mjs'
import { checkFts } from './fts.mjs'
import { ensureFactColumns } from './facts.mjs'
import { ensureHitColumns, recomputeTiers } from '../tidy.mjs'
import { ensureMoodTable } from '../domain/mood.mjs'
import { ensureSpeakerColumns } from '../domain/speaker.mjs'
import { ensureAdmitTable } from '../admission.mjs'
import { ensureTaskTable, syncFromNext } from '../tasks.mjs'
import { ensureReflectionTable } from '../reflect.mjs'
import { HOT_ZONE_MAX } from '../constants.mjs'

/**
 * 开库 + 建表 + 迁移旧库。
 *
 * @param {object} deps 依赖
 * @param {string} deps.memoryDir 记忆库目录
 * @param {string} deps.dbPath 库文件
 * @param {object} deps.config 插件配置
 * @param {Function} deps.space 当前记忆空间
 * @returns {object} db
 */
export function openMemory({ memoryDir, dbPath, config, space }) {
  mkdirSync(memoryDir, { recursive: true })
  // busy timeout：默认 0，任何一次短暂的锁争用都会立刻抛 database is locked，
  // 把整轮对话带崩。给 5 秒缓冲，真死锁仍然会失败，但不再一碰就炸。
  const db = openDb(dbPath, { timeout: 5000 })
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS entries (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      u       TEXT NOT NULL,
      a       TEXT NOT NULL,
      t       INTEGER NOT NULL,
      w       REAL NOT NULL DEFAULT 1,
      emo     TEXT NOT NULL DEFAULT '[]',
      vec     BLOB,
      hot     INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_entries_hot ON entries(hot, t);
    CREATE TABLE IF NOT EXISTS facts (
      id  INTEGER PRIMARY KEY AUTOINCREMENT,
      f   TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS stats (
      k TEXT PRIMARY KEY,
      v INTEGER NOT NULL DEFAULT 0
    );
    -- 按天记账：累计数看不出趋势，这里一天一行。
    CREATE TABLE IF NOT EXISTS daily_stats (
      day TEXT NOT NULL,
      k   TEXT NOT NULL,
      v   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, k)
    );
    CREATE TABLE IF NOT EXISTS diary (
      day        TEXT PRIMARY KEY,
      text       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    -- 修正记录：改掉的那条原样留在这里，主表只放当下的真相。
    CREATE TABLE IF NOT EXISTS revisions (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id  INTEGER NOT NULL,
      action    TEXT NOT NULL,
      before_u  TEXT NOT NULL,
      before_a  TEXT NOT NULL,
      after_u   TEXT,
      after_a   TEXT,
      reason    TEXT NOT NULL DEFAULT '',
      at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_revisions_entry ON revisions(entry_id);
    -- 跨窗口的近期事件：不管哪个会话、哪个工具，都写进同一条线。
    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      at      INTEGER NOT NULL,
      session TEXT NOT NULL,
      window  TEXT NOT NULL DEFAULT '',
      kind    TEXT NOT NULL,
      text    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
    -- 杂项键值：目前放「记忆取舍的倾向」，压缩时参与判断。
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
    -- 场景层：同一条线索下的旧事收成一段，供注入时按「一段经历」给，而不是四条碎片。
    CREATE TABLE IF NOT EXISTS scenes (
      topic     TEXT PRIMARY KEY,
      body      TEXT NOT NULL,
      entry_ids TEXT NOT NULL DEFAULT '[]',
      n         INTEGER NOT NULL DEFAULT 0,
      updated   INTEGER NOT NULL
    );
    -- 实体与共现边：谁和谁总一起出现，纯统计，可整表重建（按空间分开）。
    CREATE TABLE IF NOT EXISTS entities (
      name    TEXT NOT NULL,
      space   TEXT NOT NULL DEFAULT 'default',
      n       INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL,
      PRIMARY KEY (name, space)
    );
    CREATE TABLE IF NOT EXISTS edges (
      a       TEXT NOT NULL,
      b       TEXT NOT NULL,
      space   TEXT NOT NULL DEFAULT 'default',
      w       INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL,
      PRIMARY KEY (a, b, space)
    );
    -- 本会话已经注入过的记忆：同一段不重复占上下文，压缩后可再注入。
    CREATE TABLE IF NOT EXISTS recall_seen (
      session  TEXT NOT NULL,
      entry_id INTEGER NOT NULL,
      at       INTEGER NOT NULL,
      PRIMARY KEY (session, entry_id)
    );
    -- 证据链：结论（entries.a）与它的原始出处分开放，原始出处只追加、不参与合并改写。
    CREATE TABLE IF NOT EXISTS entry_evidence (
      entry_id    INTEGER NOT NULL,
      source      TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      created     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entry_evidence_entry ON entry_evidence(entry_id);
  `)

  // 全文检索：trigram 分词对中文友好（≥3 字），触发器跟着主表走，不用手动维护。
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        u, a, content='entries', content_rowid='id', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS entries_fts_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, u, a) VALUES (new.id, new.u, new.a);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_fts_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, u, a) VALUES ('delete', old.id, old.u, old.a);
      END;
      DROP TRIGGER IF EXISTS entries_fts_au;
      CREATE TRIGGER entries_fts_au AFTER UPDATE OF u, a ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, u, a) VALUES ('delete', old.id, old.u, old.a);
        INSERT INTO entries_fts(rowid, u, a) VALUES (new.id, new.u, new.a);
      END;
    `)
    // 只比条数不够：外部内容表条数一样也可能索引对不上。
    // 用 FTS5 自带 integrity-check 逐条比对，坏了就重建。
    const verdict = checkFts(db)
    if (!verdict.ok) {
      console.log('[whale-memory] 全文索引对不上，已重建:', verdict.error ?? '')
    } else if (verdict.repaired) {
      console.log('[whale-memory] 全文索引已重建')
    }
  } catch { /* fts5 不可用就退回 LIKE，别影响启动 */ }

  /**
   * 给已有的表补一列。SQLite 没有 IF NOT EXISTS，只能先问再改。
   *
   * @param {string} table 表名
   * @param {string} column 列名
   * @param {string} ddl 列定义
   */
  const ensureColumn = (table, column, ddl) => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all()
      if (cols.some((c) => c.name === column)) return
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
    } catch { /* 加不上就按没有处理 */ }
  }

  // 谁写的、谁改的：跨 Agent 共享时靠这两列划边界。
  ensureColumn('entries', 'owner', "TEXT NOT NULL DEFAULT ''")
  // 记忆空间：同一份库里按空间隔离，默认空间叫 default，老条目全部落在这里。
  ensureColumn('entries', 'space', "TEXT NOT NULL DEFAULT 'default'")
  // 事实和场景也要分空间，否则 A 空间的事实会漏进 B 空间的上下文。
  ensureColumn('facts', 'space', "TEXT NOT NULL DEFAULT 'default'")
  // 事实的有效期与冲突表：老库补两列、老行回填 valid_from，以及 fact_conflicts。
  ensureFactColumns(db)
  ensureColumn('scenes', 'space', "TEXT NOT NULL DEFAULT 'default'")
  // 召回计数与层级：hits 是「被想起过几次」，tier 0 是热区、1..N 越深越靠后。
  // 两列都只加不改语义；老库补列后按 hot 把层级填一次，之后由召回自己维护。
  ensureHitColumns(db)
  // 情绪记账历史：和上面两处一样，老库补表、新库建表，只加不改。
  ensureMoodTable(db)
  // 说话人与重要性：entries 补 spk/imp 两列 + 索引，另建 person（同名人可并存）。
  // 都只加不改：spk 默认空串 = 不知道谁说的，imp 默认 NULL = 走自动公式。
  // 补不上（库锁死/只读）要留一句话：写入路径会退化成不带 spk，静默降级最难查。
  if (ensureSpeakerColumns(db) === false) {
    console.warn('[whale-memory] spk/imp 列没补上：说话人这一轮起停止记录（写入退化为不带 spk）')
  }
  // 大脑三件的第一版：三张新表，全部只加不改。删表即回滚——
  // 没有任何既有路径读它们（取舍层影子只写、工作记忆只注入一行、反思只落表）。
  ensureAdmitTable(db)
  ensureTaskTable(db)
  ensureReflectionTable(db)
  // 任务栈的唯一来源是 `NEXT.md`（单向）。这里开机同步一次：
  // 不同步的话 `task` 表永远是空的，卡片底部那行「手上：…」也就永远不出现
  // （以前只有 scripts/task-sync.mjs 手动跑，等于这个功能默认是死的）。
  {
    const nextPath = join(memoryDir, 'NEXT.md')
    try {
      const r = syncFromNext(db, { nextPath, space: space() })
      if (r.missing !== true && (r.inserted + r.revived + r.closed) > 0) {
        console.log(`[whale-memory] 任务栈对齐 NEXT.md：新增 ${r.inserted} / 复活 ${r.revived} / 收档 ${r.closed}（共 ${r.total} 项未完成）`)
      }
    } catch { /* NEXT.md 是外部文件，读不了就是没任务栈，不影响主流程 */ }
  }
  // 启动时把分层对齐一次：hot 由 tier 派生，tier 按 (权重, 时间) 取前 hotZoneMax 条。
  // 不这么做的话，夜班没跑之前热区会一直是上次留下的几条（曾经长期卡在 4）。
  try { recomputeTiers(db, numCfg(config.hotZoneMax, HOT_ZONE_MAX, 1, 200, true)) } catch { /* 起不来不影响主流程 */ }

  // entities/edges 的旧结构没有 space 也没有复合主键，ALTER 改不了主键；
  // 它们都是纯派生数据，直接重建最省事（下一次 rebuild 会重新填）。
  try {
    const edgeCols = db.prepare('PRAGMA table_info(edges)').all()
    if (edgeCols.length > 0 && !edgeCols.some((c) => c.name === 'space')) {
      db.exec('DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS entities;')
      db.exec(`
        CREATE TABLE entities (
          name TEXT NOT NULL, space TEXT NOT NULL DEFAULT 'default',
          n INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL,
          PRIMARY KEY (name, space)
        );
        CREATE TABLE edges (
          a TEXT NOT NULL, b TEXT NOT NULL, space TEXT NOT NULL DEFAULT 'default',
          w INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL,
          PRIMARY KEY (a, b, space)
        );
      `)
    }
  } catch { /* 重建失败就按没有图处理 */ }

  // 依赖 space 列的索引放在迁移之后建，否则老库还没这一列。
  for (const ddl of [
    'CREATE INDEX IF NOT EXISTS idx_entries_space_hot ON entries(space, hot, t)',
    'CREATE INDEX IF NOT EXISTS idx_scenes_space ON scenes(space, updated)',
    'CREATE INDEX IF NOT EXISTS idx_edges_space_w ON edges(space, w)',
  ]) {
    try { db.exec(ddl) } catch { /* 没有对应列就跳过 */ }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS spaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
  )`)
  ensureColumn('revisions', 'actor', "TEXT NOT NULL DEFAULT ''")

  return db
}
