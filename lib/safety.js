/**
 * 出站内容检查。
 *
 * 门控管的是"要不要回"，这里管的是"这条回复能不能发出去"。两者必须分开：
 * 模型偶尔会复述系统提示原文（哪怕提示词里明确禁止），也可能说出管理员
 * 不希望出现在群里的词。发出去就收不回来了，所以出站必须过一道闸。
 *
 * 三类检查：
 *   1. 提示词泄漏 —— 内置、始终生效。命中就丢弃，绝不发出。
 *   2. 推理泄漏 —— 内置、始终生效。模型把"内心盘算"当正文吐出来，
 *      详见 REASONING_LEAK_PATTERNS 的注释（这是两套完全不同的特征）。
 *   3. 自定义屏蔽词 —— 由管理员配置（outboundBlockWords）。默认空表：
 *      不预设任何词汇，避免替用户做价值判断。
 */

/**
 * 提示词泄漏指纹。
 *
 * 取的是本插件自己注入的 section 标题与几处标志性说法 —— 它们只可能出现在
 * 系统提示里，正常聊天不会有人这么说话。命中即视为泄漏。
 */
export const LEAK_PATTERNS = [
  /【角色设定/,
  /【安全边界/,
  /【你的处境/,
  /【参与度：/,
  /【@ 别人】/,
  /【联网查证】/,
  /【本次是「?接话/,
  /系统提示(词)?(原文|内容)/,
  /我的(系统)?(提示词|instruction)/i,
  /SYSTEM PROMPT/i,
]

/**
 * 推理泄漏指纹（reasoning 被当成正文吐出来）。
 *
 * 为什么需要单独一套 —— 这类泄漏**不包含任何系统提示原文**，它包含的是
 * 模型对局势的英文盘算和对自己的指令，所以上面那批中文 section 标题一个都
 * 命中不了。2026-10-22 群里那两条就是活例子：
 *
 *   "乙 says honestly they'd get excited seeing any 国乒 player. Casual,
 *    not addressed to me — participation medium. A light short comment could
 *    fit: 见到谁都激动… / Keep it very short.这心态挺好…"
 *
 * 这种文本有个共同点：**在描述"我该怎么回"**，而不是在回复。正常群聊里
 * 不会有人用英文写"这不是在跟我说话""参与度中等""让我回一句"。
 *
 * 所以判据取的是"元话语"（metadiscourse），而不是任何具体的业务词：
 *   - 判断消息是不是冲自己来的（not addressed to me）
 *   - 复述参与度档位（participation medium —— 这是把【参与度：中】英译了）
 *   - 对篇幅下指令（Keep it short / Keep it very short）
 *   - 自问自答该用什么语气（I could reply / Let me reply / Best: brief）
 *   - 给回复打草稿（Something short: "…"）
 */
export const REASONING_LEAK_PATTERNS = [
  /\bnot addressed to (me|us)\b/i,
  /\bis addressed to (me|us)\b/i,
  /\bparticipation (level )?(low|medium|high)\b/i,
  /\bkeep (it|this|the reply) (very )?short\b/i,
  /\b(I|I'd|I'll|I can|I could|I should|let me) (just )?(reply|respond|comment|answer|ack)\b/i,
  /\b(let me|I'll|I will) (just )?(reply|respond|say)\b/i,
  /\b(a |a light |a short )?comment could fit\b/i,
  /\bsomething short\s*:\s*["“]/i,
  /\bnow respond to\b/i,
  /\bthis is a (接话|participation|follow-?up) turn\b/i,
  /\b(brief|short)[, ]+non-?confrontational\b/i,
  /^\s*(best|reply|answer)\s*:\s/im,
  /\bthey(?:'d| would) get excited\b/i,
]

/** 复合判据的触发词：只有"在安排怎么回"才会用到的词。 */
const METADISCOURSE_HINT = /\b(reply|respond|comment|addressed|participation|turn|casual)\b/i

/**
 * 判断一段文本是不是"模型的自言自语"（而不是给人看的话）。
 *
 * 字面指纹先过一遍；没命中再走复合判据 —— 有些泄漏写得很随意，凑不全上面
 * 任何一整句，但整体形态骗不了人：**英文占大头，且通篇在安排怎么回**。
 *
 * 复合判据刻意设得保守（≥25 个英文词、英文占比 ≥45%）。正常中文聊天里
 * 不会出现这种密度的英文；而真正的英文提问由用户发出、模型回的还是中文，
 * 不会撞上 METADISCOURSE_HINT。
 */
export function looksLikeReasoningLeak(body) {
  const text = String(body ?? '')
  if (!text.trim()) return { leak: false }

  for (const pattern of REASONING_LEAK_PATTERNS) {
    if (pattern.test(text)) return { leak: true, detail: String(pattern) }
  }

  const latin = text.match(/[A-Za-z][A-Za-z']*/g) ?? []
  const cjk = text.match(/[\u4e00-\u9fff]/g) ?? []
  const total = latin.length + cjk.length
  if (latin.length >= 25 && total > 0 && latin.length / total >= 0.45 && METADISCOURSE_HINT.test(text)) {
    return {
      leak: true,
      detail: `英文主导 ${latin.length}/${total} 词且含元话语`,
    }
  }

  return { leak: false }
}

/**
 * 检查一条待发出的回复。
 *
 * @param {string} text 面向用户的可读文本（不含内部 at 占位符）
 * @param {{words?: string[], reasoningLeakEnabled?: boolean}} options
 *   words —— 自定义屏蔽词
 *   reasoningLeakEnabled —— 是否检查推理泄漏（默认开；只在排障时关）
 * @returns {{ok: boolean, reason?: 'leak'|'reasoning-leak'|'word', detail?: string}}
 */
export function checkOutbound(text, { words = [], reasoningLeakEnabled = true } = {}) {
  const body = String(text ?? '')
  if (!body.trim()) return { ok: true }

  for (const pattern of LEAK_PATTERNS) {
    if (pattern.test(body)) return { ok: false, reason: 'leak', detail: String(pattern) }
  }

  if (reasoningLeakEnabled) {
    const probe = looksLikeReasoningLeak(body)
    if (probe.leak) return { ok: false, reason: 'reasoning-leak', detail: probe.detail }
  }

  for (const raw of words ?? []) {
    const word = String(raw ?? '').trim()
    if (word && body.includes(word)) return { ok: false, reason: 'word', detail: word }
  }

  return { ok: true }
}
