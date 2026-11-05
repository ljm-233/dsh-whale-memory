# 设置页结构（分页签）

最后一版：`#tab=` 四条页签，一个区一页。这里只写「结构在哪、改哪儿」——文案口径
（每项说明 ≤25 字、后缀只写「默认 X」/「已改」、单位进名称括号）见 `README.md`。

## 一、页签 ↔ 区 ↔ 分组

| 页签（hash） | 区 id | 组（`zone`） | 常用 / 高级 |
| --- | --- | --- | --- |
| 它现在怎么想我（`#tab=mood`） | `now` | 情绪记账 | 2 / 3 |
| 记忆怎么收（`#tab=memory`） | `intake` | 注入与空间 · 联想 · 冷热分层 · 入库取舍 · 落盘与周记 · 压缩存档 · 日记 | 8 / 14 |
| 怎么被叫醒（`#tab=wake`） | `wake` | 什么时候可以说话 · 免打扰 · 夜班 / 桌面页 | 2 / 7 |
| 危险与诊断（`#tab=diag`） | `diag` | 打分与调试（+ 三个按钮） | 1 / 6 |

- `ZONES`（`client.js` 顶部）= 页签表：`id`（now/intake/wake/diag，存 localStorage）、
  `slug`（mood/memory/wake/diag，进 hash）、`title`/`hint`/`long`。
- `GROUPS[].zone` 决定某组分到哪一页；没有 `zone` 的按 `intake` 算。
- `tier: 'core' | 'adv'` 决定常用/高级；**页签不搬字段，只分页**（后端字段一个没少）。

## 二、切页的三条通路

1. **点页签**：`setTab(zone.id)`，纯 React 状态，不整页刷新。
2. **键盘**：`←/→`（浏览器全局 keydown，正在 `input/textarea/select/contenteditable` 里敲字时不抢键）。
3. **地址栏**：`#tab=<slug>`。开局按 `hash > localStorage > 第一页` 的顺序认；
   `hashchange` 时跟过去（点别人分享的链接会切页）。

写回：`localStorage` 键固定 `whale-memory.settings.tab`，存区 id；地址栏用
`history.replaceState` 写成 `#tab=<slug>`——不用 `location.hash`，因为后者会去找同名锚点、把页面滚走。
`parseTabHash` / `tabOf` 都是纯函数，`__test` 里直接测。

## 三、非当前页：全部渲染，只加 `hidden`

四页**都挂在 DOM 里**，非当前页 `hidden` + 行内 `display:none`（两条一起写：UA 的
`[hidden]{display:none}` 打不过行内 `display:flex`，只写属性会看着没生效）。

为什么这么选：

- 一行设置的草稿（`draft` / `typing`）是 `Row` 的组件状态，卸载就回到旧值——切页丢字比切页慢更不能接受；
- 切回来是瞬时的，也不用重建图谱/记忆内容那些子树；
- `hidden` 顺带把它移出无障碍树：屏幕阅读器只读当前页，`role="tabpanel"` + `aria-labelledby` 成对。

代价：首屏 DOM 里四页的节点都在（静态 HTML 约 649 字，其中一页可见）。

## 四、页内自成一块的计数

- 状态条四格（版本 / 条目 / 今日注入 / 情绪）**只在第一页顶部**，不每页重复。
- 诊断页自己的那条：`说话人覆盖 N / M 条 · P%`（`/status` 的 `speaker`），常显、不用点开高级；
  更细的七行（打分公式 / 门槛 / 三轴调试 / 取舍影子 / 向量服务 / 运行位置）仍在诊断页的「高级」里。
- 记忆内容（热区/冷区/场景/画像/图谱/空间切换）跟着第一页走——它是「现状」，不是设置。
