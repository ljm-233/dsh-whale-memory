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

    /**
     * 四个分区，按「我要干什么」分，不按字段出处分。
     *
     *   now    —— 它现在怎么想我：只读现状（记忆卡/情绪/任务栈）+ 情绪那三道闸
     *   intake —— 记忆怎么收：写什么、留多少、怎么分层、落到哪
     *   wake   —— 怎么被叫醒：主动消息、免打扰、夜班
     *   diag   —— 危险与诊断：公式/调试开关（默认折叠）+ 会动真数据的按钮
     *
     * 0.28.18 改版（上一版「12 组 40 项、每项三件套」读着像文档）：
     *
     *   1. 每行只留三块：名称（左）· 控件（右）· 一行极短后缀（只写「默认 X」
     *      或「已改」，不并列单位/范围）；单位写进名称的括号里，范围与路径进 title。
     *   2. 每一项带 `tier`：core = 常用（默认展开，全页合计 ≤14 项），
     *      adv = 高级（默认折叠）。
     *   3. `desc` 一行、≤25 字；更长的解释进 `long`（渲染成 title 悬停）。
     *      组标题下最多一句话（≤30 字）。
     *
     * 同一版再往前一步：四个区 → 四条页签（见下面 TAB_KEY）。
     *
     *   1. 页签条吸顶，当前页签高亮；点 / ←→ 切页，不刷新。
     *   2. 四页**全部渲染、只隐藏**（`hidden`）——未保存的输入是 Row 的组件状态，
     *      卸载就丢；隐藏还能让「切回来」是瞬时的。见 renderZone。
     *   3. 状态条只在第一页顶部（其余页各有一条自己的计数，例如诊断页的 spk 覆盖率）。
     *
     * 0.28.19：五条页签——库里的东西从第一页搬出来，单独一页。
     *
     *   before  第一页 = 状态条 + 只读预览 + 热区/冷区/场景/画像/图谱/空间（挤成一坨）
     *   after   第一页只说明「它现在怎么想我」；「记忆内容」一页专门翻东西，
     *           每条记忆两行（摘要 / 空间·来源·重要度·命中·层级·最后想起·在哪一区），
     *           热冷占比条、空间下拉带条数、场景的「今天触发过没有」都在这一页。
     *
     * 默认值不在这里写——渲染时从表单快照的 `base` 层取，少一处副本就少一处说谎的地方。
     */
    /** react 只在这里 require 一次：下面的小构件与 h(...) 都要它。 */
    const React = require('react')
    /** React.createElement 的短名：这一页全是手写的 h(...)，不打 JSX。 */
    const h = React.createElement

    const ZONES = [
      {
        id: 'now',
        slug: 'mood',
        title: '它现在怎么想我',
        hint: '一眼看现状，下面几道闸管心情。',
        long: '上面是只读预览（这一轮会带什么进上下文）；下面是它说自己心情的几道闸，改了下一轮就生效。库里的东西在「记忆内容」那一页。',
      },
      {
        id: 'intake',
        slug: 'memory',
        title: '记忆怎么收',
        hint: '收什么、留多少、落到哪。',
        long: '改完下一轮生效，不用重启；数字越小越省 token。',
      },
      {
        id: 'content',
        slug: 'content',
        title: '记忆内容',
        hint: '库里到底存了什么。',
        long: '热区/冷区原文（可改、可撤回）、成段的场景、画像、实体关系图、按空间分开看。只读为主，写入口各自带一次确认。',
      },
      {
        id: 'people',
        slug: 'people',
        title: '人',
        hint: '谁说过话、说过几句、最近一次。',
        long: '人从认人表（person）和记忆里的说话人（entries.spk）长出来。顶上一行统计 + 覆盖率：spk 是空串的记忆表示「不知道谁说的」，不算到任何人头上，覆盖率低的时候会照实写出来。',
      },
      {
        id: 'wake',
        slug: 'wake',
        title: '怎么被叫醒',
        hint: '什么时候自己开口、什么时候闭嘴。',
        long: '这几项管的是「它会不会主动出现」，不碰记忆本体的写入。',
      },
      {
        id: 'diag',
        slug: 'diag',
        title: '危险与诊断',
        hint: '平时不用动；按钮会动真数据。',
        long: '公式与调试开关在高级里（正常用不着）；按钮那一栏点之前会再问一次。',
      },
    ]

    /**
     * 页签：一个区就是一页，五个区五条页签。
     *
     *   地址栏  `#tab=<slug>`（mood / memory / content / people / wake / diag）——分享给别人打开落在同一页
     *   本地    localStorage[`whale-memory.settings.tab`] 存区 id（now / intake / content / people / wake / diag）
     *
     * 两处都认不出时回第一页，不报错：脏书签不该把设置页搞成空白。
     */
    const TAB_KEY = 'whale-memory.settings.tab'

    /**
     * 从一段 hash 里认页签。
     *
     * 认 `#tab=memory`、`#tab=memory&x=1`、`tab=memory`；slug 与区 id 都收
     * （`#tab=intake` 也认，老书签不至于失效）。
     *
     * @param {string} hash 地址栏 hash（带不带 # 都行）
     * @returns {string|undefined} 区 id；认不出返回 undefined
     */
    const parseTabHash = (hash) => {
      const m = /(?:^|[#&?])tab=([a-z0-9_-]+)/i.exec(String(hash ?? ''))
      if (m === null) return undefined
      const key = m[1].toLowerCase()
      const hit = ZONES.find((z) => z.slug === key || z.id === key)
      return hit === undefined ? undefined : hit.id
    }

    /** 任意输入（区 id / slug / 空 / 脏数据）→ 合法区 id，认不出回第一页。 */
    const tabOf = (raw) => {
      const key = String(raw ?? '').trim().toLowerCase()
      const hit = ZONES.find((z) => z.slug === key || z.id === key)
      return hit === undefined ? ZONES[0].id : hit.id
    }

    const GROUPS = [
      // ───────────── 它现在怎么想我（唯一可写的一组：情绪记账） ─────────────
      {
        zone: 'now',
        form: 'memory',
        title: '情绪记账',
        hint: '每轮结一次心情账。',
        long: '判的是「我这一轮说了什么」——词、句长、有没有说「不想/算了/没事」。攒够了才在上下文里说一句（一行、不带数值），说不说由下面几项管：一天几次、比上次动几格、隔多久。',
        fields: [
          { tier: 'core', path: ['moodEnabled'], label: '记账开关', kind: 'bool', desc: '关掉就整轮跳过',
            long: '开：每轮结一次账，卡片里可能出现一行心情 · 关：不写库也不开口，情绪预览会停在旧值' },
          { tier: 'adv', path: ['moodHalfLifeHours'], label: '心情半衰期（小时）', kind: 'int', min: 1, max: 168, desc: '越大回落到平静越慢',
            long: '心情多久回落到平静。越大越黏，越小越像当场情绪。' },
          { tier: 'core', path: ['moodInjectDailyMax'], label: '一天最多说几次（次）', kind: 'int', min: 0, max: 50, desc: '心情那一行的日上限',
            long: '心情那一行每天最多出现几次；0 = 只记账，永不开口。' },
          { tier: 'adv', path: ['moodInjectMinDelta'], label: '动几格才开口（格）', kind: 'num', min: 0, max: 100, step: 1, desc: '变化够大才值得说',
            long: '比上次开口时变化多少才算「值得说一句」；调大它会安静很多。' },
          { tier: 'adv', path: ['moodInjectCooldownHours'], label: '两次之间至少隔（小时）', kind: 'num', min: 0, max: 168, step: 1, desc: '免得连着几轮都说',
            long: '防止连续几轮都在说心情；跨过这个间隔才允许再开口。' },
        ],
      },

      // ───────────── 记忆怎么收 ─────────────
      {
        zone: 'intake',
        form: 'memory',
        title: '注入与空间',
        hint: '每轮开头塞多少进上下文。',
        long: '超预算时先砍联想再砍热区。空间换一格，写进去和想起来的都只看那一格。最后两项是闸门：一天最多真注入几次、联想太散就不换卡（拦下时沿用上一次的卡，不会把记忆抹掉）。',
        fields: [
          { tier: 'core', path: ['budgetChars'], label: '注入字符上限（字）', kind: 'int', min: 50, max: 50000, desc: '整张记忆卡的硬预算',
            long: '整张记忆卡的硬预算，超了先砍联想再砍热区。' },
          { tier: 'core', path: ['space'], label: '当前空间', kind: 'string', desc: '读写都只看这一格',
            long: '记忆按空间隔离：换一格，写进去和想起来的都只看那一格。' },
          { tier: 'core', path: ['recentPairs'], label: '热区保留轮数（轮）', kind: 'int', min: 0, max: 100, desc: '最近几轮原样带着',
            long: '最近几轮对话原样带在身边，不用检索；调大很费 token。' },
          { tier: 'core', path: ['cardDailyMax'], label: '每天最多注入几次（次）', kind: 'int', min: 0, max: 500, desc: '到顶就沿用上次的卡',
            long: '到顶后沿用上次的卡，不再刷新——省 token 的刹车。' },
          { tier: 'adv', path: ['cardMinConfidence'], label: '注入置信门槛（0~1）', kind: 'num', min: 0, max: 1, step: 0.01, desc: '太散就不换卡',
            long: '本轮联想太散（低于它）就不换卡，避免乱塞无关旧事。' },
          { tier: 'adv', path: ['factMax'], label: '稳定事实条数（条）', kind: 'int', min: 0, max: 500, desc: '最多带几条关于你的事',
            long: '「关于你的事实」这一段最多带几条进卡片。' },
        ],
      },
      {
        zone: 'intake',
        form: 'memory',
        title: '联想',
        hint: '会不会自己想起旧事。',
        long: '这几项管记忆卡里的「和这次有关」那一段，不管 memory_recall 工具。门槛调高，它就安静一些。',
        fields: [
          { tier: 'core', path: ['recallMax'], label: '每轮最多想起几条（条）', kind: 'int', min: 0, max: 50, desc: '联想段最多几条',
            long: '联想段最多放几条旧记忆进卡片。' },
          { tier: 'adv', path: ['recallThreshold'], label: '想起门槛（旧公式，分）', kind: 'num', min: 0, max: 1000, step: 0.05, desc: '只在 legacy 公式下生效',
            long: '只在打分公式 = legacy 时生效；axes 用场景自带门槛，不看这一项。' },
          { tier: 'adv', path: ['weightMax'], label: '权重上限（权）', kind: 'num', min: 1, max: 10000, step: 1, desc: '反复想起最高多重',
            long: '一条记忆被反复想起后最高能到多重（不设顶会一直涨）。' },
        ],
      },
      {
        zone: 'intake',
        form: 'memory',
        title: '冷热分层',
        hint: '热区留几条、多重才抬进来。',
        long: '热区那几条每轮都在上下文里；冷区每深一层扣一点排序分，越深越不容易被想起。',
        fields: [
          { tier: 'adv', path: ['hotZoneMax'], label: '热区条数上限（条）', kind: 'int', min: 1, max: 200, desc: '这几条每轮都在上下文',
            long: '热区最多留几条，这几条每轮都在上下文里。' },
          { tier: 'adv', path: ['hotPromoteWeight'], label: '抬进热区的最低权重（权）', kind: 'int', min: 0, max: 20, desc: '到线才被抬进热区',
            long: '权重到这条线才被抬进热区。' },
          { tier: 'adv', path: ['tierPenalty'], label: '层级惩罚（分/层）', kind: 'num', min: 0, max: 1, step: 0.01, desc: '越深越扣分',
            long: '冷区每深一层，排序分扣多少（越大越只用最近的事）。' },
        ],
      },
      {
        zone: 'intake',
        form: 'memory',
        title: '入库取舍',
        hint: '先只记账，不改入库。',
        long: '每轮先说一句话判一次「这条该不该记」，判据是纯规则（不调模型）。默认只记账不改行为：写一行到 admit 表，入库一个字不变。看够了对账再关影子。',
        fields: [
          { tier: 'adv', path: ['admitShadow'], label: '影子模式', kind: 'bool', desc: '开=只记账不拦写入',
            long: '开（默认）：只写账，该记的都记 · 关：判成 drop 的那些真的不入库（真库样本里约三成短句会落到 drop，先看诊断区的分布再关）' },
        ],
      },
      {
        zone: 'intake',
        form: 'memory',
        title: '落盘与周记',
        hint: '群聊按天落盘，每周一份周记。',
        long: '第二层把群聊按天落成「全量-YYYY-MM-DD.md」，第三层每周拢一份周记。落盘间隔只影响渲染出来的 timer，改完要重跑 install-local --with-group-dump。',
        fields: [
          { tier: 'core', path: ['groupDump', 'enabled'], label: '群聊自动落盘', kind: 'bool', desc: '按天写成文件',
            long: '开：磁盘上留全量原文，方便事后翻 · 关：只留在记忆库里，不落盘' },
          { tier: 'core', path: ['groupDump', 'intervalMinutes'], label: '落盘间隔（分钟）', kind: 'int', min: 1, max: 1440, desc: '越短越实时也越费 IO',
            long: '多久攒一次写盘；它只影响渲染出来的 systemd timer，改完要重跑 install-local --with-group-dump。' },
          { tier: 'adv', path: ['groupDump', 'dir'], label: '导出目录', kind: 'string', desc: '留空用默认位置',
            long: '落盘文件和周记放哪；留空用记忆目录下的默认位置。' },
          { tier: 'core', path: ['weekly', 'enabled'], label: '周记', kind: 'bool', desc: '每周拢一份摘要',
            long: '开：每周一份周记 · 关：只有日文件' },
          { tier: 'adv', path: ['weekly', 'startDay'], label: '周记起始日（1=周一…7）', kind: 'int', min: 1, max: 7, desc: '一周从哪天算',
            long: '一周从哪天算起；1=周一 … 7=周日。' },
        ],
      },
      {
        zone: 'intake',
        form: 'memory',
        title: '压缩存档',
        hint: '压缩时把原文汇成文档。',
        long: '上下文被压缩时，把摘要和那段原文汇成文档，压缩掉的聊天记录不至于丢。',
        fields: [
          { tier: 'adv', path: ['archive', 'enabled'], label: '写完整存档', kind: 'bool', desc: '压缩掉的聊天不丢',
            long: '开：压缩掉的聊天记录不丢，事后可翻 · 关：只剩摘要' },
          { tier: 'adv', path: ['archive', 'notify'], label: '存档后私发一份', kind: 'bool', desc: '每次都会发一条',
            long: '开：每次存档都会主动发一条（会打扰） · 关：只落盘，不发消息' },
        ],
      },
      {
        zone: 'intake',
        form: 'memory',
        title: '日记',
        hint: '到点自己记一笔。',
        long: '到点自己记一笔，不管有没有人找。这是让它「一直在」的那根线。',
        fields: [
          { tier: 'adv', path: ['diary', 'enabled'], label: '自动写日记', kind: 'bool', desc: '每天多一条自己写的',
            long: '开：库里每天多一条它自己写的东西 · 关：不写，卡片里也就没有日记那一段' },
          { tier: 'adv', path: ['diary', 'hour'], label: '几点之后写（点）', kind: 'int', min: 0, max: 23, desc: '过了这个点就补一篇',
            long: '过了这个点、当天还没写就补一篇（0–23）。' },
        ],
      },

      // ───────────── 怎么被叫醒 ─────────────
      {
        zone: 'wake',
        form: 'proactive',
        title: '什么时候可以说话',
        hint: '它自己判断该不该开口。',
        long: '三个门槛一起决定它会不会主动出现：日上限、冷却、以及多久没说话才算安静。',
        fields: [
          // 这一页原来 9 项全在高级里：分页之后「打开这一页什么都没有」，
          // 所以把真会改的两项（日上限、多久算安静）抬到常用，其余仍在高级。
          { tier: 'core', path: ['dailyCap'], label: '每天最多发几条（条）', kind: 'int', min: 0, max: 500, desc: '0 = 完全不主动开口',
            long: '主动消息的日上限；0 = 完全不主动开口。' },
          { tier: 'adv', path: ['cooldownHours'], label: '两次之间至少隔（小时）', kind: 'num', min: 0, max: 720, step: 1, desc: '刚说过就不补一句',
            long: '刚说过话就不再补一句。' },
          { tier: 'core', path: ['silenceHours'], label: '多久没说话算安静（小时）', kind: 'num', min: 0, max: 720, step: 1, desc: '安静到这才有理由开口',
            long: '安静到这个程度才有理由主动开口。' },
        ],
      },
      {
        zone: 'wake',
        form: 'proactive',
        title: '免打扰',
        hint: '这个时段一律不发。',
        long: '这个时段一律不发。开始和结束填一样就是不启用（跨午夜也支持）。',
        fields: [
          { tier: 'adv', path: ['quietStart'], label: '从几点开始（点）', kind: 'int', min: 0, max: 23, desc: '免打扰起点',
            long: '免打扰起点（0–23，跨午夜也支持）。' },
          { tier: 'adv', path: ['quietEnd'], label: '到几点结束（点）', kind: 'int', min: 0, max: 23, desc: '和起点相同=不启用',
            long: '免打扰终点；和起点相同=不启用。' },
          { tier: 'adv', path: ['tickMinutes'], label: '多久检查一次（分钟）', kind: 'int', min: 1, max: 1440, desc: '越小越及时也越费电',
            long: '多久醒一次看要不要说话（越小越及时，越费电）。' },
        ],
      },
      {
        zone: 'wake',
        form: 'memory',
        title: '自唤醒（systemd 那条线）',
        hint: '安静时段、冷却、日限、命中率。',
        long: '这一组是「它自己醒来」那一轮：外部定时器每半小时问一次，脚本按这里判断要不要真的开口。改完下一轮生效，不用重启。',
        fields: [
          { tier: 'core', path: ['wakeSelf', 'enabled'], label: '允许自己醒来', kind: 'bool', fallback: true, desc: '关掉就一次都不叫醒',
            long: '开：到点掷骰，命中才醒 · 关：定时器照跑但脚本直接退出，一句都不说。' },
          { tier: 'adv', path: ['wakeSelf', 'dailyQuota'], label: '一天最多开口（次）', kind: 'int', min: 0, max: 50, fallback: 3, desc: '0 = 一次都不说',
            long: '一天真开口的次数上限；掷骰命中也要受它限制。' },
          { tier: 'adv', path: ['wakeSelf', 'hitRate'], label: '掷骰命中率（%）', kind: 'int', min: 1, max: 100, fallback: 40, desc: '越高越常醒',
            long: '每次到点掷一次骰，低于这个数才真的醒来。40 大约是每两三次里醒一次。' },
          { tier: 'adv', path: ['wakeSelf', 'cooldownMinutes'], label: '两次之间至少隔（分钟）', kind: 'int', min: 0, max: 1440, fallback: 90, desc: '刚醒过就不补',
            long: '刚说完就不再补一句；90 = 一个半小时。' },
          { tier: 'adv', path: ['wakeSelf', 'quietFromMinute'], label: '安静开始（分钟）', kind: 'int', min: 0, max: 1440, fallback: 0, desc: '0 = 零点',
            long: '安静时段起点（按当天第几分钟算，0 = 00:00，540 = 09:00）。' },
          { tier: 'adv', path: ['wakeSelf', 'quietToMinute'], label: '安静结束（分钟）', kind: 'int', min: 0, max: 1440, fallback: 540, desc: '540 = 上午九点',
            long: '安静时段终点；和起点一样就是不启用。' },
          { tier: 'adv', path: ['wakeSelf', 'target'], label: '发到哪（targetId）', kind: 'text', fallback: 'tgt_bca96e94052d7c32', desc: '私聊或群',
            long: '默认私聊；填 tgt_0416790124a6c9f0 是发群里。' },
        ],
      },
      {
        zone: 'wake',
        form: 'memory',
        title: '夜班 / 桌面页',
        hint: '一天结一次账，重蒸桌面页。',
        long: '一天一次结账：并日档、清理冷区、重蒸桌面页。桌面页是它每天最先读到的那一页。',
        fields: [
          { tier: 'adv', path: ['night', 'enabled'], label: '每天自动跑', kind: 'bool', desc: '并日档、清冷区',
            long: '开：每天自动并日档、清理冷区 · 关：只能手动点「立刻跑一班」' },
          { tier: 'adv', path: ['night', 'hour'], label: '几点开（点）', kind: 'int', min: 0, max: 23, fallback: 22, desc: '夜班开始的小时',
            long: '夜班开始的小时（scheme 没给默认值时用 22）。' },
          { tier: 'adv', path: ['night', 'minute'], label: '几分开始（分）', kind: 'int', min: 0, max: 59, fallback: 5, desc: '夜班开始的分钟',
            long: '夜班开始的分钟（schema 没给默认值时用 5）。' },
        ],
      },

      // ───────────── 危险与诊断（默认折叠） ─────────────
      {
        zone: 'diag',
        form: 'memory',
        title: '打分与调试',
        hint: '公式与场景决定旧事怎么排。',
        long: 'axes 是相关性/重要性/时间三轴合成（0~1）；legacy 是旧公式（2.0 刻度，A/B 对照用，切回去等于回到旧排序）。场景决定三套权重与半衰期：想问旧事用 lookup-old，日常聊天用 daily，auto 按「上次/以前/那个」这类线索词自己挑。',
        fields: [
          { tier: 'adv', path: ['scoreMode'], label: '打分公式', kind: 'select', desc: '换公式会换整段排序',
            long: '换公式会换整段联想的排序（axes 默认 / legacy 旧公式）。',
            options: [
              { value: 'axes', label: 'axes · 三维（相关性/重要性/时间）' },
              { value: 'legacy', label: 'legacy · 旧公式（A/B 对照）' },
            ] },
          { tier: 'adv', path: ['recallScene'], label: '打分场景', kind: 'select', desc: '决定权重与半衰期',
            long: '决定权重与半衰期，也就是旧事能排多前。',
            options: [
              { value: 'recall', label: 'recall · 主动联想（默认）' },
              { value: 'lookup-old', label: 'lookup-old · 查旧事（十年半衰）' },
              { value: 'daily', label: 'daily · 日常对话（旧事别抢戏）' },
              { value: 'auto', label: 'auto · 按线索词自己挑' },
            ] },
          { tier: 'adv', path: ['axesDebug'], label: '日志打印三轴分解', kind: 'bool', desc: '排查乱排时才开',
            long: '开：每轮往日志里打 rel/imp/time 三个数与权重 · 关：不打（默认）' },
          { tier: 'adv', path: ['speakerEnabled'], label: '记录说话人', kind: 'bool', desc: '每条记忆带上谁说的',
            long: '开：新记忆写 spk（按群库对齐） · 关：一律写空串，写入行为回到 0.28.17' },
        ],
      },
    ]

    /**
     * 会动真数据的按钮。`tier` 同字段：core 的「备份一份」放在常用区，
     * 其余两个（跑夜班、重蒸桌面页）跟着诊断进高级。
     *
     * `act` 是按钮上的短词——左边已经是名字，按钮再写一遍名字只是噪声。
     */
    const ACTIONS = [
      { tier: 'core', id: 'backup', label: '备份一份', act: '备份', desc: '复制到备份目录（当天的会被覆盖）', confirm: '现在备份一份记忆库？当天已有的备份会被覆盖。' },
      { tier: 'adv', id: 'nightly', label: '立刻跑一班', act: '跑', desc: '结账：并日档、清冷区、重蒸桌面页', confirm: '手动跑一班？会把今天新攒的记忆并入日档，并清理冷区里太老又低权重的条目。' },
      { tier: 'adv', id: 'desk', label: '重蒸桌面页', act: '重蒸', desc: '重算它每天最先读到的那一页', confirm: '' },
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


    /**
     * 顶部状态条压到四格：版本 / 条目（热·冷）/ 今日注入 / 情绪。
     *
     * 六格那版取不到数据时有五格是问号（`v? / ? / 0 条 / 0 / 12 / ?`），
     * 看着像坏了；现在取不到的格写「—」，一眼能分清「没数据」和「出错了」。
     *
     * 纯函数：只吃 `/status` 和 `/mood` 的返回，不碰 DOM、不碰 fetch——
     * 这样服务端渲染、测试、脚本都能直接拿到「一眼看活着没有」的那一行字。
     *
     * @param {object|null} status /status 的返回
     * @param {object|null} mood /mood 的返回
     * @param {unknown} cap 当前配置的「每天最多真注入几次」
     * @returns {Array<{label:string, value:string, hint:string}>}
     */
    const DASH = '—'
    const statusChipsOf = (status, mood, cap) => {
      const dayOf = () => {
        const d = new Date()
        const p2 = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
      }
      const rec = status?.cardInject ?? null
      const hasDay = rec !== null && rec.day === dayOf()
      const today = hasDay ? Number(rec.count ?? 0) : 0
      const capText = typeof cap === 'number' ? ` / ${cap}` : ''
      const skip = rec !== null && rec.lastSkip && rec.lastSkip.reason
        ? `${String(rec.lastSkip.reason)}${rec.lastSkip.conf != null ? `（置信 ${Number(rec.lastSkip.conf).toFixed(2)}）` : ''}`
        : ''
      const recent = Array.isArray(mood?.recent) ? (mood.recent[0] ?? null) : null
      const hasMood = recent !== null && recent.mood !== undefined && recent.mood !== null && Number.isFinite(Number(recent.mood))
      const hot = status?.hot
      const cold = status?.cold
      const hasCount = status !== null && (hot !== undefined || cold !== undefined)
      return [
        {
          label: '版本',
          value: status?.pluginVersion ? `v${status.pluginVersion}` : DASH,
          hint: status?.axes?.envOverride === true ? '环境变量覆盖了打分' : '',
        },
        {
          label: '条目',
          value: hasCount ? `${(hot ?? 0) + (cold ?? 0)} 条` : DASH,
          hint: hasCount ? `热 ${hot ?? 0} · 冷 ${cold ?? 0}` : '',
        },
        {
          label: '今日注入',
          value: rec === null ? DASH : `${today}${capText}`,
          hint: rec === null ? '' : (skip !== '' ? `上次跳过：${skip}` : (today > 0 ? '今天带过记忆' : '今天还没真注入')),
        },
        {
          label: '情绪',
          value: hasMood ? String(Math.round(Number(recent.mood))) : DASH,
          hint: hasMood ? String(recent.reason ?? '').slice(0, 28) : (mood === null ? '' : '还没记账'),
        },
      ]
    }
    /** 情绪键 → 中文，只用于显示。 */
    const EMO_TEXT = { tired: '累', sad: '难过', angry: '烦', happy: '开心', anxious: '焦虑' }

    const fmtTime = (ms) => {
      const d = new Date(ms)
      const p2 = (n) => String(n).padStart(2, '0')
      return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
    }

    /**
     * 是不是「今天」：场景那一行要标出「今天触发过没有」。
     * 按本地日历日比，不看 24 小时差——早上和夜里都算今天。
     */
    const sameDay = (ms) => {
      const t = Number(ms)
      if (!(t > 0)) return false
      const a = new Date(t)
      const b = new Date()
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
    }

    /**
     * 空状态：一句「还没有」+ 一句「为什么还没有」。
     * 空白块最费解——不写原因的话，看着像坏了。
     */
    const emptyBox = (what, why) => h('div', {
      style: { display: 'flex', flexDirection: 'column', gap: '1px', padding: '2px 0' },
    },
    h('p', { style: { fontSize: '12px', opacity: 0.7, margin: 0 } }, what),
    h('p', { style: { fontSize: '11px', opacity: 0.5, margin: 0, lineHeight: 1.55 } }, why),
    )

    /**
     * 只写「几点」：今天写 HH:MM，跨天才补日期——四段小字里日期不如时间值钱。
     */
    const fmtClock = (ms) => {
      const d = new Date(ms)
      const p2 = (n) => String(n).padStart(2, '0')
      const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
      return sameDay(ms) ? hm : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`
    }

    /**
     * 一条记忆的第二行。
     *
     * 收起时只留四段：`空间 · 命中 N 次 · 最后想起 · 热/冷`——扫一眼够判断「分量多少、多久没动过」。
     * 来源 / 重要度 / tier 是查账用的：有值才写一段，没值不占位。
     * （真库里 spk 覆盖率 0、imp 全 NULL，写占位词等于白占半行。）
     * 点开之后（open）补全所有字段：imp 的自动与否、tier 的变动时间、写入时间。
     */
    const entryMetaText = (item, opts) => {
      const open = opts?.open === true
      const spk = String(item?.spk ?? '').trim()
      const rawImp = item?.imp === null || item?.imp === undefined ? null : Number(item.imp)
      const imp = Number.isFinite(rawImp) ? rawImp : null
      const hits = Math.max(0, Number(item?.hits ?? 0) || 0)
      const tier = Math.max(0, Number(item?.tier ?? 0) || 0)
      const lastHit = Number(item?.lastHit ?? 0) || 0
      const parts = [String(item?.space ?? 'default') || 'default']
      // 来源：spk 有值才出现；收起给前 8 位，点开给全。
      if (spk !== '' || open) parts.push(`来源 ${spk === '' ? '没记' : (open ? spk : spk.slice(0, 8))}`)
      // 重要度：imp 是 NULL 表示走自动公式，不算「有值」；点开时才明说「自动」。
      if (imp !== null || open) parts.push(`重要度 ${imp === null ? '自动' : Math.round(imp * 100) / 100}`)
      // 命中 0 次与「还没被想起」说的是同一件事，合并成一句，不重复。
      if (hits > 0) parts.push(`命中 ${hits} 次`)
      // tier 0 = 刚进来、tier 1 = 冷区默认值（1947/1978 条都是它），都不值得常显。
      if (tier >= 2 || open) parts.push(`tier ${tier}`)
      parts.push(lastHit > 0 ? `最后想起 ${open ? fmtTime(lastHit) : fmtClock(lastHit)}` : '还没被想起')
      parts.push(item?.hot === true ? '热区' : '冷区')
      if (open) {
        parts.push(`写入 ${fmtTime(Number(item?.at ?? 0))}`)
        // 库里没有单独的 tier 变动时间列：tier 只在这条被想起、或夜间重分层时变，
        // 所以能说准的只有「最后一次被想起」——写 ≈，不假装是精确时间。
        parts.push(`tier 变动 ${lastHit > 0 ? `≈ 最后想起 ${fmtTime(lastHit)}` : '夜间重分层（不记时间）'}`)
      }
      return parts.join(' · ')
    }

    /** 小圆角方块：只写一个短数字/短词，例如空间条目数。 */
    const badgeStyle = {
      fontSize: '10px', lineHeight: 1.5, padding: '0 6px', borderRadius: '999px',
      border: '1px solid rgba(128,128,128,0.3)', background: 'rgba(128,128,128,0.12)',
      whiteSpace: 'nowrap',
    }

    /**
     * 一条记忆：两行。第一行摘要（一行，超出省略），第二行元信息（一行小字）。
     * 点摘要才展开全文——详情是第三屏以后的事，默认不该占版面。
     *
     * 抽成纯函数是为了能直接渲染它做验收（见 exports.__test.entryRow），
     * 页面和验收脚本走的是同一份代码，不复制。
     */
    const entryRow = (item, opts) => {
      const open = opts?.open === true
      const toggle = typeof opts?.onToggle === 'function' ? opts.onToggle : () => {}
      const summary = String(item?.user ?? '').replace(/\s+/g, ' ').trim()
      const emo = (item?.emo ?? []).map((k) => EMO_TEXT[k] ?? k).join('/')
      return h('li', {
        key: String(item?.id),
        style: { padding: '3px 0', borderBottom: '1px solid rgba(128,128,128,0.12)' },
      },
      // 第一行：摘要。
      h('div', {
        role: 'button',
        tabIndex: 0,
        title: open ? '收起全文' : '展开全文',
        onClick: toggle,
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } },
        style: {
          fontSize: '12px', lineHeight: 1.5, cursor: 'pointer',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        },
      }, `${open ? '▾' : '▸'} ${summary === '' ? '（空）' : summary}`),
      // 第二行：元信息。收着时只有四段、按一行排完；点开才补全字段，允许折行。
      h('div', {
        style: {
          fontSize: '10px', lineHeight: 1.5, opacity: 0.5,
          ...(open
            ? { whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
            : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }),
        },
      }, entryMetaText(item, { open })),
      open
        ? h('div', { style: { margin: '3px 0 0', display: 'flex', flexDirection: 'column', gap: '2px' } },
          h('div', { style: { fontSize: '10px', opacity: 0.45 } },
            `${fmtTime(Number(item?.at ?? 0))} · 权重 ${Math.round(Number(item?.weight ?? 0) * 10) / 10}${emo === '' ? '' : ` · ${emo}`}`),
          h('div', { style: { fontSize: '12px', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
            String(item?.user ?? '')),
          String(item?.assistant ?? '') === '' ? null
            : h('div', { style: { fontSize: '12px', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.55 } },
              String(item.assistant)),
          h('div', { style: { display: 'flex', gap: '10px', marginTop: '1px' } },
            h('button', {
              type: 'button',
              onClick: typeof opts?.onCorrect === 'function' ? opts.onCorrect : undefined,
              style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '11px', opacity: 0.55, padding: 0, color: 'inherit' },
            }, '改'),
            h('button', {
              type: 'button',
              onClick: typeof opts?.onRetract === 'function' ? opts.onRetract : undefined,
              style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '11px', opacity: 0.55, padding: 0, color: 'inherit' },
            }, '撤回')),
        )
        : null,
      )
    }

    /**
     * 热区/冷区占比条：两段色块，纯 CSS（flex 按条数分宽），不引图表库。
     * 数字写在条下面，色条只给「大概占多少」的直觉。
     */
    const countBar = (counts) => {
      const hot = Math.max(0, Number(counts?.hot ?? 0))
      const cold = Math.max(0, Number(counts?.cold ?? 0))
      const sum = hot + cold
      if (sum === 0) return null
      const pct = (n) => Math.round((n / sum) * 1000) / 10
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
        h('div', {
          role: 'img',
          'aria-label': `热区 ${hot} 条，冷区 ${cold} 条`,
          style: {
            display: 'flex', height: '6px', borderRadius: '999px',
            overflow: 'hidden', background: 'rgba(128,128,128,0.16)',
          },
        },
        h('div', { title: `热区 ${hot} 条（${pct(hot)}%）`, style: { flex: `${hot} 1 0`, background: 'currentColor', opacity: 0.9 } }),
        h('div', { title: `冷区 ${cold} 条（${pct(cold)}%）`, style: { flex: `${cold} 1 0`, background: 'currentColor', opacity: 0.3 } })),
        h('div', { style: { fontSize: '10px', opacity: 0.55, whiteSpace: 'nowrap' } },
          `热 ${hot}（${pct(hot)}%） · 冷 ${cold}（${pct(cold)}%）`),
      )
    }

    // ───────────────── 人这一维 ─────────────────
    /**
     * 一张「人」的页要能同时说两件事，否则就是在撒谎：
     *   1. 认人表里有哪些人（名字、又名、几条、最近一次）；
     *   2. 这些数字**覆盖到多少记忆**——`spk` 空串是「不知道谁说的」，
     *      不是某个人。覆盖率低的时候必须在顶上写出来，不许当成完整。
     *
     * 下面四个都是纯函数（数据进、元素出），验收脚本直接渲染它们，
     * 页面走的也是同一份，不复制。
     */

    /** 顶部统计行：`N 个人 · 有名字 M · 只有号 K`。 */
    const peopleCountLine = (stats) => {
      const n = Math.max(0, Number(stats?.people ?? 0) || 0)
      const named = Math.max(0, Number(stats?.named ?? 0) || 0)
      const onlyId = Math.max(0, Number(stats?.onlyId ?? 0) || 0)
      return `${n} 个人 · 有名字 ${named} · 只有号 ${onlyId}`
    }

    /** 覆盖率低于这个数就要说一句「很多记忆还不知道是谁说的」。 */
    const PEOPLE_COVERAGE_FLOOR = 0.6

    /**
     * 覆盖率不足时的灰字。够了就返回 null（不写「覆盖率 100%」这种废话）。
     *
     * @param {object} stats `/people` 回来的 stats
     * @returns {string|null} 一句话，或 null
     */
    const peopleCoverageNote = (stats) => {
      const total = Math.max(0, Number(stats?.total ?? 0) || 0)
      if (total === 0) return null
      const cov = Math.max(0, Math.min(1, Number(stats?.coverage ?? 0) || 0))
      if (cov >= PEOPLE_COVERAGE_FLOOR) return null
      const pct = Math.round(cov * 1000) / 10
      return `覆盖率 ${pct}%，很多记忆还不知道是谁说的`
    }

    /**
     * 一个人：名字（或 8 位号）+ 条目数与最近一次 + 一行小字（又名 / 只有号 / 还没说过话）。
     *
     * 点名字展开——展开的内容由调用方塞进 `opts.children`（复用的是记忆行那套渲染）。
     */
    const peopleRow = (p, opts) => {
      const open = opts?.open === true
      const toggle = typeof opts?.onToggle === 'function' ? opts.onToggle : () => {}
      const spk = String(p?.spk ?? '')
      const name = String(p?.name ?? '').trim()
      const count = Math.max(0, Number(p?.count ?? 0) || 0)
      const lastAt = Number(p?.lastAt ?? 0) || 0
      const aka = (Array.isArray(p?.aka) ? p.aka : []).map((x) => String(x ?? '').trim()).filter((x) => x !== '')
      const parts = [count > 0 ? `${count} 条` : '还没说过话']
      if (lastAt > 0) parts.push(`最近 ${fmtClock(lastAt)}`)
      const notes = []
      if (aka.length > 0) notes.push(`又名 ${aka.join(' / ')}`)
      if (name === '') notes.push(`只有号 ${spk}，认人表里还没对上名字`)
      else if (count === 0) notes.push('认人表里有他，但还没有一句归到名下')
      return h('li', {
        key: spk,
        style: { padding: '3px 0', borderBottom: '1px solid rgba(128,128,128,0.12)' },
      },
      h('div', {
        role: 'button',
        tabIndex: 0,
        title: open ? '收起' : '看他最近说过什么',
        onClick: toggle,
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } },
        style: {
          fontSize: '12px', lineHeight: 1.5, cursor: 'pointer',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        },
      },
      `${open ? '▾' : '▸'} ${name === '' ? spk : name}`,
      h('span', { style: { fontSize: '10px', opacity: 0.5, marginLeft: '6px' } }, parts.join(' · '))),
      notes.length === 0
        ? null
        : h('div', { style: { fontSize: '10px', lineHeight: 1.5, opacity: 0.45 } }, notes.join(' · ')),
      open ? (opts?.children ?? null) : null,
      )
    }

    /**
     * 「人」这一页的正文：统计行 → 覆盖率灰字 → 名单 / 空状态。
     *
     * @param {{people?:Array, stats?:object}|null} data `/people` 的返回；null = 还没到
     * @param {{openSpk?:string, onToggle?:Function, entriesOf?:(spk:string)=>any}} [opts]
     */
    const peopleBody = (data, opts) => {
      const stats = data?.stats ?? null
      const list = Array.isArray(data?.people) ? data.people : []
      const note = peopleCoverageNote(stats)
      const head = h('div', { key: 'head', style: { display: 'flex', flexDirection: 'column', gap: '1px', padding: '0 0 3px' } },
        h('p', { style: { fontSize: '12px', margin: 0 } }, stats === null ? '读取中' : peopleCountLine(stats)),
        note === null
          ? null
          : h('p', { key: 'cov', style: { fontSize: '11px', opacity: 0.5, margin: 0, lineHeight: 1.5 } }, note))
      if (data === null) return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, head)
      if (list.length === 0) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          head,
          emptyBox('还没有人。等说话人回填跑完再来。', '人是从 `person` 表和 `entries.spk` 里长出来的，两边都空的时候就先空着，不编。'))
      }
      const openSpk = String(opts?.openSpk ?? '')
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        head,
        h('ol', { style: { display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyle: 'none' } },
          ...list.map((p) => peopleRow(p, {
            open: openSpk !== '' && openSpk === String(p?.spk ?? ''),
            onToggle: () => (typeof opts?.onToggle === 'function' ? opts.onToggle(String(p?.spk ?? '')) : undefined),
            children: typeof opts?.entriesOf === 'function' ? opts.entriesOf(String(p?.spk ?? '')) : null,
          }))))
    }

    /**
     * 「人」这一页：自己拉数据，展开某个人时再拉他最近 10 条。
     *
     * 展开的那 10 条直接用 `entryRow`（热区/冷区那一套）——同一份渲染，
     * 不复制第二份字段映射；两处一漂，展开的内容就会和记忆内容页对不上。
     */
    const PeopleView = ({ currentSpace }) => {
      const [data, setData] = React.useState(null)
      const [failed, setFailed] = React.useState('')
      const [seq, setSeq] = React.useState(0)
      const [openSpk, setOpenSpk] = React.useState('')
      const [entries, setEntries] = React.useState(null)
      // 展开的某一条记忆（全文）：和记忆内容页一样，默认只看摘要。
      const [memOpen, setMemOpen] = React.useState(null)
      const space = String(currentSpace ?? 'default') || 'default'

      React.useEffect(() => {
        let alive = true
        fetch(`/dsh-whale-memory/people?limit=50&space=${encodeURIComponent(space)}`, { headers: { accept: 'application/json' } })
          .then((res) => (res.ok ? res.json() : null))
          .then((json) => { if (alive) { setFailed(json === null ? 'HTTP 没给数据' : ''); setData(json) } })
          .catch((e) => { if (alive) { setFailed(String(e?.message ?? e)); setData(null) } })
        return () => { alive = false }
      }, [space, seq])

      React.useEffect(() => {
        if (openSpk === '') { setEntries(null); return undefined }
        let alive = true
        setEntries(null)
        fetch(`/dsh-whale-memory/people/entries?spk=${encodeURIComponent(openSpk)}&limit=10`, { headers: { accept: 'application/json' } })
          .then((res) => (res.ok ? res.json() : null))
          .then((json) => { if (alive) setEntries(json) })
          .catch(() => { if (alive) setEntries({ spk: openSpk, total: 0, items: [] }) })
        return () => { alive = false }
      }, [openSpk, seq])

      const toggle = (spk) => setOpenSpk((prev) => (prev === spk ? '' : spk))

      const entriesOf = (spk) => {
        if (String(spk) !== openSpk) return null
        if (entries === null) return h('div', { style: { fontSize: '11px', opacity: 0.45, padding: '2px 0 4px' } }, '读取中')
        const items = Array.isArray(entries?.items) ? entries.items : []
        if (items.length === 0) {
          return h('div', { style: { fontSize: '11px', opacity: 0.45, padding: '2px 0 4px' } }, '这个人名下还没有记忆。')
        }
        return h('ol', { style: { display: 'flex', flexDirection: 'column', margin: '1px 0 3px', padding: 0, listStyle: 'none' } },
          ...items.map((item) => entryRow(item, {
            open: memOpen === item.id,
            onToggle: () => setMemOpen(memOpen === item.id ? null : item.id),
          })))
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: badgeStyle }, `${space}`),
          h('button', {
            type: 'button',
            onClick: () => setSeq((n) => n + 1),
            title: '重新读一次',
            style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '11px', opacity: 0.6, padding: '2px 4px', color: 'inherit' },
          }, '刷新')),
        failed === ''
          ? null
          : h('p', { style: { fontSize: '11px', color: '#ff8f8f', margin: 0, lineHeight: 1.5 } }, `读取失败：${failed}`),
        peopleBody(data, { openSpk, onToggle: toggle, entriesOf }))
    }

    const apply = (ctx) => {
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
        gap: '12px',
        padding: '5px 0',
        borderTop: '1px solid rgba(128,128,128,0.10)',
      }
      // 名称和那行说明挤在同一行：整行 28px 上下，一屏能看见十几项。
      const labelStyle = { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: '0', flex: '1 1 auto' }
      const nameStyle = { fontSize: '13px', flexShrink: 0, whiteSpace: 'nowrap' }
      const descStyle = {
        fontSize: '11px', opacity: 0.5, minWidth: '0',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }
      const suffixStyle = { fontSize: '11px', opacity: 0.45, whiteSpace: 'nowrap' }
      const metaStyle = { fontSize: '11px', opacity: 0.6, fontFamily: 'monospace' }


      /**
       * 一行设置，只有三块：名称（左）· 控件（右）· 一行极短后缀。
       *
       *   注入字符上限（字）  整张卡的硬预算        [1000]  默认 4000
       *
       * 后缀只写「默认 X」或「已改」，二选一；单位在名称的括号里；
       * 长解释、配置路径、取值范围全进 title（悬停可见）。写操作的回执
       * （写中… / 已保存 / 失败：原因）是最右边那块临时文字，平时是空的。
       */
      const Row = ({ field, value, base, overridden, disabled, save, onWrite, onReset }) => {
        // 值还没下发时用 Host 的 base 层（schema 默认）兜住：只显示、不回写，
        // 也不在客户端写死数字（groupDump/weekly 的默认值只有 LAYER_DEFAULTS 一份）。
        const fallback = pick(base, field.path) ?? field.fallback
        const shown = value === undefined || value === null ? fallback : value
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
          if (field.kind === 'select') {
            // 下拉：选项写死在 GROUPS 里，值直接写回配置（和输入框一样一次提交，没有草稿态）。
            const opts = Array.isArray(field.options) ? field.options : []
            const current = opts.some((o) => String(o.value) === String(shown))
              ? String(shown)
              : String(opts[0]?.value ?? '')
            return h('select', {
              value: current,
              disabled,
              'aria-label': field.label,
              onChange: (e) => onWrite(e.target.value),
              style: {
                fontSize: '11px', padding: '1px 4px', borderRadius: '4px',
                border: '1px solid currentColor', background: 'transparent', color: 'inherit',
                // 原生下拉弹出层由浏览器画，默认浅色底；不钉死文字色就会白底白字。
                colorScheme: 'light',
              },
            }, ...opts.map((o) => h('option', {
              key: String(o.value),
              value: String(o.value),
              style: { color: '#111', background: '#fff' },
            }, o.label ?? String(o.value))))
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
          ? `${field.min ?? ''}–${field.max ?? ''}`
          : ''
        // 长解释、配置路径、取值范围都只放在 title 里（悬停可见），行内不再常驻。
        const hover = [field.long, `${PATH_TEXT(field.path)}${range === '' ? '' : ` (${range})`}`]
          .filter((x) => typeof x === 'string' && x !== '')
          .join('\n')
        const saveText = writeStateOf(save)
        const saveFailed = save !== undefined && save !== null && save.status === 'error'

        // 默认值不写死在客户端：一律从快照的 base 层取（schema 默认就是那一份）。
        const baseShown = pick(base, field.path)
        const baseText = baseShown === undefined || baseShown === null || baseShown === ''
          ? ''
          : (typeof baseShown === 'boolean' ? (baseShown ? '开' : '关') : String(baseShown))
        // 行尾只留一块极短的后缀：「默认 X」或「已改」，二选一。
        // 单位进名称的括号，范围进 title——三件套并排是上一版的读法，太吵。
        const suffix = overridden ? '已改' : (baseText === '' ? '' : `默认 ${baseText}`)

        return h(
          'div',
          { style: rowStyle, title: hover },
          h(
            'div',
            { style: labelStyle },
            h('span', { style: nameStyle }, field.label),
            field.desc
              ? h('span', { style: descStyle }, field.desc)
              : null,
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
            suffix === ''
              ? null
              : h('span', { style: suffixStyle }, suffix),
            // 写操作的回执：写中… / 已保存 / 失败：<原因>。失败是红字，就地留着。
            h('span', {
              role: 'status',
              title: saveFailed ? String(save.message ?? '') : '',
              style: {
                fontSize: '11px',
                minWidth: '0',
                color: saveFailed ? '#ff8f8f' : 'inherit',
                opacity: saveFailed ? 1 : 0.55,
              },
            }, saveText),
          ),
        )
      }

      /**
       * 热区 / 冷区的内容预览。
       *
       * 纯只读为主：这里只有文字和切换按钮，写入口只有「改 / 撤回 / 切空间」三处，
       * 都各自带一次确认。
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

        // 空间下拉读现成的 /spaces 列表：整页共用一份，开一次就够，不跟着子页签反复拉。
        React.useEffect(() => {
          if (spaces !== null) return undefined
          let alive = true
          fetch('/dsh-whale-memory/spaces', { headers: { accept: 'application/json' } })
            .then((res) => (res.ok ? res.json() : null))
            .then((json) => { if (alive) setSpaces(Array.isArray(json?.spaces) ? json.spaces : []) })
            .catch(() => { if (alive) setSpaces([]) })
          return () => { alive = false }
        }, [spaces])

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
            // 「关于你的事实」那一段卡片里到底带了哪几条：后端按 recall 的同一口径
            // （listFacts + factMax）算好递过来，这里只照着念，不另外筛一遍。
            const facts = Array.isArray(data.facts) ? data.facts : []
            const cap = Number(data.factMax ?? 0)
            // 画像正文逐行铺开：情绪词那一行要单独标出来（旧名「情绪底色」，已改名）。
            const lines = text.split('\n').map((s) => s.trim()).filter((s) => s !== '')
            const isEmoLine = (s) => /^(对方话里的情绪词|情绪底色)/.test(s)
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
              // ── 卡片里「关于你的事实」实际取到的原文（只读） ──
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: '11px', fontWeight: 600, opacity: 0.75 } }, '关于你的事实（卡片里实际取到的）'),
                  h('span', { style: badgeStyle }, `${facts.length} / 上限 ${cap}`)),
                facts.length === 0
                  ? emptyBox('这一段现在是空的。', cap === 0 ? '事实条数上限设成了 0，卡片永远不带事实。' : '事实由夜班从对话里抽，攒到够稳才会落库；抽不到的宁可不写。')
                  : h('ol', {
                    style: { display: 'flex', flexDirection: 'column', gap: '1px', margin: 0, padding: '0 0 0 16px' },
                  }, ...facts.map((f) => h('li', {
                    key: f,
                    style: { fontSize: '12px', lineHeight: 1.55, overflowWrap: 'anywhere' },
                  }, String(f))))),
              text === ''
                ? emptyBox('还没有画像正文。', '画像在梳理时重蒸；库里的记忆还少，或夜班没跑过。')
                : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1px' } },
                  ...lines.map((line, i) => h('div', {
                    key: `p${i}`,
                    style: {
                      fontSize: '12px', lineHeight: 1.6, overflowWrap: 'anywhere',
                      opacity: isEmoLine(line) ? 0.95 : 0.85,
                    },
                  },
                  line,
                  isEmoLine(line)
                    ? h('span', {
                      style: { marginLeft: '6px', fontSize: '10px', opacity: 0.55 },
                      title: '这一行统计的是对方说过的情绪词，不是我的心情；我的心情在 mood_log。',
                    }, '（旧名「情绪底色」，已改名）')
                    : null))),
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
                // 空间下拉搬到页面顶部了（一个控制管整页），这里只留排法/视图/边数。
                h('span', { style: metaStyle }, `空间 ${spaceNow()}`),
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
                      style: { fontSize: '11px', padding: '1px 4px', borderRadius: '4px', border: '1px solid currentColor', background: 'transparent', color: 'inherit', colorScheme: 'light' },
                    }, ...[40, 80, 120, 200, 400].map((n) => h('option', {
                      key: n, value: n, style: { color: '#111', background: '#fff' },
                    }, `${n} 条`)))),
              ),
              // 图/列表上方那行统计：实体、边、这次实际画了几条，一眼对得上画面。
              nodes.length === 0
                ? null
                : h('p', { style: { fontSize: '11px', opacity: 0.6, margin: 0, lineHeight: 1.5 } },
                  `实体 ${scene === null ? nodes.length : scene.stats.nodes}${omitted > 0 ? `（省略 ${omitted}）` : ''} · 边 ${links.length} · 本次画 ${scene === null ? 0 : scene.stats.edgesDrawn} 条边`),
              nodes.length === 0
                ? emptyBox('这个空间还没有实体。', '实体由图谱重建时从原文里抽，抽不出名字就攒不出点；记忆够多、名字够重复才会出现。')
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
            if (list.length === 0) {
              return emptyBox('还没有空间记录。', '空间是写入时贴的标签；一条记忆都还没进来，也就没有可分的格子。')
            }
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

          // 热区 / 冷区：一条记忆两行（摘要 + 元信息），点开才看全文。
          if (items.length === 0) {
            return emptyBox(
              zone === 'hot' ? '热区是空的。' : '冷区是空的。',
              zone === 'hot'
                ? '热区为空：最近没有命中。热区按召回与权重重分层，命中过才会进来。'
                : '冷区为空：记忆要么都还在热区，要么这个空间还没写过东西。',
            )
          }
          return h('ol', { style: { display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyle: 'none' } },
            ...items.map((item) => entryRow(item, {
              open: memOpen === item.id,
              onToggle: () => setMemOpen(memOpen === item.id ? null : item.id),
              onCorrect: async () => {
                const next = window.prompt('改成什么？（只改用户侧那条）', item.user)
                if (next === null || next.trim() === '') return
                const ok = await postJson('/dsh-whale-memory/entries/correct', { id: item.id, text: next })
                if (ok) setSeq((n) => n + 1)
              },
              onRetract: async () => {
                if (!window.confirm('撤回这条记忆？原件会留在 revisions 里。')) return
                const ok = await postJson('/dsh-whale-memory/entries/retract', { id: item.id })
                if (ok) setSeq((n) => n + 1)
              },
            })))
        })()

        return h(
          // 用 div 不用 section：这块挂在「记忆内容」那条 tabpanel 里，
          // `<section>` 套 `<section>` 让「哪块是这一页」变得要数深度，不值当。
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          // ── 空间选择：下拉看哪个空间 + 当前空间的条目数徽标 + 热/冷占比条 ──
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('label', { style: { fontSize: '11px', opacity: 0.65, display: 'flex', alignItems: 'center', gap: '4px' } },
              '空间',
              h('select', {
                value: spaceNow(),
                onChange: (e) => { setGraphSpace(e.target.value); setMemOpen(null) },
                title: '看哪个空间（只影响这一页看到的东西，不改配置）',
                style: { fontSize: '11px', padding: '1px 4px', borderRadius: '4px', border: '1px solid currentColor', background: 'transparent', color: 'inherit' },
              }, ...(spaces === null || spaces.length === 0
                ? [{ id: spaceNow(), count: null }]
                : spaces).map((sp) => h('option', { key: sp.id, value: sp.id },
                sp.count === null ? sp.id : `${sp.id} · ${sp.count} 条`)))),
            h('span', { style: badgeStyle },
              spaces === null
                ? '条数读取中'
                : `${spaceNow()} ${(spaces.find((s) => s.id === spaceNow())?.count ?? 0)} 条`),
            spaces !== null && spaces.length > 1 && spaceNow() !== (currentSpace || 'default')
              ? h('span', { style: { fontSize: '10px', opacity: 0.5 } }, `配置里的当前空间是 ${currentSpace || 'default'}（切空间在「空间」那一栏）`)
              : null),
          // 两段色条：热/冷各占多少。没数的时候整块不出现，下面另有空状态说明。
          countBar(settled ? data.counts : null),
          actErr === ''
            ? null
            : h('p', { style: { fontSize: '11px', color: '#ff8f8f', margin: '0 0 4px', lineHeight: 1.5 } }, actErr),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0', flexWrap: 'wrap' } },
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
        // 高级折叠：按区分开记（每个区的「高级（N 项）」按钮各管各的）。
        const [advOpen, setAdvOpen] = React.useState({})
        // 情绪现值：状态条和「它现在怎么想我」都读它。
        const [moodNow, setMoodNow] = React.useState(null)
        const [actionNote, setActionNote] = React.useState('')
        const [tick, setTick] = React.useState(0)
        // 每个字段的写回执：key = 字段路径。写中…/已保存/失败：原因，就地显示。
        const [save, setSave] = React.useState({})
        const saveStateFor = (key) => (state) => setSave((prev) => ({ ...prev, [key]: state }))

        /**
         * 当前页签（区 id）。开局三处按优先级认一遍：
         *   1. 地址栏 `#tab=<slug>`——别人分享来的链接说了算
         *   2. localStorage 上一次停的那一页
         *   3. 第一页
         * 服务端渲染（测试）里 window 没有 location/localStorage，全走兜底，不抛。
         */
        const [tab, setTab] = React.useState(() => tabOf(
          (() => {
            try { return parseTabHash(window.location.hash) } catch { return undefined }
          })()
          ?? (() => {
            try { return window.localStorage.getItem(TAB_KEY) } catch { return undefined }
          })(),
        ))

        // 页签变了：记进 localStorage，并把地址栏写成 `#tab=<slug>`。
        // 用 replaceState 而不是改 location.hash——后者会去找同名锚点、把页面滚走。
        React.useEffect(() => {
          const zone = ZONES.find((z) => z.id === tab) ?? ZONES[0]
          try { window.localStorage.setItem(TAB_KEY, zone.id) } catch { /* 隐私模式没有 localStorage */ }
          const want = `#tab=${zone.slug}`
          try {
            if (window.location.hash !== want) window.history.replaceState(null, '', want)
          } catch {
            try { window.location.hash = want } catch { /* 没有 history 就算了，页签照样能切 */ }
          }
        }, [tab])

        // 手工改地址栏 / 点开另一条分享链接：hashchange 跟过去。
        React.useEffect(() => {
          const onHash = () => {
            const next = parseTabHash(window.location.hash)
            if (next !== undefined) setTab(next)
          }
          window.addEventListener('hashchange', onHash)
          return () => window.removeEventListener('hashchange', onHash)
        }, [])

        // 键盘 ←/→ 切页签。正在输入框/下拉里敲字时不抢键。
        React.useEffect(() => {
          const onKey = (ev) => {
            if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return
            if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return
            const el = ev.target
            const tag = String(el?.tagName ?? '').toUpperCase()
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable === true) return
            ev.preventDefault()
            setTab((prev) => {
              const i = ZONES.findIndex((z) => z.id === prev)
              const step = ev.key === 'ArrowRight' ? 1 : -1
              return ZONES[(((i < 0 ? 0 : i) + step) + ZONES.length) % ZONES.length].id
            })
          }
          window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        }, [])

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
          load('/dsh-whale-memory/mood?days=7', setMoodNow)
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

        // ───────────── 顶部状态条：一眼看「活着没有、对不对」 ─────────────
        const capRaw = pick(snaps.memory.value, ['cardDailyMax'])
        const injectRec = memoryStatus?.cardInject ?? {}
        const today = localDayKey()
        const injectToday = injectRec.day === today ? Number(injectRec.count ?? 0) : 0
        const capText = typeof capRaw === 'number' ? ` / ${capRaw}` : ''
        const lastSkip = injectRec.lastSkip && injectRec.lastSkip.reason
          ? `${String(injectRec.lastSkip.reason)}${injectRec.lastSkip.conf != null ? `（置信 ${Number(injectRec.lastSkip.conf).toFixed(2)}）` : ''}`
          : ''
        const taskOpen = memoryStatus?.taskStack?.open
        // 「它现在怎么想我」和诊断区都要这两样：情绪那一格、安装副本那一格。
        const moodRec = Array.isArray(moodNow?.recent) ? (moodNow.recent[0] ?? null) : null
        const inst = memoryStatus?.install ?? null
        const chips = statusChipsOf(memoryStatus, moodNow, capRaw)
        const statusBar = h('div', {
          style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))', gap: '8px' },
        }, ...chips.map((c) => Stat(c.label, c.value, c.hint)))

        // ───────────── 它现在怎么想我（只读预览） ─────────────
        const previewLine = (label, text) => h('div', {
          key: label,
          style: { display: 'flex', gap: '8px', alignItems: 'baseline', minWidth: 0 },
        },
        h('span', { style: { fontSize: '11px', opacity: 0.5, minWidth: '72px', flexShrink: 0 } }, label),
        h('span', { style: { fontSize: '12px', lineHeight: 1.5, minWidth: 0, overflowWrap: 'anywhere' } }, text),
        )

        const nowView = memoryStatus === null
          ? h('p', { style: { fontSize: '11px', opacity: 0.55, margin: 0 } }, '读不到状态（/status 没回），下面是配置项。')
          : h('div', {
            style: {
              display: 'flex', flexDirection: 'column', gap: '6px',
              border: '1px solid rgba(128,128,128,0.18)', borderRadius: '10px',
              padding: '10px 12px', background: 'rgba(128,128,128,0.04)',
            },
          },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' } },
            h('span', { style: { fontSize: '12px', fontWeight: 600 } }, '这一轮它会带什么进上下文'),
            h('span', { style: { fontSize: '10px', opacity: 0.45 } }, '只读预览 · 这里不能改'),
          ),
          // 五行压两行（2026-11-07）：原来「记忆卡/在身上的/能想起来/情绪/任务栈」各占一行，
          // 和上面那条状态条重复；现在合成「这一轮带什么」+「它现在什么状态」两句。
          previewLine('这一轮', `卡 ${injectToday}${capText || ' 次'}${injectRec.lastChars ? ` · ${injectRec.lastChars} 字` : ''}`
            + ` · 召回 ≤${pick(snaps.memory.value, ['recallMax']) ?? DASH} 条（${memoryStatus.axes?.scene ?? DASH} 场景）`
            + (taskOpen ? ` · 手上 ${taskOpen} 条` : '')
            + (lastSkip === '' ? '' : ` · 上次拦下：${lastSkip}`)),
          previewLine('身上', `热区 ${memoryStatus.hot ?? 0} · 事实 ${memoryStatus.facts ?? 0} · 场景 ${memoryStatus.scenes ?? 0} · 日记 ${memoryStatus.diary ?? 0}`
            + ` · 情绪 ${moodRec ? `${Math.round(Number(moodRec.mood))}` : DASH}`),
          )

        // ───────────── 危险与诊断：诊断统计（折叠里） ─────────────
        const diagStats = (() => {
          if (memoryStatus === null) return null
          const sp = memoryStatus.speaker ?? {}
          const ad = memoryStatus.admit ?? {}
          const rows = [
            ['打分公式', `${memoryStatus.axes?.mode ?? DASH}（配置 ${memoryStatus.axes?.sceneConfigured ?? DASH} → 生效 ${memoryStatus.axes?.scene ?? DASH}）`],
            ['门槛', String(memoryStatus.axes?.threshold ?? DASH)],
            ['三轴调试日志', memoryStatus.axes?.debug === true ? '开' : '关'],
            ['说话人覆盖率', sp.migrated === false ? '库还没迁移（spk 列不存在）' : `${sp.covered ?? 0} / ${sp.total ?? 0} = ${Math.round(Number(sp.ratio ?? 0) * 1000) / 10}%`],
            ['取舍影子（近 7 天）', `判 ${ad.total ?? 0} 条 · keep ${ad.keep ?? 0} / log-only ${ad.logOnly ?? 0} / drop ${ad.drop ?? 0} · 真拦下 ${ad.applied ?? 0}${ad.enforcing === true ? '（影子已关，正在拦）' : '（影子开着，只记账）'}`],
            ['向量服务', `${memoryStatus.embedOk ? '正常' : '降级'} ${memoryStatus.embedUrl ?? ''}`],
            ['运行位置', String(inst?.runningFrom ?? memoryStatus.dbPath ?? '')],
          ]
          return h('div', {
            style: {
              display: 'flex', flexDirection: 'column', gap: '4px',
              border: '1px solid rgba(128,128,128,0.18)', borderRadius: '10px',
              padding: '10px 12px', background: 'rgba(128,128,128,0.04)', marginTop: '2px',
            },
          }, ...rows.map(([k, v]) => previewLine(k, v)))
        })()

        /**
         * 诊断页自己的那条计数：状态条只在第一页，所以「这张脸对不对」的事
         * 跟着诊断走——不折叠、不用点开高级才看得见。
         */
        const diagCounter = (() => {
          if (memoryStatus === null) {
            return h('p', { style: { fontSize: '11px', opacity: 0.55, margin: '0 0 2px' } }, '读不到状态（/status 没回），下面是配置项。')
          }
          const sp = memoryStatus.speaker ?? {}
          const text = sp.migrated === false
            ? '说话人：库还没迁移（spk 列不存在）'
            : `说话人覆盖 ${sp.covered ?? 0} / ${sp.total ?? 0} 条 · ${Math.round(Number(sp.ratio ?? 0) * 1000) / 10}%`
          return h('p', {
            style: { fontSize: '11px', opacity: 0.6, margin: '0 0 2px', lineHeight: 1.6 },
            title: '每条记忆有没有记下「谁说的」；只统计，不影响任何写入。',
          }, text)
        })()

        /** 一行配置。只读时控件灰掉，页首另有一句话说明为什么要手改文件。 */
        const renderFieldRow = (group, field) => {
          const key = `${group.form}:${PATH_TEXT(field.path)}`
          const snap = snaps[group.form]
          return h(Row, {
            key,
            field,
            value: pick(snap.value, field.path),
            base: snap.base,
            overridden: pick(snap.user, field.path) !== undefined,
            disabled: !snap.writable,
            save: save[key],
            onWrite: (value) => writePath(forms[group.form], field.path, value, saveStateFor(key)),
            onReset: () => resetPath(forms[group.form], field.path, saveStateFor(key)),
          })
        }

        /**
         * 高级折叠里的一小组：组名 + 一句话（≤30 字，长解释在 title 里）。
         *
         * `fields` 只是这一组里落在「高级」的那些——一组可能一半常用一半高级。
         */
        const renderGroupCard = (group, fields) => h('div', {
          key: `${group.form}:${group.title}`,
          style: { display: 'flex', flexDirection: 'column', minWidth: 0, marginTop: '8px' },
        },
        h('h4', {
          style: { fontSize: '12px', margin: '0 0 1px', fontWeight: 600, opacity: 0.85 },
          title: group.long ?? '',
        }, group.title),
        h('p', {
          style: { fontSize: '11px', opacity: 0.45, margin: 0 },
          title: group.long ?? '',
        }, group.hint),
        ...fields.map((field) => renderFieldRow(group, field)),
        )

        // ───────────── 危险操作：会动真数据，先问一句 ─────────────
        const runAction = (action) => {
          if (action.confirm !== '' && !window.confirm(action.confirm)) return
          const url = action.id === 'nightly' ? NIGHTLY_URL : action.id === 'backup' ? '/dsh-whale-memory/backups' : '/dsh-whale-memory/desk'
          if (action.id === 'nightly') { setNightBusy(true); setNightNote('') } else { setActionNote(`${action.label}…`) }
          fetch(url, { method: 'POST', headers: { accept: 'application/json' } })
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
            .then((json) => {
              if (json?.ok !== true) {
                const why = json?.reason ?? json?.errors?.[0] ?? '未知原因'
                if (action.id === 'nightly') setNightNote(`没跑成：${why}`)
                else setActionNote(`${action.label}没成：${why}`)
                return
              }
              if (action.id === 'nightly') {
                const merged = Number.isFinite(Number(json.merged)) ? `${Number(json.merged)}` : '数未知'
                const pruned = Number.isFinite(Number(json?.settle?.pruned)) ? `清理 ${Number(json.settle.pruned)}` : '清理数未知'
                setNightNote(`跑完了：并入 ${merged} / ${pruned}`)
              } else if (action.id === 'backup') {
                setActionNote(`备好了：${json.bytes ?? 0} 字节 · ${json.path ?? ''}`)
              } else {
                setActionNote(`重蒸好了：${json.bytes ?? 0} 字节`)
              }
              setTick((n) => n + 1)
            })
            .catch((error) => {
              const why = String(error?.message ?? '请求失败')
              if (action.id === 'nightly') setNightNote(`没跑成：${why}`)
              else setActionNote(`${action.label}没成：${why}`)
            })
            .finally(() => { if (action.id === 'nightly') setNightBusy(false) })
        }

        const pillStyle = {
          border: '1px solid rgba(128,128,128,0.35)',
          borderRadius: '999px',
          padding: '3px 12px',
          fontSize: '11px',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          opacity: 0.85,
          flexShrink: 0,
        }

        /**
         * 会动真数据的一行：名字 + 一个短词按钮（左边已经有名字，按钮不再重写一遍）。
         * 说明与确认文案都在 title 里，点下去还是会再问一次。
         */
        const renderActionRow = (action) => h('div', {
          key: action.id,
          style: rowStyle,
          title: [action.desc, action.confirm].filter((x) => x !== '').join('\n'),
        },
        h('div', { style: labelStyle },
          h('span', { style: nameStyle }, action.label),
          h('span', { style: descStyle }, action.desc),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 } },
          h('button', {
            type: 'button',
            disabled: action.id === 'nightly' && nightBusy,
            onClick: () => runAction(action),
            style: {
              ...pillStyle,
              cursor: action.id === 'nightly' && nightBusy ? 'progress' : 'pointer',
              opacity: action.id === 'nightly' && nightBusy ? 0.5 : 0.85,
            },
          }, action.id === 'nightly' && nightBusy ? '跑着…' : action.act),
        ))

        /** 按钮跑完的那一行回执；没有就整行不出现。 */
        const actionNotes = [nightNote, actionNote].filter((x) => x !== '')

        const footNotes = []
        if (memoryStatus !== null) {
          footNotes.push(`抢救 ${memoryStatus.stats?.salvaged ?? 0} · 合并 ${memoryStatus.stats?.merged ?? 0} · 记忆库 ${memoryStatus.dbPath ?? ''}`)
        }
        if (trend !== null && Array.isArray(trend.series) && trend.series.length > 0) {
          footNotes.push(`近 7 天：${trend.series.map((d) => `${d.day.slice(5)} 蒸馏 ${d.distillCalls ?? 0} / 想起 ${d.recalled ?? 0}`).join('　')}`)
        }
        if (proactiveStatus !== null) {
          const lastSentAt = proactiveStatus.state?.lastSentAt
          footNotes.push(`主动消息：${proactiveStatus.isQuietHours ? '免打扰中' : '可发'} · 今天 ${proactiveStatus.state?.dailyCount?.[localDayKey()] ?? 0} 条 · ${lastSentAt ? `上次开口 ${fmtTime(Number(lastSentAt))}` : '还没跑过'}`)
        }

        /**
         * 页签条：吸顶、当前页签高亮、点一下切。
         *
         * 吸顶用的是半透明灰 + `backdrop-filter`，不写死主题色——浅色深色都
         * 只略微提亮一层，滚过去的内容被糊掉，名字始终读得清。
         */
        const tabbar = h('div', {
          role: 'tablist',
          'aria-label': '设置分类',
          style: {
            position: 'sticky',
            top: 0,
            zIndex: 3,
            display: 'flex',
            gap: '6px',
            flexWrap: 'wrap',
            margin: '0 0 4px',
            padding: '6px 0',
            background: 'rgba(128,128,128,0.10)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            borderBottom: '1px solid rgba(128,128,128,0.18)',
          },
        },
        ...ZONES.map((zone) => {
          const active = zone.id === tab
          return h('button', {
            key: zone.id,
            type: 'button',
            role: 'tab',
            id: `${NS}-tab-${zone.slug}`,
            'aria-selected': active ? 'true' : 'false',
            'aria-controls': `${NS}-panel-${zone.slug}`,
            // 只有当前页签进 Tab 序列：一次 Tab 就到页签条，←→ 在条内移动。
            tabIndex: active ? 0 : -1,
            title: zone.long,
            onClick: () => setTab(zone.id),
            style: {
              ...pillStyle,
              fontWeight: active ? 600 : 400,
              opacity: active ? 1 : 0.6,
              background: active ? 'rgba(128,128,128,0.22)' : 'transparent',
              borderColor: active ? 'rgba(128,128,128,0.62)' : 'rgba(128,128,128,0.28)',
              whiteSpace: 'nowrap',
            },
          }, zone.title)
        }))

        /** 一个区的地址（页签面板 id 与分享用的 hash 都由它派生）。 */
        const panelId = (zone) => `${NS}-panel-${zone.slug}`

        /**
         * 一个区（= 一页）：常用项直接摊开，其余收进「高级（N 项）」折叠。
         *
         * 常用 = `tier: 'core'`（全页合计 ≤14 项，选的是最可能被改的那几项）；
         * 高级 = 其余全部，默认折叠。折叠是每个区各一个，不串台。
         *
         * 非当前页**照样渲染，只加 `hidden`**：未保存的输入是 Row 自己的组件
         * 状态（草稿 + 「正在敲」标记），一卸载就回到旧值——切页丢字比切页慢
         * 更不能接受；`hidden` 还顺手把它移出无障碍树，屏幕阅读器只读当前页。
         */
        const renderZone = (zone) => {
          const active = zone.id === tab
          const groups = available.filter((g) => (g.zone ?? 'intake') === zone.id)
          const coreFields = []
          const advFields = []
          for (const group of groups) {
            for (const field of group.fields) {
              (field.tier === 'core' ? coreFields : advFields).push({ group, field })
            }
          }
          const coreActions = zone.id === 'diag' ? ACTIONS.filter((a) => a.tier === 'core') : []
          const advActions = zone.id === 'diag' ? ACTIONS.filter((a) => a.tier === 'adv') : []
          const advCount = advFields.length + advActions.length
          const open = advOpen[zone.id] === true

          const coreBody = []
          // 状态条挂在第一页顶部，不往下每页重复一遍。
          if (zone.id === ZONES[0].id) coreBody.push(statusBar)
          if (zone.id === 'now') coreBody.push(nowView)
          if (zone.id === 'diag') coreBody.push(diagCounter)
          for (const item of coreFields) coreBody.push(renderFieldRow(item.group, item.field))
          for (const action of coreActions) coreBody.push(renderActionRow(action))
          // 记忆内容（热区/冷区/场景/画像/图谱/空间）自己占一页：
          // 第一页只留状态条 + 只读预览，翻东西到这一页来。
          // 人自己占一页：只读，点开一个人看他最近十条（复用记忆行渲染）。
          if (zone.id === 'people') {
            coreBody.push(h(PeopleView, {
              key: 'people',
              currentSpace: memoryStatus?.spaceConfigured ?? memoryStatus?.space ?? 'default',
            }))
          }
          if (zone.id === 'content') {
            coreBody.push(h(EntriesView, {
              key: 'entries',
              // 配置里的空间，不是「最后一条记忆的 space」——后者会随写入漂走，
              // 让「当前空间」说实话。旧字段保留给别处用，这里只认配置。
              currentSpace: memoryStatus?.spaceConfigured ?? memoryStatus?.space ?? 'default',
              spaceSave: save.space,
              onSwitchSpace: (name) => writePath(memoryForm, ['space'], String(name), saveStateFor('space')),
            }))
          }

          const advBody = []
          if (open) {
            if (zone.id === 'diag' && diagStats !== null) advBody.push(diagStats)
            for (const group of groups) {
              const fields = group.fields.filter((f) => f.tier !== 'core')
              if (fields.length > 0) advBody.push(renderGroupCard(group, fields))
            }
            for (const action of advActions) advBody.push(renderActionRow(action))
            if (actionNotes.length > 0) {
              advBody.push(h('p', {
                key: 'actionNotes',
                style: { fontSize: '11px', opacity: 0.6, margin: '4px 0 0' },
              }, actionNotes.join(' · ')))
            }
          }

          if (coreBody.length === 0 && advCount === 0) return null
          return h('section', {
            key: zone.id,
            id: panelId(zone),
            role: 'tabpanel',
            'aria-labelledby': `${NS}-tab-${zone.slug}`,
            hidden: !active,
            style: {
              // hidden 属性对上样式表里的 display 是不保证赢的（UA 的 [hidden]
              // 打不过行内 display），所以两边一起写：语义靠 hidden，视觉靠 display。
              display: active ? 'flex' : 'none',
              flexDirection: 'column',
              gap: '2px',
              scrollMarginTop: '44px',
            },
          },
          h('h2', {
            style: { fontSize: '14px', margin: '0 0 1px', fontWeight: 600 },
            title: zone.long,
          }, zone.title),
          h('p', {
            style: { fontSize: '11px', opacity: 0.45, margin: '0 0 4px' },
            title: zone.long,
          }, zone.hint),
          ...coreBody,
          advCount === 0
            ? null
            : h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' } },
              h('button', {
                type: 'button',
                onClick: () => setAdvOpen((prev) => ({ ...prev, [zone.id]: prev[zone.id] !== true })),
                style: pillStyle,
              }, open ? '收起高级' : `高级（${advCount} 项）`),
              open ? null : h('span', { style: { fontSize: '11px', opacity: 0.4 } }, '平时不用动的都在这里'),
            ),
          open
            ? h('div', { style: { display: 'flex', flexDirection: 'column' } }, ...advBody)
            : null,
          )
        }

        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '6px 0 10px' } },
          h('header', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' },
          },
          h('h2', { style: { fontSize: '16px', margin: 0, fontWeight: 600 } }, '鲸娘记忆'),
          h('button', {
            type: 'button',
            onClick: () => setTick((n) => n + 1),
            style: { ...pillStyle, opacity: 0.75 },
          }, '刷新'),
          ),
          tabbar,
          // 只读态不是「控件灰了」就完事：说清为什么灰、要改该动哪个文件。
          snaps.memory.writable || available.every((g) => g.form !== 'memory')
            ? null
            : h('p', {
              style: { fontSize: '11px', color: '#ff8f8f', margin: 0, lineHeight: 1.6 },
            }, '配置文件只读（writable=false），控件改不了：手改 ~/.dsh/profiles/web/cordis.patch.yml 的 config 段，改完重启 dsh。'),
          ...ZONES.map(renderZone),
          ...footNotes.map((text, i) => h('p', {
            key: `n${i}`,
            style: { fontSize: '11px', opacity: 0.55, margin: 0, lineHeight: 1.6 },
          }, text)),
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
      pick, writePath, resetPath, normalizeNumber, GROUPS, ZONES, ACTIONS, statusChipsOf, writeStateOf,
      // 页签：地址栏/localStorage 两条路子都是纯函数，测试里直接调，不用起浏览器。
      TAB_KEY, parseTabHash, tabOf,
      // 图谱几何也是纯函数：测试和 scripts/graph-svg.mjs 借这一口直接调，不复制布局代码。
      graphScene: buildGraphScene, graphLabel: glLabel, GL_W, GL_H, CAM_MIN, CAM_MAX, GL_LABEL_ZOOM,
      // 记忆内容那几块的小构件：验收脚本直接渲染它们（页面走的也是这几份，不复制）。
      entryRow, entryMetaText, countBar, emptyBox, sameDay,
      // 「人」这一页：统计行 / 覆盖率灰字 / 一个人一行 / 整页正文，都是纯函数，验收直接渲染。
      peopleCountLine, peopleCoverageNote, peopleRow, peopleBody, PEOPLE_COVERAGE_FLOOR,
    }
    exports.apply = apply
    return module.exports
  },
})
