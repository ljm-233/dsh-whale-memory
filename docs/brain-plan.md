# 大脑计划：人、三维、三件能力、代价

> 目标：把「记得说过什么」升级成「记得谁说的、值多少、什么时候的」，并且**不换存储、不加依赖、不改现有接口契约**。
> 这一份是设计，不是接线：仓库里只多这一页文档，运行时行为一个字都没动。原型在 `/tmp/brain-proto/`（纯函数 + `node --test`）。
> 写于 2026-11-05，0.28.18。

## 现状底账（2026-11-05 实测，只读查的）

| 东西 | 数 | 说明 |
| --- | --- | --- |
| `entries` | 1946 | 列：`id,u,a,t,w,emo,vec,hot,owner,space,hits,tier,lastHit`；**没有说话人**；`u` 为空的 129 条（只有我那一侧） |
| `entities` / `edges` | 300 / 2000 | 两张都**顶到上限了**（MAX_ENTITIES / MAX_EDGES） |
| `scenes` / `diary` / `facts` | 12 / 7 / 8 | 场景层已跑，但主题只有 12 个 |
| `entry_evidence` | 1236 | 证据链已在，但只给「原话」，不给「谁」 |
| `events` | 5000 | 顶到 EVENT_MAX 了 |
| 群档 `group-history.sqlite` | 4522 条 / 10 人 | `messages(sender_id, sender_name, sent_at, text, type)`，鲸鱼姬 1139 条、ljm 1624 条 |
| 老条目里的说话人痕迹 | 48 条（2.6%） | `<@OPENID前8位>` 前缀 39 条，`<dsh_im_source>{"senderId":…}` 9 条 |
| 文本对齐回测 | 161 / 425 ≈ 38% | 最近 500 条非空 `u` 里，前 30 字 + ±10 分钟窗能在群档里**唯一**对上的；歧义 28 条（7%）、对不上 236 条（55%） |

三句结论，先摆在前面：

1. **「谁说的」现在基本没留下**（2.6%）。所以「人」这一维的 P0 不是建表，是**在写入路径上带 spk**——老数据只能补一点，不许假装补全。
2. **三维必须分开存、合起来查**。分开存的意思是三个字段/三个来源，不是三次检索；合起来查的意思是排序只吃一个数。
3. **大脑三件里，只有「工作记忆」值得先做**。取舍层和反思第一版都先在**只记账**的位置上跑两周，判据被自己的口癖喂偏是这三件里最真实的失败模式。

---

## 一、「人」这一维补进图谱

### 结论

`entities` 里的「人」是从正文里切出来的词（`cueWords` 的 2~4 字 n-gram），「鲸鱼姬」和「鱼鱼」是两个节点，「ljm」和「ljm_QvQ」是两个节点，同一个人三个叫法在图上就是三个点。这不是人手不够的问题，是**节点来源本身不是身份**。

补法：加一张 `person`（身份），给 `entries` 加一列 `spk`（谁说的），再让 `person_topic`（派生）把人和话题接起来。**`entities` / `edges` 一个字不改**——它们继续做「词与词」的图，人做「人与事」的图，两张图在查询层拼，不在一张表里打架。

### 表

```sql
-- 人：只存 openid 前 8 位。明文在 ~/.dsh/miyu/private/，不进库、不进仓库、不进导出。
CREATE TABLE IF NOT EXISTS person (
  spk     TEXT NOT NULL,                    -- openid 前 8 位，大写十六进制
  space   TEXT NOT NULL DEFAULT 'default',
  name    TEXT NOT NULL,                    -- 主名：认人.md 里「是谁」那一列
  aka     TEXT NOT NULL DEFAULT '[]',       -- JSON 数组：别的叫法 + 群昵称历史
  score   REAL NOT NULL DEFAULT 1,          -- 关系分：我主动想起他的倾向（见下）
  source  TEXT NOT NULL DEFAULT '',         -- 这行从哪来：`认人.md` / `sender_name` / `manual`
  updated INTEGER NOT NULL,
  PRIMARY KEY (spk, space)
);
-- 普通索引，不是唯一索引：ARK/梁 两个 spk 同名，唯一约束会拒绝入库
CREATE INDEX IF NOT EXISTS idx_person_name ON person(space, name);
```

**为什么不设自增 `id`**：`spk` 本身就是稳定主键，再加一个 id 只多一处要维护的映射（`recognize` 的时候还得反查）。真需要 id 就用 rowid。**为什么 `aka` 是 JSON 而不是一张表**：一个人平均 1.5 个叫法、10 个人——现在的规模下一张 `person_alias` 表换来的是每次查询多一个 JOIN，不值。超过 50 人或需要「按叫法反查」时再拆，那时有真数据支撑。

`score`（关系分）不是手填的：`1 + 0.1 * min(10, 近 30 天条目数/10) + 0.5 * (是否 ljm)`，默认 1，每晚重算一次。它只影响「主动联想时先想谁」，不影响任何既有排序。

**已知的坑**：ARK / 梁 / 哎嘿是同一个人，openid `E8721C3C` 和 `D073B690` 两个。所以 `name` 可以重复（`ARK` 两行），`UNIQUE(space,name)` 得去掉——改成 `idx_person_name` 普通索引。这是 `认人.md` 里就写着的事实，不是我猜的。

### 从哪生成（三个来源，按可信度排）

1. `notes/认人.md` 的表格（`openid 前 8 位 | 是谁 | 备注`）：**唯一的人工权威**。解析一张 markdown 表，20 行代码。这是「whoami」的真相。
2. 群档 `group-history.sqlite` 的 `sender_name`：补 `aka`（同一个人用过哪些群昵称）和 `score` 的原料。只读打开，和 `lib/diary.mjs:57` 现在读 `corpus.db` 一个路子。
3. `entries` 里已有的痕迹（2.6%）：**只用来校对，不用来生成**。原因见「反例」。

### `entries` 怎么带上说话人

**最小迁移 = 加一列**，不是加关联表：

```sql
ALTER TABLE entries ADD COLUMN spk TEXT NOT NULL DEFAULT '';   -- 沿用 ensureColumn()
ALTER TABLE entries ADD COLUMN imp REAL;                       -- 三轴里的重要性覆盖，NULL = 自动（见第二节）
CREATE INDEX IF NOT EXISTS idx_entries_spk_t ON entries(spk, t);
```

**为什么是列不是关联表**：一条 `entries` 就是一轮（一个用户消息 + 一个回复），群聊里一轮只有一个说话人。一对零/一，用列；用 `entry_person` 表要多一次 JOIN 换零收益。**什么时候该换成表**：出现「一轮里多人合说」或者「一条记忆要挂多个人」的时候——现在的口径不会。

老数据回填只有两条路，都得诚实地写成「尽力而为」：

| 路径 | 覆盖 | 做法 |
| --- | --- | --- |
| A. 正文正则 | 48 条（2.6%） | `<@([0-9A-F]{8})` 前缀 → `spk`；`"senderId":"([0-9A-F]{8})` → `spk` |
| B. 时间窗 + 原文对齐 | 唯一命中 38%，歧义 7%，无解 55%（最近 500 条实测） | `entries.u`（已被 `PART_CAP=300` 截断）前 30 字 等于 群档 `messages.text` 前缀、`sent_at` 落在 `entry.t` ±10 分钟内且**只有一条候选** → 认领（依据：`u` 就是用户那一侧原话） |

两路都不中的**留空**。查询侧把 `spk=''` 当「不知道谁说的」，仍然能按内容查到——**不猜**。`~/.dsh/miyu/scripts/who-spoke.py` 那套「认不出标新面孔」的规矩在这里同样适用。

新数据靠什么带说话人——这一条要先探，别先写。

`@xmanrui/dsh-im` 的 `enhancement.source()`（`src/channels/qq/qq-bridge.mjs:732`）确实给 `{channel, senderId, senderName, chatId}`，但它是**渲染 `<dsh_im_source>` 块进正文**的原料（`src/channels/shared/context-enhancement.mjs` 的 `enhanceContextContent`），默认 `enabled: false`，而且只在 `snapshot` 的字段选择里才会取。所以「信封里带 senderId」是真的，**但它落在文字里，不一定落在 `msg.source` 上**——现库里 12 条带 `<dsh_im_source>`、39 条带 `<@OPENID…>` 前缀，正是这个形态。

所以 P0-2 分两步，第二步按第一步的结果选：

1. **探一次**（10 分钟）：在 `lib/index.mjs:626` 的 `writer.setUser(text)` 旁边打一行临时日志，把 `msg.source` 的键集合与 `Object.keys(msg)` 输出一次（跑一轮群聊就够）。有 `senderId` → 走 2a；没有 → 走 2b。
2. **2a（探到了）**：`spk = String(msg.source.senderId ?? '').slice(0,8).toUpperCase()`，交给 `writer.setUser(text, spk)`，`writer.mjs:41` 那条 INSERT 多一列。**~5 行**。
3. **2b（探不到）**：拿 `text` 去群档对：只读打开 `~/.dsh/integrations/dsh-im/group-history.sqlite`（和 `lib/diary.mjs:57` 读语料库一个路子），`SELECT sender_id FROM messages WHERE text = ? AND sent_at BETWEEN ? - 600000 AND ? + 600000`，**唯一命中才认，多义与无解一律留空**。每条一轮一次查询，跟 `flush()` 同一个事务里只读一次。**~20 行**。

两条路都遵守同一条规矩：**认不出就是空串，不猜**。空串在查询侧永远表示「不知道谁说的」，仍然能按内容查到。

### 人和实体怎么连

| 关系 | 怎么来 | 存不存 |
| --- | --- | --- |
| 人—话题 | 这个人名下条目命中的实体（`entities` 里已有的那 300 个词），按条目计数 | 存 `person_topic`（派生，可整表重建，跟 `entities` 同一条路） |
| 人—人 | 同一时间窗（10 分钟）里出现过的不同 `spk`，按群档算共现次数 | **不存**，P2 再定；先一条 SQL 现算（4522 行，<10ms） |
| 人—时间 | `entries.spk + entries.t`，`idx_entries_spk_t` 直接覆盖 | 不用存 |

```sql
-- 派生表：和 entities 一样纯统计、可重建、可整表删
CREATE TABLE IF NOT EXISTS person_topic (
  spk TEXT NOT NULL, entity TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL, PRIMARY KEY (spk, entity)
);
```

生成放 `rebuildGraph()` 的那一趟扫描里（`lib/graph.mjs:36` 起，已经在遍历每条的 cueWords 了）：多判一个 `if (r.spk)`，把 `spk → 保留的实体` 记进 `person_topic`。**~15 行，零额外扫描成本**——这是把它放进 `rebuildGraph` 而不是另开一次全表扫的唯一理由。

### 验收式问题：「上周跟鲸鱼姬聊了什么」

```sql
-- SQL 1（真实可跑，/tmp/brain-proto/fixture.mjs 里验证过，输出见附录）
WITH win(lo, hi) AS (
  SELECT (CAST(strftime('%s', date('now','+8 hours','-7 days')) AS INTEGER) - 8*3600) * 1000,
         (CAST(strftime('%s', date('now','+8 hours'))         AS INTEGER) - 8*3600) * 1000
)
SELECT p.name AS who,
       date(e.t/1000, 'unixepoch', '+8 hours') AS day,
       e.id, substr(e.u, 1, 34) AS said, e.w, e.hits
FROM entries e
JOIN person p ON p.spk = e.spk AND p.space = e.space
CROSS JOIN win
WHERE ('鲸鱼姬' IN (p.name) OR p.aka LIKE '%"鲸鱼姬"%')
  AND e.t >= win.lo AND e.t < win.hi
ORDER BY e.t DESC
LIMIT 40;
```

三个细节，都是踩过的：

- **括号不能省**。`IN (…) OR aka LIKE … AND e.t >= …` 里 `AND` 比 `OR` 紧，少了括号时间窗就形同虚设（原型第一版就是这么错的，34 天前那条也漏了进来）。
- **时间边界算成显式毫秒**。`date('now','+8 hours')` 拿到的是东八区的「今天」，再减 8 小时换回 UTC 秒，乘 1000 才是 `entries.t` 的单位。不写 `'localtime'`，机器时区一换结果就变。
- **按 `name` 查要连 `aka`**。ARK 有三个人叫法、两个 openid，只按 `name` 查会漏掉一半。

**今天就能跑的降级版**（还没有 person 表时）：`WHERE u LIKE '%<@' || '1C282365' || '%'`——只能捞到那 48 条里的 39 条，正是「所以 P0 要先补写入侧」的证据。

### 验收

```bash
# 覆盖率：新写入的条目有多少带上了说话人（P0 三天后应接近 100%）
sqlite3 "file:$HOME/.dsh/miyu/db/memory.db?mode=ro" \
  "SELECT CASE WHEN spk='' THEN '无' ELSE '有' END k, COUNT(*) n
   FROM entries WHERE t > strftime('%s','now','-1 day')*1000 GROUP BY k;"
```

判据：一天内新条目 `有` ≥ 95%。老条目（`t` 早于接线日）覆盖率上限就是「2.6% 正文正则 + 38% 唯一对齐」，**不作为验收项**，够用即可——它们的内容仍然能按关键词和语义查到，只是不能按人查。

### 回滚

`DROP INDEX idx_entries_spk_t; ALTER TABLE entries DROP COLUMN spk;`（SQLite 3.35+ 支持 DROP COLUMN；列是 DEFAULT '' 的，删了不影响任何既有查询）。`person` / `person_topic` 是新增表，删表即回滚。**没有任何既有路径依赖它们**，因为 P0 只写不读。

---

## 二、记忆三维结构化

### 结论

三轴**分开存**（各自有来源），查询时**合成一个分**（用户只看到排序）。不把轴塞进向量，不换引擎。

| 轴 | 从哪来（已有） | 要不要新字段 |
| --- | --- | --- |
| 相关性 | 语义 `sim`（`vec` 余弦，或退化成 bigram 重叠）+ `hits` 命中频次 + `tier` 层级 | 不要。`hits`/`tier` 已经在跑 |
| 重要性 | `w` 累积权重 + `emo` 情绪冲击 + 被引用（`entry_evidence` 条数）+ 显式标记（日记/账本/`w ≥ IMPORTANT_WEIGHT`） | 一个 `imp REAL`，**NULL = 自动**，只存人工覆盖 |
| 时间 | `t` + **场景给的半衰** | 不要。`t` 是既有列 |

**为什么重要性要留一个可覆盖的列**：规则算出来的重要性，和我「明确知道这条重要」是两件事。留一个 NULL 默认的列，老数据 100% 不用动（NULL 就是走自动），只有我要钉死某条时才写值。这就是「能默认就默认」的具体形态。

### 打分（`/tmp/brain-proto/axes.mjs`，纯函数，已测）

```
rel  = 0.70·sim + 0.25·log1p(hits)/log1p(5) + 0.05·(1 - min(9,tier)/9)
imp  = 0.35·(w-1)/7 + 0.25·min(1, n_emo/2) + 0.20·min(1, cites/3) + 0.20·[显式标记]
time = 0.5 ^ (ageDays / halfLifeDays)
score = w_rel·rel + w_imp·imp + w_time·time        （三项权重和恒为 1）
```

三套场景（`SCENE`），六个权重 + 三个半衰，**就这九个数**：

| 场景 | rel | imp | time | 半衰(天) | 用在哪 |
| --- | --- | --- | --- | --- | --- |
| `recall` | 0.55 | 0.25 | 0.20 | 30 | 现在这条路径：每轮主动联想（和 `recall.mjs:138` 的 `0.5**(days/30)` 同一个刻度） |
| `lookup-old` | 0.45 | 0.45 | 0.10 | 3650 | 「查旧事」：`memory_recall` 带 `detail:full`、或用户明说「上次/以前/那个 bug」 |
| `daily` | 0.35 | 0.15 | 0.50 | 7 | 日常对话：不查旧事，旧的不许抢戏 |

**「查旧事几乎不衰」不是把分压平，是换一个十年半衰**——同一个 `t`，换个场景就是另一个数，存储一个字都不改。测试 2 就是钉这一条：300 天前那条在 `lookup-old` 里 `time > 0.9`，在 `daily` 里 `< 0.001`。

### 场景怎么选（P1 只用规则，不调模型）

```
detail:full / 关键词命中 {上周,上次,以前,之前,那个,后来,记得吗} → lookup-old
其余 → recall
日常两轮以内都没有旧事线索时 → daily（只在「注入给人看的排序」里用，不改主动联想）
```

认不出的场景名一律回落 `recall`（`sceneOf()`），拼错的字符串不许变成 0 分。

### 查询仍是「一个分」

`scoreEntry(entry, ctx) → { score, scene, axes }`。`axes` 只给测试、调试、「为什么它排第一」这类场景用；**`recall.mjs` 只取 `score`**。这条边界要写死在注释里，否则半年后一定有人拿 `axes.time` 去做业务判断。

### 迁移

| 对象 | 动作 |
| --- | --- |
| 1946 条老条目 | **零操作**。`imp` 为 NULL → 走自动公式；`hits/tier/t/vec` 全是既有列 |
| 排序公式 | 只换 `recall.mjs:138-141` 那三行（`decay` / `penalty` / `s`）。旧公式保留成 `legacyScore()`，A/B 两周 |
| 阈值 | `RECALL_THRESHOLD = 2.0` 是旧刻度的数。新分数在 0..1，按场景换刻度：`recall 0.55 / lookup-old 0.45 / daily 0.60`（三个常量，写 `constants.mjs` 一处） |
| 向量 | 不动。`vec` 继续给 `rel` 里的 `sim` 供料 |

### 反例约束（写进代码注释，防以后的自己）

- **不把三轴塞进向量**：向量只代表「这句话在说什么」。硬塞重要性进去，需要重建全部 1946 条向量，而排序最后还是要合成一个数——付两次代价，换零收益。
- **不为此换存储引擎**：`sqlite + FTS5 + WAL` 现在 1946 条 / 5000 事件毫无压力，`json_array_length`、`pow`、窗口函数都能用（`sqlite3 :memory:` 实测过）。换引擎要重写 12 个模块。

### 验收

```bash
node --test /tmp/brain-proto/    # 3 条断言：场景改排序 / 半衰按场景 / 有界不漏 NaN
```

接入后另一条：同一个 id 在三个场景里的名次必须不同（`fixture.mjs --sql=2b` 就是这条的样张：id 3 在 `lookup-old` 里第 1，id 6 在 `daily` 里第 1）。

---

## 三、「大脑系统」的最小可验证版

三件都不是新组件，是**三个落点**：一个纯函数 + 一张表 + 一条读路径。

### 3.1 取舍层：入库 / 只进日志 / 忘掉

| 项 | 内容 |
| --- | --- |
| 判据 | 纯规则加总，**不做模型判断**：`+3` 含事实句式（`我叫/我在/我喜欢`）、`+2` 长度 ≥ 20 字、`+2` 情绪命中数、`+2` 与热区二元组重叠 ≥ 0.2、`+1` 含承诺/待办（`我去做/明天/记得`）、`-2` 只是打招呼/表情/单字。`≥4` 入库、`1~3` 只进日志、`≤0` 忘掉 |
| 写到哪 | 新表 `admit(id, at, kind, reason, fp, space)`；`reason` 带**每一项的原始值**（`score=5 cues=2 fact=1 emo=2 -> keep`），`fp` 是内容指纹，用来对账「这条决定对应哪条 entries」 |
| 怎么回滚 | `admit` 是纯记账：删表即回滚。**P1 第一版默认 `admissionEnabled=false`——只记不动**（影子模式），行为一个字不改 |
| 怎么验 | `SELECT kind, COUNT(*) FROM admit WHERE at > strftime('%s','now','-1 day')*1000 GROUP BY kind;` 再与 `entries` 当日增量对账：`入库` 数 ≈ 新增条数（差 >20% 说明判据或指纹坏了） |
| 为什么这样 | 「能事后复查」的唯一形态是**决定和理由一起落盘**。只存 `kind` 的账，一周后就没人说得清当时为什么这么判 |

### 3.2 工作记忆：手上正在做什么

现在散在三处：`db/NEXT.md`（59 行，勾选框）、`db/LEDGER.md`（99 行，做完的事）、`记忆本/日档`+`日志/`（按天）。同一个任务在三处各有一半，跨会话就接不上。

| 项 | 内容 |
| --- | --- |
| 结构 | 新表 `task(id, key, title, state, order_at, created, done_at, note, src)`，`key` 是稳定 slug（`brain-plan`），`state ∈ open/doing/done/dropped`，`order_at` 是「最近动过的时间」= 栈序 |
| 读时机 | 注入时一次：`state IN ('open','doing')` 按 `doing` 优先、`order_at` 倒序取 **3 条**，进记忆卡**一行**（「手上：brain-plan / 等鲸鱼姬」）。**每轮一次查询，不是每步**——挂在 `card()` 那条同步路径上，和读热区同一趟 |
| 写时机 | ① 显式工具 `memory_task`（open/done/note）；② `turn/end` 里，本轮 `u` 命中承诺句式才 upsert 一条（P2 才开）；③ **一次性导入脚本**把 `NEXT.md` 的未勾选项搬进来 |
| 收拢原则 | `task` 表是唯一真相，`NEXT.md` 变成**单向导出**（`task` → markdown，只写不读）。绝不双向同步——双向同步是两套写入打架，最后一定有一边丢 |
| 怎么回滚 | 删表 + 关掉注入那一行。`NEXT.md` 原样还在（导出只覆盖自己的段落，带 `<!-- generated -->` 标记） |
| 怎么验 | `fixture.mjs --sql=3` 那条：栈顶三条必须等于 `NEXT.md` 导出段的前三条。不一致就是导出或排序坏了 |

```sql
-- SQL 3（真实可跑，已验证）
SELECT id, key, title, state,
       date(order_at/1000, 'unixepoch', '+8 hours') AS touched
FROM task
WHERE state IN ('open', 'doing')
ORDER BY (state = 'doing') DESC, order_at DESC
LIMIT 3;
```

`(state = 'doing') DESC` 是 SQLite 的布尔排序：正在做的永远在最上面，不用另存一个优先级。

### 3.3 反思：每天读日记 + 账本，最多改一条规矩

| 项 | 内容 |
| --- | --- |
| 判据 | 三样信号：① 同一件事在日记和账本里被写成两条（二元组重叠 ≥ 0.6）；② 某条规矩这周被违反过（账本里有「改回/撤回/认错」且对得上规矩 key）；③ 一条规矩连着两周没被用上 → 提议删。**每次只挑一条，改一处** |
| 写到哪 | `reflection(id, day UNIQUE, rule_key, before, after, why, reverted, at)`；`before`/`after` 是**原文**（可 diff），改 `notes/VOICE.md` 前先 `.bak`（沿仓库既有的备份习惯） |
| 闸 | ① `day` 唯一：一天最多一条；② 一周内不许重复同一条：`SELECT rule_key FROM reflection WHERE day >= <本周一>` 命中就跳过；③ 判据里命中的词如果在**口癖表**（VOICE 里我自己的高频句尾）里 → 降权，不许因此改规矩 |
| 怎么回滚 | `UPDATE reflection SET reverted=1`，再把 `VOICE.md` 里 `after` 换回 `before`（原文都在表里，逐字可逆） |
| 怎么验 | `SELECT COUNT(*) FROM reflection WHERE day >= date('now','-7 days');` ≤ 7，且 `SELECT COUNT(DISTINCT rule_key) …` = 同一条数（没有重复改同一条） |
| 为什么这样 | 反思最危险的失败不是「想错」，是**变成台词**：每天写一段自我剖析，写多了就成了人格表演。闸的三条都是反表演的：一天一条、一周不重复、改动必须逐字留旧值 |

---

## 四、代价，以及每条的对策

| # | 代价 | 真实量级 | 对策（都是小改动） |
| --- | --- | --- | --- |
| 1 | 调参维数上升 | 3 轴 × 3 场景 × 阈值 = 27 个旋钮 | **只暴露 9 个数**（三套权重 + 三个半衰），轴内系数写死在 `axes.mjs` 不开放；**默认值从常量变成按周统计自动校准**：`scripts/calibrate.mjs` 用上周 `admit`/`recalled` 的分布算一次，结果落 `meta('calib:<scene>')`，读不到就用常量——调参从「我猜」变成「上周的数据说」 |
| 2 | 每 turn 多几次查询/写入 | 读 +2 条 prepared（人、栈顶），写 +1 行（`spk` 进已有的那条 INSERT） | **写入合并成一次事务**：`writer.flush()` 现在就是一条 INSERT，`spk`/`imp`/`admit` 三样并进**同一条语句 + 同一个 `BEGIN IMMEDIATE…COMMIT`**；读侧全部走 `card()` 已有的同步路径（一轮一次，不是一步一次），不新增调用点。P1 加一个 `?timing` 口子量一次，>5ms 就退回「栈顶三条每小时缓存一份」 |
| 3 | 存储增长 | `person` 10 行、`task` < 200、`reflection` ≤ 365/年、`admit` ≈ 100/天 → **约 3 MB/年** | **保留期 + 修剪**：`admit` 90 天、`task` 里 `done` 180 天、`reflection` 永久但只留 `after` 摘要；修剪进 `lib/tidy.mjs`（已有 tidy 入口），**~30 行**，跟着夜班跑，不新增定时器 |
| 4 | 「演」的风险 | 情绪/反思变台词；判据被自己的口癖喂偏 | 反思三道闸（一天一条 / 一周不许重复 / before-after 逐字留）＋**口癖 stoplist**：把 VOICE 里的高频句尾做成表，反思提炼出的「规矩」若含这些词就降权；再加**每四周人工抽查一条**（一条命令：`SELECT day,rule_key,before,after FROM reflection ORDER BY at DESC LIMIT 1`） |

**最容易被低估的一条是第 4 条**，不是第 1 条。调参维数看着吓人，但它是**可见的**——九个数字摆在那里，错了能看出来。演的风险是**不可见的**：判据是我自己写的，口癖是我自己的，数据是我自己的，三者互相印证，一套越来越像我的系统会给我越来越高的置信度。它不会报警，只会越来越顺。所以对策必须是外部的：闸（一天一条）、留旧值（可 diff）、每周统计（不是我的主观判断）。

---

## 五、分期表

| 期 | # | 做什么 | 改哪个文件 | 行数量级 | 风险 |
| --- | --- | --- | --- | --- | --- |
| **P0**<br>三天内 | 1 | `entries` 加 `spk` + `imp` 两列 + 索引 | `lib/index.mjs:286` 附近 2 行 `ensureColumn` + `:326` 索引数组 1 行 | ~3 行 | **低**。DEFAULT '' / NULL，老查询一个字不改 |
| | 2 | 写入路径带说话人：**先探 `msg.source` 有没有 senderId** | `lib/index.mjs:626`（探到就 5 行；探不到在 `lib/writer.mjs` 里加一次群档唯一对齐，20 行） | ~5 或 ~25 行 | **低**。拿不到就是空串，等同于今天；对齐只认唯一匹配 |
| | 3 | 回填脚本（正则 + 时间窗对齐） | 新 `scripts/backfill-speaker.mjs`（只读群档、只写 `spk`） | ~90 行 | **中**。对齐错会张冠李戴 → 只认 `entry_evidence` 原文 + 5 分钟窗 + 唯一匹配，多义一律留空；先 `--dry-run` 出报告 |
| | 4 | `person` 表 + 从 `认人.md`/群档生成 | 新 `lib/people.mjs` | ~85 行 | **低**。纯新增，P0 不接查询 |
| | 5 | 三维纯函数 + 3 条断言 | 新 `lib/axes.mjs` + `tests/test-axes.mjs`（把 `/tmp` 原型搬进去） | ~95 + ~70 行 | **低**。不接线就等于零风险 |
| | 6 | 三条验收 SQL 落文档 + 跑场脚本 | `docs/brain-plan.md`、`scripts/`? 不必 | — | 无 |
| **P1**<br>一周 | 7 | 三维接进排序（A/B 两周） | `lib/recall.mjs:132-141`（`scoreMemory` → `scoreEntry`，`decay/penalty` 两行换掉） | ~25 行 | **中高**。排序变了，联想内容会变 → `legacyScore()` 保留 + 记录两套 top-5 对比，差异 >2 条就回滚 |
| | 8 | 工作记忆：`task` 表 + 栈顶注入一行 + `NEXT.md` 单向导出 | 新 `lib/tasks.mjs`、`lib/recall.mjs` 加 6 行、`lib/index.mjs` 接工具 | ~90 行 | **中**。注入多一行会挤预算 → 硬限 40 字，超了挤掉最后一张记忆卡 |
| | 9 | 取舍层影子模式（只记不动） | 新 `lib/admission.mjs` + `index.mjs` 4 行开关（默认 false） | ~75 行 | **低**。默认关 = 零行为变化 |
| | 10 | 保留期 + 修剪 | `lib/tidy.mjs` | ~30 行 | **低**。只删 `admit`/`task(done)`，且先 dry-run |
| **P2**<br>两周后 | 11 | `person_topic` 派生 + 人—人共现 SQL | `lib/graph.mjs:36` 扫描循环内 | ~20 行 | **低**。派生表，删了能重建 |
| | 12 | 反思（一天一条 + 三道闸 + `.bak`） | 新 `lib/reflect.mjs`；`ruminate.js` 挂一次 | ~110 行 | **中高**。会改 `VOICE.md` → 只在闸全过的时候改一处，改前 `.bak`，改后留 `before/after` |
| | 13 | 每周校准 `calib:<scene>` | 新 `scripts/calibrate.mjs` | ~60 行 | **低**。算不出来就回落常量 |

**顺序不能倒**：P0-1/2 是所有东西的地基（没有 `spk`，人这一维就是空表）；P1-7 之前必须有 P0-5 的测试（否则排序一改，没人知道是设计变了还是代码错了）。

---

## 六、不建议做（以及为什么）

| 不做 | 原因 |
| --- | --- |
| 把三轴塞进向量 | 要重算全部 1946 条向量、换检索路径，而排序最后仍然合成一个数——两次代价，零收益 |
| 为三维换存储引擎 | `sqlite + FTS5 + WAL` 现在 1946 条 / 5000 事件无压力；`json_array_length`、`pow`、窗口函数都实测可用。换引擎要重写 12 个模块 |
| 给人做独立的图页 | `client.js` 已有图谱（`readGraph`/`entity`）。`spk` 覆盖率到 60% 之前，人节点在界面上只会是一堆空点 |
| 自动推断身份（「这条像鲸鱼姬说的」） | 猜错会污染长期记忆，而且错得很安静。只认 `认人.md` + 信封 `senderId`，认不出就标「新面孔」 |
| 取舍层用模型判断 | 规则版能解释、能对账、零成本；模型版连「为什么漏了这条」都说不清。等有 2 周影子数据再说 |
| `task` 表与 `NEXT.md` 双向同步 | 两套写入必打架，最后一定有一边丢。只做单向导出 |
| 反思一次改多条规矩 | 一天一条已经够多了；改多了就没法归因，也没法撤销 |
| 每天写一段自我剖析进日记 | 那是台词，不是反思。闸的作用就是让它**不能**变成日常产出 |
| 用 `LIKE '%openid%'` 当「谁说的」 | 实测会误伤：正文里带 `@` 前缀和注入块的地方都命中，但那是**被引用的文字**，不是说话人。只认信封和原文对齐 |

---

## 附录 A：原型与复现

```bash
# 三维打分纯函数 + 三条断言（3 pass）
node --test /tmp/brain-proto/

# 造一份「设计之后」的同构库，把四条 SQL 跑出结果
node /tmp/brain-proto/fixture.mjs            # 全部
node /tmp/brain-proto/fixture.mjs --sql=1    # 只跑人查话题
node /tmp/brain-proto/fixture.mjs --sql=2b   # 同一 id 三场景名次
```

实测输出（2026-11-05）：

```
✔ 1. 场景权重真的改变排序：查旧事时旧而重的在前，日常对话时新的在前
✔ 2. 半衰按场景走：同一个 t，查旧事几乎不衰，日常对话 7 天掉一半
✔ 3. 有界且不漏 NaN：脏数据进来，分仍在 0..1，三轴都能单独读出来
tests 3 / pass 3 / fail 0
```

```sql
-- SQL 2（三维打分，真实可跑）：三轴分开算、场景切权重、只出一个分
WITH scene(name, wr, wi, wt, half) AS (
  VALUES ('recall', 0.55, 0.25, 0.20, 30.0),
         ('lookup-old', 0.45, 0.45, 0.10, 3650.0),
         ('daily', 0.35, 0.15, 0.50, 7.0)
),
hit(id) AS (SELECT rowid FROM entries_fts WHERE entries_fts MATCH '鲸鱼姬' LIMIT 200),
base AS (
  SELECT e.id, e.u, e.t, e.w, e.hits, e.tier, e.imp,
         json_array_length(e.emo) AS nemo,
         (SELECT COUNT(*) FROM entry_evidence v WHERE v.entry_id = e.id) AS cites,
         (h.id IS NOT NULL) AS matched,
         MAX(0.0, (CAST(strftime('%s','now') AS INTEGER) * 1000.0 - e.t) / 86400000.0) AS age_days
  FROM entries e LEFT JOIN hit h ON h.id = e.id
  WHERE e.space = 'default'
),
ax AS (
  SELECT b.id, b.u, b.matched, s.name AS scene, s.wr, s.wi, s.wt,
         MIN(1.0, 0.70 * (CASE WHEN b.matched THEN 1.0 ELSE 0.25 END)
                  + 0.25 * MIN(1.0, ln(1 + b.hits) / ln(6))
                  + 0.05 * MAX(0.0, 1.0 - MIN(9, MAX(0, b.tier)) / 9.0)) AS rel,
         MIN(1.0, 0.35 * MIN(1.0, MAX(0.0, (b.w - 1) / 7.0))
                  + 0.25 * MIN(1.0, b.nemo / 2.0)
                  + 0.20 * MIN(1.0, b.cites / 3.0)
                  + 0.20 * (CASE WHEN b.imp IS NOT NULL THEN MIN(1.0, MAX(0.0, b.imp)) ELSE 0.0 END)) AS imp,
         pow(0.5, b.age_days / s.half) AS time_s
  FROM base b CROSS JOIN scene s
)
SELECT scene, id, substr(u, 1, 26) AS said,
       round(rel, 3) AS rel, round(imp, 3) AS imp, round(time_s, 3) AS time_s,
       round(wr * rel + wi * imp + wt * time_s, 4) AS score
FROM ax WHERE matched = 1 AND scene = 'recall'
ORDER BY score DESC LIMIT 5;
```

## 附录 B：附带的两条查询

```sql
-- 1b. 人—话题：这个人近一个月围绕什么在说
SELECT p.name, t.entity, t.n
FROM person_topic t JOIN person p ON p.spk = t.spk
WHERE t.updated > ?            -- 传 now - 30 天的毫秒
ORDER BY t.n DESC, p.name LIMIT 10;

-- 2b. 同一个 id 在三个场景里的名次（证明「权重按场景切」不是换个常数）
--     完整语句见 /tmp/brain-proto/fixture.mjs 的 SQL['2b']
SELECT id, scene, score, rank() OVER (PARTITION BY scene ORDER BY score DESC) AS rk
FROM (SELECT e.id, s.name AS scene,
             s.wr * MIN(1.0, 0.25 * MIN(1.0, ln(1 + e.hits) / ln(6)))
           + s.wi * MIN(1.0, 0.35 * MIN(1.0, MAX(0.0, (e.w - 1) / 7.0)))
           + s.wt * pow(0.5, MAX(0.0, (CAST(strftime('%s','now') AS INTEGER) * 1000.0 - e.t)
                        / 86400000.0) / s.half) AS score
      FROM entries e
      CROSS JOIN (SELECT 'recall' name, 0.55 wr, 0.25 wi, 0.20 wt, 30.0 half
                  UNION ALL SELECT 'lookup-old', 0.45, 0.45, 0.10, 3650.0
                  UNION ALL SELECT 'daily', 0.35, 0.15, 0.50, 7.0) s) x
WHERE id IN (3, 6)
ORDER BY id, scene;
```
