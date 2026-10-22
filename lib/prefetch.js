/**
 * 媒体前置落地（prefetch）：图片 + 视频帧。
 *
 * 为什么要在收到消息的那一刻就把图下载下来 ——
 * QQ 的图片地址是带签名的临时地址（`multimedia.nt.qq.com.cn/download?...&rkey=`），
 * 有效期只有几分钟。走过一段"存档 → 门控 → 聚批 → 装配会话"之后再去下载，
 * 撞上 `retcode:-5503007 download url has expired` 是常态，模型就只能看到
 * `[图片]` 占位符。
 *
 * 视频更极端：地址同样是 rkey 签名、体积几十 MB、还要跑 ffmpeg 抽帧，
 * 拖到装配时再做基本等于必然失败。所以这里一并缓存。
 *
 * 所以在消息进入处理链路的最前面（append 存档的同时）就把字节抓下来，
 * 放进一个带 TTL 与字节上限的小缓存；真正组装模型输入时直接取，不再走网络。
 *
 * 三个必须守住的边界：
 *   - **不阻塞消息链路**：warm() 只登记 Promise，绝不 await。
 *   - **不无界增长**：TTL 30 分钟 + 总字节上限，按插入顺序 LRU 淘汰。
 *   - **失败也要记住**：负结果短 TTL 缓存。否则每次装配都会重试一次
 *     15 秒超时的下载，把整轮回复拖死。
 */
import { toImageAttachments } from './image.js'
import { toVideoFrames } from './video.js'

/** 成功结果的存活时间：够覆盖"聚批 + 排队 + 装配"。 */
const DEFAULT_TTL_MS = 30 * 60_000
/** 失败结果的存活时间：短一些，给网络抖动留一次机会。 */
const FAIL_TTL_MS = 2 * 60_000
/** 缓存总字节上限。图片单张可达数 MB，必须有硬上限。 */
const DEFAULT_MAX_BYTES = 48 * 1024 * 1024
/** 缓存条目数上限（防止大量极小的图把 Map 撑爆）。 */
const DEFAULT_MAX_ENTRIES = 200

/** FNV-1a，把超长的 base64 串折成一个短 key（不入 Map 键本身）。 */
function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/**
 * 图片段的缓存键。
 *
 * 必须对"原始段"和"存档裁剪后的段"算出同一个值 ——
 * 存档只保 url（或小体积的 base64 file），所以键也只看这两处。
 */
export function imageKeyOf(segment) {
  const data = segment?.data ?? {}
  const url = typeof data.url === 'string' ? data.url : ''
  if (/^https?:\/\//i.test(url)) return `u:${url}`
  const file = typeof data.file === 'string' ? data.file : ''
  if (file.startsWith('base64://')) return `b:${file.length}:${fnv1a(file)}`
  if (file) return `f:${file}`
  return ''
}

/**
 * 媒体段的缓存键：图片与视频分开命名空间。
 *
 * 不能只按 url 区分 —— 一张图和一个视频可能挂着同一个 CDN 路径形态，
 * 而两者的处理方式（一张原图 vs 一组抽帧）完全不同。
 */
export function mediaKeyOf(segment) {
  const key = imageKeyOf(segment)
  if (!key) return ''
  return segment?.type === 'video' ? `v:${key}` : `i:${key}`
}

export class ImagePrefetcher {
  constructor({ logger, ttlMs, failTtlMs, maxBytes, maxEntries, fetchImpl, getConfig } = {}) {
    this.logger = logger
    this.getConfig = getConfig
    this.ttlMs = Number.isFinite(ttlMs) ? ttlMs : DEFAULT_TTL_MS
    this.failTtlMs = Number.isFinite(failTtlMs) ? failTtlMs : FAIL_TTL_MS
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_MAX_ENTRIES
    this.fetchImpl = fetchImpl
    /** key -> { atts?, at, bytes, failed }（atts 是数组：长截图与视频帧都是多张） */
    this.cache = new Map()
    /** key -> Promise<atts>，同一个媒体只处理一次 */
    this.pending = new Map()
    this.bytes = 0
    this.stats = { warmed: 0, hit: 0, miss: 0, failed: 0, videos: 0, videoFrames: 0 }
  }

  /**
   * 收到消息时调用：把这条消息里的图片/视频全部预热。
   * **不返回 Promise，不 await** —— 消息链路不能被下载拖住。
   *
   * @param {Array} segments
   * @param {{images?: boolean, video?: boolean}} [options]
   *   默认两个都开；调用方按 imageEnabled / videoEnabled 传，避免关了还去下载。
   */
  warm(segments, options = {}) {
    const wantImage = options.images !== false
    const wantVideo = options.video !== false
    for (const segment of segments ?? []) {
      const type = segment?.type
      if (type !== 'image' && type !== 'video') continue
      if (type === 'image' && !wantImage) continue
      if (type === 'video' && !wantVideo) continue
      const key = mediaKeyOf(segment)
      if (!key || this.cache.has(key) || this.pending.has(key)) continue
      this.stats.warmed++
      if (type === 'video') this.stats.videos++
      const task = this.#load(segment, key)
      this.pending.set(key, task)
      // 失败在 #load 内部消化，这里只保证不会有未处理的 rejection
      task.catch(() => {})
    }
  }

  async #load(segment, key) {
    let atts
    try {
      const cfg = this.getConfig?.() ?? {}
      if (segment?.type === 'video') {
        atts = await toVideoFrames(segment, {
          logger: this.logger,
          fetchImpl: this.fetchImpl,
          maxBytes: Number(cfg.videoMaxBytes) > 0 ? Number(cfg.videoMaxBytes) * 1024 * 1024 : undefined,
          frames: cfg.videoFrameCount,
          timeoutMs: cfg.videoTimeoutMs,
        })
        if (atts?.length) this.stats.videoFrames += atts.length
      } else {
        atts = await toImageAttachments(segment, {
          logger: this.logger,
          fetchImpl: this.fetchImpl,
          // 长图切段也在这里做：切片要花 CPU，放在"收到消息"这一刻比放在装配时更从容
          maxParts: cfg.longImageMaxParts,
        })
      }
    } catch (error) {
      this.logger?.warn(`媒体预热异常: ${error?.message ?? error}`)
      atts = undefined
    } finally {
      this.pending.delete(key)
    }
    if (atts?.length) {
      this.#store(key, atts)
    } else {
      this.stats.failed++
      // 负缓存：避免每轮都重试一次注定失败的 15 秒超时下载
      this.#store(key, [])
    }
    return atts ?? []
  }

  #store(key, atts) {
    const bytes = (atts ?? []).reduce((sum, a) => sum + (a?.data?.length ?? 0), 0)
    const prev = this.cache.get(key)
    this.cache.delete(key) // 先删再插 = 移到队尾（最近使用）
    this.cache.set(key, { atts, at: Date.now(), bytes, failed: !atts?.length })
    this.bytes += bytes - (prev?.bytes ?? 0)
    this.#evict()
  }

  #evict() {
    while (this.cache.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      const entry = this.cache.get(oldest)
      this.cache.delete(oldest)
      this.bytes -= entry?.bytes ?? 0
    }
  }

  /**
   * 取一份预热的媒体（图片本体 / 视频抽出的帧）。
   *
   * @returns {Promise<{hit: boolean, atts?: Array}>}
   *   hit=true 表示"这件事我已知晓"：atts 非空就用（长图、视频帧都是好几张），
   *   空数组说明预热失败，调用方应直接降级为占位符，**不要**再自己下一遍。
   *   hit=false 表示没预热过（例如插件刚重启），调用方自行兜底下载。
   */
  async get(segment) {
    const key = mediaKeyOf(segment)
    if (!key) return { hit: false }

    const entry = this.cache.get(key)
    if (entry) {
      const ttl = entry.failed ? this.failTtlMs : this.ttlMs
      if (Date.now() - entry.at <= ttl) {
        this.cache.delete(key)
        this.cache.set(key, entry) // 命中即刷新到队尾
        this.stats.hit++
        return { hit: true, atts: entry.atts ?? [] }
      }
      this.cache.delete(key)
      this.bytes -= entry.bytes ?? 0
    }

    const inflight = this.pending.get(key)
    if (inflight) {
      this.stats.hit++
      return { hit: true, atts: (await inflight) ?? [] }
    }

    this.stats.miss++
    return { hit: false }
  }

  /** 排障用一行摘要。 */
  describe() {
    return (
      `预热 ${this.stats.warmed} 项（视频 ${this.stats.videos}，抽帧 ${this.stats.videoFrames}），` +
      `命中 ${this.stats.hit}，未预热 ${this.stats.miss}，` +
      `失败 ${this.stats.failed}；缓存 ${this.cache.size} 项 / ${Math.round(this.bytes / 1024)}KB`
    )
  }

  clear() {
    this.cache.clear()
    this.bytes = 0
  }
}
