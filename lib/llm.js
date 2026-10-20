/**
 * 轻量 LLM 通道的公共部分。
 *
 * 判定器（judge.js）与上下文摘要器（summarize.js）都走
 * `ctx.llm.stream()` —— 与"生成会话标题"同一条辅助通道：不装配工具、
 * 不带 agent 系统提示，system 由调用方自己给（几百字）。
 * 两者都要自己消费 chunk 流，这里抽出来共用，避免两份实现各自漂移。
 */

/**
 * 消费 `llm.stream()` 的 chunk 流，拼出文本。
 *
 * 为什么不用 BlockAssembler：这条通道的 chunk 形状很有限（text-delta /
 * block-end / usage / finish），自己拼更省事，也不依赖宿主内部实现。
 *
 * @returns {Promise<{text: string, usage?: object, finish?: string}>}
 */
export async function streamText(llm, options) {
  let text = ''
  let usage
  let finish
  for await (const chunk of llm.stream(options)) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') {
      text += chunk.text ?? ''
      continue
    }
    // 个别适配器不发增量、只在 block-end 里给整块文本。增量已收到时以增量为准
    if (chunk.type === 'block-end' && chunk.block?.type === 'text' && chunk.block.text && !text) {
      text = chunk.block.text
      continue
    }
    // reasoning 块不收：这两条通道都只认正文
    if (chunk.type === 'usage') {
      usage = chunk.usage
      continue
    }
    if (chunk.type === 'finish') {
      finish = chunk.reason
      break
    }
  }
  return { text, usage, finish }
}

export function trimTo(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 解析辅助通道要用的 provider/model。
 *
 * 优先级：该通道的专用配置 > 主会话配置 > 宿主默认模型。
 * 共用默认模型是合理起点 —— 真正省的是"不带工具与系统提示"；
 * 但用户愿意指定更便宜的小模型时，成本还能再降一个数量级。
 */
export function resolveAuxRoute(ctx, cfg, { providerKey, modelKey }) {
  const provider = trimTo(cfg?.[providerKey]) || trimTo(cfg?.provider) || defaultSelection(ctx)?.provider
  const model = trimTo(cfg?.[modelKey]) || trimTo(cfg?.model) || defaultSelection(ctx)?.model
  if (!provider || !model) return undefined
  return { provider, model }
}

/** 取宿主默认模型选择；服务不可用时返回 undefined（由调用方降级）。 */
export function defaultSelection(ctx) {
  try {
    const service = ctx?.get?.('agentDefaultModel')
    if (service && typeof service.currentSelection === 'function') {
      return service.currentSelection()
    }
  } catch {
    /* 取不到就走调用方的降级路径 */
  }
  return undefined
}

/**
 * 取轻量通道服务。用 `ctx.get?.()` 而不是进 `inject` ——
 * 这两条通道都是可选能力，缺失时应当降级而不是让插件装配失败。
 */
export function auxLlm(ctx) {
  const llm = ctx?.get?.('llm')
  return llm && typeof llm.stream === 'function' ? llm : undefined
}
