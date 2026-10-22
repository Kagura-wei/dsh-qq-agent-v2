/**
 * 视频抽帧测试 —— 覆盖"群里的视频模型能不能看见"这条链路。
 *
 * 模型的输入通道只有 text / image，没有视频。可行的做法是收到消息时立刻下载、
 * 用 ffmpeg 抽几帧当图片送进去；抽不出来就退回 `[视频]` 占位。
 *
 * 这里只测纯逻辑与装配分支（不依赖宿主机真的装了 ffmpeg）：
 *   - 抽帧时间点规划、缩放尺寸
 *   - 没有可下载地址 / 文件超限时的快速返回
 *   - buildRichContent 里视频段的三种结局：帧进模型 / 占位 / 开关关闭
 *
 * 运行：node test/video-test.mjs
 */
import assert from 'node:assert/strict'
import { planFrameTimes, scaleFrame, toVideoFrames } from '../lib/video.js'
import { buildRichContent } from '../lib/content.js'

const logger = { info() {}, warn() {}, error() {} }
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])

// ── 1. 抽帧时间点 ──────────────────────────────────────────────
assert.deepEqual(planFrameTimes(30, 2), [10, 20], '2 帧 → 1/3、2/3 处')
assert.deepEqual(planFrameTimes(30, 1), [15])
assert.deepEqual(planFrameTimes(4, 3), [1, 2, 3])
// 太短的视频：不要贴着末尾抽（末尾常常已经黑屏）
assert.deepEqual(planFrameTimes(0.2, 2), [0.07, 0.1])
// 时长拿不到 → 只抽第一帧
assert.deepEqual(planFrameTimes(0, 2), [0])
assert.deepEqual(planFrameTimes(undefined, 2), [0])
// 帧数被夹在 1..6
assert.equal(planFrameTimes(60, 0).length, 1)
assert.equal(planFrameTimes(60, 99).length, 6)

// ── 2. 缩放 ────────────────────────────────────────────────────
assert.deepEqual(scaleFrame(1920, 1080), { width: 1024, height: 576 })
assert.deepEqual(scaleFrame(640, 480), { width: 640, height: 480 }, '本来就小就不动它')
assert.equal(scaleFrame(0, 0), undefined)
// yuv420 要求偶数边长
assert.equal(scaleFrame(4000, 3001).height % 2, 0)

// ── 3. 拿不到视频时快速返回空数组（不抛错） ────────────────────
assert.deepEqual(await toVideoFrames({ type: 'video', data: { file: 'a.mp4' } }, { logger }), [], '没有可下载地址')
assert.deepEqual(
  await toVideoFrames(
    { type: 'video', data: { url: 'https://x/y.mp4', file_size: String(200 * 1024 * 1024) } },
    { logger }
  ),
  [],
  '声明大小超过上限时不该下载'
)

// ── 4. 装配：预热命中 → 帧作为 image 块进模型 ──────────────────
{
  const saved = []
  const attachments = {
    imageLimits: { maxImagesPerMessage: 4 },
    saveImage: async (input) => {
      saved.push(input)
      return { attachmentId: `att-${saved.length}`, mediaType: input.mediaType }
    },
  }
  const frames = [
    { data: JPEG, mediaType: 'image/jpeg', name: 'video-frame-1.jpg' },
    { data: JPEG, mediaType: 'image/jpeg', name: 'video-frame-2.jpg' },
  ]
  const videoSeg = { type: 'video', data: { url: 'https://cdn/x.mp4', file_size: '5894555' } }
  const { content, images, videos } = await buildRichContent(
    [{ senderName: '小丑', text: '[视频]', segments: [videoSeg] }],
    'group',
    { attachments, prefetch: { get: async () => ({ hit: true, atts: frames }) }, logger }
  )
  assert.equal(images, 2)
  assert.equal(videos, 1)
  const imageBlocks = content.filter((c) => c.type === 'image')
  assert.equal(imageBlocks.length, 2, '两帧都要进 content')
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('')
  assert.match(text, /\[视频帧 1\/2\]/, '要标明这两张图来自同一个视频')
  assert.match(text, /\[视频帧 2\/2\]/)
  assert.equal(saved.length, 2)
}

// ── 5. 装配：预热失败（负缓存）→ 只留 [视频] 占位，不再重试 ────
{
  const attachments = { imageLimits: { maxImagesPerMessage: 4 }, saveImage: async () => ({}) }
  let fetchCalls = 0
  const { content, images, videos } = await buildRichContent(
    [{ senderName: '甲', text: '[视频]', segments: [{ type: 'video', data: { url: 'https://cdn/y.mp4' } }] }],
    'group',
    {
      attachments,
      // hit=true + 空 atts = 已知失败，调用方不该再自己下一遍
      prefetch: { get: async () => ({ hit: true, atts: [] }) },
      fetchImpl: async () => {
        fetchCalls++
        return { ok: true, arrayBuffer: async () => JPEG.buffer.slice(0) }
      },
      logger,
    }
  )
  assert.equal(fetchCalls, 0, '负缓存命中时不该再去下载')
  assert.equal(images, 0)
  assert.equal(videos, 0)
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('')
  assert.match(text, /\[视频\]/, '抽不出帧也要让模型知道这里本来有段视频')
}

// ── 6. 装配：videoEnabled=false → 完全不进模型 ──────────────────
{
  const attachments = { imageLimits: { maxImagesPerMessage: 4 }, saveImage: async () => ({}) }
  const { content, images } = await buildRichContent(
    [{ senderName: '甲', text: '', segments: [{ type: 'video', data: { url: 'https://cdn/z.mp4' } }] }],
    'group',
    { attachments, prefetch: { get: async () => ({ hit: true, atts: [{ data: JPEG, mediaType: 'image/jpeg' }] }) }, videoEnabled: false, logger }
  )
  assert.equal(images, 0)
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('')
  assert.match(text, /\[视频\]/)
}

// ── 7. 配额：图片先占满 4 张后，视频帧不再挤进去 ────────────────
{
  const saved = []
  const attachments = {
    imageLimits: { maxImagesPerMessage: 4 },
    saveImage: async (i) => {
      saved.push(i)
      return { attachmentId: `a${saved.length}` }
    },
  }
  const img = (n) => ({ type: 'image', data: { url: `https://cdn/${n}.jpg` } })
  const { images } = await buildRichContent(
    [{ senderName: '甲', text: '', segments: [img(1), img(2), img(3), img(4), { type: 'video', data: { url: 'https://cdn/v.mp4' } }] }],
    'group',
    {
      attachments,
      prefetch: { get: async () => ({ hit: true, atts: [{ data: JPEG, mediaType: 'image/jpeg' }] }) },
      logger,
    }
  )
  assert.equal(images, 4, '不能超过单条消息的图片配额')
}

console.log('video-test: 全部通过')
