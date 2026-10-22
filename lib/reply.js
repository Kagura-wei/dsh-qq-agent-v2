/**
 * 引用消息（reply 段）展开。
 *
 * 线上故障（2026-10-22，群 100000001）：群友引用了一条「转发消息」再 @菲比，
 * 它只回「在，刚被某人勾着魂呢，有啥事」—— 因为 reply 段里只有一个消息号，
 * 被引用的内容从没进过它的视野。
 *
 * reply 段的形态（OneBot v11 标准，各家实现一致）：
 *
 *   { type: 'reply', data: { id: '7456789...' } }
 *
 * 也就是说：**光有段是没有用的，必须拿 id 去把那条消息捞回来**。
 *
 * 两条捞法，优先第二条：
 *   1. `get_msg` —— 一次 OneBot 往返，能拿到机器人自己发过的消息，但依赖
 *      NapCat 实现了这个 action，且取回的内容里图片/视频地址可能已过期。
 *   2. **自己的存档** —— 被引用的消息在引用之前就已经到过，几乎一定在
 *      `qq-archive` 里，而且里面的转发早就展开好了。查内存几乎零成本。
 *
 * 所以先查存档，查不到才调 API。真机上这两条路谁生效，看日志里的
 * `[引用] … 来源=存档|get_msg` 一行即可。
 */
import { segmentToText } from './text.js'

export const REPLY_DEFAULTS = {
  /** 引用内容最多带多少字（转发内容会被 forward 的闸先截到 2000，这里再收一道） */
  maxChars: 1200,
  /** 引用里最多带几张图 —— 不能让一条引用把本轮真正的图片配额吃光 */
  maxImages: 2,
  fetchTimeoutMs: 5000,
}

/** 取 reply 段引用的消息号（`id` 是通用字段，`message_id` 是部分实现的写法）。 */
export function replyIdOf(segment) {
  if (segment?.type !== 'reply') return 0
  const data = segment.data ?? {}
  const id = Number(data.id ?? data.message_id ?? 0)
  return Number.isFinite(id) && id > 0 ? id : 0
}

/** 这串段里有没有可展开的引用。 */
export function hasReply(segments) {
  return (segments ?? []).some((s) => replyIdOf(s) > 0)
}

/** 被引用消息的说话人（存档条目与 get_msg 结果的字段名不一样，这里统一）。 */
function senderNameOf(source) {
  const raw =
    source?.sender?.card ||
    source?.sender?.nickname ||
    source?.senderName ||
    source?.sender?.user_id ||
    source?.senderId ||
    ''
  const name = String(raw || '某人').replace(/\s+/g, ' ').trim()
  if (!name) return '某人'
  // 群名片常常很长（「魔猴烧酒:秘宝进度:史诗112,太初20,巡礼10470」），
  // 截断时留个省略号，别让模型以为这人名字就这么半截。
  return name.length > 20 ? `${name.slice(0, 19)}…` : name
}

function segmentsOf(source) {
  if (Array.isArray(source?.segments) && source.segments.length) return source.segments
  if (Array.isArray(source?.message) && source.message.length) return source.message
  const text = String(source?.text ?? source?.raw_message ?? '')
  return text ? [{ type: 'text', data: { text } }] : []
}

/**
 * 把一条被引用的消息转成「边界 + 内容」的段序列。
 *
 * 为什么要包边界：模型看到一串光秃秃的文字，分不清哪句是引用、哪句是这次
 * 对我说的。`[引用 小王: …]` 这一层壳是必须的 —— 少了它，模型会把被引用的
 * 话当成新消息，答非所问。
 */
function quoteSegments(source, opts) {
  const name = senderNameOf(source)
  const source_segments = segmentsOf(source)
  const maxChars = Math.max(40, Number(opts.maxChars) || REPLY_DEFAULTS.maxChars)
  const maxImages = Math.max(0, Number(opts.maxImages ?? REPLY_DEFAULTS.maxImages))

  const parts = [] // 内容段（text / image / video）
  let chars = 0
  let images = 0
  let droppedImages = 0
  let cut = false

  const pushText = (text) => {
    if (!text || chars >= maxChars) return
    const remain = maxChars - chars
    if (text.length > remain) {
      parts.push({ type: 'text', data: { text: `${text.slice(0, Math.max(1, remain - 1))}…` } })
      chars = maxChars
      cut = true
      return
    }
    parts.push({ type: 'text', data: { text } })
    chars += text.length
  }

  for (const seg of source_segments) {
    if (chars >= maxChars) {
      cut = true
      break
    }
    if (seg?.type === 'text') {
      pushText(seg.data?.text ?? '')
      continue
    }
    if (seg?.type === 'image' || seg?.type === 'video') {
      // 图片/视频原样透传，让下游的 content.js 决定能不能真的取到字节。
      // 取不到会降级成 [图片]/[视频] 占位 —— 但至少位置信息还在。
      if (images >= maxImages) {
        droppedImages++
        continue
      }
      parts.push({ type: seg.type, data: seg.data ?? {} })
      images++
      continue
    }
    // 被引用的若是一条转发（截图里正是这种），段要原样透传 ——
    // 换成 `[聊天记录]` 一个字就再也没法摊平了，下游的 expandForwards 会处理它。
    if (seg?.type === 'forward' || seg?.type === 'node') {
      parts.push({ type: seg.type, data: seg.data ?? {} })
      continue
    }
    if (seg?.type === 'reply') continue // 引用套引用，只保留最外层
    pushText(segmentToText(seg))
  }

  const notes = []
  if (cut) notes.push('已截断')
  if (droppedImages) notes.push(`另有 ${droppedImages} 张图未带`)
  const tailNote = notes.length ? `，${notes.join('，')}` : ''

  // 纯文字是最常见的情况：合成一个段，模型读起来最干净
  const onlyText = parts.every((p) => p.type === 'text')
  if (onlyText) {
    const body = parts.map((p) => p.data?.text ?? '').join('')
    return [{ type: 'text', data: { text: `[引用 ${name}: ${body}${tailNote}]\n` } }]
  }

  return [
    { type: 'text', data: { text: `[引用 ${name}: ` } },
    ...parts,
    { type: 'text', data: { text: `${tailNote}]\n` } },
  ]
}

/** 按 id 调 get_msg（兜底：存档里没有时，比如机器人自己发过的消息）。 */
async function fetchByApi(id, deps) {
  const { call, logger } = deps
  if (typeof call !== 'function') return undefined
  try {
    const res = await call(
      'get_msg',
      { message_id: Number(id) || id },
      deps.fetchTimeoutMs ?? REPLY_DEFAULTS.fetchTimeoutMs
    )
    const data = res?.data ?? res
    if (!data || typeof data !== 'object') return undefined
    const segments = Array.isArray(data.message) ? data.message : []
    if (!segments.length && !data.raw_message) return undefined
    return { sender: data.sender, segments, text: data.raw_message ?? '' }
  } catch (error) {
    logger?.warn(`[引用] get_msg 失败 id=${id}: ${error?.message ?? error}`)
    return undefined
  }
}

/**
 * 展开一条消息里的全部引用段。
 *
 * @param {Array} segments 归一化后的消息段
 * @param {{lookup?: (id:number)=>Promise<object|undefined>, call?: Function,
 *   logger?: object, maxChars?: number, maxImages?: number, enabled?: boolean,
 *   onResolved?: (info:{id:number, source:'archive'|'api'|'none', name?:string})=>void}} deps
 *   lookup —— 按消息号查自己的存档（store.js 的 findByMessageId）
 *   call —— OneBot 动作调用（存档查不到时的兜底）
 * @returns {Promise<Array>} 新的段数组；没有引用时原样返回
 */
export async function expandReplies(segments, deps = {}) {
  const list = Array.isArray(segments) ? segments : []
  if (deps.enabled === false || !hasReply(list)) return list

  const out = []
  for (const seg of list) {
    const id = replyIdOf(seg)
    if (!id) {
      // 没有 id 的 reply 段（或别的段）原样保留
      if (seg?.type !== 'reply') out.push(seg)
      continue
    }

    let source
    let from = 'none'
    try {
      source = await deps.lookup?.(id)
      if (source) from = 'archive'
    } catch (error) {
      deps.logger?.warn(`[引用] 查存档失败 id=${id}: ${error?.message ?? error}`)
    }
    if (!source) {
      source = await fetchByApi(id, deps)
      if (source) from = 'api'
    }

    if (!source) {
      // 取不到也要留个明确的痕迹：模型知道"这里有句话被引用了，我看不到"，
      // 比装作没这回事强得多 —— 至少它会说"你引用的那条我看不到"，而不是瞎猜。
      out.push({ type: 'text', data: { text: '[引用了一条我看不到的消息]\n' } })
      deps.onResolved?.({ id, source: 'none' })
      continue
    }

    out.push(...quoteSegments(source, deps))
    deps.onResolved?.({ id, source: from, name: senderNameOf(source) })
  }
  return out
}
