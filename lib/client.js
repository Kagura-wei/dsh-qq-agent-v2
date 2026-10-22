/**
 * dsh-qq-agent-v2 —— 浏览器半边（客户端插件）。
 *
 * 职责：往 DSH 设置面板注册一个「群聊助手」分区，并按宿主插件的
 * Config（schemastery schema）自动生成全部字段的表单。
 *
 * 加载机制（对齐 DSH 客户端插件约定）：
 *   1. package.json 声明 `dsh.client`（platform: web）
 *   2. DSH 通过 `exports["./client"]` 发现本文件
 *   3. 本文件以 `window.__ModuleLoader__.load({ id, factory })` 注册，
 *      框架注入 require，可拿到 react / react-dom / ui-primitives 等
 *   4. factory 返回的模块里导出 `inject` 与 `apply`，由客户端运行时装上
 *
 * 为什么是手写而不是打包：本分区只需要"渲染一组表单字段 + 保存"，
 * 不需要样式模块、多标签页、引导动画。框架已经注入了 React，
 * 直接用 React.createElement 即可，省掉整条构建链。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-agent-v2',
  factory: (require) => {
    // 不同打包形态下 require('react') 可能是 CJS 对象，也可能是带 default 的
    // ESM namespace。取到真正的那个，否则 createElement 会是 undefined，
    // 组件一渲染就崩。
    const reactModule = require('react')
    const React =
      reactModule && typeof reactModule.createElement === 'function'
        ? reactModule
        : (reactModule?.default ?? reactModule)

    if (!React || typeof React.createElement !== 'function') {
      // React 没注入成功时连元素都造不出来，留个明确的错误比静默白屏好查。
      throw new Error(
        `dsh-qq-agent-v2: require('react') 没有返回可用的 React（实际类型 ${typeof reactModule}）`
      )
    }

    // 与宿主插件共用的命名空间（index.js 里 settings.register 的同一个字符串）
    const NS = 'dsh-qq-chat-agent'

    /**
     * 需要注入的客户端服务。
     *
     * 这里是 cordis 的硬约束：**没在此声明的服务，一访问就抛**
     * `cannot get property "xxx" without inject`。而且这个错发生在
     * inject 阶段（早于渲染），连错误边界都接不住 —— 表现就是分区一片空白。
     * 所以用到哪个服务就必须在这里列出。
     *
     *   slots          —— 往设置面板挂分区
     *   configForms    —— 取本命名空间的表单：读值 + 带版本号写入。
     *                     DSH 0.1.2 里这个服务叫 `settingsScope`，用
     *                     `bind({ namespace })` 取 scope；0.2.0 改名 configForms、
     *                     改用 `get(namespace)` 取表单。取回来的对象接口一致
     *                     （getSnapshot / subscribe / set / unset），所以下面
     *                     的消费代码不用动，只有这一处取用的写法不同。
     *   settingsSchema —— 把序列化 schema 还原成节点，用于自动生成表单
     */
    const inject = ['slots', 'configForms', 'settingsSchema']

    // ────────────────────────── schema 遍历 ──────────────────────────

    /**
     * 从 schemastery 节点读出字段清单。
     *
     * schemastery 的 Schema 实例把类型信息放在 `type` 上（'object' / 'string' /
     * 'number' / 'boolean' / 'array' / 'dict' / 'union' / 'const'），
     * 子节点在 `dict` 里，元信息在 `meta` 里（description / default / role 等）。
     * 不同小版本字段略有差异，所以每处都做兜底，拿不到就按字符串处理。
     */
    function readFields(node) {
      if (!node) return []
      const inner = node.type === 'object' && node.dict ? node.dict : node.dict ?? {}
      const fields = []
      for (const [name, sub] of Object.entries(inner)) {
        fields.push({ name, node: sub, kind: nodeKindOf(sub), meta: sub?.meta ?? {} })
      }
      return fields
    }

    /** 判断一个 schema 节点的控件类型。 */
    function nodeKindOf(node) {
      const type = node?.type
      if (type === 'boolean') return 'boolean'
      if (type === 'number') return 'number'
      if (type === 'array') return 'list'
      if (type === 'dict') return 'map'
      if (type === 'union') return 'enum'
      if (type === 'const') return 'const'
      return 'string'
    }

    /** 取 union 节点的候选值（schemastery 放在 list 里，形如 [{type:'const',value}]）。 */
    function enumOptions(node) {
      const list = node?.list ?? []
      return list
        .map((item) => (item && 'value' in item ? item.value : undefined))
        .filter((v) => v !== undefined)
    }

    /** 默认值。schemastery 把 default 落在 meta.default。 */
    function defaultOf(node) {
      return node?.meta?.default
    }

    /** 描述文案（schema 里的 .description()）。 */
    function descriptionOf(node) {
      return node?.meta?.description ?? ''
    }

    // ────────────────────────── 样式 ──────────────────────────
    //
    // 全部内联。客户端插件不做 CSS 模块打包，内联样式也不依赖宿主类名，
    // 宿主主题切换时不会串味。
    const S = {
      wrap: { padding: '4px 2px 24px', display: 'flex', flexDirection: 'column', gap: '18px' },
      groupTitle: {
        fontSize: '12px',
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        opacity: 0.55,
        margin: '4px 0 2px',
      },
      groupBox: {
        border: '1px solid var(--dsh-border, rgba(128,128,128,0.22))',
        borderRadius: '10px',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      },
      row: { display: 'flex', flexDirection: 'column', gap: '5px' },
      label: { fontSize: '13px', fontWeight: 500 },
      hint: { fontSize: '12px', lineHeight: 1.5, opacity: 0.6 },
      // 活说明：比 hint 更醒目，因为它是"当前值意味着什么"
      note: {
        fontSize: '12px',
        lineHeight: 1.6,
        padding: '6px 9px',
        borderRadius: '6px',
        background: 'rgba(128,128,128,0.10)',
        borderLeft: '3px solid var(--dsh-accent, #4a7dff)',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 9px',
        fontSize: '13px',
        borderRadius: '7px',
        border: '1px solid var(--dsh-border, rgba(128,128,128,0.3))',
        background: 'var(--dsh-input-bg, rgba(128,128,128,0.08))',
        color: 'inherit',
        outline: 'none',
        fontFamily: 'inherit',
      },
      textarea: { minHeight: '72px', resize: 'vertical', lineHeight: 1.5 },
      inline: { display: 'flex', alignItems: 'center', gap: '8px' },
      switch: { width: 'auto', margin: 0 },
      listRow: { display: 'flex', gap: '6px', alignItems: 'center' },
      btn: {
        padding: '5px 10px',
        fontSize: '12px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, rgba(128,128,128,0.3))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontFamily: 'inherit',
        flexShrink: 0,
      },
      btnPrimary: {
        padding: '7px 16px',
        fontSize: '13px',
        fontWeight: 500,
        borderRadius: '7px',
        border: 'none',
        background: 'var(--dsh-accent, #4a7dff)',
        color: '#fff',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      footer: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        position: 'sticky',
        bottom: 0,
        padding: '10px 0',
        background: 'var(--dsh-bg, transparent)',
      },
      badge: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '4px',
        background: 'rgba(128,128,128,0.18)',
        opacity: 0.75,
      },
      err: { fontSize: '12px', color: '#e5484d' },
      ok: { fontSize: '12px', color: '#30a46c' },
      empty: { fontSize: '13px', opacity: 0.6, padding: '20px 0' },
    }

    // ────────────────────────── 值编解码 ──────────────────────────

    /** 把内存值转成输入框里的文本。 */
    function toText(kind, value) {
      if (value === undefined || value === null) return ''
      if (kind === 'list') return Array.isArray(value) ? value.join('\n') : String(value)
      if (kind === 'map') return JSON.stringify(value, null, 2)
      return String(value)
    }

    /**
     * 把输入框文本解析回内存值。
     * 返回 { ok, value }，ok=false 时保留原文并标红，不阻断其它字段。
     */
    function fromText(kind, text) {
      const trimmed = text.trim()
      if (kind === 'number') {
        if (trimmed === '') return { ok: true, value: undefined }
        const n = Number(trimmed)
        return Number.isFinite(n) ? { ok: true, value: n } : { ok: false }
      }
      if (kind === 'boolean') return { ok: true, value: trimmed === 'true' }
      if (kind === 'list') {
        const items = text
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean)
        // 数字数组按数字存，否则 schema 校验不过
        const nums = items.map(Number)
        const allNum = items.length > 0 && nums.every((n) => String(n) === String(items[nums.indexOf(n)]) && Number.isFinite(n))
        return { ok: true, value: items.length === 0 ? [] : allNum ? nums : items }
      }
      if (kind === 'map') {
        if (trimmed === '') return { ok: true, value: {} }
        try {
          const parsed = JSON.parse(text)
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? { ok: true, value: parsed }
            : { ok: false }
        } catch {
          return { ok: false }
        }
      }
      return { ok: true, value: text }
    }

    // ────────────────────────── 分组 ──────────────────────────
    //
    // 字段按语义分组折叠。分不清归属的一律进「高级」，不会漏字段。
    const GROUPS = [
      {
        title: '连接',
        fields: ['host', 'port', 'accessToken', 'botQq'],
      },
      {
        title: '白名单（留空 = 全部拒绝）',
        fields: ['allowGroups', 'allowUsers', 'blocklist'],
      },
      {
        title: '触发与节奏',
        fields: [
          'contextSliderPos',
          'replyOnlyWhenMentioned',
          'keywords',
          'wakeDelayMs',
          'drainDelayMs',
        ],
      },
      {
        title: '会话与模型',
        fields: [
          'cwd',
          'agentPreset',
          'provider',
          'model',
          'runTimeoutMs',
          'runRetryDelayMs',
          'healthLogEveryRuns',
          'sessionIdleTtlMs',
        ],
      },
      {
        title: '上下文（按轮保留，超了压成摘要）',
        fields: [
          'contextMessages',
          'contextMaxChars',
          'contextRoundGapMin',
          'contextSummaryEnabled',
          'contextSummaryModel',
          'contextSummaryProvider',
          'contextSummaryMaxChars',
          'contextSummaryMaxTokens',
          'contextSummaryMessages',
          'contextSummaryTimeoutMs',
        ],
      },
      {
        title: '上下文里的历史图片',
        fields: [
          'contextImageDescEnabled',
          'contextImageDescMax',
          'contextImageDescMaxChars',
          'contextImageDescProvider',
          'contextImageDescModel',
          'contextImageDescMaxTokens',
        ],
      },
      {
        title: '发送保护',
        fields: [
          'maxMessageLength',
          'minGapMs',
          'maxGapMs',
          'byLengthMs',
          'forwardEnabled',
          'forwardMinChunks',
          'outboundGuardEnabled',
          'outboundBlockWords',
          'outboundReasoningGuard',
          'leakRetryDelayMs',
          'maxPerMinute',
          'maxPerHour',
        ],
      },
      {
        title: '话题跟进 / 主动接话（挑相关的话接，不是每条都回）',
        fields: [
          'judgeEnabled',
          'judgeFollowUpMin',
          'judgeAlwaysOn',
          'judgeProactiveGapMs',
          'judgeProactivePerHour',
          'judgeModel',
          'judgeProvider',
          'judgeContextMessages',
          'judgeMinIntervalMs',
          'judgeMaxInFlight',
          'judgeMaxTokens',
          'judgeTimeoutMs',
          'judgeFailOpen',
          'judgePromptExtra',
        ],
      },
      {
        title: '提醒 / 通知（@ 或关键词 → 模型判定 → 到点在群里说一声）',
        fields: [
          'reminderEnabled',
          'reminderIntentJudge',
          'reminderKeywords',
          'reminderRequireMention',
          'reminderConfirm',
          'reminderConfirmText',
          'reminderAtCreator',
          'reminderLlmParse',
          'reminderModel',
          'reminderProvider',
          'reminderCatchUpMin',
          'reminderMaxPerChat',
        ],
      },
      {
        title: '人设',
        fields: ['botName', 'personaId', 'personaText', 'participation', 'rulesExtra'],
      },
      {
        title: '能力开关',
        fields: ['searchEnabled', 'imageEnabled', 'longImageMaxParts', 'mentionEnabled', 'mentionMax'],
      },
      {
        title: '引用 / 转发与视频（让「看不见的消息」变得看得见）',
        fields: [
          'replyExpandEnabled',
          'replyMaxChars',
          'replyMaxImages',
          'forwardExpandEnabled',
          'forwardMaxDepth',
          'forwardMaxNodes',
          'forwardMaxChars',
          'videoEnabled',
          'videoFrameCount',
          'videoMaxBytes',
          'videoTimeoutMs',
        ],
      },
      {
        title: '工具面（按发言人身份分层）',
        fields: [
          'toolPolicyEnabled',
          'agentUsers',
          'chatTools',
          'allowedGlobalTools',
          'allowedGlobalToolPrefixes',
        ],
      },
      {
        title: '诊断',
        fields: ['logEvents'],
      },
    ]

    /** 把字段按 GROUPS 归位；未列出的进「其他」。 */
    function groupFields(fields) {
      const seen = new Set()
      const out = []
      for (const group of GROUPS) {
        const hit = group.fields.map((n) => fields.find((f) => f.name === n)).filter(Boolean)
        for (const f of hit) seen.add(f.name)
        if (hit.length) out.push({ title: group.title, fields: hit })
      }
      const rest = fields.filter((f) => !seen.has(f.name))
      if (rest.length) out.push({ title: '其他', fields: rest })
      return out
    }

    /**
     * schema 不可用时的兜底字段表：直接按当前值的类型推断控件。
     *
     * 比只显示一句诊断有用得多 —— 用户至少能看到并修改配置，只是少了
     * 描述文案与默认值提示。等镜像就绪后会自动切回带 schema 的完整表单。
     */
    function inferFields(value) {
      if (!value || typeof value !== 'object') return []
      return Object.entries(value).map(([name, v]) => ({
        name,
        kind:
          typeof v === 'boolean'
            ? 'boolean'
            : typeof v === 'number'
              ? 'number'
              : Array.isArray(v)
                ? 'list'
                : v && typeof v === 'object'
                  ? 'map'
                  : 'string',
        node: undefined,
        meta: {},
      }))
    }

    // ────────────────────────── 活说明 ──────────────────────────

    /** 毫秒转成人话。 */
    function humanMs(ms) {
      const n = Number(ms)
      if (!Number.isFinite(n) || n < 0) return ''
      if (n < 1000) return `${n} 毫秒`
      if (n < 60_000) return `${Number((n / 1000).toFixed(1))} 秒`
      if (n < 3_600_000) return `${Number((n / 60_000).toFixed(1))} 分钟`
      return `${Number((n / 3_600_000).toFixed(1))} 小时`
    }

    /**
     * 个别字段的"活说明"：把当前值翻译成人话，随输入实时更新。
     *
     * 门控档位这种字段光看数字没意义 —— 用户真正想知道的是"它到底会不会回我"。
     * 这里的概率公式与 gate.js 的 decide() 保持一致：(pos - 20) / 70。
     *
     * @param value 该字段当前值（含尚未保存的草稿）
     * @param all 同分区全部当前值，用于跨字段联动（档位受"仅在 @ 时响应"影响）
     * @returns {string|null} null 表示不加额外说明
     */
    const FIELD_NOTES = {
      imageEnabled(value, all) {
        const on = value === true
        if (!on) {
          return '关闭：图片一律降级成 [图片] 文字占位，模型看不到图。注意是否回复不受本开关影响。'
        }
        if (all?.replyOnlyWhenMentioned === true) {
          return '注意：「仅在 @ 时响应」已开启，所以只有 @ 机器人的带图消息才会被识别。'
        }
        return '开启：被 @ / 关键词 / 几率命中的带图消息，图片会交给视觉模型识别（主模型需支持视觉）。图片不额外触发回复 —— 走的是和纯文字一样的规则。'
      },

      longImageMaxParts(value) {
        const n = Number(value)
        if (!Number.isFinite(n) || n <= 0) {
          return '关闭：群里发长截图（长边超过 8192 像素）时机器人只会说「我看不到图」。宿主的单边上限是 8192，超了整张图会被拒收。'
        }
        if (n === 1) {
          return '不切段，只把整张长图缩到能过审 —— 图能进去，但字会糊，模型只能看个大概。'
        }
        return `长边超过 8192 的截图会沿长边切成最多 ${n} 段发给模型，宽度保持原样所以文字清晰。代价是这一轮会多花几张图的 token（每段约 1.5k）。切成几段就多几段，不会超过 ${n}。`
      },

      contextImageDescEnabled(value) {
        if (value !== true) {
          return '关闭：历史里的图片只剩 [图片] 占位，模型不知道画的是什么。本次要回应的那批图不受影响，照常识别。'
        }
        return '开启：上下文里的历史图片用视觉模型补一句描述。图片必须先取到字节才有描述 —— 地址已过期的老图仍是占位符。'
      },

      replyExpandEnabled(value, all) {
        if (value !== true) {
          return '关闭：引用只留一句「[引用]」占位，模型不知道人家引的是哪句话 —— 群里「引用一条消息再问」这种问法它会答不到点上。'
        }
        const chars = Number(all?.replyMaxChars) || 1200
        const images = Number(all?.replyMaxImages ?? 2)
        return `开启：引用会被换成「被引用的那句话」再交给模型，最多带 ${chars} 字、${images} 张图。优先查插件自己的消息存档（几乎零开销），查不到才向 NapCat 请求 —— 机器人自己发过的消息就属于后一种。`
      },

      replyMaxChars(value) {
        const n = Number(value)
        if (!Number.isFinite(n)) return null
        return `引用内容最多带 ${n} 字。被引用的若是长转发，超出的截断并注明「已截断」。`
      },

      replyMaxImages(value) {
        const n = Number(value)
        if (!Number.isFinite(n)) return null
        if (n === 0) return '引用里一张图都不带（只留文字）。适合图片很费 token、或引用基本都是闲聊的场景。'
        return `引用里最多带 ${n} 张图。引用是背景信息，别把本轮真正要看的那几张图挤出去。`
      },

      forwardExpandEnabled(value, all) {
        if (value !== true) {
          return '关闭：合并转发只留一句「[聊天记录]」占位，模型完全不知道里面有什么 —— 群里转发一段聊天记录再让机器人总结，它会答不出东西。'
        }
        const depth = Number(all?.forwardMaxDepth) || 3
        const nodes = Number(all?.forwardMaxNodes) || 40
        const chars = Number(all?.forwardMaxChars) || 2000
        return `开启：合并转发会被摊平成实际内容（谁说的 + 说了什么），多层嵌套最多展开 ${depth} 层、${nodes} 条、${chars} 字；转发里的图片照常识别、视频按下方设置抽帧。`
      },

      forwardMaxNodes(value) {
        const n = Number(value)
        if (!Number.isFinite(n)) return null
        return `最多展开 ${n} 条记录。群里的聊天记录动辄几十条，全展开会把上下文挤满；超出部分在结尾注明「另有 N 条未展开」。`
      },

      forwardMaxChars(value) {
        const n = Number(value)
        if (!Number.isFinite(n)) return null
        return `展开后最多 ${n} 字。上下文总上限是另一处设置，这里先给它兜一道 —— 否则一条大转发就能吃掉整轮预算。`
      },

      videoEnabled(value, all) {
        if (value !== true) {
          return '关闭：视频只留「[视频]」占位，模型不知道画面内容。转发里的视频同样看不到。'
        }
        const frames = Number(all?.videoFrameCount) || 2
        return `开启：收到视频时立刻下载并抽出 ${frames} 帧当图片送给模型（模型的输入通道没有视频）。宿主机没装 ffmpeg 时会自动退回占位，不会报错。`
      },

      videoFrameCount(value) {
        const n = Number(value)
        if (!Number.isFinite(n)) return null
        return `每段视频抽 ${n} 帧（约 ${(n * 1.5).toFixed(1)}k token）。抽帧点按时长等分，避开开头黑场与结尾黑屏。`
      },

      videoMaxBytes(value) {
        const n = Number(value)
        if (!Number.isFinite(n)) return null
        return `超过 ${n}MB 的视频不下载、不抽帧 —— 只留「[视频]」占位。群里 4K 视频轻松上百 MB，这道闸必须留着。`
      },

      searchEnabled(value) {
        const on = value === true
        if (!on) {
          return '关闭：机器人只用已有知识回答，不确定就说不确定。'
        }
        return '开启：遇到拿不准的问题（时事 / 版本 / 价格 / 技术报错等）先用联网搜索查证再回答，查不到就直说不知道。'
      },

      mentionEnabled(value, all) {
        if (value !== true) {
          return '关闭：机器人回复里永远不会出现 @，需要点名时只能用文字（对方收不到提醒）。'
        }
        const max = Number(all?.mentionMax) || 2
        const tail = '只能 @ 到最近在该群说过话的人；昵称对不上会退化成普通文字，不会 @ 错人。'
        if (all?.replyOnlyWhenMentioned === true) {
          return `开启：群聊里机器人可以 @ 群友（由它自己判断该不该 @），一条最多 @ ${max} 人。当前「仅在 @ 时响应」是开的 —— 被 @ 后回话时它也可能 @ 回去。${tail}`
        }
        return `开启：群聊里机器人可以 @ 某个群友，提醒对方看它这句话（由它自己判断该不该 @），一条最多 @ ${max} 人。${tail}`
      },

      mentionMax(value, all) {
        if (all?.mentionEnabled !== true) {
          return '当前 @ 功能是关的，这个上限不生效。'
        }
        return `一条回复里最多 @ ${Number(value) || 2} 个人。设小一点更不容易显得刷屏。`
      },

      reminderEnabled(value, all) {
        if (value !== true) {
          return '关闭：不解析提醒请求，带提醒词的话照常交给主模型聊天。'
        }
        const kw = Array.isArray(all?.reminderKeywords) ? all.reminderKeywords.filter(Boolean) : []
        const parts = [
          '开启：被 @ 或消息里出现提醒词时，先让模型判断这句话是不是在让你设提醒，确认后才建；到点由机器人直接发言（那一步不经模型）。',
        ]
        parts.push(kw.length ? `当前提醒词：${kw.join('、')}（只是让模型看一眼，不等于会建）` : '当前没配提醒词，只能靠 @ 触发。')
        parts.push('可说「明天8点提醒我开会」「每天9点打卡」「每周一三五早上7点20开周会」「30分钟后叫我」；「查看提醒」看列表，「取消提醒 2」删掉第 2 条。')
        return parts.join(' ')
      },

      reminderIntentJudge(value) {
        return value === false
          ? '关闭：出现提醒词或被 @ 就直接建提醒。群里聊到"提醒""通知"这类词很容易被误建，不建议关。'
          : '开启：建提醒前先让轻量模型判一次「是不是在让我设提醒」，判不准就当作闲聊，不建也不回执。'
      },

      reminderRequireMention(value) {
        return value === true
          ? '开启：只有 @ 机器人的消息才会进入判定，光说"提醒我"不算。'
          : '关闭：不用 @，消息里带提醒词也会让模型判一次。判定为闲聊就不建，但仍会多花一次判定的 token。想彻底安静就打开。'
      },

      reminderCatchUpMin(value) {
        const n = Number(value)
        if (!Number.isFinite(n)) return null
        if (n === 0) return '0：服务重启跨过触发点的提醒一律不补发，直接作废。'
        return `服务停机跨过触发点时，错过不超过 ${n} 分钟的补发（正文带"（补发）"），超出的记日志跳过 —— NAS 重启是常态，这个窗口就是给它留的。`
      },

      reminderConfirmText(value) {
        const tpl = String(value ?? '').trim()
        if (!tpl) return '留空用默认：「好，{when} 提醒你：{task}」。占位符 {when} 时间、{task} 内容、{repeat} 周期。'
        const preview = tpl
          .split('{when}')
          .join('明天 08:00')
          .split('{task}')
          .join('开会')
          .split('{repeat}')
          .join('一次性')
        return `回执预览：${preview}`
      },

      reminderAtCreator(value, all) {
        return value === true
          ? '开启：群里到点提醒时 @ 当初设置提醒的人，更醒目。人多话密的群可能显得吵。'
          : '关闭：到点只发纯文字提醒，不 @ 任何人。'
      },

      contextSliderPos(value, all) {
        const pos = Number(value)
        if (!Number.isFinite(pos)) return null

        const out = []
        const followMin = Number(all?.judgeFollowUpMin ?? 10)
        const followNote =
          all?.judgeEnabled === true && all?.judgeAlwaysOn === true
            ? '「常开接话」已开启：没触发到它的消息也会先判一次相关性，能接的就接 —— 这个概率现在只管"要不要直接回"。'
            : all?.judgeEnabled === true && followMin > 0
              ? `机器人回完话后的 ${followMin} 分钟内，群里接着聊的相关消息也会接。`
              : ''

        if (all?.replyOnlyWhenMentioned === true) {
          out.push('注意：「仅在 @ 时响应」已开启，群里非 @ 消息一律不回，档位此时只影响私聊与关键词。')
        }

        if (pos <= 10) {
          out.push('群聊：只回应 @ 你（或叫到名字）的消息，其余一律不回。最省 token。')
        } else if (pos <= 20) {
          out.push('群聊：只回应 @ 与关键词命中的消息；其余一律不回。')
        } else if (pos <= 90) {
          const pct = ((pos - 20) / 70) * 100
          out.push(`群聊：@ 与关键词必回；其余消息约 ${pct.toFixed(1)}% 概率被随机回应。`)
        } else {
          out.push('群聊：每条消息都会回应。最费 token。')
          out.push('注意：这一档每条消息都算触发、都会直接回，跟进判定不会被调用 —— 想让它只挑相关的话接，把档位调到 90 以下。')
        }
        out.push('带图消息走同一套规则，没有「带图必回」；命中后图片才会交给视觉模型识别。')
        if (followNote) out.push(followNote)

        const keywords = Array.isArray(all?.keywords) ? all.keywords.filter(Boolean) : []
        if (pos > 10 && pos <= 90) {
          out.push(
            keywords.length
              ? `当前关键词：${keywords.join('、')}（命中必回）`
              : '当前没有配关键词，这一档只有随机概率在放行。'
          )
        }

        out.push('私聊不受档位影响，只要在白名单里就会回复。')
        return out.join(' ')
      },

      wakeDelayMs(value) {
        const h = humanMs(value)
        return h ? `约 ${h}。收到消息先等这么久再处理，期间又来新消息会重置计时 —— 用来把连续发言聚成一批。` : null
      },

      drainDelayMs(value) {
        const h = humanMs(value)
        return h ? `约 ${h}。一轮回复结束后若又攒了新消息，隔这么久再跑一轮。` : null
      },

      runTimeoutMs(value) {
        const h = humanMs(value)
        return h ? `约 ${h}。单次运行最长等待，超时就拿已有内容兜底发送，避免消息石沉大海。` : null
      },

      contextMessages(value) {
        const n = Number(value)
        if (!Number.isFinite(n)) return null
        if (n <= 0) return '不注入聊天记录：机器人只看到当前这条消息，不知道群里正在聊什么。'
        return `每个群各自维护最近 ${n} 条记录，作为「上下文注入」随请求带给模型，各群互不干扰。`
      },

      contextMaxChars(value) {
        const n = Number(value)
        if (!Number.isFinite(n)) return null
        return `上下文文本上限约 ${n} 字。超出时按「轮」保留最近几轮（最新一轮完整保留），更早的压成一段摘要。`
      },

      contextRoundGapMin(value) {
        const n = Number(value)
        if (!Number.isFinite(n)) return null
        return `相邻两条消息空闲超过 ${n} 分钟就算新的一轮。分轮的意义是：截断时永远不会把一轮对话劈成两半。`
      },

      byLengthMs(value) {
        const n = Number(value)
        if (!Number.isFinite(n) || n <= 0) return '不按字数附加等待，只留基础随机间隔。'
        // 与 sender.js 的 #gapFor 保持一致：min + rand + byLengthMs * log2(字数+1)
        const for100 = Math.round(n * Math.log2(101))
        const for1000 = Math.round(n * Math.log2(1001))
        return `按 log₂(字数+1) 缩放：100 字的片多等约 ${for100} 毫秒，1000 字约 ${for1000} 毫秒（线性算法会是十几秒）。`
      },

      forwardMinChunks(value) {
        const n = Number(value)
        if (!Number.isFinite(n)) return null
        return `回复切分超过 ${n} 段时，改成发一条「合并转发」的聊天记录卡片，群里只占一个气泡。服务端不支持时会自动回退成逐条发送。`
      },

      outboundBlockWords(value) {
        const n = Array.isArray(value) ? value.filter(Boolean).length : 0
        return n
          ? `回复里出现这 ${n} 个词就整条不发。提示词泄漏与推理泄漏检测都是内置的，始终生效。`
          : '当前没有屏蔽词。提示词泄漏与推理泄漏检测都是内置的，始终生效。'
      },

      outboundReasoningGuard(value) {
        if (value === false) {
          return '关闭：模型把内心盘算当正文吐出来时会原样发到群里（英文的「我该怎么回」那种）。只在排查问题时关。'
        }
        return '开启：这类回复不发送，并立即重生成一次。某些模型/通道不返回独立的思考通道，偶发把推理写进正文 —— 拦下来比发出去强。'
      },

      leakRetryDelayMs(value) {
        const h = humanMs(value)
        return h ? `检测到推理泄漏后，隔 ${h} 重生成一次。这类问题是输出格式抽风，重生成基本就好，不必等满重试间隔。` : null
      },

      runRetryDelayMs(value) {
        const h = humanMs(value)
        return h ? `一轮跑完却什么都没发出去时，隔 ${h} 重试一次（只重试一次）。重试仍失败会明确记一行「放弃」。` : null
      },

      healthLogEveryRuns(value) {
        const n = Number(value)
        if (!Number.isFinite(n) || n <= 0) return '不打印累计统计。'
        return `每跑完 ${n} 轮在日志里打一行统计（成功/空回复/超时/报错各多少），用来发现机器人是不是在悄悄变哑。`
      },

      sessionIdleTtlMs(value) {
        const h = humanMs(value)
        return h ? `约 ${h}。会话空闲这么久后回收，释放运行时句柄。` : null
      },

      minGapMs(value) {
        const h = humanMs(value)
        return h ? `约 ${h}。相邻两条消息的最小间隔。` : null
      },

      maxGapMs(value) {
        const h = humanMs(value)
        return h ? `约 ${h}。相邻两条消息的最大间隔。` : null
      },

      judgeEnabled(value, all) {
        const on = value === true
        if (!on) {
          return '关闭：只回应三种触发（@ / 关键词 / 几率），回完话后不再跟进话题。'
        }
        if (all?.replyOnlyWhenMentioned === true) {
          return '注意：「仅在 @ 时响应」已开启，非 @ 消息一律不回，跟进判定不会触发。'
        }
        const followMin = Number(all?.judgeFollowUpMin ?? 10)
        if (!(followMin > 0) && all?.judgeAlwaysOn !== true) {
          return '注意：跟进期是 0 分钟、且「常开接话」没开，判定一次都不会被调用。'
        }
        const pos = Number(all?.contextSliderPos ?? 20)
        const sliderNote =
          pos > 90
            ? '注意：档位超过 90 时每条消息都会直接回，没有需要判定的消息。'
            : ''
        const gap = Number(all?.judgeMinIntervalMs ?? 1500)
        const perHour = gap > 0 ? Math.round(3_600_000 / gap) : Infinity
        const rate = Number.isFinite(perHour) ? `每群每小时最多 ${perHour} 次` : '不限次'
        return (
          `开启：@ / 关键词 / 几率命中后直接回复并开启跟进期；跟进期内那些没触发到它的消息，` +
          `先做三项判断 —— 是否与我相关、是否同一话题、是否需要我参与，全过才接话` +
          `（约 600 token/次，主会话一次要 2.6 万）。当前节流 ${rate}。${sliderNote}`
        )
      },

      judgeFollowUpMin(value, all) {
        const n = Number(value)
        if (!Number.isFinite(n)) return null
        const alwaysOn = all?.judgeAlwaysOn === true
        if (!(n > 0)) {
          return alwaysOn
            ? '0：关掉「跟进期」。此时只剩「常开接话」在判定 —— 它不区分这话是不是刚聊过。'
            : '0：关闭跟进，机器人只在被三种触发方式命中的时候说话。'
        }
        if (all?.judgeEnabled !== true) return `${n} 分钟。要先打开「话题跟进」开关才生效。`
        return `回完话后 ${n} 分钟内算「还在聊」：窗口内挑相关的话接，接了就顺延 ${n} 分钟；窗口外交给「常开接话」决定。`
      },

      judgeAlwaysOn(value, all) {
        if (value !== true) {
          return all?.judgeEnabled === true
            ? '关闭：只在机器人刚说完话的跟进期内挑话接。群里聊到它能接的话题时，只要它上一句已经过去很久，它就不会出声。'
            : '关闭：先打开上面的「话题跟进」开关，判定才会运行。'
        }
        if (all?.judgeEnabled !== true) return '已开启，但上方的「话题跟进」总开关还关着，判定不会运行。'
        const limit = Number(all?.judgeProactivePerHour ?? 8)
        const cap = limit > 0 ? `每小时最多 ${limit} 次` : '不限次数'
        return (
          '开启：不再受跟进期限制 —— 群里每条没 @ 到它的消息都先做同一套三项判断，' +
          `只有「与我相关、话题一致、且需要我插一句」的才接（约 600 token/次）。受冷却与限额约束（${cap}）。`
        )
      },

      judgeProactiveGapMs(value) {
        const h = humanMs(value)
        return h ? `约 ${h}。同一个群两次主动接话至少隔这么久，防止一口气连搭好几句话。` : null
      },

      judgeProactivePerHour(value, all) {
        const n = Number(value)
        if (!Number.isFinite(n)) return null
        if (!(n > 0)) return '0：不限次数（只剩冷却间隔拦着），话密的群里容易显得话多。'
        if (all?.judgeAlwaysOn !== true) return `${n} 次。要先打开「常开接话」才用得到这个额度。`
        return `每个群每小时最多主动接话 ${n} 次。判定被拒的不占额度，只有真接了话才扣。`
      },

      judgeFailOpen(value) {
        return value === false
          ? '关闭：判定失败（模型报错/超时）时一律不接话 —— 判定坏了会让机器人跟着一起沉默。'
          : '开启：判定失败（模型报错/超时/取不到模型）时照旧接话。判定只是刹车，坏了不该让机器人整体静默。'
      },

      judgeModel(value, all) {
        const m = String(value ?? '').trim()
        const fallback = String(all?.model ?? '').trim()
        if (m) return `判定用 ${m}。与主模型分开填可以再省一截，前提是它听得懂中文指令。`
        return fallback ? `留空，暂用主会话模型 ${fallback}。填一个更小更便宜的模型能进一步降本。` : '留空，暂用宿主默认模型。'
      },

      judgeContextMessages(value) {
        const n = Number(value)
        if (!Number.isFinite(n) || n <= 0) return null
        return `判定时带最近 ${n} 条记录。太少判不准（单看一句「哈哈」没法决定），太多白烧钱。`
      },

      judgeMinIntervalMs(value) {
        const n = Number(value)
        if (!Number.isFinite(n)) return null
        if (n <= 0) return '不节流：每条非 @ 消息都会判定一次。活跃群请务必给个间隔。'
        const perHour = Math.round(3_600_000 / n)
        return `约 ${humanMs(value)}。同一群两次判定的最小间隔，${perHour} 次/小时上限。这是控制判定成本最有效的旋钮。`
      },

      judgeMaxInFlight(value) {
        const n = Number(value)
        return Number.isFinite(n) ? `最多同时 ${n} 个判定在跑，超出的直接跳过（不回）。` : null
      },

      judgeTimeoutMs(value) {
        const h = humanMs(value)
        return h ? `约 ${h}。超时按「不回」处理，不会阻塞后续消息。` : null
      },

      toolPolicyEnabled(value, all) {
        if (value !== true) {
          return '关闭：所有会话都带宿主的全量工具（实测 170 个 ≈ 3.8 万 token / 轮），谁说话都一样。'
        }
        const admins = Array.isArray(all?.agentUsers) ? all.agentUsers.length : 0
        if (!admins) {
          return '已开启，但「管理员 QQ」还是空的 —— 等于所有人都走精简工具面，谁也没法派活。把你自己填进去。'
        }
        const n = Array.isArray(all?.chatTools) ? all.chatTools.length : 0
        return `开启：名单里那 ${admins} 个人说话时带全量工具（可以派活），其他人只带 ${n} 个聊天用的工具。实测能把每轮的固定开销砍掉九成以上。`
      },

      agentUsers(value) {
        const list = Array.isArray(value) ? value : []
        if (!list.length) {
          return '空着的话没人能用工具干活 —— 包括你自己。填你的 QQ 号：在群里发一条消息，看日志里 from= 后面那串数字。'
        }
        return `这 ${list.length} 个人的消息会让机器人带上完整工具面，他们可以派活（跑命令、读写文件、查资料、操作网页）。只认 QQ 号：昵称和自称都不作数，所以冒充不了。`
      },

      chatTools(value) {
        const list = Array.isArray(value) ? value : []
        if (!list.length) {
          return '空着等于不限制，群聊会退回全量工具 —— 这个功能就白开了。'
        }
        return `群聊里放行的 ${list.length} 个工具：${list.join('、')}。名字必须和宿主的工具名完全一致，写错会在日志里告警并跳过，不会打断会话，但那个工具就调不到了。`
      },
    }

    // ────────────────────────── 组件 ──────────────────────────

    const h = React.createElement

    /**
     * 把渲染期的异常收成可见文本。
     *
     * 分区在设置面板里是"一片独立区域"，一旦抛错，外层不会显示任何东西 ——
     * 用户看到的就是空白，而真正的原因只留在浏览器控制台里。装个边界后
     * 至少能看见错误本身，排障不用再去猜。
     */
    class SectionBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        // 控制台留一份，方便用户贴日志
        console.error('[dsh-qq-agent-v2] 设置分区渲染失败', error)
      }

      render() {
        const { error } = this.state
        if (!error) return this.props.children
        return h(
          'div',
          { style: { padding: '16px', fontSize: '13px', lineHeight: 1.7 } },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '设置分区渲染失败'),
          h('pre', {
            style: {
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              fontSize: '12px',
              opacity: 0.85,
              margin: 0,
            },
          }, String(error?.stack ?? error?.message ?? error).slice(0, 1200))
        )
      }
    }

    /** 依赖没到位时的可见提示（不是白屏）。 */
    function Diag({ title, lines }) {
      return h(
        'div',
        { style: { padding: '16px', fontSize: '13px', lineHeight: 1.7 } },
        h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, title),
        h(
          'ul',
          { style: { margin: 0, paddingLeft: '18px', fontSize: '12px', opacity: 0.85 } },
          (lines ?? []).map((l, i) => h('li', { key: i }, l))
        )
      )
    }

    /**
     * 单个字段的控件。
     * 受控输入：编辑状态留在本组件，只在点保存时向上汇报。
     */
    function Field({ field, value, overridden, onDraft, allValues }) {
      const { name, kind, node } = field
      const desc = descriptionOf(node)
      const def = defaultOf(node)
      const [text, setText] = React.useState(() => toText(kind, value))
      const [bad, setBad] = React.useState(false)

      // 外部值变化（保存后回读、别人改了）时同步。用户正在输入时不动，
      // 避免把光标打断 —— 只在"非聚焦"状态下接受外部值。
      const focused = React.useRef(false)
      React.useEffect(() => {
        if (focused.current) return
        setText(toText(kind, value))
        setBad(false)
      }, [value, kind])

      const commit = (raw) => {
        setText(raw)
        const parsed = fromText(kind, raw)
        setBad(!parsed.ok)
        onDraft(name, parsed.ok ? parsed.value : undefined, parsed.ok)
      }

      let control
      if (kind === 'boolean') {
        control = h('input', {
          type: 'checkbox',
          style: S.switch,
          checked: text === 'true',
          onChange: (e) => commit(String(e.target.checked)),
        })
      } else if (kind === 'enum') {
        const opts = enumOptions(node)
        control = h(
          'select',
          {
            style: S.input,
            value: text,
            onChange: (e) => commit(e.target.value),
          },
          opts.map((o) => h('option', { key: String(o), value: String(o) }, String(o)))
        )
      } else if (kind === 'list' || kind === 'map') {
        // 列表：一行一个 / 逗号分隔；map：JSON 文本
        control = h('textarea', {
          style: { ...S.input, ...S.textarea },
          value: text,
          spellCheck: false,
          onFocus: () => {
            focused.current = true
          },
          onBlur: () => {
            focused.current = false
          },
          onChange: (e) => commit(e.target.value),
        })
      } else if (kind === 'number') {
        control = h('input', {
          type: 'number',
          style: S.input,
          value: text,
          onFocus: () => {
            focused.current = true
          },
          onBlur: () => {
            focused.current = false
          },
          onChange: (e) => commit(e.target.value),
        })
      } else {
        const isLong = node?.meta?.role === 'textarea'
        const isSecret = node?.meta?.role === 'secret'
        control = isLong
          ? h('textarea', {
              style: { ...S.input, ...S.textarea },
              value: text,
              spellCheck: false,
              onFocus: () => {
                focused.current = true
              },
              onBlur: () => {
                focused.current = false
              },
              onChange: (e) => commit(e.target.value),
            })
          : h('input', {
              type: isSecret ? 'password' : 'text',
              style: S.input,
              value: text,
              spellCheck: false,
              placeholder: isSecret ? '（未设置，留空则不校验）' : '',
              onFocus: () => {
                focused.current = true
              },
              onBlur: () => {
                focused.current = false
              },
              onChange: (e) => commit(e.target.value),
            })
      }

      const hintParts = []
      if (desc) hintParts.push(desc)
      if (def !== undefined && def !== '' && !(Array.isArray(def) && def.length === 0)) {
        hintParts.push(`默认 ${Array.isArray(def) || typeof def === 'object' ? JSON.stringify(def) : def}`)
      }

      // 活说明：跟着当前输入实时变，让"这个数字到底啥意思"不用去翻文档
      let note = null
      try {
        note = FIELD_NOTES[name]?.(value, allValues) ?? null
      } catch {
        note = null
      }

      return h(
        'div',
        { style: S.row },
        h(
          'div',
          { style: S.inline },
          h('label', { style: S.label }, name),
          overridden ? h('span', { style: S.badge }, '已覆盖') : null
        ),
        control,
        bad ? h('div', { style: S.err }, '格式不合法，该字段不会被保存') : null,
        note ? h('div', { style: S.note }, note) : null,
        hintParts.length ? h('div', { style: S.hint }, hintParts.join(' · ')) : null
      )
    }

    /** 一个可折叠分组。 */
    function Group({ title, fields, values, user, drafts, onDraft, effective }) {
      const [open, setOpen] = React.useState(true)
      if (!fields.length) return null
      return h(
        'div',
        null,
        h(
          'div',
          {
            style: { ...S.groupTitle, cursor: 'pointer', userSelect: 'none' },
            onClick: () => setOpen(!open),
          },
          `${open ? '▾' : '▸'} ${title}`
        ),
        open
          ? h(
              'div',
              { style: S.groupBox },
              fields.map((f) =>
                h(Field, {
                  key: f.name,
                  field: f,
                  value: drafts[f.name]?.value !== undefined ? drafts[f.name].value : values[f.name],
                  overridden: Boolean(user && Object.prototype.hasOwnProperty.call(user, f.name)),
                  onDraft,
                  allValues: effective,
                })
              )
            )
          : null
      )
    }

    /**
     * 从设置镜像里取本命名空间的序列化 schema。
     *
     * schema 只在 describe 面（镜像）上，scope 的快照里没有。镜像的加载是
     * 异步的：首次渲染很可能还是 idle，所以这个函数必须能在每次渲染 / 每次
     * 订阅回调里重新取值，不能只在注册时取一次 —— 否则镜像 ready 之后表单
     * 仍然是空的，而且永不自愈。
     */
    function readSchemaRaw(binder) {
      try {
        const view = binder?.describe?.()?.getSnapshot?.()?.view
        return view?.namespaces?.find((n) => n.ns === NS)?.schema
      } catch {
        return undefined
      }
    }

    /** 分区主体。依赖由 QQSectionEntry 保证存在后才进入这里。 */
    function QQSettingsSection(props) {
      const { scope, binder, settingsSchema } = props
      const [snap, setSnap] = React.useState(() => scope.getSnapshot())
      const [schemaRaw, setSchemaRaw] = React.useState(() => readSchemaRaw(binder))
      const [drafts, setDrafts] = React.useState({})
      const [status, setStatus] = React.useState(null)

      // 订阅 scope：值一变就重渲染，同时顺手刷新一次 schema（镜像可能刚好 ready）
      React.useEffect(
        () =>
          scope.subscribe(() => {
            setSnap(scope.getSnapshot())
            setSchemaRaw(readSchemaRaw(binder))
          }),
        [scope, binder]
      )

      // 镜像自身的订阅：镜像 ready 不一定会让 scope 快照变化，这里兜住
      React.useEffect(() => {
        const face = binder?.describe?.()
        if (!face?.subscribe) return undefined
        const read = () => setSchemaRaw(readSchemaRaw(binder))
        read()
        return face.subscribe(read)
      }, [binder])

      const value = snap.value ?? {}
      const user = snap.user ?? {}
      const writable = snap.writable !== false

      // schema 来自宿主 describe 回来的序列化信封（最准确，含 .role() 等）。
      // 拿不到就退化成空态提示，而不是让整个设置面板崩掉。
      let fields = []
      let schemaError = null
      if (schemaRaw === undefined) {
        schemaError = 'pending'
      } else {
        try {
          const node = settingsSchema?.rehydrate?.(schemaRaw)
          fields = readFields(node)
        } catch (error) {
          schemaError = String(error?.message ?? error)
        }
      }

      const onDraft = React.useCallback((name, v, ok) => {
        setDrafts((prev) => {
          const next = { ...prev }
          if (!ok) {
            next[name] = { invalid: true }
          } else {
            next[name] = { value: v }
          }
          return next
        })
      }, [])

      const save = async () => {
        setStatus({ kind: 'busy', text: '保存中…' })
        try {
          for (const [name, entry] of Object.entries(drafts)) {
            if (entry.invalid) continue
            await scope.set(name, entry.value)
          }
          setDrafts({})
          // 0.2.0 实测：写入落在 cordis.patch.yml，运行中的 config 对象不会就地更新
          // （面板刷新后仍是旧值），所以别写「热生效」误导人。
          setStatus({ kind: 'ok', text: '已保存到配置，重启 DSH 后生效' })
        } catch (error) {
          setStatus({ kind: 'err', text: `保存失败：${error?.message ?? error}` })
        }
      }

      if (snap.status === 'loading') return h('div', { style: S.empty }, '正在读取配置…')
      if (snap.status === 'unavailable') {
        return h('div', { style: S.empty }, '当前连接下设置不可用（远程页面只读）。请在 DSH 本机打开设置。')
      }
      if (schemaError === 'pending') {
        return h('div', { style: S.empty }, '正在读取配置项定义…')
      }
      if (schemaError) return h('div', { style: S.empty }, `读取 schema 失败：${schemaError}`)

      // schema 拿不到就按当前值推断字段，保证"总能改到配置"
      let inferred = false
      if (!fields.length) {
        fields = inferFields(value)
        inferred = true
      }
      if (!fields.length) {
        return h(Diag, {
          title: '既没有 schema、也读不出任何配置字段',
          lines: [
            `schemaRaw: ${schemaRaw === undefined ? 'undefined' : typeof schemaRaw}`,
            `settingsSchema: ${settingsSchema ? 'ok' : 'undefined'}`,
            `当前值键: ${Object.keys(value).join(', ') || '(空)'}`,
          ],
        })
      }

      const dirty = Object.keys(drafts).length > 0

      // 界面上的"当前有效值"：已保存值 + 未保存的草稿。
      // 活说明要靠它做跨字段联动（例如档位要读"仅在 @ 时响应"）。
      const effective = { ...value }
      for (const [name, entry] of Object.entries(drafts)) {
        if (!entry.invalid && entry.value !== undefined) effective[name] = entry.value
      }

      return h(
        'div',
        { style: S.wrap },
        inferred
          ? h(
              'div',
              { style: S.hint },
              '配置项定义（schema）暂未就绪，以下按当前值推断；稍后会自动显示完整说明。'
            )
          : null,
        groupFields(fields).map((g) =>
          h(Group, {
            key: g.title,
            title: g.title,
            fields: g.fields,
            values: value,
            user,
            drafts,
            onDraft,
            effective,
          })
        ),
        h(
          'div',
          { style: S.footer },
          h(
            'button',
            {
              style: { ...S.btnPrimary, opacity: writable && dirty ? 1 : 0.5 },
              disabled: !writable || !dirty,
              onClick: save,
            },
            '保存'
          ),
          dirty ? h('span', { style: S.badge }, `${Object.keys(drafts).length} 项待保存`) : null,
          status
            ? h(
                'span',
                { style: status.kind === 'err' ? S.err : S.ok },
                status.text
              )
            : null,
          writable ? null : h('span', { style: S.hint }, '当前设置提供方只读')
        )
      )
    }

    /** 只打一次的控制台探针：排障时能一眼看出流程走到哪一步。 */
    const traced = new Set()
    function trace(step, detail) {
      if (traced.has(step)) return
      traced.add(step)
      console.log(`[dsh-qq-agent-v2] ${step}`, detail ?? '')
    }

    /**
     * 分区入口：先确认依赖到位，再进主体；任何异常都收成可见文本。
     * 这样"空白"这种最难查的失败形态被彻底消除。
     */
    function QQSectionEntry(rawProps) {
      trace('组件渲染', `props 键=${Object.keys(rawProps ?? {}).join(',') || '(空)'}`)
      const props = rawProps ?? {}
      const scope = props.scope
      const binder = props.binder

      if (props.bindError) {
        return h(Diag, {
          title: '绑定设置命名空间失败',
          lines: [String(props.bindError?.message ?? props.bindError)],
        })
      }

      if (!scope || typeof scope.getSnapshot !== 'function' || typeof scope.set !== 'function') {
        return h(Diag, {
          title: '分区已挂载，但没拿到可用的 configForms',
          lines: [
            `收到的 props 键: ${Object.keys(props).join(', ') || '(空)'}`,
            `scope: ${scope === undefined ? 'undefined' : typeof scope}`,
            `binder: ${binder === undefined ? 'undefined' : typeof binder}`,
            '通常是客户端 inject 数组里缺少 @deepseek-ai/dsh-client-ui-settings',
          ],
        })
      }

      return h(SectionBoundary, null, h(QQSettingsSection, props))
    }

    // ────────────────────────── 装配 ──────────────────────────

    function apply(ctx) {
      trace('apply 已执行', `有 slots=${Boolean(ctx?.slots)} 有 configForms=${Boolean(ctx?.configForms)}`)
      ctx.slots.inject('settings.section', () => {
        // 取服务可能抛（服务未就绪 / 命名空间非法）。这里兜住，把错误当作
        // 一个普通值传下去显示出来 —— 若让它抛出去，注册会直接失败，
        // 用户连导航条目都看不到，更难定位。
        let scope
        let binder
        let settingsSchema
        let bindError
        // 逐个服务都兜住：cordis 对未声明服务的访问会抛，对已声明但未提供的
        // 也可能抛。任何一个取不到都只让分区降级显示诊断，而不是白屏。
        try {
          // 0.2.0 起 settingsScope 并入 configForms。configForms 同时带
          // describe()（镜像面，用来取序列化 schema），所以 binder 直接用它，
          // 下面的 readSchemaRaw(binder) 一行都不用改。
          binder = ctx.configForms
        } catch (error) {
          bindError = error
        }
        try {
          settingsSchema = ctx.settingsSchema
        } catch (error) {
          if (!bindError) bindError = error
        }
        try {
          scope = binder.get(NS)
        } catch (error) {
          if (!bindError) bindError = error
        }
        trace('scope 绑定', bindError ? `失败: ${bindError?.message}` : '成功')

        const dispose = ctx.slots.register(
          {
            name: 'settings.section',
            id: 'qq-agent',
            order: 30,
            label: () => '群聊助手',
            // binder 要一起传下去：schema 只挂在镜像（describe 面）上，
            // 而镜像 ready 是异步的，组件需要能反复去取。
            inject: () => ({ scope, binder, settingsSchema, bindError }),
          },
          QQSectionEntry
        )
        trace('已注册 settings.section', 'id=qq-agent')
        // 必须把 register 的 disposer 交回去，否则插件卸载时无法注销。
        return dispose
      })
    }

    return { inject, apply }
  },
})
