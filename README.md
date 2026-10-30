# dsh-whale-memory

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**主动记忆**插件。

不是「用户提线索才去捞」的检索器——它会察觉情绪，主动想起相关旧事；闲着的时候还会自己胡思乱想，把念头也存进记忆。

```
最近几轮的对话：
用户: 今天好累 → 你: 怎么个累法？

主动想起的相关旧事（因情绪(tired)相关而取用）：
1. 〔印象深刻〕用户: 最近天天加班，累死了 → 你: 辛苦了
```


## 配套插件：dsh-group-corpus

本仓库的 [`corpus/`](corpus/) 目录是独立插件，采集群聊全部消息、分清真人与 AI、学习真人说话风格。

| 插件 | 记什么 |
|---|---|
| `dsh-whale-memory`（本插件） | 我和你的对话，主动联想 |
| `dsh-group-corpus` | 群里所有人的话，学说话风格 |

两者互补：前者记「你和我」，后者记「整个群」。

---


## 配套插件

| 目录 | 插件 | 做什么 |
|---|---|---|
| （根） | `dsh-whale-memory` | 我和你的对话，主动联想、自己梳理 |
| [`corpus/`](corpus/) | `dsh-group-corpus` | 群里所有人的话，学说话风格 |
| [`proactive/`](proactive/) | `dsh-proactive-message` | **主动发消息**，沉默久了会来找你 |

三者互补：记忆管「记得什么」，语料管「怎么说话」，主动消息管「什么时候开口」。

---

## 它和别的记忆插件有什么不同

大多数记忆插件的逻辑是：**用户提到线索 → 检索 → 注入**。本质是个检索器。

这个插件的逻辑是：

1. **情绪驱动**：识别五类情绪（累 / 难过 / 气 / 开心 / 焦虑），情绪吻合的记忆强加权
2. **主动联想**：真向量余弦 + 情绪 + 累积权重 + 新近度综合打分，**不等用户给线索**
3. **记忆合并**：低权重的按相似度压成摘要，高权重（≥ 8）原地不动——像人一样遗忘，但记住印象深的
4. **胡思乱想**：定时器拉起，随机挑冷区记忆做向量配对，生出联想写回库中，加噪声

## 三个技术选择

| 项 | 选择 | 理由 |
|---|---|---|
| 存储 | `node:sqlite`（Node 26 内置） | 零依赖，向量存 Float32 BLOB，单机够用 |
| 向量 | 本地 BGE-small-zh-v1.5 int8 ONNX | 24MB，512 维，中文专用，离线运行 |
| 后台 | systemd timer（非常驻进程） | 只在触发时算，几乎零开销 |

向量服务不可用时**自动降级**到字符二元组重叠度，绝不阻塞对话。

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


## 自己梳理记忆

除了「胡思乱想」（生成联想噪声），插件每 6 小时会自己梳理一次记忆。

和 `ruminate.js` 的区别：

| | ruminate | consolidate |
|---|---|---|
| 做什么 | 随机配对，生成联想 | 读一批记忆，判断怎么整理 |
| 需要模型吗 | 不需要，纯向量 | **需要**，判断要靠语言理解 |
| 结果 | 加噪声 | 合并重复、删空壳、提炼规律 |

梳理时会：

1. 取 20 条冷区记忆（排除联想条目和已有的规律）
2. 交给模型判断：哪些该合并、哪些该删、能看出什么规律
3. 按判断改库；新规律标 `（规律）` 前缀，权重 3

**模型不可用时自动退回纯向量合并**（只合余弦 > 0.85 的，删掉内容少于 3 字的空壳）。

手动触发：

```bash
# 只看模型建议，不动库
curl -X POST http://127.0.0.1:3080/dsh-whale-memory/consolidate \
  -H 'content-type: application/json' -d '{"dry":true}'

# 真执行
curl -X POST http://127.0.0.1:3080/dsh-whale-memory/consolidate \
  -H 'content-type: application/json' -d '{}'
```

模型路由默认从 `WHALE_LLM_ROUTE` 环境变量读（格式 `provider/model`），没设则退回向量合并。

---


## 单向同步：私聊能看到群里在聊什么

群聊和私聊在 DSH 里是**两个 session**（`group:<openid>` 和 `c2c:<openid>`），
私聊时看不到群里刚发生什么。

`group-digest.js` 从语料里生成一份近期群聊摘要，写到
`~/.dsh/whale-memory/group-digest.json`。whale-memory 在**私聊会话**注入时读它：

```
群里最近在聊（2 人，仅供了解，不必主动接话）：
梁: 交给千问了
ljm_QvQ: 你就不能接入自己的api吗
...
```

**方向是单向的**：群 → 私聊。私聊的内容不会回流到群聊会话。

判定私聊靠 `isPrivateSession()`：读 `integrations/dsh-qq/bots/<botId>/state.json`
的会话映射，只有 `c2c:` 开头的才注入。群聊会话本来就在群里，不重复注入。

摘要超过 12 小时不注入——免得说「刚才群里」其实是一天前的。

生成摘要（可放进 timer）：

```bash
node group-digest.js --hours 24
```

---


## 每天自己写一篇日记

这是「连续性」那一块。

人不用被问起才想起昨天，因为昨天一直在。而这个插件的大部分时间里，它只在被叫到时才存在——中间那几小时、几天，对它来说是空的。

所以设了个定时器：每天过了设定时间（默认 22 点），当天还没写就补一篇。素材是当天记下的对话、群里真人说的话、以及上一篇日记。写出来是第一人称的一小段，100–150 字，不是流水账。

写完存进 `diary` 表（一天一篇，重复写会覆盖）。上下文里会注入最近两篇——不为了回忆细节，只为了让「昨天我也在」这件事成立。

模型不可用时退回机械兜底（今天说了几句、记了几段），**宁可少写也不编**。

```bash
# 看看写过什么
curl 'http://127.0.0.1:3080/dsh-whale-memory/diary?limit=10'
# 手动补写（测试用，会覆盖当天）
curl -X POST -H 'content-type: application/json' -d '{}' \
     http://127.0.0.1:3080/dsh-whale-memory/diary
```

设置页里可以关掉自动写，或者改几点之后写。

---

## 压缩前抢救：把被压掉的历史变成深度记忆

上下文压缩会把旧对话换成一句摘要，而摘要本身还会被再次压缩——**信息就这样一层层衰减掉**。

这个插件在压缩发生的那一刻做一件事：把即将被压掉的原话取出来，蒸馏成记忆写进冷区。

```
compaction/summary 事件带 shadowedSeqs（被替换的节点序号）
        ↓
session.eventAt(seq) 从日志取回原文（压缩只是从上下文移走，日志不删）
        ↓
每 8 轮对话蒸馏成一句话
        ↓
存进冷区，标记「（归档）」，权重 2
```

效果：**忘掉的是具体对话，留下的是那件事。** 像人一样——记不清某天聊了哪些字，但记得那天在做什么。

蒸馏优先用模型（一句话概括「用户在这段时间做了什么」），模型不可用时退回机械摘要（轮数 + 起始内容）。

这些归档记忆和普通记忆走同一套召回：情绪吻合、向量相似、线索命中，被想起时权重累加。所以真正重要的事会越压越深。

### 顺便存一份完整存档

光有「一句话」不够——有时候你想回头看看原文到底说了什么。所以压缩发生时，还会额外写一份完整的 Markdown：

```
~/.dsh/whale-memory/archives/20261030-173322-<会话>.md
```

内容是压缩摘要 + 那段被压掉的完整对话（不截断）。同时**复制一份私发给主人**：

- 优先用配置里的 `archive.botId` / `archive.targetId`；
- 没配就自动找机器人下的第一个单聊目标，不用把 openid 写进公开配置；
- 私发按 1200 字分段，最多 6 段；超出的部分不硬塞，末尾注明本地文件路径。

落盘是主路径，私发只是附带——发不出去也不影响存档。

---

## 设置面板

装好之后，Web 的 **设置 → 鲸娘记忆** 里可以直接改参数，改完立刻生效——不用重启，也不用碰配置文件。

这一页同时管两个插件：记忆本体（`dsh-whale-memory`）和主动消息（`dsh-proactive-message`）。主动消息是记忆的下游——先记得住，才谈得上主动开口——所以并在一页里，底下用两个命名空间分别读写。没装主动消息插件的话，那两组自动不出现。

实现上没另开存储：页面走 DSH 自己的设置服务（`ctx.configForms.get('dsh-whale-memory')`），写入落在活动 profile 的 cordis patch，插件里 `config.xxx.get()` 立刻读到新值。也就是说面板只是配置的一面镜子。

页面上还有一行实时状态：热区/冷区条数、向量服务是否正常、想起过几次、抢救过几次。

最底下是**记忆内容**：可以在热区和冷区之间切换，看一眼到底存了什么（时间、权重、情绪、原话）。

**只读。**这个区只有文字和两个切换按钮，没有任何写入口——`/dsh-whale-memory/entries` 也只接受 GET，其他动词一律 405。记忆内容怎么变是插件自己的事（权重靠被想起累积、冷热靠预算调度），不该由设置页手动改。

两个自检：

```bash
node test-selfcheck.mjs   # Host 半部的纯函数
node test-routes.mjs      # 两条只读端点（含 entries 只接受 GET）
node test-client.mjs      # 设置页（模拟客户端模块运行时，SSR 出 HTML 来断言）
```

`test-client.mjs` 需要 react，仓库本身不带依赖；找不到会跳过，装了 DSH 的环境里才有。

---

## 配置

| 常量 | 默认 | 含义 |
|---|---|---|
| `MEMORY_BUDGET_CHARS` | 1600 | 每次注入的记忆字符上限 |
| `RECENT_PAIRS` | 6 | 热区保留的最近交互轮数 |
| `RECALL_MAX` | 3 | 主动联想候选上限 |
| `FACT_MAX` | 8 | 稳定事实条数上限 |
| `COLD_MAX` | 2000 | 冷区硬上限 |
| `IMPORTANT_WEIGHT` | 8 | 权重达到此值不再参与合并 |
| `RECALL_THRESHOLD` | 2.0 | 联想的分数门槛 |
| `WEIGHT_MAX` | 12 | 单条记忆权重上限（防止被反复想起的条目垄断回忆位） |
| `IM_PART_CHARS` | 1200 | 压缩存档私发时单条消息字数 |
| `IM_MAX_PARTS` | 6 | 压缩存档私发最多几条 |

压缩存档可以关掉：

```yaml
- id: dsh-whale-memory
  config:
    archive:
      enabled: false          # 连存档都不写
      notify: false           # 只落盘，不私发
      dir: archives           # 相对记忆目录
      botId: qq_xxxxxxxx      # 不填就自动找
      targetId: tgt_xxxxxxxx  # 不填就自动找单聊目标
```

上表是**默认值**。这些参数在设置面板里都能改，改了不用重启。
`memoryPath` 和 `archive.dir` 例外——路径是启动时读的，改了要重启。

环境变量：

| 变量 | 默认 | 含义 |
|---|---|---|
| `EMBED_URL` | `http://127.0.0.1:8377` | 向量服务地址 |
| `EMBED_PORT` | `8377` | 向量服务监听端口 |
| `WHALE_DB` | `~/.dsh/whale-memory/memory.db` | 记忆库路径（`ruminate.js` 用） |

数据落在 `~/.dsh/whale-memory/memory.db`（SQLite，WAL 模式）。

## 自检

```bash
node test-selfcheck.mjs        # 十个纯函数用例，不需要向量服务
curl http://127.0.0.1:3080/dsh-whale-memory/status
```

状态端点返回：

```json
{"dbPath":"...","hot":0,"cold":4,"facts":0,"important":0,
 "embedOk":true,"embedUrl":"http://127.0.0.1:8377",
 "stats":{"merged":0,"recalled":1,"ruminated":1},"budgetChars":1600}
```

`embedOk: false` 表示向量服务挂了，插件会自动降级到二元组重叠，功能不中断。

## 已知限制

- **没有真 PG**。SQLite 足够单机场景；多用户并发或多机共享才需要 PG。
- **胡思乱想不是真正的「空闲时」**。它是 timer 每 2 小时跑一次，不是随时随地在想。
- **情绪识别靠词表**，不是模型。隐晦的表达会漏。
- **联想质量取决于记忆量**。冷区只有三四条时，配对出来的念头往往很牵强。
- **向量服务独立于插件**。插件只调 HTTP，服务挂了会降级但不报错。

## 实现上踩过的坑

写这个插件时遇到三个值得记下的问题：

**1. `ctx.get('webServer')` 在 `apply()` 里拿不到服务**

```js
// 错：服务可能还没就绪，拿到 undefined，整块 if 静默跳过
const webServer = ctx.get('webServer')
if (webServer !== undefined) { /* 永远不执行 */ }

// 对：等依赖就绪再回调
ctx.inject(['webServer'], (webCtx) => {
  webCtx.effect(() => webCtx.webServer.register({...}), '...')
})
```

**2. BERT 分词必须逐字切 CJK**

`BertPreTokenizer` 的规则是给每个中日韩字符单独成 token。按空格切词会让整段中文变成 `[UNK]`，向量退化成常量噪声——**相似的无关句子反而得分更高**。

**3. 中文里硬切 n-gram 会切出半截词**

「最近天天加班」用 3~5 字窗口切，会得到「近天天」这种不是词的碎片。做实体抽取时改成**整句取法**（按标点分句，去掉时间/人称前缀）反而更稳。

## 致谢

设计受这几个项目启发：

- [Companion-AI-Memory-Context-Token-Optimization](https://github.com/ARCHEON999/Companion-AI-Memory-Context-Token-Optimization) — 冷热分层与线索唤回的原始设计
- [dsh-layered-memory](https://github.com/JunNanLYS/dsh-layered-memory) — L0~L3 分层蒸馏
- [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) — 可组合的记忆来源与视图
- [miyu-agent](https://github.com/SHORiN-KiWATA/miyu-agent) — 模型与分词器的来源

## 许可证

MIT
