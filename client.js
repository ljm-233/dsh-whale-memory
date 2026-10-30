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
          return () => { alive = false }
        }, [])

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

        const statusLine = (text) => h(
          'p',
          { style: { fontSize: '12px', opacity: 0.65, margin: '0 0 4px' } },
          text,
        )

        const memoryLine = memoryStatus === null
          ? null
          : statusLine(
            `热区 ${memoryStatus.hot ?? '?'} 条 · 冷区 ${memoryStatus.cold ?? '?'} 条 · 向量${
              memoryStatus.embedOk ? '正常' : '不可用（已降级）'
            } · 想起过 ${memoryStatus.stats?.recalled ?? 0} 次 · 抢救 ${memoryStatus.stats?.salvaged ?? 0} 次`,
          )

        const proactiveLine = proactiveStatus === null
          ? null
          : statusLine(
            `主动消息：${proactiveStatus.isQuietHours ? '在免打扰时段' : '不在免打扰时段'} · 今天发了 ${
              proactiveStatus.state?.dailyCount?.[localDayKey()] ?? 0
            } 条 · 现在的判断是 ${proactiveStatus.decision?.reason ?? '?'}`,
          )

        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 0' } },
          memoryLine,
          proactiveLine,
          ...available.map((group) => {
            const form = forms[group.form]
            const snap = snaps[group.form]
            const disabled = !snap.writable
            return h(
              'section',
              { key: group.title, style: { display: 'flex', flexDirection: 'column' } },
              h('h3', { style: { fontSize: '13px', margin: '0 0 2px' } }, group.title),
              h('p', { style: { fontSize: '11px', opacity: 0.6, margin: '0 0 4px' } }, group.hint),
              ...group.fields.map((field) => h(Row, {
                key: PATH_TEXT(field.path),
                field,
                value: pick(snap.value, field.path),
                overridden: pick(snap.user, field.path) !== undefined,
                disabled,
                onWrite: (value) => writePath(form, field.path, value),
                onReset: () => resetPath(form, field.path),
              })),
            )
          }),
        )
      }

      /** 本地时区的今天，和 Host 的 dayKey 对齐（不能用 toISOString，那是 UTC）。 */
      const localDayKey = () => {
        const d = new Date()
        const p2 = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
      }

      const slots = ctx.get('slots')
      if (!slots || typeof slots.register !== 'function') return

      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: NS, order: 60, label: () => '鲸娘记忆' },
        Panel,
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
