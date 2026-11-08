/**
 * 自己发起一次压缩：走 host 平面的 commands 服务，等于自己敲了一次 `/compact`。
 *
 * 原样从 index.mjs 搬出来，只把外层包成 createSelfCompact()。
 */

/**
 * @param {object} deps 依赖
 * @param {object} deps.db 库
 * @param {Function} deps.bumpStat 计数
 * @param {Function} deps.getCommands 拿 commands 服务
 * @param {Function} deps.getAgents 拿 agents 服务
 * @returns {Function} compactNow
 */
export function createSelfCompact({ db, bumpStat, getCommands, getAgents }) {
  const compactNow = async (opts = {}) => {
    const commandsRef = getCommands()
    if (commandsRef === null || commandsRef === undefined || typeof commandsRef.execute !== 'function') {
      return { ok: false, reason: 'commands-unavailable' }
    }
    const agentsRef = getAgents()
    const agents = agentsRef && typeof agentsRef.list === 'function' ? agentsRef.list() : []
    const agent = (agents ?? [])[0]
    if (!agent) return { ok: false, reason: 'no-agent' }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 120_000)
    try {
      const result = await commandsRef.execute(agent, '/compact', [], ac.signal)
      if (result === undefined) return { ok: false, reason: 'command-not-found' }
      bumpStat('selfCompact')
      try {
        db.prepare('INSERT INTO events(at, session, window, kind, text) VALUES(?,?,?,?,?)')
          .run(Date.now(), String(agent.session?.id ?? ''), 'self', 'tool',
            `自己压缩了一次（${opts.reason ?? 'manual'}）`)
      } catch { /* 记不上不影响压缩 */ }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) }
    } finally {
      clearTimeout(timer)
    }
  }

  return compactNow
}
