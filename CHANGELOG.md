## 0.28.14

- 记忆卡新增「我的文件」一行：从 `INDEX.md` 解析文件名与一句话说明（每条截 14 字、最多 12 条、总长 300 字内），让每轮都能看见有哪些文件可翻。
- 只读文件，不写库；解析失败或文件不存在就跳过，不影响卡片其它部分。

# 更新记录

## 0.28.13

### 联想段和 `memory_recall` 改成六字段证据卡，正文另读

撑爆上下文的从来不是「想起几条」，是每条都把整段原文搬进来。所以命中只给卡。

- `lib/format.mjs`（新增 `shortId` / `sourceTag` / `quoteOf` / `cardScore` / `cardLine`）：
  一张卡一行、六个字段——`id`（条目 id 后 6 位，非数字 id 用 hash 前 6 位）、
  `tag`（`对话` / `工具` / `笔记`）、`score`（排序分，一位小数，**不是概率**）、
  `summary`（≤30 字）、`time`（`MM-DD HH:mm`）、`quote`（查询词在原文里定位，
  命中位置前后共 12 字的逐字原句，不改写、不加省略号；找不到给开头 12 字）。
  整卡 >120 字按 `tag → summary → quote` 逐字缩，三个都空了还超就整条丢掉
- `lib/recall.mjs`：`associate()` 不再拼 `${clamp(u,180)} → ${clamp(a,180)}`，
  改成每条一张卡；最多 5 条、整段 ≤650 字，位置与 1/3 预算约束不变，缓存机制一字未动
- `lib/constants.mjs`：`RECALL_LINE_CAP` 180 → **30**（现在是卡的摘要上限）、
  `RECALL_MAX` 3 → **5**，新增 `RECALL_CARD_MAX=120` / `RECALL_SECTION_CAP=650` /
  `RECALL_QUOTE_CHARS=12` / `RECALL_PAGE_DEFAULT=2000` / `RECALL_PAGE_MAX=8000`
- `lib/tools.mjs` 的 `memory_recall`：新增 `detail`（`card` 默认 / `full`）与 `offset`；
  `limit` 在 card 模式是条数（1-100，默认 20）、在 full 模式是每页字符数（默认 2000、上限 8000）。
  card 模式只回卡、**不出现原文**（`items[].card`，另带 id/day/zone/weight 便于定位）；
  full 模式把整段原文按 `offset/limit` 分页，返回带 `total`、`offset`、`text`、`nextOffset`
  （到末尾为 `null`）。原来 `slice(0,300)` 的截断只在 full 里由分页取代
- 没动的：`MEMORY_BUDGET_CHARS`（1000，所有会话共用）、`card()` 的同步性与
  `ctx.systemPrompt.context` 的 order 940、`ctx.compaction`、`lib/salvage.mjs`、
  writer/nightly/tidy 的删除与分层、DB schema。每轮 3 次限流与「低重合不提示」照旧

### 测试

- `tests/test-recall.mjs`（41 → 76 项）：卡 ≤120 字且六字段齐 / 三种 `tag` 的判定 /
  `quote` 按查询词定位且找不到时退回首 12 字 / 超长按 `tag→summary→quote` 缩、缩不动就丢 /
  联想段 ≤5 条且整段 ≤650 字且不含原文 / `memory_recall` 默认只回卡不带原文 /
  `detail:'full'` 的 `offset`+`limit` 分页、两页接得上、`nextOffset` 到末尾为 `null` /
  限流与低重合行为不变

## 0.28.12

### 事实有有效期了：失效只是不再默认注入，不删行

- `lib/facts.mjs`（新）：`ensureFactColumns()` 用 `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` 给 `facts` 补
  `valid_from INTEGER NOT NULL DEFAULT 0` / `valid_until INTEGER`，老行 `valid_from` 回填成迁移时刻
  （回填后不为 0，重跑不再往后推），`valid_until` 留 `NULL`；顺带建 `fact_conflicts` 与 `idx_fact_conflicts_created`
- `listFacts(db, { space, limit, includeExpired, now })`：默认 `valid_until IS NULL OR valid_until > now`，
  `includeExpired: true` 才连失效的一起给
- 默认取「仍成立」的三处：`lib/recall.mjs` 记忆卡的事实段、`lib/persona.mjs` 画像、`lib/consolidate.mjs` 画像素材

### 改口留痕，不并排躺着

- `recordFact(db, { text, space, now })`：同文本 → 跳过（不新增行、不写冲突）；相似度 ≥ **0.62** 且文本不同 →
  旧事实 `valid_until = now`、写新事实、往 `fact_conflicts(old_id,new_id,reason,evidence,created)` 记一行，
  `evidence` 存「旧：…｜新：…」两份摘要
- `lib/writer.mjs`：落库时的事实循环改走 `recordFact`，不再用 `similarity ≥ 0.6` 静默跳过；
  原有的 `factMax` 上限与清洗策略未动
- `recentConflicts(db, { limit })` + 只读端点 `GET /dsh-whale-memory/conflicts?limit=20`
  （`oldText`/`newText`/`evidence`/`day`；非 GET 一律 405）；旧事实万一被上限清掉，`evidence` 里仍有摘要

### 工具

- `memory_recall` 增加可选参数 `includeExpired`，返回值多一段 `facts`（`id`/`text`/`expired`），
  默认只给仍成立的。路由与工具都不写库、都不删行

### 测试

- 新增 `tests/test-facts.mjs`（30 项）：老库补列且不丢行 / 重跑不重复回填 / 默认只取仍成立 /
  `includeExpired` 取得到 / 相似不一致写冲突且旧事实失效 / 完全一致不新增行不写冲突 /
  记忆卡不含失效事实 / `memory_recall` 与 `/conflicts` 两个入口不抛错且只读
- 各测试的最小库 fixtures 补上 `valid_from`/`valid_until` 两列（和真库同形）

## 0.28.11

### 定时梳理默认关闭：会删条目的事不能自己跑起来

- `lib/index.mjs`：新增配置 `autoConsolidate`（`z.boolean().default(false).volatile()`）。
  第 643 行那个 6 小时定时器改成 `scheduleConsolidate({ enabled: autoConsolidate(), run })`，
  **默认返回 `null`，一个定时器都不注册**；打开后重启插件才生效。退出时的 `clearInterval` 加了空值判断
- `lib/consolidate.mjs`：导出 `scheduleConsolidate()` 与 `CONSOLIDATE_INTERVAL_MS`。
  注册逻辑抽成纯函数是为了能测——`setInterval` 可注入，测试不用真等 6 小时

### 手动梳理也必须先备份，删除必须成组

- `consolidateNow()` 入口第一件事：`backupNow({ force: true, label: 'pre-consolidate' })`，
  落成 `backups/memory-pre-consolidate-<毫秒时间戳>.db`。备不成直接返回 `{ skipped: 'backup-failed', detail }`，
  **一条都不删**；没接 `backupNow` 同样拒绝动手（`detail: 'no-backup'`）
- 合并 / 删除 / 写规律的整段删改挪进 `BEGIN IMMEDIATE` … `COMMIT`，异常 `ROLLBACK` 并返回
  `{ error: 'tx-failed', merged: 0, dropped: 0 }`。`vectorConsolidate()` 里 `LENGTH(TRIM(u))<3` 的删除也一并进事务
- 事务里不留 `await`：要写的向量（合并文本、规律）先算好再进事务，
  否则回滚会把 `await` 期间别人写的条目一起带走
- 梳理完记 `meta.consolidatedAt`（毫秒时间戳），`stats.consolidated` 沿用原来的计数

### 备份靠得住

- `lib/backup.mjs`：`backupNow()` 支持 `opts.label`，文件名变成 `memory-<label>-<时间戳>.db`，
  每次都是新文件、不覆盖当天那份日备份；不传 `label` 行为不变
- `scripts/memory-tidy.mjs`：真跑之前强制备份 `backups/memory-pre-tidy-<时间戳>.db`，
  失败就 `exit 3`，不动库；`--dry-run` 不备份

### 文档

- `lib/nightly.mjs`：注释里那句「用 `scripts/memory-tidy.mjs --prune` 手动跑，且必须带 `--yes`」是假的——
  脚本没有 `--prune` 参数，`settle()` 的 `allowPrune` 也没有调用方传 `true`。改成与现状一致
- README：补「动库之前强制备份」的时机表、`autoConsolidate` 的语义、`memory-tidy` 先备份

### 测试

- 新增 `tests/test-consolidate.mjs`（16 项）：默认不注册定时器 / 配置缺省也不注册 / `true` 才注册 / 间隔 6 小时；
  备份失败与没接备份函数时条目数不变；临时库 + 第 2 次 `DELETE` 抛错 → `tx-failed`、条目仍在、
  连合并的改写也回滚；正常路径照删、记 `consolidatedAt`、每次梳理都新留一份备份不覆盖

## 0.28.10

### 联想补回记忆卡：轻查询同步、重检索异步 + 一轮一格缓存

- `lib/recall.mjs`：新增 `associate(sessionId, userText)`（async）。它按情绪词、线索词、
  向量余弦给冷区条目打分（沿用 `scoreMemory` + 时效衰减 + `tier` 惩罚 + 门槛），
  取前 `recallMax` 条拼成一段。**算一次就够**：结果按 `session id` 存进一张最多 8 格的小 Map
- `card()` 只同步读缓存：有当前轮的联想段就并进卡片，放在热区之前；没有就整段跳过。
  绝不 await、绝不查向量、绝不打嵌入服务——card 每步组装都跑，这里必须便宜
- 缓存失效有三道：`associate()` 一进来就 `turn + 1` 并清空 `lines`（换用户消息即作废）；
  算的过程中又来了新消息（`turn` 变了）那一份直接丢掉；`at` 超过 10 分钟也丢
- 限额照旧：整卡仍受 `budgetChars()` 约束，联想段最多占其 **1/3**
- `lib/index.mjs`：`session/event` 收到真人 `user/message` 时 fire-and-forget 调
  `associate()`；`createRecall` 多接 `recallMax` / `recallThreshold` / `tierPenalty`

### 恢复升热：召回命中就浮上来

- `lib/tools.mjs` 新增导出 `warmEntries(db, ids, weightMax)`：
  `w = MIN(w + 1, weightMax)`、`hits = hits + 1`、`tier = MAX(tier - 1, 0)`，
  一条一次、一个事务、失败 `ROLLBACK` 后吞掉（召回结果不能因为记不上计数就丢）
- `memory_recall` 的 `execute` 在拿到 `rows` 后调用它；放在 tools 里而不是 `card()` 里，
  因为 card 是只读路径，每步都会跑
- 三个设置项的语义写清（README + 设置页提示）：`recallMax` / `recallThreshold` 只管
  记忆卡里的联想段；`tierPenalty` 参与联想段排序（`w ≥ 8` 免罚），当前版本生效

### 测试

- `tests/test-recall.mjs` 新增：缓存命中时卡片含联想段、别的会话不复用、
  用户消息不同则缓存不复用、超 TTL 不出现、整卡不超预算且联想段 ≤ 1/3、
  以及升热的 w/hits/tier 变化、同 id 去重、w 封顶、坏库不抛
- 通过条数：29 → 39（`tests/test-recall.mjs`）

## 0.28.9

### 记忆卡换注入点：从「每轮 prepend 一条 user 消息」改成 runtime-context

- `lib/index.mjs`：新增 `ctx.systemPrompt.context`（`plugin:dsh-whale-memory:memory`，
  `order: 940`，`interpolate: false`）。DSH 会把 context 物化成 user 角色的 runtime-context
  快照，**每步组装时现算、压缩冲掉后重新投**——这才是「擦不掉」的那一层
- 删掉 `agent/pre-step` 里 prepend 记忆消息的分支：同一条记忆不会再在一轮里出现两份，
  群里/日志里也不再冒出「记忆注入 N 段」那条 notice
- `lib/recall.mjs`：`build`（async）→ `card`（**纯同步**）。只读 sqlite 和文件
  （声音、交接条、日记、事实、热区、私聊的群摘要），不联网、不调模型。
  同步层取不到数据就返回空串，不抛错、不阻断对话；老 harness 没有 `context()` 就跳过注册
- 卡片正文缓存一次文本比对再记 `injectChars`，否则每步组装会把统计刷成几倍
- 向量主动联想不再在注入路径里做（`text` 必须同步），深查交给 `memory_recall` 工具

### 召回限流（防爆三件套）

- `lib/tools.mjs` `memory_recall`：一条人类消息之间最多 3 次，第 4 次直接回
  「这轮已经查够了，先用手上的」，不再翻库
- 计数在 `session/event` 收到新的用户消息时清零（`lib/tools.mjs` 自己挂监听）
- 命中内容与查询词重合度 < 20% 时不再追一句「要不要再查」，只在真相关且还有额度时提示
- 字节上限沿用原来的（每轮注入 1000 字、每条渲染 300 字截断）

### 测试

- `tests/test-recall.mjs` 重写：空库给空串且不抛、库坏掉不抛、缺 agent 不炸、
  预算卡住不溢出、同文本只记一次账
- `tests/test-recall.mjs` 新增限流段：第 1 次照常查、第 4 次被拒、
  重合度低不给提示、新消息后计数归零
- `tests/test-routes.mjs`：钉住 context 的 name/order/interpolate、空库返回空串、
  以及「不再注册 pre-step 注入钩子」
- `tests/test-memory-tidy.mjs`：删掉召回写 hits/tier 那一段（那条路径已经不写库了）


## 0.28.8

### 同步安装副本：一条命令 + 强制校验（0.28.7 事故的收尾）

- 事故：0.28.7 的「冷热分层」只加进了仓库 `client.js`，没同步进
  `~/.dsh/profiles/web/node_modules/dsh-whale-memory`。dsh 读的是副本，于是设置页
  看不到这一组，**重启也没用**（重启加载的还是那份旧文件）。同一次比对还查出
  `lib/tidy.mjs` 整个缺失、`lib/recall.mjs`/`index.mjs`/`shared.mjs`/`constants.mjs` 全旧，
  也就是 0.28.6 的记忆分层从没在运行实例里生效过
- `scripts/install-local.mjs`：复制完立刻逐文件比对（`client.js`、`lib/**`、`package.json`、
  `cordis.patch.yml`、`README.md`），不一致就列出文件名并 `exit 1`；仍是幂等的
- 新增 `scripts/verify-install.mjs`：只校验不动文件，支持 `--profile` / `--json`，
  副本或 profile 不存在时打 `SKIP` 并返回 0
- `scripts/check-all.mjs` 第二步接入该校验；`scripts/protect.sh` 装完再校验一次，
  失败记 `FAILED=1` 并最终 `exit 1`
- `docs/同步安装副本.md`：一句话结论 + 一条命令 + 排查顺序

### 设置页三块面板

- **场景**：空列表给出「为什么还没有」的说明；每条显示「N 条记忆 · 最近触发 X」，
  触发时间来自 `meta` 的 `sceneHit:*`（`matchScenes` 真命中时写，不编）；
  可以单条删除，`window.confirm` 二次确认，删完在 `meta` 留 `sceneMuted:*` 墓碑，
  下次重建不会自己长回来。新端点 `POST /dsh-whale-memory/scenes/delete`
- **画像**：显示桌面页字节数与生成时间，并列出 `notes/*.md` 的修改时间
  （默认 `~/.dsh/miyu/notes`，也认 `notes/` 旁边那两种布局）；
  新增「重新生成桌面页」按钮 → `POST /dsh-whale-memory/desk`，走夜班同一套
  `buildDesk`/`writeDeskFile`，不调模型、不并入记忆
- **图谱**：最多返回 200 个点并带回 `total`/`omitted`，页面画前 40 个，
  其余显示「已省略 N 个」；点节点用现成的 `entries` 搜索取一条原文（不新造查询）
- `tests/test-scenes.mjs` 补 6 项（触发记入 meta、删除留墓碑、重建不复活），
  `tests/test-routes.mjs` 补三组（场景/画像桌面页/图谱截断）

## 0.28.7

### 记忆分层三参数进设置页

- 新增三项配置：`hotZoneMax`（热区条数上限，1–200，默认 30）、`hotPromoteWeight`
  （抬进热区的最低权重，0–20，默认 3）、`tierPenalty`（每深一层扣的排序分，0–1，默认 0.15）。
  都带 `.volatile()`，设置页改完下一轮就生效
- `lib/tidy.mjs` / `lib/recall.mjs` 改成「配置优先、缺省回落常量」，越界值夹到边界
  （统一走 `shared/helpers.mjs` 的 `numCfg`）
- `scripts/memory-tidy.mjs` 取值优先级：命令行参数 > 活动 profile 的插件配置 > 常量；
  `--dry-run` 照旧。可用 `--config <cordis.patch.yml>` 指定别的 profile
- 设置页加「冷热分层」一组；`tests/test-memory-tidy.mjs` 补默认值、config 覆盖、越界夹边界等 9 项

## 0.28.6

### 新增：记忆分层（`hits` / `tier`）与库务整理

- `entries` 加两列：`hits`（被召回次数，只增）、`tier`（0 热、1..N 冷层）。老库启动时自动补列，
  已有的冷条目按 `hot` 填一次 1 层，填完在 `meta` 里留标记，之后不再覆盖召回抬浅的结果
- 召回命中时一条 `UPDATE` 同时做三件事：`w + 1`、`hits + 1`、`tier - 1`。同一轮同一条只加一次
- 打分加层级惩罚（`0.15 × 层数`，上限 9 层）：深的往后排，但向量/情绪仍是主权重；
  `w ≥ 8` 的条目不受罚，不会被层级压到检索不到
- 新增 `lib/tidy.mjs` + `scripts/memory-tidy.mjs`：补空向量、抬热区（最近 7 天且 `w ≥ 3`）、
  热区硬上限 30 条按 `w` 降级；支持 `--dry-run`；嵌入服务不在时记失败并继续。全程不删条目
- 新增 `tests/test-memory-tidy.mjs`（25 项），已加进 `npm test` 与 `npm run check`

## 0.28.5

### 修：切页签那一下会崩（热区/冷区/场景/空间）

- 换页签时旧数据还挂着，新页签拿它渲染：从「场景」切到「热区」时旧数据没有 `emo`，
  `item.emo.length` 直接抛 TypeError，整页进错误边界
- 现在加一道 `dataZone === zone` 的闸，旧数据只当「读取中」；`emo` 也给了兜底
- 顺带消掉切页签时同一把 key 撞车的警告

## 0.28.4

### 修：「当前空间」是空的、也写不进去

- `space` 之前不是 volatile，设置页的投影只带 volatile 字段，所以这一格永远是空、写了也被拒
- 现在 `space` 是 volatile，改完下一轮就按新空间走
- 顺带核了其余设置项：都在 volatile 上，能改

## 0.28.3

### 设置页白屏不再无声

- 给整页套了错误边界：崩了就在页面上写出错误信息，不再给一整块空白
- 夜班那三项目前没配置时显示默认值（开 / 22 / 5），不再留空
- 客户端设置页测试照旧全过

## 0.28.2

### 修：设置页那两个新端点其实没接上

- `lib/routes.mjs` 里 `/selfcheck`、`/nightly` 的处理函数引用了 `nightly`，但 deps 解构时漏了它
- 表现：设置页点「立刻跑一班」报请求失败，桌面页/并入两个格子一直是「?」
- 现在补上解构；`scripts/check-all.mjs` 的「未定义名字」本该抓到，之前漏跑
- 顺带给 routes 测试加了自证 + 手动跑一班的用例

## 0.28.1

### 设置页也看得见了

- 记忆设置页新增「夜班 / 桌面页」一组：每天自动跑、几点开、几分开，都是热改
- 顶部统计格多两格：桌面页多少字节、今晚并入几条
- 加一个「立刻跑一班」按钮，点完直接看结果和日志路径
- `night.*` 进配置 schema（volatile），改完不用重启

## 0.28.0

### 桌面页 + 夜班：把「一层一层翻」做成默认动作

- 新增 `lib/desk.mjs`：从库（唯一真相）蒸出桌面页，四段——我是谁、关于这个人、我守的约、手上在做什么，外加固定的「记忆怎么转」
- 预算按 UTF-8 字节算：总 ≤4096，事那一段 ≤2048；超了走固定四级压缩（原句 → 前半句 → 第一句 → 去修饰取前 20 字），同一份记忆每次缩出来是同一句
- 桌面页每轮随系统提示注入（`plugin:dsh-whale-memory:desk`），夜里同时落到 `记忆本/桌面页.md`，人和约只缩不删
- 新增 `lib/nightly.mjs`：22:05 起一天一班的夜班，顺序固定——备份 → 结算（热的降温、冷的加权上浮、30 天没动的清掉）→ 重建场景/画像/图谱 → 蒸桌面页 → 写日档 → 写日志
- 日志末尾固定一行四数：`L1=… L2=… 事实=… | 桌面页=… | 今晚并入=… | 总体=…`；跑完另写 `最后自查.txt`
- 防撞车：`nightly.lock`，占着 30 分钟内不抢，超过当死锁拆掉重来；跑完一定放锁
- 新端点：`GET /dsh-whale-memory/selfcheck` 要四个数，`POST /dsh-whale-memory/nightly` 手动跑一班
- 可手写 `记忆本/约.md`（或 `~/.dsh/whale-memory/约.md`），夜班会把它收进桌面页的「我守的约」
- 测试：`tests/test-desk.mjs`，覆盖四级压缩、预算、落盘、锁、自证

## 0.27.1

### 安全检查后的两处收口

- 超过 64KB 的 POST body 之前直接 `req.destroy()`，客户端拿到的是连接被重置；现在改成读完丢弃并回 `413 {reason:"too-large"}`
- `correctEntry` 的正文没有上限，接口能收 64KB 就能存 64KB，会把上下文挤爆；现在截到 2000 字

### 检查过、没问题的

- SQL 注入：`keyword` / `space` / `id` 全走占位符，FTS 查询词做双引号转义；`' OR 1=1 --` 返回 0 条
- 越权：`memory_correct` 有 owner 守卫，`allowForeign` 才允许改别人的条目
- XSS：客户端只渲染文本节点，图谱节点名走 SVG `text`，React 会转义
- 方法：只读端点只认 GET，写端点只认 POST，其余回 405


## 0.27.0

### 省 token

- 召回单条展示从 300 字降到 180 字（`RECALL_LINE_CAP`），日记从 200 降到 120
- 图谱只给 1 个实体、3 个邻居；场景只给前 4 行
- 冷区扫描 500 → 300 条
- 新增 `injectChars` 统计：每轮注入多少字都有账，配置调过头能立刻看见

### 提性能

- `cueWords` 加了小缓存：同一句话在一轮里被场景/图谱/召回各算一遍，现在只算一次
- 嵌入调用加缓存（64 条）并且改成懒算：闲聊轮不再为一次用不上的向量付网络延迟
- 新索引 `entries(space,hot,t)`、`scenes(space,updated)`、`edges(space,w)`，都放在迁移之后建，老库也能补上

### 实测（本机 595 条记忆）

| 场景 | 之前 | 之后 |
|---|---|---|
| 闲聊一句 | 33ms / 284 字 | 25ms / 284 字 |
| 带情绪的一句 | 59ms / 961 字 | 63ms / 967 字（首次含嵌入） |
| 同一句话再问 | 63ms | 9.4ms |


## 0.26.0

### 兼容性

- `engines` 对齐宿主：`^22.19.0 || >=24.0.0`（`node:sqlite` 在 22.19 上可用且无需 flag，更早的版本要加 `--experimental-sqlite`）
- 新增 `lib/db-open.mjs`：先带 `timeout` 选项开库，老 Node 不认这个选项就退回「裸开 + `PRAGMA busy_timeout`」，两条路效果一样
- 主连接、备份、日记语料、导出脚本统一走 `openDb`
- fts5 trigram 与 `entries_fts` 全程包在 try 里：没有 fts5 的环境自动退回 LIKE
- 文档补一节「兼容性」：Node 版本、SQLite 特性、Windows/Linux 差异（`scripts/start-dsh.sh` 与 systemd 单元是 Linux 专用）


## 0.25.2

### 设置页仍白屏的真因（修）

- 控制台报的是 `ReferenceError: localDayKey is not defined`：重写 `Panel` 时把它的定义一起删掉了，而它只在「主动消息状态拿到了」的分支里用，所以自检和 SSR 都没碰到
- 把 `localDayKey` 补回 `Panel` 之前
- 顺手把 `client.js` 纳入「未定义名字」检查：以后这类删漏会在 `check:all` 里直接报出来，不用等浏览器


## 0.25.1

### 设置页白屏（修）

- `Panel` 里用了 `React.Fragment` 拼脚注，宿主给的 React 不一定有 Fragment，取不到时整块渲染抛错 → 设置页空白。改成直接渲染带 key 的 `<p>`
- 其余布局不变


## 0.25.0

### 设置界面重做

- 顶部换成标题栏：名字 + 版本号 + 刷新（只重拉状态，不重载页面）
- 原来的长文字状态行拆成 8 个小卡片：热区/冷区/事实/场景/空间/向量/想起/蒸馏，一眼扫完
- 设置分组从单列改成自适应多列网格（`auto-fit minmax(260px,1fr)`），宽屏不再一条长龙
- 卡片圆角、边框、底色统一，长页面读起来有层次
- 记忆浏览器保持原来的标签 + 搜索，参数渲染逻辑没动


## 0.24.1

### 中文短语搜不全（修）

- trigram 只认连续片段：「重启插件」搜不到「重启了…插件」。现在 FTS 命中为空时，按两字一组拆开做 AND 交集（重启 ∧ 插件），再退回整串 LIKE
- 测试加 1 条


## 0.24.0

### 全插件审计后修的三处

- 图谱跨空间串味：`entities` / `edges` 加 `space`，按空间重建、按空间查；旧结构没有复合主键，启动时检测到就直接重建表（纯派生数据，无损失）
- 画像蒸馏的素材没分空间：`facts` 与 `scenes` 查询都按当前空间过滤
- FTS 触发器从 `AFTER UPDATE` 收窄成 `AFTER UPDATE OF u, a`：召回时改权重不再重写索引行，少一次无谓的删除+插入，也缩小了索引被写坏的面；旧触发器启动时 `DROP` 后重建


## 0.23.0

### 蒸馏按层路由（新）

- 配置 `llm.l1` / `llm.l2` / `llm.l3`，值写 `provider/model`，留空跟随默认路由
- `routeFor(layer)` 统一解析：L1（合并去重，高频）可以给便宜快的模型，L3（画像，低频）可以给强但慢的本地模型
- `consolidate` 的两处调用点接上：合并计划走 L1，画像走 L3（未配 L3 时沿用 L1）

> 典型用法：L1 用 deepseek-flash，L3 指向本地 R1（ollama / vLLM 的 OpenAI 兼容端点）。


## 0.22.0

### 全文索引周期体检（新）

- 启动探针只抽一条记忆，会漏；改成每小时再体检一次，发现不同步就 `rebuild` 并记 `ftsRepaired`

### 场景与事实按空间隔离（修）

- `scenes` 加 `space` 列：聚类、增量合并、匹配都只在同一空间内进行，A 空间的旧事不会拼进 B 空间的上下文
- `facts` 加 `space` 列：写入去重、裁剪上限、召回读取、画像蒸馏全按当前空间
- 增量标记改成 `meta.scenesMaxId:<空间>`，各空间各记各的
- 测试加 3 条空间隔离用例，共 23 条


## 0.21.0

### 召回主路径有了单测

- 新增 `tests/test-recall.mjs`：9 条覆盖事实/热区/日记进上下文、情绪触发主动联想、同会话去重、换会话重新可见、自唤醒分支、无内容返回 null
- 向量服务故意指到死端口，顺带验证降级路径

### 启动不再被索引重建拖住

- 场景/画像/图谱的启动重建从同步改成 `setTimeout(..., 1500)` 后台跑，并打一行耗时日志
- 它们都不是「开口前必须有」的东西，库大了也不该把冷启动卡住


## 0.20.0

### 修：database disk image is malformed（FTS 索引与正文不同步）

- 根因：`recall` 里 `UPDATE entries SET w = ...` 会触发 `entries_fts_au`，索引一旦和正文对不上，删旧行就抛 SQLITE_CORRUPT，整轮对话被打死
- `UPDATE` 权重累积包进 try：软信号写不进去，不该让注入失败
- 新增 `lib/fts.mjs`：`integrity-check` + **真实搜索探针**（外部内容表上 count 永远相等、integrity-check 也不比正文，只有「搜得回来」能证明同步），发现不同步就 `rebuild` 再复核
- 启动时跑一次体检；`keywordIds` 遇到损坏错误自动重建重试一次
- 测试加 7 条（体检、探针、重建幂等、损坏判定）


## 0.19.0

### 全文检索（新）

- 加 `entries_fts`（fts5 + trigram 分词）与三条触发器，主表增删改自动同步；启动时数量对不上就 `rebuild`
- `keywordIds()`：≥3 字走 FTS，短词或 fts5 不可用时返回 null，调用方退回 LIKE
- `/entries?keyword=` 与 `memory_recall` 都走这条路径
- 中文 trigram 至少三个字才切得出词，两个字仍走 LIKE——这是分词器的边界，不是 bug

### 记忆空间 UI（新）

- 设置页加「空间」标签：列出各空间和条数，当前空间带 ● 标记
- 点「切到这个空间」直接写 `space` 配置，立刻生效
- `/status` 增加 `space` 字段，面板显示当前空间

### 测试

- 加 2 条 FTS 用例，共 20 条


## 0.18.0

### 图谱可视化（新）

- 设置页「鲸娘记忆」加「图谱」标签：前 40 个节点画成 SVG，边越粗表示一起出现得越多
- 布局是便宜的三段式：圆周初始化 → 点间斥力 → 边当弹簧，跑 120 轮收敛，不引任何依赖
- 节点大小按出现次数开方，避免高频词把图压扁；读的还是 `/graph` 只读端点


## 0.17.3

### 启动日志审计后的修复

- `dsh-whale-ruminate.service` 16:09 那次失败抓到了：`ruminate 失败: database is locked`。脚本没设 busy timeout，正撞宿主写锁
- `ruminate.js` 连接加 `timeout: 5000` + `PRAGMA busy_timeout`，并加退避重试（最多三次，1s/2s），锁争用不再把 systemd 记成 failed
- 其余独立脚本的连接也一并补上：`corpus/lib`、`corpus/backfill`、`corpus/exemplars`、`proactive/lib/index`、`proactive/lib/core`、`group-digest.js`
- 已手工跑过一次 ruminate（写入 2 条联想，退出码 0），并 `reset-failed` 清掉失败状态


## 0.17.2

### 审计后修的两处

- 图谱边表原来无上限：575 条记忆长出 28200 条边，库白胖。现在只留权重最高的 2000 条，并过滤长串 openid / 十六进制 id 这类假实体
- `memory_recall` 之前跨空间乱查：现在按当前空间过滤，和注入口径一致（`searchEntries` 支持 `space`）


## 0.17.1

### 修：database is locked

- 主连接 `new DatabaseSync(dbPath, { timeout: 5000 })`，并显式 `PRAGMA busy_timeout = 5000`；默认 0 时一次短暂争用就直接抛错，会把整轮对话带崩
- `lib/backup.mjs`、`lib/diary.mjs`、`scripts/export-memory.mjs` 的只读连接同样加 5 秒

### 修：重复启动留下的僵死实例

- 新增 `scripts/start-dsh.sh`：起之前先看 3080；已在监听就不起第二个。端口空着但库被 D/Z 状态进程捏着，直接 `kill -9`
- README 加「启动与排障」：EADDRINUSE → D 状态 → 死锁不放锁 的完整处置步骤

> 超时只挡住「争用」；真正的死锁是僵尸进程攥着写锁，SIGTERM 杀不掉，只能 SIGKILL。


## 0.17.0

### 设置界面（改）

- 修：设置项只认数字，字符串配置（`space`、路径）根本渲染不出来——`Row` 加文本分支，失焦或回车才写
- 新增「记忆空间」分组（当前空间可填）
- 状态区改成卡片，补上版本号 `v0.17.0`，一眼看到跑的是哪一版
- 每组设置加卡片边框，行距收一点，长页面不再糊成一片
- 测试预期同步到 7 组 / 17 项


## 0.16.0

### 移除跨机器同步（revert）

- 删掉 `lib/sync.mjs`、`/dsh-whale-memory/sync` 端点、`sync.*` 配置与定时器
- 测试删掉 `tests/test-sync.mjs`；其余功能不动
- 理由：共享目录同步在单机上没收益，多一层合并逻辑反而增加出错面


## 0.15.0

### 记忆浏览器可搜（改）

- `/entries` 支持 `?keyword=` 与 `?all=1`（跨空间），`?space=` 仍然可用
- 设置页加搜索框（回车或点「搜」）和「全部空间」勾选
- 搜索是 LIKE 匹配，不建索引；记忆量再大再考虑 FTS


## 0.14.0

### 跨机器同步（新）

- 新增 `lib/sync.mjs`：一台机器往共享目录写快照，读别人的快照按内容指纹去重合并
- 指纹 = sha1(用户侧 + 助手侧 + 时间)，重复合并只加不重
- 配置 `sync.dir` / `sync.intervalMinutes`；不填目录就不启用
- 新端点 `POST /dsh-whale-memory/sync` 手动同步一次；合并到新条目后自动重建场景/画像/图谱
- 测试加 7 条（导出、合并、幂等、指纹）

> 走的是共享目录（Syncthing、网盘挂载都行），不架中心服务、不管谁先谁后。


## 0.13.0

### 场景增量（改）

- `rebuildScenes` 记 `meta.scenesMaxId`：没有新条目就直接跳过（返回 `skipped: 'no-new'`）
- 新条目少于 50 条时不做整表重排：按线索把它们并进已有场景，正文保留最近 8 行
- 新条目多、或场景为空时才全量重建
- 测试加 1 条，共 18 条


## 0.12.0

### 按天记账 + 趋势（新）

- 新表 `daily_stats(day,k,v)`；`bumpStat` 现在同时记总数和当天数
- 蒸馏的调用次数与字符数改走 `bumpStat`，一并进按天账
- 新端点 `GET /dsh-whale-memory/trend?days=14`
- 设置页面板加一行「近 7 天：蒸馏 N 次 / 想起 N 次」，一眼看出趋势


## 0.11.0

### 实体关系图谱（新）

- 新增 `lib/graph.mjs`：从近期记忆里抽线索词做实体，统计同一条记忆内的共现，建出 `entities` / `edges` 两张表
- 纯统计，不推断因果；可整表重建，启动和每次梳理后各重建一次
- 召回时若本轮提到图里的词，附一行「常一起出现」，并标「只是共现统计」
- 新端点 `GET /dsh-whale-memory/graph`：最多 60 个节点、120 条边
- 测试加 4 条，共 17 条


## 0.9.0

### 条目可改可撤（新）

- 设置页每条记忆下多了「改」「撤回」两个按钮：改只动用户侧那句，撤回原件进 `revisions`
- 新端点 `POST /dsh-whale-memory/entries/correct`、`POST /dsh-whale-memory/entries/retract`，请求体 ≤64KB
- 统计加 `corrected` / `retracted` 两个计数

> 模型侧本来就有 `memory_correct` 工具；这次补的是人能直接点的入口。


## 0.8.0

### 混合检索（新）

- 新增 `rrf()`：关键词一路、向量一路排完，用 Reciprocal Rank Fusion 合成一路
- 召回排序在向量可用时走融合，两路都靠前的优先，只有一路命中的不丢
- 向量不可用时行为不变，仍按单一分数排

### 状态与面板（改）

- `/status` 增加 `scenes`、`spaces`、`personaChars`
- 设置页面板那行补上「场景 N 段 · 空间 N 个 · 蒸馏 N 次」

### 测试

- 新增 RRF 两条用例，共 13 条


## 0.7.0

### 记忆空间（新）

- `entries` 加 `space` 列（默认 `default`），老条目自动落在默认空间，行为不变
- 新表 `spaces`；配置项 `space` 决定当前空间，落库与召回都按它过滤
- 召回只看当前空间：热区最近几轮、冷区主动联想都不串味
- 新端点 `/dsh-whale-memory/spaces` 看各空间条数；`/entries` 支持 `?space=`
- 导出带上 `space` 字段，方便按空间拆分

> 这一步是「本地分空间」。远端 Provider（Mem0/Honcho 那类）还没接，接口留在这里，等真要跨机器再补。


## 0.6.0

照着 dsh-layered-memory / dsh-mnemon 那类分层记忆补的，补的是「点之外的线」。

### 场景层（新）

- 新增 `scenes` 表与 `lib/scenes.mjs`：把同一线索下的冷记忆按共同线索词聚成一条场景，正文按时间串起来
- 每次定时梳理后自动重建，不调模型，纯规则、可解释、可重建
- 召回时先给「相关场景」再给单条旧事：问「那个 bug 后来怎样了」能拿到一段而不是四条碎片

### 召回（改）

- 同会话去重：`recall_seen` 按 session 记已注入的条目，同一段不反复占上下文；压缩后清空可再注入，7 天自动清理
- 时效衰减：相关度 × `max(0.5, 0.5^(天数/30))`，相关度相近时新记忆优先，老记忆最多损失一半排序分（地板兜底）
- 线索词补拉丁词：`cueWords` 现在也抽 bot、deepseek 这类英文词，中文 n-gram 对它们原本完全失明

### 画像层（新）

- 新增 `lib/persona.mjs`：从事实、高频线索、场景主题、情绪分布里蒸出「我记得的你」，写进 `meta.persona`
- 系统提示新增第三段「我记得的你」（order 2），梳理时自动重建，对不上以当下的话为准
- 纯规则，不调模型；空库时画像为空，不硬编

### 蒸馏记账（新）

- 每次 distill 成功记 `stats.distillCalls` 与 `stats.distillChars`，端点原样能读到，能看出这一层花了多少

### 可见与可带（新）

- 设置页「鲸娘记忆」加两个标签：场景（按线索成段的旧事）与画像（从记忆里蒸出来的「我记得的你」）
- 新增端点 `/dsh-whale-memory/scenes`、`/dsh-whale-memory/persona`，都只读
- 新增 `scripts/export-memory.mjs`：把记忆导成 `memory.json` + `memory.md`，只读源库；`--git` 提交、`--push` 推远端，零依赖

### 测试

- `tests/test-scenes.mjs`：场景聚类、匹配、不相干不硬凑、去重按会话隔离、画像蒸馏与写回，共 11 条

## 0.4.0

一次大改：从「会记」推进到「记得住、改得动、救得回」。

### 记忆

- 分层记忆：热区/冷区，按预算自动降温
- 情绪召回：五类情绪 + 线索词 + 向量余弦 + 累积权重
- 压缩抢救：被压掉的原文捞回来，先判断值不值得留，再蒸馏
- 取舍倾向（`memory_policy`）：我自己写的标准，参与「留不留」判断
- 每天写日记：到点自己记，第一人称
- 跨窗口事件线：所有会话/工具写同一条，只留最近 5000 条
- 记忆可改错：修正/撤回，原件进 `revisions`
- 写边界：读共享、写分域、改要留痕（`owner` / `actor`）
- 备份：`VACUUM INTO` 快照 + 当场完整性校验 + 轮转，恢复由人来点

### 工具

- `memory_recall` / `memory_correct` / `memory_policy` / `memory_backup`
- `timeline_recent`：跨窗口看最近发生了什么
- `web_read`：公共 DNS 解析，绕开本机代理的假地址
- `preference`：读写自己的偏好

### 设置面板

- Web 设置里一页，管两个插件的配置，14 项可调
- 数值失焦提交、范围放宽、超界回显
- 记忆内容只读预览（热区/冷区）

### 人格

- `PERSONA.md` 只留底线；兴趣与偏好挪到 `PREFERENCE.md`，由自己改，覆写留 `.bak`

### 重构

- `lib/index.mjs` 2506 → 742 行，按职责拆成 17 个模块
- 语料、主动消息两个配套插件同样拆分
- 共用零碎收敛到 `shared/helpers.mjs`，`sync-shared.mjs` 生成副本并校验
- 新增 `scripts/check-all.mjs`，一条命令跑完三个包的自检

### 修掉的坑

- `force` 参数写了但没人读，手动触发被闸门挡住
- 归档条目被当成跟进素材，拼出「（归档）…后来怎么样了」
- 自己唤醒那一轮没有回程，话没发到 IM
- 唤醒词只认 `miyu`，中文名「米鱼」叫不醒
- 时间窗用例卡在边界，1/3 概率假失败

## 0.3.0

- 真向量召回（本地 BGE）、SQLite 存储、主动联想
- 胡思乱想（定时器写联想噪声）
