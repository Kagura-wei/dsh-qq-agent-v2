/**
 * 提醒 / 通知：在群里对它说一句「明天8点提醒我开会」，到点它自己来说。
 *
 * 在整条链路里的位置 ——
 *   消息到达 → 提醒意图识别（本地正则 / 轻量模型）→ **命中就地接管，不进主会话**
 *   没命中 → 照常走门控 → 触发 → agent 会话
 *
 * 为什么不让 agent 干这件事：主会话每轮要付 26k token 的固定前缀（agent 系统提示
 * 16,796 字 + 96 个工具 schema + mnemon 快照），而"设提醒"是一个时间和一句话就能
 * 描述清楚的确定性动作。本地解析 + 直接回执，成本是零到三百 token。
 *
 * 四条硬约束：
 *   0. **建不建由模型点头** —— @ 和提醒词只负责"值得看一眼"，不负责下结论。
 *      词表决定建提醒 = 随机打扰（「你提醒他一下」「我记得昨天提醒过」天天出现）。
 *      判定通道不可用时按不建处理（fail-closed）。
 *   1. **到点发消息不经过 agent** —— 到点了就是到点了，不需要模型判断要不要提醒。
 *   2. **落盘即完成** —— 每次增删改都 await 写盘，不做延迟批量（重启丢提醒不可接受）。
 *   3. **错过不装死** —— 服务停机跨过触发点时，`reminderCatchUpMin` 以内的补发，
 *      超出的记日志跳过。NAS 重启是常态，静默吞掉才是最糟的。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { sessionKeyOf } from './store.js'
import {
  parseLocal,
  parseModelReply,
  buildParsePrompt,
  PARSE_SYSTEM,
  INTENT_SYSTEM,
  buildIntentPrompt,
  parseIntentReply,
  computeNext,
  formatWhen,
  extractTask,
  stripMentions,
} from './reminder-parse.js'

/** 扫描周期。提醒精度就是这个量级，20 秒对"几点几分"级别的需求足够。 */
const TICK_MS = 20_000
/** 发送失败后的重试间隔。 */
const RETRY_MS = 60_000
/** 连续失败多少次后放弃（一次性的直接删；重复的跳到下一个周期）。 */
const MAX_FAILS = 3
/** 一句话超过这个长度就不再当提醒解析 —— 长文里出现"提醒"多半是在聊天。 */
const MAX_TEXT_LEN = 200
/** 轻量解析的超时与输出上限。JSON 要占几行，给足余量（思考也吃这个预算）。 */
const PARSE_TIMEOUT_MS = 8000
const PARSE_MAX_TOKENS = 256
/** 意图判定：只要一个字母，但 `purpose` 不关思考，给小了会被思考吃干净。 */
const INTENT_TIMEOUT_MS = 5000
const INTENT_MAX_TOKENS = 64

const DEFAULT_CONFIRM_TEXT = '好，{when} 提醒你：{task}'

/** 「查看提醒」：整句就是这三个词之一/组合，才当命令。 */
const LIST_RE =
  /^(?:查看|看看|看下|查一下|查询|显示|列出|有哪些|有那些|我的|我设的|我设置的)?\s*(?:这个群|本群|群|我)?\s*(?:的)?\s*(?:提醒|定时|通知|日程|闹钟)\s*(?:列表|清单|有哪些|都有啥)?$/

/** 「取消提醒 2」/「取消全部提醒」。 */
const CANCEL_RE =
  /^(?:取消|删除|删掉|撤销|去掉|不要|不用)\s*(?:掉)?\s*(?:(?<all>所有|全部|一切)\s*)?(?:提醒|定时|通知|日程|闹钟)\s*(?:#|第)?\s*(?<n>\d+|全部|所有|all)?\s*(?:条|个)?$/i

function nowMs() {
  return Date.now()
}

export function matchReminderCommand(text) {
  // 命令要"整句就是命令"才认：去掉空白与收尾标点后逐字比对，
  // 否则「提醒我明天8点开会」会被当成"提醒"列表命令截胡。
  const bare = String(text ?? '').replace(/[\s，,。.！!？?、；;：:~～]/g, '')
  if (!bare) return null
  if (CANCEL_RE.test(bare)) {
    const m = CANCEL_RE.exec(bare)
    const raw = (m.groups?.all ?? '') || (m.groups?.n ?? '')
    if (!raw) return { kind: 'cancel', target: 'last' }
    if (/all|全部|所有/i.test(raw)) return { kind: 'cancel', target: 'all' }
    return { kind: 'cancel', target: Number(raw) }
  }
  if (LIST_RE.test(bare)) return { kind: 'list' }
  return null
}

export class ReminderService {
  /**
   * @param {object} deps
   * @param {object} deps.ctx cordis 上下文（取 llm / agentDefaultModel）
   * @param {() => object} deps.getConfig
   * @param {{send:Function, sendSegments:Function}} deps.sender
   * @param {{markRead:Function}} deps.archive
   * @param {object} deps.logger
   * @param {string} deps.dir 数据目录（与 qq-archive 同级）
   * @param {() => number} [deps.now] 注入时钟，单测用
   */
  constructor({ ctx, getConfig, sender, archive, logger, dir, now = nowMs, autoStart = true }) {
    this.ctx = ctx
    this.getConfig = getConfig
    this.sender = sender
    this.archive = archive
    this.logger = logger
    this.dir = dir
    this.now = now
    this.autoStart = autoStart

    this.file = path.join(dir, 'qq-reminders.json')
    /** @type {Array<object>} */
    this.items = []
    this.nextId = 1
    this.timer = null
    this.ticking = false
    this.loaded = false
    this.stats = { created: 0, fired: 0, missed: 0, failed: 0, judged: 0, vetoed: 0 }
  }

  // ────────────────────────── 生命周期 ──────────────────────────

  async init() {
    await fs.mkdir(this.dir, { recursive: true })
    let readNote
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed?.items)) {
        this.items = parsed.items.filter((r) => r && typeof r === 'object' && Number.isFinite(Number(r.nextAt)))
        this.nextId = Number(parsed.nextId) || this.items.length + 1
      }
      readNote = `提醒已加载 ${this.items.length} 条`
    } catch (error) {
      // ENOENT = 首次运行，属正常；但"加载日志"必须照打 ——
      // 否则冷启动时日志里查不到提醒子系统是否起来了（踩过一次）。
      readNote = error?.code === 'ENOENT' ? '提醒文件不存在（首次运行）' : `读提醒文件失败: ${error?.message ?? error}`
      if (error?.code !== 'ENOENT') this.logger.warn(readNote)
    }
    this.loaded = true
    // 只有显式传 false 才不自动起扫描：漏了赋值会静默"建了提醒却永远不响"，
    // 这个默认值就是防那种 bug 的。
    if (this.autoStart !== false) this.#start()
    this.logger.info(`${readNote}；扫描间隔 ${Math.round(TICK_MS / 1000)}s，文件 ${this.file}`)
  }

  /** 立刻扫一遍待触发队列。正常由定时器驱动，单测与手工排障时手动调。 */
  async tickOnce() {
    await this.#tick()
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.#flush().catch(() => {})
  }

  #start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.#tick().catch((error) => this.logger.error(`[提醒] 扫描异常: ${error?.message ?? error}`))
    }, TICK_MS)
    this.timer.unref?.()
  }

  // ────────────────────────── 入口 ──────────────────────────

  /**
   * 尝试把这条消息当成提醒请求处理。
   *
   * @returns {Promise<boolean>} true = 已接管，调用方不要再交给 agent
   */
  async tryHandle({ cfg, msg, mention, decision, key }) {
    // 默认开：只有显式关掉才不介入。老配置文件里没有这个键时不该"静默失效"。
    if (cfg?.reminderEnabled === false) return false
    // 复用门控已经算好的白名单/屏蔽结论，别在这里再实现一遍
    if (decision?.reason === 'not-allowed' || decision?.reason === 'blocked') return false

    const text = String(msg.text ?? '').trim()
    if (!text || text.length > MAX_TEXT_LEN) return false

    const bare = stripMentions(text, cfg.botName).trim()
    const command = matchReminderCommand(bare)
    const mentionHit = mention === true
    const keywordHit = (cfg.reminderKeywords ?? []).some((k) => k && text.includes(k))

    // 没有 @、也没说关键词、也不是管理命令 → 与提醒无关，正常聊天去
    if (!mentionHit && !keywordHit && !command) return false
    if (cfg.reminderRequireMention === true && !mentionHit) return false

    try {
      // 管理命令（查看/取消）是整句精确匹配，语义无歧义，不过判定闸门
      if (command) return await this.#runCommand({ command, cfg, msg, key })

      // ★ 意图判定：@ 和提醒词只说明「这句话值得看一眼」，**不说明**说话人
      // 在下指令。“你提醒他一下”“我记得昨天提醒过”“明天8点开会”这些天天出现，
      // 交给词表决定就等于随机打扰。所以建不建由模型点头。
      const verdict = await this.#judgeIntent({ text, cfg })
      if (verdict !== 'Y') {
        if (verdict === null) {
          // 判不了（没路由/超时/报错）→ 宁可不建：误建一次提醒的骚扰，
          // 比漏建一次的代价大得多。
          this.logger.warn(`[提醒判定] ${key} 不可用，按不建处理: ${text.slice(0, 40)}`)
        } else {
          // 这条日志要常在：用户问"我说了怎么没提醒"时，靠它证明是模型判了闲聊，
          // 而不是模块没收到消息。
          this.logger.info(`[提醒判定] ${key} N → 不建: ${text.slice(0, 40)}`)
        }
        return false
      }

      const spec =
        parseLocal(text, this.now()) || (cfg.reminderLlmParse !== false ? await this.#parseWithLlm(text, cfg) : null)
      // 解析不出来 = 不是提醒请求（或时间说不清）→ 交回正常流程，
      // 让机器人自然地接话，而不是甩一句"我没听懂"
      if (!spec) return false

      return await this.#create({ spec, cfg, msg, key, text })
    } catch (error) {
      this.logger.error(`[提醒] 处理失败 ${key}: ${error?.message ?? error}`)
      return false
    }
  }

  // ────────────────────────── 创建 ──────────────────────────

  async #create({ spec, cfg, msg, key, text }) {
    const task = spec.task ?? extractTask(text, spec.span, cfg.botName)
    if (!task) {
      await this.#reply(cfg, msg, key, '提醒内容我听到时间了，但没听清要做什么。再说一次试试，比如「明天8点提醒我开会」。')
      return true
    }

    const mine = this.#mine(key)
    const max = cfg.reminderMaxPerChat ?? 50
    if (mine.length >= max) {
      await this.#reply(cfg, msg, key, `这个会话的提醒已经有 ${mine.length} 条（上限 ${max}），先取消几条再来。`)
      return true
    }

    const nextAt = spec.repeat === 'once' ? spec.at : (spec.nextAt ?? computeNext(spec, this.now()))
    if (!Number.isFinite(nextAt)) return false

    const dup = mine.find(
      (r) => r.creatorId === msg.senderId && r.task === task && Math.abs(Number(r.nextAt) - nextAt) < 60_000
    )
    if (dup) {
      await this.#reply(cfg, msg, key, `这条已经设过了：${formatWhen(dup, this.now())} · ${dup.task}`)
      return true
    }

    const rem = {
      id: this.nextId++,
      scene: msg.scene,
      peerId: msg.peerId,
      creatorId: msg.senderId,
      creatorName: msg.senderName ?? '',
      task,
      repeat: spec.repeat,
      nextAt,
      hour: spec.hour,
      minute: spec.minute,
      ...(spec.repeat === 'weekly' ? { weekdays: spec.weekdays } : {}),
      createdAt: this.now(),
      fired: 0,
      fail: 0,
    }
    this.items.push(rem)
    await this.#flush()
    this.stats.created++

    this.logger.info(
      `[提醒新建] ${key} #${rem.id} from=${msg.senderId} ${formatWhen(rem, this.now())} · ${task}`
    )

    // 这条消息已经被消耗掉了，标已读 —— 否则它下次会作为"未读"灌进 agent 会话，
    // 模型会对着一条早就处理过的消息再回一遍。
    await this.#markRead(key, msg)
    if (this.reminderConfirmEnabled(cfg)) {
      await this.#reply(cfg, msg, key, this.#confirmText(cfg, rem))
    }
    return true
  }

  reminderConfirmEnabled(cfg) {
    return cfg.reminderConfirm !== false
  }

  #confirmText(cfg, rem) {
    const tpl = String(cfg.reminderConfirmText ?? '').trim() || DEFAULT_CONFIRM_TEXT
    return tpl
      .split('{when}')
      .join(formatWhen(rem, this.now()))
      .split('{task}')
      .join(rem.task)
      .split('{repeat}')
      .join(rem.repeat === 'once' ? '一次性' : rem.repeat === 'daily' ? '每天' : '每周')
  }

  // ────────────────────────── 命令 ──────────────────────────

  async #runCommand({ command, cfg, msg, key }) {
    const mine = this.#mine(key)
    await this.#markRead(key, msg)

    if (command.kind === 'list') {
      await this.#reply(cfg, msg, key, this.#listText(mine))
      return true
    }

    if (command.kind === 'cancel') {
      if (!mine.length) {
        await this.#reply(cfg, msg, key, '这个会话还没有提醒。')
        return true
      }
      if (command.target === 'all') {
        const own = mine.filter((r) => r.creatorId === msg.senderId)
        if (!own.length) {
          await this.#reply(cfg, msg, key, '这里没有你设的提醒。')
          return true
        }
        for (const r of own) this.#remove(r.id)
        await this.#flush()
        this.logger.info(`[提醒取消] ${key} from=${msg.senderId} 全部 ${own.length} 条`)
        await this.#reply(cfg, msg, key, `已取消你设的 ${own.length} 条提醒。`)
        return true
      }

      let target = null
      if (command.target === 'last') {
        // 没说序号：只有一条就直接删，多条就把清单摆出来让人挑
        const own = mine.filter((r) => r.creatorId === msg.senderId)
        if (own.length === 1) target = own[0]
        else {
          await this.#reply(cfg, msg, key, `要取消哪一条？回复「取消提醒 序号」。\n${this.#listText(mine)}`)
          return true
        }
      } else {
        const idx = Number(command.target)
        target = Number.isFinite(idx) && idx >= 1 && idx <= mine.length ? mine[idx - 1] : null
        if (!target) {
          await this.#reply(cfg, msg, key, `没有第 ${command.target} 条。当前共 ${mine.length} 条：\n${this.#listText(mine)}`)
          return true
        }
      }

      if (target.creatorId !== msg.senderId) {
        await this.#reply(cfg, msg, key, '这条提醒不是你设的，不能替你取消。')
        return true
      }

      this.#remove(target.id)
      await this.#flush()
      this.logger.info(`[提醒取消] ${key} #${target.id} from=${msg.senderId}`)
      await this.#reply(cfg, msg, key, `已取消：${formatWhen(target, this.now())} · ${target.task}`)
      return true
    }

    return false
  }

  #listText(mine) {
    if (!mine.length) return '这个会话还没有提醒。'
    const now = this.now()
    const lines = [`本会话的提醒（${mine.length} 条）：`]
    mine.forEach((r, i) => {
      const who = r.creatorName ? ` — ${r.creatorName}` : ''
      lines.push(`${i + 1}. ${formatWhen(r, now)} · ${r.task}${who}`)
    })
    lines.push('回复「取消提醒 序号」可以删除。')
    return lines.join('\n')
  }

  // ────────────────────────── 到点触发 ──────────────────────────

  async #tick() {
    if (this.ticking || !this.loaded) return
    this.ticking = true
    try {
      const now = this.now()
      const due = this.items.filter((r) => Number(r.nextAt) <= now).sort((a, b) => a.nextAt - b.nextAt)
      for (const rem of due) await this.#fire(rem, now)
    } finally {
      this.ticking = false
    }
  }

  async #fire(rem, now) {
    const cfg = this.getConfig()
    const key = sessionKeyOf(rem.scene, rem.peerId)
    const late = now - Number(rem.nextAt)
    const catchUpMs = (cfg.reminderCatchUpMin ?? 30) * 60_000

    if (late > catchUpMs) {
      // 停机太久：一次性提醒直接作废，重复的跳到下一个周期。
      // 两天后才弹一句"提醒你开会"只会让人困惑，不如安静跳过并留下日志。
      this.#advance(rem, now)
      await this.#flush()
      this.stats.missed++
      this.logger.warn(
        `[提醒跳过] ${key} #${rem.id} 错过 ${Math.round(late / 60_000)} 分钟（上限 ${cfg.reminderCatchUpMin ?? 30}）: ${rem.task}`
      )
      return
    }

    const text = `${late > 60_000 ? '（补发）' : ''}⏰ ${this.#fireLabel(rem)}：${rem.task}`
    const segments =
      rem.scene === 'group' && cfg.reminderAtCreator !== false && rem.creatorId
        ? [
            { type: 'at', data: { qq: String(rem.creatorId) } },
            { type: 'text', data: { text: ` ${text}` } },
          ]
        : [{ type: 'text', data: { text } }]

    try {
      const res = await this.sender.sendSegments(rem.scene, rem.peerId, segments, key)
      if (!res || res.sent <= 0) throw new Error('未发出（可能触发限频）')
      rem.fired = (rem.fired ?? 0) + 1
      rem.lastFiredAt = now
      rem.fail = 0
      this.#advance(rem, now)
      await this.#flush()
      this.stats.fired++
      this.logger.info(`[提醒发出] ${key} #${rem.id} ${this.#fireLabel(rem)} · ${rem.task}`)
    } catch (error) {
      rem.fail = (rem.fail ?? 0) + 1
      if (rem.fail >= MAX_FAILS) {
        this.#advance(rem, now)
        this.stats.failed++
        this.logger.error(
          `[提醒失败] ${key} #${rem.id} 连续 ${rem.fail} 次发不出去，放弃: ${error?.message ?? error}`
        )
      } else {
        // 保持 nextAt 不变地重试：一分钟后再来，成功即走正常推进
        rem.nextAt = now + RETRY_MS
        this.logger.warn(`[提醒重试] ${key} #${rem.id} 第 ${rem.fail} 次失败: ${error?.message ?? error}`)
      }
      await this.#flush()
    }
  }

  #fireLabel(rem) {
    if (rem.repeat === 'daily') return '每日提醒'
    if (rem.repeat === 'weekly') return '每周提醒'
    return '提醒'
  }

  /** 触发成功后推进到下一位；一次性的直接删掉。 */
  #advance(rem, now) {
    if (rem.repeat === 'once') {
      this.#remove(rem.id)
      return
    }
    const next = computeNext(rem, now)
    if (next == null) {
      this.#remove(rem.id)
      return
    }
    rem.nextAt = next
  }

  // ────────────────────────── 轻量模型解析 ──────────────────────────

  /**
   * 让模型判一次「这句话是不是在让我设提醒」。
   *
   * 这是防误触发的唯一闸门。返回 'Y' 才继续解析；'N' 交回正常聊天；
   * null（没通道/没路由/超时/报错）也按不建处理 —— 误建一次提醒的骚扰，
   * 比漏建一次的代价大。
   *
   * @returns {Promise<'Y'|'N'|null>}
   */
  async #judgeIntent({ text, cfg }) {
    // 逃生开关：判定通道长期不可用时，可以一键退回「命中即建」的旧行为
    if (cfg.reminderIntentJudge === false) return 'Y'

    const llm = this.ctx?.get?.('llm')
    if (!llm || typeof llm.stream !== 'function') return null
    const route = this.#resolveRoute(cfg)
    if (!route) return null

    const prompt = buildIntentPrompt({ text, botName: cfg.botName })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), INTENT_TIMEOUT_MS)
    let out = ''
    let usage
    try {
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        system: INTENT_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'plugin', plugin: 'dsh-qq-chat-agent' },
          },
        ],
        maxTokens: INTENT_MAX_TOKENS,
        temperature: 0,
        purpose: 'session-title',
        signal: controller.signal,
      })) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta') {
          out += chunk.text ?? ''
          continue
        }
        if (chunk.type === 'block-end' && chunk.block?.type === 'text' && chunk.block.text && !out) {
          out = chunk.block.text
          continue
        }
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') break
      }
    } catch (error) {
      this.logger.warn(`[提醒判定] 调用失败: ${error?.message ?? error}`)
      return null
    } finally {
      clearTimeout(timer)
    }

    const verdict = parseIntentReply(out)
    this.stats.judged++
    if (verdict !== 'Y') this.stats.vetoed++
    if (cfg.logEvents === true) {
      this.logger.info(
        `[提醒判定] model=${route.model} tokens=${usage?.inputTokens ?? 0}+${usage?.outputTokens ?? 0} ` +
          `out="${out.replace(/\s+/g, ' ').slice(0, 20)}" → ${verdict ?? 'null'}`
      )
    }
    return verdict
  }

  #resolveRoute(cfg) {
    const provider = trimTo(cfg.reminderProvider) || trimTo(cfg.provider) || this.#defaultSelection()?.provider
    const model = trimTo(cfg.reminderModel) || trimTo(cfg.model) || this.#defaultSelection()?.model
    if (!provider || !model) return undefined
    return { provider, model }
  }

  #defaultSelection() {
    try {
      const service = this.ctx?.get?.('agentDefaultModel')
      if (service && typeof service.currentSelection === 'function') return service.currentSelection()
    } catch {
      /* 取不到就走降级 */
    }
    return undefined
  }

  async #parseWithLlm(text, cfg) {
    const llm = this.ctx?.get?.('llm')
    if (!llm || typeof llm.stream !== 'function') return null

    const route = this.#resolveRoute(cfg)
    if (!route) {
      this.logger.warn('[提醒解析] 解析不出 provider/model，跳过')
      return null
    }

    const prompt = buildParsePrompt({ text, now: new Date(this.now()), botName: cfg.botName })
    if (cfg.logEvents === true) this.logger.info(`[提醒解析提示]\n${prompt}`)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PARSE_TIMEOUT_MS)
    let out = ''
    let usage
    try {
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        system: PARSE_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'plugin', plugin: 'dsh-qq-chat-agent' },
          },
        ],
        maxTokens: PARSE_MAX_TOKENS,
        temperature: 0,
        purpose: 'session-title',
        signal: controller.signal,
      })) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta') {
          out += chunk.text ?? ''
          continue
        }
        if (chunk.type === 'block-end' && chunk.block?.type === 'text' && chunk.block.text && !out) {
          out = chunk.block.text
          continue
        }
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') break
      }
    } catch (error) {
      this.logger.warn(`[提醒解析] 调用失败: ${error?.message ?? error}`)
      return null
    } finally {
      clearTimeout(timer)
    }

    const spec = parseModelReply(out, this.now())
    this.logger.info(
      `[提醒解析] model=${route.model} tokens=${usage?.inputTokens ?? 0}+${usage?.outputTokens ?? 0} ` +
        `out="${out.replace(/\s+/g, ' ').slice(0, 80)}" → ${spec ? `${spec.repeat}` : 'null'}`
    )
    return spec
  }

  // ────────────────────────── 存取 ──────────────────────────

  #mine(key) {
    return this.items
      .filter((r) => sessionKeyOf(r.scene, r.peerId) === key)
      .sort((a, b) => Number(a.nextAt) - Number(b.nextAt))
  }

  #remove(id) {
    const i = this.items.findIndex((r) => r.id === id)
    if (i >= 0) this.items.splice(i, 1)
    return i >= 0
  }

  /** 每次都立即落盘 —— 提醒是"用户交给你的一件事"，丢了无法补救。 */
  async #flush() {
    const payload = JSON.stringify({ version: 1, nextId: this.nextId, items: this.items })
    await fs.writeFile(this.file, payload, 'utf8')
  }

  async #markRead(key, msg) {
    if (!msg?.messageId || !this.archive) return
    try {
      const doc = this.archive.getRecentCached(key, 5)
      const hit = doc.find((m) => Number(m.messageId) === Number(msg.messageId))
      if (hit?.seq != null) await this.archive.markRead(key, [hit.seq])
    } catch (error) {
      this.logger.warn(`[提醒] 标记已读失败 ${key}: ${error?.message ?? error}`)
    }
  }

  async #reply(cfg, msg, key, text) {
    try {
      await this.sender.send(msg.scene, msg.peerId, text, key)
    } catch (error) {
      this.logger.error(`[提醒] 回执发送失败 ${key}: ${error?.message ?? error}`)
    }
  }
}

function trimTo(value) {
  return typeof value === 'string' ? value.trim() : ''
}
