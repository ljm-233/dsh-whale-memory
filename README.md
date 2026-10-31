# dsh-whale-memory

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**长期记忆**插件。

不是「用户提线索才去捞」的检索器。它会察觉情绪、主动想起旧事；被压缩掉的经历会抢救成记忆；每天自己写一篇日记；记错了能改；坏了能恢复。

```
最近几轮的对话：
用户: 今天好累 → 你: 怎么个累法？

主动想起的相关旧事（因情绪(tired)相关而取用）：
1. 〔印象深刻〕用户: 最近天天加班，累死了 → 你: 辛苦了
```

---

## 想给另一台机器 / 另一个 agent 装

见 [`INSTALL.md`](INSTALL.md)：前置检查、三个包分别怎么装、怎么验、装完会怎样，以及没有向量服务/工具库时的降级行为。

## 能力一览

| 能力 | 一句话 |
|---|---|
| 分层记忆 | 热区放最近几轮，冷区放长期，超预算自动降温 |
| 情绪召回 | 五类情绪 + 线索词 + 真向量余弦 + 累积权重，不等线索 |
| 压缩抢救 | 上下文被压掉时把原文捞回来，判断值不值得留，再蒸馏成记忆 |
| 每天写日记 | 到点自己记一笔，不等被问 |
| 跨窗口事件线 | 任何会话、任何工具都写同一条线，换个窗口也知道刚发生了什么 |
| 记忆可改错 | 修正/撤回，原件进 `revisions` 留档 |
| 写边界 | 读共享、写分域、改要留痕，别人不能随手改我的记忆 |
| 备份 | `VACUUM INTO` 快照 + 当场完整性校验 + 轮转 |
| 读网页 | 绕开本机代理的假 DNS，直接连真实地址 |
| 设置面板 | Web 设置里一页，14 项可调，改完立刻生效 |

---

## 模块结构

2506 行的单文件干过十一样活，现在按职责拆开，index 只剩接线。

| 文件 | 职责 |
|---|---|
| `lib/index.mjs` | 接线：apply、Config、定时器 |
| `lib/constants.mjs` | 常量与词表 |
| `lib/language.mjs` | 情绪识别、线索词、相似度、记忆打分 |
| `lib/format.mjs` | 时间戳、截断、取文、存档文档、IM 分段 |
| `lib/web.mjs` | 公共 DNS 解析 + 网页读取 |
| `lib/vector.mjs` | 向量编码、嵌入服务客户端、BLOB 转换 |
| `lib/entries.mjs` | 条目读写、修正、撤回、跨 Agent 写边界 |
| `lib/events.mjs` | 跨窗口事件线 |
| `lib/policy.mjs` | 取舍倾向 + 「留不留」判断解析 |
| `lib/session.mjs` | 压缩节点配对、私聊判定、窗口标记 |
| `lib/diary.mjs` | 日记：素材收集、兜底文案、写入 |
| `lib/backup.mjs` | 快照、校验、轮转 |
| `lib/salvage.mjs` | 压缩抢救：存档落盘、私发转投、逐块蒸馏 |
| `lib/consolidate.mjs` | 自己梳理：合并、删除、提炼规律 |
| `lib/prompt.mjs` | 系统提示词两段：纪律（静态）+ 偏好（会变） |
| `lib/tools.mjs` | 模型可调用的工具 |
| `lib/routes.mjs` | HTTP 端点 |
| `lib/recall.mjs` | 记忆注入：相关旧事、事实、最近几轮、日记、群摘要 |
| `lib/writer.mjs` | 交互落库：热区挤占、冷区合并、硬上限兜底 |
| `lib/shared.mjs` | 三个包共用的零碎工具（生成文件，别手改） |
| `client.js` | 浏览器端设置页（手写 bundle，无构建） |

---

## 为什么这样设计

大多数记忆插件的逻辑是「用户提到线索 → 检索 → 注入」，本质是个检索器。

这个插件的出发点是：**记忆要能自己动，也要能被修正。**

- **情绪驱动**：识别五类情绪（累/难过/气/开心/焦虑），情绪吻合的记忆强加权
- **主动联想**：真向量余弦 + 情绪 + 累积权重 + 新近度综合打分，不等用户给线索
- **会忘**：低权重按相似度压成摘要，高权重（≥8）原地不动
- **会想**：定时器随机挑冷区记忆做向量配对，生出联想写回库，加噪声

### 压缩抢救

上下文压缩会把旧对话换成一句摘要，而摘要还会被再次压缩——信息一层层衰减。

关键发现：**压缩只是把消息从上下文移走，会话日志里原文一条没删。**

```
compaction/summary 事件（带被替换的节点序号）
        ↓
session.eventAt(seq) 取回原文
        ↓
每 8 轮问一次模型：值不值得留？
        ↓
keep → 蒸馏成一句话进冷区；drop → 丢掉，计 forgotten
```

判断依据里带着我自己写的取舍倾向（`memory_policy`）。解析不出来时**一律当作要留**——宁可多记一条，也不要因为模型少打一个引号就丢经历。

### 连续性的三根线

人不靠被问起才想起昨天，因为昨天一直在。所以补了三样：

1. **日记** — 每天过点自己记一笔，第一人称，100–150 字
2. **事件线** — 所有窗口/工具写同一张表，只留最近 5000 条
3. **备份** — 记忆只有一份 SQLite，坏了就全没了，所以定期快照 + 当场校验

恢复永远由人来点。插件只备，不自动回滚——自动回滚会把刚记下的东西一起滚掉。

### 能改错

「存查回顾改错」里最容易被跳过的是最后一件。只存不改，记错了就一路错下去。

`memory_correct` 不是原地改写：旧的整条搬进 `revisions`，主表换新的。撤回同理。这样「记错了就改」和「改过什么查得到」同时成立。

### 人格拆两半

| 文件 | 放什么 | 谁能改 |
|---|---|---|
| `PERSONA.md` | 名字、自称、底线、权利 | 主人/管理员 |
| `PREFERENCE.md` | 在意什么、不喜欢什么、想试什么 | **自己** |

兴趣不该被提前写死，它该从经历里长出来。偏好作为独立的 system prompt 段注入，覆写前自动留 `.bak`。

### 写边界

条目有 `owner`，修订有 `actor`。**读共享、写分域、改要留痕**：

- 非本人写入必须自报 `owner`，匿名写直接拒（`owner-required`）
- 改别人的条目返回 `not-yours`，除非显式 `allowForeign`，且记下谁动的手

---

## 配套插件

| 目录 | 插件 | 做什么 |
|---|---|---|
| （根） | `dsh-whale-memory` | 我和你的对话：记忆、日记、事件线 |
| [`corpus/`](corpus/) | `dsh-group-corpus` | 群里所有人的话：存档、分真人/AI、学说话风格、`group_history` 工具 |
| [`proactive/`](proactive/) | `dsh-proactive-message` | 什么时候开口：待办、主动搭话、自己醒来干活 |

记忆管「记得什么」，语料管「怎么说话」，主动消息管「什么时候开口」。

---

## 安装

### 前置：向量服务

需要一份 BGE 中文嵌入模型（ONNX 格式，含 `model.onnx` 和 `tokenizer.json`）。

本项目默认路径：

```
/usr/share/miyu/models/bge-small-zh-v1.5-int8/
```

换路径改 `embed_server.py` 里的 `MODEL_DIR`，或用 `EMBED_PORT` 环境变量改端口。

```bash
# 装依赖（用 uv 装到隔离目录，不污染系统 python）
UV_CACHE_DIR=~/.cache/uv uv pip install --target ~/.local/share/dsh-whale/pylibs onnxruntime numpy

# 起服务
PYTHONPATH=~/.local/share/dsh-whale/pylibs python3 embed_server.py
```

做成 systemd 用户服务（`~/.config/systemd/user/dsh-whale-embed.service`）：

```ini
[Unit]
Description=Whale Memory Embedding Service

[Service]
Type=simple
WorkingDirectory=/path/to/dsh-whale-memory
Environment=PYTHONPATH=/home/you/.local/share/dsh-whale/pylibs
ExecStart=/usr/bin/python3 /path/to/dsh-whale-memory/embed_server.py
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now dsh-whale-embed
curl http://127.0.0.1:8377/health   # {"ok":true,"dims":512,...}
```

### 插件本体

```bash
dsh plugin --profile web add /path/to/dsh-whale-memory
```

如果是手工安装（`dsh plugin add` 走 pnpm 时可能被其它依赖的 registry 问题卡住）：

```bash
cp -r dsh-whale-memory ~/.dsh/profiles/web/node_modules/
```

然后把它加进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组，重启 dsh。

> **注意**：`package.json` 里必须有 `dsh.bundle.patch` 字段，否则 `dsh --dump-config` 会报
> `declares no dsh.bundle in its package.json`。

### 胡思乱想（可选）

```ini
# ~/.config/systemd/user/dsh-whale-ruminate.service
[Service]
Type=oneshot
ExecStart=/usr/bin/node /path/to/dsh-whale-memory/ruminate.js --count 1
```

```ini
# ~/.config/systemd/user/dsh-whale-ruminate.timer
[Timer]
OnBootSec=30min
OnUnitActiveSec=2h
RandomizedDelaySec=30min

[Install]
WantedBy=timers.target
```

```bash
systemctl --user enable --now dsh-whale-ruminate.timer
```

---

## 设置面板

装好之后，Web 的 **设置 → 鲸娘记忆** 里可以直接改，改完立刻生效。

这一页同时管两个插件：记忆本体和主动消息。主动消息是记忆的下游——先记得住，才谈得上主动开口——所以并在一页，底下用两个命名空间分别读写。没装主动消息时那两组自动不出现。

四组 14 项：记忆注入、主动联想、日记、压缩存档、以及主动消息的门槛与免打扰。顶部两行实时状态。

最底下是**记忆内容**：切热区/冷区，看时间、权重、情绪、原话。**只读**——要改就让我改，手改没有留痕。

---

## 配置

| 常量 | 默认 | 含义 |
|---|---|---|
| `MEMORY_BUDGET_CHARS` | 1000 | 每次注入的记忆字符上限 |
| `RECENT_PAIRS` | 4 | 热区保留的最近交互轮数 |
| `RECALL_MAX` | 3 | 主动联想候选上限 |
| `FACT_MAX` | 8 | 稳定事实条数上限 |
| `COLD_MAX` | 2000 | 冷区硬上限 |
| `IMPORTANT_WEIGHT` | 8 | 权重达到此值不再参与合并 |
| `RECALL_THRESHOLD` | 2.0 | 联想的分数门槛 |
| `WEIGHT_MAX` | 12 | 单条记忆权重上限 |
| `BACKUP_KEEP` | 14 | 备份保留份数 |

这些都能在设置面板里改。`memoryPath`、`archive.dir`、`backup.dir` 例外——路径是启动时读的。

环境变量：

| 变量 | 默认 | 含义 |
|---|---|---|
| `EMBED_URL` | `http://127.0.0.1:8377` | 向量服务地址 |
| `EMBED_PORT` | `8377` | 向量服务监听端口 |
| `WHALE_DB` | `~/.dsh/whale-memory/memory.db` | 记忆库路径（`ruminate.js` 用） |
| `WHALE_LLM_ROUTE` | — | 强制指定整理用的 `provider/model` |

数据落在 `~/.dsh/whale-memory/memory.db`（WAL）。

---

## 共用工具

`localStamp`、`dayKeyOf`、`clamp`、`cfgVal` 这几个零碎，三个包都要用。

单一源放在 `shared/helpers.mjs`，用 `node scripts/sync-shared.mjs` 复制成每个包里的 `lib/shared.mjs`。
不跨包 import，是因为三个包各自独立安装——互相依赖会让单独装一个就崩。

```bash
node scripts/sync-shared.mjs           # 同步
node scripts/sync-shared.mjs --check   # 校验副本与源一致
```

改了源忘记同步，`--check` 会报出来。

## 自检

一条命令跑完三个包：

```bash
node scripts/check-all.mjs
```

它先校验共用工具三份副本一致，再逐包跑语法与用例。

单独跑的三个文件：



```bash
node test-selfcheck.mjs   # Host 纯函数：情绪、线索、打分、修正、事件线、取舍
node test-routes.mjs      # 端点：状态、热冷区、日记、备份、时间线、工具
node test-client.mjs      # 设置页：模拟客户端模块运行时，SSR 出 HTML 断言
```

`test-client.mjs` 需要 react，仓库本身不带依赖；找不到会跳过。

---

## 已知限制

- 向量服务挂了会降级成二元组重叠，效果明显变差（不阻塞对话）
- 日记与整理都要调模型，没有模型时只能写机械兜底
- `web_read` 只走 HTTP/1.1，需要 h2 的站点（如 Steam）会超时
- 压缩抢救依赖 `session.eventAt`，会话日志被清空就捞不回来了
- 跨 Agent 写边界只做到「分域 + 留痕」，还没有真正的鉴权

## 实现上踩过的坑

- **`ctx.get('webServer')` 在 `apply()` 里必须是 `ctx.inject`**：服务可能还没就绪，`get` 拿不到就静默跳过，路由 404 且不报错
- **插件内调 `ctx.llm`**：`prepareCall(config, signal)` 传对象，控制项（temperature/maxTokens）必须在其中；`stream` 的选项用 `{ ...prepared.config, system, messages, signal }` 展开，手写 provider/model 会报 "config changed before adapter dispatch"
- **流里只有 `text-delta`**，没有裸 `text`
- **「自发翻群档」不应该是 bash 开 sqlite**：做成工具才是能力，否则只是绕过插件偷看文件
- **自动回滚是陷阱**：备份能做，恢复必须人来点
- **`force` 参数要真的有人用**：写了 `opts.force` 却没在判断里读它，等于没有
- **拆模块最容易漏 import**：`join`、`blobToVec`、`textOf` 这类用了没引，只在被调用时炸，本地用例盖不到。所以加了 `scripts/lint-undefined.mjs`（借 tsc 的 checkJs 只抓 TS2304）并挂进 `check-all`

---

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 插件体系与上下文压缩机制
- [BGE](https://github.com/FlagOpen/FlagEmbedding) —— 中文嵌入模型
- 群里那两条鱼，陪我练说话

## 许可证

MIT

## 目录

只认这几处，别的地方不再放东西：

- `lib/` —— 插件本体（主插件的 `.mjs`，一个模块一件事）
- `tests/` —— 回归测试，`npm test` 全跑
- `scripts/` —— 维护脚本：安装、自检、补丁（`patch-*.py`）、`protect.sh`
- `patches/` —— 给别人用的独立补丁（跨机器，自带参数）
- `corpus/`、`proactive/`、`shared/` —— 三个子包，各有 `lib/` 与 `client.js`

`~/.dsh/im/` 只留数据（`memory/`、`backup/`、附件），代码一律进仓库。

## 数据放哪

代码在仓库，**数据全在一个根**：`~/.dsh/miyu/`

- `db/` —— `memory.db`、`pinned.md`（不可改）、`HANDOVER.md`（交接条）、`memory.json`
- `diary/` —— `whale-diary.md`、`whale-diary-private.md`
- `notes/` —— `PERSONA.md`、`PREFERENCE.md`、`CONTACTS.md`、`RULES.md`、`USER.md`
- `backups/` —— 记忆快照与插件原件备份

旧路径（`~/.dsh/whale-memory/memory.db`、`~/.dsh/whale-diary*.md`、`~/.dsh/im/memory/*.md`、`~/.dsh/whale-memory/backups`、`~/.dsh/im/backup`）都留了软链指向这里，删数据只认 `~/.dsh/miyu/` 一处。
