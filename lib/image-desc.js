/**
 * 历史图片的"一句话描述"。
 *
 * 上下文注入这条通道只能传字符串：`systemPrompt.context()` 的回调是**同步**的，
 * 而 image 块必须先异步落盘（`attachments.saveImage`）才能进模型。所以历史里的图
 * 到了注入文本里只剩 `[图片]` 三个字 —— 模型知道"那儿有张图"，却不知道画的是什么。
 * 群里"发图 + 说话"是常态，缺了这半边信息，模型很容易答得驴唇不对马嘴。
 *
 * 这里不动两条通道的结构，只给**能取到字节**的图补一句描述，把注入文本从
 * `雨下雫: [图片]` 变成 `雨下雫: [图片: 又输了一局]`。四条边界：
 *
 *   - **取不到字节就放弃**：老消息的签名地址早已过期（retcode -5503007），
 *     此时保持 `[图片]` 占位，绝不为了描述再等一次注定失败的下载；
 *   - **按图片自身缓存**：描述挂在 url/file 上，同一张图在之后每一轮注入里
 *     直接复用，只花一次钱；
 *   - **每轮限量且并行**：一轮最多处理 N 张，并行发出，避免把回复的开头拖长；
 *   - **全程可失败**：没有 llm / 没有路由 / 没有附件服务 / 模型报错 / 超时，
 *     一律静默退回占位符。它只是让背景更完整，绝不能让整轮回复挂掉。
 */
import { toImageAttachments } from './image.js'
import { auxLlm, resolveAuxRoute, streamText } from './llm.js'
import { imageKeyOf } from './prefetch.js'

/** 成功描述的存活时间。同一张图的描述不会变，缓存久一点没有副作用。 */
const DEFAULT_TTL_MS = 60 * 60_000
/** 失败结果的存活时间：短一些，给网络抖动留一次机会，又不会每轮重试。 */
const FAIL_TTL_MS = 5 * 60_000
/** 缓存条目上限，防止长时间运行把 Map 撑大。 */
const DEFAULT_MAX_ENTRIES = 300
/** 单张图的描述超时（含取字节）。历史图不该拖住整轮。 */
const CALL_TIMEOUT_MS = 12_000

/**
 * 描述用的系统提示。极短是有意的 —— 它是每次调用的固定成本。
 * 要的是"能给后续对话当背景"的客观内容，不是文学描写。
 */
const BASE_SYSTEM = [
  '你在帮一个群聊机器人读懂历史记录里的图片。',
  '用一句不超过 30 字的中文，客观描述图里有什么：画面内容、能看清的文字、这是哪类截图。',
  '只输出这一句描述本身。不要开场白，不要"这张图"之类的引语，不要解释，不要换行。',
].join('\n')

const PROMPT = '用一句话描述这张图。'

/**
 * 清洗模型输出：它偶尔会加引号、换行，或来一句"这张图显示的是……"的开场白。
 * 这些在 `[图片: ...]` 里都是噪音。
 */
function cleanDesc(text, maxChars) {
  let s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  s = s
    .replace(/^[“”"'「『【]+/, '')
    .replace(/[“”"'」』】]+$/, '')
    .trim()
  s = s.replace(/^(这张|这幅|一幅|一张)?(图片|截图|图)(里|中)?(是|有|显示|拍的|截的)?[：:，,]?\s*/, '')
  if (!s) return ''
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 40
  return s.length > limit ? `${s.slice(0, limit)}…` : s
}

export class ImageDescriber {
  /**
   * @param {{ctx: object, getConfig: () => object, logger: object, prefetch?: object,
   *   ttlMs?: number, maxEntries?: number, fetchImpl?: Function}} deps
   *   fetchImpl 只在单测里替换（未预热的老图要回落实时下载）
   */
  constructor({ ctx, getConfig, logger, prefetch, ttlMs, maxEntries, fetchImpl } = {}) {
    this.ctx = ctx
    this.getConfig = getConfig ?? (() => ({}))
    this.logger = logger
    this.prefetch = prefetch
    this.fetchImpl = fetchImpl
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_MAX_ENTRIES
    /** key -> { text, at, failed }（Map 保持插入顺序，天然是 LRU 队列） */
    this.cache = new Map()
    this.stats = { calls: 0, errors: 0, skipped: 0, reused: 0, noBytes: 0 }
  }

  /**
   * 为一批历史条目准备"图片描述查表函数"。
   *
   * @param {Array} entries 即将进入上下文注入的存档条目
   * @param {{cfg?: object}} [options]
   * @returns {Promise<((segment: object) => string|undefined)|undefined>}
   *   没有任何可用描述时返回 undefined —— 调用方据此走原来的纯占位路径
   */
  async build(entries, { cfg = this.getConfig() } = {}) {
    if (cfg?.contextImageDescEnabled === false) return undefined

    const seen = new Set()
    const map = new Map()
    const todo = []
    for (const msg of entries ?? []) {
      for (const segment of msg?.segments ?? []) {
        if (segment?.type !== 'image') continue
        const key = imageKeyOf(segment)
        if (!key || seen.has(key)) continue
        seen.add(key)
        const cached = this.#lookup(key)
        if (cached) {
          if (cached.text) map.set(key, cached.text)
          this.stats.reused++
          continue
        }
        todo.push({ key, segment })
      }
    }
    if (!todo.length) return this.#of(map)

    const deps = this.#resolveDeps(cfg)
    if (!deps) {
      this.stats.skipped++
      return this.#of(map)
    }

    const max = Number.isFinite(cfg?.contextImageDescMax) ? cfg.contextImageDescMax : 3
    const batch = max > 0 ? todo.slice(0, max) : []
    if (batch.length) {
      // 并行：三张图串行会让每轮回复的开头白白多等十几秒
      const results = await Promise.all(batch.map((item) => this.#describe(item, cfg, deps)))
      for (let i = 0; i < batch.length; i++) {
        if (results[i]) map.set(batch[i].key, results[i])
      }
    }
    return this.#of(map)
  }

  #of(map) {
    if (!map.size) return undefined
    return (segment) => map.get(imageKeyOf(segment))
  }

  /** 解析这条通道要用到的三个可选依赖；缺任何一个都只能整批跳过。 */
  #resolveDeps(cfg) {
    const llm = auxLlm(this.ctx)
    if (!llm) {
      this.logger?.warn('[图片描述] 宿主没有 ctx.llm.stream()，历史图保持占位')
      return undefined
    }
    const attachments = this.ctx?.get?.('attachments')
    if (!attachments || typeof attachments.saveImage !== 'function') {
      this.logger?.warn('[图片描述] 没有附件服务，历史图保持占位')
      return undefined
    }
    const route = resolveAuxRoute(this.ctx, cfg, {
      providerKey: 'contextImageDescProvider',
      modelKey: 'contextImageDescModel',
    })
    if (!route) {
      this.logger?.warn('[图片描述] 解析不出 provider/model，历史图保持占位')
      return undefined
    }
    return { llm, attachments, route }
  }

  /**
   * 取图片字节：先问预热缓存（历史里的图多半刚预热过），没预热过才回落实时下载。
   * hit=true 且没有字节，表示预热已经试过并失败了 —— 不要重下，否则白等一次 15 秒超时。
   *
   * 只取**第一段**：长截图会被切段（见 image.js），但描述只需要"这张图大概是什么"，
   * 为一句话描述把每一段都送进模型是纯浪费。
   */
  async #bytesOf(segment) {
    const warmed = await this.prefetch?.get?.(segment)
    if (warmed?.hit) return warmed.atts?.[0]
    try {
      const parts = await toImageAttachments(segment, { logger: this.logger, fetchImpl: this.fetchImpl })
      return parts[0]
    } catch (error) {
      this.logger?.warn(`[图片描述] 取图异常: ${error?.message ?? error}`)
      return undefined
    }
  }

  async #describe({ key, segment }, cfg, { llm, attachments, route }) {
    const att = await this.#bytesOf(segment)
    if (!att) {
      this.stats.noBytes++
      this.#store(key, undefined)
      return ''
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
    this.stats.calls++
    try {
      const ref = await attachments.saveImage(att)
      const { text } = await streamText(llm, {
        provider: route.provider,
        model: route.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', attachment: ref },
              { type: 'text', text: PROMPT },
            ],
            source: { kind: 'plugin', plugin: 'dsh-qq-chat-agent' },
          },
        ],
        system: BASE_SYSTEM,
        // 与"生成会话标题"同一条辅助通道的分类值；它不关 thinking，
        // 所以输出虽小也要给足余量，别让推理把正文吃光。
        maxTokens: cfg?.contextImageDescMaxTokens ?? 128,
        temperature: 0,
        purpose: 'session-title',
        signal: controller.signal,
      })
      if (controller.signal.aborted) throw new Error(`描述超时（${CALL_TIMEOUT_MS}ms）`)
      const desc = cleanDesc(text, cfg?.contextImageDescMaxChars ?? 40)
      if (!desc) {
        this.stats.errors++
        this.logger?.warn('[图片描述] 模型输出为空，保持占位')
        this.#store(key, undefined)
        return ''
      }
      this.#store(key, desc)
      this.logger?.info(`[图片描述] ${desc}`)
      return desc
    } catch (error) {
      this.stats.errors++
      this.#store(key, undefined)
      this.logger?.warn(`[图片描述] 失败: ${error?.message ?? error}`)
      return ''
    } finally {
      clearTimeout(timer)
    }
  }

  #lookup(key) {
    const entry = this.cache.get(key)
    if (!entry) return undefined
    const ttl = entry.failed ? FAIL_TTL_MS : this.ttlMs
    if (Date.now() - entry.at > ttl) {
      this.cache.delete(key)
      return undefined
    }
    this.cache.delete(key)
    this.cache.set(key, entry) // 命中刷新到队尾
    return entry
  }

  #store(key, text) {
    const value = String(text ?? '')
    this.cache.delete(key)
    this.cache.set(key, { text: value, at: Date.now(), failed: !value })
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  /** 排障/自检用一行摘要。 */
  describe() {
    return (
      `描述 ${this.stats.calls} 次（失败 ${this.stats.errors}，跳过 ${this.stats.skipped}，` +
      `取不到图 ${this.stats.noBytes}），复用 ${this.stats.reused} 次；` +
      `缓存 ${this.cache.size} 项`
    )
  }

  stop() {
    this.cache.clear()
  }
}
