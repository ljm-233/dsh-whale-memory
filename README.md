# dsh-whale-memory

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的长期记忆插件。版本号只写在 `package.json`（`lib/constants.mjs` 读回来，`GET /dsh-whale-memory/status` 里看得到）。

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
| `dump-group.mjs` | 第二层：群聊增量导成 `全量-YYYY-MM-DD.md`（游标 `logs/.last-id`，重复跑不重复写；`--config <file>` 换一份配置） |
| `weekly-digest.mjs` | 第三层：拢一份周记到 `diary/周记-YYYY-Www.md`（只统计，不调 LLM；`--base <miyu 根>` 换目录） |
| `protect.sh` | 装完自动校验，失败 exit 1 |

`dump-group.mjs` 与 `weekly-digest.mjs` 之间的时间工具（东八区换算、`dateKey`、`flagValue`）在 `scripts/_localtime.mjs` 里，别再各抄一份。

## 设置页

「鲸娘记忆」分**五条页签**（一个区一页），页签条吸顶，当前页签高亮，点一下或按 `←/→` 切页，不刷新：

| 页签 | hash | 放什么 |
| --- | --- | --- |
| 它现在怎么想我 | `#tab=mood` | 状态条 + 只读预览（这一轮会带什么进上下文）+ 情绪那几道闸 |
| 记忆怎么收 | `#tab=memory` | 注入字符上限 / 空间 / 热区轮数 / 想起几条 / 落盘与周记 …… |
| 记忆内容 | `#tab=content` | 热区 / 冷区 / 场景 / 画像 / 图谱 / 空间（库里的东西，没设置项） |
| 怎么被叫醒 | `#tab=wake` | 主动消息（日上限、多久算安静）、免打扰、夜班 |
| 危险与诊断 | `#tab=diag` | 说话人覆盖率计数 + 备份按钮（常用）；公式、场景、调试开关在高级里 |

- **URL 可分享**：`#tab=memory` 这类地址直接打开就落在那一页（也认旧的区 id：`#tab=intake`）。
- **记住上次那一页**：`localStorage['whale-memory.settings.tab']`，存的区 id（`now|intake|content|wake|diag`）；hash 优先于它。
- **切页不丢输入**：五页全部渲染，非当前页只加 `hidden`（`display:none`），不卸载——没提交的草稿是行内组件的状态，卸载就没了。
- **状态条只在第一页顶部**；各页自己的计数写在自己页里（例如诊断页的 spk 覆盖率）。
- 页签条是半透明灰 + `backdrop-filter`，不写死主题色；只用 `kind:'select'` 等现有控件，没引任何 UI 库。
- 结构细节（页签 ↔ 区 ↔ 分组、切页三条通路、为什么「只隐藏不卸载」）见 [`docs/settings-page.md`](docs/settings-page.md)。

每页两层：**常用**直接摊开（每页 ≤14 项，就是最可能被改的那几项），其余全进**高级**（默认折叠）。

一行的样子只有三块，后缀只写「默认 X」或「已改」二选一：

```
注入字符上限（字）  整张记忆卡的硬预算        [4000]  默认 4000
```

单位在名称的括号里；更长的解释、配置路径、取值范围全在 `title` 里（悬停可见）。
顶部状态条四格：版本 · 条目（热/冷）· 今日注入 · 情绪；取不到数据写「—」，不写「?」。

除了 `memoryPath`（记忆库路径，改了要重启），都是 volatile，改完下一次读配置就生效。

「自动落盘 / 周记」那五项就是第二、三层脚本的开关与参数：

- `groupDump.enabled`（自动落盘）、`groupDump.dir`（导出目录，默认 `~/.dsh/miyu/logs`）——脚本下次启动就读到；
- `groupDump.intervalMinutes`（落盘间隔，1–1440）——**只影响渲染出来的 systemd timer**，改完要重跑 `node scripts/install-local.mjs --with-group-dump` 才换掉间隔；
- `weekly.enabled`（周记）、`weekly.startDay`（一周从周几算，1=周一 … 7=周日）。

这几项的默认值只有一份：`lib/dump-config.mjs` 的 `LAYER_DEFAULTS`。

**记忆内容**（`#tab=content`）是库里的东西，接口都在 `http://127.0.0.1:3080/dsh-whale-memory/` 下：
`status`、`entries`、`scenes`、`persona`、`graph`、`graph/entity`、`spaces`、`trend`、`timeline`、`conflicts`、`backups`。
其中 **图谱** 是「谁和谁总一起出现」的共现统计：`GET /graph?space=&limit=&sort=` 给实体（`name/count/lastHit/degree`）与边（`a/b/weight`），
`GET /graph/entity?name=&space=&limit=` 点进去看这个实体最近几条记忆（查不到 404）。

这一页的排法（每条记忆两行：摘要 / `空间 · 命中 · 最后想起 · 在哪一区`，`来源 / 重要度 / tier` 有值才占位、点开才补全；
热冷两段纯 CSS 占比条；空间下拉带条目数；场景标「今天触发过没有」；画像列事实原文；
图上方一行 `实体 N · 边 M · 本次画 K 条边`；每块都有「还没有 + 为什么」的空状态）见
[`docs/settings-page.md`](docs/settings-page.md) 第五节。`/entries` 为此多回了
`counts{hot,cold}` 与 `space/spk/imp/hits/tier/lastHit/hot` 七个字段（只加字段，老客户端不看也不坏）。
页面默认是**力导向关系图**（原生 SVG，可缩放 0.3×～4×、拖动平移、标签避让，零依赖），右上角可切「列表」。
算法、阈值（共现 ≥ 2 次才成边）、字段、交互键位见 `docs/GRAPH.md`。
场景那行「最近召回」来自 `entries.lastHit`（`memory_recall` 真把条目交回模型时写），没被召回过就写「还没被召回」。

## 环境

- Node 22+
- 本地嵌入服务：`http://127.0.0.1:8377`（BGE，512 维）。`embed_server.py` 自带一个；没有也不致命，只是向量那一路退化成关键词。
- SQLite 库默认在 `~/.dsh/whale-memory/memory.db`（`lib/constants.mjs` 的 `DEFAULT_MEMORY_DIR`），路径可用 `memoryPath` 改。

  ⚠️ 本机（妹妹那台）它是软链：`~/.dsh/whale-memory/memory.db` → `../../db/memory.db`，真文件落在 `~/.dsh/db/`。同一层还有四个同样的软链：`backups/`、`HANDOVER.md`、`pinned.md`、`memory.json`。**这是脆弱点**：重建记忆目录、换机器、从备份还原时先 `ls -l ~/.dsh/whale-memory/` 看清指向——软链断了不会报错，插件会对着一个新库重新建，旧账看着就像「没记过」。

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
