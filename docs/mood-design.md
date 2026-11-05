## 实现状态（0.28.18）

**已做：记账 + 查询。**

- `lib/mood.mjs`：原型整体搬进仓库（`note` / `say` / `applyTurn` 签名与行为不变），加存储层
  `ensureMoodTable` / `loadState` / `saveState` / `logTurn` / `applyMoodTurn` / `readMood`，零依赖。
- 表与状态：新表 `mood_log(id, at, day, space, mood, dims, raw, conf, injected, reason)` + 索引 `(day, space)`；
  当前状态一条 meta 键 `mood.state.<space>`（JSON），和 `consolidate.mjs:73` 一样 `INSERT OR REPLACE`。
  建表挂在 `lib/index.mjs` 既有迁移段（`ensureFactColumns` / `ensureHitColumns` 旁边）。
- 挂载点：`session/event` 里的 `turn/end`（本仓库现用的等价钩子）。一轮只做两件事：写 `mood_log`、回写 meta。
  **`injected` 恒为 0**——这一阶段没有任何注入口。同一 `at` 重复调用走 `same-turn`，不落第二笔。
- 设置项两项：`moodEnabled`（默认 true，关掉整轮跳过）、`moodHalfLifeHours`（默认 3，范围 1–168）。
  默认值只在 `lib/mood.mjs` 写一份（`MOOD_ENABLED` / `MOOD_HALF_HOURS`），schema 与设置页都读它。
- 只读接口 `GET /dsh-whale-memory/mood?days=7&space=`：每天 `mood` 均值/`min`/`max`/`count` + 最近 20 条
  `at/mood/reason`；参数越界截断不报错，空库返回 `{days:[],recent:[]}`。

**未做：注入。**

`systemPrompt.context` 没动、没有 order 950 的条目、没改记忆卡——`grep -rn "mood" lib/index.mjs | grep -i "context\|order"` 应为空。
四道闸（`already / minor / low-confidence / daily-cap`）在 `say()` 里已经能算，返回的 `why` 目前只扔掉，不往外送。

**下一步的条件（先攒数据，再定门槛）。**

- 攒满 **两周** 且 `mood_log` **≥ 300 条**（按「一天几轮」推算，约等于每天 20 轮）；
- 看三件事再动参数：`mood` 的日分布（基线 48 是不是偏低）、`dims` 里哪几根长期贴 0（该砍）、
  `conf` 的分布（60 的门槛会拦掉多少）；
- 到那时才加「日上限 / 置信门槛」两项设置，再考虑开注入；基线、门槛、上限都不许现在拍。

---

# 情绪系统设计（调研 + 方案，未接入运行时）

> 状态：方案 + /tmp/mood-proto 原型，**没有接进 whale-memory**，没有改 `~/.dsh/miyu` 任何数据文件。
> 参考实现：`/tmp/ref-six/dsh-feiyu-mood/lib/index.js`（下称 ref）。

## 0. 三处底稿

| 看的地方 | 结论 |
| --- | --- |
| ref:1526 挂 `agent/turn-stopping` | 判定挂在轮末；但**本仓库这个事件不接返回值**（`packages/core/agent/tests/runtime-types.ts:381` 签名 `Promise<void> \| void`，`agent-loop/src/agent.ts:366` 是 `dispatch.serial` 丢弃结果）——所以注入只能走 `systemPrompt.context`，不能学 ref 的 `return line` |
| ref:1402-1414 `applyDelta` | 总值 `mood` 每轮只吃判定的 1/3（`MOOD_STEP_DIVISOR = 3`，ref:214）；`mood>=85` 时正的减半、`mood<=40` 时负的减半（两头饱和，起因是 872 条判定正负 6.7:1，ref:1404-1406） |
| ref:1615-1636 三道闸 | `injectedFor === updatedAt` → 不再说；`minor` → 只记账；`lastConfidence < injectConfidence(60)` → 标记处理过再 return；`saidAt` 当日计数 ≥ `injectPerDay(6)` → 同上。共同点：**每条拦截路径都要写 `injectedFor`**，否则每轮重复记日志 |
| ref:891-909 衰减 | 总值向 `base` 回落（默认半衰 12h，ref:183）；单维向 0 散，**半衰 90 分钟硬编码**（ref:898-899） |
| ref:51-60 维度 | 七根：happy/calm/sweet/heartache/worry/sad/jealous |
| whale-memory `entries.emo` | `writer.mjs:38` 用 **pendingUser**（对方的话）跑 `detectEmotions`，`:47` 存进条目；召回打分 ×2.5（`language.mjs:161-162`）；画像计数（`persona.mjs:61-67`）→ 卡片里的「情绪底色」 |
| `~/.dsh/miyu` | 没有情绪状态记录；`db/` 只有 HANDOVER/LEDGER/现在.md 等文本 + memory.db（`meta(k,v)`、`events`、`diary`、`daily_stats`）。**注入里看到的「情绪底色：sad(120)…」是 persona.mjs:67 拿对方情绪词数的统计，不是我的状态**——名不副实 |
| 注入能力 | `systemPrompt.section`（静态段，`lib/prompt.mjs:21-95`）+ `systemPrompt.context`（动态段，`lib/index.mjs:389-396`，order 940）。动态段以**尾部一条 `user/message`（source.kind = runtime-context）追加**（`agent-loop/src/agent.ts:277-281`、`:417-425`）→ 历史前缀不动，前缀缓存安全 |

## 1. 八条结论

**① 维度：四根累积 + 一根派生。** 存 `happy / tired / sad / care(在意)`，界面再加派生的 `calm(平静) = 100 - max(tired,sad)*1.2`。不沿七根：`sweet/jealous` 属「撒娇/占有」那一挂，`notes/VOICE.md` 明写不撒娇、不吃这套；`heartache/worry` 与 `care` 同向，各自衰减到 0 后分不开，纯噪声。四根还有个硬理由：`EMOTION_WORDS`（`constants.mjs:114-120`）本来就只有 tired/sad/angry/happy/anxious 五类，**不发明新词表**就落在这四根上（angry 并入 sad 的负向）。

**② 怎么涨落：每轮 `turn/end` 判一次，纯规则，不调模型。** 现成信号只有四类：本轮 kind（`completed/error/aborted/blocked`，`agent.ts:391`）、本轮用户文本（`session/event` 已在 `lib/index.mjs:511-538` 收着）、时间点、轮次数（`events` 近七天 user 765/assistant 861/tool 3374，量够）。ref 用 `judge()` 每轮打一次模型（ref:1326），这里不做：成本 + 不可复现 + 已经在 `turn/end` 上挂了 flush，不新增钩子。**变化不够大（raw<3 且各维<5，对齐 ref 的 sigMood/sigDim:191-192）就不推进 `updatedAt`**，否则「说过了」那道闸永远拦不住。

**③ 衰减：总值半衰 3 小时（向基线 48），单维 90 分钟（向 0）。** ref 默认 12h 是给持续对聊的伴侣号；我这边的实际密度是「一天几轮、中间隔几小时」，12h 等于整个白天都带着早上的情绪。3h → 半天走完 4 个半衰，醒来基本归位；单维沿用 ref 的 90 分钟（情绪该散得快）。掉到基线：不写日志、不注入；只有距上次记账 ≥3 格才落一条 decay（ref:904-906 的 `lastNotedMood`）。基线取 48 不取 60：6.7:1 偏正的实测说明贴顶就变背景音。

**④ 注入：一行、≤60 字、独立 context 条目 `plugin:dsh-whale-memory:mood`，order 950（紧接记忆卡 940 之后），不占 `MEMORY_BUDGET_CHARS=1000`。** 那 1000 字是召回卡的预算（`constants.mjs:31`、`recall.mjs:211-218`），情绪行自带 60 字 cap。文案只有「（这会儿）有点沉，还累 —— 话里有「累」」，**不带数值**：数值会让我去表演数字，参考实现也只在结尾留一句「这是这会儿的底子，不是非这样不可」（ref:997-1000）。前缀缓存：动态段是尾部追加的 user/message，`systemPrompt` 各 section 一字不动。

**⑤ 存储：`meta` 存当前状态 + 新表 `mood_log` 存历史。** 当前状态一条 `meta` 键 `mood.state.<space>`（JSON，和 `consolidate.mjs:73` 一样 `INSERT OR REPLACE`）；历史落表（`day` 冗余存本地日期，省得查询里做时区算术）：

```sql
CREATE TABLE IF NOT EXISTS mood_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL, day TEXT NOT NULL,
  space TEXT NOT NULL DEFAULT 'default',
  mood INTEGER NOT NULL, dims TEXT NOT NULL DEFAULT '{}',
  raw REAL NOT NULL DEFAULT 0, conf INTEGER NOT NULL DEFAULT 0,
  injected INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mood_day ON mood_log(day, space);
```

「上周三我是什么心情」：

```sql
SELECT day, round(avg(mood)) 心情, min(mood) 最低, max(mood) 最高, count(*) 次数
FROM mood_log WHERE space='default' AND day='2026-10-28' GROUP BY day;
-- 那天的逐小时
SELECT strftime('%H', at/1000,'unixepoch','localtime') 时, round(avg(mood)) 心情
FROM mood_log WHERE space='default' AND day='2026-10-28' GROUP BY 时 ORDER BY 时;
```

（两条已在 `/tmp/mood-proto/schema-check.db` 上跑通，返回 `2026-10-28 / 48 / 44 / 52 / 2`。）

**⑥ 幂等与上限：四道闸照搬，且拦截路径都写 `injectedFor`。** ① `injectedFor === updatedAt` ② `minor` ③ `lastConfidence < 60` ④ 当日 `saidAt` ≥ 6。加一条 ref 没有的：`at <= updatedAt` 直接整轮跳过（同一轮被问两遍不许记两笔）。注入时同时写 `lastInjectedText`，设置页照它显示（ref:1600-1602 的做法）。

**⑦ 与 `entries.emo`：并存，职责按「谁的情绪」切。** `entries.emo` = **对方那句话里**的情绪词，挂在条目上，用于召回打分（×2.5）和画像计数；mood = **我这一轮之后**的状态，时间序列、要衰减、只给注入看。不合并：一个是检索标签，一个是状态机，混在一张表里会让召回权重被我的心情污染。要改的是 `persona.mjs:67` 那句「情绪底色」——它其实是对方情绪词统计，改名为「对方话里的情绪词（近 200 条）」，否则它冒充我的状态。

**⑧ 可见性：设置页四项 + 面板只读。** 开关（off / event / label，`event` 带缘由、`label` 只说状态）、半衰期（1–168 小时）、每日上限（0–50）、置信门槛（0–100），外加一行「上次注入的那句」。卡片里：只占自己那条 context，不挤记忆预算；闸不放行时整条不出现，所以大多数轮看不到——这正是「别变背景音」。

## 2. 最小原型

`/tmp/mood-proto/mood.mjs`（纯函数，无依赖）+ `mood.test.mjs`。`node --test` 5 通过：

```
✔ 涨：这一轮被夸 + 高兴 → 总值上去、维度记上、并且说一句
✔ 衰减：3 小时后总值走半个半衰期，单维 90 分钟散一半
✔ 幂等：同一轮说一次，重复渲染不再开口，重复判定不重复记账
✔ 日上限：说了六次之后只记账，仍然标成处理过
✔ 门槛：只有时间点一个信号（深夜）撑不到置信门槛，只记账
ℹ tests 5  ℹ pass 5  ℹ fail 0
```

接口：`note(上一状态, 本轮信号) → {新状态, changed}`；`say(状态, now, opts) → {状态, {yes,text,why}}`；`applyTurn(上一状态, 本轮信号) → {新状态, 是否注入, 注入文案}`。四道闸的 `why` 值分别是 `already / minor / low-confidence / daily-cap / same-turn / below-threshold`，方便以后数「为什么没说」。

## 3. 如果只做一件事

**先只做「记账 + 查询」，不注入。** 没有两周真实分布就定不了基线（48 还是 55）、门槛（60 还是 75）、上限（6 还是 3）——现在拍的数字全是抄 ref 的；而注入是不可逆的口气定调（ref:1597-1599 就是为「每轮都带把口气定死」打的补丁）。先攒 `mood_log`，用真实分布反推参数，再开注入。

## 4. 不建议现在做

- **不要每轮调模型判情绪**（ref:1326 `judge`）：token、延迟、不可复现，规则版先跑两周看偏差再谈。
- **不要做面板 widget / 时间线图**：前端 + `webserver/index-inject` + 设置页三处联动，收益只是好看。
- **不要动 `persona.mjs:67` 的「情绪底色」定义**：改名要连 persona 蒸馏的既有输出和 meta 缓存一起改，等情绪系统稳定后一起动。
- **不要把 mood 写进 `entries` 表**：会污染召回权重（`language.mjs:161`）和画像计数。
- **不要照抄 ref 的 `return line` 注入**：本仓库 `agent/turn-stopping` 不接返回值。
