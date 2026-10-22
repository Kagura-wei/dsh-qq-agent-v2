/**
 * 合并转发展开测试 —— 锁住"转发里的东西模型能看见"这条链路。
 *
 * 线上故障（2026-10-22）：群里发一条多层转发的聊天记录（里面还有视频），
 * 然后 @机器人「总结一下」，机器人回「光说一句总结一下，我也不知道你想让我总结啥」。
 * 原因：segmentToText 对 forward 段返回空串，存档又把未知段裁成 {type,data:{}}，
 * 模型收到的是一条空消息。
 *
 * 下面的节点结构照抄自真机 get_msg / get_forward_msg 的返回形态（QQ 号与时间戳
 * 已替换为假数据）。
 *
 * 运行：node test/forward-test.mjs
 */
import assert from 'node:assert/strict'
import { expandForwards, flattenForward, hasForward, isForwardSegment } from '../lib/forward.js'
import { segmentToText, segmentsToText, hasVideo } from '../lib/text.js'
import { trimSegments } from '../lib/store.js'

const logger = { info() {}, warn() {}, error() {} }

/** 真机里一个转发节点长这样：一条完整消息对象，自带 sender.nickname 与 message 段数组。 */
function node(nickname, segs, extra = {}) {
  return {
    self_id: 10002,
    user_id: 10004,
    time: 1700000005,
    message_id: 90002,
    sender: { user_id: 10004, nickname, card: '' },
    message: segs,
    post_type: 'message',
    ...extra,
  }
}

const text = (t) => ({ type: 'text', data: { text: t } })
const video = { type: 'video', data: { file: '67e4d8.mp4', url: 'https://multimedia.nt.qq.com.cn/x?rkey=1', file_size: '5894555' } }
const image = { type: 'image', data: { file: 'a.jpg', url: 'https://multimedia.nt.qq.com.cn/y?rkey=2' } }

// ── 1. 段类型识别 ──────────────────────────────────────────────
assert.equal(isForwardSegment({ type: 'forward' }), true)
assert.equal(isForwardSegment({ type: 'node' }), true)
assert.equal(isForwardSegment({ type: 'text' }), false)
assert.equal(hasForward([text('hi'), { type: 'forward', data: {} }]), true)
assert.equal(hasForward([text('hi')]), false)

// ── 2. 占位符：视频/卡片/转发不再是空串 ────────────────────────
assert.equal(segmentToText(video), '[视频]')
assert.equal(segmentToText({ type: 'video', data: { duration: 12 } }), '[视频 12s]')
assert.equal(segmentToText({ type: 'forward', data: {} }), '[聊天记录]')
assert.equal(segmentToText({ type: 'file', data: { name: '报表.xlsx' } }), '[文件: 报表.xlsx]')
assert.equal(
  segmentToText({ type: 'json', data: { data: JSON.stringify({ prompt: '[分享] 一段图文', meta: { news: { title: '热门推送' } } }) } }),
  '[卡片: 热门推送]'
)
assert.equal(segmentToText({ type: 'json', data: { data: 'not-json' } }), '[卡片]')
assert.equal(hasVideo([image, video]), true)

// ── 3. 单层转发：文字 + 图片 + 视频都要留下 ────────────────────
{
  const nodes = [node('小丑', [text('谨慎观看，近亲的报应来了')]), node('世代', [image]), node('世代', [video])]
  const flat = flattenForward(nodes)
  const out = segmentsToText(flat)
  assert.match(out, /^\[聊天记录 3 条\]/, '开头要标明这是一条转发记录')
  assert.match(out, /小丑: 谨慎观看/)
  assert.match(out, /世代: \[图片\]/, '图片保留占位（本体由下游存成 image 块）')
  assert.match(out, /世代: \[视频\]/, '视频保留占位（下游抽帧）')
  assert.match(out, /\[\/聊天记录\]$/, '结尾要收口，模型才知道记录到哪结束')

  // 图片/视频段必须原样透传，否则下游没法抽帧/存图
  const passed = flat.filter((s) => s.type === 'image' || s.type === 'video')
  assert.equal(passed.length, 2)
  assert.equal(passed[0].data.url, image.data.url)
  assert.equal(passed[1].data.file_size, '5894555')
}

// ── 4. 多层嵌套：真机里嵌套转发的 content 直接内嵌 ─────────────
{
  const nested = {
    type: 'forward',
    data: {
      id: '7699352847137900002',
      content: [node('世代', [image]), node('世代', [text('第二层的话')])],
    },
  }
  const outer = [node('小丑', [text('楼下继续')]), node('小丑', [nested]), node('路人', [text('看完了')])]
  const out = segmentsToText(flattenForward(outer))
  assert.match(out, /小丑: 〔转发 2 条〕/, '嵌套转发要标出条数')
  assert.match(out, /世代: \[图片\]/, '第二层的内容必须展开')
  assert.match(out, /世代: 第二层的话/)
  assert.match(out, /路人: 看完了/, '嵌套结束后同层的记录照常输出')
  // 第二层要比第一层缩进更深，肉眼能看出层级
  assert.match(out, /\n {2}世代: /)
}

// ── 5. 深度/条数/字数三条闸都要生效 ────────────────────────────
{
  // 深度语义：maxDepth = 最多往下展开几层。1 = 允许一层嵌套，2 = 两层…
  const deep = { type: 'forward', data: { content: [node('甲', [text('inner')])] } }
  // maxDepth=1：第一层嵌套要展开
  assert.match(segmentsToText(flattenForward([node('乙', [deep])], { maxDepth: 1 })), /inner/)
  // maxDepth=0：一层都不展开，只留说明（配置项最小是 1，这里是纯函数的兜底语义）
  const blocked = segmentsToText(flattenForward([node('乙', [deep])], { maxDepth: 0 }))
  assert.match(blocked, /嵌套太深/)
  assert.doesNotMatch(blocked, /inner/, '超过深度的内容不该展开')

  // 条数：超出的记进"未展开"
  const many = Array.from({ length: 10 }, (_, i) => node(`人${i}`, [text(`第${i}条`)]))
  const capped = segmentsToText(flattenForward(many, { maxNodes: 3 }))
  assert.match(capped, /另有 7 条未展开/)

  // 字数：超了截断，但不会崩
  const long = segmentsToText(flattenForward([node('话痨', [text('很长'.repeat(500))])], { maxChars: 300 }))
  assert.ok(long.length < 600, `字数上限要生效，实际 ${long.length}`)
}

// ── 6. 空节点 / 缺内容的嵌套：只留说明，不抛错 ─────────────────
{
  const out = segmentsToText(flattenForward([node('甲', []), node('乙', [{ type: 'forward', data: {} }])]))
  assert.match(out, /乙: 〔转发消息，内容取不到〕/)
}

// ── 7. expandForwards：内嵌 content 直接展开，不发网络请求 ──────
{
  let called = 0
  const segs = [text('看看这个'), { type: 'forward', data: { id: '1', content: [node('甲', [text('转发里的字')])] } }]
  const out = await expandForwards(segs, {
    call: async () => {
      called++
      return { messages: [] }
    },
    logger,
  })
  assert.equal(called, 0, 'content 已经内嵌时不该再发 get_forward_msg')
  assert.match(segmentsToText(out), /转发里的字/)
  assert.match(segmentsToText(out), /^看看这个/, '转发外层的正文要保留')
  assert.equal(out[0].type, 'text')
  assert.ok(out.some((s) => s.type === 'text' && /聊天记录/.test(s.data.text)))
}

// ── 8. expandForwards：缺 content 时按 id 补取（真机部分版本如此）──
{
  const fetched = []
  const segs = [{ type: 'forward', data: { id: 'abc' } }]
  const out = await expandForwards(segs, {
    call: async (action, params) => {
      fetched.push([action, params.id])
      return { messages: [node('甲', [text('补取到的内容')])] }
    },
    logger,
  })
  assert.deepEqual(fetched, [['get_forward_msg', 'abc']])
  assert.match(segmentsToText(out), /补取到的内容/)
}

// ── 9. 取不到内容时给明确说明，而不是空白 ─────────────────────
{
  const out = await expandForwards([{ type: 'forward', data: { id: 'x' } }], {
    call: async () => {
      throw new Error('NapCat 未连接')
    },
    logger,
  })
  assert.match(segmentsToText(out), /内容取不到/)
}

// ── 10. enabled=false 原样返回 ────────────────────────────────
{
  const segs = [{ type: 'forward', data: { content: [node('甲', [text('x')])] } }]
  const out = await expandForwards(segs, { enabled: false, logger })
  assert.equal(out, segs)
}

// ── 11. 存档：展开后的段能安全落盘，视频 url 必须保住 ──────────
{
  const flat = flattenForward([node('甲', [text('話')]), node('乙', [image]), node('丙', [video])])
  const trimmed = trimSegments(flat)
  const kept = trimmed.filter((s) => s.type === 'video')
  assert.equal(kept.length, 1)
  assert.equal(kept[0].data.url, video.data.url, '视频 url 丢了就再也抽不了帧')
  assert.equal(kept[0].data.file_size, '5894555')
  // base64 视频不能进存档（体积不可控）
  const big = trimSegments([{ type: 'video', data: { file: `base64://${'A'.repeat(1000)}`, url: '' } }])
  assert.equal(big[0].data.file, undefined)
  // 文字段原样保留
  assert.ok(trimmed.some((s) => s.type === 'text' && s.data.text.includes('話')))
}

console.log('forward-test: 全部通过')
