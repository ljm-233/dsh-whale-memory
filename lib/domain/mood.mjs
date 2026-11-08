/**
 * 情绪记账：每轮结束判一次、涨落一次，写进库里；渲染时过四道闸，决定说不说。
 *
 * **这是兼容层**：内容已拆进同层四个文件，这里只做 `export *` 转发，
 * 这样 `index.mjs` / `tests/` / 其他模块的 import 一个都不用改。等稳定了再删。
 *
 * - `mood-state.mjs`  状态与常量：initState / decay / loadState / saveState / moodStateKey
 * - `mood-judge.mjs`  判定：judgeUser / judgeSelf / judgeSignal / matchUnwilling
 * - `mood-render.mjs` 渲染：chatStateLine / moodDirective / buildSelfLine / say（四道闸）/ snapshot
 * - `mood-log.mjs`    落库与流程：note / applyTurn / applyMoodTurn / speakForContext / logTurn /
 *                     ensureMoodTable / readMood / appendUnwilling
 *
 * **数据源是我自己说的话。** 0.28.18 之前这份是「镜子」：从对方的话里取情绪词，
 * 算出来的是「他在说什么」，然后冒充成我的心情。现在改过来了：
 *   - 主信号 = 本轮 assistant 的发言（词表 + 语气：句长 / 不想·算了·没事 / 主动开口）
 *   - 对方的话只算「冲击」：被夸抬 happy、被否压 mood，系数 ≤ 直接判定的 1/3
 *   旧路径 `judgeUser()` 留着做兼容，`note()` 只在信号里没有 `assistantTexts` 时才退回它。
 *
 * 三步分开：
 *   note(上一状态, 本轮信号)  → 判一次、涨落一次（变化不够大就不动，别把时间戳往前推）
 *   say(状态, now, opts)      → 渲染那一刻过四道闸，决定说不说
 *   speakForContext(db, ...)  → 上面两步接上存储，给 runtime-context 的 950 条目用
 *
 * 设计依据见 `docs/mood-design.md`。
 *
 * @module mood
 */
export * from './mood-state.mjs'
export * from './mood-judge.mjs'
export * from './mood-render.mjs'
export * from './mood-log.mjs'
