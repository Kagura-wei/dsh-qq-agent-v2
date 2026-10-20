/**
 * 消息存档：每个会话一份 JSON，带已读/未读标记。
 *
 * 存档是"无状态运行"的另一半——Agent 每次运行都是新会话，
 * 连续性完全靠这里的已读历史重建，所以写入必须先于触发判定。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const MAX_ENTRIES = 500 // 每会话保留上限，防止磁盘无限增长
const FLUSH_DELAY_MS = 500

/**
 * 内联图片（base64://）单条保留上限。
 *
 * 存档是要长期留在磁盘上的，绝不能把几 MB 的 base64 原样写进去 ——
 * 500 条上限乘以图片体积，很容易把盘写满。超过这个大小就只留类型标记，
 * 取图时自然降级成 `[图片]` 占位。
 */
const MAX_INLINE_IMAGE_CHARS = 512 * 1024

export function sessionKeyOf(scene, peerId) {
  return `${scene}:${peerId}`
}

/**
 * 裁剪消息段后存档。
 *
 * 图片段是重点：只保留"还能取到图"所需的最少字段 ——
 *   - http(s) url：轻量，始终保留（这是 NapCat 最常见的形态）
 *   - base64 内联：小图保留，大图丢弃
 *   - 两者都没有：只留一个 image 标记，让下游知道"这里本来有张图"
 * 其余段只留类型与必要数据，避免把 OneBot 的原始字段整包写进磁盘。
 */
export function trimSegments(segments) {
  if (!Array.isArray(segments) || !segments.length) return undefined
  const out = []
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue
    if (seg.type === 'image') {
      const data = seg.data ?? {}
      const url = typeof data.url === 'string' ? data.url : ''
      const file = typeof data.file === 'string' ? data.file : ''
      const keepUrl = /^https?:\/\//i.test(url)
      const keepInline = file.startsWith('base64://') && file.length <= MAX_INLINE_IMAGE_CHARS
      out.push({
        type: 'image',
        data: { ...(keepUrl ? { url } : {}), ...(keepInline ? { file } : {}) },
      })
      continue
    }
    if (seg.type === 'text') {
      out.push({ type: 'text', data: { text: String(seg.data?.text ?? '') } })
      continue
    }
    if (seg.type === 'at') {
      out.push({ type: 'at', data: { qq: seg.data?.qq } })
      continue
    }
    out.push({ type: seg.type, data: {} })
  }
  return out.length ? out : undefined
}

export class Archive {
  constructor({ dir, logger }) {
    this.dir = dir
    this.logger = logger
    this.cache = new Map() // key -> { messages: [], dirty: boolean }
    this.flushTimer = null
    this.ready = false
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true })
    this.ready = true
    this.logger.info(`存档目录已就绪: ${this.dir}`)
  }

  #fileOf(key) {
    return path.join(this.dir, `${key.replace(':', '-')}.json`)
  }

  async #load(key) {
    if (this.cache.has(key)) return this.cache.get(key)
    let doc = { messages: [] }
    try {
      const raw = await fs.readFile(this.#fileOf(key), 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed?.messages)) doc = parsed
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger.warn(`读存档失败 ${key}: ${error?.message ?? error}`)
      }
    }
    this.cache.set(key, doc)
    return doc
  }

  /**
   * 写入一条消息并标记为未读。
   * @returns {Promise<object>} 落库后的条目（含自增 seq）
   */
  async append(key, msg) {
    const doc = await this.#load(key)
    const entry = {
      seq: (doc.messages.at(-1)?.seq ?? 0) + 1,
      time: msg.time ?? Math.floor(Date.now() / 1000),
      senderId: msg.senderId,
      senderName: msg.senderName ?? '',
      // 记住 OneBot 的消息号：靠它才能指出"这一批里哪条才是要回应的"
      messageId: msg.messageId ?? 0,
      text: msg.text ?? '',
      hasImage: msg.hasImage ?? false,
      read: false,
    }
    // 段信息必须留：图片能不能进模型，全靠下游还能看到 image 段。
    // 少了它，整条消息只剩 "[图片]" 这行字 —— 模型就"只看到图片的框"。
    const segments = trimSegments(msg.segments)
    if (segments) entry.segments = segments
    doc.messages.push(entry)
    if (doc.messages.length > MAX_ENTRIES) {
      doc.messages.splice(0, doc.messages.length - MAX_ENTRIES)
    }
    this.#scheduleFlush(key)
    return entry
  }

  /** 取最近 limit 条未读（按时间正序，便于直接喂给模型）。 */
  async getUnread(key, limit = 20) {
    const doc = await this.#load(key)
    return doc.messages.filter((m) => !m.read).slice(-limit)
  }

  /** 取最近 limit 条（不论已读），用于构造上下文。 */
  async getRecent(key, limit = 20) {
    const doc = await this.#load(key)
    return doc.messages.slice(-limit)
  }

  /**
   * 同步读内存缓存里的最近若干条。
   *
   * systemPrompt 的上下文回调必须是同步的（签名返回 string，不能 await 读盘），
   * 所以只从缓存取。调用方需保证该 key 已加载过 —— append() 之后它一定在缓存里。
   */
  getRecentCached(key, limit = 30) {
    const doc = this.cache.get(key)
    if (!doc) return []
    const n = Math.max(0, Math.floor(limit))
    return n === 0 ? [] : doc.messages.slice(-n)
  }

  /** 丢弃某个会话的缓存（会话回收时用，避免 Map 无限增长）。 */
  dropCache(key) {
    this.cache.delete(key)
  }

  async markRead(key, seqs) {
    const doc = await this.#load(key)
    const set = new Set(seqs)
    let changed = false
    for (const m of doc.messages) {
      if (set.has(m.seq) && !m.read) {
        m.read = true
        changed = true
      }
    }
    if (changed) this.#scheduleFlush(key)
    return changed
  }

  async markAllRead(key) {
    const doc = await this.#load(key)
    let changed = false
    for (const m of doc.messages) {
      if (!m.read) {
        m.read = true
        changed = true
      }
    }
    if (changed) this.#scheduleFlush(key)
    return changed
  }

  #scheduleFlush(key) {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushAll().catch((error) => {
        this.logger.error(`存档落盘失败: ${error?.message ?? error}`)
      })
    }, FLUSH_DELAY_MS)
    this.flushTimer.unref?.()
  }

  async flushAll() {
    for (const [key, doc] of this.cache) {
      try {
        await fs.writeFile(this.#fileOf(key), JSON.stringify(doc), 'utf8')
      } catch (error) {
        this.logger.error(`写存档失败 ${key}: ${error?.message ?? error}`)
      }
    }
  }

  async stop() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    await this.flushAll()
    this.cache.clear()
  }
}
