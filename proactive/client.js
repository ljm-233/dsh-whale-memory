/**
 * dsh-proactive-message —— 浏览器端：设置面板里的「主动消息」页
 *
 * 格式与 DSH 自带的客户端插件一致：`window.__ModuleLoader__.load({id, factory})`，
 * factory 返回 `{ name, inject, apply }`，由 shell 当普通 Cordis 插件挂载。
 * 没有构建步骤，也不用 JSX。
 *
 * 数据通路走 DSH 自己的设置服务，不另开存储：
 *
 *   ctx.get('configForms').get('dsh-proactive-message')
 *        ↓ 读解析后的值 + 修订号
 *   表单改动 → form.set / form.mutate
 *        ↓ Host 校验后写进活动 profile 的 cordis patch
 *   插件里 config.xxx.get() 立刻读到新值
 */
window.__ModuleLoader__.load({
  id: 'dsh-proactive-message',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** 与 profile 里的插件条目 id 一致。 */
    const NS = 'dsh-proactive-message'
    const STATUS_URL = '/dsh-proactive-message/status'

    const GROUPS = [
      {
        title: '什么时候可以说话',
        hint: '它自己判断该不该开口时的几个门槛。',
        fields: [
          { path: ['dailyCap'], label: '每天最多发几条', kind: 'int', min: 0, max: 500 },
          { path: ['cooldownHours'], label: '两次之间至少隔几小时', kind: 'num', min: 0, max: 720 },
          { path: ['silenceHours'], label: '多久没说话才算安静（小时）', kind: 'num', min: 0, max: 720 },
        ],
      },
      {
        title: '免打扰',
        hint: '这个时段一律不发。开始和结束填一样的数字就是不启用。',
        fields: [
          { path: ['quietStart'], label: '从几点开始（0–23）', kind: 'int', min: 0, max: 23 },
          { path: ['quietEnd'], label: '到几点结束（0–23）', kind: 'int', min: 0, max: 23 },
        ],
      },
      {
        title: '检查频率',
        hint: '多久醒一次看看该不该说话。',
        fields: [
          { path: ['tickMinutes'], label: '每多少分钟检查一次', kind: 'int', min: 1, max: 1440 },
        ],
      },
    ]

    const PATH_TEXT = (path) => path.join('.')

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
      const Input = primitives && primitives.Input

      const formOf = () => {
        const forms = ctx.get('configForms')
        if (!forms || typeof forms.get !== 'function') return null
        return forms.get(NS)
      }

      const rowStyle = {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '16px', padding: '10px 0',
      }
      const labelStyle = { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' }
      const nameStyle = { fontSize: '13px' }
      const metaStyle = { fontSize: '11px', opacity: 0.6, fontFamily: 'monospace' }

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

        const props = {
          type: 'number',
          value: draft,
          step: field.step ?? 'any',
          disabled,
          'aria-label': field.label,
          onFocus: () => setTyping(true),
          onChange: (e) => { setTyping(true); setDraft(e.target.value) },
          onBlur: commit,
          onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur() },
          style: { width: '110px' },
        }
        const control = typeof Input === 'function' ? h(Input, props) : h('input', props)

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
              ? h('button', {
                type: 'button',
                onClick: onReset,
                title: '恢复成默认值',
                style: {
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  fontSize: '11px', opacity: 0.6, padding: '2px 4px', color: 'inherit',
                },
              }, '恢复')
              : null,
            control,
          ),
        )
      }

      const Panel = () => {
        const form = formOf()
        const [status, setStatus] = React.useState(null)

        React.useEffect(() => {
          let alive = true
          fetch(STATUS_URL, { headers: { accept: 'application/json' } })
            .then((res) => (res.ok ? res.json() : null))
            .then((json) => { if (alive && json) setStatus(json) })
            .catch(() => { /* 拿不到就不显示 */ })
          return () => { alive = false }
        }, [])

        if (form === null) {
          return h('p', { style: { fontSize: '13px', opacity: 0.75 } }, '设置服务不可用（DSH 版本偏旧？），参数只能改配置文件。')
        }

        const snap = React.useSyncExternalStore(
          (cb) => form.subscribe(cb),
          () => form.getSnapshot(),
          () => form.getSnapshot(),
        )

        if (snap.status === 'loading') return h('p', { style: { fontSize: '13px', opacity: 0.6 } }, '读取中…')
        if (snap.status === 'unavailable') {
          return h('p', { style: { fontSize: '13px', opacity: 0.75 } }, '这个插件条目没有暴露配置，先确认它已经在 profile 里启用。')
        }

        const disabled = !snap.writable
        const write = (path, value) => writePath(form, path, value)
        const reset = (path) => resetPath(form, path)

        const summary = status === null
          ? null
          : h(
            'p',
            { style: { fontSize: '12px', opacity: 0.65, margin: '0 0 4px' } },
            `现在${status.isQuietHours ? '在免打扰时段' : '不在免打扰时段'} · 今天发了 ${
              status.state?.dailyCount?.[localDayKey()] ?? 0
            } 条 · 现在的判断：${status.decision?.reason ?? '?'}`,
          )

        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 0' } },
          summary,
          ...GROUPS.map((group) => h(
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
              onWrite: (value) => write(field.path, value),
              onReset: () => reset(field.path),
            })),
          )),
        )
      }

      const slots = ctx.get('slots')
      if (!slots || typeof slots.register !== 'function') return

      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: NS, order: 61, label: () => '主动消息' },
        Panel,
      ))
    }

    exports.name = 'dsh-proactive-message'
    exports.inject = ['slots']
    /** 纯函数，自检直接调，不用起浏览器。 */
    exports.__test = { pick, writePath, resetPath, normalizeNumber, GROUPS }
    exports.apply = apply
    return module.exports
  },
})
