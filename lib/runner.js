/**
 * 编排层：把"已通过门控的消息"变成一次 Agent 运行，并把回复发出去。
 *
 * 会话策略（决策 Q4，假设值，可一句话切换）：
 *   每个会话 key（scene:peerId）复用一个长期 session，空闲后回收。
 *   不采用 QQ-agent 的"每条消息新建"——DSH 的 session 是持久化资源，
 *   每条新建会持续膨胀，且丢失多轮上下文。
 *
 * 关键约束：session 必须成对创建/销毁。本模块是唯一持有 session 句柄的地方，
 * stop() 与空闲回收都会显式 dispose。
 */
import { randomUUID } from 'node:crypto'
import { buildSystemPrompt, buildFollowUpRules, buildAdminRules, buildChatRules, isAgentUser } from './prompt.js'
import { stripMemeTags, limitPicks } from './meme/parse.js'
import { buildMemePrompt } from './meme/prompt.js'
import { buildRichContent } from './content.js'
import { planContext } from './context.js'
import { Summarizer } from './summarize.js'
import { ImageDescriber } from './image-desc.js'
import { checkOutbound } from './safety.js'
import { collectMembers, parseMentions } from './mention.js'

const DEFAULT_IDLE_RECLAIM_MS = 30 * 60 * 1000

/**
 * 单轮最多取多少条未读进 user 消息。
 *
 * 未读本来就是"攒下来待回应的"，不是历史 —— 历史走上下文注入。
 * 这里给个上限纯粹是防止极端情况下（机器人离线很久）一次灌爆输入。
 */
const MAX_PENDING_PER_RUN = 100

/**
 * 系统提示 section 的兜底排序值。
 *
 * DSH 的提示词是 section 排序拼装的，人设栏位叫 DEPLOYMENT_PERSONA。
 * 能拿到它的 order 就排在它后面（人设优先，规则随后），拿不到用这个兜底值。
 */
const FALLBACK_PROMPT_ORDER = 118

/**
 * 上下文注入的排序值。
 *
 * DSH 的运行时上下文是另一套序号表（CONTEXT_ORDERS：沙箱 110 / 审批 115 /
 * 子任务 120）。聊天记录属于"环境信息"，排在策略之前更自然，用 100。
 */
const CONTEXT_INJECT_ORDER = 100

/**
 * 「本次是接话而不是被点名」那段的序号。
 *
 * 排在聊天记录（100）之后、沙箱（110）之前：先说清背景，再交代本次的分寸。
 * 它是**运行时上下文**而不是系统提示 section —— 因为同一场对话里
 * "被 @ 回"和"跟进期接一句"会来回切换，而系统提示改了就得重建会话；
 * 上下文回调每轮重新求值，正好合适。
 */
const TURN_MODE_INJECT_ORDER = 105

/**
 * 「本轮说话的人是管理员」那段的序号。
 *
 * 紧跟在回合分寸（105）之后：先把背景和本次语气交代清楚，最后才给身份授权 ——
 * 授权是这一轮里权限最高的一条，排在越靠后模型越不容易被前面的内容带跑。
 * 同样必须是运行时上下文：同一个群里管理员和群友是交替说话的，
 * 身份写进 section 就把整个会话锁死成一种了。
 */
const ROLE_INJECT_ORDER = 106

/**
 * 跟进期里模型表示"这一轮我不发言"的暗号（见 prompt.js 的 buildFollowUpRules）。
 *
 * 锚定整条回复，避免误伤正常内容 —— 群里正常说话不会只发一个减号。
 */
const SKIP_REPLY_RE = /^(?:-|—|–|\[不发\]|【不发】|（不发）|\(不发\)|不回复|无需回复|skip)$/i

/**
 * 有实际内容吗：字母、数字或 emoji。纯标点/纯空白都算"没说话"。
 *
 * emoji 必须留着 —— 群里回一个表情是合法回应，不能当空回复吞掉。
 */
const HAS_CONTENT_RE = /[\p{L}\p{N}\p{Extended_Pictographic}]/u

/**
 * 整条回复是不是"这一轮没什么要说的"。
 *
 * ⚠️ 为什么不只看 `mode === 'followup'`：那句「没什么好说的就只回一个半角减号」
 * 是 `systemPrompt.context()` 注入的，而它落地成一条 `source=runtime-context`
 * 的 user 消息，**留在会话历史里**。跟进期那一轮过去之后，普通回合模型照样
 * 看得见这条指令、照样会回 `-` —— 实测 22 条只发符号的回复里有 9 条落在
 * 非跟进期。只按模式判断就等于漏掉这 9 条。
 *
 * 所以判定改成与模式无关：只要整条回复没有任何实际内容，一律不发。
 */
function isSilentReply(text) {
  const t = String(text ?? '').replace(/[\s\u200b\u2060\ufeff]+/g, '')
  if (!t) return true
  if (SKIP_REPLY_RE.test(t)) return true
  return !HAS_CONTENT_RE.test(t)
}

/**
 * 硬失败：这一轮**什么都没发出去**，属于"机器人没回话"。
 *
 * 这类情况绝不能把消息标成已读 —— 一标就等于"处理过了"，用户看到的是
 * 机器人装死，日志里也没有任何痕迹（对应 AstrBot 那个 issue #9980：
 * 失败不抛异常 → 任务被记成完成）。这里保留未读并重试一次。
 *
 * 注意 `empty` 不在其中：模型这一轮确实什么都没说（比如只调了工具）是
 * 合法结果，重试只会把同一批消息处理两遍。
 */
const HARD_FAIL_STATES = new Set(['timeout', 'error'])

/**
 * 值得重试一次的终态。
 *
 * 在硬失败之外多一个 `leaked`：模型把推理当正文吐了出来（见 safety.js 的
 * 推理泄漏指纹）。它同样是"什么都没发出去"，但成因在输出格式而不在链路，
 * 重生成一次基本就好了，所以用短延迟重试，别让群里干等。
 */
const RETRYABLE_STATES = new Set([...HARD_FAIL_STATES, 'leaked'])

/**
 * 从 ctx 里取服务并做鸭子类型校验（对齐 DSH 内置插件 dsh-mnemon 的取法）。
 * 拿不到就返回 undefined，由调用方走降级路径，避免把整个会话打死。
 */
function modelService(value) {
  if (!value || typeof value !== 'object') return undefined
  return typeof value.currentSelection === 'function' ? value : undefined
}

function presetService(value) {
  if (!value || typeof value !== 'object') return undefined
  return typeof value.resolve === 'function' && typeof value.mount === 'function' ? value : undefined
}

function trimTo(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 会话日志 id 冲突的判据。DSH 的原话是
 * `session "..." already has a persisted log on disk that does not match this live session (id collision)`
 * 另有一种 `session source headers conflict for session "..."`（cwd/来源变了），同样无解，一并兜。
 */
const LOG_COLLISION_RE = /(persisted log|id collision|source headers conflict)/i

export class Runner {
  constructor({ ctx, getConfig, archive, sender, logger, onReply, getSelfId, prefetch, memes, describeExtra }) {
    this.ctx = ctx
    this.getConfig = getConfig
    this.archive = archive
    this.sender = sender
    this.logger = logger
    /** 回复发出后的回调，用于让判定器记住"我说过什么" */
    this.onReply = typeof onReply === 'function' ? onReply : undefined
    /** 取机器人自己的 QQ 号：解析 @ 时要排除它，避免自己 @ 自己 */
    this.getSelfId = typeof getSelfId === 'function' ? getSelfId : () => 0
    /** 图片预热器：图片在消息到达时就下好了，装配时直接取（见 prefetch.js） */
    this.prefetch = prefetch
    /** 表情包库：提供分类表（进系统提示）与随机取图（出站发图），见 lib/meme/store.js */
    this.memes = memes
    /** 额外的统计行（判定器 / 预热器 / 摘要器的自述），由 index.js 提供 */
    this.describeExtra = typeof describeExtra === 'function' ? describeExtra : undefined

    this.pending = new Map() // key -> { timer, scene, peerId }
    this.sessions = new Map() // key -> { handle, out: string[], lastActive }
    this.running = new Set() // 正在运行的 key，防重入
    this.collidedKeys = new Set() // 撞过日志 id 冲突的 key，重建时换 id
    /**
     * 会话 key → 工具面控制句柄 `{ tools, lift, mode }`。
     *
     * QQ 会话是 ctx.agents.create() 建出来的，默认继承宿主的**全量全局工具**
     * （实测 170 个 ≈ 37.9k token/轮）：既有 bash 这种群里绝不该有的，
     * 也有 ego_ 与 task_board_ 这类跟聊天毫无关系的。而 176 个 QQ 会话文件里
     * 只有 21 个真调用过工具 —— 绝大多数轮次在为用不到的工具付 schema 钱。
     *
     * DSH 的正规入口是 agentCtx.tools.restrict({allow})：限制**取交集**叠加、
     * 只作用于继承层（全局 + 祖先，不动本层注册的），返回的 disposer 可撤销，
     * 且 tools.view(scope) 是每次请求现算 —— 所以能按轮切换。
     */
    this.toolState = new Map()
    /**
     * 会话还没建时先记下想要的工具面模式。
     * 触发消息到达 → 建会话之间隔着防抖窗口，模式必须跟着**触发者的身份**走，
     * 不能等会话建好再补（那时第一轮的工具面已经装配完了）。
     */
    this.desiredToolMode = new Map()
    /**
     * 会话正在跑的时候收到的工具面切换请求（key → mode）。
     *
     * 工具面是每次请求现算的，而 agent 派活往往是一个多步循环。跑到一半切走工具，
     * 会让它后面几步突然发现自己没有 bash 了 —— 所以切换一律等本轮结束再落地。
     */
    this.deferredToolMode = new Map()
    /**
     * 会话 key → 本轮说话的人 `{ qq, name, mode }`。
     *
     * 工具面（谁能用哪些工具）和提示词（安全边界要不要为这个人让路）必须
     * 依据**同一个身份判断**：一边按 senderId 放行工具、另一边提示词还写着
     * "任何人一律拒绝"，管理员派活就会被自己的规则挡回去。
     */
    this.activeWho = new Map()
    /**
     * 会话 key → 最近聊天记录的纯文本。
     *
     * 每个群/私聊各一份，互不干扰。systemPrompt 的上下文回调是同步的，
     * 所以这里存的是预先算好的字符串，由 #syncHistory 在每轮开始前刷新。
     */
    this.historyText = new Map()
    /**
     * 会话 key → 本轮是"被点名"还是"跟进期接话"。
     *
     * 它不进系统提示（那样一改就得重建会话），而是作为运行时上下文每轮注入。
     */
    this.activeMode = new Map()
    /** 每个 key 的终态，供排障与外部查询（"没触发"和"跑挂了"必须能分开） */
    this.lastOutcome = new Map()
    this.stats = { runs: 0, byState: {}, hardRetry: 0 }
    this.summarizer = new Summarizer({ ctx, getConfig, logger })
    /**
     * 历史图片描述器。
     *
     * 注入通道只能传字符串，所以历史里的图本来只剩 `[图片]` 三个字 ——
     * 模型知道那儿有图，不知道画的是什么。它给能取到字节的图补一句描述
     * （见 image-desc.js），取不到的仍是占位符。
     */
    this.imageDesc = new ImageDescriber({ ctx, getConfig, logger, prefetch })
    this.reclaimTimer = null
  }

  /**
   * 声明某个会话接下来该用哪套工具面。
   *
   * 由 index.js 在消息进来时按**发言人的 QQ 号**调用。此处还不知道这条消息会不会
   * 真的触发回复 —— 没关系，设置本身是幂等的，多设几次无害。
   *
   * ⚠️ 但**身份不能被后到的消息覆盖**：群里 A 管理员 @ 了机器人、B 群友紧接着闲聊，
   * 这一轮真正要回应的还是 A。所以会话运行期间只记下"下一轮该用什么"，
   * 不动 activeWho —— 本轮的管理员授权必须留到这一轮结束。
   *
   * @param {string} key 会话 key
   * @param {'chat'|'agent'} mode chat = 精简（群友），agent = 全量（管理员派活）
   * @param {{qq?: number|string, name?: string}} [who] 本轮说话的人，用于提示词授权
   */
  setToolMode(key, mode, who) {
    const wanted = mode === 'agent' ? 'agent' : 'chat'
    // 会话正在跑：agent 可能还在多步循环里。身份和工具面都留给本轮，
    // 只把"下一轮要什么"记下来（下一次装配会话时生效）。
    if (this.running.has(key)) {
      this.deferredToolMode.set(key, wanted)
      return
    }
    this.activeWho.set(key, { qq: who?.qq, name: who?.name, mode: wanted })
    const state = this.toolState.get(key)
    if (!state) {
      this.desiredToolMode.set(key, wanted)
      return
    }
    this.#applyToolMode(state, key, wanted)
  }

  /**
   * 本轮开工前，按「这一轮真正要回应谁」把工具面钉死。
   *
   * 为什么必须在 #run 里再定一次，而不是只靠消息进来时的 setToolMode ——
   * 工具面是**装配期**的能力：`restrict()` 只对随后装配出来的会话生效，
   * 已经活着的会话中途换不掉（模型看到的工具列表在装配时就定了）。
   * 于是只要会话是上一轮"群友工具面"留下的缓存，管理员这条 @ 就会静默
   * 退化成白名单 7 个工具，模型调 bash 只会拿到 `unknown tool`。
   * 这里先把目标模式写进 desiredToolMode，#ensureSession 再按它决定是否重建。
   *
   * 判据：这一批未读里只要有一个管理员，本轮就给全量（他让你干活，
   * 不能因为后面有人闲聊就把工具收走）。
   *
   * @param {string} key 会话 key
   * @param {Array<{senderId?: number|string, senderName?: string}>} unread 本轮待回应的消息
   * @param {object} cfg 插件配置
   */
  #pinTurnMode(key, unread, cfg) {
    if (cfg.toolPolicyEnabled === false) return
    const fromAdmin = [...unread].reverse().find((m) => isAgentUser(cfg, m?.senderId))
    const last = [...unread].reverse().find((m) => m?.senderId !== undefined && m?.senderId !== null)
    const who = fromAdmin ?? last
    const wanted = fromAdmin ? 'agent' : 'chat'
    this.activeWho.set(key, { qq: who?.senderId, name: who?.senderName, mode: wanted })
    this.desiredToolMode.set(key, wanted)
    this.deferredToolMode.delete(key)
    const state = this.toolState.get(key)
    if (state) this.#applyToolMode(state, key, wanted)
  }

  /** 把运行期间攒下的工具面切换落地。在 #run 收尾时调用。 */
  #flushDeferredToolMode(key) {
    const wanted = this.deferredToolMode.get(key)
    if (wanted === undefined) return
    this.deferredToolMode.delete(key)
    const state = this.toolState.get(key)
    if (!state) {
      this.desiredToolMode.set(key, wanted)
      return
    }
    this.#applyToolMode(state, key, wanted)
  }

  /**
   * 装配会话的工具面。必须在 setup(agentCtx) 里调用 ——
   * `tools.restrict()` 要求作用域上下文，在全局 ctx 上会直接抛错。
   */
  #mountToolPolicy(agentCtx, key, wanted = undefined) {
    const tools = agentCtx?.tools
    if (!tools || typeof tools.restrict !== 'function') {
      this.logger.warn(`[工具面] agentCtx 上没有 tools.restrict()，裁剪不生效 ${key}`)
      return
    }
    const state = { tools, ctx: agentCtx, lift: null, mode: null }
    this.toolState.set(key, state)
    // 没有触发者信息时按最保守的 chat 起步：宁可少给工具，也不该让群聊默认吃全量。
    const mode = wanted ?? this.desiredToolMode.get(key) ?? 'chat'
    this.desiredToolMode.delete(key)
    this.#applyToolMode(state, key, mode)
  }

  /**
   * 切换工具面。
   *
   * restrict 的限制是**取交集**叠加的，所以放开必须先撤销上一道限制
   * （调它返回的 disposer），否则只会越勒越紧、再也回不到全量。
   */
  #applyToolMode(state, key, wanted) {
    if (state.mode === wanted) return

    if (state.lift) {
      try {
        state.lift()
      } catch (error) {
        this.logger.warn(`[工具面] 撤销旧限制失败 ${key}: ${error?.message ?? error}`)
      }
      state.lift = null
    }

    if (wanted === 'chat') {
      const allow = this.#chatToolNames(state)
      if (!allow.length) {
        // 白名单为空 = 不设限。这多半是配置被清空了，点出来免得当成"裁剪生效"。
        this.logger.warn(`[工具面] ${key} chat 白名单为空，本轮维持全量工具`)
        state.mode = null
        return
      }
      try {
        state.lift = state.tools.restrict({ allow })
      } catch (error) {
        // 名字不在「已知全局工具」里会在这里抛，错误信息会带上全部合法名。
        this.logger.warn(`[工具面] 裁剪失败，本轮维持全量 ${key}: ${error?.message ?? error}`)
        state.mode = null
        return
      }
      this.logger.info(`[工具面] ${key} → chat（${allow.length} 个工具：${allow.join(', ')}）`)
    } else {
      this.logger.info(`[工具面] ${key} → agent（全量工具）`)
    }

    state.mode = wanted
  }

  /** 群聊模式下放行的全局工具名（去重、去空、展开前缀）。 */
  #chatToolNames(state) {
    const cfg = this.getConfig()
    const list = [...(cfg.chatTools ?? []), ...(cfg.allowedGlobalTools ?? [])]
    const out = []
    for (const raw of list) {
      if (typeof raw !== 'string') continue
      const name = raw.trim()
      if (name && !out.includes(name)) out.push(name)
    }

    // 前缀展开：restrict 只认精确名，`mnemon_` 这类前缀得先摊成实际工具名。
    const prefixes = (Array.isArray(cfg.allowedGlobalToolPrefixes) ? cfg.allowedGlobalToolPrefixes : [])
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => p.trim())
    if (prefixes.length) {
      const known = this.#knownToolNames(state)
      if (!known.length) {
        this.logger.warn('[工具面] 取不到工具名清单，allowedGlobalToolPrefixes 无法展开')
      }
      for (const name of known) {
        if (out.includes(name)) continue
        if (prefixes.some((p) => name.startsWith(p))) out.push(name)
      }
    }
    return out
  }

  /**
   * 取该会话作用域能看见的全部工具名（不受限制影响，用于前缀展开）。
   *
   * view(scope).knownNames 是注册表的原始事实，schemas(scope) 是投影后的可见集，
   * 两个都试一遍 —— 宿主换 API 时不至于把功能整个打死。
   */
  #knownToolNames(state) {
    try {
      const view = state.tools.view?.(state.ctx)
      if (view?.knownNames) return [...view.knownNames]
    } catch {
      /* 换下面的路子 */
    }
    try {
      const list = state.tools.schemas?.(state.ctx)
      if (Array.isArray(list)) return list.map((s) => s?.name).filter(Boolean)
    } catch {
      /* 都给不出来就只能不展开 */
    }
    return []
  }

  /** 会话回收时释放工具面句柄，别把限制留在已经作废的 agent 作用域上。 */
  #releaseToolPolicy(key) {
    const state = this.toolState.get(key)
    if (!state) return
    if (state.lift) {
      try {
        state.lift()
      } catch {
        /* 作用域已经拆了就无所谓了 */
      }
    }
    this.toolState.delete(key)
    this.desiredToolMode.delete(key)
    this.activeWho.delete(key)
  }

  /**
   * 收到一条命中门控的消息。防抖聚批：期间来新消息会重置计时。
   *
   * @param {string} key 会话 key
   * @param {{scene:string, peerId:number, mode?: 'normal'|'followup'}} info
   *   mode='followup' 表示这次是判定器放行的"跟进期接话"，系统提示会额外
   *   交代"没人点名你、可以不说话"（见 prompt.js）。
   */
  schedule(key, info = {}) {
    const cfg = this.getConfig()
    const mode = info.mode === 'followup' ? 'followup' : 'normal'
    this.activeMode.set(key, mode)
    const existing = this.pending.get(key)
    if (existing) clearTimeout(existing.timer)

    const timer = setTimeout(() => {
      this.pending.delete(key)
      this.#run(key, { scene: info.scene, peerId: info.peerId, mode }).catch((error) => {
        this.logger.error(`运行失败 ${key}: ${error?.stack ?? error}`)
      })
    }, cfg.wakeDelayMs ?? 2000)
    timer.unref?.()

    this.pending.set(key, { timer, scene: info.scene, peerId: info.peerId })
    this.#ensureReclaimLoop()
  }

  async #run(key, { scene, peerId, retry = 0, attempt = 0, mode = 'normal' }) {
    if (this.running.has(key)) return // 上一轮还没结束，交给它的排空逻辑
    this.running.add(key)
    this.activeMode.set(key, mode === 'followup' ? 'followup' : 'normal')

    const cfg = this.getConfig()
    const startedAt = Date.now()
    /** 本轮取出的未读 —— 决定要不要 markRead（硬失败时不能消费） */
    let unread = []
    /** 终态。默认 idle：没有未读，本轮什么都没做 */
    let outcome = { state: 'idle', detail: '' }
    let chunks = 0
    let needRetry = false

    try {
      // unread 就是"攒下来待回应的"，全部进 user 消息；更早的历史不在这里带，
      // 由上下文注入提供（见 #syncHistory）。两者分开，模型才不会跑去接历史话题。
      unread = await this.archive.getUnread(key, MAX_PENDING_PER_RUN)
      if (!unread.length) return

      // 工具面和身份都必须在装配会话**之前**定好：谁说的这句话，就按谁来给工具。
      // 只靠消息进来时那次 setToolMode 不够 —— 会话是长期缓存复用的，
      // 上一轮群友留下的白名单会把管理员这一轮也一起锁死。
      this.#pinTurnMode(key, unread, cfg)

      // 刷新本会话的上下文快照 —— 下一步的会话装配会同步读它。
      // 窗口终点是"本次待回应消息之前"，两者严格不重叠（见 #syncHistory）。
      // 超出预算时会在这里做一次轻量摘要，所以它是异步的。
      await this.#syncHistory(key, scene, cfg, unread[0]?.seq)

      // 组装输入。图片/视频要先落盘成 attachment 才能进模型 ——
      // 这一步失败只降级成占位符，不影响整条消息。
      const mediaOff = cfg.imageEnabled === false && cfg.videoEnabled === false
      const { content, images, dropped, sliced, videos } = await buildRichContent(unread, scene, {
        attachments: mediaOff ? undefined : this.ctx.get?.('attachments'),
        prefetch: mediaOff ? undefined : this.prefetch,
        logger: this.logger,
        // 长截图切段：单边超 8192 的图会被宿主整张拒收，切段是唯一能读到内容的办法
        maxParts: cfg.longImageMaxParts,
        videoEnabled: cfg.videoEnabled !== false,
        videoMaxBytes: cfg.videoMaxBytes,
        videoFrameCount: cfg.videoFrameCount,
      })
      if (images || dropped || videos) {
        this.logger.info(
          `[图片] ${key} 带入 ${images} 张${videos ? `（含 ${videos} 段视频抽帧）` : ''}` +
            `${dropped ? `，${dropped} 段未取到` : ''}` +
            `${sliced ? `（${sliced} 张长图已切段）` : ''}`
        )
      }

      const session = await this.#ensureSession(key, cfg, scene)
      session.out.length = 0
      session.lastActive = Date.now()
      session.resetTurn() // 上一轮的残留状态（含超时挂住的 activeTurn）不能带进来

      // 等「这一轮回合结束」而不是等 whenIdle：
      // followup 只是入队并唤醒 driver，不保证同步起转；而 whenIdle 在
      // 尚无活动时会立刻 resolve（实现是 do await activityDone while 变化）。
      // 所以先登记一个 turn/end 等待者，再投喂，超时由 runTimeoutMs 兜底。
      const turnDone = new Promise((resolve) => session.turnWaiters.push(resolve))
      session.expectTurn = true

      session.handle.agent.followup({
        id: randomUUID(),
        role: 'user',
        content,
        source: { kind: 'user' },
      })

      await withTimeout(turnDone, cfg.runTimeoutMs ?? 120000)
      session.expectTurn = false

      // 会话日志 id 冲突（典型成因：磁盘上留有同名但不同来源的持久化日志，
      // 例如手工清理过 ~/.dsh/sessions，或 cwd 变过）。
      // 这个错误是 turn/start 之后才由 agent/error 报出来的，create 阶段抓不到，
      // 所以只能在这里兜：丢弃这个坏会话，换 id 重建后重试一次，避免该会话永久卡死。
      if (session.collided && retry === 0) {
        this.logger.warn(`${key} 会话日志 id 冲突，丢弃后重建并重试一次`)
        this.collidedKeys.add(key)
        this.sessions.delete(key)
        try {
          await session.handle.dispose()
        } catch (error) {
          this.logger.warn(`丢弃冲突会话失败 ${key}: ${error?.message ?? error}`)
        }
        outcome = { state: 'retry-collision', detail: '' }
        needRetry = true
      } else {
        const reply = session.out.join('\n').trim()
        session.out.length = 0
        const delivered = await this.#deliver({
          key,
          scene,
          peerId,
          cfg,
          reply,
          mode,
          timedOut: session.turnUnfinished,
          turnStarted: session.turnStarted,
          errored: session.hadError,
        })
        outcome = delivered.outcome
        chunks = delivered.chunks
      }
    } finally {
      this.running.delete(key)
      // 本轮跑完了，把期间攒下的工具面切换落地（见 setToolMode）。
      this.#flushDeferredToolMode(key)
    }

    // ── 消费 / 重试的决策，全部由终态驱动 ──
    // 关键点：**没发出去的消息不能算处理过**。旧实现无论成败都 markRead，
    // 于是"模型报错/超时"和"机器人装死"在用户眼里完全一样，日志里也只剩一行
    // 警告。现在硬失败保留未读并重试一次，重试仍失败才放弃（并明确记一行）。
    //
    // leaked 也是"没发出去"，但成因完全不同：链路是好的，只是模型这一次把
    // 思考当正文吐了。这种情况重生成一次几乎必然正常，所以用短延迟（默认 2.5s）
    // 而不是 30s —— 让群里干等半分钟比不回还难受。
    if (outcome.state === 'retry-collision') {
      // 紧接着重建重试，不动未读
    } else if (RETRYABLE_STATES.has(outcome.state) && attempt === 0) {
      this.stats.hardRetry++
      const delay =
        outcome.state === 'leaked'
          ? Math.max(800, cfg.leakRetryDelayMs ?? 2500)
          : Math.max(1000, cfg.runRetryDelayMs ?? 30000)
      this.logger.warn(
        `[回合] ${key} outcome=${outcome.state} 本轮没发出任何回复 —— 保留未读，` +
          `${Math.round(delay / 1000)} 秒后重试一次`
      )
      const timer = setTimeout(() => {
        this.#run(key, { scene, peerId, attempt: attempt + 1, mode }).catch((error) => {
          this.logger.error(`重试轮失败 ${key}: ${error?.message ?? error}`)
        })
      }, delay)
      timer.unref?.()
    } else {
      if (unread.length) {
        // 投喂只用最近 MAX_PENDING_PER_RUN 条，但"消账"要把比它更老的未读一起清掉：
        // getUnread 永远从末尾取，比这批更老的条目永远轮不到被带上，留着只会
        // 永久占住未读队列，还把 #syncHistory 的窗口终点（首条未读 seq）拖早，
        // 挤空真正该注入的历史。它们在存档里，标已读后照样并入历史窗口。
        const stale = await this.#staleUnread(key, unread[0].seq)
        if (stale.length) {
          this.logger.info(`[未读] ${key} 顺带消账 ${stale.length} 条更老的未读（永远轮不到投喂）`)
        }
        await this.archive.markRead(key, [...stale, ...unread.map((m) => m.seq)])
        if (RETRYABLE_STATES.has(outcome.state)) {
          const why =
            outcome.state === 'leaked'
              ? '重试后仍然把推理当正文吐出来'
              : '重试后仍未发出回复'
          this.logger.error(`[放弃] ${key} ${why}，本条已标记为已读（不再重试）`)
        }
        // 排空：运行期间又来了新消息，隔 drainDelayMs 再跑一轮。
        // 只有"这批确实被消费掉"时才排空 —— 硬失败时未读还在，排空会变成死循环。
        const rest = await this.archive.getUnread(key, 1)
        if (rest.length) {
          setTimeout(() => {
            this.#run(key, { scene, peerId, mode }).catch((error) => {
              this.logger.error(`排空轮失败 ${key}: ${error?.message ?? error}`)
            })
          }, cfg.drainDelayMs ?? 1200).unref?.()
        }
      }
    }

    this.#recordOutcome(key, outcome, startedAt, chunks)

    if (needRetry) {
      await this.#run(key, { scene, peerId, retry: retry + 1, attempt, mode })
    }
  }

  /**
   * 把这一轮的结果交付出去，并给出终态。
   *
   * 终态是"能对外说话的唯一凭据"：调用方、日志、后续的消费决策都看它。
   * 旧实现没有终态，失败只剩一行 warning，"没触发"和"跑挂了"分不出来。
   *
   * @returns {Promise<{outcome: {state: string, detail: string}, chunks: number}>}
   *   state: ok | empty | timeout | error | skipped | blocked | send-failed
   */
  async #deliver({ key, scene, peerId, cfg, reply, mode, timedOut, turnStarted, errored }) {
    if (!reply) {
      if (errored) {
        this.logger.warn(`[回合异常] ${key} 本轮有 agent/error 且没有产出回复`)
        return { outcome: { state: 'error', detail: 'agent/error' }, chunks: 0 }
      }
      if (timedOut) {
        const detail = turnStarted ? 'turn-not-ended' : 'turn-not-started'
        this.logger.warn(
          `[回合异常] ${key} ${detail}（等满超时），没有产出回复`
        )
        return { outcome: { state: 'timeout', detail }, chunks: 0 }
      }
      this.logger.warn(`[空回复] ${key} —— 未收到 assistant/message`)
      return { outcome: { state: 'empty', detail: '' }, chunks: 0 }
    }

    // 模型"这一轮不发言"的暗号 + 纯符号回复：**任何模式都不发**。
    // 跟进期它会主动返回 "-"（prompt.js 教的）；普通回合则是那段提示词留在
    // 会话历史里被继续照做 —— 详见 isSilentReply() 的注释。
    if (isSilentReply(reply)) {
      this.logger.info(
        `[接话] ${key} 本轮不发言 mode=${mode} 原文=${JSON.stringify(reply.slice(0, 20))}`
      )
      const detail = mode === 'followup' ? 'no-comment' : 'silent'
      return { outcome: { state: 'skipped', detail }, chunks: 0 }
    }

    // 排障时能看到模型到底回了什么（人设是否生效靠它判断）
    if (cfg.logEvents) this.logger.info(`[回复] ${key} ${reply.slice(0, 160)}`)

    // @ 解析：模型写的 [[at:昵称]] 转成真正的 at 段。
    // 查不到人／超出上限就退化成普通文字 —— 宁可少 @，也不 @ 错人。
    const out = this.#resolveMentions(key, scene, cfg, reply)

    // 表情包：摘掉 &&分类键&&。**标记一律剥离**（写错的键、空标记、畸形写法都剥），
    // 只有命中分类表的才真的发图 —— 协议本身绝不能出现在群里。
    const meme = this.#extractMemes(key, cfg, out)

    // 出站检查：提示词泄漏 + 推理泄漏（都是内置、始终生效）+ 管理员屏蔽词。
    // 发了就收不回来，所以宁可这一轮不说话。
    const guard = checkOutbound(out.display, {
      words: cfg.outboundGuardEnabled === false ? [] : cfg.outboundBlockWords,
      reasoningLeakEnabled: cfg.outboundReasoningGuard !== false,
    })
    if (!guard.ok) {
      // 推理泄漏和提示词泄漏要分开处理：前者是模型这一次的输出格式抽风，
      // 重生成一次基本就好了，所以它走"可重试"路径（外层 leaked 分支），
      // 而不是像屏蔽词那样直接判死。
      if (guard.reason === 'reasoning-leak') {
        this.logger.warn(
          `[推理泄漏] ${key} ${guard.detail} —— 模型把内心盘算当正文吐出来了，本条不发送`
        )
        return { outcome: { state: 'leaked', detail: guard.detail }, chunks: 0 }
      }
      this.logger.warn(
        `[出站拦截] ${key} reason=${guard.reason} detail=${guard.detail} —— 本条不发送`
      )
      return { outcome: { state: 'blocked', detail: guard.reason }, chunks: 0 }
    }

    // 纯表情回复：模型只写了标记、没写字。这也是合法的一轮（群里发个表情包
    // 本身就是完整回应），不算 empty —— 旧逻辑会让它掉进 send-failed 再重试。
    const hasText = Boolean(out.text.trim())
    const wantsImages = meme.picks.length > 0

    if (!hasText && !wantsImages) {
      // 正文被标记吃空了（例如只写了一个不存在的分类）→ 没东西可发
      this.logger.warn(`[空回复] ${key} —— 标记解析后没有可发送内容`)
      return { outcome: { state: 'empty', detail: 'tags-only' }, chunks: 0 }
    }

    let chunks = 0
    let forwarded = false
    if (hasText) {
      // sender 从不抛异常，失败只是记在返回值里（被踢出群、限频丢弃都返回
      // sent=0）。所以必须看返回值：只有真的发出去了才能算"我说过这句话"，
      // 否则判定会以为问题答过了而一直不回。
      const result = await this.sender.sendRich(scene, peerId, out.text, out.ats, key)
      if (!(result?.sent > 0)) {
        this.logger.warn(`[发送失败] ${key} sent=0 dropped=${result?.dropped ?? 0} —— 未送达`)
        // 文字没发出去，但可能还有表情 —— 那一张也算"我说过话"，由下面统一判断
        if (!wantsImages) {
          return { outcome: { state: 'send-failed', detail: `dropped=${result?.dropped ?? 0}` }, chunks: 0 }
        }
      } else {
        chunks += result.sent ?? 0
        forwarded = Boolean(result.forwarded)
      }
    }

    let images = 0
    if (wantsImages) {
      images = await this.#sendMemes(key, scene, peerId, cfg, meme.picks)
      chunks += images
      if (!images && !hasText) {
        this.logger.warn(`[发送失败] ${key} 表情图一张都没发出去`)
        return { outcome: { state: 'send-failed', detail: 'meme-failed' }, chunks: 0 }
      }
    }

    // 判定器看的是可读版：@ 占位符已还原成 @昵称，别让它见到内部标记。
    // 纯表情回复没有文字，给个可读的占位，免得判定器以为机器人什么都没说。
    this.onReply?.({ key, text: out.display.trim() || '[表情]' })
    return {
      outcome: {
        state: 'ok',
        detail: [
          forwarded ? 'forwarded' : '',
          images ? `meme:${images}` : '',
          !hasText ? 'image-only' : '',
        ]
          .filter(Boolean)
          .join(' '),
      },
      chunks,
    }
  }

  /**
   * 摘掉回复里的表情标记，并把选中的分类翻译成"要发的图"。
   *
   * 就地改 `out`（text 与 display 都改）—— 两串里的标记是同一份字面量，
   * 分别剥离后仍然一致。返回的是**已截断**的 picks。
   *
   * @returns {{picks: string[], invalid: string[]}}
   */
  #extractMemes(key, cfg, out) {
    if (cfg.memeEnabled === false) return { picks: [], invalid: [] }
    const keys = this.memes ? this.memes.keys() : []

    const display = stripMemeTags(out.display, keys)
    out.display = display.text
    // text 里带 at 占位符（SENTINEL），标记与它互不干扰，同样剥一遍保持一致
    out.text = stripMemeTags(out.text, keys).text

    if (display.invalid.length) {
      this.logger.info(
        `[表情] ${key} 不认识的分类键 ${display.invalid.join('、')}（已从正文剥离，未发图）`
      )
    }
    return { picks: limitPicks(display.picks, cfg.memeMaxPerReply), invalid: display.invalid }
  }

  /**
   * 发表情图。
   *
   * 一次请求里带的图合成**一条**消息（多段），群里只占一个气泡。图走
   * base64:// 内联：NapCat 常常跑在容器里，`file://` 路径它看不见，而
   * 我们也没必要为了发张图去架一个静态文件服务。
   *
   * @returns {Promise<number>} 实际发出的张数
   */
  async #sendMemes(key, scene, peerId, cfg, picks) {
    if (!this.memes || !picks.length) return 0
    const segments = []
    const used = []
    for (const pick of picks) {
      const hit = await this.memes.read(pick, cfg)
      if (!hit) continue
      segments.push({
        type: 'image',
        data: { file: `base64://${hit.buffer.toString('base64')}` },
      })
      used.push(`${hit.pack}/${hit.cat}/${hit.name}`)
    }
    if (!segments.length) return 0

    try {
      const result = await this.sender.sendSegments(scene, peerId, segments, key, {
        timeoutMs: cfg.memeSendTimeoutMs ?? 30000,
      })
      if (result?.sent > 0) {
        this.logger.info(`[表情] ${key} 发出 ${segments.length} 张（${used.join('、')}）`)
        return segments.length
      }
      this.logger.warn(`[表情] ${key} 发送被限频或丢弃（dropped=${result?.dropped ?? 0}）`)
    } catch (error) {
      this.logger.warn(`[表情] ${key} 发送失败: ${error?.message ?? error}`)
    }
    return 0
  }

  /** 记终态并打一行"本轮到底怎么了"。每轮必打，排障时不必再猜。 */
  #recordOutcome(key, outcome, startedAt, chunks) {
    this.stats.runs++
    this.stats.byState[outcome.state] = (this.stats.byState[outcome.state] ?? 0) + 1
    this.lastOutcome.set(key, { state: outcome.state, detail: outcome.detail, time: Date.now() })

    this.logger.info(
      `[回合] ${key} outcome=${outcome.state}${outcome.detail ? `(${outcome.detail})` : ''} ` +
        `chunks=${chunks} wait=${Date.now() - startedAt}ms`
    )

    const every = this.getConfig().healthLogEveryRuns ?? 20
    if (every > 0 && this.stats.runs % every === 0) {
      const counts = Object.entries(this.stats.byState)
        .map(([state, n]) => `${state}=${n}`)
        .join(' ')
      const extra = this.describeExtra?.()
      this.logger.info(
        `[统计] 回合 ${this.stats.runs}（${counts}，硬失败重试 ${this.stats.hardRetry}）` +
          (extra ? `；${extra}` : '')
      )
    }
  }

  /**
   * 生成本轮要注入的表情包段落。
   *
   * 库空 / 功能关闭时返回 ''（一个 token 都不花）。扫描是"目录 mtime 没变就
   * 直接返回"，所以在管理页上传完，下一轮就会带上新分类 —— 而系统提示一变，
   * #ensureSession 会自己重建会话，不需要手工重启。
   */
  async #memePrompt(cfg) {
    if (!this.memes || cfg.memeEnabled === false) return ''
    try {
      await this.memes.rescan()
    } catch (error) {
      this.logger.warn(`扫描表情包库失败: ${error?.message ?? error}`)
    }
    if (this.memes.empty) return ''
    return buildMemePrompt(this.memes.categories(), { maxPerReply: cfg.memeMaxPerReply })
  }

  /** 取（或建）该会话的 agent。setup 里注册监听，才能收到会话作用域的事件。 */
  async #ensureSession(key, cfg, scene) {
    // 系统提示（人设 + 处境 + 安全边界 + 表情包分类表）在会话建立时注册，
    // 改配置/改库必须重建才生效 —— 重建判据就是下面这段文本是否变了。
    const systemText = buildSystemPrompt(cfg, { scene, memes: await this.#memePrompt(cfg) })

    // 本轮要装配成哪种工具面。#pinTurnMode 已按未读的发言人定好，这里取一次
    // 定死：重建判据、setup 里的 restrict、以及会话缓存上记的 mode 必须是同一个值。
    const wantedMode = this.desiredToolMode.get(key) ?? 'chat'

    const cached = this.sessions.get(key)
    if (cached) {
      cached.lastActive = Date.now()
      if (cached.systemText === systemText) {
        // 工具面只对**随后装配**的会话生效（restrict 作用在装配期，活着的会话
        // 中途换不掉）。所以模式变了就得换会话：否则管理员那条 @ 会静默退化成
        // 群友白名单，模型调 bash 只会收到 unknown tool，白转两分钟再发个表情。
        if ((cached.toolMode ?? 'chat') === wantedMode) return cached
        this.logger.info(`${key} 工具面 ${cached.toolMode ?? 'chat'} → ${wantedMode}，重建会话使其生效`)
        this.sessions.delete(key)
        try {
          await cached.handle.dispose()
        } catch (error) {
          this.logger.warn(`工具面切换前回收旧会话失败 ${key}: ${error?.message ?? error}`)
        }
      } else {
        // 人设/规则被改了：丢掉旧会话重建，让改动立刻生效，而不是等空闲回收。
        this.logger.info(`${key} 系统提示已变更，重建会话使其生效`)
        this.sessions.delete(key)
        try {
          await cached.handle.dispose()
        } catch (error) {
          this.logger.warn(`重建前回收旧会话失败 ${key}: ${error?.message ?? error}`)
        }
      }
    }

    // 撞过 id 冲突的 key 必须换 id 重建，否则会再次撞上同一份坏日志。
    const sessionId = this.collidedKeys.has(key) ? `qq-${key}-${Date.now()}` : `qq-${key}`
    const out = []
    const turnWaiters = []
    const state = { expectTurn: false, activeTurn: null, collided: false, hadError: false, started: false }

    // 模型路由必须显式解析出 provider + model。
    // 传空 agentOptions 会让 prompt 装配阶段拿不到 {{model}} 变量，
    // 回合会立刻以 `prompt variable "{{model}}" has no value for this assembly` 失败，
    // 且这种失败不写 session 事件流，只能靠 agent/error 才看得到。
    const agentOptions = this.#resolveModelRoute(cfg)
    if (!agentOptions) {
      throw new Error(
        '未能解析出 provider/model：请确认 DSH 已设置默认模型，或在插件设置里显式填 provider 与 model'
      )
    }

    // Agent preset 决定工具面与 prompt 的 deployment:persona 等 section 装配，
    // 缺失同样会让 prompt 装配失败，所以没有显式配置时取宿主的默认 preset。
    const presets = presetService(this.ctx.get?.('agentPresets'))
    const resolvedPreset = trimTo(cfg.agentPreset) || (await this.#resolvePresetId(presets))

    // 只放非空值：显式写 undefined 会在被 spread/assign 到默认配置时把默认值抹掉。
    const meta = {}
    if (cfg.cwd) meta.cwd = cfg.cwd
    if (resolvedPreset) meta.agentPreset = resolvedPreset

    this.logger.info(
      `会话 ${sessionId} 模型路由 provider=${agentOptions.provider} model=${agentOptions.model} preset=${resolvedPreset || '-'}`
    )

    // setup 在 session 发布前执行，此处注册的监听器属于会话作用域。
    //
    // 事件体形状（dsh-session 的 append 构造）：{ type, seq, time, data }，
    // assistant/message 的 data 才是 { turn, step, message } —— 注意不是 event.message。
    const setup = async (agentCtx) => {
      // mount 必须在注册我们自己的监听前完成，否则 preset 带的 section 装配不上。
      // 失败只降级不中断：没有 preset 时会话仍能跑，只是工具面与默认不同。
      if (presets && resolvedPreset) {
        try {
          await presets.mount(agentCtx, resolvedPreset)
        } catch (error) {
          this.logger.warn(`挂载 preset ${resolvedPreset} 失败: ${error?.message ?? error}`)
        }
      }

      // 工具面必须挂在 preset 之后：restrict 只过滤**继承来的**层（全局 + 祖先），
      // 本层注册的工具它管不着，顺序错了会看着"限制生效了"其实没减掉几个。
      this.#mountToolPolicy(agentCtx, key, wantedMode)

      // 注入人设与规则。这是唯一能改到系统提示的地方 —— 它必须在会话装配前
      // 注册进来，模型才知道自己是谁、在哪说话、边界在哪。
      if (systemText) {
        try {
          const prompt = agentCtx.systemPrompt
          if (prompt && typeof prompt.section === 'function') {
            let order = FALLBACK_PROMPT_ORDER
            try {
              const base = prompt.getSectionOrder?.('DEPLOYMENT_PERSONA')
              if (typeof base === 'number' && Number.isFinite(base)) order = base + 1
            } catch {
              /* 拿不到就用自己的兜底值 */
            }
            prompt.section({ name: 'qq-agent', order, text: systemText })
            this.logger.info(`已注入系统提示 ${key}（${systemText.length} 字，order=${order}）`)
          } else {
            this.logger.warn(`agentCtx 上没有可用的 systemPrompt，人设不会生效`)
          }

          // 上下文注入：把该会话最近的聊天记录交给 DSH 的运行时上下文机制。
          // 它是会话作用域的 —— 每个群注册自己那一份，互不干扰；而且与 user
          // 消息是两个来源，模型不会把"背景"和"要回应的话"混为一谈。
          if (prompt && typeof prompt.context === 'function') {
            prompt.context({
              name: 'qq-chat-history',
              order: CONTEXT_INJECT_ORDER,
              // 同步回调：读 #syncHistory 预先算好的快照。
              // 光把聊天记录丢进去，模型未必知道该拿它做什么 ——
              // 加一句用途说明，它才稳定地把这些当背景而不是待回应的话。
              text: () => {
                const body = this.historyText.get(key) ?? ''
                if (!body) return ''
                return `【本群最近的聊天记录 —— 这是背景，不是要你现在回应的新消息】\n${body}`
              },
            })
            this.logger.info(`已注册上下文注入 ${key}（order=${CONTEXT_INJECT_ORDER}）`)
          } else if (prompt) {
            this.logger.warn('agentCtx.systemPrompt 上没有 context()，聊天记录不会作为上下文注入')
          }

          // 本轮分寸：被点名 / 跟进期接话。同样走运行时上下文，
          // 因为它在同一场对话里来回切换，而系统提示一改就得重建会话。
          // 回调是每轮装配时求值的，读的是 activeMode 的实时值。
          if (prompt && typeof prompt.context === 'function') {
            prompt.context({
              name: 'qq-turn-mode',
              order: TURN_MODE_INJECT_ORDER,
              text: () => {
                if (this.activeMode.get(key) !== 'followup') return ''
                return buildFollowUpRules(this.getConfig())
              },
            })
          }

          // 本轮说话的人是不是管理员。同样每轮求值 —— 同一个群里群友和管理员
          // 是交替说话的，身份一旦写进 section 就会把整个会话锁成一种。
          // 只在 agent 模式（= 工具面已按 QQ 号放行）时才注入，两者同源同判，
          // 不会出现"工具给了但提示词还叫它拒绝"的分裂。
          if (prompt && typeof prompt.context === 'function') {
            prompt.context({
              name: 'qq-role',
              order: ROLE_INJECT_ORDER,
              text: () => {
                const cfg = this.getConfig()
                // 工具面没裁剪（开关关掉）就没什么好交代的：此时 activeWho 根本不写，
                // 若在这里兜底成 chat 规则，反而会告诉一个持有全量工具的模型"你没有 shell"。
                if (cfg.toolPolicyEnabled === false) return ''
                const who = this.activeWho.get(key)
                if (!who || who.mode !== 'agent') return buildChatRules(cfg)
                return buildAdminRules(cfg, who)
              },
            })
          }
        } catch (error) {
          this.logger.error(`注入系统提示失败 ${key}: ${error?.message ?? error}`)
        }
      }

      const logEvents = () => this.getConfig().logEvents === true
      agentCtx.on('session/event', (_session, event) => {
        const type = event?.type
        if (logEvents()) this.logger.info(`[事件] ${type} turn=${event?.data?.turn ?? '-'}`)
        if (type === 'turn/start') {
          // 只认我们投喂后开起的那一轮，避免被维护任务的回合误唤醒
          if (state.expectTurn && state.activeTurn === null) {
            state.activeTurn = event.data?.turn ?? null
            state.started = true
          }
          return
        }
        if (type === 'assistant/message') {
          const text = extractText(event.data?.message?.content)
          if (text) out.push(text)
          return
        }
        if (type === 'turn/end') {
          if (state.activeTurn !== null && event.data?.turn !== state.activeTurn) return
          state.activeTurn = null
          const waiters = turnWaiters.splice(0)
          for (const resolve of waiters) resolve()
        }
      })

      // 模型请求失败不会落到 session 事件里，必须单独听 agent 事件才能看到原因。
      // 注意：payload 常带循环引用，JSON.stringify 会抛错，所以要做字段级兜底。
      const describe = (payload) => {
        const src = payload?.failure ?? payload
        // 先做字段提取，再考虑序列化：payload 常带循环引用（JSON.stringify 会抛），
        // 而且 Error 实例序列化出来是 {}，message 会整个丢掉。
        const err = src?.error ?? src
        const detail = [src?.code, src?.message, err?.name, err?.code, err?.message]
          .filter(Boolean)
          .join(' | ')
        if (detail) return `keys=[${Object.keys(src ?? {}).join(',')}] ${detail}`
        try {
          const json = JSON.stringify(src)
          if (json && json !== '{}') return json
        } catch {
          /* 循环引用，落到下面 */
        }
        return String(src)
      }
      agentCtx.on('agent/error', (payload) => {
        const text = describe(payload)
        this.logger.error(`[agent/error] ${text}`)
        // 记下"这一轮出过错"：终态要靠它把 error 和 empty 分开 ——
        // 模型什么都没说 vs 模型根本没能说话，处理方式完全不同。
        state.hadError = true
        if (LOG_COLLISION_RE.test(text)) state.collided = true
      })
      agentCtx.on('agent/request-error', (payload) => {
        state.hadError = true
        this.logger.error(`[agent/request-error] ${describe(payload)}`)
      })
    }

    const handle = await this.#openSession(sessionId, { meta, agentOptions, setup })

    const entry = {
      handle,
      out,
      turnWaiters,
      // 记住建会话时用的系统提示，变了就重建，让人设改动立刻生效
      systemText,
      get expectTurn() {
        return state.expectTurn
      },
      set expectTurn(v) {
        state.expectTurn = v
      },
      get collided() {
        return state.collided
      },
      /**
       * 这一轮"没跑完"—— 回合从没起来，或起来了但没等到 turn/end。
       *
       * 用来把 timeout 从 empty 里分出来：模型什么都没说（empty）是合法结果，
       * "回合根本没跑"是故障，两者的处理方式完全不同（后者要重试）。
       *
       * 顺带修掉一个隐性死锁：超时后 activeTurn 会一直挂着，下一轮的
       * turn/start 因为 activeTurn !== null 而不被认领，导致这个会话此后
       * **每一轮都等满超时**。resetTurn() 会把它清干净。
       */
      get turnUnfinished() {
        return !state.started || state.activeTurn !== null
      },
      /** 这一轮到底有没有起转（用来区分"回合没起来"和"回合没结束"） */
      get turnStarted() {
        return state.started
      },
      /** 本轮是否出过 agent/error */
      get hadError() {
        return state.hadError
      },
      /** 每轮开始前清干净上一轮的残留状态 */
      resetTurn() {
        state.hadError = false
        state.started = false
        state.activeTurn = null
      },
      lastActive: Date.now(),
      /** 这个会话装配时用的工具面。模式变了必须重建才生效，见 #ensureSession。 */
      toolMode: wantedMode,
    }
    this.sessions.set(key, entry)
    return entry
  }

  /**
   * 把模型回复里的 @ 标记解析成 at 段。
   *
   * 昵称从「该会话最近说过话的人」里查 —— 想让谁收到通知，那个人多半
   * 就在这场对话里，不必去拉整个群成员表（大群几百人，又慢又没必要）。
   * 查不到就退化成普通文字，绝不 @ 错人。
   *
   * 私聊不处理（一对一没有 @ 的意义）；开关关掉时原样返回。
   *
   * @returns {{text: string, display: string, ats: Array}}
   */
  #resolveMentions(key, scene, cfg, reply) {
    const plain = { text: reply, display: reply, ats: [] }
    if (scene !== 'group' || cfg.mentionEnabled === false) return plain

    const botQq = Number(this.getSelfId()) || 0
    const members = collectMembers(this.archive.getRecentCached(key, 80), { botQq })
    if (!members.length) return plain

    const { text, display, ats, unresolved, overflow } = parseMentions(reply, {
      members,
      botQq,
      max: cfg.mentionMax ?? 2,
    })

    if (ats.length) {
      this.logger.info(`[@] ${key} ${ats.map((a) => `${a.name}(${a.qq})`).join('、')}`)
    }
    if (unresolved.length) {
      this.logger.info(`[@未解析] ${key} ${unresolved.join('、')} —— 不在最近说话的人里，按普通文字发出`)
    }
    if (overflow.length) {
      this.logger.info(`[@超出上限] ${key} ${overflow.join('、')} —— 一条最多 @ ${cfg.mentionMax ?? 2} 人`)
    }

    return { text, display, ats }
  }

  /**
   * 找出"比本轮投喂批次更老"的未读，用于消账。
   *
   * 正常路径下这里应该是空的（门控不放行的消息会即时退休，见 index.js 的
   * retireUnread）。它是兜底：机器人停机一整天后再上线、或存档里留着历史
   * 遗留的积压时，未读总数可能远超 MAX_PENDING_PER_RUN，而 getUnread 永远
   * 只取末尾 N 条 —— 更老的那些既进不了投喂窗口，也永远等不到 markRead。
   */
  async #staleUnread(key, firstSeq) {
    try {
      const all = await this.archive.getUnread(key, Number.MAX_SAFE_INTEGER)
      return all.filter((m) => m.seq < firstSeq).map((m) => m.seq)
    } catch (error) {
      this.logger.warn(`读未读队列失败 ${key}: ${error?.message ?? error}`)
      return []
    }
  }

  /**
   * 刷新某会话的上下文快照。
   *
   * systemPrompt 的上下文回调是**同步**的（签名要求直接返回 string），
   * 不能在那里 await 读盘或调模型。所以每轮开始前先把该会话最近的记录
   * 渲染好，回调只管同步取。每个 key 一份快照，各群互不干扰。
   *
   * **窗口终点 = 本次待回应消息之前**（`beforeSeq` 为本次首条未读的 seq）。
   * 不能只排除"本次未读"：一轮结束会把刚回应的消息标为已读，下一轮它们
   * 就落进最近窗口，被当成历史又注入一遍 —— 同一批内容重复烧 token，
   * 还会让模型把刚回应过的话题当成新背景再提一次。
   * 以 seq 划断，上下文与 user 消息在同一根时间轴上严格不重叠。
   *
   * 超预算时不再是"从最旧的开始丢"，而是交给 planContext 按轮规划：
   * 最新一轮完整保留，装不下的旧轮次压成一段摘要（见 context.js / summarize.js）。
   * 摘要不可用就退回有损截断 —— 优化可以失效，功能不能失效。
   *
   * @param {number|undefined} beforeSeq 只取 seq 小于它的记录；未给则不注入
   */
  async #syncHistory(key, scene, cfg, beforeSeq) {
    const limit = cfg.contextMessages ?? 30
    if (limit <= 0 || !Number.isFinite(beforeSeq)) {
      this.historyText.delete(key)
      return
    }
    // 多取一段，按 seq 切掉"本次及之后"的部分，再截到 limit
    const window = this.archive.getRecentCached(key, Math.max(limit * 2, 60))
    const slice = window.filter((m) => m.seq < beforeSeq).slice(-limit)

    // 历史里的图在注入文本里只有 `[图片]` 占位符（注入通道只能传字符串，
    // image 块进不来）。能给能取到字节的图补一句描述，模型才知道那些图在画什么；
    // 取不到的（老消息的签名地址早已过期）保持占位，不会为此多等一次下载。
    const describe = await this.imageDesc.build(slice, { cfg })

    const planned = planContext(slice, {
      scene,
      maxChars: cfg.contextMaxChars ?? 4000,
      gapMs: Math.max(1, cfg.contextRoundGapMin ?? 5) * 60_000,
      summaryBudget: Math.min(1000, Math.max(200, cfg.contextSummaryMaxChars ?? 300)),
      describe,
    })

    let summary = ''
    if (planned.over && planned.oldEntries.length) {
      if (cfg.contextSummaryEnabled === false) {
        this.logger.warn(
          `[上下文] ${key} 超出预算且摘要已关闭，${planned.oldEntries.length} 条更早的记录本轮丢弃`
        )
      } else {
        summary = (await this.summarizer.get({ key, scene, entries: planned.oldEntries })) ?? ''
        if (!summary) {
          this.logger.warn(
            `[上下文] ${key} 摘要不可用，${planned.oldEntries.length} 条更早的记录本轮丢弃`
          )
        }
      }
    }

    const parts = []
    if (summary) {
      // 摘要单独标明用途：它是"来龙去脉"，不是让人主动提起的谈资
      parts.push(`【更早的对话摘要（仅供了解来龙去脉，不要主动提起）】\n${summary}`)
    }
    if (planned.recentText) parts.push(`【最近的聊天记录】\n${planned.recentText}`)
    const text = parts.join('\n\n')

    if (text) this.historyText.set(key, text)
    else this.historyText.delete(key)

    // 排障时能看到模型到底带着什么背景在说话
    if (planned.over) {
      this.logger.info(
        `[上下文] ${key} ${slice.length} 条 → ${planned.recentText.length} 字` +
          `（超预算：旧记录 ${planned.oldEntries.length} 条，摘要 ${summary.length} 字）`
      )
    }
    if (cfg.logEvents) {
      const preview = text.replace(/\n/g, ' ⏎ ').slice(0, 300)
      this.logger.info(`[上下文] ${key} 明细：${preview || '(空)'}`)
    }
  }

  /**
   * 解析本会话要用的 provider/model，优先级：显式配置 > 宿主默认模型 > 任意在跑的 agent。
   *
   * 对齐 DSH 内置插件 dsh-mnemon 的 taskAgentModelRoute：内置插件在自建会话时
   * 也是这么解析的，自己另起炉灶会拿不到 {{model}} 变量。
   */
  #resolveModelRoute(cfg) {
    let selected
    try {
      selected = modelService(this.ctx.get?.('agentDefaultModel'))?.currentSelection()
    } catch (error) {
      this.logger.warn(`读取宿主默认模型失败: ${error?.message ?? error}`)
    }

    const fallback = this.#liveAgentOptions()
    const provider = trimTo(cfg.provider) || trimTo(selected?.provider) || trimTo(fallback?.provider)
    const model = trimTo(cfg.model) || trimTo(selected?.model) || trimTo(fallback?.model)

    if (!provider || !model) return undefined

    const options = { provider, model }
    if (typeof fallback?.maxTokens === 'number') options.maxTokens = fallback.maxTokens
    return options
  }

  /** 取任意一个在跑的根 agent 的 options，作为最后兜底。 */
  #liveAgentOptions() {
    try {
      for (const agent of this.ctx.agents?.roots?.() ?? []) {
        const options = agent?.options
        if (options?.provider && options?.model) return options
      }
    } catch {
      /* roots() 不可用时静默降级 */
    }
    return undefined
  }

  /** 解析宿主默认 preset 的 id；解析不出就 undefined（不阻断）。 */
  async #resolvePresetId(presets) {
    if (!presets) return undefined
    try {
      const resolved = await presets.resolve()
      return trimTo(resolved?.id) || undefined
    } catch (error) {
      this.logger.warn(`解析默认 agent preset 失败: ${error?.message ?? error}`)
      return undefined
    }
  }

  /**
   * 打开一个会话句柄：新建优先，已存在则恢复，恢复也失败就换全新 id。
   *
   * DSH 的 session 是持久化资源：插件重启后同一个 id 再 create 会抛
   * `session "..." already exists`。若不处理，该会话此后每一次触发都会失败，
   * 且失败不写入 sessions 表 → 永久卡死。所以必须 create → resume → 兜底重建。
   */
  async #openSession(sessionId, { meta, agentOptions, setup }) {
    try {
      const handle = await this.ctx.agents.create({ sessionId, meta, agentOptions, setup })
      this.logger.info(`已创建会话 ${sessionId}`)
      return handle
    } catch (error) {
      const msg = String(error?.message ?? error)
      if (!/already exists/i.test(msg)) throw error

      try {
        const handle = await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
        this.logger.info(`已恢复持久化会话 ${sessionId}`)
        return handle
      } catch (resumeError) {
        // 最后兜底：宁可丢掉这段历史，也不能让这个会话永久不可用。
        // 上下文仍有 Archive 的最近消息兜着，连续性损失有限。
        const fresh = `${sessionId}-${Date.now()}`
        this.logger.warn(
          `恢复会话 ${sessionId} 失败（${resumeError?.message ?? resumeError}），改用新会话 ${fresh}`
        )
        const handle = await this.ctx.agents.create({ sessionId: fresh, meta, agentOptions, setup })
        this.logger.info(`已创建会话 ${fresh}`)
        return handle
      }
    }
  }

  #ensureReclaimLoop() {
    if (this.reclaimTimer) return
    this.reclaimTimer = setInterval(() => {
      this.reclaimIdle().catch((error) => {
        this.logger.error(`回收会话失败: ${error?.message ?? error}`)
      })
    }, 60000)
    this.reclaimTimer.unref?.()
  }

  /** 回收空闲过久的 session，防止句柄与内存无限增长。 */
  async reclaimIdle() {
    const ttl = this.getConfig().sessionIdleTtlMs ?? DEFAULT_IDLE_RECLAIM_MS
    const now = Date.now()
    for (const [key, entry] of this.sessions) {
      if (this.running.has(key)) continue
      if (now - entry.lastActive < ttl) continue
      this.sessions.delete(key)
      this.historyText.delete(key) // 快照跟着会话一起回收
      this.activeMode.delete(key)
      this.#releaseToolPolicy(key) // 工具面句柄属于这个会话作用域，一起释放
      this.summarizer.clear(key) // 摘要也过期：会话都没了，别留着占地方
      try {
        await entry.handle.dispose()
        this.logger.info(`已回收空闲会话 ${key}`)
      } catch (error) {
        this.logger.warn(`回收失败 ${key}: ${error?.message ?? error}`)
      }
    }
  }

  async stop() {
    for (const entry of this.pending.values()) clearTimeout(entry.timer)
    this.pending.clear()
    if (this.reclaimTimer) clearInterval(this.reclaimTimer)
    this.reclaimTimer = null

    // 放行所有还在等回合结束的调用，避免停机时干等到超时
    for (const entry of this.sessions.values()) {
      for (const resolve of entry.turnWaiters.splice(0)) resolve()
    }

    for (const [key, entry] of this.sessions) {
      try {
        await entry.handle.dispose()
      } catch (error) {
        this.logger.warn(`停止时回收失败 ${key}: ${error?.message ?? error}`)
      }
    }
    this.sessions.clear()
    this.running.clear()
    this.historyText.clear()
    this.activeMode.clear()
    this.toolState.clear()
    this.desiredToolMode.clear()
    this.deferredToolMode.clear()
    this.activeWho.clear()
    this.summarizer.stop()
    this.imageDesc.stop()
  }
}

export function extractText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise.catch(() => undefined),
    new Promise((resolve) => setTimeout(() => resolve(undefined), ms).unref?.()),
  ])
}
