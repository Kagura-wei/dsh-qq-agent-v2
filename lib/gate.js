/**
 * 事件归一化 + 响应门控。
 *
 * 门控是省 token 的核心：绝大多数消息应该在这里被判死，
 * 连 Agent 会话都不创建（零开销）。
 */
import { segmentsToText } from './text.js'

/** OneBot 原始事件 → 内部统一消息模型。返回 null 表示不关心的事件。 */
export function normalizeEvent(raw) {
  if (raw.post_type !== 'message') return null
  const scene = raw.message_type === 'group' ? 'group' : 'private'
  if (raw.message_type !== 'group' && raw.message_type !== 'private') return null

  const segments = normalizeSegments(raw.message)
  const peerId = scene === 'group' ? raw.group_id : raw.user_id
  if (peerId == null) return null

  return {
    scene,
    peerId: Number(peerId),
    senderId: Number(raw.user_id ?? raw.sender?.user_id ?? 0),
    senderName: raw.sender?.nickname ?? raw.sender?.card ?? '',
    messageId: Number(raw.message_id ?? 0),
    time: Number(raw.time ?? Date.now() / 1000),
    segments,
    // 引用（回复）信息单独拎出来：正文里它不参与渲染（见 text.js），
    // 但门控要靠它判断"这条是不是在回机器人自己说过的话"。
    replyTo: findReplyId(segments),
    text: segmentsToText(segments).trim(),
    raw,
  }
}

/**
 * 取 reply 段引用的消息号。
 *
 * 各家 OneBot 实现给的字段不完全一致：`id` 是通用的，`qq`/`user_id` 是
 * 被引用消息的发送者（部分实现不给）。我们只依赖 `id`，配合出站登记表
 * 判断"这条引用的是不是我自己发的"—— 不依赖 sender_id，因为 NapCat 的
 * reply 段通常只有 id。
 */
export function findReplyId(segments) {
  for (const seg of segments ?? []) {
    if (seg?.type !== 'reply') continue
    const data = seg.data ?? {}
    const id = Number(data.id ?? data.message_id ?? 0)
    if (Number.isFinite(id) && id > 0) return id
  }
  return 0
}

export function normalizeSegments(message) {
  if (Array.isArray(message)) return message.filter((s) => s && typeof s === 'object')
  if (typeof message === 'string') return [{ type: 'text', data: { text: message } }]
  return []
}

/**
 * 触发检测：这条消息算不算"在跟机器人说话"。
 *
 * 三种信号，按可靠性排序：
 *   1. `at` 段的 qq 就是机器人 —— 最明确，没有任何歧义；
 *   2. **引用了机器人自己发过的消息**（reply 段 + 出站登记表）——
 *      群里长按引用追问是最自然的对话延续，与 @ 同级。缺了它，
 *      这类话只能靠几率或跟进期判定去救，该回的不回；
 *   3. 正文里出现机器人名字 —— 最弱，必须防误触（见下）。
 *
 * 第 3 条的防误触规则来自真实故障：群里说「@张三 你觉得小鲸鱼说的对吗」，
 * 正文含"小鲸鱼"就被叫醒去回复，而这句话根本不是对它说的。
 * 所以：**消息开头的第一个有效段是 @ 别人时，整条消息就当成"在对别人说话"**，
 * 正文里出现名字（以及下文的关键词）一律不算数。
 *
 * @param {{segments?: Array, text?: string, replyTo?: number}} msg
 * @param {{botQq?: number, botName?: string, isBotMessage?: (id: number) => boolean}} options
 * @returns {{mention: boolean, kind: 'at'|'reply'|'text'|null, addressedToOther: boolean}}
 *   addressedToOther 为真表示这条消息是冲着别人去的 —— decide() 据此压掉
 *   一切"靠正文认领"的触发（名字提及、关键词），只留 @ 与引用两条硬信号。
 */
export function detectTrigger(msg, { botQq, botName, isBotMessage } = {}) {
  const bot = Number(botQq) || 0
  const segments = Array.isArray(msg?.segments) ? msg.segments : []

  // 第一个有效段（跳过纯空白文本段）如果是 @ 别人，这条消息是在对别人说话
  const first = firstMeaningfulSegment(segments)
  const addressedToOther = first?.type === 'at' && (!bot || Number(first.data?.qq) !== bot)

  if (bot && segments.some((s) => s?.type === 'at' && Number(s.data?.qq) === bot)) {
    return { mention: true, kind: 'at', addressedToOther }
  }

  const replyTo = Number(msg?.replyTo ?? 0)
  if (replyTo > 0 && typeof isBotMessage === 'function' && isBotMessage(replyTo)) {
    return { mention: true, kind: 'reply', addressedToOther }
  }

  const name = String(botName ?? '').trim()
  if (!name || addressedToOther) return { mention: false, kind: null, addressedToOther }
  if (!String(msg?.text ?? '').includes(name)) return { mention: false, kind: null, addressedToOther }

  return { mention: true, kind: 'text', addressedToOther }
}

/** 跳过纯空白的文本段，取第一个"有内容"的段。 */
function firstMeaningfulSegment(segments) {
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue
    if (seg.type === 'text' && !String(seg.data?.text ?? '').trim()) continue
    return seg
  }
  return undefined
}

/**
 * 兼容入口：只要"是不是在跟机器人说话"这个布尔。
 * 新的调用方应当用 detectTrigger 拿到 kind（回复理由里要区分 at / reply）。
 */
export function detectMention(msg, options) {
  return detectTrigger(msg, options).mention
}

/**
 * 决定是否响应。
 *
 * 这里只回答"要不要回"。带多少上下文由会话自己维护的上下文窗口决定，
 * 不再按触发类型给不同条数 —— 那是旧设计，已改为 systemPrompt 的上下文注入。
 *
 * **图片不享受特殊待遇**：带图消息和纯文字走完全相同的三条路
 * （@ / 关键词 / 几率命中），没有"带图必回"。
 * `imageEnabled` 管的是"命中之后要不要把图送进模型"，不管"要不要回" ——
 * 否则群里一有人刷图就会被逐张回复，把档位调低也拦不住。
 *
 * `mention` 为真时有三种来源（at / reply / 正文提到名字），它们在门控里
 * 是同一档；reason 里回显具体来源，便于排障时看清是哪条路把人叫醒的。
 *
 * `addressedToOther`（消息开头 @ 的是别人）会压掉所有"靠正文认领"的触发 ——
 * 名字提及与关键词都不算数。这条很重要：关键词表里常常放着机器人名字
 * （比如 `keywords: ['阿蓝']`），不加这道闸的话，一句「@张三 你觉得阿蓝
 * 说的对吗」照样会被关键词叫醒，防误触发就是白做的。
 * @ 机器人与"引用机器人消息"是明确冲着它来的信号，不受影响。
 *
 * @returns {{ accept: boolean, reason: string }}
 *   reason: 'not-allowed' | 'blocked' | 'not-mentioned' | 'at' | 'reply' | 'keyword' | 'random' | 'all'
 */
export function decide({ config, msg, mention, mentionKind, addressedToOther, random = Math.random }) {
  const { scene, peerId, senderId } = msg

  // 1) 白名单：空 = 全部拒绝（安全默认）
  const allow = scene === 'group' ? config.allowGroups : config.allowUsers
  if (!Array.isArray(allow) || !allow.map(Number).includes(Number(peerId))) {
    return { accept: false, reason: 'not-allowed' }
  }

  // 2) 群内屏蔽名单
  if (scene === 'group') {
    const blocked = config.blocklist?.[String(peerId)] ?? []
    if (blocked.map(Number).includes(Number(senderId))) {
      return { accept: false, reason: 'blocked' }
    }
  }

  const pos = clamp(config.contextSliderPos ?? 20, 0, 100)

  // 3) 私聊：只要过白名单就回
  if (scene === 'private') {
    return { accept: true, reason: pos > 90 ? 'all' : 'at' }
  }

  // 4) 群聊：@ / 引用机器人 / 正文点名 优先
  if (mention) {
    return { accept: true, reason: mentionKind === 'reply' ? 'reply' : 'at' }
  }

  // 仅 @ 模式：非 @ 直接放弃（但仍然存档，由调用方处理）
  if (config.replyOnlyWhenMentioned) {
    return { accept: false, reason: 'not-mentioned' }
  }

  // 5) 档位判定。带图消息也走这里 —— 纯图片的文本是 `[图片]`，
  // 既不含 @ 也不含关键词，所以只会被几率命中，与预期一致。
  if (pos <= 10) {
    return { accept: false, reason: 'not-mentioned' }
  }

  const keywords = (config.keywords ?? []).filter(Boolean)
  // 开头 @ 了别人 = 这条是在对别人说话：正文里的关键词不算数
  const hitKeyword = addressedToOther === true ? false : keywords.some((k) => msg.text.includes(k))
  if (pos <= 20) {
    return hitKeyword ? { accept: true, reason: 'keyword' } : { accept: false, reason: 'not-mentioned' }
  }

  if (pos <= 90) {
    if (hitKeyword) return { accept: true, reason: 'keyword' }
    // 几率是独立的触发方式之一，照常掷骰子；判定不在这里插手 ——
    // 它管的是"触发之后、跟进期里那些没触发的话要不要接"（见 judge.js）。
    const probability = (pos - 20) / 70 // 20→0, 90→1 线性
    if (random() < probability) return { accept: true, reason: 'random' }
    return { accept: false, reason: 'not-mentioned' }
  }

  return { accept: true, reason: 'all' }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
