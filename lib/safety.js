/**
 * 出站内容检查。
 *
 * 门控管的是"要不要回"，这里管的是"这条回复能不能发出去"。两者必须分开：
 * 模型偶尔会复述系统提示原文（哪怕提示词里明确禁止），也可能说出管理员
 * 不希望出现在群里的词。发出去就收不回来了，所以出站必须过一道闸。
 *
 * 两类检查：
 *   1. 提示词泄漏 —— 内置、始终生效。命中就丢弃，绝不发出（宁可这一轮不说话，
 *      也不能把系统提示暴露给群友）。
 *   2. 自定义屏蔽词 —— 由管理员配置（outboundBlockWords）。默认空表：
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
 * 检查一条待发出的回复。
 *
 * @param {string} text 面向用户的可读文本（不含内部 at 占位符）
 * @param {{words?: string[]}} options 自定义屏蔽词
 * @returns {{ok: boolean, reason?: 'leak'|'word', detail?: string}}
 */
export function checkOutbound(text, { words = [] } = {}) {
  const body = String(text ?? '')
  if (!body.trim()) return { ok: true }

  for (const pattern of LEAK_PATTERNS) {
    if (pattern.test(body)) return { ok: false, reason: 'leak', detail: String(pattern) }
  }

  for (const raw of words ?? []) {
    const word = String(raw ?? '').trim()
    if (word && body.includes(word)) return { ok: false, reason: 'word', detail: word }
  }

  return { ok: true }
}
