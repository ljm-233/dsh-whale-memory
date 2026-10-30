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
 */
window.__ModuleLoader__.load({
  id: 'dsh-whale-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** 与 profile 里的插件条目 id 一致，设置服务按它找命名空间。 */
    const NS = 'dsh-whale-memory'
    const STATUS_URL = '/dsh-whale-memory/status'

    const GROUPS = [
      {
        title: '记忆注入',
        hint: '每次对话开头塞多少记忆进上下文。数字越小越省 token。',
        fields: [
          { path: ['budgetChars'], label: '注入字符上限', kind: 'int', min: 200, max: 8000 },
          { path: ['recentPairs'], label: '热区保留轮数', kind: 'int', min: 1, max: 20 },
          { path: ['factMax'], label: '稳定事实条数', kind: 'int', min: 0, max: 50 },
        ],
      },
      {
        title: '主动联想',
        hint: '它会不会自己想起旧事。门槛调高，它就安静一些。',
        fields: [
          { path: ['recallMax'], label: '每轮最多想起几条', kind: 'int', min: 0, max: 8 },
          { path: ['recallThreshold'], label: '想起门槛', kind: 'num', min: 0, max: 10, step: 0.1 },
          { path: ['weightMax'], label: '权重上限', kind: 'num', min: 1, max: 50, step: 1 },
        ],
      },
      {
        title: '压缩存档',
        hint: '上下文被压缩时，把摘要和那段原文汇成文档。',
        fields: [
          { path: ['archive', 'enabled'], label: '写完整存档到磁盘', kind: 'bool' },
          { path: ['archive', 'notify'], label: '顺手私发主人一份', kind: 'bool' },
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

      /** 拿共享表单；服务缺席时返回 null，页面显示提示而不是崩掉。 */
      const formOf = () => {
        const forms = ctx.get('configForms')
        if (!forms || typeof forms.get !== 'function') return null
        return forms.get(NS)
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
        const control = (() => {
          if (field.kind === 'bool') {
            const checked = value === true
            if (typeof Switch === 'function') {
              return h(Switch, { checked, label: field.label, disabled, onChange: (next) => onWrite(next) })
            }
            return h('input', { type: 'checkbox', checked, disabled, onChange: (e) => onWrite(e.target.checked) })
          }
          const onChange = (e) => {
            const raw = e.target.value
            if (raw === '') return onReset()
            const n = Number(raw)
            if (!Number.isFinite(n)) return
            onWrite(n)
          }
          if (typeof Input === 'function') {
            return h(Input, {
              type: 'number',
              value: value === undefined || value === null ? '' : String(value),
              min: field.min,
              max: field.max,
              step: field.step,
              disabled,
              'aria-label': field.label,
              onChange,
              style: { width: '110px' },
            })
          }
          return h('input', {
            type: 'number', value: value === undefined || value === null ? '' : String(value),
            min: field.min, max: field.max, step: field.step, disabled, onChange,
          })
        })()

        return h(
          'div',
          { style: rowStyle },
          h(
            'div',
            { style: labelStyle },
            h('span', { style: nameStyle }, field.label),
            h('span', { style: metaStyle }, overridden ? `${PATH_TEXT(field.path)} · 已改` : PATH_TEXT(field.path)),
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
        const form = formOf()
        const [status, setStatus] = React.useState(null)

        React.useEffect(() => {
          let alive = true
          fetch(STATUS_URL, { headers: { accept: 'application/json' } })
            .then((res) => (res.ok ? res.json() : null))
            .then((json) => { if (alive && json) setStatus(json) })
            .catch(() => { /* 拿不到就不显示这行 */ })
          return () => { alive = false }
        }, [])

        if (form === null) {
          return h('p', { style: { fontSize: '13px', opacity: 0.75 } }, '设置服务不可用（DSH 版本偏旧？），参数只能改配置文件。')
        }

        const snap = React.useSyncExternalStore(
          (cb) => form.subscribe(cb),
          () => form.getSnapshot(),
          // 第三个参数让这个组件也能在服务端渲染（测试用），浏览器里不会走到。
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
            `热区 ${status.hot ?? '?'} 条 · 冷区 ${status.cold ?? '?'} 条 · 向量${
              status.embedOk ? '正常' : '不可用（已降级）'
            } · 想起过 ${status.stats?.recalled ?? 0} 次 · 抢救 ${status.stats?.salvaged ?? 0} 次`,
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
        { name: 'settings.section', id: NS, order: 60, label: () => '鲸娘记忆' },
        Panel,
      ))
    }

    exports.name = 'dsh-whale-memory'
    exports.inject = ['slots']
    /** 纯函数，自检直接调，不用起浏览器。 */
    exports.__test = { pick, writePath, resetPath, GROUPS }
    exports.apply = apply
    return module.exports
  },
})
