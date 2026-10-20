/**
 * 图片入模型测试 —— 覆盖"群里发图，模型能不能看见"这条链路。
 *
 * 线上故障：机器人回复"只看到图片的框"，因为 [图片] 只是文字占位符，
 * 图片本体从没进过模型。这里锁住正确行为。
 *
 * 运行：node test/content-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRichContent, buildUserInput, renderHistory } from '../lib/content.js'
import { sniffMediaType, toImageAttachment } from '../lib/image.js'
import { Archive, trimSegments } from '../lib/store.js'

const logger = { info() {}, warn() {}, error() {} }

/** 一个最小合法 PNG 头。 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])

const okFetch = async () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => PNG.buffer.slice(0),
})
const failFetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })

/** 假附件仓库，记录存进来的图。 */
function makeAttachments(limit = 4) {
  const saved = []
  return {
    saved,
    imageLimits: { maxImagesPerMessage: limit },
    saveImage: async (input) => {
      saved.push(input)
      return {
        attachmentId: `att-${saved.length}`,
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 1,
        height: 1,
      }
    },
  }
}

const msg = (over = {}) => ({
  senderName: '张三',
  senderId: 1,
  text: '',
  segments: [],
  ...over,
})

let passed = 0
function check(label, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${label}`)
  } catch (error) {
    console.error(`  FAIL ${label}: ${error.message}`)
    process.exitCode = 1
  }
}
async function checkAsync(label, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${label}`)
  } catch (error) {
    console.error(`  FAIL ${label}: ${error.message}`)
    process.exitCode = 1
  }
}

console.log('\n[图片] 媒体类型识别')
check('识别 PNG', () => assert.equal(sniffMediaType(PNG), 'image/png'))
check('识别 JPEG', () => assert.equal(sniffMediaType(JPEG), 'image/jpeg'))
check('识别 GIF', () =>
  assert.equal(sniffMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])), 'image/gif')
)
check('识别 WebP', () =>
  assert.equal(
    sniffMediaType(
      new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])
    ),
    'image/webp'
  )
)
check('不是图片返回 undefined', () => assert.equal(sniffMediaType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), undefined))

console.log('\n[图片] 从 OneBot 段取字节')
await checkAsync('http url 走 fetch', async () => {
  const att = await toImageAttachment({ type: 'image', data: { url: 'http://x/a.png' } }, { fetchImpl: okFetch, logger })
  assert.ok(att, '应取到附件')
  assert.equal(att.mediaType, 'image/png', '应按魔数判定类型')
})
await checkAsync('base64:// 直接解码', async () => {
  const b64 = Buffer.from(PNG).toString('base64')
  const att = await toImageAttachment({ type: 'image', data: { file: `base64://${b64}` } }, { logger })
  assert.ok(att, '应取到附件')
  assert.equal(att.mediaType, 'image/png')
})
await checkAsync('fetch 失败返回 undefined（交给调用方降级）', async () => {
  const att = await toImageAttachment({ type: 'image', data: { url: 'http://x/a.png' } }, { fetchImpl: failFetch, logger })
  assert.equal(att, undefined)
})
await checkAsync('url 为空且 file 不可读时返回 undefined', async () => {
  const att = await toImageAttachment({ type: 'image', data: { url: '', file: 'not-a-path.jpg' } }, { logger })
  assert.equal(att, undefined)
})

console.log('\n[图片] 组装模型输入')
await checkAsync('纯文本消息不产生 image 块', async () => {
  const { content, images } = await buildRichContent(
    [msg({ text: '你好', segments: [{ type: 'text', data: { text: '你好' } }] })],
    'group',
    { attachments: makeAttachments(), logger }
  )
  assert.equal(images, 0)
  assert.equal(content.filter((b) => b.type === 'image').length, 0)
  assert.ok(content[0].text.includes('张三: 你好'))
})

await checkAsync('图片按原位置插进 content（这是本次故障的修复点）', async () => {
  const attachments = makeAttachments()
  const { content, images } = await buildRichContent(
    [
      msg({
        segments: [
          { type: 'image', data: { url: 'http://x/1.png' } },
          { type: 'text', data: { text: '能看到图片么？' } },
          { type: 'image', data: { url: 'http://x/2.png' } },
        ],
      }),
    ],
    'group',
    { attachments, logger, fetchImpl: okFetch }
  )
  assert.equal(images, 2, '应带入 2 张图')
  assert.equal(attachments.saved.length, 2, '两张都应落盘')
  const kinds = content.map((b) => b.type)
  assert.deepEqual(kinds, ['text', 'image', 'text', 'image', 'text'], `实际 ${kinds.join(',')}`)
  // 文字要在两张图之间，位置不能乱
  assert.ok(content[2].text.includes('能看到图片么？'), '文字应夹在两张图中间')
})

await checkAsync('图片块带的是附件引用而不是 URL', async () => {
  const { content } = await buildRichContent([msg({ segments: [{ type: 'image', data: { url: 'http://x/1.png' } }] })], 'group', {
    attachments: makeAttachments(),
    logger,
    fetchImpl: okFetch,
  })
  const imageBlock = content.find((b) => b.type === 'image')
  assert.ok(imageBlock.attachment, '应带 attachment 字段')
  assert.equal(imageBlock.attachment.attachmentId, 'att-1')
})

await checkAsync('下载失败时退回 [图片] 占位，不影响文字', async () => {
  const { content, images, dropped } = await buildRichContent(
    [
      msg({
        segments: [
          { type: 'image', data: { url: 'http://x/1.png' } },
          { type: 'text', data: { text: '看看这张' } },
        ],
      }),
    ],
    'group',
    { attachments: makeAttachments(), logger, fetchImpl: failFetch }
  )
  assert.equal(images, 0)
  assert.equal(dropped, 1, '应记一笔失败')
  assert.ok(content[0].text.includes('[图片]'), '应保留占位符')
  assert.ok(content[0].text.includes('看看这张'), '文字不能丢')
})

await checkAsync('没有附件服务时全部走占位符', async () => {
  const { content, images } = await buildRichContent(
    [msg({ segments: [{ type: 'image', data: { url: 'http://x/1.png' } }] })],
    'group',
    { logger }
  )
  assert.equal(images, 0)
  assert.ok(content[0].text.includes('[图片]'))
})

await checkAsync('超过单条消息图片配额时截断', async () => {
  const attachments = makeAttachments(2)
  const segments = Array.from({ length: 5 }, (_, i) => ({ type: 'image', data: { url: `http://x/${i}.png` } }))
  const { content, images } = await buildRichContent([msg({ segments })], 'group', {
    attachments,
    logger,
    fetchImpl: okFetch,
  })
  assert.equal(images, 2, '应受 maxImagesPerMessage 限制')
  assert.equal(content.filter((b) => b.type === 'image').length, 2)
})

await checkAsync('纯图片消息 content 不为空', async () => {
  const { content } = await buildRichContent([msg({ segments: [{ type: 'image', data: { url: 'http://x/1.png' } }] })], 'group', {
    attachments: makeAttachments(),
    logger,
    fetchImpl: okFetch,
  })
  assert.ok(content.length > 0, 'content 不能是空数组')
})

await checkAsync('私聊不显示对方 ID', async () => {
  const { content } = await buildRichContent([msg({ senderName: '', senderId: 99, text: 'hi', segments: [{ type: 'text', data: { text: 'hi' } }] })], 'private', {
    attachments: makeAttachments(),
    logger,
  })
  const text = content.map((b) => b.text ?? '').join('')
  assert.ok(text.includes('对方: hi'), `实际: ${text}`)
})

console.log('\n[图片] 纯文本降级路径')
check('buildUserInput 仍然可用（回归）', () => {
  const s = buildUserInput([{ senderName: '张三', senderId: 1, text: 'hi' }], 'group')
  assert.equal(s, '张三: hi')
})
check('buildUserInput 不再重复 [图片]', () => {
  // text 里已经含 [图片]，旧实现又拼了一次
  const s = buildUserInput([{ senderName: '张三', senderId: 1, text: '[图片]' }], 'group')
  assert.equal(s, '张三: [图片]')
})

console.log('\n[上下文] 聊天记录渲染成纯文本（交给 systemPrompt 注入）')
check('逐条按"说话人: 内容"渲染', () => {
  const text = renderHistory(
    [
      { senderName: '甲', senderId: 1, text: '今天打游戏' },
      { senderName: '乙', senderId: 2, text: '光缆断了' },
    ],
    'group'
  )
  assert.equal(text, '甲: 今天打游戏\n乙: 光缆断了')
})
check('跳过空消息（纯图片/表情不会留下空行）', () => {
  const text = renderHistory(
    [
      { senderName: '甲', senderId: 1, text: '[图片]' },
      { senderName: '乙', senderId: 2, text: '  ' },
      { senderName: '丙', senderId: 3, text: '真的' },
    ],
    'group'
  )
  assert.equal(text, '甲: [图片]\n丙: 真的')
})
check('超出字符上限时丢最旧的、保住最近的', () => {
  const entries = [
    { senderName: '甲', senderId: 1, text: 'x'.repeat(100) },
    { senderName: '乙', senderId: 2, text: 'y'.repeat(100) },
    { senderName: '丙', senderId: 3, text: 'z'.repeat(100) },
  ]
  const text = renderHistory(entries, 'group', 120)
  assert.ok(!text.includes('甲:'), '最旧的应被丢掉')
  assert.ok(text.includes('丙:'), '最近的一定要在')
})
check('单条就超限也至少保留一条（不能整个空掉）', () => {
  const text = renderHistory([{ senderName: '甲', senderId: 1, text: 'x'.repeat(500) }], 'group', 50)
  assert.ok(text.includes('甲:'), '至少保住一条')
})
check('没有内容时返回空串（不注入空块）', () => {
  assert.equal(renderHistory([], 'group'), '')
  assert.equal(renderHistory(undefined, 'group'), '')
  assert.equal(renderHistory([{ text: '' }], 'group'), '')
})
check('私聊不显示对方 ID', () => {
  const text = renderHistory([{ senderName: '', senderId: 99, text: 'hi' }], 'private')
  assert.equal(text, '对方: hi')
})
check('打散 {{ }} 防止被当成提示词变量', () => {
  // DSH 装配时会插值上下文里的 {{name}}，查不到值就抛错 —— 整轮跟着失败。
  // 群里有人贴 {{model}} 或模板代码是常事，必须先打散。
  const text = renderHistory([{ senderName: '甲', senderId: 1, text: '看这个 {{model}} 怎么用' }], 'group')
  assert.ok(!text.includes('{{'), `仍含连续双花括号: ${JSON.stringify(text)}`)
  assert.ok(text.includes('model'), '文字本身不能丢')
})

console.log('\n[图片] 存档裁剪（不能把几 MB 的 base64 写进磁盘）')
check('保留 http url', () => {
  const out = trimSegments([{ type: 'image', data: { url: 'http://x/a.png', file: 'a.png' } }])
  assert.equal(out[0].data.url, 'http://x/a.png')
  assert.equal(out[0].data.file, undefined, '非 base64 的 file 不必留')
})
check('小 base64 内联保留', () => {
  const file = `base64://${'A'.repeat(1000)}`
  const out = trimSegments([{ type: 'image', data: { file } }])
  assert.equal(out[0].data.file, file, '小图应保住，否则取不到图')
})
check('超大 base64 丢弃但保留 image 标记', () => {
  const file = `base64://${'A'.repeat(600 * 1024)}`
  const out = trimSegments([{ type: 'image', data: { file } }])
  assert.equal(out[0].type, 'image', '类型要留着，下游才知道这里有图')
  assert.equal(out[0].data.file, undefined, '大图不该写进存档')
})
check('文本/at 段照常保留', () => {
  const out = trimSegments([
    { type: 'text', data: { text: 'hi' } },
    { type: 'at', data: { qq: '123', name: 'x' } },
  ])
  assert.equal(out[0].data.text, 'hi')
  assert.equal(out[1].data.qq, '123')
})
check('空数组返回 undefined', () => assert.equal(trimSegments([]), undefined))

console.log('\n[图片] 存档落库（本次故障的修复点：segments 曾被丢弃）')
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-content-'))
  const archive = new Archive({ dir: tmp, logger })
  await archive.init()

  await archive.append('group:1', {
    time: 1,
    senderId: 1,
    senderName: '张三',
    text: '[图片]看这个',
    hasImage: true,
    segments: [
      { type: 'image', data: { url: 'http://x/a.png' } },
      { type: 'text', data: { text: '看这个' } },
    ],
  })
  const unread = await archive.getUnread('group:1', 10)

  check('存档把 segments 一起写进去了', () => {
    assert.ok(Array.isArray(unread[0].segments), 'segments 必须留，否则图永远进不了模型')
    assert.equal(unread[0].segments.length, 2)
    assert.equal(unread[0].segments[0].type, 'image')
    assert.equal(unread[0].segments[0].data.url, 'http://x/a.png')
  })

  await checkAsync('从存档取回的消息能被组装成 image 块', async () => {
    const attachments = makeAttachments()
    const { content, images } = await buildRichContent(unread, 'group', {
      attachments,
      logger,
      fetchImpl: okFetch,
    })
    assert.equal(images, 1, '存档 → 取图 → 入模型，这条链要通')
    assert.equal(content.filter((b) => b.type === 'image').length, 1)
  })

  await archive.stop()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

console.log(`\n通过 ${passed} 项\n`)
