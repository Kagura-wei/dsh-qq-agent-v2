/**
 * 模型输入组装。
 *
 * 分两条路径，各司其职：
 *
 * 1. **user 消息**（`buildRichContent`）—— 只承载"本次需要回应的消息"。
 *    逐段处理，图片段落盘成 attachment 后作为 image 块插进 content。
 *    拼字符串只能得到 `[图片]` 占位符，模型就"只看到图片的框"，所以必须逐段。
 *
 * 2. **上下文**（`renderHistory`）—— 该会话最近的聊天记录，纯文本，
 *    交给 systemPrompt 的上下文注入（见 runner）。它天然是同步字符串，
 *    不带图片（image 块需要异步落盘，塞不进同步回调）。
 *
 * 两条路径分开之后，"哪条是要回应的"不再靠文本里的标题去暗示，
 * 而是由输入结构本身决定 —— 模型不会再去接历史里的话题。
 */
import { segmentToText } from './text.js'
import { toImageAttachments } from './image.js'
import { toVideoFrames } from './video.js'

/** 一条消息在提示词里的说话人前缀。 */
export function senderLabel(msg, scene) {
  return scene === 'group' ? `${msg.senderName || msg.senderId}` : '对方'
}

/**
 * 纯文本输入（不含图片块）。图片一律降级成 `[图片]` 占位。
 * 保留它是为了没有附件服务时的降级路径，以及测试里的纯文本断言。
 */
export function buildUserInput(entries, scene) {
  const lines = []
  for (const m of entries) {
    lines.push(`${senderLabel(m, scene)}: ${m.text ?? ''}`)
  }
  return lines.join('\n')
}

/**
 * 打散提示词变量的左花括号。
 *
 * DSH 在装配时会把上下文文本里的 `{{name}}` 当作提示词变量做插值 ——
 * 变量名查不到值就直接抛错，整轮装配跟着失败。群里完全可能有人贴
 * `{{model}}` 或带模板语法的代码，所以进上下文前必须先打散。
 * 插零宽空格：视觉上仍是两个花括号，但不再匹配 `{{`。
 */
function escapePromptVariables(text) {
  return text.replace(/\{\{/g, '{\u200B{')
}

/**
 * 把消息文本里的 `[图片]` 逐个换成带描述的版本。
 *
 * 文本与段本来就是顺序对应的（`m.text` 就是 segmentsToText 的产物），
 * 所以按出现顺序取 image 段即可；数量对不上时，多出来的 `[图片]` 原样保留。
 * 替换必须发生在打散 `{{` 之前 —— 描述是模型生成的，同样可能带模板语法。
 */
function withImageDesc(text, msg, describe) {
  if (!describe) return escapePromptVariables(text)
  const images = (msg?.segments ?? []).filter((s) => s?.type === 'image')
  if (!images.length) return escapePromptVariables(text)
  let index = 0
  const replaced = text.replace(/\[图片\]/g, (matched) => {
    if (index >= images.length) return matched
    const desc = describe(images[index++], msg)
    return desc ? `[图片: ${desc}]` : matched
  })
  return escapePromptVariables(replaced)
}

/**
 * 把一批消息渲染成纯文本上下文。
 *
 * 从最新往回累加，超限就丢最旧的 —— 保证"最近发生的事"一定在，
 * 而不是留着开头的寒暄、丢掉刚说的那句话。
 *
 * @param {Array} entries 按时间正序
 * @param {'group'|'private'} scene
 * @param {number} maxChars 字符上限
 * @param {{describe?: (segment: object, msg: object) => string|undefined}} [options]
 *   describe —— 给图片段配一句话描述（见 image-desc.js）。注入通道只能传字符串，
 *   图片本体的 image 块进不来，这段描述就是模型"看得见"历史图的唯一途径。
 *   返回空值时保留 `[图片]` 占位。
 * @returns {string} 无内容时返回空串
 */
export function renderHistory(entries, scene, maxChars = 4000, options = {}) {
  const { describe } = options
  const lines = []
  for (const m of entries ?? []) {
    const text = String(m.text ?? '').trim()
    if (!text) continue
    lines.push(`${senderLabel(m, scene)}: ${withImageDesc(text, m, describe)}`)
  }

  const kept = []
  let total = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 1
    // 至少保留一条：单条就超限时也让它进，否则上下文会整个空掉
    if (total + cost > maxChars && kept.length) break
    kept.unshift(lines[i])
    total += cost
  }
  return kept.join('\n')
}

/** 把攒下的文本落成一个 text 块（与相邻 text 块合并，避免碎片）。 */
function flush(content, state) {
  if (!state.pending) return
  const last = content[content.length - 1]
  if (last && last.type === 'text') last.text += state.pending
  else content.push({ type: 'text', text: state.pending })
  state.pending = ''
}

function pushText(state, text) {
  if (text) state.pending += text
}

/**
 * 取一张图（或一张长图切出来的几段）的字节。
 *
 * 优先用**预热缓存**：图片在消息到达那一刻就已经下好了（见 prefetch.js），
 * 这里直接取字节，绕开"签名地址早已过期"这个线上常态。
 * 没预热过（插件刚重启、或这条消息在预热开关关掉时进来的）才现下。
 */
async function resolveAttachments(segment, { prefetch, logger, fetchImpl, maxParts }) {
  if (prefetch && typeof prefetch.get === 'function') {
    const warmed = await prefetch.get(segment)
    // hit=true 时没有字节是有意义的信号：前面已经试过并失败了，
    // 不要再花 15 秒重试一遍，直接降级成 [图片] 占位。
    if (warmed?.hit) return warmed.atts ?? []
  }
  return toImageAttachments(segment, { logger, fetchImpl, maxParts })
}

/**
 * 取一段视频的**关键帧**。
 *
 * 模型的输入通道没有视频，只能抽帧成图片送进去 —— 有了这几帧它才能说
 * "视频里是 XX"，而不是"这儿有个视频但我看不了"。抽帧比下载图片慢得多
 * （下载 + ffprobe + N 次 ffmpeg），所以同样优先走预热缓存。
 */
async function resolveVideoFrames(segment, { prefetch, logger, fetchImpl, maxBytes, frames }) {
  if (prefetch && typeof prefetch.get === 'function') {
    const warmed = await prefetch.get(segment)
    // 同样是负缓存：热过但没帧，说明上一轮已经失败过，别再花 30 秒重来一遍
    if (warmed?.hit) return warmed.atts ?? []
  }
  return toVideoFrames(segment, { logger, fetchImpl, maxBytes, frames })
}

/**
 * 组装 user 消息的 content。
 *
 * 图片取不到时只降级成 `[图片]` 占位 —— 链接过期、容器网络不通都是常事，
 * 不能因此让整条消息发不出去。长截图会被切成几段，逐段插 image 块，
 * 并用 `[图片 1/3]` 这样的标记告诉模型"这几段其实是同一张图"。
 *
 * 视频同理：能抽帧就把帧当图片送进去（`[视频帧 1/2]` 标明同源），
 * 抽不出来就留 `[视频]` 占位 —— 至少模型知道这里本来有段视频。
 *
 * @param {Array} entries 要放进本次输入的消息（通常只有触发消息及其之后到达的）
 * @param {'group'|'private'} scene
 * @param {{attachments?: object, prefetch?: object, logger?: object, maxImages?: number,
 *   maxParts?: number, videoEnabled?: boolean, videoMaxBytes?: number, videoFrameCount?: number,
 *   fetchImpl?: Function}} deps
 *   prefetch —— 媒体预热器（ImagePrefetcher），命中时不再走网络
 *   maxParts —— 长图最多切几段（透传给 image.js，0 表示不切）
 *   videoEnabled —— 关掉后视频只留 `[视频]` 占位，不做抽帧
 * @returns {Promise<{content: Array, images: number, dropped: number, sliced: number, videos: number}>}
 *   sliced = 被切开的图片张数（不是段数）
 *   videos = 成功抽帧进模型的视频段数
 */
export async function buildRichContent(entries, scene, deps = {}) {
  const { attachments, prefetch, logger } = deps
  const content = []
  const state = {
    pending: '',
    images: 0,
    dropped: 0,
    sliced: 0,
    videos: 0,
    // DSH 对单条消息的图片数量有配额，超了会整条被拒。提前按它的限额截断。
    maxImages:
      Number.isFinite(deps.maxImages) && deps.maxImages > 0
        ? deps.maxImages
        : (attachments?.imageLimits?.maxImagesPerMessage ?? 4),
  }

  for (const msg of entries ?? []) {
    pushText(state, `${senderLabel(msg, scene)}: `)
    const segments = Array.isArray(msg.segments) ? msg.segments : []

    if (!segments.length) {
      pushText(state, String(msg.text ?? ''))
      pushText(state, '\n')
      continue
    }

    for (const segment of segments) {
      const type = segment?.type
      if (type !== 'image' && type !== 'video') {
        pushText(state, segmentToText(segment))
        continue
      }

      const isVideo = type === 'video'
      if (isVideo && deps.videoEnabled === false) {
        pushText(state, segmentToText(segment))
        continue
      }

      const canAttach =
        attachments && typeof attachments.saveImage === 'function' && state.images < state.maxImages
      if (canAttach) {
        const parts = isVideo
          ? await resolveVideoFrames(segment, {
              prefetch,
              logger,
              fetchImpl: deps.fetchImpl,
              maxBytes:
                Number(deps.videoMaxBytes) > 0 ? Number(deps.videoMaxBytes) * 1024 * 1024 : undefined,
              frames: deps.videoFrameCount,
            })
          : await resolveAttachments(segment, {
              prefetch,
              logger,
              fetchImpl: deps.fetchImpl,
              maxParts: deps.maxParts,
            })
        // 配额在切段之后仍然要守：多段长图不能把单条消息的图片数撑爆
        const room = Math.min(parts.length, state.maxImages - state.images)
        let saved = 0
        for (let i = 0; i < room; i++) {
          try {
            const ref = await attachments.saveImage(parts[i])
            pushText(
              state,
              parts.length > 1
                ? `[${isVideo ? '视频帧' : '图片'} ${i + 1}/${parts.length}]`
                : isVideo
                  ? '[视频帧]'
                  : '[图片]'
            )
            flush(content, state)
            content.push({ type: 'image', attachment: ref })
            state.images++
            saved++
          } catch (error) {
            logger?.warn(`${isVideo ? '视频帧' : '图片'}入库失败: ${error?.message ?? error}`)
          }
        }
        if (saved) {
          if (!isVideo && parts.length > 1) state.sliced++
          if (isVideo) state.videos++
          if (saved < parts.length) state.dropped++
          continue
        }
        state.dropped++
      }

      pushText(state, isVideo ? segmentToText(segment) : '[图片]')
    }

    pushText(state, '\n')
  }

  flush(content, state)
  // 纯图片、没有文字时也要保证 content 非空，否则消息会被判为空
  if (!content.length) content.push({ type: 'text', text: '(空消息)' })
  return { content, images: state.images, dropped: state.dropped, sliced: state.sliced, videos: state.videos }
}
