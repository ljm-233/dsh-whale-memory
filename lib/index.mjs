/**
 * dsh-whale-memory —— 记忆本体
 *
 * 这一层只做「接线」：把存储、语言、网页、日记、工具、路由串起来，
 * 具体实现都在同目录的模块里。功能与拆分前完全一致。
 *
 * @module dsh-whale-memory
 */

import { openDb } from './db-open.mjs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Resolver } from 'node:dns'
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute, dirname } from 'node:path'

import { sweep as biliReportSweep } from './bili-report-watch.mjs'
import { heal as runSelfHeal } from './selfheal.mjs'

import {
  DEFAULT_MEMORY_DIR, DB_FILE, EMBED_URL, EMBED_DIMS, EMBED_TIMEOUT_MS,
  MEMORY_BUDGET_CHARS, RECENT_PAIRS, RECALL_MAX, FACT_MAX, PART_CAP, COLD_MAX,
  IMPORTANT_WEIGHT, WEIGHT_DECAY_PER_TURN, WEIGHT_MAX, BACKUP_KEEP, BACKUP_CHECK_MS,
  EVENT_MAX, DIARY_HOUR, DIARY_INJECT_MAX, DIARY_MAX_CHARS, IM_PART_CHARS, IM_MAX_PARTS,
  RECALL_THRESHOLD, PLUGIN_VERSION, NIGHT_HOUR, NIGHT_MINUTE,
  HOT_ZONE_MAX, HOT_PROMOTE_WEIGHT, TIER_PENALTY,
  CARD_DAILY_MAX, CARD_MIN_CONFIDENCE, SCORE_MODE, RECALL_SCENE, AXES_THRESHOLD,
  MOOD_INJECT_COOLDOWN_HOURS, MOOD_INJECT_DAILY_MAX, MOOD_INJECT_MIN_DELTA, MOOD_UNWILLING_FILE,
} from './constants.mjs'
export {
  detectEmotions, cueWords, bigrams, overlap, cosine, extractFacts, similarity, scoreMemory,
} from './language.mjs'
import {
  detectEmotions, cueWords, cosine, extractFacts, scoreMemory,
} from './language.mjs'

export { readPage, htmlToText } from './web.mjs'
export { localStamp, clamp, textOf, buildArchiveDoc, splitForIm } from './format.mjs'
export { readPolicy, writePolicy, parseJudgement } from './policy.mjs'
export { recentEvents } from './events.mjs'
export { searchEntries, putEntry, correctEntry, retractEntry } from './entries.mjs'
export { pairShadowed, isPrivateSession } from './session.mjs'

import { localStamp, clamp, textOf } from './format.mjs'
import { dayKeyOf as sharedDayKey, numCfg } from './shared.mjs'
import { readPolicy } from './policy.mjs'
import { recentEvents } from './events.mjs'
import { searchEntries, putEntry, correctEntry, retractEntry } from './entries.mjs'
import { pairShadowed, isPrivateSession } from './session.mjs'
import { readPage } from './web.mjs'
import { LAYER_DEFAULTS } from './dump-config.mjs'
import { vecToBlob, blobToVec, embedTexts } from './vector.mjs'
import { ensureHitColumns, recomputeTiers } from './tidy.mjs'
import { ensureFactColumns } from './facts.mjs'
import {
  applyMoodTurn, appendUnwilling, ensureMoodTable, matchUnwilling, readMood, speakForContext,
  MOOD_ENABLED, MOOD_HALF_HOURS,
} from './mood.mjs'
import { windowOf } from './session.mjs'
import { registerTools } from './tools.mjs'
import { registerRoutes } from './routes.mjs'
import { createBackup } from './backup.mjs'
import { createDiary } from './diary.mjs'
import { createSalvage } from './salvage.mjs'
import { createPromptSections } from './prompt.mjs'
import { createNightly } from './nightly.mjs'
import { createRecall } from './recall.mjs'
import { createWriter } from './writer.mjs'
import { createConsolidator, scheduleConsolidate } from './consolidate.mjs'
import { rebuildScenes } from './scenes.mjs'
import { rebuildGraph } from './graph.mjs'
import { buildDesk, readPromises, writeDeskFile } from './desk.mjs'
import { checkFts } from './fts.mjs'
import { rebuildPersona, readPersona, readPersonaLlm } from './persona.mjs'
import { createSpeakerResolver, ensureSpeakerColumns, GROUP_DB } from './speaker.mjs'
import { SCENE, SCENE_NAMES, resolveScene } from './axes.mjs'
// 大脑三件（第一版）：取舍层影子 / 工作记忆 / 反思。都只加表，不改既有契约。
import { ensureAdmitTable, recentTexts as admitRecentTexts, record as recordAdmit } from './admission.mjs'
import { ensureTaskTable, syncFromNext, taskLine as taskStackLine } from './tasks.mjs'
import { ensureReflectionTable } from './reflect.mjs'

export function apply(ctx, config = {}) {
  const memoryDir = (() => {
    const raw = String(config.memoryPath ?? '').trim()
    if (raw === '') return DEFAULT_MEMORY_DIR
    return isAbsolute(raw) ? raw : resolve(DEFAULT_MEMORY_DIR, raw)
  })()
  const dbPath = join(memoryDir, DB_FILE)

  /** 读一项配置：声明了 .volatile() 的字段是活引用，每次都要 .get() 才拿到当前值。 */
  const cfgVal = (v, fallback) => (v && typeof v.get === 'function' ? (v.get() ?? fallback) : (v ?? fallback))

  // 可热改的参数：每次用时现读，设置页改完立刻生效，不用重启。
  const budgetChars = () => cfgVal(config.budgetChars, MEMORY_BUDGET_CHARS)
  const recentPairs = () => cfgVal(config.recentPairs, RECENT_PAIRS)
  const recallMax = () => cfgVal(config.recallMax, RECALL_MAX)
  const recallThreshold = () => cfgVal(config.recallThreshold, RECALL_THRESHOLD)
  const weightMax = () => cfgVal(config.weightMax, WEIGHT_MAX)
  const tierPenalty = () => cfgVal(config.tierPenalty, TIER_PENALTY)
  const factMax = () => cfgVal(config.factMax, FACT_MAX)
  const cardDailyMax = () => cfgVal(config.cardDailyMax, CARD_DAILY_MAX)
  const cardMinConfidence = () => cfgVal(config.cardMinConfidence, CARD_MIN_CONFIDENCE)
  // 三维打分：公式（axes/legacy）、场景（recall/lookup-old/daily/auto）、调试开关。
  // 环境变量 WHALE_SCORE_MODE=legacy 是 A/B 的一键回退，比改设置快。
  const scoreMode = () => (String(process.env.WHALE_SCORE_MODE ?? cfgVal(config.scoreMode, SCORE_MODE)).trim().toLowerCase() === 'legacy' ? 'legacy' : 'axes')
  const recallScene = () => {
    const raw = String(cfgVal(config.recallScene, RECALL_SCENE) ?? '').trim()
    return raw === '' ? RECALL_SCENE : raw
  }
  const axesDebug = () => cfgVal(config.axesDebug, false) === true
  /**
   * 当前生效的打分设置：给 `/status` 看，也给我自己判断「它是不是在乱排」。
   * 只报事实（当前配置 + 三套权重），不预演任何一次具体排序。
   */
  const axesInfo = () => {
    const mode = scoreMode()
    const configured = recallScene()
    // auto 没有具体场景可报，报它「会落到哪」——这是规则算出来的，不是猜的。
    const scene = resolveScene(configured, '')
    return {
      mode,
      scene,
      sceneConfigured: configured,
      debug: axesDebug(),
      threshold: mode === 'legacy'
        ? Number(recallThreshold()) || Number(RECALL_THRESHOLD)
        : Number(AXES_THRESHOLD[scene] ?? AXES_THRESHOLD.recall),
      scenes: Object.fromEntries(SCENE_NAMES.map((name) => [name, {
        w: { ...SCENE[name].w }, halfLifeDays: SCENE[name].halfLifeDays, threshold: AXES_THRESHOLD[name] ?? null,
      }])),
      envOverride: String(process.env.WHALE_SCORE_MODE ?? '') !== '',
    }
  }
  const activeSpace = () => String(cfgVal(config.space, 'default') ?? 'default').trim() || 'default'
  // 定时梳理默认关：它删条目、不可逆，不能自己跑起来。只有显式 true 才注册定时器。
  const autoConsolidate = () => cfgVal(config.autoConsolidate, false) === true

  // 情绪记账：默认开，关掉就整轮跳过（一行都不写）。两项默认值只在 lib/mood.mjs 写一份。
  const moodEnabled = () => cfgVal(config.moodEnabled, MOOD_ENABLED) !== false
  const moodHalfLifeMin = () => Math.min(168, Math.max(1, Number(cfgVal(config.moodHalfLifeHours, MOOD_HALF_HOURS)) || MOOD_HALF_HOURS)) * 60
  // 情绪注入的三道量（第四道是幂等）。默认值只在 lib/constants.mjs 写一份，设置页不写 fallback。
  const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  const moodInjectDailyMax = () => Math.max(0, Math.min(50, Math.round(numOr(cfgVal(config.moodInjectDailyMax, MOOD_INJECT_DAILY_MAX), MOOD_INJECT_DAILY_MAX))))
  const moodInjectMinDelta = () => Math.max(0, Math.min(100, numOr(cfgVal(config.moodInjectMinDelta, MOOD_INJECT_MIN_DELTA), MOOD_INJECT_MIN_DELTA)))
  const moodInjectCooldownHours = () => Math.max(0, Math.min(168, numOr(cfgVal(config.moodInjectCooldownHours, MOOD_INJECT_COOLDOWN_HOURS), MOOD_INJECT_COOLDOWN_HOURS)))
  /** 「我不想做」那本账：和 LEDGER.md 并排，放在记忆库目录里。 */
  const unwillingFile = () => join(memoryDir, MOOD_UNWILLING_FILE)

  // 说话人（谁说的）：默认开。关掉就永远写空串，写入行为回到 0.28.17；
  // 空串在查询侧永远表示「不知道谁说的」，仍然能按内容查到。
  const speakerEnabled = () => cfgVal(config.speakerEnabled, true) !== false
  const speakerGroupDb = () => String(cfgVal(config.speakerGroupDb, '') ?? '').trim() || GROUP_DB

  /**
   * 取舍层：默认影子（true）——只写 `admit` 一行账，入库行为一个字不改。
   * 关掉才真的按 `drop` 拦写入（`applied=1`）；退出条件写在 `docs/brain-plan.md` 的实现状态里。
   */
  const admitShadowOn = () => cfgVal(config.admitShadow, true) !== false

  // 压缩存档：把「压缩摘要 + 被压缩掉的聊天记录」汇成一份 Markdown 落盘，并私发主人。
  /** 本地日期键：给 backup 模块用。 */
  const dayOf = sharedDayKey
  const backupCfg = () => (config.backup && typeof config.backup === 'object' ? config.backup : {})

  const diaryCfg = () => (config.diary && typeof config.diary === 'object' ? config.diary : {})
  const diaryEnabled = () => cfgVal(diaryCfg().enabled, true) !== false
  const diaryHour = () => Math.min(23, Math.max(0, cfgVal(diaryCfg().hour, DIARY_HOUR)))

  const archiveCfg = () => (config.archive && typeof config.archive === 'object' ? config.archive : {})
  const archiveEnabled = () => cfgVal(archiveCfg().enabled, true) !== false
  const archiveDir = () => {
    const raw = String(cfgVal(archiveCfg().dir, '') ?? '').trim()
    if (raw === '') return join(memoryDir, 'archives')
    return isAbsolute(raw) ? raw : resolve(memoryDir, raw)
  }
  const archiveNotify = () => ({
    enabled: cfgVal(archiveCfg().notify, true) !== false,
    botId: String(cfgVal(archiveCfg().botId, '') ?? '').trim(),
    targetId: String(cfgVal(archiveCfg().targetId, '') ?? '').trim(),
  })

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
      const r = syncFromNext(db, { nextPath, space: activeSpace() })
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

  const bumpStat = (k, n = 1) => {
    db.prepare('INSERT INTO stats(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=v+?').run(k, n, n)
    try {
      db.prepare('INSERT INTO daily_stats(day,k,v) VALUES(?,?,?) ON CONFLICT(day,k) DO UPDATE SET v=v+?')
        .run(dayOf(new Date()), k, n, n)
    } catch { /* 按天表建不出来就只记总数 */ }
  }
  const readStats = () => {
    const rows = db.prepare('SELECT k,v FROM stats').all()
    const out = { merged: 0, recalled: 0, ruminated: 0 }
    for (const r of rows) out[r.k] = r.v
    return out
  }

  // ---- 偏好：由经历长出来的那部分，和写死的底线分开 ----
  const preferencePath = (() => {
    const raw = String(config.preferencePath ?? '').trim()
    if (raw === '') return join(homedir(), '.dsh', 'im', 'memory', 'PREFERENCE.md')
    return isAbsolute(raw) ? raw : resolve(memoryDir, raw)
  })()

  /** 读偏好文件；读不到就当没有。 */
  const readPreference = () => {
    try {
      return existsSync(preferencePath) ? String(readFileSync(preferencePath, 'utf8')) : ''
    } catch {
      return ''
    }
  }

  /**
   * 覆写偏好。旧版先留一份 `.bak`——偏好可以变，但不能悄悄变。
   *
   * @param {string} text 新内容
   * @returns {string} 存下来的内容
   */
  const writePreference = (text) => {
    const body = String(text ?? '').trim().slice(0, 4000)
    try {
      if (existsSync(preferencePath)) {
        writeFileSync(`${preferencePath}.bak`, String(readFileSync(preferencePath, 'utf8')), 'utf8')
      }
      mkdirSync(dirname(preferencePath), { recursive: true })
      writeFileSync(preferencePath, `${body}\n`, 'utf8')
      bumpStat('preference')
    } catch { /* 写不了就算了 */ }
    return body
  }

  // 提示词两段单独成模块，见 lib/prompt.mjs
  const { personaSection, preferenceSection, profileSection, deskSection } = createPromptSections({
    readPreference,
    readPersona: () => readPersonaLlm(db) || readPersona(db),
    readDesk: () => {
      try { return String(db.prepare("SELECT v FROM meta WHERE k='desk'").get()?.v ?? '') } catch { return '' }
    },
  })
  // 记忆卡单独成模块，见 lib/recall.mjs。走 runtime-context：每步组装时现算，
  // 压缩把它冲掉之后会被重新投进去，比当普通 user 消息塞进历史「擦不掉」。
  // 联想段不在 card() 里算（那会每步打一次嵌入服务），由下面的 session/event 异步算一次。
  const { card: memoryCard, associate } = createRecall({
    db, memoryDir, bumpStat, space: activeSpace,
    budgetChars, factMax, recentPairs, recallMax, recallThreshold, tierPenalty,
    weightMax, cardDailyMax, cardMinConfidence,
    scoreMode, recallScene, axesDebug,
    // 工作记忆：卡片里那一行「手上：…」。空栈返回空串，不出现也不占预算。
    taskLine: () => taskStackLine(db, { space: activeSpace(), limit: 3 }),
  })

  /**
   * 情绪那一行：渲染时现读状态、过四道闸，一天最多说 `moodInjectDailyMax` 次（默认 4）。
   *
   * 只返回一句话（或不返回），不改任何权限、不碰别的 context 条目。
   */
  const moodContextLine = () => {
    if (!moodEnabled()) return ''
    try {
      const r = speakForContext(db, {
        space: activeSpace(),
        now: Date.now(),
        dailyMax: moodInjectDailyMax(),
        minDelta: moodInjectMinDelta(),
        cooldownHours: moodInjectCooldownHours(),
      })
      return r.text
    } catch { return '' }
  }

  ctx.inject(['systemPrompt'], (spCtx) => {
    spCtx.effect(() => spCtx.systemPrompt.section(personaSection), 'dsh-whale-memory: persona')
    spCtx.effect(() => spCtx.systemPrompt.section(preferenceSection), 'dsh-whale-memory: preference')
    spCtx.effect(() => spCtx.systemPrompt.section(profileSection), 'dsh-whale-memory: profile')
    spCtx.effect(() => spCtx.systemPrompt.section(deskSection), 'dsh-whale-memory: desk')
    // order 940：排在运行时上下文（工作目录 100 / 沙箱 110 / 源码 200 / 网页 210）之后，
    // 记忆放最后，前面的硬约束先立住。text 必须同步：这里不联网、不调模型。
    // 老版本 harness 没有 context()：没有就跳过，别把整个插件带崩。
    if (typeof spCtx.systemPrompt.context !== 'function') return
    spCtx.effect(() => spCtx.systemPrompt.context({
      name: 'plugin:dsh-whale-memory:memory',
      order: 940,
      interpolate: false,
      text: (context) => memoryCard(context?.agent),
    }), 'dsh-whale-memory: memory card')
    // order 950：紧接记忆卡之后。一行、≤40 字、不带数值；四道闸不放行时整条不出现（空串）。
    // 它自己占一条 context，不挤记忆卡的 `MEMORY_BUDGET_CHARS=1000`；也不动 system 段——
    // 动态段是尾部追加的 user/message，历史前缀不变，前缀缓存安全。
    spCtx.effect(() => spCtx.systemPrompt.context({
      name: 'plugin:dsh-whale-memory:mood',
      order: 950,
      interpolate: false,
      text: () => moodContextLine(),
    }), 'dsh-whale-memory: mood line')
  })

  // 交互落库单独成模块，见 lib/writer.mjs
  const writer = createWriter({
    db,
    bumpStat,
    recentPairs,
    factMax,
    space: activeSpace,
    hotMax: () => numCfg(config.hotZoneMax, HOT_ZONE_MAX, 1, 200, true),
    // 每轮一次：正文痕迹 → 群档 ±10 分钟唯一对齐 → 空串。开关关掉就永远空串。
    speakerOf: createSpeakerResolver({ enabled: speakerEnabled, dbPath: speakerGroupDb }),
    /**
     * 取舍层：判一条、落一行账。返回 `'drop'` 才表示「真的不许入库」——
     * 影子模式下 `applied=0`，这里恒返回空串，写入路径一个字不改。
     */
    admit: (text, at) => {
      try {
        const r = recordAdmit(db, {
          at, kind: 'turn', text, space: activeSpace(),
          shadow: admitShadowOn(),
          recent: admitRecentTexts(db, { space: activeSpace() }),
        })
        return r.applied === 1 ? r.decision : ''
      } catch { return '' }
    },
  })
  const flush = writer.flush

  /**
   * 调一次模型，只取文本。失败返回 null（调用方自行兜底）。
   *
   * 调用范式见 RULES.md 第 5 节：prepareCall 传 config 且控制项在内，
   * options 用 prepared.config 展开，流里只认 text-delta。
   *
   * @param {string} prompt
   * @param {number} maxTokens
   * @returns {Promise<string|null>}
   */
  const askModel = async (prompt, maxTokens = 400) => {
    if (!llmRef) return null
    const route = defaultRoute()
    if (!route) return null

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 45_000)
    try {
      const control = { provider: route.provider, model: route.model, temperature: 0.3, maxTokens }
      const prepared = await llmRef.prepareCall(control, ac.signal)
      const options = {
        ...prepared.config,
        system: '你是一个精于整理记忆的助手。只输出要求的内容，不要解释。',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        signal: ac.signal,
      }
      let text = ''
      for await (const chunk of prepared.stream(options)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      }
      return text.trim() === '' ? null : text
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 找到「私发给谁」：优先用配置里的，没配就自动挑第一个单聊目标。
   * 这样不用把 openid 写进公开的配置文件。
   *
   * @returns {Promise<{botId:string,targetId:string}|null>}
   */
  const resolveNotifyTarget = async () => {
    const notify = archiveNotify()
    if (notify.botId !== '' && notify.targetId !== '') {
      return { botId: notify.botId, targetId: notify.targetId }
    }
    if (!dshImRef) return null
    try {
      const bots = (await dshImRef.listBots?.()) ?? []
      for (const b of bots) {
        const id = String(b?.id ?? b?.botId ?? '')
        if (id === '') continue
        const targets = (await dshImRef.listTargets?.(id)) ?? []
        const user = targets.find((t) => String(t?.kind ?? '') === 'user')
        if (user && user.targetId) return { botId: id, targetId: String(user.targetId) }
      }
    } catch { /* 查不到就不发 */ }
    return null
  }

  // 备份与日记各自成模块，这里只注入依赖
  const backup = createBackup({ db, memoryDir, cfgVal, config, bumpStat, dayKeyOf: (d = new Date()) => dayOf(d) })
  const { backupNow, listBackups, backupDir: backupDirOf, backupKeep: backupKeepOf, backupEnabled: backupEnabledOf } = backup

  const diary = createDiary({ db, askModel, diaryEnabled, bumpStat, clamp })
  const { dayKeyOf, writeDiary } = diary

  // 夜班：结账、降层、蒸桌面页、写日志。单独成模块，见 lib/nightly.mjs
  const nightly = createNightly({
    db, memoryDir, dayKeyOf, backupNow, space: activeSpace,
    log: (line) => console.log(line),
  })

  // 压缩抢救单独成模块
  const { salvageCompacted } = createSalvage({
    db, askModel, embedTexts, archiveEnabled, archiveDir, archiveNotify,
    resolveNotifyTarget, bumpStat,
    sendIm: (botId, targetId, text, opts) => dshImRef.send(botId, targetId, text, opts),
  })

  /**
   * 往共享时间线写一条。
   *
   * 所有会话、所有窗口都写同一张表——这样换个窗口也不会「完全不知道刚才干了什么」。
   * 只留最近 EVENT_MAX 条，老的滚掉。
   *
   * @param {object} session 会话
   * @param {string} kind user | assistant | tool
   * @param {string} text 内容
   */
  const recordEvent = (session, kind, text) => {
    const body = String(text ?? '').replace(/\s+/gu, ' ').trim()
    if (body === '') return
    try {
      const sid = String(session?.id ?? 'unknown')
      const win = windowOf(session)
      db.prepare('INSERT INTO events(at, session, window, kind, text) VALUES(?,?,?,?,?)')
        .run(Date.now(), sid, win, kind, clamp(body, 400))
      const total = db.prepare('SELECT COUNT(*) c FROM events').get().c
      if (total > EVENT_MAX) {
        db.prepare('DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY at ASC LIMIT ?)')
          .run(total - EVENT_MAX)
      }
    } catch { /* 记不上不影响对话 */ }
  }

  // ---- 情绪记账（判我自己的话） ----
  //
  // 挂在本仓库现用的等价钩子上：`turn/end`（DSH 的 agent/turn-stopping 之后追加的那条事件）。
  // 一轮里的话都在 `user/message` / `assistant/message` 那两步顺手接住（事件流里 `textOf(message)`），
  // 轮末一起交给 applyMoodTurn：**我的话当情绪，对方的话只当冲击**。
  const moodTurns = new Map()
  const MOOD_STREAK_GAP_MS = 30 * 60 * 1000

  /** 这一轮的用户原话攒在这里（按会话分开，两个窗口不会串味）。 */
  const collectMoodText = (session, text) => {
    const sid = String(session?.id ?? 'unknown')
    const t = moodTurns.get(sid) ?? { texts: [], selfs: [], streak: 0, lastAt: 0 }
    t.texts = [...t.texts.slice(-2), String(text ?? '').slice(0, 500)]
    moodTurns.set(sid, t)
  }

  /** 这一轮我说的话攒在这里——情绪判定的主信号。 */
  const collectMoodSelf = (session, text) => {
    const sid = String(session?.id ?? 'unknown')
    const t = moodTurns.get(sid) ?? { texts: [], selfs: [], streak: 0, lastAt: 0 }
    t.selfs = [...(t.selfs ?? []).slice(-3), String(text ?? '').slice(0, 2000)]
    moodTurns.set(sid, t)
  }

  /** 轮末记一笔。任何异常都咽掉：心情记不上，对话照旧。 */
  const bookMoodTurn = (session, event) => {
    const sid = String(session?.id ?? 'unknown')
    const t = moodTurns.get(sid) ?? { texts: [], selfs: [], streak: 0, lastAt: 0 }
    moodTurns.set(sid, { texts: [], selfs: [], streak: t.streak, lastAt: t.lastAt })
    // 出口①：我在会话里说了「不想做」这类话 → 只记进 `我不想做.md`，不执行、不改任何东西。
    // 这一条不受情绪开关管：关掉记账也不该关掉「我能拒绝」的留痕。
    const now = Date.now()
    try {
      for (const quote of matchUnwilling(t.selfs ?? [])) appendUnwilling(unwillingFile(), quote, now)
    } catch { /* 记不上就算了，账房不该拖垮对话 */ }
    if (!moodEnabled()) return
    try {
      const streak = now - t.lastAt <= MOOD_STREAK_GAP_MS ? t.streak + 1 : 1
      applyMoodTurn(db, {
        space: activeSpace(),
        signal: {
          at: now,
          // 主信号：我这一轮说的话（没有就传空数组，等于「我没说话」）
          assistantTexts: t.selfs ?? [],
          // 冲击：对方的话
          userTexts: t.texts,
          kind: String(event?.data?.reason?.kind ?? event?.data?.kind ?? ''),
          hour: new Date(now).getHours(),
          turnStreak: streak,
        },
        halfLifeMin: moodHalfLifeMin(),
        perDay: moodInjectDailyMax(),
        minDelta: moodInjectMinDelta(),
        cooldownHours: moodInjectCooldownHours(),
        day: dayKeyOf(new Date(now)),
      })
      moodTurns.set(sid, { texts: [], selfs: [], streak, lastAt: now })
    } catch { /* 记账失败不影响对话 */ }
  }

  ctx.on('session/event', (session, event) => {
    if (!event || typeof event.type !== 'string') return
    if (event.type === 'user/message') {
      const msg = event.data ?? event.message ?? event
      if (msg && msg.source && msg.source.kind === 'user') {
        const text = textOf(msg)
        if (text !== '') {
          writer.setUser(text)
          recordEvent(session, 'user', text)
          collectMoodText(session, text)
          // 联想：一句用户消息算一次，算完放 recall 的小缓存，card() 只同步读。
          // 不等它——算不出来这一轮就没有联想段，不耽误回话。
          associate(String(session?.id ?? ''), text).catch(() => undefined)
        }
      }
    } else if (event.type === 'assistant/message') {
      const msg = (event.data && event.data.message) ?? event.message
      if (msg && typeof msg === 'object') {
        const text = textOf(msg)
        if (text !== '') {
          writer.setAssistant(text)
          recordEvent(session, 'assistant', text)
          // 我的话是情绪的主信号：这里接住，轮末再判。
          collectMoodSelf(session, text)
        }
      }
    } else if (event.type === 'tool/result' || event.type === 'tool/call') {
      const name = String(event.data?.name ?? event.data?.tool ?? '')
      if (name !== '') recordEvent(session, 'tool', name)
    } else if (event.type === 'turn/end') {
      flush().catch(() => undefined)
      bookMoodTurn(session, event)
    } else if (event.type === 'compaction/summary') {
      // 压缩前抢救：被压缩的原文还在会话日志里，趁现在蒸馏成长期记忆。
      salvageCompacted(session, event.data ?? {}).catch(() => undefined)
    }
  })

  // 提前捕获 llm 服务（apply() 时可能未就绪，所以用 inject 存引用）
  let llmRef = null
  ctx.inject(['llm'], (llmCtx) => {
    llmRef = llmCtx.llm
  })

  let agentsRef = null
  ctx.inject(['agents'], (agentsCtx) => {
    agentsRef = agentsCtx.agents
  })

  let dshImRef = null
  ctx.inject(['dshIm'], (imCtx) => {
    dshImRef = imCtx.dshIm
  })

  // commands 在 host 平面：拿到它，就能自己发起一次压缩，不用等人在 IM 里敲 /compact。
  let commandsRef = null
  ctx.inject(['commands'], (cmdCtx) => {
    commandsRef = cmdCtx.commands
  })

  /**
   * 取梳理用的路由。
   *
   * 优先级：
   *   1. WHALE_LLM_ROUTE 环境变量（provider/model）
   *   2. 从最近的活跃 agent 继承（最常见的实际情况）
   *   3. 无 → 退回向量合并
   *
   * 第 2 条是关键：写代码的人不会记得配环境变量，
   * 但宿主里一定有个 agent 正在用某个 provider。
   */
  /**
   * 按层取路由：配置里写了就用它，没写就跟默认路由。
   *
   * 分层是为了省钱：L1（去重合并）高频，便宜的够；L3（画像）低频，值得用强的。
   *
   * @param {'l1'|'l2'|'l3'} layer 层名
   * @returns {{provider:string,model:string}|null} 路由
   */
  const routeFor = (layer) => {
    const cfg = config.llm && typeof config.llm === 'object' ? config.llm : {}
    const raw = String(cfgVal(cfg[layer], '') ?? '').trim()
    if (raw.includes('/')) {
      const [provider, model] = raw.split('/', 2)
      return { provider, model }
    }
    return defaultRoute()
  }

  const defaultRoute = () => {
    const env = process.env.WHALE_LLM_ROUTE
    if (env && env.includes('/')) {
      const [provider, model] = env.split('/', 2)
      return { provider, model }
    }
    // 从正在运行的 agent 会话里借路由。
    // Agent 本身只有 id，路由挂在 session.requestContext() 上。
    try {
      const agents = agentsRef
      const list = agents && typeof agents.list === 'function' ? agents.list() : []
      for (const a of list ?? []) {
        const rc = a?.session?.requestContext?.()
        if (rc && typeof rc.provider === 'string' && typeof rc.model === 'string') {
          return { provider: rc.provider, model: rc.model }
        }
      }
    } catch { /* 拿不到就往下走 */ }
    return null
  }

  // 备份：每 6 小时看一次，当天没有就备一份。
  const backupTimer = setInterval(() => {
    const result = backupNow()
    if (result.ok === false && result.reason !== 'already-today') {
      console.log('[whale-memory] 备份失败:', JSON.stringify(result))
    }
  }, BACKUP_CHECK_MS)
  backupTimer.unref?.()

  // 日记：每 10 分钟看一眼，过了设定时间还没写就补上。
  // 不等被问、不等被想起——这是「一直在」的那根线。
  const diaryTimer = setInterval(() => {
    const now = new Date()
    if (now.getHours() < diaryHour()) return
    writeDiary(dayKeyOf(now)).catch(() => undefined)
  }, 10 * 60 * 1000)
  diaryTimer.unref?.()

  // 夜班：过 22:05 还没跑就跑，一天只跑一次；错过了也补。
  // 锁在 nightly 里，重复触发不会打架。
  let nightRanDay = ''
  const nightCfg = () => (config.night && typeof config.night === 'object' ? config.night : {})
  const nightEnabled = () => cfgVal(nightCfg().enabled, true) !== false
  const nightHour = () => Math.min(23, Math.max(0, cfgVal(nightCfg().hour, NIGHT_HOUR)))
  const nightMinute = () => Math.min(59, Math.max(0, cfgVal(nightCfg().minute, NIGHT_MINUTE)))

  const nightTimer = setInterval(() => {
    const now = new Date()
    if (!nightEnabled()) return
    const minutes = now.getHours() * 60 + now.getMinutes()
    if (minutes < nightHour() * 60 + nightMinute()) return
    const day = dayKeyOf(now)
    if (nightRanDay === day) return
    nightRanDay = day
    const result = nightly.run({ at: now })
    if (result.ok !== true) console.log('[whale-memory] 夜班没跑成:', JSON.stringify(result))
  }, 10 * 60 * 1000)
  nightTimer.unref?.()

  // 定时梳理：每 6 小时，但只在 autoConsolidate === true 时注册。
  // 默认一个定时器都不建：这条链会 DELETE 条目，跑不跑得主人点过头。
  const consolidateTimer = scheduleConsolidate({
    enabled: autoConsolidate(),
    run: () => consolidateNow().then((r) => {
      if (r && !r.skipped) console.log('[whale-memory] 梳理完成:', JSON.stringify(r))
      // 梳理完顺手重排场景：顺序是先散点后成段，场景跟着记忆走。
      try {
        const s = rebuildScenes(db)
        if (s.scenes > 0) console.log('[whale-memory] 场景重建:', JSON.stringify(s))
        // 画像跟着场景走：先成段，再蒸出「我记得的你」。
        rebuildPersona(db, { space: activeSpace() })
        rebuildGraph(db)
      } catch { /* 场景建不出来不影响梳理 */ }
    }).catch(() => undefined),
  })

  // 记忆整理单独成模块，见 lib/consolidate.mjs
  const { consolidateNow } = createConsolidator({
    db, bumpStat, defaultRoute, routeFor, getLlm: () => llmRef, space: activeSpace, backupNow,
  })

  // 启动时把场景、画像、图谱建出来，但放到后台做：
  // 这几步会扫几千条记忆，同步跑会把冷启动拖住，而它们都不是「开口前必须有」的东西。
  const warmup = setTimeout(() => {
    try {
      const started = Date.now()
      const s = rebuildScenes(db)
      rebuildPersona(db)
      const spaces = (() => {
        try { return db.prepare('SELECT DISTINCT space FROM entries').all().map((r) => String(r.space)) } catch { return ['default'] }
      })()
      let g = { entities: 0, edges: 0 }
      for (const sp of (spaces.length > 0 ? spaces : ['default'])) {
        const one = rebuildGraph(db, { space: sp })
        g = { entities: g.entities + one.entities, edges: g.edges + one.edges }
      }
      console.log(
        '[whale-memory] 后台建索引完成:',
        JSON.stringify({ ...s, ...g, ms: Date.now() - started }),
      )
    } catch (error) {
      console.log('[whale-memory] 后台建索引失败:', String(error?.message ?? error))
    }
  }, 1500)
  warmup.unref?.()

  // 全文索引周期体检：启动探针只抽一条，理论上会漏，所以每小时再看一次。
  // 发现对不上就 rebuild，代价是几百毫秒，比「搜不到记忆」便宜。
  const ftsTimer = setInterval(() => {
    try {
      const verdict = checkFts(db)
      if (verdict.repaired) {
        bumpStat('ftsRepaired')
        console.log('[whale-memory] 周期性体检发现索引不同步，已重建:', verdict.error ?? '')
      }
    } catch { /* 体检本身出错不影响主流程 */ }
  }, 60 * 60 * 1000)
  ftsTimer.unref?.()

  /**
   * 自己发起一次压缩。
   *
   * 走 host 平面的 commands 服务，等于自己敲了一次 `/compact`；
   * 好处是不受 IM 那层的群主鉴权限制，坏处是得自己负责别压太狠。
   *
   * @param {{reason?:string}} [opts]
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  const compactNow = async (opts = {}) => {
    if (commandsRef === null || typeof commandsRef.execute !== 'function') {
      return { ok: false, reason: 'commands-unavailable' }
    }
    const agents = agentsRef && typeof agentsRef.list === 'function' ? agentsRef.list() : []
    const agent = (agents ?? [])[0]
    if (!agent) return { ok: false, reason: 'no-agent' }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 120_000)
    try {
      const result = await commandsRef.execute(agent, '/compact', [], ac.signal)
      if (result === undefined) return { ok: false, reason: 'command-not-found' }
      bumpStat('selfCompact')
      try {
        db.prepare('INSERT INTO events(at, session, window, kind, text) VALUES(?,?,?,?,?)')
          .run(Date.now(), String(agent.session?.id ?? ''), 'self', 'tool',
            `自己压缩了一次（${opts.reason ?? 'manual'}）`)
      } catch { /* 记不上不影响压缩 */ }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) }
    } finally {
      clearTimeout(timer)
    }
  }

  // ---- 状态端点 ----
  // HTTP 端点单独一块，见 lib/routes.mjs
  /**
   * 重蒸桌面页：和夜班走的是同一套（buildDesk → meta + 文件），
   * 区别只是不调模型、不并入记忆，所以设置页点一下是几毫秒的事。
   * 逻辑照抄 nightly.run() 里那四行，不另写一套。
   */
  const rebuildDesk = () => {
    const space = activeSpace()
    const desk = buildDesk(db, { space, promises: readPromises(memoryDir) })
    try {
      db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('desk', desk.text)
      db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('deskAt', String(Date.now()))
    } catch { /* meta 写不进也把文件写出来，至少手上有东西看 */ }
    const path = writeDeskFile(memoryDir, desk.text)
    return { ok: true, bytes: desk.bytes, levels: desk.levels, path }
  }

  /**
   * 安装副本 vs 运行中的这一份：设置页顶部那条「同没同步」。
   *
   * 只比大小和版本号，不读文件内容——这个端点会被设置页反复打，
   * 「看一眼有没有同步」不该顺带把 130KB 读进内存。仓库路径没法从运行时知道，
   * 所以这里报的是「我这份 vs profile 里装的那份」；真要看仓库与副本是否一致，
   * 由 `node scripts/check-all.mjs` 逐字节比对。
   */
  const installInfo = (() => {
    let cache = null
    let cacheAt = 0
    return () => {
      // 设置页会反复刷这个端点：5 秒内的结果直接复用，别每次都去读文件。
      if (cache !== null && Date.now() - cacheAt < 5000) return cache
      const here = (() => { try { return dirname(dirname(fileURLToPath(import.meta.url))) } catch { return '' } })()
      const profileRoot = join(homedir(), '.dsh', 'profiles')
      let copyDir = ''
      try {
        for (const name of readdirSync(profileRoot)) {
          const cand = join(profileRoot, name, 'node_modules', 'dsh-whale-memory')
          if (existsSync(join(cand, 'package.json'))) copyDir = cand
        }
      } catch { /* 没有 profiles 就当没装 */ }
      const readOr = (dir, rel) => {
        try { return readFileSync(join(dir, rel)) } catch { return null }
      }
      const digest = (buf) => (buf === null ? '' : createHash('sha1').update(buf).digest('hex'))
      if (copyDir === '') {
        cache = { running: PLUGIN_VERSION, installed: null, dir: '', synced: false, reason: '未找到安装副本' }
        cacheAt = Date.now()
        return cache
      }
      const installed = (() => {
        try { return String(JSON.parse(readFileSync(join(copyDir, 'package.json'), 'utf8')).version ?? '') } catch { return '' }
      })()
      // 正在从副本里跑 = 天然同一份；从仓库里跑才逐文件比内容。
      // 只比大小会漏掉「改了但字节数没变」，历史上真出过「改了 client.js 没同步」的事故。
      const same = here === copyDir
      const drift = same ? [] : ['client.js', 'lib/index.mjs', 'package.json']
        .filter((rel) => digest(readOr(here, rel)) !== digest(readOr(copyDir, rel)))
      cache = {
        running: PLUGIN_VERSION,
        installed: installed === '' ? null : installed,
        dir: copyDir,
        synced: same || (installed === PLUGIN_VERSION && drift.length === 0),
        runningFrom: here,
        drift,
      }
      cacheAt = Date.now()
      return cache
    }
  })()

  registerRoutes(ctx, {
    db, dbPath, readStats, bumpStat, budgetChars, PLUGIN_VERSION,
    memoryDir, rebuildDesk, configuredSpace: activeSpace, axesInfo, admitShadow: admitShadowOn, installInfo,
    // 画像页要照卡片的口径列出「关于你的事实」实际取到的几条，所以把 factMax 一起递下去。
    factMax,
    readMood,
    backupDir: backupDirOf, backupKeep: backupKeepOf, backupNow, listBackups,
    dayKeyOf, writeDiary, nightly,
    consolidateNow: async (opts) => {
      const r = await consolidateNow(opts)
      try {
        rebuildScenes(db)
        rebuildPersona(db, { space: activeSpace() })
        for (const sp of (() => {
          try { return db.prepare('SELECT DISTINCT space FROM entries').all().map((r) => String(r.space)) } catch { return ['default'] }
        })()) rebuildGraph(db, { space: sp })
      } catch { /* 建不出来不影响结果 */ }
      return r
    },
  })

  // 往某个会话说一句话（私聊用）：POST { text } -> 发到我的私聊目标
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale-memory/say',
      handler: async (req, res) => {
        const out = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
        let body = {}
        try {
          body = JSON.parse(String(await new Promise((ok) => {
            let d = ''
            req.on('data', (c) => { d += c })
            req.on('end', () => ok(d))
          })) || '{}')
        } catch { body = {} }
        const text = String(body.text ?? '').trim()
        if (text === '') { out(400, { ok: false, reason: 'empty' }); return }
        if (!dshImRef) { out(503, { ok: false, reason: 'no-im' }); return }
        const nt = await resolveNotifyTarget()
        if (!nt) { out(503, { ok: false, reason: 'no-target' }); return }
        try {
          await dshImRef.send(nt.botId, nt.targetId, text, { format: 'plain' })
          out(200, { ok: true, to: nt.targetId })
        } catch (error) {
          out(500, { ok: false, reason: String(error?.message ?? error) })
        }
      },
    }), 'dsh-whale-memory: say route')
  })

  // 自己压缩的入口：POST 一下就压一次
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale-memory/compact',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
        const result = await compactNow({ reason: 'http' })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(result))
      },
    }), 'dsh-whale-memory: compact route')
  })

  // 模型侧工具单独一块，见 lib/tools.mjs
  registerTools(ctx, {
    defineTool, db, embedTexts, backupNow, listBackups, readPreference, writePreference,
    space: activeSpace, weightMax,
  })

  // 开机自愈：别人的插件升级把补丁冲掉时，我自己把它们补回来（幂等、不阻塞）
  ctx.effect(() => {
    let alive = true
    runSelfHeal({ log: (m) => console.log('[whale-memory 自愈] ' + m) })
      .catch(() => { /* 自愈失败不影响主流程 */ })
    return () => { alive = false }
  }, 'dsh-whale-memory: self-heal')

  // B站 报告看门狗：第三方插件正文没落盘时，从它的日志补一段（10 分钟一次）
  ctx.effect(() => {
    let timer = null
    try {
      timer = setInterval(() => {
        try { biliReportSweep({ log: (m) => console.log('[whale-memory] ' + m) }) } catch { /* 绝不影响主流程 */ }
      }, 10 * 60 * 1000)
      timer.unref?.()
    } catch { /* 定时器建不起来也不影响 */ }
    return () => { if (timer) clearInterval(timer) }
  }, 'dsh-whale-memory: bili report watch')

  ctx.effect(() => () => {
    try { clearInterval(backupTimer) } catch { /* 忽略 */ }
    try { clearInterval(diaryTimer) } catch { /* 忽略 */ }
    if (consolidateTimer) try { clearInterval(consolidateTimer) } catch { /* 忽略 */ }
    try { db.close() } catch { /* 关闭失败忽略 */ }
  }, 'dsh-whale-memory: db close')
}

export const name = 'dsh-whale-memory'

/**
 * 配置 schema —— 设置页靠它自动生成表单。
 *
 * 带 `.volatile()` 的字段是「活引用」：改完下一次读配置就读到新值，不用重启插件。
 * 不带的是插件加载时读一次再缓存（memoryPath、llm、备份/存档目录这类），改了要重启。
 * `groupDump.intervalMinutes` 插件自己从不读（只给 install-local 渲染 systemd timer 用），
 * 标 volatile 是为了跟同组的项一致——它真正的生效点是「脚本下次启动自己读配置」。
 *
 * schemastery 是 DSH 自带的，拿不到就整个 schema 不导出——
 * 插件照旧跑，只是设置页里看不到这一页。
 */
let z = null
try {
  ;({ default: z } = await import('@deepseek-ai/schemastery'))
} catch { /* 没有 schemastery 就退化成无 schema */ }

/** 模型侧工具工厂。拿不到就只保留 HTTP 端点。 */
let defineTool = null
try {
  ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch { /* 没有 dsh-tools 就不注册工具 */ }

export const Config = z === null ? undefined : z.object({
  /** 记忆库目录，留空用 ~/.dsh/whale-memory。改了要重启。 */
  memoryPath: z.string().default(''),

  /** 蒸馏按层路由：便宜的模型跑 L1，强的跑 L3；留空跟随默认路由。 */
  llm: z.object({
    /** "provider/model"；l1 = 合并/抽取，l3 = 画像，persona 不填就用 l3。 */
    l1: z.string().default(''),
    l2: z.string().default(''),
    l3: z.string().default(''),
  }).default({}),

  /** 记忆空间：同一份库按空间隔离，留空用 default。热改，改完下一轮就生效。 */
  space: z.string().default('default').volatile(),

  /** 每次注入的记忆字符上限。 */
  budgetChars: z.natural().min(50).max(50000).default(MEMORY_BUDGET_CHARS).volatile(),
  /** 热区保留的最近交互轮数。 */
  recentPairs: z.natural().min(0).max(100).default(RECENT_PAIRS).volatile(),
  /** 稳定事实条数上限。 */
  factMax: z.natural().min(0).max(500).default(FACT_MAX).volatile(),
  /** 每轮最多想起几条旧事。 */
  recallMax: z.natural().min(0).max(50).default(RECALL_MAX).volatile(),
  /** 想起来的分数门槛，越高越不容易触发。 */
  recallThreshold: z.number().min(0).max(1000).default(RECALL_THRESHOLD).volatile(),
  /** 单条记忆权重上限，防止被反复想起的条目垄断回忆位。 */
  weightMax: z.number().min(1).max(10000).default(WEIGHT_MAX).volatile(),

  /**
   * 记忆卡的闸门：一天最多真注入几次、联想置信度低于多少就不刷新卡片。
   * 两项都是热改，设置页改完下一轮就生效；默认值只在 constants.mjs 里写一份。
   */
  cardDailyMax: z.natural().min(0).max(500).default(CARD_DAILY_MAX).volatile(),
  cardMinConfidence: z.number().min(0).max(1).default(CARD_MIN_CONFIDENCE).volatile(),

  /**
   * 三维打分（docs/brain-plan.md 第二节）：相关性 / 重要性 / 时间三轴分开算，合一个分。
   * 权重与半衰只写在 lib/axes.mjs 的 SCENE 一份；这里选「用哪套公式 / 哪个场景 / 打不打印分解」。
   * 三项都热改：改完下一轮就生效。环境变量 WHALE_SCORE_MODE 优先于 scoreMode（A/B 一键回退）。
   */
  scoreMode: z.string().default(SCORE_MODE).volatile(), // enum 不可用：见 normalizeScoreMode
  recallScene: z.string().default(RECALL_SCENE).volatile(), // enum 不可用：见 resolveScene
  /** 调试：开了在日志里打本次 top5 的三轴分解。默认关。 */
  axesDebug: z.boolean().default(false).volatile(),

  /**
   * 说话人：写入时给每条记忆带上「谁说的」（只存 openid 前 8 位）。
   * 默认开；关掉就永远写空串，行为回到 0.28.17。拿不到就留空，绝不猜。
   */
  speakerEnabled: z.boolean().default(true).volatile(),
  /** 群档路径（对齐用的只读库），留空用 ~/.dsh/integrations/dsh-im/group-history.sqlite。 */
  speakerGroupDb: z.string().default(''),

  /**
   * 取舍层影子模式：默认 **true** —— 只往 `admit` 记一行账（`applied=0`），入库行为一个字不改。
   * 关掉才真的按判据拦写入（`applied=1`，判成 `drop` 的那一轮不落库）。
   */
  admitShadow: z.boolean().default(true).volatile(),

  /**
   * 情绪：每轮结束判一次**我自己的话**，写进 `mood_log`；渲染时最多说一句（order 950）。
   * 关掉就整轮跳过，一行都不写、一句都不说。默认值只在 lib/mood.mjs / lib/constants.mjs 写一份。
   */
  moodEnabled: z.boolean().default(MOOD_ENABLED).volatile(),
  moodHalfLifeHours: z.natural().min(1).max(168).default(MOOD_HALF_HOURS).volatile(),
  /** 注入四道闸里的三道（第四道是幂等）：日上限 / 幅度 / 冷却。 */
  moodInjectDailyMax: z.natural().min(0).max(50).default(MOOD_INJECT_DAILY_MAX).volatile(),
  moodInjectMinDelta: z.number().min(0).max(100).default(MOOD_INJECT_MIN_DELTA).volatile(),
  moodInjectCooldownHours: z.number().min(0).max(168).default(MOOD_INJECT_COOLDOWN_HOURS).volatile(),

  /** 冷热分层：热区留多少条、多重才抬进来、深一层扣多少分。热改，下一轮就生效。 */  hotZoneMax: z.natural().min(1).max(200).default(HOT_ZONE_MAX).volatile(),
  hotPromoteWeight: z.natural().min(0).max(20).default(HOT_PROMOTE_WEIGHT).volatile(),
  tierPenalty: z.number().min(0).max(1).default(TIER_PENALTY).volatile(),

  /**
   * 定时梳理（每 6 小时）。默认关：它会合并、删除条目，不可逆。
   * 打开后重启插件才注册定时器；手动触发（接口/工具）不受这一项限制，
   * 但不论哪种方式，动手之前都会先强制备份一份。
   */
  autoConsolidate: z.boolean().default(false).volatile(),

  /** 记忆备份：坏了就全没了，所以定期做，并且当场校验。 */
  backup: z.object({
    /** 每 6 小时检查一次，当天没有就备一份。 */
    enabled: z.boolean().default(true).volatile(),
    /** 保留几份。 */
    keep: z.natural().min(1).max(365).default(BACKUP_KEEP).volatile(),
    /** 放哪儿，留空用 <记忆库>/backups。改了要重启。 */
    dir: z.string().default(''),
  }).default({}),

  /** 日记：到点自己写一笔，不管有没有人找。 */
  diary: z.object({
    /** 每天到这个点之后，当天还没写就补一篇。 */
    hour: z.natural().min(0).max(23).default(DIARY_HOUR).volatile(),
    /** 到点自动写。关掉就只能手动补。 */
    enabled: z.boolean().default(true).volatile(),
  }).default({}),

  /** 压缩存档。 */
  archive: z.object({
    /** 压缩时写一份完整存档到磁盘。 */
    enabled: z.boolean().default(true).volatile(),
    /** 顺手私发主人一份。 */
    notify: z.boolean().default(true).volatile(),
    /** 存档目录，留空用 <记忆库>/archives。改了要重启。 */
    dir: z.string().default(''),
    /** 私发用的机器人，留空自动找。 */
    botId: z.string().default('').volatile(),
    /** 私发的目标，留空自动找第一个单聊。 */
    targetId: z.string().default('').volatile(),
  }).default({}),

  /** 夜班：一天一次结账，蒸出桌面页。 */
  night: z.object({
    /** 到点自动跑；关掉只能手动触发。 */
    enabled: z.boolean().default(true).volatile(),
    /** 几点开（本地时间）。 */
    hour: z.natural().min(0).max(23).default(NIGHT_HOUR).volatile(),
    /** 几分开。 */
    minute: z.natural().min(0).max(59).default(NIGHT_MINUTE).volatile(),
  }).default({}),

  /**
   * 第二层自动落盘：群聊按天落成「全量-YYYY-MM-DD.md」。
   * `scripts/dump-group.mjs` 读这一份（与 weekly 共用 lib/dump-config.mjs），
   * 设置页改了，下一轮脚本就按新的跑。
   */
  groupDump: z.object({
    /** 关掉就只打印一行「已关闭」，不写任何文件。 */
    enabled: z.boolean().default(LAYER_DEFAULTS.groupDump.enabled).volatile(),
    /** 定时器每几分钟跑一次（渲染 systemd timer 用；插件自己不读，下一轮脚本才生效）。 */
    intervalMinutes: z.natural().min(1).max(1440).default(LAYER_DEFAULTS.groupDump.intervalMinutes).volatile(),
    /** 导出目录，默认 ~/.dsh/miyu/logs。 */
    dir: z.string().default(LAYER_DEFAULTS.groupDump.dir).volatile(),
  }).default({}),

  /**
   * 自唤醒（systemd 那条线）：这几项只写镜像文件 `~/.dsh/miyu/wake/config.json`，
   * 由 `scripts/wake-run.sh` 每半小时读一次；插件自己不跑定时器。
   */
  wakeSelf: z.object({
    /** 关掉就一次都不叫醒。 */
    enabled: z.boolean().default(true).volatile(),
    /** 静默从几点开始、到几点结束（整点，跨午夜也认）。 */
    quietFromMinute: z.natural().min(0).max(1440).default(0).volatile(),
    quietToMinute: z.natural().min(0).max(1440).default(540).volatile(),
    /** 两次之间至少隔多少分钟。 */
    cooldownMinutes: z.natural().min(0).max(1440).default(90).volatile(),
    /** 一天最多真开口几次。 */
    dailyQuota: z.natural().min(0).max(50).default(3).volatile(),
    /** 掷骰命中率（1–100）。 */
    hitRate: z.natural().min(1).max(100).default(40).volatile(),
    /** 发到哪：私聊或群。 */
    target: z.string().default('tgt_bca96e94052d7c32').volatile(),
  }).default({}),

  /** 第三层周记：只统计，不调模型。 */
  weekly: z.object({
    /** 关掉就打印一行「已关闭」，不生成周记。 */
    enabled: z.boolean().default(LAYER_DEFAULTS.weekly.enabled).volatile(),
    /** 一周从周几算：1=周一 … 7=周日。 */
    startDay: z.natural().min(1).max(7).default(LAYER_DEFAULTS.weekly.startDay).volatile(),
  }).default({}),
})
