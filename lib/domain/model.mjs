/**
 * 模型与路由：调一次模型只取文本、按层选路由、找「私发给谁」。
 *
 * 原样从 index.mjs 搬出来，只把外层包成两个工厂：
 *   - createModelAccess()：askModel / routeFor / defaultRoute
 *   - createNotifyTarget()：resolveNotifyTarget
 */
/**
 * @param {object} deps 依赖
 * @param {object} deps.config 插件配置
 * @param {Function} deps.cfgVal 读一项配置
 * @param {Function} deps.getLlm 拿 llm 服务（apply 时可能还没就绪）
 * @param {Function} deps.getAgents 拿 agents 服务
 * @returns {{askModel:Function, routeFor:Function, defaultRoute:Function}}
 */
export function createModelAccess({ config, cfgVal, getLlm, getAgents }) {
  /**
   * 调一次模型，只取文本。失败返回 null（调用方自行兜底）。
   *
   * 调用范式见 RULES.md 第 5 节：prepareCall 传 config 且控制项在内，
   * options 用 prepared.config 展开，流里只认 text-delta。
   *
   * @param {string} prompt
   * @param {number} maxTokens
   * @returns {Promise<string|null>}
   */
  const askModel = async (prompt, maxTokens = 400) => {
    const llmRef = getLlm()
    if (!llmRef) return null
    const route = defaultRoute()
    if (!route) return null

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 45_000)
    try {
      const control = { provider: route.provider, model: route.model, temperature: 0.3, maxTokens }
      const prepared = await llmRef.prepareCall(control, ac.signal)
      const options = {
        ...prepared.config,
        system: '你是一个精于整理记忆的助手。只输出要求的内容，不要解释。',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        signal: ac.signal,
      }
      let text = ''
      for await (const chunk of prepared.stream(options)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      }
      return text.trim() === '' ? null : text
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
  /**
   * 取梳理用的路由。
   *
   * 优先级：
   *   1. WHALE_LLM_ROUTE 环境变量（provider/model）
   *   2. 从最近的活跃 agent 继承（最常见的实际情况）
   *   3. 无 → 退回向量合并
   *
   * 第 2 条是关键：写代码的人不会记得配环境变量，
   * 但宿主里一定有个 agent 正在用某个 provider。
   */
  /**
   * 按层取路由：配置里写了就用它，没写就跟默认路由。
   *
   * 分层是为了省钱：L1（去重合并）高频，便宜的够；L3（画像）低频，值得用强的。
   *
   * @param {'l1'|'l2'|'l3'} layer 层名
   * @returns {{provider:string,model:string}|null} 路由
   */
  const routeFor = (layer) => {
    const cfg = config.llm && typeof config.llm === 'object' ? config.llm : {}
    const raw = String(cfgVal(cfg[layer], '') ?? '').trim()
    if (raw.includes('/')) {
      const [provider, model] = raw.split('/', 2)
      return { provider, model }
    }
    return defaultRoute()
  }

  const defaultRoute = () => {
    const env = process.env.WHALE_LLM_ROUTE
    if (env && env.includes('/')) {
      const [provider, model] = env.split('/', 2)
      return { provider, model }
    }
    // 从正在运行的 agent 会话里借路由。
    // Agent 本身只有 id，路由挂在 session.requestContext() 上。
    try {
      const agents = getAgents()
      const list = agents && typeof agents.list === 'function' ? agents.list() : []
      for (const a of list ?? []) {
        const rc = a?.session?.requestContext?.()
        if (rc && typeof rc.provider === 'string' && typeof rc.model === 'string') {
          return { provider: rc.provider, model: rc.model }
        }
      }
    } catch { /* 拿不到就往下走 */ }
    return null
  }

  return { askModel, routeFor, defaultRoute }
}

/**
 * 找「私发给谁」的解析器：优先用配置里的，没配就自动挑第一个单聊目标。
 *
 * @param {object} deps 依赖
 * @param {Function} deps.archiveNotify 存档的私发配置
 * @param {Function} deps.getIm 拿 dshIm 服务
 * @returns {Function} resolveNotifyTarget
 */
export function createNotifyTarget({ archiveNotify, getIm }) {
  const resolveNotifyTarget = async () => {
    const notify = archiveNotify()
    if (notify.botId !== '' && notify.targetId !== '') {
      return { botId: notify.botId, targetId: notify.targetId }
    }
    const dshImRef = getIm()
    if (!dshImRef) return null
    try {
      const bots = (await dshImRef.listBots?.()) ?? []
      for (const b of bots) {
        const id = String(b?.id ?? b?.botId ?? '')
        if (id === '') continue
        const targets = (await dshImRef.listTargets?.(id)) ?? []
        const user = targets.find((t) => String(t?.kind ?? '') === 'user')
        if (user && user.targetId) return { botId: id, targetId: String(user.targetId) }
      }
    } catch { /* 查不到就不发 */ }
    return null
  }

  return resolveNotifyTarget
}
