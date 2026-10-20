/**
 * 上下文摘要器：把"装不进预算的旧轮次"压成一段话。
 *
 * 只在 planContext 判定 over=true（确实超了预算、且存在更早的轮次）时才调用 ——
 * 也就是说正常群里一天也未必调用几次，成本可以忽略。
 *
 * 两个关键设计：
 *   1. **增量**：缓存上一次的摘要，新内容来了就"旧摘要 + 新增的旧轮次"再压一次。
 *      否则每超一次就要把全部旧内容重读一遍，越往后越贵。
 *   2. **可失败**：拿不到路由 / 模型报错 / 超时，一律返回 undefined，
 *      由调用方退回有损截断。摘要只是优化，不能让整轮回复挂掉。
 */
import { renderHistory } from './content.js'
import { auxLlm, resolveAuxRoute, streamText } from './llm.js'

/**
 * 摘要用的系统提示。
 *
 * 极短是有意的：它是每次调用的固定成本，而且这段调用不带任何工具与
 * agent 系统提示。要点是"保留能被继续追问的东西"（人物、结论、未决问题），
 * 而不是复述寒暄。
 */
const BASE_SYSTEM = [
  '你把群聊记录压缩成一段简短的中文摘要，供后续对话当背景使用。',
  '保留：谁在聊什么、已经得出的结论、还没解决的问题、与机器人相关的约定。',
  '丢掉：寒暄、语气词、表情、重复内容。',
  '用陈述句，不要分点，不要评论，不要提及"摘要"这个词本身。不要编造记录里没有的信息。',
].join('\n')

export class Summarizer {
  /**
   * @param {{ctx: object, getConfig: () => object, logger: object}} deps
   */
  constructor({ ctx, getConfig, logger }) {
    this.ctx = ctx
    this.getConfig = getConfig
    this.logger = logger
    /** key -> { uptoSeq, text } 上次摘要覆盖到哪条（seq 是单调的，拿它当版本号） */
    this.cache = new Map()
    this.stats = { calls: 0, errors: 0, skipped: 0, inputTokens: 0, outputTokens: 0 }
  }

  /**
   * 取（必要时生成）该会话的旧轮次摘要。
   *
   * @param {{key: string, scene: string, entries: Array}} input
   * @returns {Promise<string|undefined>} undefined = 不可用，调用方走截断兜底
   */
  async get({ key, scene, entries }) {
    const list = (entries ?? []).filter((m) => String(m?.text ?? '').trim())
    if (!list.length) return undefined

    const cfg = this.getConfig()
    const uptoSeq = Number(list[list.length - 1]?.seq ?? 0)
    const cached = this.cache.get(key)
    // 边界没推进就直接复用 —— 同一批旧内容不重复花钱
    if (cached && cached.uptoSeq === uptoSeq) return cached.text

    const llm = auxLlm(this.ctx)
    if (!llm) {
      this.stats.skipped++
      this.logger?.warn('[摘要] 宿主没有 ctx.llm.stream()，跳过后退回截断')
      return undefined
    }
    const route = resolveAuxRoute(this.ctx, cfg, {
      providerKey: 'contextSummaryProvider',
      modelKey: 'contextSummaryModel',
    })
    if (!route) {
      this.stats.skipped++
      this.logger?.warn('[摘要] 解析不出 provider/model，跳过后退回截断')
      return undefined
    }

    const messageBudget = cfg.contextSummaryMessages ?? 200
    const body = renderHistory(list.slice(-messageBudget), scene, cfg.contextMaxChars ?? 4000)
    const lines = []
    if (cached?.text) {
      lines.push('【已有的摘要】', cached.text, '')
    }
    lines.push('【新的聊天记录】', body, '')
    lines.push(`把它们合并成一段不超过 ${cfg.contextSummaryMaxChars ?? 300} 字的中文摘要。只输出摘要本身。`)

    const controller = new AbortController()
    const timeoutMs = cfg.contextSummaryTimeoutMs ?? 15000
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    this.stats.calls++
    try {
      const { text, usage, finish } = await streamText(llm, {
        provider: route.provider,
        model: route.model,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: lines.join('\n') }],
            source: { kind: 'plugin', plugin: 'dsh-qq-chat-agent' },
          },
        ],
        system: BASE_SYSTEM,
        maxTokens: cfg.contextSummaryMaxTokens ?? 512,
        // 摘要不该有随机性：同一段历史两次压出不同的话，会让模型前后理解不一致
        temperature: 0,
        // 与"生成会话标题"同一条辅助通道的分类值；不关 thinking，
        // 所以 maxTokens 给足（默认 512），别让思考把正文吃光。
        purpose: 'session-title',
        signal: controller.signal,
      })
      if (controller.signal.aborted) throw new Error(`摘要超时（${timeoutMs}ms）`)
      const summary = String(text ?? '').replace(/\s+/g, ' ').trim()
      if (!summary) {
        this.logger?.warn(`[摘要] ${key} 模型输出为空 fin=${finish ?? '?'}，退回截断`)
        return undefined
      }
      if (usage) {
        this.stats.inputTokens += usage.inputTokens ?? 0
        this.stats.outputTokens += usage.outputTokens ?? 0
      }
      this.cache.set(key, { uptoSeq, text: summary })
      this.logger?.info(
        `[摘要] ${key} ${list.length} 条 → ${summary.length} 字 ` +
          `tokens=${usage?.inputTokens ?? 0}+${usage?.outputTokens ?? 0}`
      )
      return summary
    } catch (error) {
      this.stats.errors++
      this.logger?.warn(`[摘要] ${key} 失败: ${error?.message ?? error}，退回截断`)
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  /** 会话回收时清掉对应缓存（重启后本来是空的，这里是防 Map 无界增长）。 */
  clear(key) {
    this.cache.delete(key)
  }

  describe() {
    return (
      `调用 ${this.stats.calls} 次（失败 ${this.stats.errors}，跳过 ${this.stats.skipped}），` +
      `tokens=${this.stats.inputTokens}+${this.stats.outputTokens}`
    )
  }

  stop() {
    this.cache.clear()
  }
}
