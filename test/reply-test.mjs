/**
 * 引用消息展开测试 —— 覆盖「群友引用一条消息再说话，模型能不能看到被引用的内容」。
 *
 * 线上故障（2026-10-22，群 100000001）：群友引用了一条转发消息再 @菲比，
 * 它只回「在，刚被某人勾着魂呢，有啥事」—— reply 段里只有一个消息号，
 * 被引用的内容从没进过它的视野。
 *
 * 样本取自线上故障当场的存档形态（seq 12364 / messageId 90001，说话人「甲」，
 * 内容是一条 3 条的转发，里面夹一个 7.8MB 视频）—— 结构照实，群号、QQ 号、
 * 昵称与原文均已替换为假数据。
 *
 * 运行：node test/reply-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expandReplies, hasReply, replyIdOf } from '../lib/reply.js'
import { expandForwards } from '../lib/forward.js'
import { segmentsToText } from '../lib/text.js'
import { Archive } from '../lib/store.js'

const logger = { info() {}, warn() {}, error() {} }

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ✓ ${name}`)
}

/** 真机存档里被引用的那条（截取前半，保住"文字 + 视频混排"这个关键形态）。 */
const REAL_REPLIED = {
  seq: 12364,
  messageId: 90001,
  senderName: '甲',
  senderId: 10003,
  text: '[聊天记录 3 条]\nQQ用户: 〔转发 7 条〕…',
  segments: [
    { type: 'text', data: { text: '[聊天记录 3 条]' } },
    { type: 'text', data: { text: '\nQQ用户: ' } },
    { type: 'text', data: { text: '〔转发 7 条〕' } },
    { type: 'text', data: { text: '\n  QQ用户: ' } },
    {
      type: 'video',
      data: {
        url: 'https://multimedia.nt.qq.com.cn/download?appid=1415&rkey=xxx',
        file: '7bf4a935e70f38febaaceb4348069a76.mp4',
        file_size: '7843870',
      },
    },
    { type: 'text', data: { text: '\n  QQ用户: ' } },
    { type: 'text', data: { text: '啊啊啊这段水花溅得也太高了吧' } },
    { type: 'text', data: { text: '\nQQ用户: ' } },
    { type: 'text', data: { text: '[卡片: 欢迎加入某群]' } },
  ],
}

const replySeg = (id) => ({ type: 'reply', data: { id: String(id) } })

// ── 1. 基础识别 ──
{
  assert.equal(replyIdOf(replySeg(1234567890)), 1234567890)
  assert.equal(replyIdOf({ type: 'reply', data: { message_id: '987' } }), 987, '部分实现用 message_id')
  assert.equal(replyIdOf({ type: 'text', data: { text: 'hi' } }), 0)
  assert.equal(replyIdOf({ type: 'reply', data: {} }), 0, '没有 id 就是取不到')
  ok('replyIdOf 认 id / message_id，无 id 返回 0')

  assert.equal(hasReply([replySeg(1), { type: 'text', data: { text: 'hi' } }]), true)
  assert.equal(hasReply([{ type: 'reply', data: {} }]), false, '裁掉 id 的 reply 段不算可展开')
  assert.equal(hasReply([{ type: 'text', data: { text: 'hi' } }]), false)
  ok('hasReply 只认带消息号的引用')
}

// ── 2. 存档命中（主路径）：截图里那个场景 ──
{
  const segments = [replySeg(REAL_REPLIED.messageId), { type: 'text', data: { text: ' @10002' } }]
  const lookups = []
  const out = await expandReplies(segments, {
    logger,
    lookup: async (id) => {
      lookups.push(id)
      return id === REAL_REPLIED.messageId ? REAL_REPLIED : undefined
    },
  })
  const text = segmentsToText(out)
  assert.deepEqual(lookups, [REAL_REPLIED.messageId], '应该按消息号查了一次存档')
  assert.match(text, /\[引用 甲:/, '要标明这是谁的引用')
  assert.match(text, /水花溅得也太高/, '被引用的正文必须在')
  assert.match(text, /@10002|@10002/, '自己说的话不能被引用吞掉')
  assert.ok(
    out.some((s) => s.type === 'video'),
    '被引用里的视频段必须原样透传（换成占位就再也抽不了帧）'
  )
  ok('存档命中：引用内容 + 视频段一起进模型')
}

// ── 3. 图片/视频配额 ──
{
  const many = {
    senderName: '图王',
    segments: [
      { type: 'text', data: { text: '看这几张' } },
      { type: 'image', data: { url: 'https://a/1.jpg' } },
      { type: 'image', data: { url: 'https://a/2.jpg' } },
      { type: 'image', data: { url: 'https://a/3.jpg' } },
    ],
  }
  const out = await expandReplies([replySeg(1)], { logger, lookup: async () => many, maxImages: 2 })
  const images = out.filter((s) => s.type === 'image')
  assert.equal(images.length, 2, '最多带 replyMaxImages 张')
  assert.match(segmentsToText(out), /另有 1 张图未带/, '丢掉的要说明，别让模型以为只有两张')
  ok('引用里的图片受配额限制，并在文字里注明')

  const none = await expandReplies([replySeg(1)], { logger, lookup: async () => many, maxImages: 0 })
  assert.equal(none.filter((s) => s.type === 'image').length, 0)
  ok('maxImages=0 时一张都不带')
}

// ── 4. 字数截断 ──
{
  const long = { senderName: '话痨', segments: [{ type: 'text', data: { text: '啊'.repeat(500) } }] }
  const out = await expandReplies([replySeg(1)], { logger, lookup: async () => long, maxChars: 100 })
  const text = segmentsToText(out)
  assert.match(text, /已截断/)
  assert.ok(text.length < 200, `截断要真的生效，实际 ${text.length} 字`)
  ok('长引用按 maxChars 截断并注明')
}

// ── 5. 存档没有 → get_msg 兜底（机器人自己发过的消息不入档） ──
{
  const calls = []
  const out = await expandReplies([replySeg(555)], {
    logger,
    lookup: async () => undefined,
    call: async (action, params) => {
      calls.push({ action, params })
      return {
        status: 'ok',
        data: {
          sender: { nickname: '菲比' },
          message: [{ type: 'text', data: { text: '我之前说过的那句话' } }],
        },
      }
    },
  })
  assert.equal(calls[0]?.action, 'get_msg')
  assert.equal(Number(calls[0]?.params?.message_id), 555)
  assert.match(segmentsToText(out), /\[引用 菲比: 我之前说过的那句话\]/)
  ok('存档查不到时走 get_msg')
}

// ── 6. 两条都取不到 ──
{
  const out = await expandReplies([replySeg(999)], {
    logger,
    lookup: async () => undefined,
    call: async () => ({ status: 'ok', data: {} }),
  })
  const text = segmentsToText(out)
  assert.match(text, /引用了一条我看不到的消息/)
  ok('取不到时留明确痕迹，而不是假装没有')
}

// ── 7. 无引用时原样返回，且不触发查询 ──
{
  let called = 0
  const input = [{ type: 'text', data: { text: '今天天气不错' } }]
  const out = await expandReplies(input, { logger, lookup: async () => (called++, undefined) })
  assert.equal(out, input, '应该原样返回同一个数组')
  assert.equal(called, 0, '没有引用就不该查任何东西')
  ok('无引用时零开销')
}

// ── 8. 引用里套转发：透传给 expandForwards，最终被摊平 ──
{
  // 被引用的是一条「转发」，且 content 内嵌（真机形态）
  const quotedForward = {
    senderName: '小丑',
    segments: [
      {
        type: 'forward',
        data: {
          id: '7699352847137900001',
          content: [
            { sender: { nickname: '甲' }, user_id: 1, message: [{ type: 'text', data: { text: '第一层内容' } }] },
          ],
        },
      },
    ],
  }
  const out = await expandReplies([replySeg(1)], { logger, lookup: async () => quotedForward })
  // 引用展开后仍是一个 forward 段，交给 forward.js 继续摊平
  const flat = await expandForwards(out, { logger })
  const text = segmentsToText(flat)
  assert.match(text, /\[引用 小丑:/)
  assert.match(text, /第一层内容/, '引用里的转发表必须能被摊平（截图里就是这种）')
  ok('引用里的转发会被继续展开')
}

// ── 9. 真机存档链路：reply 段的 id 必须留得住 ──
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-reply-'))
  const archive = new Archive({ dir, logger })
  await archive.init()
  const key = 'group:100000001'

  // 先让被引用的那条进存档（真实链路里它就是先到的）
  await archive.append(key, {
    time: 1,
    senderId: REAL_REPLIED.senderId,
    senderName: REAL_REPLIED.senderName,
    messageId: REAL_REPLIED.messageId,
    text: REAL_REPLIED.text,
    segments: REAL_REPLIED.segments,
  })

  const found = await archive.findByMessageId(key, REAL_REPLIED.messageId)
  assert.ok(found, '按消息号应该查得到')
  assert.equal(found.senderName, '甲')
  ok('Archive.findByMessageId 能按消息号反查')

  // 引用消息自己入库后，reply 段的 id 不能被裁掉
  await archive.append(key, {
    time: 2,
    senderId: 999,
    senderName: '提问的人',
    messageId: 111,
    text: '@10002',
    segments: [replySeg(REAL_REPLIED.messageId), { type: 'at', data: { qq: '10002' } }],
  })
  const stored = (await archive.getRecent(key, 5)).at(-1)
  const replyInStore = (stored.segments ?? []).find((s) => s.type === 'reply')
  assert.ok(replyInStore, '存档里必须还有 reply 段')
  assert.equal(
    String(replyInStore.data?.id),
    String(REAL_REPLIED.messageId),
    'id 被裁掉就等于引用内容永久丢失（转发那次踩过同样的坑）'
  )
  ok('存档保留 reply 段的消息号')

  await archive.stop()
  await fs.rm(dir, { recursive: true, force: true })
}

console.log(`\n全部通过（${passed} 项）`)
