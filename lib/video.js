/**
 * 视频段 → 若干张关键帧图片。
 *
 * 模型的输入通道只有 text / image，没有视频。所以群里发来一段视频时，
 * 要么告诉模型「这儿有个视频」（占位符），要么抽几帧让它真看见 ——
 * 后者才是"能总结一下这段视频"的前提。
 *
 * 做法：下载（限额、限时）→ ffprobe 读时长与分辨率 → 在 1/(n+1)、2/(n+1)…
 * 位置各抽一帧 → 缩到 ≤1024 宽后交给调用方当图片存。全部失败就返回空数组，
 * 由调用方退回 `[视频]` 占位，绝不让整条消息失败。
 *
 * 边界：
 *   - 视频地址和图片一样是 rkey 签名地址，几分钟就失效 → 必须在收到消息那一刻下（见 prefetch.js）
 *   - 文件可能几十 MB，默认上限 30MB，先看 content-length 再流式累加，两边都守
 *   - 宿主机不一定有 ffmpeg（容器里就没有），找不到就静默降级
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 视频下载超时。比图片宽松些：几十 MB 在 NAS 上也要几秒。 */
const FETCH_TIMEOUT_MS = 30_000

/** 单段视频字节上限（默认 30MB）。超过直接放弃抽帧。 */
const MAX_VIDEO_BYTES = 30 * 1024 * 1024

/** 抽帧后缩到的最大宽度。再大只是白花图片 token，视频帧本来就不清晰。 */
const FRAME_MAX_WIDTH = 1024

/** 单次 ffmpeg/ffprobe 调用的超时。 */
const FFMPEG_TIMEOUT_MS = 20_000

/** ffmpeg/ffprobe 的查找顺序，环境变量优先（容器或非标准安装时用得上）。 */
function ffmpegBin(name) {
  const env = process.env[name === 'ffmpeg' ? 'DSH_QQ_FFMPEG' : 'DSH_QQ_FFPROBE']
  return [env, `/usr/bin/${name}`, `/usr/local/bin/${name}`, name].filter(Boolean)
}

/**
 * 规划抽帧时间点（纯函数，便于单测）。
 *
 * 不取第 0 秒：视频开头常是黑场/片头，抽出来等于没抽。默认把时长等分成
 * count+1 份，取第 1..count 个分点（2 帧 → 1/3、2/3 处）。
 *
 * @param {number} duration 秒
 * @param {number} count 抽几帧
 * @returns {number[]} 时间点（升序、去重）
 */
export function planFrameTimes(duration, count = 2) {
  const n = Math.max(1, Math.min(6, Math.floor(Number(count) || 1)))
  const d = Number(duration)
  // 时长拿不到（ffprobe 失败 / 流式视频）：只抽第一帧，聊胜于无
  if (!Number.isFinite(d) || d <= 0) return [0]

  const out = []
  for (let i = 1; i <= n; i++) {
    const t = (d * i) / (n + 1)
    // 别贴着末尾抽，最后 0.1 秒常常已经黑屏
    const clamped = Math.max(0, Math.min(t, Math.max(0, d - 0.1)))
    out.push(Number(clamped.toFixed(2)))
  }
  return [...new Set(out)]
}

/** 带字节上限的下载。先看 content-length，再流式累加兜住谎报的情况。 */
async function fetchCapped(url, { fetchImpl, maxBytes, logger }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) {
      logger?.warn(`视频下载失败 HTTP ${res.status}`)
      return undefined
    }
    const declared = Number(res.headers?.get?.('content-length') ?? 0)
    if (declared > maxBytes) {
      logger?.warn(`视频声明大小 ${Math.round(declared / 1024)}KB 超过上限 ${Math.round(maxBytes / 1024)}KB，跳过抽帧`)
      return undefined
    }

    if (!res.body || typeof res.body[Symbol.asyncIterator] !== 'function') {
      const buf = new Uint8Array(await res.arrayBuffer())
      if (buf.length > maxBytes) {
        logger?.warn(`视频超过上限 ${Math.round(maxBytes / 1024)}KB，跳过抽帧`)
        return undefined
      }
      return buf
    }

    const chunks = []
    let total = 0
    for await (const chunk of res.body) {
      total += chunk.length
      if (total > maxBytes) {
        controller.abort()
        logger?.warn(`视频超过上限 ${Math.round(maxBytes / 1024)}KB，已中断下载`)
        return undefined
      }
      chunks.push(chunk)
    }
    return chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${FETCH_TIMEOUT_MS}ms` : (error?.message ?? error)
    logger?.warn(`视频下载异常: ${reason}`)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** 依次尝试候选可执行文件，返回第一个能跑起来的路径。 */
async function resolveBin(candidates, args = ['-version']) {
  for (const bin of candidates) {
    try {
      await run(bin, args, { timeout: FFMPEG_TIMEOUT_MS })
      return bin
    } catch {
      // 换下一个候选
    }
  }
  return undefined
}

let ffmpegReady // { ffmpeg?, ffprobe? } —— 探测一次就够，整个进程复用

/** 探测 ffmpeg/ffprobe（失败信息只打一次，避免每条视频刷日志）。 */
async function detectFfmpeg(logger) {
  if (ffmpegReady) return ffmpegReady
  const ffmpeg = await resolveBin(ffmpegBin('ffmpeg'))
  const ffprobe = await resolveBin(ffmpegBin('ffprobe'))
  ffmpegReady = { ffmpeg, ffprobe }
  if (!ffmpeg) logger?.warn('[视频] 没找到 ffmpeg，视频只能显示 [视频] 占位（装一个或用 DSH_QQ_FFMPEG 指定路径）')
  else logger?.info(`[视频] 抽帧可用：${ffmpeg}${ffprobe ? '' : '（缺 ffprobe，只能抽第一帧）'}`)
  return ffmpegReady
}

/** 读时长与分辨率。 */
async function probe(file, ffprobe) {
  if (!ffprobe) return {}
  try {
    const { stdout } = await run(
      ffprobe,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,duration',
        '-show_entries', 'format=duration',
        '-of', 'json',
        file,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    )
    const doc = JSON.parse(stdout || '{}')
    const stream = doc?.streams?.[0] ?? {}
    const duration = Number(stream.duration ?? doc?.format?.duration ?? 0)
    return {
      duration: Number.isFinite(duration) ? duration : 0,
      width: Number(stream.width ?? 0) || 0,
      height: Number(stream.height ?? 0) || 0,
    }
  } catch (error) {
    return { probeError: error?.message ?? String(error) }
  }
}

/** 计算缩放后的尺寸；宽度不变时不缩放。 */
export function scaleFrame(width, height, maxWidth = FRAME_MAX_WIDTH) {
  if (!(width > 0) || !(height > 0)) return undefined
  if (width <= maxWidth) return { width, height }
  const w = maxWidth
  // yuv420 要求偶数边长
  const h = Math.max(2, Math.round((height * w) / width / 2) * 2)
  return { width: w, height: h }
}

/**
 * 视频段 → 关键帧图片附件。
 *
 * @param {object} segment OneBot video 段
 * @param {{logger?: object, fetchImpl?: Function, maxBytes?: number, frames?: number,
 *   timeoutMs?: number}} deps
 * @returns {Promise<Array<{data: Uint8Array, mediaType: string, name?: string}>>}
 *   空数组表示拿不到，调用方退回 `[视频]` 占位
 */
export async function toVideoFrames(segment, deps = {}) {
  const { logger, fetchImpl = globalThis.fetch } = deps
  const data = segment?.data ?? {}
  const maxBytes = Number(deps.maxBytes) > 0 ? Number(deps.maxBytes) : MAX_VIDEO_BYTES
  const frameCount = Math.max(1, Math.min(6, Math.floor(Number(deps.frames) || 2)))

  // NapCat 会带 file_size，先按它挡一次，省掉整段下载
  const declared = Number(data.file_size)
  if (Number.isFinite(declared) && declared > maxBytes) {
    logger?.warn(`视频 ${Math.round(declared / 1024)}KB 超过上限，跳过抽帧`)
    return []
  }

  const url = typeof data.url === 'string' ? data.url : ''
  if (!/^https?:\/\//i.test(url)) {
    // 没有可下载地址（只有文件名）—— 抽帧无从谈起
    return []
  }

  const { ffmpeg, ffprobe } = await detectFfmpeg(logger)
  if (!ffmpeg) return []

  const bytes = await fetchCapped(url, { fetchImpl, maxBytes, logger })
  if (!bytes?.length) return []

  let dir
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-qq-video-'))
    const src = path.join(dir, 'in.mp4')
    await writeFile(src, bytes)

    const meta = await probe(src, ffprobe)
    if (meta.probeError) logger?.warn(`[视频] ffprobe 失败: ${meta.probeError}`)
    const times = planFrameTimes(meta.duration, frameCount)
    const size = scaleFrame(meta.width, meta.height)

    const frames = []
    for (let i = 0; i < times.length; i++) {
      const out = path.join(dir, `frame-${i}.jpg`)
      const args = ['-v', 'error', '-ss', String(times[i]), '-i', src, '-frames:v', '1']
      if (size) args.push('-vf', `scale=${size.width}:${size.height}`)
      args.push('-q:v', '4', '-y', out)
      try {
        await run(ffmpeg, args, { timeout: deps.timeoutMs ?? FFMPEG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 })
        const buf = await readFile(out)
        if (!buf.length) continue
        frames.push({
          data: new Uint8Array(buf),
          mediaType: 'image/jpeg',
          name: `video-frame-${i + 1}.jpg`,
        })
      } catch (error) {
        logger?.warn(`[视频] 抽帧失败（第 ${i + 1}/${times.length} 帧，t=${times[i]}s）: ${error?.message ?? error}`)
      }
    }
    if (!frames.length) logger?.warn('[视频] 一帧也没抽出来')
    return frames
  } catch (error) {
    logger?.warn(`[视频] 抽帧异常: ${error?.message ?? error}`)
    return []
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 排障用：视频段的字段摘要。 */
export function describeVideoSegments(segments) {
  return (segments ?? [])
    .filter((s) => s?.type === 'video')
    .map((seg) => {
      const data = seg.data ?? {}
      const bits = [`url=${data.url ? String(data.url).slice(0, 90) : '(空)'}`]
      if (data.file) bits.push(`file=${String(data.file).slice(0, 60)}`)
      if (data.file_size) bits.push(`size=${data.file_size}`)
      return bits.join(' ')
    })
    .join(' | ')
}
