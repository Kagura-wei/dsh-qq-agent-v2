/** 消息段与纯文本的互转、长文本安全切分。 */

/**
 * 从卡片（json / xml 段）里抠一句标题。
 *
 * 群里的分享卡片、小程序、图文消息都走 json 段，原始内容是一坨 JSON 字符串。
 * 整段塞给模型既贵又没用，只留标题/摘要这一行 —— 至少让它知道"这里有个卡片，
 * 讲的是 XX"，比什么都不说强。
 */
function cardSummary(seg) {
  const raw = seg?.data?.data ?? seg?.data?.content
  if (typeof raw !== 'string' || !raw.trim()) return ''
  try {
    const doc = JSON.parse(raw)
    const meta = doc?.meta ?? {}
    const candidates = [
      meta?.news?.title,
      meta?.news?.desc,
      meta?.detail?.title,
      meta?.detail?.desc,
      meta?.music?.title,
      meta?.music?.desc,
      meta?.summary,
      meta?.title,
      doc?.prompt,
      doc?.desc,
    ]
    const hit = candidates.find((v) => typeof v === 'string' && v.trim())
    return hit ? String(hit).replace(/\s+/g, ' ').trim().slice(0, 40) : ''
  } catch {
    return ''
  }
}

/**
 * 单个消息段 → 文本。
 *
 * 图片段返回 `[图片]` 占位符：调用方如果能拿到图片本体，会把它换成真正的
 * image 内容块；换不到（下载失败等）就保留这个占位，让模型至少知道
 * "这里本来有张图"，而不是把位置信息丢掉。
 *
 * 视频同理（`[视频]`，能抽帧时会被换成 image 块）；合并转发在
 * forward.js 里会被展开成它实际的内容，走到这里通常只剩兜底占位。
 */
export function segmentToText(seg) {
  if (seg?.type === 'text') return seg.data?.text ?? ''
  if (seg?.type === 'at') return `@${seg.data?.qq ?? ''}`
  if (seg?.type === 'face') return `[表情${seg.data?.id ?? ''}]`
  if (seg?.type === 'image') return '[图片]'
  if (seg?.type === 'record') return '[语音]'
  // 引用在 reply.js 里会被换成「被引用的那句话」；走到这里说明没展开成功
  // （开关关了，或这一步出错）。留个占位，让模型知道"这里有句话在指代别的消息"，
  // 而不是以为对方在没头没尾地说话。
  if (seg?.type === 'reply') return '[引用]'
  if (seg?.type === 'video') {
    const secs = Number(seg.data?.duration ?? seg.data?.seconds ?? 0)
    return secs > 0 ? `[视频 ${Math.round(secs)}s]` : '[视频]'
  }
  if (seg?.type === 'forward' || seg?.type === 'node') return '[聊天记录]'
  if (seg?.type === 'json' || seg?.type === 'xml') {
    const title = cardSummary(seg)
    return title ? `[卡片: ${title}]` : '[卡片]'
  }
  if (seg?.type === 'file') {
    const name = String(seg.data?.name ?? seg.data?.file ?? '').slice(0, 40)
    return name ? `[文件: ${name}]` : '[文件]'
  }
  if (seg?.type === 'mface') {
    const title = String(seg.data?.summary ?? seg.data?.name ?? '')
    return title ? `[表情包: ${title.slice(0, 20)}]` : '[表情包]'
  }
  if (seg?.type === 'dice' || seg?.type === 'rps') return '[骰子]'
  if (seg?.type === 'poke') return '[戳一戳]'
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

/** 是否含有视频段（视频要靠抽帧才能进模型，处理链路和图片一样要赶早）。 */
export function hasVideo(segments) {
  return (segments ?? []).some((s) => s?.type === 'video')
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
