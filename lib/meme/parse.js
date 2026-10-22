/**
 * 表情包标记解析。
 *
 * 协议沿用 AstrBot 表情包管理器：模型在回复里写 `&&分类键&&`，插件把标记
 * 摘掉、换成一张对应分类的图发出去。沿用而不是自创，是因为社区表情包
 * （manifest.json 里的分类描述）就是按这套话术写的，可以直接用。
 *
 * 两条铁律：
 *   1. **所有 `&&...&&` 一律从出站文本里剥离**，不只是能识别的那些。
 *      模型可能写错键、写中文名、把 `&&` 当重音符号用 —— 无论哪种，
 *      协议本身都不能泄漏到群里。
 *   2. 只有命中分类表的键才会产生 picks，且去重、截断到上限。
 *
 * 第三条（2026-10-21 补）：**半截标记也算标记**。
 *   换 provider 之后模型稳定地把收尾的 `&&` 吃掉，回回写成 `\n\n&&sad`
 *   （29 条带标记的回复里 20 条是这种，切换前的 9 条全部闭合 —— 是模型侧
 *   行为变化，不是偶发）。只认成对标记的旧正则把它们原样发到群里，
 *   于是群里每条消息尾巴都挂着 `&&sad`。所以：
 *     - 整行只剩 `&&键`   → 当标记，整行丢弃；
 *     - 行尾挂着 ` &&键`  → 摘掉尾巴。
 *   两种都只有在键**命中分类表**时才发图，其余只记 invalid 并剥离。
 *
 * 纯函数，不碰文件也不碰网络，便于单测。
 */

/** 标记本体。键长上限 64：分类键是包作者定义的短标识，没有更长的道理。 */
const TAG_RE = /&&[^&\r\n]{0,64}&&/g

/** 整行只有半截标记：`&&sad`（含前后空白）。 */
const LONE_TAIL_RE = /^\s*&&\s*([^&\r\n]{0,64}?)\s*$/

/** 行尾挂着的半截标记：`正文 &&sad`。前面必须是空白，免得误伤 `A&&B` 这类正常文本。 */
const INLINE_TAIL_RE = /\s&&\s*([^&\s\r\n]{1,64})\s*$/

/** 行尾只剩一对孤零零的 `&&`（连键都没有）。 */
const BARE_TAIL_RE = /\s&&\s*$/

/**
 * 黏在正文尾部的半截标记：`正文&&sad`（前面没空白）。
 * 只在键**命中分类表**时才认 —— 没空白就分不清是标记还是正文里的 `&&`，
 * 宁可放过不认识的，也绝不把正常内容截掉。
 */
const GLUED_TAIL_RE = /&&([^&\s\r\n]{1,64})\s*$/

/** 分类键的形态：ASCII 小写标识 或 纯中文。用来给「行尾半截标记」设一道闸。 */
const KEY_SHAPE_RE = /^(?:[a-z][a-z0-9_-]{0,63}|[\u4e00-\u9fa5]{1,16})$/

/** 归一化：去空白 + 转小写。分类键统一按 ASCII 小写 + 中文原样比对。 */
function normalize(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
}

/** 把分类键集合包成便于比对的形态（支持数组 / Set / Map）。 */
function toKeyIndex(keys) {
  if (keys instanceof Set) return keys
  if (keys instanceof Map) return new Set(keys.keys())
  return new Set(Array.isArray(keys) ? keys : [])
}

/**
 * 摘掉回复里的表情标记。
 *
 * 整行只有标记时连这一行一起丢掉 —— 否则模型习惯把标记单独放一行，
 * 群里就会多出一个空行（QQ 上看是"消息末尾悬着一段空白"）。
 *
 * @param {string} text 模型原文
 * @param {Iterable<string>} keys 可用分类键
 * @returns {{text: string, picks: string[], invalid: string[]}}
 *   text  —— 可发出的正文（标记已剥离）
 *   picks —— 命中的分类键，按出现顺序去重
 *   invalid —— 不认识的键，仅用于日志（可以据此调提示词）
 */
export function stripMemeTags(text, keys) {
  const body = String(text ?? '')
  const index = toKeyIndex(keys)
  const picks = []
  const invalid = []
  const out = []

  /** 记一个标记：命中分类表 → picks，否则 → invalid。 */
  const note = (raw) => {
    const key = normalize(raw)
    if (!key) return
    if (index.has(key)) {
      if (!picks.includes(key)) picks.push(key)
    } else if (!invalid.includes(key)) {
      invalid.push(key)
    }
  }

  for (const line of body.split('\n')) {
    let touched = false
    let cleaned = line.replace(TAG_RE, (whole) => {
      touched = true
      note(whole.slice(2, -2))
      return ''
    })

    // 半截标记。模型换 provider 后经常只写 `&&键` 不收尾（见文件头第三条）。
    // 顺序要紧：先看整行是不是只剩标记，再看行尾 —— 否则「&&sad」会被
    // INLINE_TAIL_RE 留下一个前导空格，多出一个空行。
    const lone = LONE_TAIL_RE.exec(cleaned)
    if (lone) {
      touched = true
      note(lone[1])
      continue // 整行就是标记，整行丢弃
    }
    const tail = INLINE_TAIL_RE.exec(cleaned)
    if (tail && KEY_SHAPE_RE.test(normalize(tail[1]))) {
      touched = true
      note(tail[1])
      cleaned = cleaned.slice(0, tail.index)
    } else {
      const bare = BARE_TAIL_RE.exec(cleaned)
      if (bare) {
        touched = true
        cleaned = cleaned.slice(0, bare.index)
      } else {
        const glued = GLUED_TAIL_RE.exec(cleaned)
        if (glued && index.has(normalize(glued[1]))) {
          touched = true
          note(glued[1])
          cleaned = cleaned.slice(0, glued.index)
        }
      }
    }

    if (!touched) {
      out.push(line)
      continue
    }
    // 这一行本来就只是标记 → 整行丢弃；还有正文 → 收尾空格一并清掉。
    // 行内标记摘掉后会留下双空格（"嗯嗯 &&shy&& 别夸了"），顺手合并成一个。
    if (!cleaned.trim()) continue
    out.push(cleaned.replace(/[ \t]{2,}/g, ' ').trimEnd())
  }

  return {
    text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    picks,
    invalid,
  }
}

/**
 * 按上限截断选图。
 *
 * @param {string[]} picks 已去重的分类键
 * @param {number} max 一条回复最多几张
 */
export function limitPicks(picks, max) {
  const n = Number(max)
  if (!Number.isFinite(n) || n <= 0) return []
  return picks.slice(0, Math.max(0, Math.trunc(n)))
}
