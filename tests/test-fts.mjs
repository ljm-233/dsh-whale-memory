/**
 * 全文索引体检与重建的回归：索引和正文对不上时要能自己发现并修好。
 * 跑法：node tests/test-fts.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { checkFts, rebuildFts, isCorrupt } from '../lib/fts.mjs'
import { keywordIds } from '../lib/entries.mjs'

let pass = 0
let fail = 0
const check = (name, cond) => {
  if (cond) { pass += 1; console.log('  OK  ' + name) }
  else { fail += 1; console.log('  NG  ' + name) }
}

const db = new DatabaseSync(':memory:')
db.exec(`
  CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, u TEXT, a TEXT);
  CREATE VIRTUAL TABLE entries_fts USING fts5(u, a, content='entries', content_rowid='id', tokenize='trigram');
  CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, u, a) VALUES (new.id, new.u, new.a);
  END;
`)
db.prepare('INSERT INTO entries (u,a) VALUES (?,?)').run('记忆库坏了要重建索引', '嗯')
db.prepare('INSERT INTO entries (u,a) VALUES (?,?)').run('今天重启了好几次插件', '重启不是坏事')

check('一致时体检通过', checkFts(db).ok === true)
check('搜索能命中', (keywordIds(db, '重建索引') ?? []).length === 1)

// 人为制造不同步：绕过触发器直接删索引行
db.exec('DELETE FROM entries_fts')
const verdict = checkFts(db)
check('不同步能被发现并修好', verdict.ok === true && verdict.repaired === true)
check('修好后搜索恢复', (keywordIds(db, '重启了好几次') ?? []).length >= 1)

// 短语搜不到时按两字一组拆开做交集
check('短语不连续也能搜到', (keywordIds(db, '重启插件') ?? []).length >= 1)

check('损坏判定认 malformed', isCorrupt(new Error('database disk image is malformed')) === true)
check('普通错误不误判', isCorrupt(new Error('database is locked')) === false)

db.prepare('INSERT INTO entries (u,a) VALUES (?,?)').run('又一条', '好')
check('重建是幂等的', rebuildFts(db) === true && rebuildFts(db) === true)

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail > 0) process.exit(1)
