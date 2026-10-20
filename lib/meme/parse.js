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
 * 纯函数，不碰文件也不碰网络，便于单测。
 */

/** 标记本体。键长上限 64：分类键是包作者定义的短标识，没有更长的道理。 */
const TAG_RE = /&&[^&\r\n]{0,64}&&/g

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

  for (const line of body.split('\n')) {
    let touched = false
    const cleaned = line.replace(TAG_RE, (whole) => {
      touched = true
      const raw = normalize(whole.slice(2, -2))
      if (!raw) return ''
      if (index.has(raw)) {
        if (!picks.includes(raw)) picks.push(raw)
      } else if (!invalid.includes(raw)) {
        invalid.push(raw)
      }
      return ''
    })

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
