/**
 * 上下文规划：按「轮」保留 + 超阈值才交给摘要器。
 *
 * 旧实现是"按字符数从最旧的开始丢"，问题有两个：
 *   1. 丢在半句上 —— 一轮对话被劈成两半，模型看到半截提问，会去答已经答过的事；
 *   2. 丢了就永久没了 —— 群里聊到一半的话题背景凭空消失。
 *
 * 现在的规则（对齐 AstrBot 的 enforce_max_turns → 压缩 → 兜底截断三层）：
 *   - **按轮切**（同一段连续对话算一轮），永不切开一轮；
 *   - **最新一轮永远完整保留**，哪怕它自己就超预算 —— 它才是"现在在聊什么"；
 *   - 预算还装得下的旧轮次继续保留，装不下的交给摘要器压成一段话；
 *   - 摘要器不可用时退回纯截断（有损但不会失败）。
 *
 * 「轮」的划法：我们手里只有收到的消息（自己的回复不进存档），所以用
 * **时间间隔**切：相邻两条消息间隔超过 gapMs 就算新的一轮。这一条在群聊里
 * 相当准 —— 一顿饭之后再说的话，本来就是新话题。
 */
import { renderHistory } from './content.js'

/** 预算里留给摘要的份额：摘要本身也要占地方，别把最近的记录挤没了。 */
const DEFAULT_SUMMARY_BUDGET = 800

/** 粗估 token：CJK 一字约一 token，其余按 4 字符一 token。 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  let cjk = 0
  for (const ch of s) {
    const code = ch.codePointAt(0)
    if (code >= 0x2e80 && code <= 0x9fff) cjk++
  }
  return cjk + Math.ceil((s.length - cjk) / 4)
}

/**
 * 按时间间隔把消息切成「轮」。
 *
 * @param {Array} entries 按时间正序
 * @param {{gapMs?: number}} options
 * @returns {Array<Array>} 轮的数组，按时间正序
 */
export function splitRounds(entries, { gapMs = 5 * 60_000 } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const rounds = []
  let current = []
  let prevTime = 0
  for (const m of list) {
    const t = Number(m?.time ?? 0) * 1000
    if (current.length && Number.isFinite(t) && Number.isFinite(prevTime) && t - prevTime > gapMs) {
      rounds.push(current)
      current = []
    }
    current.push(m)
    if (Number.isFinite(t)) prevTime = t
  }
  if (current.length) rounds.push(current)
  return rounds
}

/**
 * 规划注入内容。
 *
 * @param {Array} entries 按时间正序的存档条目
 * @param {{scene?: string, maxChars?: number, gapMs?: number, summaryBudget?: number,
 *   describe?: (segment: object, msg: object) => string|undefined}} options
 *   describe 原样透传给 renderHistory —— 给历史里的图配一句话描述（见 image-desc.js）
 * @returns {{recentText: string, oldEntries: Array, over: boolean, chars: number}}
 *   oldEntries 非空表示需要摘要；over=true 表示确实超了预算（此时才值得花钱摘要）
 */
export function planContext(entries, { scene = 'group', maxChars = 4000, gapMs = 5 * 60_000, summaryBudget = DEFAULT_SUMMARY_BUDGET, describe } = {}) {
  const list = (entries ?? []).filter((m) => String(m?.text ?? '').trim())
  if (!list.length) return { recentText: '', oldEntries: [], over: false, chars: 0 }

  // 先算"完全不设限"的长度再判断是否超预算。
  // 不能拿 renderHistory(list, maxChars) 的结果去比 —— 它本身就是被截过的，
  // 比出来永远"没超"，摘要分支就永远不会触发。
  const rawText = renderHistory(list, scene, Number.MAX_SAFE_INTEGER, { describe })
  if (rawText.length <= maxChars) {
    return { recentText: rawText, oldEntries: [], over: false, chars: rawText.length }
  }

  const rounds = splitRounds(list, { gapMs })
  if (rounds.length <= 1) {
    // 全部内容只在同一轮里 —— 没有"较旧的轮"可摘要，只能按字符截断
    const truncated = renderHistory(list, scene, maxChars, { describe })
    return { recentText: truncated, oldEntries: [], over: true, chars: truncated.length }
  }

  // 最新一轮永远完整保留：渲染时不设上限
  const lastRound = rounds[rounds.length - 1]
  const lastText = renderHistory(lastRound, scene, Number.MAX_SAFE_INTEGER, { describe })
  const budget = Math.max(400, maxChars - summaryBudget)

  const kept = [lastText]
  let keptChars = lastText.length
  let index = rounds.length - 2
  for (; index >= 0; index--) {
    const text = renderHistory(rounds[index], scene, Number.MAX_SAFE_INTEGER, { describe })
    if (keptChars + text.length + 1 > budget) break
    kept.unshift(text)
    keptChars += text.length + 1
  }

  const oldEntries = rounds.slice(0, index + 1).flat()
  const recentText = kept.join('\n')
  return { recentText, oldEntries, over: true, chars: recentText.length }
}
