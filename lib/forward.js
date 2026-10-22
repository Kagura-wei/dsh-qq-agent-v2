/**
 * 合并转发（聊天记录）展开。
 *
 * 线上故障：群里发一条「转发的聊天记录」再让机器人"总结一下"，它回
 * 「光说一句总结一下，我也不知道你想让我总结啥」—— 因为它什么都没收到。
 * `segmentToText()` 对 `forward` 段返回空串，存档又把未知段裁成 `{type:'forward', data:{}}`，
 * 整条转发在模型眼里就是一片空白。
 *
 * 真机（NapCat，2026-10）给的形态：
 *
 *   { type: 'forward', data: { id: '76993528...', content: [ node, node, ... ] } }
 *
 * `content` 里每个 node 就是一条完整的消息对象（自带 sender.nickname / message 段数组），
 * **多层嵌套的转发也直接内嵌在里面**，不需要再调 `get_forward_msg`。
 * 但不同版本/实现会缺 content，所以这里留了一条"缺了就按 id 去取"的兜底。
 *
 * 展开结果是一段**扁平的消息段数组**，而不是一段字符串 —— 这样转发里的图片、
 * 视频能顺着原有链路继续走（图片进 image 块、视频抽帧），模型看到的才是内容本身，
 * 而不是一个「有 N 条记录」的空壳。
 */
import { segmentToText } from './text.js'

/** 默认上限。转发是别人塞进来的东西，深度/条数/字数都得有闸。 */
export const FORWARD_DEFAULTS = {
  maxDepth: 3,
  maxNodes: 40,
  maxChars: 2000,
  /** 缺 content 时按 id 去取的最多次数（每次都是一次 OneBot 往返） */
  maxFetches: 6,
  fetchTimeoutMs: 8000,
}

/** 这个段是不是合并转发。 */
export function isForwardSegment(segment) {
  return segment?.type === 'forward' || segment?.type === 'node'
}

/** 这串段里有没有合并转发。 */
export function hasForward(segments) {
  return (segments ?? []).some(isForwardSegment)
}

/**
 * 从各种转发节点形态里掏出「谁说的 + 说了什么」。
 *
 * 三种来源都见过：
 *   1. NapCat 收到的节点：{ sender:{card,nickname}, user_id, message:[段], time }
 *   2. OneBot v11 标准节点：{ type:'node', data:{ name, uin, content:[段], time } }
 *   3. 简化节点：{ nickname, user_id, content:[段] }
 */
function nodeInfo(node) {
  if (!node || typeof node !== 'object') return undefined
  const data = node.type === 'node' && node.data ? node.data : node
  const inner = data.message ?? data.content
  let segments = []
  if (Array.isArray(inner)) segments = inner.filter((s) => s && typeof s === 'object')
  else if (typeof inner === 'string' && inner) segments = [{ type: 'text', data: { text: inner } }]

  const rawName =
    data.sender?.card ||
    data.sender?.nickname ||
    data.nickname ||
    data.name ||
    (data.user_id ?? data.uin ? String(data.user_id ?? data.uin) : '')
  const name = String(rawName || '某人').replace(/\s+/g, ' ').trim().slice(0, 20) || '某人'
  return { name, segments }
}

/**
 * 把转发节点摊平成消息段数组。
 *
 * 纯函数：不做网络请求，缺 content 的嵌套转发只留一句说明（补齐见 hydrateForwards）。
 *
 * @param {Array} nodes 转发 content 里的节点数组
 * @param {object} [options] 见 FORWARD_DEFAULTS
 * @returns {Array} 消息段数组（text / image / video 混排，保持原始顺序）
 */
export function flattenForward(nodes, options = {}) {
  const opts = { ...FORWARD_DEFAULTS, ...options }
  const maxNodes = Math.max(1, Number(opts.maxNodes) || FORWARD_DEFAULTS.maxNodes)
  const maxChars = Math.max(100, Number(opts.maxChars) || FORWARD_DEFAULTS.maxChars)
  const maxDepth = Math.max(0, Number(opts.maxDepth) || 0)

  const out = []
  let chars = 0
  let nodesUsed = 0
  let omitted = 0
  let cut = false

  const pushText = (text) => {
    if (!text) return
    out.push({ type: 'text', data: { text } })
    chars += text.length
  }

  /**
   * 推送文字并守住字数上限。
   *
   * 必须切在段内而不是"超了就整段不要" —— 转发里常见一条几千字的长文，
   * 整段丢弃等于把这条记录的内容全丢了，切成前半段至少还能看懂在说什么。
   */
  const pushBounded = (text) => {
    if (!text || chars >= maxChars) return
    const remain = maxChars - chars
    if (text.length > remain) {
      pushText(`${text.slice(0, Math.max(1, remain - 1))}…`)
      cut = true
      return
    }
    pushText(text)
  }

  const walk = (list, depth) => {
    const indent = '  '.repeat(depth)
    for (const node of list ?? []) {
      // 超限的节点不再展开内容，但计数留着 —— 结尾要告诉模型"还有多少没看"
      if (nodesUsed >= maxNodes || chars >= maxChars) {
        omitted++
        continue
      }
      const info = nodeInfo(node)
      if (!info || !info.segments.length) {
        omitted++
        continue
      }
      nodesUsed++
      pushBounded(`\n${indent}${info.name}: `)

      for (const seg of info.segments) {
        if (chars >= maxChars) {
          cut = true
          break
        }
        if (isForwardSegment(seg)) {
          const inner = Array.isArray(seg?.data?.content) ? seg.data.content : []
          if (!inner.length) {
            pushBounded('〔转发消息，内容取不到〕')
            continue
          }
          pushBounded(`〔转发 ${inner.length} 条〕`)
          if (depth + 1 > maxDepth) {
            pushBounded('〔嵌套太深，已省略〕')
            omitted += inner.length
          } else {
            walk(inner, depth + 1)
          }
          continue
        }
        // 图片/视频原样透传：下游会把图片存成 image 块、视频抽帧，
        // 换成字符串占位就再也没法补救了
        if (seg?.type === 'image' || seg?.type === 'video') {
          out.push({ type: seg.type, data: seg.data ?? {} })
          continue
        }
        pushBounded(segmentToText(seg))
      }
    }
  }

  walk(nodes, 0)
  const total = Array.isArray(nodes) ? nodes.length : 0
  const head = `[聊天记录 ${total} 条]`
  const notes = []
  if (omitted > 0) notes.push(`另有 ${omitted} 条未展开`)
  if (cut) notes.push('内容过长已截断')
  const tail = notes.length ? `\n[/聊天记录，${notes.join('，')}]` : '\n[/聊天记录]'
  return [{ type: 'text', data: { text: head } }, ...out, { type: 'text', data: { text: tail } }]
}

/** 按 id 取一份转发内容（部分实现不在事件里内嵌 content）。 */
async function fetchForwardContent(id, deps) {
  const { call, logger, fetchTimeoutMs } = deps
  if (typeof call !== 'function' || !id) return []
  try {
    const res = await call('get_forward_msg', { id: String(id) }, fetchTimeoutMs ?? FORWARD_DEFAULTS.fetchTimeoutMs)
    const messages = res?.messages ?? res?.data?.messages ?? res?.data
    return Array.isArray(messages) ? messages : []
  } catch (error) {
    logger?.warn(`取转发内容失败 id=${id}: ${error?.message ?? error}`)
    return []
  }
}

/**
 * 补齐缺失的嵌套 content（就地写回 segment.data.content）。
 *
 * 只在真缺内容时才会发网络请求，且总量受 maxFetches 限制 —— 一条 60 层的
 * 转发不能把整轮回复拖死。
 */
async function hydrateForwards(nodes, depth, deps, budget) {
  const maxDepth = Math.max(0, Number(deps.maxDepth ?? FORWARD_DEFAULTS.maxDepth) || 0)
  for (const node of nodes ?? []) {
    const info = nodeInfo(node)
    if (!info) continue
    for (const seg of info.segments) {
      if (!isForwardSegment(seg)) continue
      if (!seg.data || typeof seg.data !== 'object') seg.data = {}
      let content = Array.isArray(seg.data.content) ? seg.data.content : []
      if (!content.length && seg.data.id && budget.left > 0) {
        budget.left--
        content = await fetchForwardContent(seg.data.id, deps)
        if (content.length) seg.data.content = content
      }
      if (content.length && depth + 1 <= maxDepth) {
        await hydrateForwards(content, depth + 1, deps, budget)
      }
    }
  }
}

/**
 * 展开一条消息里的全部转发段。
 *
 * @param {Array} segments 归一化后的消息段
 * @param {{call?: Function, logger?: object, maxDepth?: number, maxNodes?: number,
 *   maxChars?: number, enabled?: boolean}} deps
 *   call —— OneBot 动作调用（缺 content 时用；不传则只展开内嵌内容）
 * @returns {Promise<Array>} 新的段数组；没有转发时原样返回
 */
export async function expandForwards(segments, deps = {}) {
  const list = Array.isArray(segments) ? segments : []
  if (deps.enabled === false || !hasForward(list)) return list

  const opts = {
    maxDepth: deps.maxDepth ?? FORWARD_DEFAULTS.maxDepth,
    maxNodes: deps.maxNodes ?? FORWARD_DEFAULTS.maxNodes,
    maxChars: deps.maxChars ?? FORWARD_DEFAULTS.maxChars,
  }

  const out = []
  for (const seg of list) {
    if (!isForwardSegment(seg)) {
      out.push(seg)
      continue
    }
    const budget = { left: Number(deps.maxFetches ?? FORWARD_DEFAULTS.maxFetches) }
    let content = Array.isArray(seg?.data?.content) ? seg.data.content : []
    if (!content.length && seg?.data?.id && budget.left > 0) {
      budget.left--
      content = await fetchForwardContent(seg.data.id, deps)
    }
    if (!content.length) {
      out.push({ type: 'text', data: { text: '[聊天记录：内容取不到]' } })
      continue
    }
    await hydrateForwards(content, 0, { ...deps, ...opts }, budget)
    out.push(...flattenForward(content, opts))
  }
  return out
}
