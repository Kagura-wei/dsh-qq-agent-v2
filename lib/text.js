/** 消息段与纯文本的互转、长文本安全切分。 */

/**
 * 单个消息段 → 文本。
 *
 * 图片段返回 `[图片]` 占位符：调用方如果能拿到图片本体，会把它换成真正的
 * image 内容块；换不到（下载失败等）就保留这个占位，让模型至少知道
 * "这里本来有张图"，而不是把位置信息丢掉。
 */
export function segmentToText(seg) {
  if (seg?.type === 'text') return seg.data?.text ?? ''
  if (seg?.type === 'at') return `@${seg.data?.qq ?? ''}`
  if (seg?.type === 'face') return `[表情${seg.data?.id ?? ''}]`
  if (seg?.type === 'image') return '[图片]'
  if (seg?.type === 'record') return '[语音]'
  if (seg?.type === 'reply') return '' // 引用内容不进正文
  return ''
}

export function segmentsToText(segments) {
  let out = ''
  for (const seg of segments ?? []) out += segmentToText(seg)
  return out
}

/** 是否含有需要多模态能力的段。 */
export function hasImage(segments) {
  return (segments ?? []).some((s) => s?.type === 'image')
}

/**
 * 按最大长度切分文本。优先在换行/句末断，避免把一句话劈成两半。
 * 使用码点遍历，避免把 emoji 或代理对切断。
 */
export function splitMessage(text, maxLength = 1700) {
  const limit = Math.max(100, Math.floor(maxLength))
  // 全程按码点数组操作：emoji/代理对是 1 个码点，绝不能在 UTF-16 索引上切
  const chars = Array.from(text ?? '')
  if (chars.length <= limit) return chars.length ? [text] : []

  const chunks = []
  let current = []
  const flush = (arr) => {
    const s = arr.join('').trimEnd()
    if (s) chunks.push(s)
  }

  for (const ch of chars) {
    current.push(ch)
    if (current.length < limit) continue

    // 到达上限：回退到最近的句读/换行处断开
    let cutAt = -1
    for (let j = current.length - 1; j > limit * 0.5; j--) {
      const c = current[j]
      if (c === '\n' || c === '。' || c === '！' || c === '？' || c === '；') {
        cutAt = j
        break
      }
    }

    if (cutAt > 0) {
      flush(current.slice(0, cutAt + 1))
      current = current.slice(cutAt + 1)
    } else {
      flush(current)
      current = []
    }
  }

  flush(current)
  return chunks
}

/** 按码点计数（代理对算 1 个字符）。 */
export function codePointLength(text) {
  return Array.from(text ?? '').length
}
