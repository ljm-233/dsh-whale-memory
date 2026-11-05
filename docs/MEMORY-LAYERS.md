# 记忆四层

一份记忆要能「随时可用」，也要能「事后翻得到」。这四层各管一件事，谁也不替谁。

| 层 | 名字 | 干什么 | 落在哪 | 谁在跑 |
| --- | --- | --- | --- | --- |
| 一 | 实时会话 | 每轮开口前把记忆卡塞进上下文 | 无文件（内存 + `memory.db` 查询） | `lib/index.mjs` 注入链 |
| 二 | 自动落盘 | 群聊增量导成按天的人读日志 | `~/.dsh/miyu/logs/全量-YYYY-MM-DD.md` + `logs/.last-id` | `scripts/dump-group.mjs` + `dsh-group-dump.timer` |
| 三 | 周记 | 一周拢一份：几天、多少条、谁话多、我干了啥 | `~/.dsh/miyu/diary/周记-YYYY-Www.md` | `scripts/weekly-digest.mjs`（手动/自定 timer） |
| 四 | 全量 | 真正可查的底账：条目、事实、证据、向量 | `~/.dsh/whale-memory/memory.db` | 插件本体（`lib/*`）、`ruminate.js`、`scripts/memory-tidy.mjs` |

## 一、实时会话（每轮）

- 入口：DSH 每轮把记忆卡注入上下文，条数与长度由设置页「记忆注入 / 主动联想 / 冷热分层」控制。
- 相关命令：无独立脚本；改设置页即生效（`volatile` 字段下一轮就读到）。

## 二、自动落盘（每 10 分钟）

- 命令：`node scripts/dump-group.mjs`（可加 `--config <file.json>` 换一份配置）
- 数据源：`~/.dsh/integrations/dsh-im/group-history.sqlite`，**只读**打开（`readOnly` / 退路 `PRAGMA query_only`）。
- 游标：`messages.rowid` 存在 `logs/.last-id`。`messages.id` 是 uuid 文本，**不能当游标**。
- 行格式：`HH:MM:SS 昵称：正文`；正文里的换行压成 `↵`，空正文写 `（空）`，缺昵称写 `（未知）`。
- 分文件：按本地日期（Asia/Shanghai，固定 +08:00）`全量-YYYY-MM-DD.md`。
- 首次运行只导当天，不回溯历史；重复跑不重复写；退出码永远 0（错误留 journal）。
- systemd：
  - `scripts/systemd/dsh-group-dump.service.tpl`
  - `scripts/systemd/dsh-group-dump.timer.tpl`（`OnBootSec=3min`、`OnUnitActiveSec=__INTERVAL_MIN__min`、`Persistent=true`）
  - 占位符：`__HOME__`、`__NODE__`、`__INTERVAL_MIN__`
- 安装：`node scripts/install-local.mjs --with-group-dump`
  （渲染到 `~/.config/systemd/user/`，再 `systemctl --user daemon-reload && systemctl --user enable --now dsh-group-dump.timer`）
  **不加这个开关，安装流程与以前完全一样，一个字都不碰 systemd。**
- 只看渲染结果：`node scripts/install-local.mjs --render-units /tmp/x [--config cfg.yml]`

## 三、周记（一周一份）

- 命令：`node scripts/weekly-digest.mjs [--week 2026-W45] [--base <miyu 根>] [--config <file>]`
- 输入：第二层的 `全量-YYYY-MM-DD.md`、`diary/whale-diary.md`、`db/LEDGER.md`
- 输出：`diary/周记-YYYY-Www.md`（同日重跑覆盖，同一个输入永远同一个文件）
- 四块内容：本周几天（有档几天 / 写日记几天）、每天多少条、谁说得最多（前十，带百分比）、我在这周里做了什么（活账本该周的日期行）。
- **不调 LLM**，只做统计与摘录：可复现、零成本、不会记错。
- 周起点由 `weekly.startDay` 决定（1=周一 … 7=周日）；`--week` 显式指定时按 ISO 周走，忽略起算日。

## 四、全量（底账）

- `memory.db`：`entries`（结论）+ `entry_evidence`（原始出处）+ 事实表 + FTS + 向量列。
- 相关命令：
  - `node scripts/memory-tidy.mjs` 补向量、抬/压热区（会先强制备份）
  - `node ruminate.js` 定期联想
  - `node scripts/export-memory.mjs` 导出人读副本
  - 备份：`lib/backup.mjs`（`VACUUM INTO` + 当场校验 + 轮转），**没有单独的命令行**——
    插件内每 6 小时自查一次要不要备，`node scripts/memory-tidy.mjs` 真跑之前也会强制备一份；
    想立刻备一份：`curl -X POST http://127.0.0.1:3080/dsh-whale-memory/backups`（同地址 GET 看现有几份、放在哪）

## 设置项（设置页「鲸娘记忆 → 自动落盘 / 周记」）

脚本和设置页读同一份配置：`scripts/dump-group.mjs` 与 `scripts/weekly-digest.mjs` 都调
`lib/dump-config.mjs` 的 `loadLayerConfig()`。**默认值只有一处**：`LAYER_DEFAULTS`（同在 `lib/dump-config.mjs`）。
设置页那一侧不再自带第二份——`lib/index.mjs` 的 zod schema 写的是 `.default(LAYER_DEFAULTS.*)`，
`client.js` 的表单里这几项没有 `fallback`（值全由 schema 给），所以「设置页显示的默认值」「脚本读到的默认值」
「渲染 timer 用的默认值」不可能各说各话。

| 键名 | 控件 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `groupDump.enabled` | 自动落盘（开关） | `true` | 关掉时脚本打印一行「已关闭」并 exit 0，不写任何文件 |
| `groupDump.intervalMinutes` | 落盘间隔（分钟） | `10` | 1–1440；**只影响渲染出来的 timer**，脚本本身不管间隔 |
| `groupDump.dir` | 导出目录（文本） | `~/.dsh/miyu/logs` | 绝对路径或 `~/...`；周记的 diary/db 取它的上一级 |
| `weekly.enabled` | 周记（开关） | `true` | 关掉时打印「已关闭」并 exit 0 |
| `weekly.startDay` | 周记起始日 | `1`（周一） | 1=周一 … 7=周日 |

配置来源与优先级：

1. `--config <file>`：`.json` 按 JSON 读，其余按 yml 读（测试/换机器用）
2. 活动 profile 的 `cordis.patch.yml` 里 `- id: dsh-whale-memory` 那段 `config:`
3. `LAYER_DEFAULTS`（`lib/dump-config.mjs`）

生效方式：

- 脚本每次启动读一次配置 → **下一次 timer 触发时生效**，不用重启 dsh。
- `groupDump.dir` 改了：下一轮就写到新目录（旧目录里的 `.last-id` 不跟过去，新目录按「首次只导当天」重新起算）。
- `groupDump.intervalMinutes` 改了：重跑 `node scripts/install-local.mjs --with-group-dump`
  （或只 `--render-units ~/.config/systemd/user` + `systemctl --user daemon-reload`）才换掉 timer 的间隔。
- 环境变量：`MIYU_BASE`（配置里没显式写 dir 时顶替成 `$MIYU_BASE/logs`）、`DSH_GROUP_DB`（换数据源）。只给测试/迁移用。
