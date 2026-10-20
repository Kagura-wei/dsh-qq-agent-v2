/**
 * 轻量判定：用不带工具的小模型回答"这条群消息还在跟我聊同一个话题吗"。
 *
 * 它在整条链路里的位置 ——
 *   @ / 关键词 / 几率 命中 → 直接回复（不判定），回复成功后开启「跟进期」
 *   跟进期内收到的、三种触发都没命中的消息 → 送这里判相关性，相关才接话
 *
 * 为什么要单独走这条路 ——
 * 主会话每次调用要付 23.5k token 的固定前缀（agent 系统提示 16,796 字 +
 * 96 个工具 schema + mnemon 快照），实测单次 26,531 token。拿它去判"要不要接话"
 * 是拿牛刀杀鸡：活跃群 422 条/天会把日耗从 1.17M 推到 11.2M。
 *
 * 这里改用 DSH 的 `ctx.llm.stream()` —— 与"生成会话标题"同一条辅助通道，
 * **不装配任何工具、不带 agent 系统提示**，system 由我们自己给（几百字）。
 * 单次约 250 input + 1 output，是主会话的 1/100。
 *
 * 任何异常都不许冒泡到消息处理链路：判定失败 = 不接话，绝不许把群刷屏。
 */
import { renderHistory } from './content.js'
import { auxLlm, resolveAuxRoute, streamText } from './llm.js'

/**
 * 判定用的系统提示。
 *
 * 必须极短 —— 它是每轮都要付的固定成本。人格只给一句（后半段由配置拼），
 * 输出格式卡死成单个字母，省得模型啰嗦。
 */
const BASE_SYSTEM = [
  '你是群聊机器人的接话判断器。',
  '机器人刚在群里说过话，你只判断最新那条消息是否还在延续它参与的话题。',
  '判断对象只是最新那条消息；更早的对话仅作背景，不要因为更早的提问没人回就判 Y。',
  '只输出一个字母：Y 表示该接，N 表示不接。不要解释，不要标点。',
].join('\n')

/**
 * 判定提示的正文模板。
 *
 * `{{` 会被 DSH 的提示词插值当成变量（查不到值会抛错），群消息里贴模板
 * 语法是常事，所以聊天记录必须先打散。判定虽然在 llm.stream 里不装配
 * 系统提示，但打散是零成本的保险。
 */
function buildUserPrompt({ scene, botName, recent, extra, botReplies, windowMin, mode = 'followup' }) {
  const body = renderHistory(recent, scene, 1500)
  const ambient = mode === 'ambient'
  const lines = []
  lines.push(
    ambient
      ? `你是群聊里的「${botName}」。下面是群里最近的对话，最后一行是最新消息。`
      : `你是群聊里的「${botName}」。下面是你刚参与过的对话，最后一行是最新消息。`
  )
  lines.push('')
  lines.push('【最近对话】')
  lines.push(body || '(空)')
  if (botReplies?.length) {
    // 机器人自己的发言不进存档（存档只记收到的消息，改它会污染未读计数），
    // 但判定必须看得见：否则刚回答过的问题在窗口里还是"没人接的提问"，
    // 下一轮会再答一遍。这几行单独维护，按时间排在最后。
    lines.push(`我（${botName}）: ${botReplies.map((r) => r.text).join(' / ')}`)
  }
  lines.push('')
  lines.push('【判断标准】')
  if (ambient) {
    // 常开模式（judgeAlwaysOn）：机器人此前没参与这轮，问的是"值不值得主动插一句"。
    // 正面理由必须收得很紧 —— 只在"有人在问、且没人接"这类明确信号上放行，
    // 否则常开判定会退化成"每条闲扯都搭腔"，那比不接话更糟。
    lines.push('只判断最新一条：值不值得我主动插一句。更早的消息只作背景，不要替它们补答。')
    lines.push('- 有人在问一个具体问题、求助、或拿不定主意在征求看法，且**还没人回应** → Y')
    lines.push('- 最新一条提到了我（叫了名字但没 @）→ Y')
    lines.push('- 话题正好是我能给出实在信息的（技术、游戏、工具、生活常识等），我的回答有增量 → Y')
    lines.push('- 只是闲聊、附和、玩梗、复读、纯语气词（哈哈/确实/6/表情）、或换了个我插不上嘴的新话题 → N')
    lines.push('- 有人已经在回应，或话题已经自然收尾 → N')
    lines.push('- 私人纠纷、情绪宣泄、敏感是非话题 → N')
    lines.push('- 拿不准一律 N')
  } else {
    lines.push(
      `背景：你刚刚接过话，${windowMin} 分钟内群里接着说的话，只要还在同一个话题上就可以继续聊。`
    )
    lines.push('只看最新一条：它是否还在延续这个话题，或正是在对我说的。更早的消息只作背景。')
    lines.push('- 最新一条接着刚才的话题往下说、追问、回应我 → Y')
    lines.push('- 最新一条在问本话题相关的细节，且还没人回应 → Y')
    lines.push('- 最新一条提到了我（叫了名字但没 @）→ Y')
    lines.push('- 最新一条换了新话题、或只是和我无关的闲扯、附和、玩梗、纯语气词（哈哈/确实/6/表情）→ N')
    lines.push('- 别人已经在回应，或这个话题已经自然收尾 → N')
    lines.push('- 拿不准一律 N')
  }
  if (extra) {
    lines.push('')
    lines.push('【额外规则】')
    lines.push(extra)
  }
  lines.push('')
  lines.push('只输出 Y 或 N：')
  return lines.join('\n')
}

/**
 * 把模型输出解析成布尔。
 *
 * 宽容是有意的：小模型偶尔会带句号、换行、甚至半句解释。只要开头能认出
 * 肯定信号就放行；**认不出一律当 N** —— 漏回一条不痛，乱回会吵。
 */
export function parseVerdict(text) {
  const s = String(text ?? '').trim()
  if (!s) return { reply: false, verdict: 'empty' }
  const head = s.slice(0, 8)
  if (/^[Yy]|^是|^要|^回|^true|^1/.test(head)) return { reply: true, verdict: 'yes' }
  if (/^[Nn]|^否|^不|^false|^0/.test(head)) return { reply: false, verdict: 'no' }
  // 整段里出现明确的肯定/否定词也能兜住
  if (/\bY\b|YES/i.test(s) && !/\bN\b|NO/i.test(s)) return { reply: true, verdict: 'yes-loose' }
  return { reply: false, verdict: 'unrecognized' }
}

export class Judge {
  /**
   * @param {object} deps
   * @param {object} deps.ctx cordis 上下文，需能取到 llm / agentDefaultModel / agents
   * @param {() => object} deps.getConfig
   * @param {{info:Function,warn:Function,error:Function}} deps.logger
   */
  constructor({ ctx, getConfig, logger }) {
    this.ctx = ctx
    this.getConfig = getConfig
    this.logger = logger

    /** key -> 上次发起判定的时间戳，用于每群节流 */
    this.lastCallAt = new Map()
    /** key -> 机器人最近自己说过的话（[{time, text}]，每个 key 最多 4 条） */
    this.recentBotReplies = new Map()
    /**
     * key -> 跟进期截止时间戳（回复成功那一刻 + 窗口时长）。
     *
     * 只有"机器人真的把话发出去了"才开窗：发失败说明这条回复不存在，
     * 后续消息没有可延续的话题。窗口内再接上话，窗口顺延。
     * 纯内存，重启即失效 —— 重启后本来也没有"正在聊的话题"。
     */
    this.windowUntil = new Map()
    /**
     * 常开模式（judgeAlwaysOn）专用：
     *   lastConsiderAt —— key -> 上次发起"主动接话"判定的时间戳（冷却，防连发）
     *   proactiveLog   —— key -> 已发生的主动接话时间戳数组（滑动一小时限额）
     * 两者都只在"真的判完并排了程"时才写，纯内存，重启即清。
     */
    this.lastConsiderAt = new Map()
    this.proactiveLog = new Map()
    /** 同时在飞的判定数，防止高峰雪崩 */
    this.inFlight = 0
    /** 累计统计，排障与验证成本用 */
    // cacheRead 也要记：判定的请求前缀（那百来字的 system）跨群跨次是共享的，
    // 命中缓存后这部分不计入 input —— 只报 input 会让成本看起来比实际更好看。
    this.stats = {
      calls: 0,
      errors: 0,
      skipped: 0,
      yes: 0,
      no: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    }
  }

  /** 跟进期时长（毫秒）。0 表示关闭跟进（判定永不触发）。 */
  #followUpMs(cfg) {
    const min = Number(cfg?.judgeFollowUpMin ?? 10)
    return Number.isFinite(min) && min > 0 ? min * 60_000 : 0
  }

  /** 常开模式下同一群两次主动接话的最小间隔（毫秒，默认 90 秒）。 */
  #proactiveGapMs(cfg) {
    const ms = Number(cfg?.judgeProactiveGapMs ?? 90_000)
    return Number.isFinite(ms) && ms >= 0 ? ms : 90_000
  }

  /** 常开模式下每群每小时主动接话上限。0 或负数表示不限额。 */
  #proactiveLimit(cfg) {
    const n = Number(cfg?.judgeProactivePerHour ?? 8)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }

  /** 取该群最近一小时内的主动接话时间戳（顺带丢掉过期的）。 */
  #recentProactive(key, now) {
    const list = this.proactiveLog.get(key) ?? []
    const kept = list.filter((t) => now - t < 3_600_000)
    if (kept.length !== list.length) this.proactiveLog.set(key, kept)
    return kept
  }

  /**
   * 记一次"真的主动接了话"。
   *
   * 只在常开模式、且判定通过并已交给编排层时才调用 —— 判定被拒绝了不算，
   * 否则限额会被一堆"判完不回"的消息吃光，真该接的时候反而没额度了。
   */
  recordProactive({ key, now = Date.now() } = {}) {
    if (!key) return
    const list = this.#recentProactive(key, now)
    list.push(now)
    this.proactiveLog.set(key, list)
  }

  /**
   * 该群现在是否处于跟进期（机器人刚插过话的那段时间）。
   *
   * @param {string} key 会话 key
   * @param {number} [now] 注入时钟，便于测试窗口边界
   */
  isInFollowUp(key, now = Date.now()) {
    const until = this.windowUntil.get(key) ?? 0
    return until > now
  }

  /**
   * 这条消息是否该交给 AI 判定。
   *
   * 判定只管一件事：**跟进期里，那些没被三种触发方式命中的消息要不要接**。
   * 所以四个条件缺一不可 ——
   * - 开关打开（judgeEnabled）
   * - 群聊（私聊本来就该回）
   * - 这条不是触发消息：@ / 关键词 / 几率命中已经直接回复了，不该再花一次钱；
   *   not-allowed / blocked 是白名单与屏蔽名单的真实拒绝，判定无权翻案
   * - 该群处于跟进期：机器人没在跟这轮对话，就没有"话题"可延续
   *
   * 注意这里**不再看档位**：档位决定的是"哪些消息能触发"，而跟进期一旦被
   * @ / 关键词 / 几率打开，窗口内的相关消息就该接 —— 这正是三种触发方式
   * 共用的后续规则。唯一的例外是 replyOnlyWhenMentioned（"非 @ 一概不理"
   * 是更强的明确表态），它优先于跟进。
   */
  shouldConsider({ cfg, msg, mention, decision, key, now = Date.now() }) {
    if (cfg?.judgeEnabled !== true) return false
    if (mention) return false
    if (msg.scene !== 'group') return false
    if (cfg.replyOnlyWhenMentioned === true) return false
    if (decision?.accept === true) return false
    if (decision?.reason !== 'not-mentioned') return false

    // 跟进期：机器人刚插过话，窗口内的相关消息顺理成章接上。
    if (this.isInFollowUp(key, now)) return true

    // 常开模式：窗口外也判，但有"冷却 + 每小时限额"两道闸挡着搭腔过量。
    if (cfg.judgeAlwaysOn !== true) return false
    const gap = this.#proactiveGapMs(cfg)
    if (gap > 0 && now - (this.lastConsiderAt.get(key) ?? 0) < gap) return false
    const limit = this.#proactiveLimit(cfg)
    if (limit > 0 && this.#recentProactive(key, now).length >= limit) return false

    // 在这里占住冷却名额：判定是异步的，不立刻标记的话，同一秒内连着到的
    // 几条消息会一起挤进判定，冷却就形同虚设了。
    this.lastConsiderAt.set(key, now)
    return true
  }

  /**
   * 记一条机器人自己发出去的话，并（重新）开启跟进期。
   *
   * 存档只记收到的消息，机器人的回复不在里面。判定若看不见自己说过什么，
   * 刚答过的问题在窗口里仍是"没人接的提问"，会一轮又一轮地重复作答。
   * 这里只留最近几条，纯内存，重启即清空 —— 够用且不会无限涨。
   *
   * 窗口顺延是有意的：话题还在继续，跟进期就该继续，否则聊到一半
   * 会因为"距上次回复满 10 分钟"而突然不理人。
   */
  recordReply({ key, text, now = Date.now() }) {
    if (!key) return
    const value = String(text ?? '').trim()
    if (!value) return
    const list = this.recentBotReplies.get(key) ?? []
    list.push({ time: now, text: value.slice(0, 200) })
    while (list.length > 4) list.shift()
    this.recentBotReplies.set(key, list)

    const span = this.#followUpMs(this.getConfig())
    if (span > 0) this.windowUntil.set(key, now + span)
  }

  /** 只用于测试与排障：强制关窗 / 直接开窗。 */
  setFollowUpUntil(key, until) {
    if (until > 0) this.windowUntil.set(key, until)
    else this.windowUntil.delete(key)
  }

  /**
   * 只保留跟进期内的消息作为"当前话题"。
   *
   * 窗口外的老对话与此刻的话题无关，塞进去只会让模型把陈年提问当成待接的话。
   * 最新一条永远保留（它就是判定对象，时间戳为 0 的存档条目也不能丢）。
   */
  #topicWindow(recent, windowMs, now) {
    const list = Array.isArray(recent) ? recent : []
    if (windowMs <= 0) return list
    const cutoff = now - windowMs
    const kept = list.filter((m, i) => {
      if (i === list.length - 1) return true
      const t = Number(m?.time ?? 0) * 1000
      return !Number.isFinite(t) || t === 0 || t >= cutoff
    })
    return kept
  }

  /**
   * 判定一条消息。永远不抛异常。
   *
   * @param {object} input
   * @param {string} input.key 会话 key
   * @param {'group'|'private'} input.scene
   * @param {Array} input.recent 最近的消息（含刚到的这条，按时间正序）
   * @param {'followup'|'ambient'} [input.mode] 判定语义：
   *   followup = 跟进期里"这条还在延续我的话题吗"；
   *   ambient  = 常开模式"这条值不值得我主动插一句"。两者标准不同，不可混用。
   * @returns {Promise<{reply:boolean, reason:string, usage?:object, verdict?:string}>}
   */
  async evaluate({ key, scene, recent, mode = 'followup' }) {
    const cfg = this.getConfig()

    if (this.inFlight >= (cfg.judgeMaxInFlight ?? 3)) {
      this.stats.skipped++
      return { reply: false, reason: 'busy' }
    }

    const now = Date.now()
    const minGap = cfg.judgeMinIntervalMs ?? 1500
    const last = this.lastCallAt.get(key) ?? 0
    if (now - last < minGap) {
      this.stats.skipped++
      return { reply: false, reason: 'throttled' }
    }
    this.lastCallAt.set(key, now)

    const route = this.#resolveRoute(cfg)
    if (!route) {
      this.stats.errors++
      this.logger.warn('[判定] 解析不出 provider/model，跳过判定')
      return this.#unavailable(cfg, 'no-route', mode)
    }

    const llm = auxLlm(this.ctx)
    if (!llm) {
      this.stats.errors++
      this.logger.warn('[判定] 宿主没有 ctx.llm.stream()，跳过判定')
      return this.#unavailable(cfg, 'no-llm', mode)
    }

    // "当前话题" = 跟进期内的消息。窗口外的老对话与此刻无关，塞进去只会让
    // 模型把陈年提问当成待接的话；判完再截到配置的条数上限（省钱）。
    // 常开模式没有窗口概念，直接取最近若干条当背景。
    const windowMs = this.#followUpMs(cfg)
    const maxMsgs = cfg.judgeContextMessages ?? 8
    const topic =
      mode === 'ambient'
        ? (recent ?? []).slice(-maxMsgs)
        : this.#topicWindow(recent, windowMs, Date.now()).slice(-maxMsgs)

    const promptText = buildUserPrompt({
      scene,
      botName: cfg.botName || '机器人',
      recent: topic,
      extra: (cfg.judgePromptExtra ?? '').trim(),
      botReplies: this.recentBotReplies.get(key),
      windowMin: Math.round(windowMs / 60_000),
      mode,
    })
    const messages = [
      {
        role: 'user',
        content: [{ type: 'text', text: promptText }],
        source: { kind: 'plugin', plugin: 'dsh-qq-chat-agent' },
      },
    ]

    // 判定器看不见自己的输入就没法调：判定偶发漏回时，只能靠这里还原
    // 模型当时到底看到了哪几行。跟着 logEvents 走，不另开开关。
    if (cfg.logEvents === true) {
      this.logger.info(`[判定提示] ${key} 话题${topic.length}条\n${promptText}`)
    }

    // 超时用自己持有的 AbortController，而不是 AbortSignal.timeout() ——
    // 后者的内部定时器是 unref 的，事件循环一空就根本不会触发，
    // 一个卡死的判定会永远挂着占住并发名额。这里改成可引用的定时器，
    // 并在结束时显式清掉，既不漏触发也不拖住退出。
    const controller = new AbortController()
    const timeoutMs = cfg.judgeTimeoutMs ?? 8000
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    // purpose 用 'session-title' 只是合法的辅助调用分类（与生成会话标题同通道），
    // 并不会关掉 thinking —— 不传 reasoningEffort 时模型走默认推理档位，
    // 角色扮演类消息会先思考，把小 maxTokens 全吃掉导致正文为空。
    // 所以 maxTokens 默认给到 64：思考占 40 也还够吐一个 Y/N。
    const options = {
      provider: route.provider,
      model: route.model,
      messages,
      system: BASE_SYSTEM,
      maxTokens: cfg.judgeMaxTokens ?? 64,
      // 判定是二分类，不该有随机性。不显式给 0 时，实测同一段对话在不同轮次
      // 会给出相反结论（"谁能帮我看看这个报错"一次 Y 一次 N），准确率掉到六成。
      temperature: 0,
      purpose: 'session-title',
      signal: controller.signal,
    }

    this.inFlight++
    let finishReason
    try {
      const { text, usage, finish } = await streamText(llm, options)
      finishReason = finish
      // 有些适配器被 abort 后会安静地结束流而不是抛错，那样会走到"空输出 → 不回"，
      // 日志里看不出是超时。这里显式判一下，让超时在日志里说得清。
      if (controller.signal.aborted) throw new Error(`判定超时（${timeoutMs}ms）`)
      const { reply, verdict } = parseVerdict(text)
      this.stats.calls++
      if (reply) this.stats.yes++
      else this.stats.no++
      if (usage) {
        this.stats.inputTokens += usage.inputTokens ?? 0
        this.stats.outputTokens += usage.outputTokens ?? 0
        this.stats.cacheReadTokens += usage.cacheReadTokens ?? 0
      }
      this.logger.info(
        `[判定] ${key} ${verdict} mode=${mode} model=${route.model} ` +
          `tokens=${(usage?.inputTokens ?? 0)}+${(usage?.outputTokens ?? 0)}` +
          `(缓存读${usage?.cacheReadTokens ?? 0}) ` +
          `out="${text.trim().slice(0, 20)}"` +
          (verdict === 'empty' ? ` fin=${finishReason ?? '?'}` : '')
      )
      return { reply, reason: verdict, usage, verdict }
    } catch (error) {
      this.stats.errors++
      this.logger.warn(`[判定] ${key} 失败(mode=${mode}): ${error?.message ?? error}`)
      return this.#unavailable(cfg, 'error', mode)
    } finally {
      clearTimeout(timer)
      this.inFlight--
    }
  }

  /**
   * 判定"不可用"时的兜底。
   *
   * 判定只是刹车，不是闸门：模型报错、超时、拿不到路由时，不该让机器人
   * 整体静默 —— 那会把"判定坏了"变成"机器人死了"，用户根本分不清。
   * 所以默认放行（judgeFailOpen=false 可改回保守）。
   *
   * 注意区分"不可用"与"没判为相关"：模型答了但答案含糊（unrecognized/empty）
   * 不算故障，仍按不回处理 —— 那是判定本身在工作，只是没给出肯定结论。
   */
  #unavailable(cfg, reason, mode = 'followup') {
    // 常开模式必须 fail-closed：这条路每收到一条群消息都可能被调用，一旦
    // "判定坏了就放行"，机器人会对着群里每条闲扯都插一句 —— 那比静默严重得多。
    // 跟进期模式才沿用 failOpen（默认放行），因为那时它本来就该在跟这个话题。
    if (mode === 'ambient') {
      return { reply: false, reason: `${reason}-failclosed`, failOpen: false }
    }
    const failOpen = cfg?.judgeFailOpen !== false
    return { reply: failOpen, reason: failOpen ? `${reason}-failopen` : reason, failOpen }
  }

  /**
   * 解析判定用的 provider/model。
   *
   * 优先级：判定专用配置 > 主会话的 provider/model > 宿主默认模型。
   * 与摘要器共用同一条解析逻辑（lib/llm.js），避免两处漂移。
   */
  #resolveRoute(cfg) {
    return resolveAuxRoute(this.ctx, cfg, { providerKey: 'judgeProvider', modelKey: 'judgeModel' })
  }
}
