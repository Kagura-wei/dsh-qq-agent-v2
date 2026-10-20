/**
 * 历史图片描述测试 —— 覆盖"上下文里的历史图，模型能不能知道画的是什么"。
 *
 * 背景：上下文注入通道只能传字符串（回调是同步的，image 块要先异步落盘），
 * 所以历史里的图到了注入文本里只剩 `[图片]`。这里锁住"补一句描述"的行为，
 * 以及它绝不能反噬主流程（取不到图、没模型、模型报错都必须静默退回占位）。
 *
 * 运行：node test/image-desc-test.mjs
 */
import assert from 'node:assert/strict'
import { renderHistory } from '../lib/content.js'
import { planContext } from '../lib/context.js'
import { ImageDescriber } from '../lib/image-desc.js'

const logger = { info() {}, warn() {}, error() {} }

const IMG_A = { type: 'image', data: { url: 'https://example.com/a.png' } }
const IMG_B = { type: 'image', data: { url: 'https://example.com/b.png' } }
const ATT = { data: new Uint8Array([1, 2, 3, 4]), mediaType: 'image/png' }

const entry = (over = {}) => ({
  seq: 1,
  time: 1700000000,
  senderId: 10001,
  senderName: '雨下雫',
  text: '[图片]',
  segments: [IMG_A],
  read: true,
  ...over,
})

/** 假 llm：记录每次调用，可定时返回固定文本或直接失败。 */
function makeLlm(text = '团战结算截图', { fail = false } = {}) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      if (fail) throw new Error('模型挂了')
      return (async function* () {
        yield { type: 'text-delta', text }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } }
        yield { type: 'finish', reason: 'stop' }
      })()
    },
  }
}

function makeCtx({ llm, attachments, defaultModel } = {}) {
  return {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'attachments') return attachments
      // 路由解析的兜底来源：宿主默认模型（见 llm.js 的 defaultSelection）
      if (name === 'agentDefaultModel') {
        return defaultModel === null
          ? undefined
          : { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
      }
      return undefined
    },
  }
}

const makeAttachments = () => ({
  saved: [],
  async saveImage(input) {
    this.saved.push(input)
    return { attachmentId: `att-${this.saved.length}`, mediaType: input.mediaType }
  },
})

/** 预热命中（图刚下好）。 */
const prefetchHit = { get: async () => ({ hit: true, atts: [ATT] }) }
/** 预热试过并失败：绝不能再自己去下一遍。 */
const prefetchFailed = { get: async () => ({ hit: true, atts: [] }) }
const prefetchMiss = { get: async () => ({ hit: false }) }

{
  // ── 1. renderHistory：描述按出现顺序替换，空描述保留占位 ──
  const entries = [
    entry({ seq: 1, text: '[图片]', segments: [IMG_A] }),
    entry({ seq: 2, text: '看这个 [图片] 和 [图片]', segments: [IMG_A, IMG_B] }),
  ]
  const descMap = new Map([[IMG_A.data.url, '一张团战结算截图']])

  const plain = renderHistory(entries, 'group', 4000)
  assert.ok(plain.includes('雨下雫: [图片]'), '不传 describe 时行为必须与从前一致')
  assert.ok(!plain.includes('[图片:'), '不传 describe 时不该出现描述')

  const withDesc = renderHistory(entries, 'group', 4000, {
    describe: (segment) => (segment.data.url === IMG_A.data.url ? descMap.get(segment.data.url) : undefined),
  })
  assert.ok(withDesc.includes('[图片: 一张团战结算截图]'), '能取到描述的图应带上描述')
  assert.ok(withDesc.includes('和 [图片]'), '没有描述的图保持原占位')
  console.log('✓ renderHistory 描述替换')
}

{
  // ── 2. 描述同样要打散 {{ ，否则会打断整轮装配 ──
  const text = renderHistory([entry()], 'group', 4000, {
    describe: () => '带 {{model}} 的说明',
  })
  assert.ok(!text.includes('{{model}}'), '描述里的模板语法必须被打散')
  console.log('✓ 描述里的 {{ 被打散')
}

{
  // ── 3. planContext 把 describe 透传到每条渲染路径 ──
  const entries = [entry({ seq: 1 })]
  const planned = planContext(entries, {
    scene: 'group',
    maxChars: 4000,
    describe: () => '一只猫',
  })
  assert.ok(planned.recentText.includes('[图片: 一只猫]'), 'planContext 应透传 describe')
  console.log('✓ planContext 透传 describe')
}

{
  // ── 4. ImageDescriber：正常生成 + 缓存复用 ──
  const llm = makeLlm('“这张图是团战结算截图”')
  const attachments = makeAttachments()
  const desc = new ImageDescriber({
    ctx: makeCtx({ llm, attachments }),
    getConfig: () => ({}),
    logger,
    prefetch: prefetchHit,
  })

  const first = await desc.build([entry()])
  assert.equal(typeof first, 'function', '应返回查表函数')
  assert.equal(first(IMG_A), '团战结算截图', '模型输出应被清洗成一句话')
  assert.equal(llm.calls.length, 1)
  assert.equal(attachments.saved.length, 1, '图片要先落盘成附件才能进模型')
  const content = llm.calls[0].messages[0].content
  assert.equal(content[0].type, 'image', '描述调用必须真的把图片放进 messages')
  assert.equal(content[1].type, 'text')

  const second = await desc.build([entry()])
  assert.equal(second(IMG_A), '团战结算截图')
  assert.equal(llm.calls.length, 1, '同一张图第二次应直接复用缓存')
  assert.equal(desc.stats.reused, 1)
  console.log('✓ ImageDescriber 生成 + 缓存复用')
}

{
  // ── 5. 取不到字节：不调模型，保持占位，且不反复重试 ──
  const llm = makeLlm()
  const desc = new ImageDescriber({
    ctx: makeCtx({ llm, attachments: makeAttachments() }),
    getConfig: () => ({}),
    logger,
    prefetch: prefetchFailed,
  })
  assert.equal(await desc.build([entry()]), undefined)
  assert.equal(llm.calls.length, 0, '预热已失败时不该再调模型')
  await desc.build([entry()])
  assert.equal(desc.stats.noBytes, 1, '失败结果要负缓存，不能每轮重试')
  console.log('✓ 取不到图时静默降级')
}

{
  // ── 6. 开关关闭 / 没有 llm / 没有附件服务 / 模型报错，一律退回占位 ──
  const off = new ImageDescriber({
    ctx: makeCtx({ llm: makeLlm(), attachments: makeAttachments() }),
    getConfig: () => ({ contextImageDescEnabled: false }),
    logger,
    prefetch: prefetchHit,
  })
  assert.equal(await off.build([entry()]), undefined, '开关关闭应完全不干活')

  const noLlm = new ImageDescriber({
    ctx: makeCtx({ attachments: makeAttachments() }),
    getConfig: () => ({}),
    logger,
    prefetch: prefetchHit,
  })
  assert.equal(await noLlm.build([entry()]), undefined)

  const noAttach = new ImageDescriber({
    ctx: makeCtx({ llm: makeLlm() }),
    getConfig: () => ({}),
    logger,
    prefetch: prefetchHit,
  })
  assert.equal(await noAttach.build([entry()]), undefined)

  const broken = new ImageDescriber({
    ctx: makeCtx({ llm: makeLlm('x', { fail: true }), attachments: makeAttachments() }),
    getConfig: () => ({}),
    logger,
    prefetch: prefetchHit,
  })
  assert.equal(await broken.build([entry()]), undefined, '模型报错不能冒到调用方')
  console.log('✓ 四种不可用场景都静默退回占位')
}

{
  // ── 7. 每轮限量：只对新图调用，且不超过上限 ──
  const llm = makeLlm('一张图')
  const attachments = makeAttachments()
  const desc = new ImageDescriber({
    ctx: makeCtx({ llm, attachments }),
    getConfig: () => ({ contextImageDescMax: 1 }),
    logger,
    prefetch: prefetchHit,
  })
  const entries = [entry({ seq: 1, segments: [IMG_A] }), entry({ seq: 2, segments: [IMG_B] })]
  await desc.build(entries)
  assert.equal(llm.calls.length, 1, '一轮最多处理 contextImageDescMax 张新图')
  await desc.build(entries)
  assert.equal(llm.calls.length, 2, '下一轮补上剩下那张')
  console.log('✓ 每轮限量，跨轮补齐')
}

{
  // ── 8. 空输出不算描述（避免把"[图片: ]"塞进上下文） ──
  const desc = new ImageDescriber({
    ctx: makeCtx({ llm: makeLlm('   '), attachments: makeAttachments() }),
    getConfig: () => ({}),
    logger,
    prefetch: prefetchHit,
  })
  assert.equal(await desc.build([entry()]), undefined)
  console.log('✓ 空输出退回占位')
}

{
  // ── 9. 未预热的历史图：回落实时下载，失败即降级 ──
  const llm = makeLlm('下载后识别成功')
  const attachments = makeAttachments()
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer,
  })
  const desc = new ImageDescriber({
    ctx: makeCtx({ llm, attachments }),
    getConfig: () => ({}),
    logger,
    prefetch: prefetchMiss,
    fetchImpl,
  })
  const describe = await desc.build([entry()])
  assert.equal(describe(IMG_A), '下载后识别成功')
  console.log('✓ 未预热时回落实时下载')
}

console.log('\n全部通过')
