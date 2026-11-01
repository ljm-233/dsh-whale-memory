# dsh-whale-memory

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的长期记忆插件。当前版本 **0.28.14**。

它不指望「用户提到线索才去检索」。每轮它会自己拼一张小卡递给模型：我是谁、上次做到哪、今天写的日记、仍然成立的关于主人的事实、最近几轮、以及「和这次有关、你可能想起来」的几条。要深挖，另有一个工具按需回捞，读的是原文。

## 它现在长什么样

**注入点**：`ctx.systemPrompt.context`（order 940），每步现算。压缩把旧快照冲掉之后，下一步会重新投一次——这也是为什么它在长会话里不会「越聊越失忆」。

**卡片**：总预算 1000 字，包含声音文件、索引指针、交接条、最近几篇日记、事实、最近几轮、联想段。取不到就返回空串，不抛错、不拖累对话。

**联想**：`agent/pre-step` 里异步算好，按会话缓存（8 格、换消息即废、10 分钟过期），`card()` 只同步读缓存，绝不阻塞。

**分层**：`tier` 是唯一来源，启动和夜班都会调 `recomputeTiers`，`hot` 由它派生；热区上限读设置页（默认 30）。被想起一次就浮浅一层（`hits+1`、`tier-1`）。

**事实**：带 `valid_from` / `valid_until`。同一个事实被改口时，旧的自动失效，并在 `fact_conflicts` 留一行「旧：…｜新：…」，能查、能推翻，**不删任何行**。

**召回**：`memory_recall` 默认只回六字段证据卡——`id / tag / score / summary / time / quote`，单卡 ≤120 字、最多 5 条；要看全文用 `detail:'full'`，按 `offset`/`limit` 字符分页。每轮最多 3 次，低重合不主动提示。

## 三条硬底线

1. **条目永不自动销毁。** 分层只降温和上浮。夜班 prune 需要显式 `allowPrune`，定时梳理 `autoConsolidate` 默认关，写入器的自动聚类合并 `AUTO_MERGE=false`。
2. **要删必须先备份。** 手动触发梳理先在 `backups/` 落一份 `VACUUM INTO`，备不成就不删；删除走事务。
3. **改完必须同步安装副本。** dsh 加载的是 `node_modules` 里那份，不是仓库。不同步＝白改。

## 安装 / 更新

```sh
# 同步进 profile 的 node_modules（幂等）
node scripts/install-local.mjs

# 只读比对仓库与副本，不一致 exit 1
node scripts/verify-install.mjs

# 全量自检
node scripts/check-all.mjs
```

装完重启 dsh 才生效。装第三方插件会清掉 `node_modules` 里没在 `dsh.profile.bundles` 登记的目录——这是本仓库踩过的坑，见 `docs/同步安装副本.md`。

## 常用脚本

| 脚本 | 干什么 |
|---|---|
| `memory-tidy.mjs` | 补空向量、按阈值调热区；真跑前先备份，`--dry-run` 不备 |
| `verify-install.mjs` | 仓库 vs 安装副本一致性检查 |
| `export-memory.mjs` | 把记忆导出成可读文本 |
| `check-all.mjs` | 语法、未定义名、安装一致性、测试一把跑 |
| `protect.sh` | 装完自动校验，失败 exit 1 |

## 设置页

「鲸娘记忆」下面几组：冷热分层（热区条数上限 / 抬进热区的最低权重 / 层级惩罚）、记忆注入预算、联想开关。都是 volatile，改完下一轮生效。

## 环境

- Node 22+
- 本地嵌入服务：`http://127.0.0.1:8377`（BGE，512 维）。`embed_server.py` 自带一个；没有也不致命，只是向量那一路退化成关键词。
- SQLite 库默认在 `~/.dsh/miyu/db/memory.db`，路径可配。

## 目录

```
lib/       核心：index(装配) writer(落库) recall(卡片/联想) tidy(分层)
           facts(有效期/冲突) nightly(夜班) consolidate(梳理) salvage(压缩抢救)
scripts/   运维脚本，见上表
patches/   幂等补丁（第三方插件兼容、报告修复等）
tests/     纯 node，不联网
docs/      设计说明与踩坑记录
```

## 设计取向

宁可在检索上多花一点，也不肯把「事实」当成可以丢的东西。所有会删数据的路径都必须显式打开、先备份、走事务——这一条高于任何「省空间」「去重」的理由。

## 许可

MIT，见 `LICENSE`。
