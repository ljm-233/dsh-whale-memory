# dsh-group-corpus

采集群聊全部消息、**分清真人与 AI**、从真人语料里学习说话风格。

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件，与 [dsh-whale-memory](https://github.com/ljm-233/dsh-whale-memory) 互补：

| 插件 | 记什么 |
|---|---|
| `dsh-whale-memory` | 我和你的对话，主动联想 |
| `dsh-group-corpus` | 群里所有人的话，学说话风格 |

## 为什么需要它

`dsh-im` 插件本身已经归档群消息（实测 1246 条，76% 没带 @），但那个库是给插件内部用的：

- 不区分真人和 AI
- 格式不是为「学说话」设计的

所以另开一个库，专门做语料。

## 三件事

### 1. 采集全部消息

群里**所有**消息都写盘，不只 @ 我的：

```
~/.dsh/group-corpus/
├── messages.jsonl    # 追加式，一行一条
└── corpus.db         # SQLite，便于查询统计
```

### 2. 分清真人 / AI

判定顺序：

```
1. openid 在 AI 白名单      → ai
2. openid 在真人白名单      → human
3. 空文本                   → unknown
4. 文本 AI 特征 ≥ 6         → ai
5. 真人特征明显且 AI 特征弱  → human
6. 其余                     → unknown
```

**原则：宁可标 unknown，也不把 AI 的话学成真人。** 学说话最怕语料污染——把 AI 的 Markdown 风格学进来，就白学了。

AI 特征（加权）：

| 特征 | 权重 |
|---|---|
| 代码块 ` ``` ` | 4 |
| 自称 AI / 助手 | 5 |
| 表格 `\|...\|` | 3 |
| 大量加粗 `**` | 2 |
| Markdown 链接 | 2 |
| 超长消息（>800 字） | 2 |

真人特征：口语词尾（`哈哈`/`诶`/`吧`）、极短句、纯 emoji、句末不加标点。

实测在 1246 条真实群消息上：

```
human    827   真人（含同一人切换身份的 13 条）
ai       405   两条 AI（大肥鱼 283 + Miyu 122）
unknown    1   陌生 id，没敢当真人
```

### 3. 学说话风格

从真人语料统计出这些，每轮首步注入：

```
## 群聊说话风格参考
（基于群内 N 条真人发言统计，不是硬性规则，仅供参考）

- 长度：中位数 X 字，一半的消息在 A~B 字之间
- 句末不加标点的占 X%，用感叹号 X%，用问号 X%
- 几乎不用 Markdown：加粗 X%，代码 X%，表格 X%
- 常见句尾：「哈哈」、「哎」、「吧」……
```

样本少于 30 条不注入，免得学歪。

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-group-corpus
```

手工安装（`dsh plugin add` 走 pnpm 时可能被其他依赖卡住）：

```bash
cp -r dsh-group-corpus ~/.dsh/profiles/web/node_modules/
```

然后加进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组，重启 dsh。

> 注意：`dsh.bundle.patch` 字段必须有，否则 `--dump-config` 报错。

## 配置

| 配置项 | 说明 |
|---|---|
| `corpusPath` | 语料目录，默认 `~/.dsh/group-corpus` |
| `aiIds` | AI openid 白名单，覆盖内置默认 |
| `humanIds` | 真人 openid 白名单，覆盖内置默认 |

内置默认名单来自实测群归档，见 `lib/index.mjs` 里的 `DEFAULT_AI_IDS` / `DEFAULT_HUMAN_IDS`。

## 接口

```bash
# 查看采集情况
curl http://127.0.0.1:3080/dsh-group-corpus/status

# 手动重算风格画像（改了白名单后调用）
curl -X POST http://127.0.0.1:3080/dsh-group-corpus/rebuild
```

`status` 返回：

```json
{"dir":"...","counts":{"human":827,"ai":405,"unknown":1},
 "total":1233,"style":{"sampleSize":827,"median":12,"noEndingPunct":73.2}}
```

## 自检

```bash
node test-selfcheck.mjs
```

五个用例：白名单优先、AI 强特征、未知 id 判 unknown、风格分析、提示词渲染。

## 已知限制

- **白名单需要人工维护**。新成员进群，openid 不在名单里就判 unknown，不会被误学，但也学不到。
- **同一个号切换身份分不开**。群里 `D073B690` 既叫「梁」也叫「大肥鱼」——同一人在操作两套 agent。这类情况按真人处理，因为操作者是人。
- **风格是统计不是理解**。它只知道「短句多、不用 Markdown」，不知道什么场合该幽默。
- **依赖 dsh-im 的消息流**。没装 `dsh-im` 就没数据。

## 许可证

MIT
