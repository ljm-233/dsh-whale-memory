/**
 * 梳理里跟模型打交道的部分：拼提示词、调一次 LLM 取纯文本、用模型写画像。
 *
 * 只做「说」的事，不碰删改；写库与事务在 ./consolidate.mjs。
 */
import { listFacts } from '../core/facts.mjs'

/**
 * 梳理用的提示词：给一批记忆条目，让模型判断合并 / 删除 / 规律。
 *
 * @param {Array<{id:number,u:string,a:string}>} batch 冷区记忆
 * @returns {string} 提示词
 */
export function buildMergePrompt(batch) {
  const list = batch.map((e) => `[${e.id}] 用户: ${e.u}\n      你: ${e.a}`).join('\n\n')
  return `你在整理一个 AI 助手的长期记忆库。下面是一批记忆条目，每条有编号。

${list}

请判断怎么整理，只输出 JSON，不要解释：

{
  "merge": [{"ids": [3, 7], "into": "合并后的一句话", "reason": "为什么合并"}],
  "drop": [12, 15],
  "insight": "从这批记忆里总结出的关于用户的一条规律，没有就留空"
}

规则：
- merge：内容重复或高度相似的才合并
- drop：完全没有信息量的（纯问候、纯表情、单字回复）
- insight：只写能明确看出的规律，不要编
- 宁可少做，不要错做`
}

/**
 * 调一次模型，把流里的 text-delta 拼成整段返回；超时或调不通就抛错，由调用方降级。
 *
 * 接口用法（照 translator/src/deepseek.ts）：
 *   prepareCall(config, signal) —— 传对象，不是 (provider, model, signal)
 *   stream({ ...prepared.config, system, messages, signal })
 * 用 prepared.config 展开而不是手写 provider/model，否则 INVALID_PREPARED_CALL。
 * 控制项（temperature/maxTokens）必须在 prepareCall 的 config 里就给，
 * 否则 callConfigEquals 会判定「config changed before adapter dispatch」——
 * 它拿 options 里这几项和 resolvedConfig 逐一比对。
 * StreamChunk 只有 text-delta（没有裸 text），照 types.ts 的定义来。
 *
 * @param {object} llm llm 服务
 * @param {{provider:string,model:string}} route 路由
 * @param {object} spec system / prompt / temperature / maxTokens / timeoutMs
 * @returns {Promise<string>} 模型输出
 */
export async function callLlmText(llm, route, { system, prompt, temperature, maxTokens, timeoutMs }) {
  // 加超时：网关不通时不能一直挂着，否则接口调用会卡死
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let text = ''
  try {
    const control = { provider: route.provider, model: route.model, temperature, maxTokens, reasoningEffort: 'off' }
    const prepared = await llm.prepareCall(control, ac.signal)
    const options = {
      ...prepared.config,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal: ac.signal,
    }
    for await (const chunk of prepared.stream(options)) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    }
    return text
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 用模型把散记忆写成一小段画像。
 *
 * 只写「看得出来」的：事实归事实，推测归推测；宁短不编。
 *
 * @param {object} llm llm 服务
 * @param {{provider:string,model:string}} route 路由
 * @param {object} db 记忆库
 * @param {Function} space 当前记忆空间
 * @returns {Promise<boolean>} 是否写成功
 */
export async function writePersonaLlm(llm, route, db, space) {
  const activeSpace = String((typeof space === 'function' ? space() : 'default') ?? 'default')
  const facts = listFacts(db, { space: activeSpace, limit: 12 }).map((r) => r.f)
  const scenes = (() => {
    try {
      return db.prepare('SELECT topic, body FROM scenes WHERE space=? ORDER BY updated DESC LIMIT 6').all(activeSpace)
    } catch { return [] }
  })()
  const recent = db.prepare('SELECT u FROM entries WHERE hot=0 ORDER BY t DESC LIMIT 15').all()
  if (facts.length === 0 && recent.length === 0) return false

  const material = [
    facts.length > 0 ? `事实：\n${facts.map((f) => `- ${f}`).join('\n')}` : '',
    scenes.length > 0 ? `成段的旧事：\n${scenes.map((s) => `- ${s.topic}：${String(s.body).split('\n').slice(0, 2).join(' / ')}`).join('\n')}` : '',
    recent.length > 0 ? `最近聊到：\n${recent.map((r) => `- ${String(r.u ?? '').slice(0, 40)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')

  const prompt = `下面是我记住的材料，请写一段「我记得的你」，120 字以内，第二人称（叫对方「你」、叫自己「我」），只写材料里能看出来的：
- 事实与推测分开写，推测要带「也许」「可能」
- 不写套话，不写心理分析，不评价这个人
- 没有材料支撑的不要写
- 不要写「你让某某做插件」这类把我和别人混在一起的话

${material}`

  const text = await callLlmText(llm, route, {
    system: '你在给自己写一小段关于对方的画像：用「你」称呼对方，用「我」称呼自己，不要把两个人的身份写混。只输出正文。',
    prompt,
    temperature: 0.4,
    maxTokens: 1200,
    timeoutMs: 45_000,
  })

  const body = text.trim().slice(0, 600)
  if (body.length < 10) return false
  db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('personaLLM', ?)").run(body)
  db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('personaLLMAt', ?)").run(String(Date.now()))
  return true
}
