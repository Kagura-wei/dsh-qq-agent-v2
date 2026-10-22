/**
 * 轻量判定：用不带工具的小模型判断"这条群消息该不该接"。
 *
 * 它在整条链路里的位置 ——
 *   @ / 关键词 / 几率 命中 → 直接回复（不判定），回复成功后开启「跟进期」
 *   跟进期内收到的、三种触发都没命中的消息 → 送这里判定，三项都过才接话
 *
 * **三项判断**（2026-10-21 起，替代原来的单字母 Y/N）：
 *   1 相关：这条消息是否与「我」有关（提到我 / 回应我 / 问的是我参与的事）
 *   2 同题：是否与「叫醒我的那句话」属于同一话题（常开模式参照当前话题）
 *   3 需要：是否需要我参与（有人在等回答、还没人接、我能给实质增量）
 * 三项全 Y 才接，任一 N 都不接 —— 单看"相不相关"会接一堆自己插不上嘴的闲扯。
 *
 * 为什么要单独走这条路 ——
 * 主会话每次调用要付 23.5k token 的固定前缀（agent 系统提示 16,796 字 +
 * 96 个工具 schema + mnemon 快照），实测单次 26,531 token。拿它去判"要不要接话"
 * 是拿牛刀杀鸡：活跃群 422 条/天会把日耗从 1.17M 推到 11.2M。
 *
 * 这里改用 DSH 的 `ctx.llm.stream()` —— 与"生成会话标题"同一条辅助通道，
 * **不装配任何工具、不带 agent 系统提示**，system 由我们自己给（一百多字）。
 * 三项判断带一句理由，单次约 400~700 input + 20~60 output，仍是主会话的 1/40。
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
  '你是群聊机器人的接话判断器。对最新那条消息做三项判断：与我相关、与当前话题同题、需要我参与。',
  '只看最新一条，更早的对话仅作背景，不要因为更早的提问没人回就判 Y。',
  '三项全是 Y 才算该接，任一为 N 就不该接。只按格式输出，不解释推理过程。',
].join('\n')

/**
 * 判定提示的正文模板。
 *
 * `{{` 会被 DSH 的提示词插值当成变量（查不到值会抛错），群消息里贴模板
 * 语法是常事，所以聊天记录必须先打散。判定虽然在 llm.stream 里不装配
 * 系统提示，但打散是零成本的保险。
 *
 * 三项判断的写法有两个要点：
 *   - 每项都给"什么算 Y、什么算 N"的正反例，只说一句"是否相关"模型会一路 Y；
 *   - 第 2 项必须**指名参照物**（叫醒我的那句话），否则它会拿"最近几条"当锚，
 *     话题一换、或者窗口里混进旧话题，就判成"同题"。
 */
function buildUserPrompt({ scene, botName, recent, extra, botReplies, wake, windowMin, mode = 'followup' }) {
  const body = renderHistory(recent, scene, 1500)
  const ambient = mode === 'ambient'
  const lines = []
  lines.push(
    ambient
      ? `你是群聊里的「${botName}」。下面是群里最近的对话，最后一行是最新消息。`
      : `你是群聊里的「${botName}」。下面是你刚参与过的对话，最后一行是最新消息。`
  )
  lines.push('')

  // 话题锚点：这次是被哪句话叫醒的。它是第 2 项判断唯一的参照物，
  // 比"最近几条"可靠得多 —— 最近几条里可能已经混进了别的话题。
  if (!ambient && wake && String(wake.text ?? '').trim()) {
    lines.push('【叫醒我的那句话】')
    lines.push(`${wake.senderName || '某人'}: ${scatter(String(wake.text).slice(0, 200))}`)
    lines.push('')
  }

  lines.push('【最近对话】')
  lines.push(body || '(空)')
  if (botReplies?.length) {
    // 机器人自己的发言不进存档（存档只记收到的消息，改它会污染未读计数），
    // 但判定必须看得见：否则刚回答过的问题在窗口里还是"没人接的提问"，
    // 下一轮会再答一遍。这几行单独维护，按时间排在最后。
    lines.push(`我（${botName}）: ${botReplies.map((r) => r.text).join(' / ')}`)
  }
  lines.push('')
  lines.push('【只看最新一条，逐项判断】')
  if (ambient) {
    // 常开模式（judgeAlwaysOn）：机器人此前没参与这轮，没有"叫醒我的话"，
    // 第 2 项退化成"和群里此刻正在聊的话题一致"（别插进刚起的新话题）。
    lines.push('1 相关：这条消息是否与我有关？叫了我的名字、问的是我能答的事、或在讨论我参与过的话题 → Y；纯属与我无关的群友互聊 → N。')
    lines.push('2 同题：是否与群里此刻正在聊的话题一致？是同一个话题、同一件事的延续 → Y；刚起了个新话题、或从别处岔过来 → N。')
    lines.push('3 需要：值不值得我主动插一句？有人在问具体问题、求助、拿不定主意在征求看法，且还没人回应 → Y；只是闲聊、附和、玩梗、复读、纯语气词（哈哈/确实/6/表情）、别人已经在答、话题已收尾、私人纠纷或敏感是非 → N。')
    lines.push('拿不准一律 N。')
  } else {
    lines.push(`背景：${windowMin} 分钟前你接过话，这段时间里群里接着说的话，只要还在同一个话题上就可以继续聊。`)
    lines.push('1 相关：这条消息是否与我有关？提到我、回应我、问的是我说过或做过的事、正需要我的能力 → Y；与我无关的群友互聊 → N。')
    lines.push('2 同题：是否与【叫醒我的那句话】属于同一话题？同一件事、同一个问题、同一条线索的后续（追问细节、反驳、补充、接着吐槽）→ Y；换了新话题、或另起一件不相干的事 → N。')
    lines.push('3 需要：是否需要我参与？有人在等这个回答、话题还悬着、我能给出实质信息或判断 → Y；只是附和、玩梗、复读、纯语气词（哈哈/确实/6/表情）、别人已经在答、话题已自然收尾 → N。')
    lines.push('拿不准一律 N。')
  }
  if (extra) {
    lines.push('')
    lines.push('【额外规则】')
    lines.push(extra)
  }
  lines.push('')
  lines.push('【输出格式】')
  lines.push('第一行只写三个字母，依次是 相关、同题、需要（Y=是，N=否），中间不加空格，例如 YYN。')
  lines.push('第二行写理由，不超过 20 字。')
  return lines.join('\n')
}

/** 打散 `{{`，与 content.js 的做法一致（插零宽空格，视觉不变、不再匹配变量）。 */
function scatter(text) {
  return String(text ?? '').replace(/\{\{/g, '{\u200B{')
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

/**
 * 三项判断的字段标签。
 *
 * 模型只要写成「相关=Y 同题=Y 需要=N」，就能被逐项取到；不写标签、
 * 只吐 `YYN` 也认（见 triplet）。两条路都不通才退化成单字母兜底。
 */
const FIELD_LABELS = {
  related: ['相关', '有关', '关联'],
  same: ['同题', '同一话题', '同话题'],
  need: ['需要', '需参与', '要我参与'],
}

function toBool(ch) {
  const s = String(ch ?? '').trim()
  if (s === 'Y' || s === 'y' || s === '是' || s === '要' || s === '1' || s === 'true') return true
  if (s === 'N' || s === 'n' || s === '否' || s === '不' || s === '0' || s === 'false') return false
  return null
}

/** 日志里把布尔还原成 Y/N。 */
function letter(value) {
  return value === true ? 'Y' : 'N'
}

/** 取「标签 = Y/N」形式里的值。找不到返回 null（不是 false）。 */
function labeledBool(text, labels) {
  for (const label of labels) {
    const m = text.match(new RegExp(`${label}\\s*[=:：]?\\s*([YyNn]|是|否|要|不)`))
    if (m) {
      const value = toBool(m[1])
      if (value !== null) return value
    }
  }
  return null
}

/**
 * 从某一行里剥出三个字母。
 *
 * 为什么这样剥：模型给 `YYN`、`Y Y N`、`1=Y 2=Y 3=N`、`相关=Y 同题=Y 需要=N`
 * 都很常见，把非 Y/N 字符全删掉再取前三位，四种写法就统一了。
 * 只在一行里凑够 3 个字母才算 —— 否则一句「N，换话题了」会被误读成三项。
 */
function triplet(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const letters = line.replace(/[^YyNn]/g, '')
    if (letters.length >= 3) return [toBool(letters[0]), toBool(letters[1]), toBool(letters[2])]
  }
  return null
}

/** 模型自报的理由，只用于日志与排障，不参与判定。 */
function extractReason(text) {
  const m = String(text).match(/理由\s*[=:：]?\s*([^\n]+)/)
  if (m) return m[1].trim().slice(0, 40)
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const tail = lines.find((l) => !/[YyNn]/.test(l) && l.length > 1)
  return tail ? tail.slice(0, 40) : ''
}

function finish(related, same, need, verdict, detail) {
  return {
    reply: related === true && same === true && need === true,
    verdict,
    related,
    same,
    need,
    detail,
  }
}

/**
 * 解析三项判断的结果。
 *
 * **三项全 Y 才接**：只看"相不相关"会接一堆自己插不上嘴的闲扯；
 * 只看"需不需要"又会去抢别人的话头。任一为 N 就不接，方向永远是"宁可漏回"。
 *
 * 输出格式兼容顺序：带标签的 → 三个字母 → 单字母（老提示词/换了模型时退化）。
 * 全认不出 = 不接，绝不能因为解析失败就放行。
 */
export function parseVerdict3(text) {
  const s = String(text ?? '').trim()
  if (!s) return { reply: false, verdict: 'empty', related: false, same: false, need: false, detail: '' }

  const detail = extractReason(s)
  const related = labeledBool(s, FIELD_LABELS.related)
  const same = labeledBool(s, FIELD_LABELS.same)
  const need = labeledBool(s, FIELD_LABELS.need)

  if (related !== null && same !== null && need !== null) {
    return finish(related, same, need, 'labeled', detail)
  }

  const tri = triplet(s)
  if (tri) return finish(tri[0], tri[1], tri[2], 'triplet', detail)

  const legacy = parseVerdict(s)
  if (legacy.verdict === 'yes' || legacy.verdict === 'yes-loose') {
    return finish(true, true, true, legacy.verdict, detail)
  }
  if (legacy.verdict === 'no') return finish(false, false, false, legacy.verdict, detail)

  return { reply: false, verdict: 'unrecognized', related: false, same: false, need: false, detail }
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
     * key -> "这次是被哪句话叫醒的"：{text, senderName, reason}。
     *
     * 三项判断里的第 2 项（是否同一话题）需要参照物。参照物必须是**触发这次
     * 回复的那条消息**，而不是笼统的"最近几条" —— 窗口里随时可能混进别的话题，
     * 拿最近几条当锚，判定就会把新话题也算成同题。
     * 跟进期里再次接话时锚点会换成那条新消息：它才是当下这轮话题的起点。
     */
    this.wakeAnchors = new Map()
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
      // 三项各自命中的次数：判定不接话时，靠这三个数判断是哪一关卡住的
      // （相关就 N = 认错人；同题 N = 话题跑了；需要 N = 插不上嘴）。
      relatedYes: 0,
      sameYes: 0,
      needYes: 0,
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

  /**
   * 记下"这次是被哪句话叫醒的"，供第 2 项判断当话题锚点。
   *
   * 在真正排程（要回这条消息）时调用，不等到回复发出：话题从被叫醒那一刻就定了，
   * 而回复可能要十几秒甚至超时。回复没发出去时窗口不会开，锚点留着也无害 ——
   * 它只在跟进期判定时才被读到。
   *
   * 每个群只留最新一条（它就是"我为什么开口"的最近原因）；
   * 纯内存，重启即清，与跟进窗口同生命周期。
   */
  recordWake({ key, text, senderName, reason } = {}) {
    if (!key) return
    const value = String(text ?? '').trim()
    if (!value) return
    this.wakeAnchors.set(key, {
      text: value.slice(0, 200),
      senderName: String(senderName ?? '').trim().slice(0, 20),
      reason: String(reason ?? '').trim().slice(0, 20),
    })
  }

  /** 只用于测试与排障：取当前话题锚点。 */
  wakeAnchor(key) {
    return this.wakeAnchors.get(key)
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
   *   followup = 跟进期里"是否相关 / 是否同一话题 / 是否需要我"；
   *   ambient  = 常开模式"是否相关 / 是否当前话题 / 值不值得我主动插一句"。两者标准不同，不可混用。
   * @returns {Promise<{reply:boolean, related:boolean, same:boolean, need:boolean,
   *   reason:string, detail?:string, usage?:object, verdict?:string}>}
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
    const maxMsgs = cfg.judgeContextMessages ?? 10
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
      wake: this.wakeAnchors.get(key),
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
    const timeoutMs = cfg.judgeTimeoutMs ?? 12000
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    // purpose 用 'session-title' 只是合法的辅助调用分类（与生成会话标题同通道），
    // 并不会关掉 thinking —— 不传 reasoningEffort 时模型走默认推理档位，
    // 三项判断本身就要先想一遍，输出预算给小了会被思考吃光、正文为空。
    // 默认 320：够想 + 三个字母 + 一行理由，比主会话的 26.5k 仍便宜一个量级。
    const options = {
      provider: route.provider,
      model: route.model,
      messages,
      system: BASE_SYSTEM,
      maxTokens: cfg.judgeMaxTokens ?? 320,
      // 判定是分类，不该有随机性。不显式给 0 时，实测同一段对话在不同轮次
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
      const parsed = parseVerdict3(text)
      const { reply, verdict, related, same, need, detail } = parsed
      this.stats.calls++
      if (reply) this.stats.yes++
      else this.stats.no++
      if (related) this.stats.relatedYes++
      if (same) this.stats.sameYes++
      if (need) this.stats.needYes++
      if (usage) {
        this.stats.inputTokens += usage.inputTokens ?? 0
        this.stats.outputTokens += usage.outputTokens ?? 0
        this.stats.cacheReadTokens += usage.cacheReadTokens ?? 0
      }
      this.logger.info(
        `[判定] ${key} ${verdict} ${letter(related)}${letter(same)}${letter(need)}` +
          `(关${letter(related)}/题${letter(same)}/需${letter(need)}) mode=${mode} model=${route.model} ` +
          `tokens=${(usage?.inputTokens ?? 0)}+${(usage?.outputTokens ?? 0)}` +
          `(缓存读${usage?.cacheReadTokens ?? 0}) ` +
          `out="${text.trim().replace(/\s+/g, ' ').slice(0, 24)}"` +
          (detail ? ` why="${detail}"` : '') +
          (verdict === 'empty' ? ` fin=${finishReason ?? '?'}` : '')
      )
      return { ...parsed, reason: verdict, usage }
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
      return { reply: false, reason: `${reason}-failclosed`, failOpen: false, related: false, same: false, need: false }
    }
    const failOpen = cfg?.judgeFailOpen !== false
    return {
      reply: failOpen,
      reason: failOpen ? `${reason}-failopen` : reason,
      failOpen,
      related: failOpen,
      same: failOpen,
      need: failOpen,
    }
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
