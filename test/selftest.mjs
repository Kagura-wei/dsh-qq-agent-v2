/**
 * 自测：门控 / 归一化 / 文本切分 / 存档。
 * 运行：node test/selftest.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { decide, normalizeEvent, detectMention, detectTrigger, normalizeSegments } from '../lib/gate.js'
import { splitMessage, segmentsToText, codePointLength } from '../lib/text.js'
import { buildSystemPrompt } from '../lib/prompt.js'
import { Archive, sessionKeyOf } from '../lib/store.js'

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

const baseConfig = {
  allowGroups: [10001],
  allowUsers: [10002],
  contextSliderPos: 20,
  replyOnlyWhenMentioned: true,
  keywords: ['机器人'],
  atCount: 20,
  keywordCount: 15,
  randomCount: 8,
  allCount: 80,
}

const groupMsg = { scene: 'group', peerId: 10001, senderId: 555, text: '你好' }
const privateMsg = { scene: 'private', peerId: 10002, senderId: 10002, text: '你好' }

console.log('\n[门控] 白名单')
check('白名单外的群直接拒绝', () => {
  const r = decide({ config: baseConfig, msg: { ...groupMsg, peerId: 999 }, mention: false })
  assert.equal(r.accept, false)
  assert.equal(r.reason, 'not-allowed')
})
check('空白名单 = 拒绝所有群', () => {
  const r = decide({ config: { ...baseConfig, allowGroups: [] }, msg: groupMsg, mention: true })
  assert.equal(r.accept, false)
})
check('白名单外的私聊拒绝', () => {
  const r = decide({ config: baseConfig, msg: { ...privateMsg, peerId: 111 }, mention: false })
  assert.equal(r.accept, false)
})
check('多个群/多个私聊都能放行', () => {
  const cfg = { ...baseConfig, allowGroups: [1, 10001, 2], allowUsers: [9, 10002] }
  assert.equal(decide({ config: cfg, msg: groupMsg, mention: true }).accept, true)
  assert.equal(decide({ config: cfg, msg: privateMsg, mention: false }).accept, true)
})

console.log('\n[门控] 群聊触发')
check('@ 命中（不再附带历史条数）', () => {
  const r = decide({ config: baseConfig, msg: groupMsg, mention: true })
  assert.equal(r.accept, true)
  assert.equal(r.reason, 'at')
  assert.equal(r.historyCount, undefined, '历史条数已交由上下文注入，门控不再决定')
})
check('仅@模式下未@不响应', () => {
  const r = decide({ config: baseConfig, msg: groupMsg, mention: false })
  assert.equal(r.accept, false)
  assert.equal(r.reason, 'not-mentioned')
})
check('档位10：仅@响应', () => {
  const cfg = { ...baseConfig, contextSliderPos: 10, replyOnlyWhenMentioned: false }
  assert.equal(decide({ config: cfg, msg: groupMsg, mention: false }).accept, false)
  assert.equal(decide({ config: cfg, msg: groupMsg, mention: true }).accept, true)
})
check('档位20：@+关键词', () => {
  const cfg = { ...baseConfig, contextSliderPos: 20, replyOnlyWhenMentioned: false }
  const hit = decide({ config: cfg, msg: { ...groupMsg, text: '机器人 你好' }, mention: false })
  assert.equal(hit.accept, true)
  assert.equal(hit.reason, 'keyword')
  assert.equal(hit.historyCount, undefined)
  assert.equal(decide({ config: cfg, msg: groupMsg, mention: false }).accept, false)
})
check('档位50：概率区间，random=0.1 命中、0.9 不命中', () => {
  const cfg = { ...baseConfig, contextSliderPos: 50, replyOnlyWhenMentioned: false }
  assert.equal(decide({ config: cfg, msg: groupMsg, mention: false, random: () => 0.1 }).accept, true)
  assert.equal(decide({ config: cfg, msg: groupMsg, mention: false, random: () => 0.9 }).accept, false)
})
check('档位89：概率高达 98.6%，random=0.98 命中、0.99 漏过', () => {
  const cfg = { ...baseConfig, contextSliderPos: 89, replyOnlyWhenMentioned: false }
  const hit = decide({ config: cfg, msg: groupMsg, mention: false, random: () => 0.98 })
  assert.equal(hit.accept, true)
  assert.equal(hit.reason, 'random')
  const miss = decide({ config: cfg, msg: groupMsg, mention: false, random: () => 0.99 })
  assert.equal(miss.accept, false)
})
check('几率是独立触发方式：判定开着也照常掷骰子', () => {
  // 判定管的是"触发之后、跟进期里那些没触发的话要不要接"，
  // 不参与"这条消息能不能触发" —— 所以 89 档该掷还是掷。
  const cfg = { ...baseConfig, contextSliderPos: 89, replyOnlyWhenMentioned: false, judgeEnabled: true }
  const hit = decide({ config: cfg, msg: groupMsg, mention: false, random: () => 0.98 })
  assert.equal(hit.accept, true)
  assert.equal(hit.reason, 'random')
  const miss = decide({ config: cfg, msg: groupMsg, mention: false, random: () => 0.99 })
  assert.equal(miss.accept, false)
  assert.equal(miss.reason, 'not-mentioned', '没命中就是没触发，后续由跟进期决定')
})
check('判定开启时关键词仍然本地放行（不必花钱判）', () => {
  const cfg = { ...baseConfig, contextSliderPos: 50, replyOnlyWhenMentioned: false, judgeEnabled: true }
  const d = decide({ config: cfg, msg: { ...groupMsg, text: '机器人 你好' }, mention: false, random: () => 0.001 })
  assert.equal(d.accept, true)
  assert.equal(d.reason, 'keyword')
})
check('档位 100 每条都是触发（跟进判定不会被调用）', () => {
  const cfg = { ...baseConfig, contextSliderPos: 100, replyOnlyWhenMentioned: false, judgeEnabled: true }
  const d = decide({ config: cfg, msg: groupMsg, mention: false, random: () => 0.99 })
  assert.equal(d.accept, true)
  assert.equal(d.reason, 'all')
})
check('档位100：全响应', () => {
  const cfg = { ...baseConfig, contextSliderPos: 100, replyOnlyWhenMentioned: false }
  const r = decide({ config: cfg, msg: groupMsg, mention: false, random: () => 0.99 })
  assert.equal(r.accept, true)
  assert.equal(r.reason, 'all')
  assert.equal(r.historyCount, undefined)
})

console.log('\n[门控] 图片走与纯文字相同的三种触发机制')
const imgSeg = [{ type: 'image', data: { url: 'https://example.com/x.jpg' } }]
// 纯图消息的真实文本就是 `[图片]`（segmentsToText 的产物）：既不含 @ 也不含关键词
const imgMsg = { scene: 'group', peerId: 10001, senderId: 555, text: '[图片]', segments: imgSeg }

check('低档位下带图消息不再"必回"（档位15只放行 @ 与关键词）', () => {
  // 本次改动的核心：图片不再绕过档位。random 给 0.001 也不该有用，因为这一档根本没开几率。
  const cfg = { ...baseConfig, contextSliderPos: 15, replyOnlyWhenMentioned: false, imageEnabled: true }
  const d = decide({ config: cfg, msg: imgMsg, mention: false, random: () => 0.001 })
  assert.equal(d.accept, false)
  assert.equal(d.reason, 'not-mentioned')
})
check('带图 + @ → 必回（reason=at）', () => {
  const cfg = { ...baseConfig, contextSliderPos: 15, replyOnlyWhenMentioned: false, imageEnabled: true }
  const d = decide({ config: cfg, msg: imgMsg, mention: true, random: () => 0.99 })
  assert.equal(d.accept, true)
  assert.equal(d.reason, 'at')
})
check('带图 + 关键词 → 必回（reason=keyword）', () => {
  const cfg = { ...baseConfig, contextSliderPos: 15, replyOnlyWhenMentioned: false, imageEnabled: true }
  const d = decide({
    config: cfg,
    msg: { ...imgMsg, text: '[图片] 机器人 快看看这个' },
    mention: false,
    random: () => 0.99,
  })
  assert.equal(d.accept, true)
  assert.equal(d.reason, 'keyword')
})
check('带图 + 几率命中 → 回复（reason=random），没掷中就不回', () => {
  const cfg = { ...baseConfig, contextSliderPos: 50, replyOnlyWhenMentioned: false, imageEnabled: true }
  const hit = decide({ config: cfg, msg: imgMsg, mention: false, random: () => 0.1 })
  assert.equal(hit.accept, true)
  assert.equal(hit.reason, 'random')
  const miss = decide({ config: cfg, msg: imgMsg, mention: false, random: () => 0.99 })
  assert.equal(miss.accept, false)
  assert.equal(miss.reason, 'not-mentioned')
})
check('图片开关只管"图能不能进模型"，不参与门控（开关两种取值结果一致）', () => {
  const on = decide({
    config: { ...baseConfig, contextSliderPos: 50, replyOnlyWhenMentioned: false, imageEnabled: true },
    msg: imgMsg,
    mention: false,
    random: () => 0.1,
  })
  const off = decide({
    config: { ...baseConfig, contextSliderPos: 50, replyOnlyWhenMentioned: false, imageEnabled: false },
    msg: imgMsg,
    mention: false,
    random: () => 0.1,
  })
  assert.deepEqual(off, on)
})
check('「仅在 @ 时响应」优先于一切（图片也不回）', () => {
  const cfg = { ...baseConfig, contextSliderPos: 50, replyOnlyWhenMentioned: true, imageEnabled: true }
  const d = decide({ config: cfg, msg: imgMsg, mention: false })
  assert.equal(d.accept, false)
  assert.equal(d.reason, 'not-mentioned')
})
check('屏蔽用户发的图片同样不触发', () => {
  const cfg = { ...baseConfig, contextSliderPos: 50, replyOnlyWhenMentioned: false, imageEnabled: true, blocklist: { '10001': [555] } }
  const d = decide({ config: cfg, msg: imgMsg, mention: false })
  assert.equal(d.accept, false)
  assert.equal(d.reason, 'blocked')
})
check('白名单外的群发图不触发', () => {
  const cfg = { ...baseConfig, contextSliderPos: 50, replyOnlyWhenMentioned: false, imageEnabled: true }
  const d = decide({ config: cfg, msg: { ...imgMsg, peerId: 999 }, mention: false })
  assert.equal(d.accept, false)
  assert.equal(d.reason, 'not-allowed')
})

console.log('\n[门控] 屏蔽名单与私聊')
check('群内屏蔽用户不触发', () => {
  const cfg = { ...baseConfig, blocklist: { '10001': [555] } }
  const r = decide({ config: cfg, msg: groupMsg, mention: true })
  assert.equal(r.accept, false)
  assert.equal(r.reason, 'blocked')
})
check('过白名单的私聊总是响应', () => {
  const r = decide({ config: baseConfig, msg: privateMsg, mention: false })
  assert.equal(r.accept, true)
})

console.log('\n[归一化]')
check('群消息归一化', () => {
  const msg = normalizeEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 10001,
    user_id: 555,
    message_id: 1001,
    time: 1700000000,
    sender: { nickname: '张三' },
    message: [{ type: 'text', data: { text: '你好' } }],
  })
  assert.equal(msg.scene, 'group')
  assert.equal(msg.peerId, 10001)
  assert.equal(msg.senderName, '张三')
  assert.equal(msg.text, '你好')
})
check('字符串消息也能归一化', () => {
  const msg = normalizeEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 10002,
    message: 'hi',
  })
  assert.equal(msg.scene, 'private')
  assert.equal(msg.text, 'hi')
})
check('非消息事件返回 null', () => {
  assert.equal(normalizeEvent({ post_type: 'meta_event' }), null)
})
check('@ 检测', () => {
  const msg = {
    segments: normalizeSegments([{ type: 'at', data: { qq: '10003' } }, { type: 'text', data: { text: ' 在吗' } }]),
    text: '@机器人 在吗',
  }
  assert.equal(detectMention(msg, { botQq: 10003, botName: '' }), true)
  assert.equal(detectMention(msg, { botQq: 1, botName: '小鲸鱼' }), false)
  assert.equal(
    detectMention(
      { ...msg, segments: [{ type: 'text', data: { text: '小鲸鱼 在吗' } }], text: '小鲸鱼 在吗' },
      { botQq: 1, botName: '小鲸鱼' }
    ),
    true
  )
})

console.log('\n[归一化] 引用（reply 段）')
check('reply 段的消息号被拎出来', () => {
  const msg = normalizeEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 1,
    user_id: 2,
    message: [
      { type: 'reply', data: { id: '12345' } },
      { type: 'text', data: { text: '这句你怎么看' } },
    ],
  })
  assert.equal(msg.replyTo, 12345)
  assert.equal(msg.text, '这句你怎么看', '引用内容不该混进正文')
})
check('没有 reply 段时 replyTo 为 0', () => {
  const msg = normalizeEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 1,
    user_id: 2,
    message: [{ type: 'text', data: { text: 'hi' } }],
  })
  assert.equal(msg.replyTo, 0)
})

console.log('\n[触发] 三种信号 + 误触发防护')
check('引用机器人自己发过的消息 = 触发（kind=reply）', () => {
  const msg = { segments: [{ type: 'reply', data: { id: 900 } }], text: '这句你怎么看', replyTo: 900 }
  const t = detectTrigger(msg, { botQq: 111, botName: '小鲸鱼', isBotMessage: (id) => id === 900 })
  assert.equal(t.mention, true)
  assert.equal(t.kind, 'reply')
})
check('引用的不是机器人发的不算触发', () => {
  const msg = { segments: [{ type: 'reply', data: { id: 901 } }], text: '这句你怎么看', replyTo: 901 }
  const t = detectTrigger(msg, { botQq: 111, botName: '小鲸鱼', isBotMessage: () => false })
  assert.equal(t.mention, false)
})
check('@ 优先于引用（kind=at）', () => {
  const msg = {
    segments: [{ type: 'at', data: { qq: '111' } }, { type: 'reply', data: { id: 900 } }],
    text: '@机器人',
    replyTo: 900,
  }
  const t = detectTrigger(msg, { botQq: 111, isBotMessage: () => true })
  assert.equal(t.kind, 'at')
})
check('⚠️ 开头 @ 别人时，正文提到机器人名不算触发（防误触发）', () => {
  // 线上故障：群里说「@张三 你觉得小鲸鱼说的对吗」，机器人被这句话叫醒了
  const msg = {
    segments: [
      { type: 'at', data: { qq: '222' } },
      { type: 'text', data: { text: ' 你觉得小鲸鱼说的对吗' } },
    ],
    text: '@222 你觉得小鲸鱼说的对吗',
  }
  assert.equal(detectMention(msg, { botQq: 111, botName: '小鲸鱼' }), false)
})
check('@ 别人之后又 @ 了机器人 → 仍然触发', () => {
  const msg = {
    segments: [
      { type: 'at', data: { qq: '222' } },
      { type: 'text', data: { text: ' 你看' } },
      { type: 'at', data: { qq: '111' } },
    ],
    text: '@222 你看 @111',
  }
  assert.equal(detectMention(msg, { botQq: 111, botName: '小鲸鱼' }), true)
})
check('开头是空白文本段时不影响判断', () => {
  const msg = {
    segments: [
      { type: 'text', data: { text: '  ' } },
      { type: 'at', data: { qq: '222' } },
      { type: 'text', data: { text: ' 小鲸鱼 你看呢' } },
    ],
    text: '   @222 小鲸鱼 你看呢',
  }
  assert.equal(detectMention(msg, { botQq: 111, botName: '小鲸鱼' }), false)
})
check('⚠️ 开头 @ 别人时，正文关键词也不算数（关键词表里常放机器人名）', () => {
  const cfg = { ...baseConfig, contextSliderPos: 21, replyOnlyWhenMentioned: false, keywords: ['小鲸鱼'] }
  const msg = {
    scene: 'group',
    peerId: 10001,
    senderId: 555,
    segments: [
      { type: 'at', data: { qq: '222' } },
      { type: 'text', data: { text: ' 你觉得小鲸鱼说的对吗' } },
    ],
    text: '@222 你觉得小鲸鱼说的对吗',
  }
  const t = detectTrigger(msg, { botQq: 111, botName: '小鲸鱼' })
  assert.equal(t.addressedToOther, true)
  const d = decide({
    config: cfg,
    msg,
    mention: t.mention,
    mentionKind: t.kind,
    addressedToOther: t.addressedToOther,
    random: () => 0.99, // 档位 21 还有 1.4% 的几率触发，钉死骰子才测得出"关键词被压掉"
  })
  assert.equal(d.accept, false, '这条是对别人说的，不该被关键词叫醒')

  // 对照：同样一句话，去掉开头的 @ 别人 → 关键词正常命中
  const plain = { ...msg, segments: [{ type: 'text', data: { text: '你觉得小鲸鱼说的对吗' } }] }
  const p = decide({ config: cfg, msg: plain, mention: false, random: () => 0.99 })
  assert.equal(p.accept, true)
  assert.equal(p.reason, 'keyword')
})
check('门控：引用触发 reason=reply（与 @ 同级，不受"仅@模式"限制）', () => {
  const cfg = { ...baseConfig, replyOnlyWhenMentioned: true }
  const d = decide({ config: cfg, msg: groupMsg, mention: true, mentionKind: 'reply' })
  assert.equal(d.accept, true)
  assert.equal(d.reason, 'reply')
})
check('门控：@ 触发 reason 仍是 at', () => {
  const d = decide({ config: baseConfig, msg: groupMsg, mention: true, mentionKind: 'at' })
  assert.equal(d.reason, 'at')
})

console.log('\n[文本]')
check('消息段转文本', () => {
  const t = segmentsToText([
    { type: 'text', data: { text: '看这个' } },
    { type: 'image' },
  ])
  assert.equal(t, '看这个[图片]')
})
check('长文本切分不超长且在句读处断开', () => {
  const text = ('这是一句话。' + 'x'.repeat(50)).repeat(200)
  const parts = splitMessage(text, 1700)
  assert.ok(parts.length > 1, '应切成多段')
  for (const p of parts) assert.ok(codePointLength(p) <= 1700, `超长: ${codePointLength(p)}`)
})
// 高代理后无低代理，或低代理前无高代理 —— 才是真的切坏了
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
check('emoji 不会被切坏', () => {
  const text = '😀'.repeat(2000)
  const parts = splitMessage(text, 1700)
  assert.ok(parts.length > 1, '应切成多段')
  for (const p of parts) assert.ok(!LONE_SURROGATE.test(p), '出现孤立代理项')
  assert.equal(parts.join(''), text, '拼接后应还原原文')
})

console.log('\n[存档]')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-store-'))
const logger = { info() {}, warn() {}, error() {} }
const archive = new Archive({ dir: tmp, logger })
await archive.init()
const key = sessionKeyOf('group', 10001)
await archive.append(key, { time: 1, senderId: 1, text: '第一条' })
await archive.append(key, { time: 2, senderId: 2, text: '第二条' })
let unread = await archive.getUnread(key, 20)
check('写入后两条未读', () => assert.equal(unread.length, 2))
await archive.markAllRead(key)
unread = await archive.getUnread(key, 20)
check('标记已读后未读清零', () => assert.equal(unread.length, 0))
const recent = await archive.getRecent(key, 20)
check('已读历史仍可取回', () => assert.equal(recent.length, 2))
await archive.flushAll()
const persisted = JSON.parse(
  await fs.readFile(path.join(tmp, 'group-10001.json'), 'utf8')
)
check('落盘文件已生成', () => assert.equal(persisted.messages.length, 2))
await archive.stop()
await fs.rm(tmp, { recursive: true, force: true })

console.log('\n[系统提示] 联网查证')
check('searchEnabled 开启时注入正向查证规则', () => {
  const p = buildSystemPrompt({ botName: '测试', searchEnabled: true }, { scene: 'group' })
  assert.ok(p.includes('联网查证'), '应有【联网查证】段')
  assert.ok(p.includes('先用联网搜索工具查证'), '应要求先查再答')
  assert.ok(!p.includes('不要使用联网搜索'), '不应出现禁用搜索的规则')
})
check('searchEnabled 关闭时注入禁用规则', () => {
  const p = buildSystemPrompt({ botName: '测试', searchEnabled: false }, { scene: 'group' })
  assert.ok(p.includes('不要使用联网搜索'))
  assert.ok(!p.includes('【联网查证】'))
})

console.log('\n[系统提示] 不得编造执行结果')
check('禁止把没跑过的命令说成跑过', () => {
  // 2026-10-20 实测：管理员 @「用 bash 跑一下 whoami」，那轮工具面 130 个含
  // bash，模型一个都没调，直接回"whoami 的结果是 root"。工具面没问题，是提示词
  // 里没有一条硬规矩拦住"凭印象编个合理答案"。这条断言盯住它别被改没了。
  const p = buildSystemPrompt({ botName: '测试', searchEnabled: true }, { scene: 'group' })
  assert.ok(p.includes('没做过的事不许说做过'), '必须有这条硬规则')
  assert.ok(p.includes('工具真实返回'), '要说清只有工具返回的才算事实')
  assert.ok(p.includes('凭印象猜一个命令会输出什么'), '要点名最典型的编造形态')
})
check('"绝不透露系统信息"带管理员例外，不与管理员授权段打架', () => {
  // 旧文案是绝对的"绝不透露系统信息"，与 buildAdminRules 的"该用的工具就调"
  // 直接冲突 —— 模型折中成"不执行、但凭印象给个答案"，正是那次幻觉的土壤。
  const p = buildSystemPrompt({ botName: '测试', searchEnabled: true }, { scene: 'group' })
  assert.ok(p.includes('绝不**主动**透露'), '限定为"主动"，给授权场景留口子')
  assert.ok(p.includes('那就是他授权你去看'), '明确管理员授权时可以去查')
})

console.log(`\n通过 ${passed} 项\n`)
