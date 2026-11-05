/**
 * dsh-whale-memory —— 浏览器端：设置面板里的「鲸娘记忆」页
 *
 * 手写 bundle，没有构建步骤。格式与 DSH 自带的客户端插件一致：
 * `window.__ModuleLoader__.load({ id, factory(require) })`，factory 返回
 * `{ name, inject, apply }`，由 shell 当普通 Cordis 插件挂载。
 *
 * 数据通路走 DSH 自己的设置服务，不另开存储：
 *
 *   ctx.get('configForms').get('dsh-whale-memory')
 *        ↓ 读 schema 解析后的值 + 修订号
 *   表单改动 → form.set(path, value) / form.mutate([...])
 *        ↓ Host 校验、写进活动 profile 的 cordis patch
 *   插件里 config.xxx.get() 立刻读到新值（volatile 字段无需重启）
 *
 * 所以这里不保存任何东西，页面只是那套配置的一面镜子。
 *
 * 这一页同时管两个插件的配置：记忆本体（dsh-whale-memory）和主动消息
 * （dsh-proactive-message）。主动消息是记忆的下游——先记得住，才谈得上
 * 主动开口——所以放在同一页，用两个命名空间分别读写。
 */
window.__ModuleLoader__.load({
  id: 'dsh-whale-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** 与 profile 里的插件条目 id 一致，设置服务按它找命名空间。 */
    const NS = 'dsh-whale-memory'
    /** 主动消息是另一个插件、另一个命名空间，但共用这一页。 */
    const PROACTIVE_NS = 'dsh-proactive-message'
    const STATUS_URL = '/dsh-whale-memory/status'
    const SELF_CHECK_URL = '/dsh-whale-memory/selfcheck'
    const NIGHTLY_URL = '/dsh-whale-memory/nightly'
    const PROACTIVE_STATUS_URL = '/dsh-proactive-message/status'

    /** 服务缺席时的占位表单，保证 hooks 每轮都按同样顺序调用。 */
    const NULL_FORM = {
      getSnapshot: () => ({
        status: 'unavailable', value: undefined, base: undefined,
        user: undefined, revision: undefined, writable: false,
      }),
      subscribe: () => () => {},
      set: () => Promise.resolve(false),
      unset: () => Promise.resolve(false),
      mutate: () => Promise.resolve(false),
    }

    const GROUPS = [
      {
        form: 'memory',
        title: '记忆注入',
        hint: '每次对话开头塞多少记忆进上下文。数字越小越省 token。空间也在这一组：换一格，写进去和想起来的都只看那一格。',
        fields: [
          { path: ['budgetChars'], label: '注入字符上限', kind: 'int', min: 50, max: 50000 },
          { path: ['recentPairs'], label: '热区保留轮数', kind: 'int', min: 0, max: 100 },
          { path: ['factMax'], label: '稳定事实条数', kind: 'int', min: 0, max: 500 },
          { path: ['space'], label: '当前空间', kind: 'string' },
        ],
      },
      {
        form: 'memory',
        title: '主动联想',
        hint: '它会不会自己想起旧事。门槛调高，它就安静一些。这三项只管记忆卡里的「和这次有关」那一段，不管 memory_recall 工具。',
        fields: [
          { path: ['recallMax'], label: '每轮最多想起几条', kind: 'int', min: 0, max: 50 },
          { path: ['recallThreshold'], label: '想起门槛', kind: 'num', min: 0, max: 1000 },
          { path: ['weightMax'], label: '权重上限', kind: 'num', min: 1, max: 10000 },
        ],
      },
      {
        form: 'memory',
        title: '冷热分层',
        hint: '热区留多少条、多重才抬进来、深一层扣多少分。改完下一轮就生效。',
        fields: [
          { path: ['hotZoneMax'], label: '热区条数上限', kind: 'int', min: 1, max: 200 },
          { path: ['hotPromoteWeight'], label: '抬进热区的最低权重', kind: 'int', min: 0, max: 20 },
          { path: ['tierPenalty'], label: '层级惩罚（每深一层扣分）', kind: 'num', min: 0, max: 1, step: 0.01 },
        ],
      },
      {
        form: 'memory',
        title: '夜班 / 桌面页',
        hint: '一天一次结账，蒸出下一轮要读的那一页。',
        fields: [
          { path: ['night', 'enabled'], label: '每天自动跑', kind: 'bool', fallback: true },
          { path: ['night', 'hour'], label: '几点开（0–23）', kind: 'int', min: 0, max: 23, fallback: 22 },
          { path: ['night', 'minute'], label: '几分开（0–59）', kind: 'int', min: 0, max: 59, fallback: 5 },
        ],
      },
      {
        form: 'memory',
        title: '日记',
        hint: '到点自己记一笔，不管有没有人找。这是让它「一直在」的那根线。',
        fields: [
          { path: ['diary', 'enabled'], label: '自动写日记', kind: 'bool' },
          { path: ['diary', 'hour'], label: '每天几点之后写（0–23）', kind: 'int', min: 0, max: 23 },
        ],
      },
      {
        form: 'memory',
        title: '压缩存档',
        hint: '上下文被压缩时，把摘要和那段原文汇成文档。',
        fields: [
          { path: ['archive', 'enabled'], label: '写完整存档到磁盘', kind: 'bool' },
          { path: ['archive', 'notify'], label: '顺手私发主人一份', kind: 'bool' },
        ],
      },
      {
        form: 'memory',
        title: '自动落盘 / 周记',
        hint: '第二层把群聊按天落成「全量-YYYY-MM-DD.md」，第三层每周拢一份周记。改完下一轮脚本就按这里跑。',
        fields: [
          { path: ['groupDump', 'enabled'], label: '自动落盘', kind: 'bool' },
          { path: ['groupDump', 'intervalMinutes'], label: '落盘间隔（分钟）', kind: 'int', min: 1, max: 1440 },
          { path: ['weekly', 'enabled'], label: '周记', kind: 'bool' },
          { path: ['weekly', 'startDay'], label: '周记起始日（1=周一 … 7=周日）', kind: 'int', min: 1, max: 7 },
          { path: ['groupDump', 'dir'], label: '导出目录', kind: 'string' },
        ],
      },
      {
        form: 'proactive',
        title: '主动消息 · 什么时候可以说话',
        hint: '它自己判断该不该开口时的几个门槛。',
        fields: [
          { path: ['dailyCap'], label: '每天最多发几条', kind: 'int', min: 0, max: 500 },
          { path: ['cooldownHours'], label: '两次之间至少隔几小时', kind: 'num', min: 0, max: 720 },
          { path: ['silenceHours'], label: '多久没说话才算安静（小时）', kind: 'num', min: 0, max: 720 },
        ],
      },
      {
        form: 'proactive',
        title: '主动消息 · 免打扰',
        hint: '这个时段一律不发。开始和结束填一样就是不启用。',
        fields: [
          { path: ['quietStart'], label: '从几点开始（0–23）', kind: 'int', min: 0, max: 23 },
          { path: ['quietEnd'], label: '到结束（0–23）', kind: 'int', min: 0, max: 23 },
          { path: ['tickMinutes'], label: '每多少分钟检查一次', kind: 'int', min: 1, max: 1440 },
        ],
      },
    ]

    const PATH_TEXT = (path) => path.join('.')

    /** 沿路径读一层普通对象，读不到就 undefined。 */
    const pick = (root, path) => {
      let cur = root
      for (const key of path) {
        if (cur === null || typeof cur !== 'object') return undefined
        cur = cur[key]
      }
      return cur
    }

    /**
     * 把输入框里的文字变成要写入的数值。
     *
     * 空串和非法输入都不写、不从默认值重置——只有点「恢复」才重置。
     * 超出范围就夹到边界上，所以用户敲什么都不会被静默吞掉。
     *
     * @param {object} field 字段描述（带 min/max）
     * @param {string} raw 输入框当前文字
     * @param {number|undefined} current 现在实际生效的值
     * @returns {{write:boolean, value?:number, clamped?:boolean}}
     */
    const normalizeNumber = (field, raw, current) => {
      const text = String(raw).trim()
      if (text === '') return { write: false }
      const n = Number(text)
      if (!Number.isFinite(n)) return { write: false }
      const lo = field.min ?? -Infinity
      const hi = field.max ?? Infinity
      const value = Math.min(hi, Math.max(lo, n))
      if (value === current) return { write: false, clamped: value !== n }
      return { write: true, value, clamped: value !== n }
    }

    /**
     * 写操作的三态文案：写中 → 已保存 / 失败：<原因>。
     *
     * 以前这里 `catch(() => undefined)` 就把 reject 吞了，页面只靠「值回弹」
     * 暗示没写进去——用户分不清是网络断了、配置只读，还是 Host 校验拒了。
     * 现在错误原样交回调用方，由行尾红字说清原因。
     */
    const WRITE_TEXT = {
      saving: () => '写中…',
      saved: () => '已保存',
      error: (state) => `失败：${state?.message ?? '未知原因'}`,
    }

    /** 写状态 → 给人看的一行字；没有状态就是空串（不占位）。 */
    const writeStateOf = (state) => {
      if (state === undefined || state === null) return ''
      const text = WRITE_TEXT[state.status]
      return typeof text === 'function' ? text(state) : ''
    }

    /**
     * 写入一个字段：一级字段走 set，嵌套字段走 mutate + 路径。
     *
     * @param {object} form 配置表单
     * @param {string[]} path 字段路径
     * @param {unknown} value 新值
     * @param {Function} [onState] 状态回调：{status:'saving'|'saved'|'error', message?}
     * @returns {Promise<boolean>} 是否真的写进去了（拒绝也算 false，不抛）
     */
    const writePath = (form, path, value, onState) => {
      const notify = typeof onState === 'function' ? onState : () => {}
      notify({ status: 'saving' })
      const done = path.length === 1
        ? form.set(path[0], value)
        : form.mutate([{ op: 'set', path, value }])
      return Promise.resolve(done).then(
        (ok) => {
          if (ok === false) {
            notify({ status: 'error', message: '配置服务拒了这次写入（只读，或值没通过校验）' })
            return false
          }
          notify({ status: 'saved' })
          return true
        },
        (error) => {
          notify({ status: 'error', message: String(error?.message ?? error ?? '请求没发出去') })
          return false
        },
      )
    }

    /** 清掉用户覆盖，让字段回到 schema 默认值。 */
    const resetPath = (form, path, onState) => {
      const notify = typeof onState === 'function' ? onState : () => {}
      notify({ status: 'saving' })
      const done = path.length === 1
        ? form.unset(path[0])
        : form.mutate([{ op: 'unset', path }])
      return Promise.resolve(done).then(
        (ok) => {
          if (ok === false) {
            notify({ status: 'error', message: '配置服务拒了这次恢复（只读，或值没通过校验）' })
            return false
          }
          notify({ status: 'saved' })
          return true
        },
        (error) => {
          notify({ status: 'error', message: String(error?.message ?? error ?? '请求没发出去') })
          return false
        },
      )
    }

  // ───────────────────────── 图谱几何（纯函数，无 DOM、无随机） ─────────────────────────
  // 浏览器这边没有打包步骤，只能单文件放着；但这一段不碰 React 也不碰 DOM，
  // 测试和 scripts/graph-svg.mjs 都从 __test 里直接调它——所以「画成什么样」可复现、可校验。
  const GL_W = 900
  const GL_H = 620
  const GL_PAD = 64
  const GL_FONT = 11
  const GL_MIN_FONT = 8
  const GL_LINE = 1.35
  const GL_MAX_LABEL_W = 104
  const GL_PUSH = 10
  const GL_PUSH_MAX = 5
  const GL_TOP = 5
  const GL_LABEL_ZOOM = 0.6
  const GL_EDGE_DEFAULT = 120
  /** 两个圆点之间至少留多少空隙（除了各自的半径）：标签就压在点上方，挤在一起必压字。 */
  const GL_MIN_SEP = 28
  /** 点离画布边至少留多少（标签要放得下）。 */
  const GL_EDGE = 30
  const CAM_MIN = 0.3
  const CAM_MAX = 4

  const glR2 = (v) => Math.round(v * 100) / 100

  /** 名字 → 32 位哈希（FNV-1a）：同一个名字永远同一个值，布局不随刷新乱跳。 */
  const glHash = (s) => {
    let x = 0x811c9dc5
    for (let i = 0; i < s.length; i += 1) {
      x ^= s.charCodeAt(i)
      x = Math.imul(x, 0x01000193) >>> 0
    }
    return x >>> 0
  }

  /** 种子定、序列定的 PRNG；力导向里任何一处「随机」都从这里来。 */
  const glRand = (seed) => {
    let s = (seed >>> 0) || 0x9e3779b9
    return () => {
      s = (s ^ (s << 13)) >>> 0
      s = (s ^ (s >>> 17)) >>> 0
      s = (s ^ (s << 5)) >>> 0
      return s / 4294967296
    }
  }

  /** 力导向：Fruchterman-Reingold 两步（斥力 k²/d、引力 d²/k）+ 向心力，固定迭代次数。 */
  const glForce = (nodes, edges, W, H) => {
    const pos = new Map()
    for (const nd of nodes) {
      const h0 = glHash(nd.name)
      // 相位与半径都由名字决定：同一个库、同一批实体，初始位置永远一样。
      const ang = ((h0 % 4096) / 4096) * Math.PI * 2
      const rad = 40 + glRand(h0)() * Math.min(W, H) * 0.32
      pos.set(nd.name, { x: W / 2 + Math.cos(ang) * rad, y: H / 2 + Math.sin(ang) * rad })
    }
    const pairs = [...pos.entries()]
    const n = pairs.length
    const k = Math.sqrt((W * H) / Math.max(1, n)) * 0.62
    const iters = n <= 60 ? 260 : n <= 120 ? 180 : 120
    const disp = new Map()
    for (let it = 0; it < iters; it += 1) {
      const temp = Math.max(1, (1 - it / iters) * W * 0.05)
      for (const [name] of pairs) disp.set(name, { x: 0, y: 0 })
      for (let i = 0; i < n; i += 1) {
        const [na, pa] = pairs[i]
        for (let j = i + 1; j < n; j += 1) {
          const [nb, pb] = pairs[j]
          let dx = pa.x - pb.x
          let dy = pa.y - pb.y
          let d2 = dx * dx + dy * dy
          if (d2 < 0.01) {
            dx = 0.1 + (i % 3) * 0.1
            dy = 0.1 + (j % 3) * 0.1
            d2 = dx * dx + dy * dy
          }
          const d = Math.sqrt(d2)
          const f = (k * k) / d
          const da = disp.get(na)
          const db = disp.get(nb)
          da.x += (dx / d) * f
          da.y += (dy / d) * f
          db.x -= (dx / d) * f
          db.y -= (dy / d) * f
        }
      }
      for (const e of edges) {
        const pa = pos.get(e.a)
        const pb = pos.get(e.b)
        if (pa === undefined || pb === undefined) continue
        const dx = pb.x - pa.x
        const dy = pb.y - pa.y
        const d = Math.max(0.01, Math.sqrt(dx * dx + dy * dy))
        // 弹簧只拉到「自然长度 k」为止。d²/k 那种写法在 120 条边的图上会把点全吸成一个团
        // （斥力是逐对求和、引力却按边直接加，量级压不过）。
        const f = (d - k) * 0.06
        const da = disp.get(e.a)
        const db = disp.get(e.b)
        da.x += (dx / d) * f
        da.y += (dy / d) * f
        db.x -= (dx / d) * f
        db.y -= (dy / d) * f
      }
      for (const [name, p] of pairs) {
        const dd = disp.get(name)
        dd.x += (W / 2 - p.x) * 0.02
        dd.y += (H / 2 - p.y) * 0.02
        const len = Math.sqrt(dd.x * dd.x + dd.y * dd.y)
        if (len > 0.0001) {
          const step = Math.min(len, temp)
          p.x += (dd.x / len) * step
          p.y += (dd.y / len) * step
        }
      }
    }
    return pos
  }

  /**
   * 力导向收尾：把挨得太近的点推开，给标签腾地方（标签在点正上方，点太挤就必然压字）。
   * 纯推开式松弛，方向只取决于坐标与下标，没有随机：同一份数据结果一样。
   */
  const glSeparate = (pos, radiusOf, rounds = 24) => {
    const names = [...pos.keys()]
    for (let round = 0; round < rounds; round += 1) {
      let moved = false
      for (let i = 0; i < names.length; i += 1) {
        const pa = pos.get(names[i])
        for (let j = i + 1; j < names.length; j += 1) {
          const pb = pos.get(names[j])
          const need = GL_MIN_SEP + (radiusOf.get(names[i]) ?? 5) + (radiusOf.get(names[j]) ?? 5)
          const dx = pb.x - pa.x
          const dy = pb.y - pa.y
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d >= need) continue
          // 完全重合时按下标取一个确定的方向，别用随机数。
          const ux = d < 0.01 ? Math.cos(i + j) : dx / d
          const uy = d < 0.01 ? Math.sin(i + j) : dy / d
          const step = (need - d) / 2 + 0.5
          pa.x -= ux * step
          pa.y -= uy * step
          pb.x += ux * step
          pb.y += uy * step
          moved = true
        }
      }
      if (!moved) break
    }
    return pos
  }

  /** 收进画布：留一点边，别让标签贴着框飞出去。 */
  const glClamp = (pos, W, H) => {
    const out = new Map()
    for (const [name, p] of pos) {
      out.set(name, {
        x: glR2(Math.min(W - GL_EDGE, Math.max(GL_EDGE, p.x))),
        y: glR2(Math.min(H - GL_EDGE, Math.max(GL_EDGE, p.y))),
      })
    }
    return out
  }

  /** 把布局整体缩放平移进画布（按半径留出边），坐标统一取两位小数。 */
  const glFit = (pos, radiusOf, W, H, pad) => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const [name, p] of pos) {
      const r = radiusOf.get(name) ?? 5
      minX = Math.min(minX, p.x - r)
      maxX = Math.max(maxX, p.x + r)
      minY = Math.min(minY, p.y - r)
      maxY = Math.max(maxY, p.y + r)
    }
    if (!Number.isFinite(minX)) return pos
    const bw = Math.max(1, maxX - minX)
    const bh = Math.max(1, maxY - minY)
    const s = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh, 1.6)
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const out = new Map()
    for (const [name, p] of pos) {
      out.set(name, { x: glR2(W / 2 + (p.x - cx) * s), y: glR2(H / 2 + (p.y - cy) * s) })
    }
    return out
  }

  /** 半径分五档（按 count 与最大值的比例），不做连续缩放。 */
  const glRadius = (count, maxCount) => {
    const t = maxCount <= 0 ? 0 : Math.max(0, Math.min(1, count / maxCount))
    if (t >= 0.75) return 16
    if (t >= 0.45) return 12.5
    if (t >= 0.22) return 9.5
    if (t >= 0.08) return 7
    return 5
  }

  /** 边粗分四档（按 weight 与最大值的比例）。 */
  const glEdgeWidth = (w, maxW) => {
    const t = maxW <= 0 ? 0 : Math.max(0, Math.min(1, w / maxW))
    if (t >= 0.8) return 3.2
    if (t >= 0.55) return 2.4
    if (t >= 0.3) return 1.6
    if (t >= 0.15) return 1
    return 0.6
  }

  /** 单字符宽度（em）：CJK/全角 1，拉丁 0.56，空格 0.3。够准，且不量 DOM。 */
  const glCharEm = (ch) => {
    const c = ch.codePointAt(0) ?? 0
    if (c === 32) return 0.3
    if (c < 0x2e80) return 0.56
    return 1
  }
  const glTextW = (s, fs) => {
    let w = 0
    for (const ch of s) w += glCharEm(ch) * fs
    return w
  }
  /** 拉丁串只在空格/连字符/分隔符后断；中文逐字断。 */
  const glBreakable = (ch) => ch === ' ' || ch === '-' || ch === '_' || ch === '/' || ch === ':' || ch === '.' || ch === '·' || ch === '、' || ch === '，'

  /** 折行到宽度上限以内。完整保留原文，一个字都不丢（不打省略号）。 */
  const glWrap = (name, fs, maxW) => {
    const width = (arr) => glTextW(arr.join(''), fs)
    const lines = []
    let cur = []
    for (const ch of [...name]) {
      if (cur.length === 0) { cur.push(ch); continue }
      if (width([...cur, ch]) <= maxW) { cur.push(ch); continue }
      let cut = cur.length
      if ((ch.codePointAt(0) ?? 0) < 0x2e80) {
        for (let i = cur.length - 1; i > 0; i -= 1) {
          if (glBreakable(cur[i - 1])) { cut = i; break }
        }
      }
      lines.push(cur.slice(0, cut).join(''))
      cur = cur.slice(cut)
      cur.push(ch)
      while (cur.length > 1 && width(cur) > maxW) {
        let k = cur.length
        while (k > 1 && width(cur.slice(0, k - 1)) > maxW) k -= 1
        lines.push(cur.slice(0, k).join(''))
        cur = cur.slice(k)
      }
    }
    if (cur.length > 0) lines.push(cur.join(''))
    return lines.length === 0 ? [name] : lines
  }

  /**
   * 一条标签：先按 11px 折行；超过两行就把字号往下压到 8px，再不行就多占一行。
   * 任何情况下都**不截断**——宁可多一行小字，也不把名字改短。
   */
  const glLabel = (name, maxW = GL_MAX_LABEL_W) => {
    let fs = GL_FONT
    let lines = glWrap(name, fs, maxW)
    while (lines.length > 2 && fs > GL_MIN_FONT) {
      fs -= 1
      lines = glWrap(name, fs, maxW)
    }
    const lineHeight = glR2(fs * GL_LINE)
    return {
      lines,
      fontSize: fs,
      lineHeight,
      w: Math.max(...lines.map((l) => glTextW(l, fs))),
      h: Math.max(1, lines.length) * lineHeight,
    }
  }

  /**
   * 标签摆放：圆点正上方居中，然后贪心避让——
   * 按「度 → 次数 → 名字」排序逐个放；和已放的矩形重叠就沿法线推开 10px，最多 5 次；
   * 推到画布边上就翻到另一侧（点下方）继续推。
   */
  const glPlaceLabels = (items, opts) => {
    const W = opts.width
    const H = opts.height
    const showAll = opts.showAll !== false
    const order = [...items].sort((a, b) => b.degree - a.degree
      || b.count - a.count
      || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const always = new Set(order.slice(0, GL_TOP).map((it) => it.name))
    const boxes = []
    const out = new Map()
    for (const it of order) {
      if (!showAll && !always.has(it.name)) continue
      const lab = it.label
      let x = it.x - lab.w / 2
      let y = it.y - it.r - 6 - lab.h
      x = Math.min(W - lab.w - 2, Math.max(2, x))
      y = Math.min(H - lab.h - 2, Math.max(2, y))
      let dir = -1
      for (let push = 0; push < GL_PUSH_MAX; push += 1) {
        const hit = boxes.find((b) => !(x + lab.w + 1 <= b.x
          || b.x + b.w + 1 <= x
          || y + lab.h + 1 <= b.y
          || b.y + b.h + 1 <= y))
        if (hit === undefined) break
        // 沿「压得最浅的那条轴」的法线推开 10px（上下压得浅就上下推，左右压得浅就左右推）；
        // 推到画布边上就换另一条轴，最多 5 次。
        const overY = Math.min(y + lab.h, hit.y + hit.h) - Math.max(y, hit.y)
        const overX = Math.min(x + lab.w, hit.x + hit.w) - Math.max(x, hit.x)
        if (overY <= overX) {
          const ny = y + dir * GL_PUSH
          if (ny < 2 || ny + lab.h > H - 2) {
            dir = -dir
            x += (x + lab.w / 2 >= hit.x + hit.w / 2 ? GL_PUSH : -GL_PUSH)
          } else {
            y = ny
          }
        } else {
          const nx = x + (x + lab.w / 2 >= hit.x + hit.w / 2 ? GL_PUSH : -GL_PUSH)
          if (nx < 2 || nx + lab.w > W - 2) {
            y += (y + lab.h / 2 >= hit.y + hit.h / 2 ? GL_PUSH : -GL_PUSH)
          } else {
            x = nx
          }
        }
      }
      y = Math.min(H - lab.h - 2, Math.max(2, y))
      boxes.push({ x, y, w: lab.w, h: lab.h })
      out.set(it.name, {
        lines: lab.lines,
        fontSize: lab.fontSize,
        lineHeight: lab.lineHeight,
        x: glR2(x),
        y: glR2(y),
        w: glR2(lab.w),
        h: glR2(lab.h),
      })
    }
    return out
  }

  /**
   * 一张图要画的东西：点的坐标与半径、要画的边（按 weight 取前 N 条）、标签位置。
   * 纯函数：同样的输入 → 完全一样的输出（测试就靠这一条）。
   */
  const buildGraphScene = (input, opts = {}) => {
    const W = opts.width ?? GL_W
    const H = opts.height ?? GL_H
    const edgeMax = Math.max(1, Number(opts.edgeMax) || GL_EDGE_DEFAULT)
    const showAll = opts.showAll !== false
    const nodes = (Array.isArray(input?.nodes) ? input.nodes : [])
      .filter((n) => n !== null && typeof n?.name === 'string' && n.name !== '')
    const byName = new Map(nodes.map((n) => [n.name, n]))
    const allEdges = (Array.isArray(input?.edges) ? input.edges : [])
      .filter((e) => e !== null && byName.has(e?.a) && byName.has(e?.b) && e.a !== e.b)
      .map((e) => ({ a: e.a, b: e.b, w: Number(e.weight ?? e.w ?? 0) || 0 }))
      .sort((x, y) => y.w - x.w
        || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0)
        || (x.b < y.b ? -1 : x.b > y.b ? 1 : 0))
    const edges = allEdges.slice(0, edgeMax)
    const localDeg = new Map(nodes.map((n) => [n.name, 0]))
    for (const e of allEdges) {
      localDeg.set(e.a, (localDeg.get(e.a) ?? 0) + 1)
      localDeg.set(e.b, (localDeg.get(e.b) ?? 0) + 1)
    }
    const maxCount = nodes.reduce((m, n) => Math.max(m, Number(n.count) || 0), 0)
    const radiusOf = new Map(nodes.map((n) => [n.name, glRadius(Number(n.count) || 0, maxCount)]))
    // 顺序要紧：先缩放进画布，再在**画布像素**上推开——反过来的话，推开后整体一缩放，
    // 间距又按比例缩回去，等于白推。
    const fit = glFit(glForce(nodes.map((n) => ({ name: n.name })), edges, W, H), radiusOf, W, H, GL_PAD)
    const pos = glClamp(glSeparate(fit, radiusOf), W, H)
    const maxW = edges.reduce((m, e) => Math.max(m, e.w), 1)
    const drawn = edges.map((e) => {
      const pa = pos.get(e.a) ?? { x: W / 2, y: H / 2 }
      const pb = pos.get(e.b) ?? { x: W / 2, y: H / 2 }
      const ra = radiusOf.get(e.a) ?? 5
      const rb = radiusOf.get(e.b) ?? 5
      const dx = pb.x - pa.x
      const dy = pb.y - pa.y
      const d = Math.max(0.01, Math.sqrt(dx * dx + dy * dy))
      const ux = dx / d
      const uy = dy / d
      const t = maxW <= 0 ? 0 : e.w / maxW
      return {
        a: e.a,
        b: e.b,
        w: e.w,
        x1: glR2(pa.x + ux * ra),
        y1: glR2(pa.y + uy * ra),
        x2: glR2(pb.x - ux * rb),
        y2: glR2(pb.y - uy * rb),
        width: glEdgeWidth(e.w, maxW),
        opacity: glR2(0.12 + 0.5 * t),
      }
    })
    const items = nodes.map((n) => {
      const p = pos.get(n.name) ?? { x: W / 2, y: H / 2 }
      return {
        name: n.name,
        x: p.x,
        y: p.y,
        r: radiusOf.get(n.name) ?? 5,
        count: Number(n.count) || 0,
        // 度：接口给了就用接口的（整张图的度），没给才退回本次这批边算出来的局部度。
        // 注意接口的 0 是「真的一条边都没有」，不能当成「没给」。
        degree: (() => {
          const raw = n.degree
          if (raw !== undefined && raw !== null && Number.isFinite(Number(raw))) return Number(raw)
          return localDeg.get(n.name) ?? 0
        })(),
        label: glLabel(n.name),
      }
    })
    const labels = glPlaceLabels(items, { width: W, height: H, showAll })
    return {
      width: W,
      height: H,
      nodes: items.map((it) => ({ ...it, label: labels.get(it.name) ?? null })),
      edges: drawn,
      stats: {
        nodes: items.length,
        edgesTotal: allEdges.length,
        edgesDrawn: drawn.length,
        labels: labels.size,
        showAll,
      },
    }
  }
  // ───────────────────────── /图谱几何 ─────────────────────────


    const apply = (ctx) => {
      const React = require('react')
      const h = React.createElement
      const primitives = (() => {
        try {
          return require('@deepseek-ai/dsh-client-ui-primitives')
        } catch {
          return null
        }
      })()

      const Switch = primitives && primitives.Switch
      const Input = primitives && primitives.Input

      /**
       * 拿某个命名空间的共享表单；服务缺席时返回 null，页面显示提示而不是崩掉。
       * 拿到就缓存——反复 get 会拿到新的 controller，订阅会一直重来。
       */
      const formCache = new Map()
      const formOf = (ns) => {
        if (formCache.has(ns)) return formCache.get(ns)
        const forms = ctx.get('configForms')
        if (!forms || typeof forms.get !== 'function') return null
        const form = forms.get(ns)
        if (!form) return null
        formCache.set(ns, form)
        return form
      }

      const rowStyle = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        padding: '10px 0',
      }
      const labelStyle = { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' }
      const nameStyle = { fontSize: '13px' }
      const metaStyle = { fontSize: '11px', opacity: 0.6, fontFamily: 'monospace' }


      /**
       * 一行设置：标签 + 控件 + 覆盖标记 + 写操作反馈。
       *
       * 路径与取值范围只放在整行的 title 里（悬停可见），行内不再常驻——
       * 28 行每行都挂一段 monospace 噪音，值反而看不见。
       */
      const Row = ({ field, value, base, overridden, disabled, save, onWrite, onReset }) => {
        // 值还没下发时用 Host 的 base 层（schema 默认）兜住：只显示、不回写，
        // 也不在客户端写死数字（groupDump/weekly 的默认值只有 LAYER_DEFAULTS 一份）。
        const fallback = pick(base, field.path) ?? field.fallback
        const shown = value === undefined || value === null ? fallback : value
        const usingDefault = (value === undefined || value === null) && shown !== undefined && shown !== null
        // 输入框自己存草稿：敲字时只改草稿，失焦或回车才写进去。
        // 否则每敲一个数字就提交一次，Host 一回写就把光标和内容顶回去。
        const asText = (v) => (v === undefined || v === null ? '' : String(v))
        const [draft, setDraft] = React.useState(asText(shown))
        const [typing, setTyping] = React.useState(false)

        React.useEffect(() => {
          if (!typing) setDraft(asText(shown))
        }, [shown, typing])

        const commit = () => {
          setTyping(false)
          const result = normalizeNumber(field, draft, shown)
          if (result.clamped === true) setDraft(asText(result.value))
          if (result.write === true) onWrite(result.value)
          else if (draft.trim() === '' || !Number.isFinite(Number(draft))) setDraft(asText(shown))
        }

        const control = (() => {
          if (field.kind === 'string') {
            const commitText = () => {
              setTyping(false)
              const next = String(draft).trim()
              if (next !== String(shown ?? '')) onWrite(next)
            }
            return h('input', {
              type: 'text',
              value: draft,
              disabled,
              'aria-label': field.label,
              onFocus: () => setTyping(true),
              onChange: (e) => { setTyping(true); setDraft(e.target.value) },
              onBlur: commitText,
              onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur() },
              style: { width: '180px' },
            })
          }
          if (field.kind === 'bool') {
            const checked = shown === true
            if (typeof Switch === 'function') {
              return h(Switch, { checked, label: field.label, disabled, onChange: (next) => onWrite(next) })
            }
            return h('input', { type: 'checkbox', checked, disabled, onChange: (e) => onWrite(e.target.checked) })
          }
          const props = {
            type: 'number',
            value: draft,
            // step 给 any，否则只能按步长走，敲不进小数
            step: field.step ?? 'any',
            disabled,
            'aria-label': field.label,
            onFocus: () => setTyping(true),
            onChange: (e) => { setTyping(true); setDraft(e.target.value) },
            onBlur: commit,
            onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur() },
            style: { width: '110px' },
          }
          if (typeof Input === 'function') return h(Input, props)
          return h('input', props)
        })()

        const range = field.min !== undefined || field.max !== undefined
          ? `${field.min ?? ''}~${field.max ?? ''}`
          : ''
        const hover = `${PATH_TEXT(field.path)}${range === '' ? '' : ` (${range})`}`
        const saveText = writeStateOf(save)
        const saveFailed = save !== undefined && save !== null && save.status === 'error'

        return h(
          'div',
          { style: rowStyle, title: hover },
          h(
            'div',
            { style: labelStyle },
            h('span', { style: nameStyle }, field.label),
            h(
              'span',
              { style: metaStyle },
              usingDefault ? '默认值' : '',
              overridden ? (usingDefault ? ' · 已改' : '已改') : '',
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 } },
            overridden && !disabled
              ? h(
                'button',
                {
                  type: 'button',
                  onClick: onReset,
                  title: '恢复成默认值',
                  style: {
                    border: 'none', background: 'transparent', cursor: 'pointer',
                    fontSize: '11px', opacity: 0.6, padding: '2px 4px', color: 'inherit',
                  },
                },
                '恢复',
              )
              : null,
            control,
            // 写操作的回执：写中… / 已保存 / 失败：<原因>。失败是红字，就地留着。
            h('span', {
              role: 'status',
              title: saveFailed ? String(save.message ?? '') : '',
              style: {
                fontSize: '11px',
                minWidth: '64px',
                color: saveFailed ? '#ff8f8f' : 'inherit',
                opacity: saveFailed ? 1 : 0.55,
              },
            }, saveText),
          ),
        )
      }

      /** 情绪键 → 中文，只用于显示。 */
      const EMO_TEXT = { tired: '累', sad: '难过', angry: '烦', happy: '开心', anxious: '焦虑' }

      const fmtTime = (ms) => {
        const d = new Date(ms)
        const p2 = (n) => String(n).padStart(2, '0')
        return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
      }

      /**
       * 热区 / 冷区的内容预览。
       *
       * 纯只读：这里只有文字和一个切换按钮，没有任何写入口——
       * 记忆内容该怎么变是插件自己决定的，不该由设置页手动改。
       */
      const EntriesView = ({ onSwitchSpace, currentSpace, spaceSave }) => {
        const [zone, setZone] = React.useState('cold')
        const [data, setData] = React.useState(null)
        const [dataZone, setDataZone] = React.useState('')
        const [failed, setFailed] = React.useState(false)
        const [seq, setSeq] = React.useState(0)
        const [q, setQ] = React.useState('')
        const [allSpaces, setAllSpaces] = React.useState(false)
        // 画像面板：重蒸桌面页时的忙标记；图谱：空间/排序/展开的实体与它名下的记忆。
        const [deskBusy, setDeskBusy] = React.useState(false)
        const [graphSpace, setGraphSpace] = React.useState('')
        const [graphSort, setGraphSort] = React.useState('count')
        const [spaces, setSpaces] = React.useState(null)
        const [entity, setEntity] = React.useState(null)
        const [memOpen, setMemOpen] = React.useState(null)
        // 图谱：图 / 列表两条视图，图是默认；画多少条边；相机的缩放平移。
        const [graphMode, setGraphMode] = React.useState('graph')
        const [graphEdges, setGraphEdges] = React.useState(GL_EDGE_DEFAULT)
        const [cam, setCam] = React.useState({ k: 1, x: 0, y: 0 })
        const [hover, setHover] = React.useState(null)
        // 删/改/撤回这类动作失败时，就地把原因摊在列表上方——别刷新一下装作什么都没发生。
        const [actErr, setActErr] = React.useState('')
        // 切空间是一次写操作，同样要回执（写中…/已保存/失败）。
        const [spaceBusy, setSpaceBusy] = React.useState(false)
        const svgRef = React.useRef(null)
        const panRef = React.useRef(null)

        /** 这一页现在看的是哪个空间：没手动选就是设置里那个。 */
        const spaceNow = () => (graphSpace !== '' ? graphSpace : (currentSpace || 'default'))

        const urlOf = (z) => {
          const extra = `&keyword=${encodeURIComponent(q)}&all=${allSpaces ? 1 : 0}`
          if (z === 'scenes') return '/dsh-whale-memory/scenes'
          if (z === 'persona') return '/dsh-whale-memory/persona'
          if (z === 'graph') return `/dsh-whale-memory/graph?space=${encodeURIComponent(spaceNow())}&limit=50&sort=${graphSort}`
          if (z === 'spaces') return '/dsh-whale-memory/spaces'
          // 热区/冷区必须带上当前空间：不带的话后端按 'default' 读，
          // 切了空间看到的还是同一批，等于骗人。「全部空间」时留空表示不过滤。
          return `/dsh-whale-memory/entries?zone=${z}&space=${encodeURIComponent(allSpaces ? '' : spaceNow())}&limit=50${extra}`
        }

        /**
         * 发一个改记忆内容的请求。
         *
         * 只看 `res.ok`：后端拒绝（404/409/500）时也要把原因说出来，
         * 并且**不刷新**——刷新会让人以为改动生效了，实际什么都没有变。
         *
         * @returns {Promise<boolean>} 成功返回 true
         */
        const postJson = async (url, body) => {
          setActErr('')
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
            if (res.ok) return true
            let detail = ''
            try {
              const json = await res.json()
              detail = String(json?.reason ?? json?.error ?? '')
            } catch {
              try { detail = String(await res.text()).slice(0, 200) } catch { detail = '' }
            }
            setActErr(`操作失败：HTTP ${res.status}${detail === '' ? '' : ` · ${detail}`}`)
            return false
          } catch (error) {
            setActErr(`操作失败：${String(error?.message ?? error ?? '请求没发出去')}`)
            return false
          }
        }

        // 图谱的空间下拉读现成的 /spaces 列表：开一次就够，不跟着页签反复拉。
        React.useEffect(() => {
          if (zone !== 'graph' || spaces !== null) return undefined
          let alive = true
          fetch('/dsh-whale-memory/spaces', { headers: { accept: 'application/json' } })
            .then((res) => (res.ok ? res.json() : null))
            .then((json) => { if (alive) setSpaces(Array.isArray(json?.spaces) ? json.spaces : []) })
            .catch(() => { if (alive) setSpaces([]) })
          return () => { alive = false }
        }, [zone, spaces])

        React.useEffect(() => {
          let alive = true
          setFailed(false)
          // 换页签先把上一页的数据清掉：不然新页签会拿旧数据渲染一次，
          // 比如从「场景」切到「热区」，旧数据里没有 emo，渲染就炸。
          setData(null)
          fetch(urlOf(zone), { headers: { accept: 'application/json' } })
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
            .then((json) => { if (alive) { setData(json); setDataZone(zone) } })
            .catch(() => { if (alive) { setData(null); setFailed(true) } })
          return () => { alive = false }
        }, [zone, seq, allSpaces, graphSpace, graphSort, currentSpace])

        const tab = (key, label) => h('button', {
          type: 'button',
          onClick: () => setZone(key),
          style: {
            border: '1px solid currentColor',
            borderRadius: '6px',
            padding: '2px 10px',
            fontSize: '12px',
            cursor: 'pointer',
            color: 'inherit',
            background: 'transparent',
            opacity: zone === key ? 1 : 0.5,
          },
        }, label)

        // 只有数据属于当前页签才算数，否则按「读取中」处理：
        // 换页签的瞬间旧数据还在，用它渲染会读错字段、也会撞 key。
        const settled = data !== null && dataZone === zone
        const items = settled ? (data.items ?? []) : []

        // 图谱几何只随「数据 / 边数 / 缩放档」重算：拖拽平移每帧都重排会卡。
        const graphScene = React.useMemo(() => {
          if (data === null || dataZone !== 'graph') return null
          return buildGraphScene(data, { edgeMax: graphEdges, showAll: cam.k >= GL_LABEL_ZOOM })
        }, [data, dataZone, graphEdges, cam.k >= GL_LABEL_ZOOM])

        // 滚轮缩放挂原生监听：React 的 onWheel 是 passive 的，preventDefault 会被忽略，
        // 缩放时整页跟着滚。
        React.useEffect(() => {
          const el = svgRef.current
          if (el === null) return undefined
          const onWheel = (ev) => {
            ev.preventDefault()
            const rect = el.getBoundingClientRect()
            if (rect.width <= 0 || rect.height <= 0) return
            const mx = ((ev.clientX - rect.left) / rect.width) * GL_W
            const my = ((ev.clientY - rect.top) / rect.height) * GL_H
            setCam((c) => {
              const next = Math.min(CAM_MAX, Math.max(CAM_MIN, c.k * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)))
              const f = next / c.k
              return { k: next, x: mx - (mx - c.x) * f, y: my - (my - c.y) * f }
            })
          }
          el.addEventListener('wheel', onWheel, { passive: false })
          return () => el.removeEventListener('wheel', onWheel)
        }, [zone, graphMode, settled, graphScene])

        const body = (() => {
          if (failed) return h('p', { style: { fontSize: '12px', opacity: 0.7 } }, '读不到记忆库。')
          if (!settled) return h('p', { style: { fontSize: '12px', opacity: 0.55 } }, '读取中…')

          if (zone === 'persona') {
            const text = String(data.text ?? '')
            const deskAt = Number(data.deskAt ?? 0)
            const files = Array.isArray(data.notes?.files) ? data.notes.files : []
            const notesDir = String(data.notes?.dir ?? '')
            return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' } },
                h('span', { style: metaStyle },
                  deskAt > 0
                    ? `桌面页 ${data.deskBytes ?? 0} 字节 · 生成于 ${fmtTime(deskAt)}`
                    : '桌面页还没生成过'),
                h('button', {
                  type: 'button',
                  disabled: deskBusy,
                  title: '用现有记忆重蒸一次桌面页，不调模型',
                  onClick: () => {
                    if (deskBusy) return
                    setDeskBusy(true)
                    // 走现成的 /desk 端点（夜班同一套 buildDesk），回来再读一次画像。
                    fetch('/dsh-whale-memory/desk', { method: 'POST' })
                      .then((res) => res.json())
                      .then(() => setSeq((n) => n + 1))
                      .catch(() => undefined)
                      .finally(() => setDeskBusy(false))
                  },
                  style: {
                    border: '1px solid currentColor', borderRadius: '6px', padding: '2px 10px',
                    fontSize: '11px', background: 'transparent', color: 'inherit',
                    cursor: deskBusy ? 'progress' : 'pointer', opacity: deskBusy ? 0.5 : 0.85,
                  },
                }, deskBusy ? '蒸着…' : '重新生成桌面页'),
              ),
              files.length === 0
                ? h('p', { style: { fontSize: '11px', opacity: 0.55, margin: 0 } },
                  notesDir === '' ? '没找到画像笔记目录。' : `画像笔记还没写：${notesDir}`)
                : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px' } },
                  ...files.map((f) => h('span', { key: f.name, style: metaStyle },
                    `${f.name} · ${fmtTime(f.mtime)}`))),
              text === ''
                ? h('p', { style: { fontSize: '12px', opacity: 0.55 } }, '还没有画像，等下一次梳理。')
                : h('pre', {
                  style: {
                    fontSize: '12px', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word', margin: 0, fontFamily: 'inherit', opacity: 0.85,
                  },
                }, text),
            )
          }

          if (zone === 'graph') {
            const nodes = Array.isArray(data.nodes) ? data.nodes : []
            const links = Array.isArray(data.edges) ? data.edges : []
            const total = Number(data.total ?? nodes.length)
            const omitted = Math.max(0, total - nodes.length)
            // 每个实体下面要列它的前几条边：先把边摊成「按这一端分组」的表。
            const around = new Map()
            for (const e of links) {
              const w = Number(e.weight ?? e.w ?? 0)
              for (const [me, other] of [[e.a, e.b], [e.b, e.a]]) {
                if (!around.has(me)) around.set(me, [])
                around.get(me).push({ other, w })
              }
            }
            for (const list of around.values()) list.sort((m, n) => n.w - m.w)
            /** 点一个实体：展开它名下最近几条记忆；再点一次收起来。 */
            const openEntity = (name) => {
              if (entity !== null && entity.name === name) { setEntity(null); return }
              setEntity({ name, items: null })
              setMemOpen(null)
              fetch(`/dsh-whale-memory/graph/entity?name=${encodeURIComponent(name)}&space=${encodeURIComponent(spaceNow())}&limit=5`, { headers: { accept: 'application/json' } })
                .then((res) => (res.ok ? res.json() : null))
                .then((json) => setEntity((cur) => (cur !== null && cur.name === name
                  ? { name, items: Array.isArray(json?.items) ? json.items : [] }
                  : cur)))
                .catch(() => setEntity((cur) => (cur !== null && cur.name === name ? { name, items: [] } : cur)))
            }
            // 点一下就能穿过去，所以用按钮而不是纯文字；样式交给继承，别各写一套。
            const linkStyle = {
              border: 'none', background: 'transparent', cursor: 'pointer',
              color: 'inherit', padding: 0, textAlign: 'left', font: 'inherit',
            }
            const spaceList = spaces === null || spaces.length === 0
              ? [{ id: spaceNow(), count: 0 }]
              : spaces
            const scene = graphScene

            /** 展开的实体：图上点圆点、列表里点名字，共用这一块（在画布下方）。 */
            const entityPanel = entity === null ? null : h('div', {
              style: {
                border: '1px solid rgba(128,128,128,0.25)', borderRadius: '6px',
                padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: '4px',
              },
            },
              h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' } },
                h('span', { style: { fontSize: '12px' } }, `● ${entity.name}`),
                h('span', { style: { fontSize: '11px', opacity: 0.5, fontFamily: 'monospace' } },
                  entity.items === null ? '读取中…' : `最近 ${entity.items.length} 条`),
              ),
              entity.items === null
                ? h('p', { style: { fontSize: '11px', opacity: 0.55, margin: 0 } }, '读取中…')
                : entity.items.length === 0
                  ? h('p', { style: { fontSize: '11px', opacity: 0.55, margin: 0 } }, '这个名字下暂时查不到原文。')
                  : h('ol', { style: { display: 'flex', flexDirection: 'column', gap: '4px', margin: 0, padding: '0 0 0 16px' } },
                    ...entity.items.map((it) => h('li', { key: String(it.id), style: { fontSize: '11px', lineHeight: 1.5 } },
                      h('div', {
                        onClick: () => setMemOpen(memOpen === it.id ? null : it.id),
                        style: { cursor: 'pointer', opacity: 0.85 },
                      }, `${fmtTime(it.t)} · ${it.u}`),
                      memOpen === it.id && String(it.a ?? '') !== ''
                        ? h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.5 } }, it.a)
                        : null,
                    ))),
            )

            /** 列表视图（上一版那一列，留着没删）：谁、几次、连了谁。 */
            const renderList = () => {
              const rows = nodes.map((n) => {
                const opened = entity !== null && entity.name === n.name
                const mine = (around.get(n.name) ?? []).slice(0, 5)
                const last = Number(n.lastHit ?? 0)
                return h('li', { key: n.name, style: { padding: '4px 0', borderBottom: '1px solid rgba(128,128,128,0.12)' } },
                  h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px' } },
                    h('button', { type: 'button', onClick: () => openEntity(n.name), style: { ...linkStyle, fontSize: '12px' } },
                      `${opened ? '▾' : '▸'} ${n.name}`),
                    h('span', { style: { fontSize: '11px', opacity: 0.5, fontFamily: 'monospace', flexShrink: 0 } },
                      `${n.count ?? 0} 条 · 度 ${n.degree ?? 0} · ${last > 0 ? `最近出现在 ${fmtTime(last)}` : '还没记到时间'}`),
                  ),
                  mine.length === 0 ? null
                    : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '2px 12px', marginTop: '2px' } },
                      ...mine.map((e) => h('button', {
                        key: e.other,
                        type: 'button',
                        title: '切到这个实体',
                        onClick: () => openEntity(e.other),
                        style: { ...linkStyle, fontSize: '11px', opacity: 0.7 },
                      }, `${n.name} ↔ ${e.other} ×${e.w}`))),
                )
              })
              if (nodes.length === 0) {
                return h('p', { style: { fontSize: '12px', opacity: 0.6, margin: 0 } }, '这段记忆里还没攒出实体，等记忆再多一点。')
              }
              return h('ol', { style: { display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyle: 'none' } }, ...rows)
            }

            /**
             * 图视图：原生 SVG + 手写力导向。坐标来自 buildGraphScene（纯函数、可复现），
             * 这里只管把它画出来和接手势。
             */
            const renderGraph = () => {
              if (scene === null) return null
              // 悬停高亮：它的边、它的对端，其余压暗。
              const lit = hover === null ? null : new Set(
                [hover, ...scene.edges.filter((e) => e.a === hover || e.b === hover).flatMap((e) => [e.a, e.b])],
              )
              const zoomBy = (f) => setCam((c) => {
                const next = Math.min(CAM_MAX, Math.max(CAM_MIN, c.k * f))
                const g = next / c.k
                const mx = GL_W / 2
                const my = GL_H / 2
                return { k: next, x: mx - (mx - c.x) * g, y: my - (my - c.y) * g }
              })
              const resetCam = () => setCam({ k: 1, x: 0, y: 0 })
              const panDown = (ev) => {
                if (ev.button !== 0) return
                panRef.current = { x: ev.clientX, y: ev.clientY, cam }
                if (typeof ev.currentTarget.setPointerCapture === 'function') {
                  ev.currentTarget.setPointerCapture(ev.pointerId)
                }
              }
              const panMove = (ev) => {
                const from = panRef.current
                if (from === null) return
                const el = svgRef.current
                const rect = el === null ? null : el.getBoundingClientRect()
                if (rect === null || rect.width <= 0 || rect.height <= 0) return
                // 屏幕像素 → viewBox 像素：画布宽度是缩放的，得换算，不然拖起来发飘。
                setCam({
                  k: from.cam.k,
                  x: from.cam.x + (ev.clientX - from.x) * (GL_W / rect.width),
                  y: from.cam.y + (ev.clientY - from.y) * (GL_H / rect.height),
                })
              }
              const panUp = () => { panRef.current = null }
              const camBtn = (label, title, onClick) => h('button', {
                type: 'button', title, onClick,
                style: {
                  border: '1px solid currentColor', borderRadius: '6px', padding: '1px 7px',
                  fontSize: '12px', lineHeight: 1.4, background: 'rgba(0,0,0,0.04)',
                  color: 'inherit', cursor: 'pointer', opacity: 0.85,
                },
              }, label)
              return h('div', { style: { position: 'relative' } },
                h('div', { style: { position: 'relative' } },
                  h('svg', {
                    ref: svgRef,
                    viewBox: `0 0 ${GL_W} ${GL_H}`,
                    role: 'img',
                    'aria-label': `实体关系图：${scene.stats.nodes} 个实体，画了 ${scene.stats.edgesDrawn} 条边`,
                    onPointerDown: panDown,
                    onPointerMove: panMove,
                    onPointerUp: panUp,
                    onPointerCancel: panUp,
                    onDoubleClick: resetCam,
                    style: {
                      width: '100%', height: 'auto', display: 'block',
                      border: '1px solid rgba(128,128,128,0.2)', borderRadius: '6px',
                      touchAction: 'none', userSelect: 'none',
                      cursor: panRef.current === null ? 'grab' : 'grabbing',
                    },
                  },
                    h('g', {
                      transform: `translate(${glR2(cam.x)} ${glR2(cam.y)}) scale(${Math.round(cam.k * 1000) / 1000})`,
                    },
                      ...scene.edges.map((e, i) => {
                        const near = hover !== null && (e.a === hover || e.b === hover)
                        return h('line', {
                          key: `e${i}`,
                          x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2,
                          stroke: 'currentColor',
                          strokeOpacity: lit !== null && !near ? 0.04 : Math.min(0.9, e.opacity + (near ? 0.35 : 0)),
                          strokeWidth: near ? e.width + 0.8 : e.width,
                          style: { pointerEvents: 'none' },
                        })
                      }),
                      ...scene.nodes.map((n) => {
                        const on = lit === null || lit.has(n.name)
                        const picked = entity !== null && entity.name === n.name
                        return h('g', {
                          key: n.name,
                          onPointerEnter: () => setHover(n.name),
                          onPointerLeave: () => setHover(null),
                          // 点圆点只开实体面板，不开平移：把事件挡住，别冒到画布上。
                          onPointerDown: (ev) => ev.stopPropagation(),
                          onClick: () => openEntity(n.name),
                          style: { cursor: 'pointer', opacity: on ? 1 : 0.22 },
                        },
                          h('circle', {
                            cx: n.x, cy: n.y, r: n.r,
                            fill: 'currentColor',
                            fillOpacity: picked ? 0.55 : 0.22,
                            stroke: 'currentColor',
                            strokeOpacity: picked || hover === n.name ? 0.95 : 0.45,
                            strokeWidth: picked || hover === n.name ? 1.4 : 0.8,
                          }),
                          // 全名放 title 里：标签怎么折行，悬停/无障碍读到的都是原文。
                          h('title', null, n.name),
                          ...(n.label === null ? [] : n.label.lines.map((line, i) => h('text', {
                            key: `t${i}`,
                            x: glR2(n.label.x + n.label.w / 2),
                            y: glR2(n.label.y + n.label.lineHeight * i + n.label.fontSize),
                            textAnchor: 'middle',
                            fontSize: n.label.fontSize,
                            fill: 'currentColor',
                            fillOpacity: picked || hover === n.name ? 0.95 : 0.72,
                            style: { pointerEvents: 'none' },
                          }, line))),
                        )
                      }),
                    ),
                  ),
                  h('div', { style: { position: 'absolute', top: '6px', right: '6px', display: 'flex', gap: '4px' } },
                    camBtn('＋', '放大（也可以滚轮）', () => zoomBy(1.25)),
                    camBtn('－', '缩小（也可以滚轮）', () => zoomBy(0.8)),
                    camBtn('复位', '回到 1×（也可以双击画布）', resetCam)),
                ),
                h('p', { style: { fontSize: '11px', opacity: 0.55, margin: '4px 0 0' } },
                  `滚轮缩放（以鼠标那点为中心，${CAM_MIN}×～${CAM_MAX}×）· 按住拖动平移 · 双击复位 · 缩放到 ${GL_LABEL_ZOOM}× 以上显示全部名字（度最高的 ${GL_TOP} 个一直显示）· 点圆点看它名下最近 5 条`),
              )
            }

            const viewTab = (key, label) => h('button', {
              type: 'button',
              onClick: () => setGraphMode(key),
              style: {
                border: '1px solid currentColor', borderRadius: '6px', padding: '2px 10px',
                fontSize: '11px', cursor: 'pointer', color: 'inherit', background: 'transparent',
                opacity: graphMode === key ? 1 : 0.5,
              },
            }, label)

            return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                h('label', { style: { fontSize: '11px', opacity: 0.65, display: 'flex', alignItems: 'center', gap: '4px' } },
                  '空间',
                  h('select', {
                    value: spaceNow(),
                    onChange: (e) => setGraphSpace(e.target.value),
                    style: { fontSize: '11px', padding: '1px 4px', borderRadius: '4px', border: '1px solid currentColor', background: 'transparent', color: 'inherit' },
                  }, ...spaceList.map((sp) => h('option', { key: sp.id, value: sp.id }, `${sp.id} · ${sp.count ?? 0} 条`)))),
                h('span', { style: metaStyle },
                  scene === null
                    ? `实体 ${total} 个 · 边 ${links.length} 条`
                    : `实体 ${scene.stats.nodes} 个${omitted > 0 ? `（省略 ${omitted}）` : ''} · 边 ${scene.stats.edgesTotal} 条，画前 ${scene.stats.edgesDrawn} 条`),
                h('button', {
                  type: 'button',
                  title: '换一种排法（影响取哪几个实体）',
                  onClick: () => setGraphSort(graphSort === 'count' ? 'degree' : 'count'),
                  style: { border: '1px solid currentColor', borderRadius: '6px', padding: '2px 8px', fontSize: '11px', background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: 0.85 },
                }, graphSort === 'count' ? '按出现次数排' : '按联系数排'),
                h('div', { style: { display: 'flex', gap: '4px' } }, viewTab('graph', '图'), viewTab('list', '列表')),
                graphMode !== 'graph' ? null
                  : h('label', { style: { fontSize: '11px', opacity: 0.65, display: 'flex', alignItems: 'center', gap: '4px' } },
                    '边',
                    h('select', {
                      value: graphEdges,
                      onChange: (e) => setGraphEdges(Number(e.target.value)),
                      title: '画权重最高的前几条边',
                      style: { fontSize: '11px', padding: '1px 4px', borderRadius: '4px', border: '1px solid currentColor', background: 'transparent', color: 'inherit' },
                    }, ...[40, 80, 120, 200, 400].map((n) => h('option', { key: n, value: n }, `${n} 条`)))),
              ),
              nodes.length === 0
                ? h('p', { style: { fontSize: '12px', opacity: 0.6, margin: 0 } }, '这段记忆里还没攒出实体，等记忆再多一点。')
                : graphMode === 'graph' ? renderGraph() : renderList(),
              nodes.length > 0 && links.length === 0
                ? h('p', { style: { fontSize: '11px', opacity: 0.5, margin: 0, lineHeight: 1.6 } },
                  '还没攒够共现，等记忆再多一点：一条边要被两条以上的记忆同时提到才留下（至少出现 2 次）。')
                : null,
              entityPanel,
            )
          }

          if (zone === 'spaces') {
            const list = Array.isArray(data.spaces) ? data.spaces : []
            if (list.length === 0) return h('p', { style: { fontSize: '12px', opacity: 0.55 } }, '还没有空间记录。')
            const spaceFailed = spaceSave !== undefined && spaceSave !== null && spaceSave.status === 'error'
            return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              h('p', { style: { fontSize: '11px', opacity: 0.55, margin: 0 } },
                `当前空间：${currentSpace || 'default'}。换一个空间后，写进去和想起来的都只看那一格。`),
              spaceSave === undefined || spaceSave === null
                ? null
                : h('p', {
                  role: 'status',
                  style: { fontSize: '11px', margin: 0, color: spaceFailed ? '#ff8f8f' : 'inherit', opacity: spaceFailed ? 1 : 0.55 },
                }, spaceFailed ? `切换失败：${spaceSave.message ?? '未知原因'}` : writeStateOf(spaceSave)),
              ...list.map((sp) => h('div', {
                key: sp.id,
                style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '4px 0', borderBottom: '1px solid rgba(128,128,128,0.15)' },
              },
                h('span', { style: { fontSize: '12px' } }, `${sp.id === (currentSpace || 'default') ? '● ' : ''}${sp.id} · ${sp.count} 条`),
                h('button', {
                  type: 'button',
                  disabled: typeof onSwitchSpace !== 'function' || sp.id === (currentSpace || 'default') || spaceBusy,
                  onClick: async () => {
                    if (typeof onSwitchSpace !== 'function' || spaceBusy) return
                    setSpaceBusy(true)
                    try { await onSwitchSpace(sp.id) } finally { setSpaceBusy(false) }
                  },
                  style: { border: '1px solid currentColor', borderRadius: '6px', padding: '2px 8px', fontSize: '11px', background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: sp.id === (currentSpace || 'default') ? 0.4 : 0.9 },
                }, '切到这个空间'),
              )),
            )
          }

          if (zone === 'scenes') {
            if (items.length === 0) {
              // 空列表不是错误：说清「为什么现在还没有」，比一句「空」有用。
              return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                h('p', { style: { fontSize: '12px', opacity: 0.7, margin: 0 } }, '还没有成段的场景。'),
                h('p', { style: { fontSize: '11px', opacity: 0.5, margin: 0, lineHeight: 1.6 } },
                  '同一个线索词至少要串起两条记忆才会成一段：先把话攒着，夜班梳理完（或右上「刷新」）就会出现。刚删掉的那一段不会自己长回来。'))
            }
            return h('ol', { style: { display: 'flex', flexDirection: 'column', gap: '12px', margin: 0, padding: '0 0 0 18px' } },
              ...items.map((item) => h('li', { key: `${item.space ?? ''}:${item.topic}`, style: { fontSize: '12px', lineHeight: 1.5 } },
                h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px' } },
                  h('span', { style: { fontSize: '11px', opacity: 0.5, fontFamily: 'monospace' } },
                    `${item.topic} · ${item.count ?? 0} 条记忆 · ${(item.lastHit ?? 0) > 0 ? `最近召回 ${fmtTime(item.lastHit)}` : '还没被召回'}`),
                  h('button', {
                    type: 'button',
                    title: '删掉这一段（原文还在记忆里）',
                    onClick: async () => {
                      if (!window.confirm(`删掉场景「${item.topic}」？原文不会丢，只是这一段不再被当作一段经历取用。`)) return
                      const ok = await postJson('/dsh-whale-memory/scenes/delete', { topic: item.topic, space: item.space ?? 'default' })
                      if (ok) setSeq((n) => n + 1)
                    },
                    style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '11px', opacity: 0.55, padding: 0, color: 'inherit', flexShrink: 0 },
                  }, '删'),
                ),
                h('pre', {
                  style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '2px 0 0', fontFamily: 'inherit', opacity: 0.8 },
                }, item.body),
              )))
          }

          if (items.length === 0) return h('p', { style: { fontSize: '12px', opacity: 0.55 } }, '这条区是空的。')
          return h('ol', { style: { display: 'flex', flexDirection: 'column', gap: '10px', margin: 0, padding: '0 0 0 18px' } },
            ...items.map((item) => h('li', { key: String(item.id), style: { fontSize: '12px', lineHeight: 1.5 } },
              h('div', { style: { fontSize: '11px', opacity: 0.5, fontFamily: 'monospace' } },
                `${fmtTime(item.at)} · 权重 ${Math.round(item.weight * 10) / 10}${
                  (item.emo ?? []).length === 0 ? '' : ` · ${(item.emo ?? []).map((k) => EMO_TEXT[k] ?? k).join('/')}`
                }`),
              h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, item.user),
              item.assistant === '' ? null
                : h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.55 } }, item.assistant),
              h('div', { style: { display: 'flex', gap: '10px', marginTop: '2px' } },
                h('button', {
                  type: 'button',
                  onClick: async () => {
                    const next = window.prompt('改成什么？（只改用户侧那条）', item.user)
                    if (next === null || next.trim() === '') return
                    const ok = await postJson('/dsh-whale-memory/entries/correct', { id: item.id, text: next })
                    if (ok) setSeq((n) => n + 1)
                  },
                  style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '11px', opacity: 0.55, padding: 0, color: 'inherit' },
                }, '改'),
                h('button', {
                  type: 'button',
                  onClick: async () => {
                    if (!window.confirm('撤回这条记忆？原件会留在 revisions 里。')) return
                    const ok = await postJson('/dsh-whale-memory/entries/retract', { id: item.id })
                    if (ok) setSeq((n) => n + 1)
                  },
                  style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '11px', opacity: 0.55, padding: 0, color: 'inherit' },
                }, '撤回'),
              ),
            )))
        })()

        return h(
          'section',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('h3', { style: { fontSize: '13px', margin: '0 0 2px' } }, '记忆内容'),
          h(
            'p',
            { style: { fontSize: '11px', opacity: 0.6, margin: '0 0 4px' } },
            '只读，只是看一眼存了什么。热区是最近还在上下文里的，冷区是压下去、被想起时才取用的；场景是同一条线索串起来的一段（可以单条删掉，原文不丢），画像则是从记忆里蒸出来的「我记得的你」。',
          ),
          actErr === ''
            ? null
            : h('p', { style: { fontSize: '11px', color: '#ff8f8f', margin: '0 0 4px', lineHeight: 1.5 } }, actErr),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', flexWrap: 'wrap' } },
            tab('hot', '热区'),
            tab('cold', '冷区'),
            tab('scenes', '场景'),
            tab('persona', '画像'),
            tab('graph', '图谱'),
            tab('spaces', '空间'),
            h('span', { style: { ...metaStyle, marginLeft: '4px' } },
              data === null ? '' : (zone === 'persona' || zone === 'graph' || zone === 'spaces') ? '' : `${data.total ?? 0} 条，显示 ${data.shown ?? items.length}`),
            h('button', {
              type: 'button',
              onClick: () => setSeq((n) => n + 1),
              title: '重新读一次',
              style: {
                border: 'none', background: 'transparent', cursor: 'pointer',
                fontSize: '11px', opacity: 0.6, padding: '2px 4px', color: 'inherit',
              },
            }, '刷新'),
          ),
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', padding: '0 0 4px' } },
            h('input', {
              value: q,
              onChange: (e) => setQ(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') setSeq((n) => n + 1) },
              placeholder: '搜关键字',
              style: { flex: '1 1 auto', minWidth: '80px', fontSize: '12px', padding: '2px 6px', borderRadius: '4px', border: '1px solid currentColor', background: 'transparent', color: 'inherit' },
            }),
            h('button', {
              type: 'button',
              onClick: () => setSeq((n) => n + 1),
              style: { border: '1px solid currentColor', borderRadius: '6px', padding: '2px 8px', fontSize: '12px', background: 'transparent', color: 'inherit', cursor: 'pointer' },
            }, '搜'),
            h('label', { style: { fontSize: '11px', opacity: 0.65, display: 'flex', alignItems: 'center', gap: '3px' } },
              h('input', { type: 'checkbox', checked: allSpaces, onChange: (e) => setAllSpaces(e.target.checked) }),
              '全部空间',
            ),
          ),
          body,
        )
      }

      /** 本地日期键：给「今天发了多少条」这类按天统计用。 */
      const localDayKey = () => {
        const d = new Date()
        const p2 = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
      }

      /** 状态里的一个小数字卡片。 */
      const Stat = (label, value, hint) => h('div', {
        key: label,
        style: {
          border: '1px solid rgba(128,128,128,0.18)',
          borderRadius: '10px',
          padding: '8px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: '1px',
          background: 'rgba(128,128,128,0.05)',
          minWidth: 0,
        },
      },
      h('span', { style: { fontSize: '10px', opacity: 0.5, letterSpacing: '0.04em' } }, label),
      h('span', { style: { fontSize: '17px', fontWeight: 600, lineHeight: 1.2 } }, value),
      hint ? h('span', { style: { fontSize: '10px', opacity: 0.45, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, hint) : null,
      )

      /**
       * 崩了就把错误摊开写在页面上，别整块空白——
       * 设置页白屏最难查，连从哪儿错都不知道。
       */
      class SectionBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }

        static getDerivedStateFromError(error) {
          return { error }
        }

        componentDidCatch(error, info) {
          console.error('[whale-memory] 设置页崩了', error, info?.componentStack)
        }

        render() {
          if (this.state.error !== null) {
            return h('pre', {
              style: {
                fontSize: '11px',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                color: '#ff8f8f',
                margin: 0,
                padding: '8px 0',
              },
            }, `设置页崩了：${String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)}\n\n${String(this.state.error && this.state.error.stack ? this.state.error.stack : '')}`)
          }
          return this.props.children
        }
      }

      const Panel = () => {
        // 两个命名空间，各自一份快照。服务缺席时用占位表单，
        // 这样 hooks 的顺序和数量每轮都一样。
        const memoryForm = formOf(NS) ?? NULL_FORM
        const proactiveForm = formOf(PROACTIVE_NS) ?? NULL_FORM

        const useSnap = (form) => React.useSyncExternalStore(
          (cb) => form.subscribe(cb),
          () => form.getSnapshot(),
          // 第三个参数让这个组件也能在服务端渲染（测试用），浏览器里不会走到。
          () => form.getSnapshot(),
        )
        const snaps = { memory: useSnap(memoryForm), proactive: useSnap(proactiveForm) }
        const forms = { memory: memoryForm, proactive: proactiveForm }

        const [memoryStatus, setMemoryStatus] = React.useState(null)
        const [proactiveStatus, setProactiveStatus] = React.useState(null)
        const [trend, setTrend] = React.useState(null)
        const [selfCheck, setSelfCheck] = React.useState(null)
        const [nightBusy, setNightBusy] = React.useState(false)
        const [nightNote, setNightNote] = React.useState('')
        const [tick, setTick] = React.useState(0)
        // 每个字段的写回执：key = 字段路径。写中…/已保存/失败：原因，就地显示。
        const [save, setSave] = React.useState({})
        const saveStateFor = (key) => (state) => setSave((prev) => ({ ...prev, [key]: state }))

        React.useEffect(() => {
          let alive = true
          const load = (url, setter) => {
            fetch(url, { headers: { accept: 'application/json' } })
              .then((res) => (res.ok ? res.json() : null))
              .then((json) => { if (alive && json) setter(json) })
              .catch(() => { /* 拿不到就不显示这行 */ })
          }
          load(STATUS_URL, setMemoryStatus)
          load(PROACTIVE_STATUS_URL, setProactiveStatus)
          load('/dsh-whale-memory/trend?days=7', setTrend)
          load(SELF_CHECK_URL, setSelfCheck)
          return () => { alive = false }
        }, [tick])

        if (formOf(NS) === null && formOf(PROACTIVE_NS) === null) {
          return h('p', { style: { fontSize: '13px', opacity: 0.75 } }, '设置服务不可用（DSH 版本偏旧？），参数只能改配置文件。')
        }

        const available = GROUPS.filter((g) => snaps[g.form].status === 'ready')
        if (available.length === 0) {
          if (snaps.memory.status === 'loading' || snaps.proactive.status === 'loading') {
            return h('p', { style: { fontSize: '13px', opacity: 0.6 } }, '读取中…')
          }
          return h('p', { style: { fontSize: '13px', opacity: 0.75 } }, '这两个插件条目都没有暴露配置，先确认它们已经在 profile 里启用。')
        }

        const statGrid = memoryStatus === null
          ? null
          : h('div', {
            style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(88px, 1fr))', gap: '8px' },
          },
          Stat('热区', `${memoryStatus.hot ?? '?'} 条`),
          Stat('冷区', `${memoryStatus.cold ?? '?'} 条`),
          Stat('事实', `${memoryStatus.facts ?? '?'} 条`),
          Stat('场景', `${memoryStatus.scenes ?? 0} 段`),
          Stat('空间', `${memoryStatus.spaces ?? 0} 个`, String(memoryStatus.spaceConfigured ?? 'default')),
          Stat('向量', memoryStatus.embedOk ? '正常' : '降级'),
          Stat('想起', `${memoryStatus.stats?.recalled ?? 0} 次`),
          Stat('蒸馏', `${memoryStatus.stats?.distillCalls ?? 0} 次`),
          Stat('桌面页', selfCheck === null ? '?' : `${selfCheck.deskBytes ?? 0} 字节`),
          Stat('今晚并入', selfCheck === null ? '?' : `${selfCheck.mergedTonight ?? 0} 条`),
          )

        const footNotes = []
        if (memoryStatus !== null) {
          footNotes.push(`抢救 ${memoryStatus.stats?.salvaged ?? 0} · 合并 ${memoryStatus.stats?.merged ?? 0} · 记忆库 ${memoryStatus.dbPath ?? ''}`)
        }
        if (trend !== null && Array.isArray(trend.series) && trend.series.length > 0) {
          footNotes.push(`近 7 天：${trend.series.map((d) => `${d.day.slice(5)} 蒸馏 ${d.distillCalls ?? 0} / 想起 ${d.recalled ?? 0}`).join('　')}`)
        }
        if (proactiveStatus !== null) {
          // lastSentAt 是状态里真实存在的字段；以前读 decision.reason，那里根本没有，
          // 于是永远显示一个「?」——宁可说「还没跑过」，也不摆个问号糊弄。
          const lastSentAt = proactiveStatus.state?.lastSentAt
          footNotes.push(`主动消息：${proactiveStatus.isQuietHours ? '免打扰中' : '可发'} · 今天 ${proactiveStatus.state?.dailyCount?.[localDayKey()] ?? 0} 条 · ${lastSentAt ? `上次开口 ${fmtTime(Number(lastSentAt))}` : '还没跑过'}`)
        }

        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '6px 0 10px' } },
          h('header', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' },
          },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 } },
            h('h2', { style: { fontSize: '16px', margin: 0, fontWeight: 600 } }, '鲸娘记忆'),
            h('span', { style: { fontSize: '11px', opacity: 0.45, fontFamily: 'monospace' } },
              `v${memoryStatus?.pluginVersion ?? '?'}`),
          ),
          h('button', {
            type: 'button',
            onClick: () => setTick((n) => n + 1),
            style: {
              border: '1px solid rgba(128,128,128,0.35)',
              borderRadius: '999px',
              padding: '2px 10px',
              fontSize: '11px',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              opacity: 0.75,
              flexShrink: 0,
            },
          }, '刷新'),
          ),
          statGrid,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              disabled: nightBusy,
              onClick: () => {
                if (nightBusy) return
                // 手动跑一班是会动真数据的：先说清它要做哪两件事，再问要不要。
                const pending = Number.isFinite(Number(selfCheck?.mergedTonight)) ? Number(selfCheck.mergedTonight) : null
                const ask = [
                  '手动跑一班夜班？它现在会做两件事：',
                  `1) 把今天新攒的记忆并入日档（现在 ${pending === null ? '数未知' : `${pending} 条`}）；`,
                  '2) 清理冷区里太老、权重又低的条目。',
                  '',
                  '要现在跑吗？',
                ].join('\n')
                if (!window.confirm(ask)) return
                setNightBusy(true)
                setNightNote('')
                fetch(NIGHTLY_URL, { method: 'POST' })
                  .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
                  .then((json) => {
                    if (json?.ok !== true) {
                      setNightNote(`没跑成：${json?.reason ?? json?.errors?.[0] ?? '未知原因'}`)
                      return
                    }
                    // 真数从 nightly 的返回里取；取不到就说「清理数未知」，不编一个 0。
                    const merged = Number.isFinite(Number(json.merged)) ? `${Number(json.merged)}` : '数未知'
                    const prunedRaw = json?.settle?.pruned
                    const pruned = Number.isFinite(Number(prunedRaw)) ? `清理 ${Number(prunedRaw)}` : '清理数未知'
                    setNightNote(`跑完了：并入 ${merged} / ${pruned}`)
                    setTick((n) => n + 1)
                  })
                  .catch((error) => setNightNote(`没跑成：${String(error?.message ?? '请求失败')}`))
                  .finally(() => setNightBusy(false))
              },
              style: {
                border: '1px solid rgba(128,128,128,0.35)',
                borderRadius: '999px',
                padding: '3px 12px',
                fontSize: '11px',
                background: 'transparent',
                color: 'inherit',
                cursor: nightBusy ? 'progress' : 'pointer',
                opacity: nightBusy ? 0.5 : 0.85,
              },
            }, nightBusy ? '跑着…' : '立刻跑一班'),
            h('span', { style: { fontSize: '11px', opacity: 0.55 } },
              nightNote !== '' ? nightNote : (selfCheck?.logFile ? `日志：${selfCheck.logFile}` : '')),
          ),
          ...footNotes.map((text, i) => h('p', {
            key: `n${i}`,
            style: { fontSize: '11px', opacity: 0.55, margin: 0, lineHeight: 1.6 },
          }, text)),
          // 只读态不是「控件灰了」就完事：说清为什么灰、要改该动哪个文件。
          snaps.memory.writable || available.every((g) => g.form !== 'memory')
            ? null
            : h('p', {
              style: { fontSize: '11px', color: '#ff8f8f', margin: 0, lineHeight: 1.6 },
            }, '配置文件只读（writable=false），下面这些控件改不了。要改请手改 ~/.dsh/profiles/web/cordis.patch.yml 里 dsh-whale-memory 的 config 段（改完重启 dsh）。'),
          // 写操作的回执说明：干等一个「值没变」看不出写没写进去。
          h('p', {
            style: { fontSize: '11px', opacity: 0.5, margin: 0, lineHeight: 1.6 },
          }, '每行改动都会立刻写进配置：写中… → 已保存；失败会在行尾用红字写明原因。'),
          h('div', {
            style: {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: '12px',
              alignItems: 'start',
            },
          },
          ...available.map((group) => {
            const form = forms[group.form]
            const snap = snaps[group.form]
            const disabled = !snap.writable
            return h(
              'section',
              {
                key: group.title,
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  border: '1px solid rgba(128,128,128,0.18)',
                  borderRadius: '10px',
                  padding: '10px 12px 4px',
                  minWidth: 0,
                },
              },
              h('h3', { style: { fontSize: '13px', margin: '0 0 2px', fontWeight: 600 } }, group.title),
              h('p', { style: { fontSize: '11px', opacity: 0.55, margin: '0 0 4px', lineHeight: 1.5 } }, group.hint),
              ...group.fields.map((field) => {
                const key = PATH_TEXT(field.path)
                return h(Row, {
                  key,
                  field,
                  value: pick(snap.value, field.path),
                  base: snap.base,
                  overridden: pick(snap.user, field.path) !== undefined,
                  disabled,
                  save: save[key],
                  onWrite: (value) => writePath(form, field.path, value, saveStateFor(key)),
                  onReset: () => resetPath(form, field.path, saveStateFor(key)),
                })
              }),
            )
          }),
          ),
          h(EntriesView, {
            key: 'entries',
            // 配置里的空间，不是「最后一条记忆的 space」——后者会随写入漂走，
            // 让「当前空间」随时说谎。旧字段保留给别处用，这里只认配置。
            currentSpace: memoryStatus?.spaceConfigured ?? memoryStatus?.space ?? 'default',
            spaceSave: save.space,
            onSwitchSpace: (name) => writePath(memoryForm, ['space'], String(name), saveStateFor('space')),
          }),
        )
      }

      const slots = ctx.get('slots')
      if (!slots || typeof slots.register !== 'function') return

      const Guarded = () => h(SectionBoundary, null, h(Panel))

      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: NS, order: 60, label: () => '鲸娘记忆' },
        Guarded,
      ))
    }

    exports.name = 'dsh-whale-memory'
    exports.inject = ['slots']
    /** 纯函数，自检直接调，不用起浏览器。 */
    exports.__test = {
      pick, writePath, resetPath, normalizeNumber, GROUPS, writeStateOf,
      // 图谱几何也是纯函数：测试和 scripts/graph-svg.mjs 借这一口直接调，不复制布局代码。
      graphScene: buildGraphScene, graphLabel: glLabel, GL_W, GL_H, CAM_MIN, CAM_MAX, GL_LABEL_ZOOM,
    }
    exports.apply = apply
    return module.exports
  },
})
