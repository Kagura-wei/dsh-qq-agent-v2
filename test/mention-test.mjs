/**
 * 自测：@ 解析（成员表 / 标记解析 / 带 at 段的发送切分）。
 * 运行：node test/mention-test.mjs
 */
import assert from 'node:assert/strict'
import { collectMembers, parseMentions, SENTINEL } from '../lib/mention.js'
import { Sender } from '../lib/sender.js'
import { buildSystemPrompt } from '../lib/prompt.js'

let passed = 0
async function check(label, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${label}`)
  } catch (error) {
    console.error(`  FAIL ${label}: ${error.message}`)
    process.exitCode = 1
  }
}

const silent = { info() {}, warn() {}, error() {} }

/** 构造一个只记录出站内容的 Sender。 */
function makeSender(overrides = {}) {
  const out = []
  const server = {
    send: async (scene, peerId, segments) => {
      out.push({ scene, peerId, segments })
    },
  }
  const cfg = {
    maxMessageLength: 1700,
    minGapMs: 0,
    maxGapMs: 0,
    byLengthMs: 0,
    maxPerMinute: 100,
    maxPerHour: 1000,
    ...overrides,
  }
  return { sender: new Sender({ server, getConfig: () => cfg, logger: silent }), out }
}

const entry = (senderName, senderId) => ({ senderName, senderId })

// ────────────────────────── 成员表 ──────────────────────────

console.log('\n[成员表] 昵称 → QQ')

await check('从存档提取说话的人（最近说过话的排在前面）', () => {
  const members = collectMembers([entry('阿蓝', 100), entry('阿May', 200)])
  assert.deepEqual(members, [
    { name: '阿May', qq: 200 },
    { name: '阿蓝', qq: 100 },
  ])
})

await check('同名以最新的为准', () => {
  const members = collectMembers([entry('张三', 111), entry('李四', 222), entry('张三', 333)])
  assert.equal(members.find((m) => m.name === '张三').qq, 333)
})

await check('排除机器人自己', () => {
  const members = collectMembers([entry('阿蓝', 100), entry('小鲸鱼', 900)], { botQq: 900 })
  assert.deepEqual(members.map((m) => m.name), ['阿蓝'])
})

await check('没昵称的跳过（拿不到就 @ 不到，好过记一个空名字）', () => {
  const members = collectMembers([entry('', 100), entry('  ', 200), entry('阿蓝', 300)])
  assert.deepEqual(members, [{ name: '阿蓝', qq: 300 }])
})

await check('非法 senderId 跳过', () => {
  const members = collectMembers([entry('甲', 0), entry('乙', NaN), entry('丙', 300)])
  assert.deepEqual(members, [{ name: '丙', qq: 300 }])
})

await check('不传 / 传空都返回空表', () => {
  assert.deepEqual(collectMembers(undefined), [])
  assert.deepEqual(collectMembers([]), [])
})

await check('limit 生效', () => {
  const many = Array.from({ length: 20 }, (_, i) => entry(`人${i}`, 1000 + i))
  assert.equal(collectMembers(many, { limit: 5 }).length, 5)
})

// ────────────────────────── 标记解析 ──────────────────────────

console.log('\n[解析] [[at:…]] / @昵称')

const members = [
  { name: '阿蓝', qq: 100 },
  { name: '阿 May', qq: 200 },
  { name: '张三', qq: 300 },
]
const botQq = 900

await check('显式标记 → at 段', () => {
  const r = parseMentions('[[at:阿蓝]] 你刚才说的那个我查到了', { members, botQq })
  assert.equal(r.ats.length, 1)
  assert.equal(r.ats[0].qq, 100)
  assert.equal(r.text, `${SENTINEL} 你刚才说的那个我查到了`)
  assert.equal(r.display, '@阿蓝 你刚才说的那个我查到了')
})

await check('标记在句子中间也保留位置', () => {
  const r = parseMentions('我觉得 [[at:张三]] 说得对', { members, botQq })
  assert.equal(r.text, `我觉得 ${SENTINEL} 说得对`)
})

await check('容错：大小写 / 全角冒号 / 内部空格', () => {
  for (const src of ['[[AT:阿蓝]] 好', '[[ at ： 阿蓝 ]] 好', '[[At: 阿蓝]]好']) {
    const r = parseMentions(src, { members, botQq })
    assert.equal(r.ats.length, 1, `应解析: ${src}`)
    assert.equal(r.ats[0].qq, 100)
  }
})

await check('直接写 QQ 号也认（前提是他在成员表里）', () => {
  const r = parseMentions('[[at:100]] 你好', { members, botQq })
  assert.equal(r.ats[0].name, '阿蓝')
})

await check('裸 @昵称 也能转（精确匹配）', () => {
  const r = parseMentions('@阿蓝 你来看看', { members, botQq })
  assert.equal(r.ats.length, 1)
  assert.equal(r.ats[0].qq, 100)
  assert.equal(r.display, '@阿蓝 你来看看')
})

await check('裸 @ 遇到中文标点不吃标点', () => {
  const r = parseMentions('@阿蓝，你看看', { members, botQq })
  assert.equal(r.ats.length, 1)
  assert.equal(r.text, `${SENTINEL}，你看看`)
})

await check('昵称含空格要走显式标记', () => {
  const r = parseMentions('[[at:阿 May]] 你好', { members, botQq })
  assert.equal(r.ats[0].qq, 200)
})

await check('认不出的人退化成普通文字，不报错、不 @ 错人', () => {
  const r = parseMentions('[[at:路人甲]] 你好', { members, botQq })
  assert.equal(r.ats.length, 0)
  assert.deepEqual(r.unresolved, ['路人甲'])
  assert.ok(r.text.includes('@路人甲'), '应保留可读文字')
  assert.ok(!r.text.includes(SENTINEL), '不应留下占位符')
})

await check('不在成员表里的 QQ 号也不认（防 @ 陌生人）', () => {
  const r = parseMentions('[[at:88888888]] 你好', { members, botQq })
  assert.equal(r.ats.length, 0)
})

await check('不 @ 自己', () => {
  const withBot = [...members, { name: '小鲸鱼', qq: botQq }]
  const r = parseMentions('[[at:小鲸鱼]] 你好', { members: withBot, botQq })
  assert.equal(r.ats.length, 0)
  assert.deepEqual(r.unresolved, ['小鲸鱼'])
})

await check('超过上限的部分退化成文字', () => {
  const r = parseMentions('[[at:阿蓝]] [[at:张三]] [[at:阿 May]] 都来看', { members, botQq, max: 2 })
  assert.deepEqual(r.ats.map((a) => a.qq), [100, 300])
  assert.deepEqual(r.overflow, ['阿 May'])
  assert.ok(r.text.includes('@阿 May'), '超限那个保留成文字')
  assert.equal((r.text.match(new RegExp(SENTINEL, 'g')) ?? []).length, 2)
})

await check('max=1 时只 @ 一个', () => {
  const r = parseMentions('[[at:阿蓝]] [[at:张三]] 好', { members, botQq, max: 1 })
  assert.equal(r.ats.length, 1)
})

await check('原文里混进哨兵会被清掉（否则还原时错位）', () => {
  const r = parseMentions(`前${SENTINEL}后 [[at:阿蓝]] 好`, { members, botQq })
  assert.equal(r.ats.length, 1)
  assert.equal((r.text.match(new RegExp(SENTINEL, 'g')) ?? []).length, 1)
})

await check('显式与裸 @ 混用时顺序与文本一致（不把两个人对调）', () => {
  const r = parseMentions('@阿蓝 然后 [[at:张三]] 好', { members, botQq, max: 5 })
  assert.deepEqual(r.ats.map((a) => a.qq), [100, 300], 'ats 顺序应等于出现顺序')
  assert.equal(r.text, `${SENTINEL} 然后 ${SENTINEL} 好`)
  assert.equal(r.display, '@阿蓝 然后 @张三 好')
})

await check('没有任何 @ 时原样返回', () => {
  const r = parseMentions('今天天气不错', { members, botQq })
  assert.equal(r.ats.length, 0)
  assert.equal(r.text, '今天天气不错')
  assert.equal(r.display, '今天天气不错')
})

await check('空输入不炸', () => {
  for (const v of ['', null, undefined]) {
    const r = parseMentions(v, { members, botQq })
    assert.equal(r.ats.length, 0)
  }
})

// ────────────────────────── 发送 ──────────────────────────

console.log('\n[发送] 带 at 段的出站')

await check('没有 at 时就是一条纯文本', async () => {
  const { sender, out } = makeSender()
  const r = await sender.sendRich('group', 999, '你好呀', [], 'g:999')
  assert.equal(r.sent, 1)
  assert.deepEqual(out[0].segments, [{ type: 'text', data: { text: '你好呀' } }])
})

await check('at 段排在文本前面', async () => {
  const { sender, out } = makeSender()
  await sender.sendRich('group', 999, `${SENTINEL} 你好`, [{ name: '阿蓝', qq: 100 }], 'g:999')
  assert.deepEqual(out[0].segments, [
    { type: 'at', data: { qq: '100' } },
    { type: 'text', data: { text: ' 你好' } },
  ])
})

await check('at 后紧跟文字自动补空格', async () => {
  const { sender, out } = makeSender()
  await sender.sendRich('group', 999, `${SENTINEL}你好`, [{ name: '阿蓝', qq: 100 }], 'g:999')
  assert.deepEqual(out[0].segments[1], { type: 'text', data: { text: ' 你好' } })
})

await check('at 后跟中文标点不补空格', async () => {
  const { sender, out } = makeSender()
  await sender.sendRich('group', 999, `${SENTINEL}，你好`, [{ name: '阿蓝', qq: 100 }], 'g:999')
  assert.deepEqual(out[0].segments[1], { type: 'text', data: { text: '，你好' } })
})

await check('句子中间的 at 落在正确位置', async () => {
  const { sender, out } = makeSender()
  await sender.sendRich(
    'group',
    999,
    `我觉得 ${SENTINEL} 说得对`,
    [{ name: '张三', qq: 300 }],
    'g:999'
  )
  assert.deepEqual(out[0].segments, [
    { type: 'text', data: { text: '我觉得 ' } },
    { type: 'at', data: { qq: '300' } },
    { type: 'text', data: { text: ' 说得对' } },
  ])
})

await check('长回复切分时 at 只发一次（落在第一片）', async () => {
  const { sender, out } = makeSender({ maxMessageLength: 100 })
  const body = `${SENTINEL} ${'啊'.repeat(250)}`
  const r = await sender.sendRich('group', 999, body, [{ name: '阿蓝', qq: 100 }], 'g:999')

  assert.ok(out.length > 1, `应被切成多条，实际 ${out.length}`)
  assert.equal(r.sent, out.length)
  const atCount = out.flatMap((m) => m.segments).filter((s) => s.type === 'at').length
  assert.equal(atCount, 1, 'at 段只应出现一次')
  assert.equal(out[0].segments[0].type, 'at', 'at 应在第一条')
})

await check('切成多条时，中间那片的 at 不会被前一片抢走', async () => {
  const { sender, out } = makeSender({ maxMessageLength: 100 })
  // 第一片 100 字（无 at），第二片开头才有 at
  const body = `${'啊'.repeat(100)}${SENTINEL} 你好`
  await sender.sendRich('group', 999, body, [{ name: '阿蓝', qq: 100 }], 'g:999')

  const withAt = out.filter((m) => m.segments.some((s) => s.type === 'at'))
  assert.equal(withAt.length, 1, '只有一片带 at')
  assert.ok(out.indexOf(withAt[0]) > 0, '应在第一片之后')
})

await check('空文本不发', async () => {
  const { sender, out } = makeSender()
  const r = await sender.sendRich('group', 999, '', [], 'g:999')
  assert.equal(r.sent, 0)
  assert.equal(out.length, 0)
})

await check('纯文本走 send() 时与从前一致', async () => {
  const { sender, out } = makeSender()
  await sender.send('private', 10002, '在的', 'p:10002')
  assert.deepEqual(out[0].segments, [{ type: 'text', data: { text: '在的' } }])
})

await check('限频仍然管得住带 at 的发送', async () => {
  const { sender, out } = makeSender({ maxMessageLength: 100, maxPerMinute: 1 })
  const r = await sender.sendRich('group', 999, '啊'.repeat(250), [], 'g:999')
  assert.equal(r.sent, 1)
  assert.ok(r.dropped > 0, '超出部分应被丢弃')
  assert.equal(out.length, 1)
})

// ────────────────────────── 提示词 ──────────────────────────

console.log('\n[系统提示] @ 规则')

await check('群聊 + 开启时教 @ 语法', () => {
  const p = buildSystemPrompt({ botName: '测试', mentionEnabled: true }, { scene: 'group' })
  assert.ok(p.includes('【@ 别人】'), '应有【@ 别人】段')
  assert.ok(p.includes('[[at:'), '应给出标记格式')
  assert.ok(p.includes('弹提醒'), '应说明打扰感')
  assert.ok(p.includes('不要 @ 你自己'), '应禁止 @ 自己')
})

await check('关闭时不提 @', () => {
  const p = buildSystemPrompt({ botName: '测试', mentionEnabled: false }, { scene: 'group' })
  assert.ok(!p.includes('【@ 别人】'))
  assert.ok(!p.includes('[[at:'))
})

await check('私聊不注入 @ 规则（一对一没有 @ 的意义）', () => {
  const p = buildSystemPrompt({ botName: '测试', mentionEnabled: true }, { scene: 'private' })
  assert.ok(!p.includes('【@ 别人】'))
})

console.log(`\n通过 ${passed} 项\n`)
