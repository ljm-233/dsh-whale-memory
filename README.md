# dsh-whale-memory

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**主动记忆**插件。

不是「用户提线索才去捞」的检索器——它会察觉情绪，主动想起相关旧事；闲着的时候还会自己胡思乱想，把念头也存进记忆。

```
最近几轮的对话：
用户: 今天好累 → 你: 怎么个累法？

主动想起的相关旧事（因情绪(tired)相关而取用）：
1. 〔印象深刻〕用户: 最近天天加班，累死了 → 你: 辛苦了
```

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

环境变量：

| 变量 | 默认 | 含义 |
|---|---|---|
| `EMBED_URL` | `http://127.0.0.1:8377` | 向量服务地址 |
| `EMBED_PORT` | `8377` | 向量服务监听端口 |
| `WHALE_DB` | `~/.dsh/whale-memory/memory.db` | 记忆库路径（`ruminate.js` 用） |

数据落在 `~/.dsh/whale-memory/memory.db`（SQLite，WAL 模式）。

## 自检

```bash
node test-selfcheck.mjs        # 七个纯函数用例，不需要向量服务
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
