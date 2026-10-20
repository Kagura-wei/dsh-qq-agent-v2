/**
 * 发送层：切分 → 限频 → 拟人节流 → 出站。
 *
 * 限频是硬保护：一旦超限直接丢弃后续分片，宁可少说也不冒刷屏/风控风险。
 *
 * 两条出站形态：
 *   - 普通：逐条发（长文本安全切分，at 段跟着自己那片走）；
 *   - **合并转发**：分片超过阈值时合成一条"聊天记录"发出（见 #tryForward）。
 *
 * 另外这里维护一张**出站消息号登记表**：机器人自己发出去的 message_id 记下来，
 * 门控靠它判断"这条新消息是不是在引用我的话"（见 gate.js 的 detectTrigger）。
 */
import { splitMessage } from './text.js'
import { SENTINEL } from './mention.js'

/** 出站登记表容量。超出按插入顺序淘汰最旧的 —— 只服务于"刚刚那句被引用"。 */
const MAX_TRACKED_IDS = 500

export class Sender {
  constructor({ server, getConfig, logger, getSelfId }) {
    this.server = server
    this.getConfig = getConfig
    this.logger = logger
    /** 机器人自己的 QQ 号，合并转发节点要用它当 uin */
    this.getSelfId = typeof getSelfId === 'function' ? getSelfId : () => 0
    this.buckets = new Map() // key -> { minute: [ts...], hour: [ts...] }
    /** messageId -> key。Map 保持插入顺序，天然是 FIFO 淘汰队列。 */
    this.outbound = new Map()
  }

  /**
   * 发纯文本（不含 @）。
   * @returns {Promise<{ sent: number, dropped: number }>}
   */
  async send(scene, peerId, text, key) {
    return this.sendRich(scene, peerId, text, [], key)
  }

  /**
   * 发一条可能带 @ 的回复。
   *
   * `text` 里的 SENTINEL（见 mention.js）按出现顺序对应 `ats`。
   * 长文本照样切分，at 段跟着它原本所在的那一片走 —— 每个 at 只发一次，
   * 不会因为切分把同一个人 @ 好几遍。
   *
   * @param {string} text 含 SENTINEL 占位的正文
   * @param {Array<{name?: string, qq: number}>} ats 要 @ 的人
   * @returns {Promise<{ sent: number, dropped: number, forwarded?: boolean }>}
   */
  async sendRich(scene, peerId, text, ats = [], key) {
    const cfg = this.getConfig()
    const chunks = splitMessage(String(text ?? ''), cfg.maxMessageLength ?? 1700)
    if (!chunks.length) return { sent: 0, dropped: 0 }

    // 分片多到一定程度，逐条发就是刷屏。合并转发把整段包成一条"聊天记录"，
    // 群里只占一个气泡，展开才看到全文 —— 观感与风控都友好得多。
    if (this.#shouldForward(chunks, cfg)) {
      const forwarded = await this.#tryForward(scene, peerId, chunks, ats, key, cfg)
      if (forwarded) return forwarded
      // 返回 null = 合并转发不可用/失败，继续走逐条发送（消息不能丢）
    }

    let sent = 0
    let dropped = 0
    let cursor = 0 // 已消费的 at 下标：切分保序，顺次取即可

    for (let i = 0; i < chunks.length; i++) {
      if (!this.#allow(key, cfg)) {
        dropped = chunks.length - i
        this.logger.warn(`[限频] ${key} 触发上限，丢弃剩余 ${dropped} 条`)
        break
      }

      const rendered = renderSegments(chunks[i], ats, cursor)
      cursor = rendered.cursor

      try {
        const data = await this.server.send(scene, peerId, rendered.segments)
        this.#rememberSent(key, data)
        sent++
      } catch (error) {
        this.logger.error(`发送失败 ${key}: ${error?.message ?? error}`)
        break // 发送链路异常，不再重试后续分片
      }

      if (i < chunks.length - 1) await sleep(this.#gapFor(chunks[i], cfg))
    }

    return { sent, dropped }
  }

  /**
   * 发一段已经拼好的消息段，不切分。
   *
   * 提醒要 @ 人（at 段 + 文本段），表情包要发 image 段（base64 内联），
   * 纯文本那条路拼不出来。限频额度与 send() 共用同一套桶：这些都不能成为
   * 绕过发送保护的旁路。
   *
   * @param {{timeoutMs?: number}} options 大图 base64 的帧体积大，动作要给足时间
   */
  async sendSegments(scene, peerId, segments, key, { timeoutMs } = {}) {
    const cfg = this.getConfig()
    if (!Array.isArray(segments) || !segments.length) return { sent: 0, dropped: 0 }
    if (!this.#allow(key, cfg)) {
      this.logger.warn(`[限频] ${key} 触发上限，丢弃本条消息段`)
      return { sent: 0, dropped: 1 }
    }
    const data = await this.server.send(scene, peerId, segments, timeoutMs)
    this.#rememberSent(key, data)
    return { sent: 1, dropped: 0 }
  }

  /**
   * 这条消息是不是机器人自己发出去的。
   * 门控用它把"引用我的话"提升到与 @ 同级的触发。
   */
  isBotMessage(messageId) {
    const id = Number(messageId)
    if (!Number.isFinite(id) || id <= 0) return false
    return this.outbound.has(id)
  }

  describe() {
    return `出站登记表 ${this.outbound.size} 条`
  }

  #shouldForward(chunks, cfg) {
    if (cfg.forwardEnabled === false) return false
    if (typeof this.server.sendForward !== 'function') return false
    return chunks.length >= (cfg.forwardMinChunks ?? 3)
  }

  /**
   * 尝试合并转发。
   * @returns {Promise<object|null>} null 表示不可用，调用方回退逐条发送
   */
  async #tryForward(scene, peerId, chunks, ats, key, cfg) {
    if (!this.#allow(key, cfg)) {
      this.logger.warn(`[限频] ${key} 触发上限，丢弃本条合并转发`)
      return { sent: 0, dropped: chunks.length, forwarded: false }
    }

    const nodes = []
    let cursor = 0
    for (const chunk of chunks) {
      const rendered = renderSegments(chunk, ats, cursor)
      cursor = rendered.cursor
      nodes.push({
        type: 'node',
        data: {
          name: String(cfg.botName ?? '').trim() || '机器人',
          uin: String(this.getSelfId() || 0),
          content: rendered.segments,
        },
      })
    }

    try {
      const data = await this.server.sendForward(scene, peerId, nodes)
      this.#rememberSent(key, data)
      this.logger.info(
        `[合并转发] ${key} ${chunks.length} 段合成一条转发消息` +
          (scene === 'group' ? '' : '（私聊）')
      )
      return { sent: 1, dropped: 0, forwarded: true, nodes: nodes.length }
    } catch (error) {
      // 不同 OneBot 实现对转发动作的支持参差不齐（缺 action / uin 为空 /
      // 群权限不足）。失败必须回退，否则这一整段回复会凭空消失。
      this.logger.warn(`[合并转发] ${key} 失败（${error?.message ?? error}），回退为逐条发送`)
      return null
    }
  }

  /** 记住机器人自己发出去的消息号（门控判断"引用我"要用）。 */
  #rememberSent(key, data) {
    const id = Number(data?.message_id ?? data?.messageId ?? 0)
    if (!Number.isFinite(id) || id <= 0) return
    // 先删再插 = 移到队尾，重复消息号不会占两个位置
    this.outbound.delete(id)
    this.outbound.set(id, key)
    while (this.outbound.size > MAX_TRACKED_IDS) {
      const oldest = this.outbound.keys().next().value
      this.outbound.delete(oldest)
    }
  }

  /**
   * 拟人间隔：基础随机区间 + 按字数附加。
   *
   * 字数部分走 **log2 缩放**而不是线性：线性是"50 字多等 1 秒、200 字多等 4 秒"，
   * 长回复动辄等十几秒，机械得像在数数；对数增长让长回复只是"稍微慢一点"，
   * 短回复也不会快到像机器刷屏。
   */
  #gapFor(chunk, cfg) {
    const min = cfg.minGapMs ?? 1000
    const max = Math.max(min, cfg.maxGapMs ?? 3000)
    const length = Array.from(chunk ?? '').length
    const byLength = (cfg.byLengthMs ?? 120) * Math.log2(length + 1)
    return min + Math.random() * (max - min) + byLength
  }

  /** 滑动窗口计数：每分钟 / 每小时各一个窗口。 */
  #allow(key, cfg) {
    const now = Date.now()
    const bucket = this.buckets.get(key) ?? { minute: [], hour: [] }
    bucket.minute = bucket.minute.filter((t) => now - t < 60000)
    bucket.hour = bucket.hour.filter((t) => now - t < 3600000)

    if (bucket.minute.length >= (cfg.maxPerMinute ?? 20)) {
      this.buckets.set(key, bucket)
      return false
    }
    if (bucket.hour.length >= (cfg.maxPerHour ?? 200)) {
      this.buckets.set(key, bucket)
      return false
    }

    bucket.minute.push(now)
    bucket.hour.push(now)
    this.buckets.set(key, bucket)
    return true
  }

  stop() {
    this.buckets.clear()
    this.outbound.clear()
  }
}

/** @ 后紧跟文字会连成一个词（@阿蓝你好），补个空格；中文标点紧跟则不用。 */
const NO_SPACE_AFTER_AT = /^[\s，。！？、；：,.!?;:)\]）】》”’…]/

/**
 * 把一片文本还原成消息段：SENTINEL → at 段，其余 → text 段。
 *
 * at 按出现顺序顺次消费 `ats` —— 切分保序，所以每个 at 只会落在
 * 它原本所属的那一片里，正好只发一次。
 *
 * @returns {{segments: Array, cursor: number}} cursor 为消费后的 at 下标
 */
function renderSegments(chunk, ats, cursor) {
  const parts = String(chunk).split(SENTINEL)
  const segments = []
  let used = cursor
  let pendingAt = false // 刚发过 at，紧跟的文字要补空格

  for (let i = 0; i < parts.length; i++) {
    let text = parts[i]
    if (text) {
      if (pendingAt && !NO_SPACE_AFTER_AT.test(text)) text = ` ${text}`
      pendingAt = false
      segments.push({ type: 'text', data: { text } })
    }
    if (i < parts.length - 1) {
      const at = ats[used]
      if (at && Number.isFinite(Number(at.qq))) {
        segments.push({ type: 'at', data: { qq: String(at.qq) } })
        used++
        pendingAt = true
      }
    }
  }

  // 兜底：切出来的片理论上不会为空，真空了也不能发空段数组
  if (!segments.length) segments.push({ type: 'text', data: { text: String(chunk) } })
  return { segments, cursor: used }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
