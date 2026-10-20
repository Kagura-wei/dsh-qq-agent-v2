/**
 * 提醒 / 通知测试：时间解析、任务提取、命令识别、到点触发与落盘。
 *
 * 运行：node test/reminder-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  cnToNumber,
  readClock,
  parseLocal,
  computeNext,
  formatWhen,
  extractTask,
  parseModelReply,
  buildParsePrompt,
  buildIntentPrompt,
  parseIntentReply,
  weekdayOf,
} from '../lib/reminder-parse.js'
import { ReminderService, matchReminderCommand } from '../lib/reminders.js'

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

const logger = { info() {}, warn() {}, error() {} }

/** 2026-09-20 是周日。所有"今天/明天/周几"的期望值都以它为基准。 */
const BASE = new Date(2026, 8, 20, 2, 0, 0, 0).getTime()
const at = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi, 0, 0).getTime()

console.log('\n[解析] 中文数字')
await check('十 / 十五 / 二十 / 二十三', () => {
  assert.equal(cnToNumber('十'), 10)
  assert.equal(cnToNumber('十五'), 15)
  assert.equal(cnToNumber('二十'), 20)
  assert.equal(cnToNumber('二十三'), 23)
})
await check('零五 = 5，两 = 2，阿拉伯数字直接过', () => {
  assert.equal(cnToNumber('零五'), 5)
  assert.equal(cnToNumber('两'), 2)
  assert.equal(cnToNumber('8'), 8)
})
await check('非数字返回 null', () => {
  assert.equal(cnToNumber('开会'), null)
  assert.equal(cnToNumber(''), null)
})

console.log('\n[解析] 时刻')
await check('8点 / 8:30 / 八点半 / 三点', () => {
  assert.deepEqual(readClock('8点'), { hour: 8, minute: 0 })
  assert.deepEqual(readClock('8:30'), { hour: 8, minute: 30 })
  assert.deepEqual(readClock('八点半'), { hour: 8, minute: 30 })
  assert.deepEqual(readClock('三点'), { hour: 3, minute: 0 })
})
await check('裸数字不是时间', () => {
  assert.equal(readClock('20分'), null)
  assert.equal(readClock('买2个苹果'), null)
})

console.log('\n[解析] 一次性提醒')
await check('明天8点', () => {
  const s = parseLocal('明天8点提醒我开会', BASE)
  assert.equal(s.repeat, 'once')
  assert.equal(s.at, at(2026, 9, 21, 8, 0))
})
await check('明晚8点 = 明天 20:00', () => {
  assert.equal(parseLocal('明晚8点', BASE).at, at(2026, 9, 21, 20, 0))
})
await check('后天下午3点半 = 后天 15:30', () => {
  assert.equal(parseLocal('后天下午3点半', BASE).at, at(2026, 9, 22, 15, 30))
})
await check('没说哪天、时刻还没到 → 今天', () => {
  const s = parseLocal('8点提醒我', BASE)
  assert.equal(s.at, at(2026, 9, 20, 8, 0))
})
await check('没说哪天、时刻已过 → 明天', () => {
  const s = parseLocal('8点提醒我', at(2026, 9, 20, 10, 0))
  assert.equal(s.at, at(2026, 9, 21, 8, 0))
})
await check('明确说了"今天"却已过去 → 不猜，交回上层', () => {
  assert.equal(parseLocal('今天8点提醒我', at(2026, 9, 20, 10, 0)), null)
})
await check('晚上12点 = 次日 00:00', () => {
  const s = parseLocal('晚上12点提醒我睡觉', BASE)
  assert.equal(s.at, at(2026, 9, 21, 0, 0))
})
await check('下午3点 = 15:00', () => {
  assert.equal(parseLocal('下午3点开会', BASE).at, at(2026, 9, 20, 15, 0))
})

console.log('\n[解析] 相对时间')
await check('30分钟后', () => {
  assert.equal(parseLocal('30分钟后提醒我吃药', BASE).at, BASE + 30 * 60_000)
})
await check('两小时后', () => {
  assert.equal(parseLocal('两小时后叫我', BASE).at, BASE + 2 * 3_600_000)
})
await check('半小时后', () => {
  assert.equal(parseLocal('半小时后提醒我', BASE).at, BASE + 30 * 60_000)
})
await check('只说"两个小时"不算（缺"后"）', () => {
  assert.equal(parseLocal('我聊了两个小时', BASE), null)
})
await check('「8点20分后」不会被当成"20分钟后"', () => {
  const s = parseLocal('8点20分后提醒我', BASE)
  assert.equal(s.repeat, 'once')
  assert.equal(s.at, at(2026, 9, 20, 8, 20))
})

console.log('\n[解析] 重复提醒')
await check('每天早上9点 → daily，下一次在今天 09:00', () => {
  const s = parseLocal('每天早上9点提醒我打卡', BASE)
  assert.equal(s.repeat, 'daily')
  assert.equal(s.hour, 9)
  assert.equal(s.minute, 0)
  assert.equal(s.nextAt, at(2026, 9, 20, 9, 0))
})
await check('每天9点（过了就顺延到明天）', () => {
  const s = parseLocal('每天9点打卡', at(2026, 9, 20, 10, 0))
  assert.equal(s.nextAt, at(2026, 9, 21, 9, 0))
})
await check('每周一三五早上7点20 → 周一 07:20', () => {
  const s = parseLocal('每周一三五早上7点20开周会', BASE)
  assert.equal(s.repeat, 'weekly')
  assert.deepEqual(s.weekdays, [1, 3, 5])
  assert.equal(s.hour, 7)
  assert.equal(s.minute, 20)
  assert.equal(s.nextAt, at(2026, 9, 21, 7, 20))
})
await check('每周三9点 → 09-23', () => {
  const s = parseLocal('每周三9点开会', BASE)
  assert.deepEqual(s.weekdays, [3])
  assert.equal(s.nextAt, at(2026, 9, 23, 9, 0))
})
await check('每周7点不会被当"周日"（7 是小时）', () => {
  const s = parseLocal('每周7点提醒我', BASE)
  assert.equal(s.hour, 7)
  assert.deepEqual(s.weekdays, [7]) // 没写周几时按今天算，今天是周日
})

console.log('\n[解析] 不该被认成提醒的句子')
await check('普通讨论里出现数字', () => {
  assert.equal(parseLocal('我买了2个苹果', BASE), null)
  assert.equal(parseLocal('这个报错怎么修', BASE), null)
})

console.log('\n[时间] computeNext')
await check('daily 从触发点往后推一天', () => {
  const spec = { repeat: 'daily', hour: 9, minute: 0 }
  assert.equal(computeNext(spec, at(2026, 9, 20, 9, 0)), at(2026, 9, 21, 9, 0))
})
await check('weekly 跳过不在集合里的日子', () => {
  const spec = { repeat: 'weekly', hour: 9, minute: 0, weekdays: [1, 3] }
  assert.equal(computeNext(spec, at(2026, 9, 21, 9, 0)), at(2026, 9, 23, 9, 0))
})
await check('once 没有下一次', () => {
  assert.equal(computeNext({ repeat: 'once' }, BASE), null)
})

console.log('\n[时间] 格式化')
await check('今天 / 明天 / 后天', () => {
  assert.equal(formatWhen({ repeat: 'once', nextAt: at(2026, 9, 20, 8, 0) }, BASE), '今天 08:00')
  assert.equal(formatWhen({ repeat: 'once', nextAt: at(2026, 9, 21, 8, 0) }, BASE), '明天 08:00')
  assert.equal(formatWhen({ repeat: 'once', nextAt: at(2026, 9, 22, 8, 0) }, BASE), '后天 08:00')
})
await check('更远的日子给月日', () => {
  assert.equal(formatWhen({ repeat: 'once', nextAt: at(2026, 10, 1, 8, 0) }, BASE), '10月1日 08:00')
})
await check('daily / weekly', () => {
  assert.equal(formatWhen({ repeat: 'daily', hour: 9, minute: 5 }, BASE), '每天 09:05')
  assert.equal(formatWhen({ repeat: 'weekly', weekdays: [1, 3], hour: 7, minute: 20 }, BASE), '每周一、周三 07:20')
})

console.log('\n[内容] 任务提取')
await check('明天8点提醒我开会 → 开会', () => {
  const text = '明天8点提醒我开会'
  const s = parseLocal(text, BASE)
  assert.equal(extractTask(text, s.span, '阿蓝'), '开会')
})
await check('@ 与机器人名都要剥掉', () => {
  const text = '阿蓝，明天下午3点提醒我交报告'
  const s = parseLocal(text, BASE)
  assert.equal(extractTask(text, s.span, '阿蓝'), '交报告')
})
await check('相对时间 + 触发词', () => {
  const text = '@123456 提醒我30分钟后吃药'
  const s = parseLocal(text, BASE)
  assert.equal(extractTask(text, s.span, '阿蓝'), '吃药')
})
await check('每天9点提醒我打卡 → 打卡（"每天"不能留在内容里）', () => {
  const text = '每天9点提醒我打卡'
  const s = parseLocal(text, BASE)
  assert.equal(extractTask(text, s.span, '阿蓝'), '打卡')
})
await check('句子太短没内容时返回空串', () => {
  const text = '提醒我明天8点'
  const s = parseLocal(text, BASE)
  assert.equal(extractTask(text, s.span, '阿蓝'), '')
})

console.log('\n[命令] 识别')
await check('查看类', () => {
  for (const t of ['查看提醒', '我的提醒', '提醒列表', '有哪些提醒', '本群提醒']) {
    assert.deepEqual(matchReminderCommand(t), { kind: 'list' }, t)
  }
})
await check('取消类', () => {
  assert.deepEqual(matchReminderCommand('取消提醒'), { kind: 'cancel', target: 'last' })
  assert.deepEqual(matchReminderCommand('取消提醒 2'), { kind: 'cancel', target: 2 })
  assert.deepEqual(matchReminderCommand('删除提醒2'), { kind: 'cancel', target: 2 })
  assert.deepEqual(matchReminderCommand('取消全部提醒'), { kind: 'cancel', target: 'all' })
  assert.deepEqual(matchReminderCommand('取消所有提醒'), { kind: 'cancel', target: 'all' })
})
await check('带标点也算命令', () => {
  assert.deepEqual(matchReminderCommand('查看提醒。'), { kind: 'list' })
  assert.deepEqual(matchReminderCommand(' 查看提醒 '), { kind: 'list' })
  assert.deepEqual(matchReminderCommand('取消提醒 1！'), { kind: 'cancel', target: 1 })
})
await check('正常句子不会被当成命令', () => {
  assert.equal(matchReminderCommand('提醒我明天8点开会'), null)
  assert.equal(matchReminderCommand('明天8点提醒我开会'), null)
  assert.equal(matchReminderCommand('看看这个图'), null)
})

console.log('\n[模型兜底] 回包解析')
await check('合法 JSON', () => {
  const raw = '{"ok":true,"repeat":"once","when":"2026-09-21T08:00","task":"开会"}'
  const s = parseModelReply(raw, BASE)
  assert.equal(s.repeat, 'once')
  assert.equal(s.task, '开会')
  assert.equal(s.at, at(2026, 9, 21, 8, 0))
})
await check('代码块包裹也能剥出来', () => {
  const raw = '```json\n{"ok":true,"repeat":"daily","when":"2026-09-21T09:00","task":"打卡"}\n```'
  const s = parseModelReply(raw, BASE)
  assert.equal(s.repeat, 'daily')
  assert.equal(s.nextAt, at(2026, 9, 20, 9, 0))
})
await check('weekly 带 weekdays', () => {
  const raw = '{"ok":true,"repeat":"weekly","when":"2026-09-21T07:20","weekdays":[1,3,5],"task":"开周会"}'
  const s = parseModelReply(raw, BASE)
  assert.deepEqual(s.weekdays, [1, 3, 5])
  assert.equal(s.nextAt, at(2026, 9, 21, 7, 20))
})
await check('ok:false / 垃圾输出 / 过去时间 → null', () => {
  assert.equal(parseModelReply('{"ok":false}', BASE), null)
  assert.equal(parseModelReply('我猜是明天吧', BASE), null)
  assert.equal(parseModelReply('{"ok":true,"repeat":"once","when":"2026-09-19T08:00","task":"开会"}', BASE), null)
  assert.equal(parseModelReply('{"ok":true,"repeat":"once","when":"2026-09-21T08:00","task":""}', BASE), null)
})
await check('提示词带上当前时间与用户原话', () => {
  const p = buildParsePrompt({ text: '下周三提醒我交报告', now: new Date(BASE), botName: '阿蓝' })
  assert.ok(p.includes('2026-09-20 02:00'), '应包含当前时间')
  assert.ok(p.includes('下周三提醒我交报告'), '应包含用户原话')
})
await check('用户原话里的 {{ 被打散（提示词插值保护）', () => {
  const p = buildParsePrompt({ text: '{{a}} 后提醒我', now: new Date(BASE), botName: '阿蓝' })
  assert.ok(!p.includes('{{a}}'))
})

console.log('\n[意图判定] 防误触发的闸门')

await check('只认开头字母：Y / N / 多余解释', () => {
  assert.equal(parseIntentReply('Y'), 'Y')
  assert.equal(parseIntentReply('N'), 'N')
  assert.equal(parseIntentReply('y'), 'Y')
  assert.equal(parseIntentReply('Y（这是在设提醒）'), 'Y')
  assert.equal(parseIntentReply(' ```Y``` '), 'Y')
  assert.equal(parseIntentReply('N。这是闲聊'), 'N')
})
await check('空输出 / 认不出来 → null（调用方按不建处理）', () => {
  assert.equal(parseIntentReply(''), null)
  assert.equal(parseIntentReply('   '), null)
  assert.equal(parseIntentReply('我不确定'), null)
  assert.equal(parseIntentReply(undefined), null)
})
await check('判定提示词带上原话与机器人名，且 {{ 被打散', () => {
  const p = buildIntentPrompt({ text: '{{x}} 明天8点提醒我', botName: '阿蓝' })
  assert.ok(p.includes('阿蓝'))
  assert.ok(p.includes('明天8点提醒我'))
  assert.ok(!p.includes('{{x}}'))
  assert.ok(p.includes('拿不准 → N'), '判不准要落到 N')
})

console.log('\n[服务] 创建 / 触发 / 取消 / 落盘')

/**
 * @param {{intent?: string, withLlm?: boolean}} opts
 *   intent: 假模型对"是不是设提醒"的回答（Y / N / throw）
 *   withLlm: false 表示判定通道不可用（没装 llm 服务）
 */
function makeHarness({ intent = 'Y', withLlm = true } = {}) {
  let clock = BASE
  const sent = []
  const sender = {
    async send(scene, peerId, text, key) {
      sent.push({ kind: 'text', scene, peerId, text, key })
      return { sent: 1, dropped: 0 }
    },
    async sendSegments(scene, peerId, segments, key) {
      sent.push({ kind: 'segments', scene, peerId, segments, key })
      return { sent: 1, dropped: 0 }
    },
  }
  const archive = { getRecentCached: () => [], markRead: async () => true }
  // 假模型只服务意图判定 —— 解析走 reminderLlmParse:false，不该再调模型。
  const llm = {
    async *stream({ messages }) {
      const text = messages?.[0]?.content?.[0]?.text ?? ''
      if (!text.includes('判 Y（是在设提醒）')) {
        yield { type: 'text-delta', text: '{"ok":false}' }
        yield { type: 'finish' }
        return
      }
      if (intent === 'throw') throw new Error('模型挂了')
      yield { type: 'text-delta', text: intent }
      yield { type: 'finish' }
    },
  }
  const ctx = { get: (name) => (name === 'llm' && withLlm ? llm : undefined) }
  const cfg = {
    reminderEnabled: true,
    reminderIntentJudge: true,
    reminderKeywords: ['提醒', '叫我'],
    reminderRequireMention: false,
    reminderConfirm: true,
    reminderAtCreator: true,
    reminderLlmParse: false, // 单测不连模型
    reminderCatchUpMin: 30,
    reminderMaxPerChat: 50,
    botName: '阿蓝',
    provider: 'p',
    model: 'm',
  }
  return {
    sent,
    cfg,
    getClock: () => clock,
    setClock: (v) => {
      clock = v
    },
    make: (dir) =>
      new ReminderService({
        ctx,
        getConfig: () => cfg,
        sender,
        archive,
        logger,
        dir,
        now: () => clock,
        autoStart: false,
      }),
  }
}

const msgOf = (text, extra = {}) => ({
  scene: 'group',
  peerId: 999999,
  senderId: 555,
  senderName: '小明',
  messageId: 1001,
  text,
  segments: [{ type: 'text', data: { text } }],
  ...extra,
})

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reminder-'))

{
  const h = makeHarness()
  const svc = h.make(tmpDir)
  await svc.init()

  const take = await svc.tryHandle({
    cfg: h.cfg,
    msg: msgOf('明天8点提醒我开会'),
    mention: false,
    decision: { accept: false, reason: 'not-mentioned' },
    key: 'group:999999',
  })

  await check('关键词命中 → 接管并建提醒', () => {
    assert.equal(take, true)
    assert.equal(svc.items.length, 1)
    assert.equal(svc.items[0].task, '开会')
    assert.equal(svc.items[0].nextAt, at(2026, 9, 21, 8, 0))
  })
  await check('回执带时间与内容', () => {
    assert.ok(h.sent.some((s) => s.kind === 'text' && s.text.includes('明天 08:00') && s.text.includes('开会')))
  })

  await check('无关的话不接管', async () => {
    const r = await svc.tryHandle({
      cfg: h.cfg,
      msg: msgOf('今天天气不错'),
      mention: false,
      decision: { accept: false, reason: 'not-mentioned' },
      key: 'group:999999',
    })
    assert.equal(r, false)
  })

  await check('重复设置同一条不重复入库', async () => {
    const r = await svc.tryHandle({
      cfg: h.cfg,
      msg: msgOf('明天8点提醒我开会'),
      mention: false,
      decision: { accept: false, reason: 'not-mentioned' },
      key: 'group:999999',
    })
    assert.equal(r, true)
    assert.equal(svc.items.length, 1)
  })

  await check('未到点不发', async () => {
    const before = h.sent.length
    await svc.tickOnce()
    assert.equal(h.sent.length, before)
  })

  h.setClock(at(2026, 9, 21, 8, 0))
  await svc.tickOnce()

  await check('到点发出，且群里 @ 设置者', () => {
    const fired = h.sent.at(-1)
    assert.equal(fired.kind, 'segments')
    assert.equal(fired.segments[0].type, 'at')
    assert.equal(fired.segments[0].data.qq, '555')
    assert.ok(fired.segments[1].data.text.includes('提醒'))
    assert.ok(fired.segments[1].data.text.includes('开会'))
  })
  await check('一次性提醒发完即销', () => {
    assert.equal(svc.items.length, 0)
    assert.equal(svc.stats.fired, 1)
  })

  await check('重复提醒发完保留并推进到下一位', async () => {
    await svc.tryHandle({
      cfg: h.cfg,
      msg: msgOf('每天9点提醒我打卡'),
      mention: false,
      decision: { accept: false, reason: 'not-mentioned' },
      key: 'group:999999',
    })
    assert.equal(svc.items.length, 1)
    h.setClock(at(2026, 9, 22, 9, 0))
    await svc.tickOnce()
    assert.equal(svc.items.length, 1)
    assert.equal(svc.items[0].nextAt, at(2026, 9, 23, 9, 0))
  })

  await check('错误输入的序号会被挡下', async () => {
    await svc.tryHandle({
      cfg: h.cfg,
      msg: msgOf('取消提醒 9'),
      mention: false,
      decision: { accept: false, reason: 'not-mentioned' },
      key: 'group:999999',
    })
    assert.ok(h.sent.at(-1).text.includes('没有第 9 条'))
    assert.equal(svc.items.length, 1)
  })

  await check('查看提醒列出条目', async () => {
    await svc.tryHandle({
      cfg: h.cfg,
      msg: msgOf('查看提醒'),
      mention: false,
      decision: { accept: false, reason: 'not-mentioned' },
      key: 'group:999999',
    })
    assert.ok(h.sent.at(-1).text.includes('打卡'))
  })

  await check('取消提醒 1 生效', async () => {
    await svc.tryHandle({
      cfg: h.cfg,
      msg: msgOf('取消提醒 1'),
      mention: false,
      decision: { accept: false, reason: 'not-mentioned' },
      key: 'group:999999',
    })
    assert.equal(svc.items.length, 0)
    assert.ok(h.sent.at(-1).text.includes('已取消'))
  })

  await check('别人的提醒不能替你取消', async () => {
    await svc.tryHandle({
      cfg: h.cfg,
      msg: msgOf('每天9点提醒我打卡'),
      mention: false,
      decision: { accept: false, reason: 'not-mentioned' },
      key: 'group:999999',
    })
    await svc.tryHandle({
      cfg: h.cfg,
      msg: msgOf('取消提醒 1', { senderId: 777, senderName: '小红' }),
      mention: false,
      decision: { accept: false, reason: 'not-mentioned' },
      key: 'group:999999',
    })
    assert.equal(svc.items.length, 1)
    assert.ok(h.sent.at(-1).text.includes('不是你设的'))
    svc.items.length = 0
    await svc.tickOnce() // 触发内部 flush 之外的路径不应崩
  })

  await svc.stop()
}

console.log('\n[判定闸门] 模型说不建就不建')

/** 造一个独立服务免得 items 串味。 */
async function freshService(opts) {
  const h = makeHarness(opts)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reminder-gate-'))
  const svc = h.make(dir)
  await svc.init()
  return { h, svc }
}

const gateMsg = (text, extra) => ({
  cfg: undefined,
  msg: msgOf(text, extra),
  mention: true,
  decision: { accept: false, reason: 'not-mentioned' },
  key: 'group:999999',
})

{
  const { h, svc } = await freshService({ intent: 'N' })

  await check('@ 了但模型判 N → 不建、不回执、交回正常聊天', async () => {
    const r = await svc.tryHandle({ ...gateMsg('明天8点提醒我开会'), cfg: h.cfg })
    assert.equal(r, false, '要交回 agent，让机器人正常接话')
    assert.equal(svc.items.length, 0, '不该入库')
    assert.equal(h.sent.length, 0, '不该发确认回执')
    assert.equal(svc.stats.vetoed, 1)
  })

  await check('关键词命中但模型判 N → 同样不建', async () => {
    const r = await svc.tryHandle({ ...gateMsg('你提醒他一下明天别迟到', { senderId: 556 }), cfg: h.cfg })
    assert.equal(r, false)
    assert.equal(svc.items.length, 0)
  })

  await check('管理命令不过闸门：判 N 也能列出提醒', async () => {
    const r = await svc.tryHandle({ ...gateMsg('查看提醒'), cfg: h.cfg })
    assert.equal(r, true)
    assert.ok(h.sent.at(-1).text.includes('还没有提醒'))
  })

  await svc.stop()
}

{
  const { h, svc } = await freshService({ withLlm: false })

  await check('判定通道不可用 → fail-closed，不建也不回执', async () => {
    const r = await svc.tryHandle({ ...gateMsg('明天8点提醒我开会'), cfg: h.cfg })
    assert.equal(r, false)
    assert.equal(svc.items.length, 0)
    assert.equal(h.sent.length, 0)
  })

  await svc.stop()
}

{
  const { h, svc } = await freshService({ intent: 'throw' })

  await check('判定调用报错 → 按不建处理，不抛到上层', async () => {
    const r = await svc.tryHandle({ ...gateMsg('明天8点提醒我开会'), cfg: h.cfg })
    assert.equal(r, false)
    assert.equal(svc.items.length, 0)
  })

  await svc.stop()
}

{
  const { h, svc } = await freshService({ intent: 'N' })
  h.cfg.reminderIntentJudge = false

  await check('逃生开关关掉判定 → 退回"命中即建"的旧行为', async () => {
    const r = await svc.tryHandle({ ...gateMsg('明天8点提醒我开会'), cfg: h.cfg })
    assert.equal(r, true)
    assert.equal(svc.items.length, 1)
  })

  await svc.stop()
}

{
  const h = makeHarness()
  const svc = h.make(tmpDir)
  await svc.init()

  await check('落盘后重新加载能读回来', async () => {
    await svc.tryHandle({
      cfg: h.cfg,
      msg: msgOf('明天8点提醒我开会'),
      mention: false,
      decision: { accept: false, reason: 'not-mentioned' },
      key: 'group:999999',
    })
    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'qq-reminders.json'), 'utf8'))
    assert.equal(raw.items.length, 1)
    assert.equal(raw.items[0].task, '开会')

    const again = h.make(tmpDir)
    await again.init()
    assert.equal(again.items.length, 1)
    assert.equal(again.items[0].task, '开会')
    await again.stop()
  })

  await check('停机跨过触发点 → 补发', async () => {
    h.setClock(at(2026, 9, 21, 8, 10)) // 晚 10 分钟，在 30 分钟窗口内
    const before = h.sent.length
    await svc.tickOnce()
    assert.equal(h.sent.length, before + 1)
    assert.ok(h.sent.at(-1).segments[1].data.text.includes('（补发）'))
    assert.equal(svc.items.length, 0)
  })

  await check('错过超过窗口 → 跳过并作废', async () => {
    h.setClock(BASE)
    await svc.tryHandle({
      cfg: h.cfg,
      msg: msgOf('明天8点提醒我开会'),
      mention: false,
      decision: { accept: false, reason: 'not-mentioned' },
      key: 'group:999999',
    })
    const before = h.sent.length
    h.setClock(at(2026, 9, 21, 12, 0)) // 晚 4 小时
    await svc.tickOnce()
    assert.equal(h.sent.length, before)
    assert.equal(svc.stats.missed, 1)
    assert.equal(svc.items.length, 0)
  })

  await check('发送失败会重试，不静默丢失', async () => {
    h.setClock(BASE)
    await svc.tryHandle({
      cfg: h.cfg,
      msg: msgOf('明天8点提醒我开会'),
      mention: false,
      decision: { accept: false, reason: 'not-mentioned' },
      key: 'group:999999',
    })
    const original = svc.sender.sendSegments
    svc.sender.sendSegments = async () => {
      throw new Error('NapCat 未连接')
    }
    h.setClock(at(2026, 9, 21, 8, 0))
    await svc.tickOnce()
    assert.equal(svc.items.length, 1)
    assert.equal(svc.items[0].fail, 1)
    assert.equal(svc.items[0].nextAt, at(2026, 9, 21, 8, 0) + 60_000)
    svc.sender.sendSegments = original
    h.setClock(at(2026, 9, 21, 8, 1))
    await svc.tickOnce()
    assert.equal(svc.items.length, 0)
  })

  await check('白名单/屏蔽名单的消息不处理', async () => {
    const r = await svc.tryHandle({
      cfg: h.cfg,
      msg: msgOf('提醒我明天8点开会'),
      mention: false,
      decision: { accept: false, reason: 'blocked' },
      key: 'group:999999',
    })
    assert.equal(r, false)
  })

  await check('开关关掉后完全不介入', async () => {
    const r = await svc.tryHandle({
      cfg: { ...h.cfg, reminderEnabled: false },
      msg: msgOf('提醒我明天8点开会'),
      mention: false,
      decision: { accept: false, reason: 'not-mentioned' },
      key: 'group:999999',
    })
    assert.equal(r, false)
  })

  await check('只要 @ 模式时，关键词不算数', async () => {
    const r = await svc.tryHandle({
      cfg: { ...h.cfg, reminderRequireMention: true },
      msg: msgOf('提醒我明天8点开会'),
      mention: false,
      decision: { accept: false, reason: 'not-mentioned' },
      key: 'group:999999',
    })
    assert.equal(r, false)
    const r2 = await svc.tryHandle({
      cfg: { ...h.cfg, reminderRequireMention: true },
      msg: msgOf('提醒我明天8点开会'),
      mention: true,
      decision: { accept: true, reason: 'at' },
      key: 'group:999999',
    })
    assert.equal(r2, true)
    svc.items.length = 0
  })

  await check('每条会话独立计数，互不干扰', async () => {
    await svc.tryHandle({
      cfg: h.cfg,
      msg: msgOf('明天8点提醒我开会'),
      mention: false,
      decision: { accept: false, reason: 'not-mentioned' },
      key: 'group:999999',
    })
    await svc.tryHandle({
      cfg: h.cfg,
      msg: { ...msgOf('明天9点提醒我买菜'), scene: 'private', peerId: 555, senderId: 555 },
      mention: false,
      decision: { accept: true, reason: 'at' },
      key: 'private:555',
    })
    await svc.tryHandle({
      cfg: h.cfg,
      msg: msgOf('查看提醒'),
      mention: false,
      decision: { accept: false, reason: 'not-mentioned' },
      key: 'group:999999',
    })
    const list = h.sent.at(-1).text
    assert.ok(list.includes('开会'))
    assert.ok(!list.includes('买菜'), '私聊的提醒不该出现在群列表里')
    svc.items.length = 0
  })

  await svc.stop()
  await fs.rm(tmpDir, { recursive: true, force: true })
}

await check('weekdayOf: 周日 = 7', () => {
  assert.equal(weekdayOf(at(2026, 9, 20, 12, 0)), 7)
  assert.equal(weekdayOf(at(2026, 9, 21, 12, 0)), 1)
})

console.log(`\n提醒测试：${passed} 项通过${process.exitCode ? '（有失败）' : ''}`)
