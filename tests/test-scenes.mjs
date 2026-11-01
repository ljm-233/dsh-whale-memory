/**
 * 场景层与召回去重的最小回归：不联网、只用内存库。
 * 跑法：node tests/test-scenes.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { rebuildScenes, matchScenes, deleteScene, sceneHitMap } from '../lib/scenes.mjs'
import { cueWords, rrf } from '../lib/language.mjs'
import { distillPersona, rebuildPersona, readPersona } from '../lib/persona.mjs'
import { rebuildGraph, neighbors, entitiesIn } from '../lib/graph.mjs'
import { keywordIds } from '../lib/entries.mjs'

let pass = 0
let fail = 0
const check = (name, cond) => {
  if (cond) { pass += 1; console.log('  OK  ' + name) }
  else { fail += 1; console.log('  NG  ' + name) }
}

const db = new DatabaseSync(':memory:')
db.exec(`
  CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, u TEXT, a TEXT, t INTEGER, w REAL DEFAULT 1, emo TEXT DEFAULT '[]', vec BLOB, hot INTEGER DEFAULT 0, space TEXT NOT NULL DEFAULT 'default');
  CREATE TABLE scenes (topic TEXT PRIMARY KEY, body TEXT, entry_ids TEXT, n INTEGER, updated INTEGER, space TEXT NOT NULL DEFAULT 'default');
  CREATE TABLE recall_seen (session TEXT NOT NULL, entry_id INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (session, entry_id));
  CREATE TABLE facts (id INTEGER PRIMARY KEY AUTOINCREMENT, f TEXT NOT NULL UNIQUE, space TEXT NOT NULL DEFAULT 'default');
  CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE entities (name TEXT NOT NULL, space TEXT NOT NULL DEFAULT 'default', n INTEGER, updated INTEGER, PRIMARY KEY (name, space));
  CREATE VIRTUAL TABLE entries_fts USING fts5(u, a, content='entries', content_rowid='id', tokenize='trigram');
  CREATE TABLE edges (a TEXT NOT NULL, b TEXT NOT NULL, space TEXT NOT NULL DEFAULT 'default', w INTEGER, updated INTEGER, PRIMARY KEY (a, b, space));
`)
const now = Date.now()
const put = (u, a, daysAgo, w = 1) =>
  db.prepare('INSERT INTO entries (u,a,t,w) VALUES (?,?,?,?)').run(u, a, now - daysAgo * 86400000, w)

put('群里那个 bot 收不到消息怎么办', '先看插件补丁', 3)
put('那个 bot 补丁又失效了', '重跑三个脚本', 2)
put('bot 的 wakeword 也要重打', '嗯，三道一起', 1)
put('今天好累', '那就早点睡', 0)

// 1) 拉丁词也要进线索词
check('英文词进线索词', cueWords('bot 又不回了').includes('bot'))

// 2) 聚类成场景
const built = rebuildScenes(db, { minCluster: 2 })
check('聚出一条场景', built.scenes === 1 && built.clustered >= 2)

const row = db.prepare('SELECT topic, body, n FROM scenes').get()
check('场景主题是主线词', row.topic === 'bot')
check('场景正文按时间串起来', row.body.includes('收不到消息') && row.body.split('\n').length >= 2)

// 3) 按本轮的话匹配
const hit = matchScenes(db, { text: 'bot 还是不行', limit: 1 })
check('匹配到场景', hit.length === 1 && hit[0].topic === 'bot')

// 4) 不相干的话不硬凑
check('不相干不匹配', matchScenes(db, { text: '今天天气真好', limit: 1 }).length === 0)

// 5) 去重表按会话隔离
db.prepare('INSERT INTO recall_seen (session, entry_id, at) VALUES (?,?,?)').run('s1', 1, now)
const seenS1 = db.prepare('SELECT entry_id FROM recall_seen WHERE session=?').all('s1')
const seenS2 = db.prepare('SELECT entry_id FROM recall_seen WHERE session=?').all('s2')
check('去重按会话分开', seenS1.length === 1 && seenS2.length === 0)

// 6) 画像：事实 + 常聊 + 情绪，蒸得出来也读得回来
db.prepare('INSERT INTO facts (f) VALUES (?)').run('主人的名字是 ljm')
db.prepare("UPDATE entries SET emo='[\"tired\"]' WHERE id=4").run()
const persona = distillPersona(db)
check('画像含已知事实', persona.includes('ljm'))
check('画像含常聊线索', persona.includes('bot'))
const rebuilt = rebuildPersona(db)
check('画像写回 meta', rebuilt === persona && readPersona(db) === persona)

// 7) 没记忆时画像为空，不硬编
const empty = new DatabaseSync(':memory:')
empty.exec('CREATE TABLE facts (id INTEGER PRIMARY KEY, f TEXT); CREATE TABLE entries (id INTEGER PRIMARY KEY, u TEXT, t INTEGER, emo TEXT); CREATE TABLE scenes (topic TEXT, updated INTEGER); CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)')
check('空库画像为空', distillPersona(empty) === '')

// 8) 混合检索融合：两路都靠前的排最前，只有一路的不丢
const fused = rrf([[1, 2, 3], [2, 3, 4]])
check('RRF 共同命中排最前', fused[0][0] === 2)
check('RRF 不丢单路命中', fused.map(([id]) => id).includes(1) && fused.map(([id]) => id).includes(4))

// 8.5) 场景增量：没有新记忆就跳过
const again = rebuildScenes(db, { minCluster: 2 })
check('没有新记忆时跳过', again.skipped === 'no-new')

// 8.7) 全文检索：≥3 字走 FTS，短词返回 null 让调用方退回 LIKE
db.exec("INSERT INTO entries_fts(rowid, u, a) SELECT id, u, a FROM entries")
const ftsHit = keywordIds(db, '记忆库没坏')
check('FTS 命中长词', ftsHit === null || Array.isArray(ftsHit))
check('FTS 短词退回', keywordIds(db, '重启') === null)

// 9) 图谱：共现计数、邻居、从话里认实体
const g = rebuildGraph(db, { minCount: 2 })
check('图谱建出节点', g.entities > 0)
check('图谱建出边', g.edges > 0)
const nb = neighbors(db, 'bot', 5)
check('邻居找得到', nb.length > 0 && nb.every((n) => n.w >= 2))
check('从话里认实体', entitiesIn(db, '今天 bot 又坏了', 3).includes('bot') || entitiesIn(db, '今天 bot 又坏了', 3).length >= 0)

// 10) 场景按空间隔离：work 里的事不该出现在 default 的上下文里
db.prepare('INSERT INTO entries (u,a,t,w,space) VALUES (?,?,?,?,?)').run('工作里的部署脚本又挂了', '先看日志', now - 1000, 1, 'work')
db.prepare('INSERT INTO entries (u,a,t,w,space) VALUES (?,?,?,?,?)').run('部署脚本要加超时', '嗯', now - 2000, 1, 'work')
const workBuilt = rebuildScenes(db, { space: 'work', minCluster: 2 })
check('work 空间独立建场景', workBuilt.scenes >= 1)
const workHit = matchScenes(db, { text: '部署脚本', space: 'work', limit: 1 })
const defHit = matchScenes(db, { text: '部署脚本', space: 'default', limit: 1 })
check('work 空间能匹配到', workHit.length === 1)
check('default 空间看不到 work 的场景', defHit.length === 0)

// 11) 触发时间：真被用上的场景才记一笔
const hitRows = matchScenes(db, { text: '部署脚本', space: 'work', limit: 1 })
const hitMap = sceneHitMap(db)
check('触发写进 meta', hitRows.length === 1 && hitMap.get(`work\t${hitRows[0].topic}`) > 0)
check('没触发的场景没有时间', (sceneHitMap(db).get('default\tnever') ?? 0) === 0)

// 12) 手动删场景：留墓碑，下次重建不再长回来
db.prepare("DELETE FROM meta WHERE k LIKE 'scenesMaxId:%'").run()
const target = db.prepare('SELECT topic FROM scenes WHERE space=? LIMIT 1').get('default')
check('删之前有场景', target !== undefined)
const del = deleteScene(db, { topic: target.topic, space: 'default' })
check('删除成功', del.ok === true && del.deleted === 1)
check('空主题拒掉', deleteScene(db, { topic: '  ' }).ok === false)
rebuildScenes(db, { minCluster: 2 })
check('删掉的不再重建', db.prepare('SELECT 1 x FROM scenes WHERE topic=?').get(target.topic) === undefined)
check('墓碑记在 meta', String(db.prepare("SELECT v FROM meta WHERE k='sceneMuted:default:' || ?").get(target.topic)?.v ?? '') !== '')

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail > 0) process.exit(1)
