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
        hint: '每次对话开头塞多少记忆进上下文。数字越小越省 token。',
        fields: [
          { path: ['budgetChars'], label: '注入字符上限', kind: 'int', min: 50, max: 50000 },
          { path: ['recentPairs'], label: '热区保留轮数', kind: 'int', min: 0, max: 100 },
          { path: ['factMax'], label: '稳定事实条数', kind: 'int', min: 0, max: 500 },
        ],
      },
      {
        form: 'memory',
        title: '主动联想',
        hint: '它会不会自己想起旧事。门槛调高，它就安静一些。',
        fields: [
          { path: ['recallMax'], label: '每轮最多想起几条', kind: 'int', min: 0, max: 50 },
          { path: ['recallThreshold'], label: '想起门槛', kind: 'num', min: 0, max: 1000 },
          { path: ['weightMax'], label: '权重上限', kind: 'num', min: 1, max: 10000 },
        ],
      },
      {
        form: 'memory',
        title: '记忆空间',
        hint: '同一份库按空间隔离：换一个空间，写进去和想起来的都只看那一格。',
        fields: [
          { path: ['space'], label: '当前空间', kind: 'string' },
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

    /** 写入一个字段：一级字段走 set，嵌套字段走 mutate + 路径。 */
    const writePath = (form, path, value) => {
      const done = path.length === 1
        ? form.set(path[0], value)
        : form.mutate([{ op: 'set', path, value }])
      done.catch(() => undefined)
    }

    /** 清掉用户覆盖，让字段回到 schema 默认值。 */
    const resetPath = (form, path) => {
      const done = path.length === 1
        ? form.unset(path[0])
        : form.mutate([{ op: 'unset', path }])
      done.catch(() => undefined)
    }

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

      /** 一行设置：标签 + 控件 + 覆盖标记。 */
      const Row = ({ field, value, overridden, disabled, onWrite, onReset }) => {
        // 输入框自己存草稿：敲字时只改草稿，失焦或回车才写进去。
        // 否则每敲一个数字就提交一次，Host 一回写就把光标和内容顶回去。
        const asText = (v) => (v === undefined || v === null ? '' : String(v))
        const [draft, setDraft] = React.useState(asText(value))
        const [typing, setTyping] = React.useState(false)

        React.useEffect(() => {
          if (!typing) setDraft(asText(value))
        }, [value, typing])

        const commit = () => {
          setTyping(false)
          const result = normalizeNumber(field, draft, value)
          if (result.clamped === true) setDraft(asText(result.value))
          if (result.write === true) onWrite(result.value)
          else if (draft.trim() === '' || !Number.isFinite(Number(draft))) setDraft(asText(value))
        }

        const control = (() => {
          if (field.kind === 'string') {
            const commitText = () => {
              setTyping(false)
              const next = String(draft).trim()
              if (next !== String(value ?? '')) onWrite(next)
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
            const checked = value === true
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

        return h(
          'div',
          { style: rowStyle },
          h(
            'div',
            { style: labelStyle },
            h('span', { style: nameStyle }, field.label),
            h(
              'span',
              { style: metaStyle },
              overridden ? `${PATH_TEXT(field.path)} · 已改` : PATH_TEXT(field.path),
              range === '' ? '' : `  (${range})`,
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
      const EntriesView = ({ onSwitchSpace, currentSpace }) => {
        const [zone, setZone] = React.useState('cold')
        const [data, setData] = React.useState(null)
        const [failed, setFailed] = React.useState(false)
        const [seq, setSeq] = React.useState(0)
        const [q, setQ] = React.useState('')
        const [allSpaces, setAllSpaces] = React.useState(false)

        const urlOf = (z) => {
          const extra = `&keyword=${encodeURIComponent(q)}&all=${allSpaces ? 1 : 0}`
          if (z === 'scenes') return '/dsh-whale-memory/scenes'
          if (z === 'persona') return '/dsh-whale-memory/persona'
          if (z === 'graph') return '/dsh-whale-memory/graph'
          if (z === 'spaces') return '/dsh-whale-memory/spaces'
          return `/dsh-whale-memory/entries?zone=${z}&limit=50${extra}`
        }

        React.useEffect(() => {
          let alive = true
          setFailed(false)
          fetch(urlOf(zone), { headers: { accept: 'application/json' } })
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
            .then((json) => { if (alive) setData(json) })
            .catch(() => { if (alive) { setData(null); setFailed(true) } })
          return () => { alive = false }
        }, [zone, seq, allSpaces])

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

        const items = data === null ? [] : (data.items ?? [])

        const body = (() => {
          if (failed) return h('p', { style: { fontSize: '12px', opacity: 0.7 } }, '读不到记忆库。')
          if (data === null) return h('p', { style: { fontSize: '12px', opacity: 0.55 } }, '读取中…')

          if (zone === 'persona') {
            const text = String(data.text ?? '')
            return text === ''
              ? h('p', { style: { fontSize: '12px', opacity: 0.55 } }, '还没有画像，等下一次梳理。')
              : h('pre', {
                style: {
                  fontSize: '12px', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word', margin: 0, fontFamily: 'inherit', opacity: 0.85,
                },
              }, text)
          }

          if (zone === 'graph') {
            const nodes = Array.isArray(data.nodes) ? data.nodes : []
            const links = Array.isArray(data.edges) ? data.edges : []
            if (nodes.length === 0) return h('p', { style: { fontSize: '12px', opacity: 0.55 } }, '图谱还是空的。')
            const W = 560
            const H = 320
            const shown = nodes.slice(0, 40)
            const names = new Set(shown.map((n) => n.name))
            const edges = links.filter((e) => names.has(e.a) && names.has(e.b))
            // 便宜的三段式布局：圆上初始 → 斥力推开 → 边当弹簧拉近。60 个点以内够用，不引依赖。
            const pos = new Map()
            shown.forEach((n, i) => {
              const ang = (2 * Math.PI * i) / shown.length
              pos.set(n.name, { x: W / 2 + Math.cos(ang) * 110, y: H / 2 + Math.sin(ang) * 110 })
            })
            for (let iter = 0; iter < 120; iter++) {
              const list = [...pos.entries()]
              for (let i = 0; i < list.length; i++) {
                for (let j = i + 1; j < list.length; j++) {
                  const [na, pa] = list[i]
                  const [nb, pb] = list[j]
                  let dx = pa.x - pb.x
                  let dy = pa.y - pb.y
                  let d2 = dx * dx + dy * dy
                  if (d2 < 1) { dx = 0.1; dy = 0.1; d2 = 0.02 }
                  const f = 2600 / d2
                  const d = Math.sqrt(d2)
                  pa.x += (dx / d) * f
                  pa.y += (dy / d) * f
                  pb.x -= (dx / d) * f
                  pb.y -= (dy / d) * f
                }
              }
              for (const e of edges) {
                const pa = pos.get(e.a)
                const pb = pos.get(e.b)
                if (!pa || !pb) continue
                const dx = pb.x - pa.x
                const dy = pb.y - pa.y
                const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
                const pull = (d - 70) * 0.02
                pa.x += (dx / d) * pull
                pa.y += (dy / d) * pull
                pb.x -= (dx / d) * pull
                pb.y -= (dy / d) * pull
              }
              for (const p of pos.values()) {
                p.x = Math.min(W - 12, Math.max(12, p.x))
                p.y = Math.min(H - 12, Math.max(12, p.y))
              }
            }
            const maxW = Math.max(1, ...edges.map((e) => e.w))
            return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              h('p', { style: { fontSize: '11px', opacity: 0.55, margin: 0 } },
                `节点 ${nodes.length} 个（画前 40）· 边 ${links.length} 条 · 线越粗一起出现得越多`),
              h('svg', { viewBox: `0 0 ${W} ${H}`, style: { width: '100%', height: 'auto', border: '1px solid rgba(128,128,128,0.2)', borderRadius: '6px' } },
                ...edges.map((e, i) => {
                  const pa = pos.get(e.a)
                  const pb = pos.get(e.b)
                  if (!pa || !pb) return null
                  return h('line', {
                    key: `e${i}`,
                    x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y,
                    stroke: 'currentColor',
                    strokeOpacity: 0.12 + 0.5 * (e.w / maxW),
                    strokeWidth: 0.5 + 2 * (e.w / maxW),
                  })
                }),
                ...shown.map((n) => {
                  const p = pos.get(n.name)
                  const r = 3 + Math.min(9, Math.sqrt(n.count) * 1.6)
                  return h('g', { key: n.name },
                    h('circle', { cx: p.x, cy: p.y, r, fill: 'currentColor', fillOpacity: 0.28, stroke: 'currentColor', strokeOpacity: 0.5 }),
                    h('text', {
                      x: p.x, y: p.y - r - 3,
                      fontSize: 9, textAnchor: 'middle', fill: 'currentColor', fillOpacity: 0.75,
                    }, n.name),
                  )
                }),
              ),
            )
          }

          if (zone === 'spaces') {
            const list = Array.isArray(data.spaces) ? data.spaces : []
            if (list.length === 0) return h('p', { style: { fontSize: '12px', opacity: 0.55 } }, '还没有空间记录。')
            return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              h('p', { style: { fontSize: '11px', opacity: 0.55, margin: 0 } },
                `当前空间：${currentSpace || 'default'}。换一个空间后，写进去和想起来的都只看那一格。`),
              ...list.map((sp) => h('div', {
                key: sp.id,
                style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '4px 0', borderBottom: '1px solid rgba(128,128,128,0.15)' },
              },
                h('span', { style: { fontSize: '12px' } }, `${sp.id === (currentSpace || 'default') ? '● ' : ''}${sp.id} · ${sp.count} 条`),
                h('button', {
                  type: 'button',
                  disabled: typeof onSwitchSpace !== 'function' || sp.id === (currentSpace || 'default'),
                  onClick: () => { if (typeof onSwitchSpace === 'function') onSwitchSpace(sp.id) },
                  style: { border: '1px solid currentColor', borderRadius: '6px', padding: '2px 8px', fontSize: '11px', background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: sp.id === (currentSpace || 'default') ? 0.4 : 0.9 },
                }, '切到这个空间'),
              )),
            )
          }

          if (zone === 'scenes') {
            if (items.length === 0) return h('p', { style: { fontSize: '12px', opacity: 0.55 } }, '还没有成段的场景。')
            return h('ol', { style: { display: 'flex', flexDirection: 'column', gap: '12px', margin: 0, padding: '0 0 0 18px' } },
              ...items.map((item) => h('li', { key: item.topic, style: { fontSize: '12px', lineHeight: 1.5 } },
                h('div', { style: { fontSize: '11px', opacity: 0.5, fontFamily: 'monospace' } },
                  `${item.topic} · ${item.count} 条 · ${fmtTime(item.at)}`),
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
                  item.emo.length === 0 ? '' : ` · ${item.emo.map((k) => EMO_TEXT[k] ?? k).join('/')}`
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
                    await fetch('/dsh-whale-memory/entries/correct', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ id: item.id, text: next }),
                    })
                    setSeq((n) => n + 1)
                  },
                  style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '11px', opacity: 0.55, padding: 0, color: 'inherit' },
                }, '改'),
                h('button', {
                  type: 'button',
                  onClick: async () => {
                    if (!window.confirm('撤回这条记忆？原件会留在 revisions 里。')) return
                    await fetch('/dsh-whale-memory/entries/retract', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ id: item.id }),
                    })
                    setSeq((n) => n + 1)
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
            '只读，只是看一眼存了什么。热区是最近还在上下文里的，冷区是压下去、被想起时才取用的；场景是同一条线索串起来的一段，画像则是从记忆里蒸出来的「我记得的你」。',
          ),
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
          Stat('空间', `${memoryStatus.spaces ?? 0} 个`, String(memoryStatus.space ?? '')),
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
          footNotes.push(`主动消息：${proactiveStatus.isQuietHours ? '免打扰中' : '可发'} · 今天 ${proactiveStatus.state?.dailyCount?.[localDayKey()] ?? 0} 条 · ${proactiveStatus.decision?.reason ?? '?'}`)
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
                setNightBusy(true)
                setNightNote('')
                fetch(NIGHTLY_URL, { method: 'POST' })
                  .then((res) => res.json())
                  .then((json) => {
                    setNightNote(json?.ok
                      ? `跑完了：桌面页 ${json.deskBytes} 字节，并入 ${json.merged} 条`
                      : `没跑成：${json?.reason ?? json?.errors?.[0] ?? '未知原因'}`)
                    setTick((n) => n + 1)
                  })
                  .catch(() => setNightNote('请求失败'))
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
              ...group.fields.map((field) => h(Row, {
                key: PATH_TEXT(field.path),
                field,
                value: pick(snap.value, field.path) ?? field.fallback,
                overridden: pick(snap.user, field.path) !== undefined,
                disabled,
                onWrite: (value) => writePath(form, field.path, value),
                onReset: () => resetPath(form, field.path),
              })),
            )
          }),
          ),
          h(EntriesView, {
            key: 'entries',
            currentSpace: memoryStatus?.space ?? 'default',
            onSwitchSpace: (name) => writePath(memoryForm, ['space'], String(name)),
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
    exports.__test = { pick, writePath, resetPath, normalizeNumber, GROUPS }
    exports.apply = apply
    return module.exports
  },
})
