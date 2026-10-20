/**
 * OneBot 图片段 → DSH 可存储的图片附件。
 *
 * DSH 的模型输入里，图片是 `{ type: 'image', attachment: ImageAttachmentRef }`，
 * 而 ref 必须由 AttachmentStore 落盘后签发（`saveImage`）。所以外部图片要先进
 * store。这里负责"把 OneBot 给的东西变成字节"这一步。
 *
 * 各家 OneBot 实现给的字段不统一，按可靠性依次尝试：
 *   1. data.url（http/https）—— 最通用，fetch 下来
 *   2. data.file = base64://... —— 直接解码，不依赖网络
 *   3. data.file 是本地绝对路径 / file:// —— 读文件（仅当 NapCat 与宿主同机）
 * 全部失败就返回 undefined，由调用方退回 "[图片]" 文字占位 ——
 * 宁可模型看不到图，也不能让整条消息失败。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

/** 单张图的下载超时。群聊里图片来自不可控来源，不能让它拖住整轮。 */
const FETCH_TIMEOUT_MS = 15_000

/** 单张图字节上限，与 DSH 默认的 maxImageBytes 对齐（20MiB）。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/**
 * 宿主的**准入**限制（`dsh-attachment-local` 的默认值）。
 *
 * `saveImage()` 在解码之前先量尺寸，超过就直接抛
 * `Image exceeds the configured per-side pixel limit.` —— **整张图丢掉**，
 * 调用方只能在提示词里留个 `[图片]` 占位。群里发的长截图（长边轻松过万）
 * 必然撞上这条：模型看到的是"这儿有张图，但我读不到"。
 */
const HOST_MAX_SIDE = 8192
const HOST_MAX_PIXELS = 64_000_000

/**
 * 宿主**原样存储**的额度（`normalizedImageMaxPixels` 默认 2048×2048）。
 * 切片按它来切最划算：每段都能被原样存下，不会被宿主二次重编码。
 */
const STORE_MAX_PIXELS = 2048 * 2048

/** 默认最多把一张长图切成几段（再多会把一轮的图片配额和 token 一起吃光）。 */
const DEFAULT_MAX_PARTS = 4

/**
 * 按字节魔数识别媒体类型。
 *
 * 比扩展名可靠：QQ 转发/压缩过的图经常顶着 .image 之类的怪名字，
 * 而 DSH 的 saveImage 会拿声明类型去核对真实解码结果，声明错了会被拒。
 */
export function sniffMediaType(bytes) {
  if (!bytes || bytes.length < 4) return undefined
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  // GIF: "GIF8"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif'
  }
  // WebP: "RIFF" .... "WEBP"（这一种必须看到第 12 字节）
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return undefined
}

/** 从文件名猜媒体类型，作为魔数识别失败时的兜底。 */
function mediaTypeFromName(name) {
  const ext = String(name ?? '')
    .toLowerCase()
    .split('.')
    .pop()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return undefined
}

/** 带超时的 fetch，返回 Uint8Array 或 undefined。 */
async function fetchBytes(url, { fetchImpl, logger }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) {
      logger?.warn(`图片下载失败 HTTP ${res.status}: ${url.slice(0, 120)}`)
      return undefined
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.length > MAX_IMAGE_BYTES) {
      logger?.warn(`图片超过 ${MAX_IMAGE_BYTES} 字节，跳过: ${buf.length}`)
      return undefined
    }
    return buf
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${FETCH_TIMEOUT_MS}ms` : (error?.message ?? error)
    logger?.warn(`图片下载异常: ${reason}`)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** 解码 base64://... 形式的图片。 */
function decodeBase64(file) {
  const raw = String(file).slice('base64://'.length)
  try {
    return new Uint8Array(Buffer.from(raw, 'base64'))
  } catch {
    return undefined
  }
}

/** 读本地文件（file:// 或绝对路径）。 */
async function readLocal(file, logger) {
  try {
    const path = String(file).startsWith('file://') ? fileURLToPath(file) : String(file)
    // 只接受绝对路径：相对路径在 NapCat 容器里没有意义
    if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) return undefined
    const buf = await readFile(path)
    if (buf.length > MAX_IMAGE_BYTES) return undefined
    return new Uint8Array(buf)
  } catch (error) {
    logger?.warn(`读取本地图片失败: ${error?.message ?? error}`)
    return undefined
  }
}

/**
 * 诊断用：把 image 段的字段摘要成一行（不打印大段数据）。
 *
 * 真机上 NapCat 到底给的是 http url 还是 base64、地址是不是容器内网段，
 * 靠它一眼看出 —— 图片取不到时这是第一个要看的东西。
 */
export function describeImageSegments(segments) {
  return (segments ?? [])
    .filter((s) => s?.type === 'image')
    .map((seg) => {
      const data = seg.data ?? {}
      const url = typeof data.url === 'string' ? data.url : ''
      const file = typeof data.file === 'string' ? data.file : ''
      const bits = [`url=${url ? url.slice(0, 110) : '(空)'}`]
      if (file) {
        bits.push(
          file.startsWith('base64://')
            ? `file=base64(${file.length}字符)`
            : `file=${file.slice(0, 70)}`
        )
      }
      if (data.file_size) bits.push(`size=${data.file_size}`)
      return bits.join(' ')
    })
    .join(' | ')
}

/**
 * 把 OneBot 的 image 段转成 `SaveImageAttachment`。
 *
 * @param {object} segment OneBot 消息段（type 应为 'image'）
 * @param {{logger?: object, fetchImpl?: Function}} deps
 * @returns {Promise<{data: Uint8Array, mediaType: string, name?: string}|undefined>}
 *   undefined 表示拿不到图片，调用方应退回文字占位
 */
export async function toImageAttachment(segment, deps = {}) {
  const { logger, fetchImpl = globalThis.fetch } = deps
  const data = segment?.data ?? {}

  let bytes
  const url = typeof data.url === 'string' ? data.url : ''
  const file = typeof data.file === 'string' ? data.file : ''

  if (/^https?:\/\//i.test(url)) {
    bytes = await fetchBytes(url, { fetchImpl, logger })
  } else if (file.startsWith('base64://')) {
    bytes = decodeBase64(file)
  } else if (file) {
    bytes = await readLocal(file, logger)
  }
  // url 有时是空的（部分实现只在 file 里给 base64），所以再兜一次
  if (!bytes && file && !file.startsWith('base64://')) {
    bytes = await readLocal(file, logger)
  }

  if (!bytes || bytes.length === 0) return undefined
  if (bytes.length > MAX_IMAGE_BYTES) {
    logger?.warn(`图片过大已跳过: ${bytes.length} 字节`)
    return undefined
  }

  const mediaType = sniffMediaType(bytes) ?? mediaTypeFromName(data.file) ?? 'image/jpeg'
  const name = mediaTypeFromName(data.file) ? String(data.file).split('/').pop() : undefined
  return { data: bytes, mediaType, ...(name ? { name } : {}) }
}

/**
 * 规划长图该怎么切。
 *
 * 纯函数，便于单测。返回 undefined 表示"不用动"。
 *
 * ⚠️ 触发条件只看宿主的**准入**上限（单边 8192 / 64M 像素）—— 那才让整张图被拒收。
 * 只是超过"原样存储"额度（4M 像素）的图不该切：宿主会自己把它缩到 4M 存下，
 * 切成两段只会白花一倍的图片 token。**每段切多长**才去对齐 4M 那个额度。
 *
 * 切法：沿着**长边**切。宽度保持原样很关键 —— 长截图缩一缩文字就糊了，
 * 只有原分辨率才有 OCR 价值。
 *
 * @param {number} width
 * @param {number} height
 * @param {{hardSide?: number, hardPixels?: number, maxPixels?: number, maxParts?: number}} [options]
 * @returns {{vertical: boolean, parts: number, sliceLen: number, width: number, height: number}|undefined}
 */
export function planSlices(width, height, options = {}) {
  const hardSide = options.hardSide ?? HOST_MAX_SIDE
  const hardPixels = options.hardPixels ?? HOST_MAX_PIXELS
  const maxPixels = options.maxPixels ?? STORE_MAX_PIXELS
  const maxParts = Math.max(1, options.maxParts ?? DEFAULT_MAX_PARTS)

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  // 本来就能过审 → 原样送，不动它（这条必须排在最前：绝大多数图走这里）
  if (Math.max(width, height) <= hardSide && width * height <= hardPixels) return undefined

  const longSide = Math.max(width, height)
  const shortSide = Math.min(width, height)
  // 一段最多能有多长：单边不超限，像素也不超"原样存储"额度
  const ideal = Math.max(1, Math.min(hardSide, Math.floor(maxPixels / shortSide)))
  const parts = Math.min(Math.max(Math.ceil(longSide / ideal), 1), maxParts)
  return {
    vertical: height >= width,
    parts,
    sliceLen: Math.ceil(longSide / parts),
    width,
    height,
  }
}

/**
 * 懒加载宿主自带的 sharp。
 *
 * 插件自身不装依赖（`node_modules` 里只有 cosmokit/schemastery/ws），但 DSH 自己的
 * `node_modules` 里有 sharp —— 直接顺着绝对路径解析，省掉一份原生依赖。
 * 找不到就返回 null，整条链路退回"原样送一张"，绝不因此让消息失败。
 */
let sharpPromise
async function loadSharp(logger) {
  if (!sharpPromise) {
    sharpPromise = (async () => {
      const req = createRequire(import.meta.url)
      const dirs = [
        ...(process.env.DSH_QQ_SHARP_DIR ? [process.env.DSH_QQ_SHARP_DIR] : []),
        '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules',
        '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules',
      ]
      for (const dir of dirs) {
        try {
          const resolved = req.resolve('sharp', { paths: [dir] })
          const mod = await import(pathToFileURL(resolved).href)
          return mod?.default ?? mod
        } catch {
          // 换下一个候选目录（不同安装方式路径不一样）
        }
      }
      try {
        const mod = await import('sharp') // 插件目录自己装了依赖时走这条
        return mod?.default ?? mod
      } catch {
        logger?.warn('[长图] 找不到可用的 sharp，超过宿主尺寸上限的图只能降级成 [图片] 占位')
        return null
      }
    })()
  }
  return sharpPromise
}

/**
 * 把一张超限的图切成若干段。
 *
 * 每段都保证落在宿主的**准入**限制内；正常切法下还会落在"原样存储"额度内
 * （只有"段数被 maxParts 卡住"时才需要顺手缩一下，那条路的结果本来也只是聊胜于无）。
 */
async function sliceImage(att, plan, sharpFn, logger) {
  const out = []
  const stem = String(att.name ?? 'image').replace(/\.[a-z0-9]+$/i, '') || 'image'
  for (let i = 0; i < plan.parts; i++) {
    const offset = i * plan.sliceLen
    const len = Math.min(plan.sliceLen, (plan.vertical ? plan.height : plan.width) - offset)
    if (len <= 0) break
    const region = plan.vertical
      ? { left: 0, top: offset, width: plan.width, height: len }
      : { left: offset, top: 0, width: len, height: plan.height }
    try {
      let pipeline = sharpFn(att.data, { limitInputPixels: false })
        .extract(region)
        // PNG 透明底转 JPEG 会变黑，先压到白底上
        .flatten({ background: '#ffffff' })
      const scale = Math.min(
        1,
        HOST_MAX_SIDE / Math.max(region.width, region.height),
        Math.sqrt(HOST_MAX_PIXELS / (region.width * region.height))
      )
      if (scale < 1) {
        pipeline = pipeline.resize(
          Math.max(1, Math.round(region.width * scale)),
          Math.max(1, Math.round(region.height * scale)),
          { fit: 'inside' }
        )
      }
      const data = new Uint8Array(await pipeline.jpeg({ quality: 88 }).toBuffer())
      out.push({ data, mediaType: 'image/jpeg', name: `${stem}-${i + 1}.jpg` })
    } catch (error) {
      logger?.warn(`长图切片失败（第 ${i + 1}/${plan.parts} 段）: ${error?.message ?? error}`)
      return undefined
    }
  }
  return out.length ? out : undefined
}

/**
 * 把 OneBot 的 image 段转成**一组**可存储的附件。
 *
 * 普通图就是 1 个（与 `toImageAttachment` 完全一致）；长截图会被切成 2–N 段，
 * 让模型的图片通道真正读到内容 —— 否则长边一过 8192 就被宿主整张拒收。
 *
 * @param {object} segment OneBot 消息段
 * @param {{logger?: object, fetchImpl?: Function, maxParts?: number, sharp?: object}} deps
 *   maxParts: 最多切几段。0 = 关闭切片（超限的图按老样子降级占位）；
 *             1 = 不切，只把整张图缩到能过审；>1 = 最多切这么多段。
 *   sharp: 仅单测注入，正常路径用宿主自带的那份。
 * @returns {Promise<Array<{data: Uint8Array, mediaType: string, name?: string}>>}
 *   空数组表示拿不到图片，调用方应退回 `[图片]` 占位
 */
export async function toImageAttachments(segment, deps = {}) {
  const { logger } = deps
  const base = await toImageAttachment(segment, deps)
  if (!base) return []

  const maxParts = deps.maxParts === undefined ? DEFAULT_MAX_PARTS : Number(deps.maxParts)
  if (!Number.isFinite(maxParts) || maxParts <= 0) return [base]

  const sharpFn = deps.sharp ?? (await loadSharp(logger))
  if (!sharpFn) {
    logger?.warn('图片可能超过宿主尺寸上限，但没有可用的 sharp，只能原样送（多半会被拒）')
    return [base]
  }

  let meta
  try {
    meta = await sharpFn(base.data, { limitInputPixels: false }).metadata()
  } catch (error) {
    // 宿主认得的格式 sharp 未必都认（GIF 动画等）：量不出来就原样送，交给宿主自己处理
    logger?.warn(`图片尺寸探测失败，原样送: ${error?.message ?? error}`)
    return [base]
  }

  const plan = planSlices(meta.width, meta.height, { maxParts })
  if (!plan) return [base]

  const parts = await sliceImage(base, plan, sharpFn, logger)
  if (!parts) return [base]
  logger?.info(
    `[长图] ${meta.width}×${meta.height} 超出宿主单边上限，切为 ${parts.length} 段` +
      `（每段最长 ${plan.sliceLen}px，宽度保持）`
  )
  return parts
}
