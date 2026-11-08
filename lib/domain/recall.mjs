/**
 * 记忆卡：拼进 runtime-context 的那一份「我是谁 / 记得什么」。
 *
 * **这是兼容层**：内容已拆进同层四个文件，这里只做 `export *` 转发，
 * 这样 `index.mjs` / `tests/` / `scripts/probe-recall.mjs` 的 import 一个都不用改。
 *
 * - `recall-pool.mjs`  候选池：kwTermsOf / kwArmOf / coldPoolOf
 * - `recall-score.mjs` 打分：createScorer（rel/imp/time 三轴或 legacy）+ scoreCold
 * - `recall-assoc.mjs` 素材：联想段（异步 + 每 session 一格缓存）+ 声音/现在/索引/交接条
 * - `recall-card.mjs`  卡片：createRecall / card（三道闸 + 跨进程幂等）
 *
 * 分两层（原设计，不变）：
 * - 轻查询（声音/交接条/日记/事实/热区/群摘要）同步读 sqlite 和文件——每步组装都要现算，必须便宜。
 * - 重检索（「这一句在说什么」的语义联想）异步算一次，结果按 session 存一小格缓存，card() 只同步读。
 *
 * 为什么不把联想也塞进 card()：card 每步组装都被调一次（一轮 N 步就是 N 次），
 * 而联想要打一次本地嵌入服务、还要扫几百条冷区。放进 card = 同一件事一轮做 N 次；
 * 异步算一次 + 同步读缓存 = 一轮只付一次，且绝不 await、绝不阻塞对话。
 */
export * from './recall-pool.mjs'
export * from './recall-score.mjs'
export * from './recall-assoc.mjs'
export * from './recall-card.mjs'
