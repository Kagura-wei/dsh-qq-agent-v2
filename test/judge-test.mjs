/**
 * 轻量判定测试（假 llm 服务，不依赖真实 DSH 运行时）。
 *
 * 重点验证三件事：
 *   1. 判定走的是 ctx.llm.stream()，且请求里**没有工具、没有 agent 系统提示**
 *      —— 这是它比主会话便宜两个数量级的唯一原因，必须锁死。
 *   2. 任何失败都收敛成"不回"，绝不冒泡、绝不刷屏。
 *   3. 节流与并发上限真的挡得住高峰。
 * 运行：node test/judge-test.mjs
 */
import assert from 'node:assert/strict'
import { Judge, parseVerdict, parseVerdict3 } from '../lib/judge.js'

const logger = { info() {}, warn() {}, error() {} }

/**
 * 假 ctx + 假 llm 服务，记录每次请求。
 *
 * @param {object} o
 * @param {string} o.reply 模型输出
 * @param {Error|null} o.fail 抛错
 * @param {boolean} o.hang 永不返回（考察超时路径，会响应 signal）
 * @param {boolean} o.noLlm 宿主没有 llm 服务
 * @param {object|null} o.defaultModel agentDefaultModel 的返回值
 */
function makeCtx({ reply = 'N', fail = null, hang = false, noLlm = false, defaultModel = { provider: 'p-main', model: 'm-main' }, blockEndOnly = false } = {}) {
  const requests = []

  const llm = {
    async *stream(options) {
      requests.push(options)
      if (hang) {
        // 真实适配器会响应 signal；假实现也必须响应，否则超时用例会真卡死
        await new Promise((_resolve, reject) => {
          if (options.signal?.aborted) return reject(new Error('aborted'))
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        })
      }
      if (fail) throw fail
      if (blockEndOnly) {
        // 个别适配器不发增量，只在 block-end 里给整块文本
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 1 } }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 487, outputTokens: 3, cacheReadTokens: 64 } }
      yield { type: 'finish', reason: 'stop' }
    },
  }

  return {
    requests,
    get(name) {
      if (name === 'llm') return noLlm ? undefined : llm
      if (name === 'agentDefaultModel') {
        return defaultModel ? { currentSelection: () => defaultModel } : undefined
      }
      return undefined
    },
  }
}

function makeJudge(ctx, config = {}) {
  const cfg = { judgeEnabled: true, botName: '阿蓝', contextSliderPos: 25, ...config }
  return new Judge({ ctx, getConfig: () => cfg, logger })
}

const recent = [
  { seq: 1, senderId: 1, senderName: '甲', text: '今晚这局打得怎么样呀' },
  { seq: 2, senderId: 2, senderName: '乙', text: '还行，就是最后一把拉了' },
  { seq: 3, senderId: 1, senderName: '甲', text: '哈哈' },
]

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}\n      ${error.message}`)
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}\n      ${error.message}`)
  }
}

console.log('【Y/N 解析】')

check('Y / y / 是 / 要 / 1 都判为要回', () => {
  for (const [input, want] of [
    ['Y', true],
    ['y', true],
    ['Y.', true],
    ['  Y\n', true],
    ['是', true],
    ['要', true],
    ['1', true],
  ]) {
    assert.equal(parseVerdict(input).reply, want, `输入 ${JSON.stringify(input)}`)
  }
})

check('N / n / 否 / 不 / 0 都判为不回', () => {
  for (const [input, want] of [
    ['N', false],
    ['n', false],
    ['N。', false],
    ['否', false],
    ['不', false],
    ['0', false],
  ]) {
    assert.equal(parseVerdict(input).reply, want, `输入 ${JSON.stringify(input)}`)
  }
})

check('认不出的输出一律当"不回"（宁可漏回，不可乱回）', () => {
  assert.equal(parseVerdict('这个嘛，我觉得可以考虑一下').reply, false)
  assert.equal(parseVerdict('').reply, false)
  assert.equal(parseVerdict(undefined).reply, false)
  assert.equal(parseVerdict(null).reply, false)
})

check('带解释的 YES 也能兜住', () => {
  assert.equal(parseVerdict('YES 我觉得该回').reply, true)
})

console.log('\n【请求构造：便宜的全部依据】')

await checkAsync('走 ctx.llm.stream，且不带任何工具 schema', async () => {
  const ctx = makeCtx({ reply: 'Y' })
  const judge = makeJudge(ctx)
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(ctx.requests.length, 1)
  assert.equal(ctx.requests[0].tools, undefined, '绝不能带工具')
})

await checkAsync('system 是我们自己的极简提示，不是 16k 字的 agent 提示', async () => {
  const ctx = makeCtx({ reply: 'Y' })
  const judge = makeJudge(ctx)
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  const sys = ctx.requests[0].system
  assert.ok(sys, 'system 不能为空')
  assert.ok(sys.length < 200, `system 必须极短，实际 ${sys.length} 字`)
  assert.ok(!/DeepSeek Harness|WRITE PROTOCOL|web_search/.test(sys), '不能混进 agent 系统提示')
})

await checkAsync('不发增量、只在 block-end 给整块文本的适配器也能解析', async () => {
  const ctx = makeCtx({ reply: 'Y', blockEndOnly: true })
  const judge = makeJudge(ctx)
  const r = await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(r.reply, true, `block-end 的文本应被采用，实际 verdict=${r.verdict}`)
})

await checkAsync('输出上限留了思考余量（16 会全被推理吃掉）', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx)
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  // 不传 reasoningEffort 时模型走默认推理档位，思考会先吃掉一部分输出预算；
  // 16 全被吃掉后正文为空（真机出现过），64 足够思考 + 一个 Y/N
  assert.ok(ctx.requests[0].maxTokens >= 48, `maxTokens 应 ≥48，实际 ${ctx.requests[0].maxTokens}`)
})

await checkAsync('purpose 用辅助调用分类（与生成会话标题同通道）', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx)
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(ctx.requests[0].purpose, 'session-title')
})

await checkAsync('temperature 为 0（二分类不该抖动）', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx)
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  // 不显式给 0 时，同一段对话在不同轮次会给出相反结论，准确率只有六成
  assert.equal(ctx.requests[0].temperature, 0)
})

await checkAsync('提示词里带上最近对话与判定标准', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx)
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  const text = ctx.requests[0].messages[0].content[0].text
  assert.ok(text.includes('甲: 今晚这局打得怎么样呀'), '要带上最近对话')
  assert.ok(text.includes('阿蓝'), '要带上机器人名字')
  assert.ok(text.includes('Y'), '要说明输出格式')
})

await checkAsync('额外规则会拼进判定标准', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx, { judgePromptExtra: '有人聊到光缆一定要接' })
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  const text = ctx.requests[0].messages[0].content[0].text
  assert.ok(text.includes('有人聊到光缆一定要接'))
})

await checkAsync('群消息里的 {{}} 会被打散（防止被当提示词变量）', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx)
  await judge.evaluate({
    key: 'group:1',
    scene: 'group',
    recent: [{ seq: 1, senderName: '甲', text: '看看 {{model}} 这个变量' }],
  })
  const text = ctx.requests[0].messages[0].content[0].text
  assert.ok(!text.includes('{{model}}'), '原始 {{model}} 不应出现')
})

console.log('\n【机器人自己说过的话：防止重复作答】')

await checkAsync('回复发出后，判定上下文里能看到机器人自己说过什么', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx)
  judge.recordReply({ key: 'group:1', text: '截个图看看？' })
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  const text = ctx.requests[0].messages[0].content[0].text
  assert.ok(text.includes('截个图看看？'), '刚说过的话必须出现在判定提示里')
  assert.ok(text.includes('我（阿蓝）'), '要标明这是机器人自己的发言')
})

await checkAsync('没回复过时，不应出现空的"我（机器人）"行', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx)
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  const text = ctx.requests[0].messages[0].content[0].text
  assert.ok(!text.includes('我（阿蓝）'), '没说过话就别加这一行')
})

await checkAsync('只留最近 4 条，不会无限涨', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx)
  for (let i = 1; i <= 9; i++) judge.recordReply({ key: 'group:1', text: `第${i}句` })
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  const text = ctx.requests[0].messages[0].content[0].text
  assert.ok(text.includes('第9句'), '要留最新的')
  assert.ok(text.includes('第6句'), '要留最近 4 条里的')
  assert.ok(!text.includes('第5句'), '更早的必须丢掉')
})

await checkAsync('空回复与缺 key 都不记录', () => {
  const judge = makeJudge(makeCtx({ reply: 'N' }))
  judge.recordReply({ key: 'group:1', text: '   ' })
  judge.recordReply({ key: null, text: '有内容' })
  judge.recordReply({ key: 'group:1' })
  assert.equal(judge.recentBotReplies.size, 0)
})

await checkAsync('判定标准明确"只看最新一条"（否则会为陈年未答的提问反复插嘴）', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx)
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  const text = ctx.requests[0].messages[0].content[0].text
  assert.ok(/只看最新一条/.test(text), '少了这句，模型会去管更早没人回的提问')
  assert.ok(/不要因为更早的提问没人回就判 Y/.test(ctx.requests[0].system))
})

await checkAsync('配置了判定专用模型就用它', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx, { judgeProvider: 'p-small', judgeModel: 'm-small' })
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(ctx.requests[0].provider, 'p-small')
  assert.equal(ctx.requests[0].model, 'm-small')
})

await checkAsync('只填判定模型时，provider 回落到默认', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx, { judgeModel: 'm-small' })
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(ctx.requests[0].provider, 'p-main')
  assert.equal(ctx.requests[0].model, 'm-small')
})

await checkAsync('未配判定模型时回落到宿主默认', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx)
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(ctx.requests[0].provider, 'p-main')
  assert.equal(ctx.requests[0].model, 'm-main')
})

console.log('\n【判定不可用：默认照旧接话，不静默】')

await checkAsync('模型抛错 → 接话（判定只当刹车），且不抛异常', async () => {
  const ctx = makeCtx({ fail: new Error('provider 挂了') })
  const judge = makeJudge(ctx)
  const r = await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(r.reply, true, '故障不该让机器人整体沉默')
  assert.equal(r.reason, 'error-failopen')
  assert.equal(judge.stats.errors, 1)
})

await checkAsync('关掉 failOpen 后，故障才按"不接话"处理', async () => {
  const ctx = makeCtx({ fail: new Error('provider 挂了') })
  const judge = makeJudge(ctx, { judgeFailOpen: false })
  const r = await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(r.reply, false)
  assert.equal(r.reason, 'error')
})

await checkAsync('宿主没有 ctx.llm → 接话（没判定可用，不拦消息）', async () => {
  const ctx = makeCtx({ noLlm: true })
  const judge = makeJudge(ctx)
  const r = await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(r.reply, true)
  assert.equal(r.reason, 'no-llm-failopen')
})

await checkAsync('解析不出 provider/model → 接话，且不发请求', async () => {
  const ctx = makeCtx({ defaultModel: null })
  const judge = makeJudge(ctx)
  const r = await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(r.reply, true)
  assert.equal(r.reason, 'no-route-failopen')
  assert.equal(ctx.requests.length, 0, '不该发起请求')
})

await checkAsync('超时 → 接话（不会卡住后续消息，也不会静默）', async () => {
  const ctx = makeCtx({ hang: true })
  const judge = makeJudge(ctx, { judgeTimeoutMs: 30 })
  const r = await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(r.reply, true)
  assert.equal(judge.inFlight, 0, 'inFlight 必须归还，否则后续判定全被挡住')
})

await checkAsync('模型答了但答不出结论（unrecognized）→ 不接话', async () => {
  // 区分"不可用"和"没判为相关"：模型在工作，只是没给肯定结论 → 保守不打扰
  const ctx = makeCtx({ reply: '嗯…这个不好说' })
  const judge = makeJudge(ctx)
  const r = await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(r.reply, false)
  assert.equal(r.reason, 'unrecognized')
})

console.log('\n【节流与并发：挡住高峰】')

await checkAsync('同一群在最小间隔内只判一次', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx, { judgeMinIntervalMs: 60_000 })
  const a = await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  const b = await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(a.reason, 'no')
  assert.equal(b.reason, 'throttled')
  assert.equal(ctx.requests.length, 1, '第二次不该发起请求')
})

await checkAsync('不同群各算各的节流', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx, { judgeMinIntervalMs: 60_000 })
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  const b = await judge.evaluate({ key: 'group:2', scene: 'group', recent })
  assert.equal(b.reason, 'no')
  assert.equal(ctx.requests.length, 2)
})

await checkAsync('并发超上限直接跳过', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx, { judgeMaxInFlight: 1, judgeMinIntervalMs: 0 })
  judge.inFlight = 1 // 模拟已有一个在飞
  const r = await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(r.reason, 'busy')
  assert.equal(ctx.requests.length, 0)
})

console.log('\n【跟进期窗口：几点开、多久关】')

check('回复成功会开窗', () => {
  const judge = makeJudge(makeCtx())
  assert.equal(judge.isInFollowUp('group:1'), false, '没回过话就没有话题')
  judge.recordReply({ key: 'group:1', text: '这个报错是端口占用了' })
  assert.equal(judge.isInFollowUp('group:1'), true)
})

check('窗口时长跟着 judgeFollowUpMin 走（默认 10 分钟）', () => {
  const judge = makeJudge(makeCtx())
  const now = Date.now()
  judge.recordReply({ key: 'group:1', text: '嗯', now })
  assert.equal(judge.isInFollowUp('group:1', now + 9 * 60_000), true, '9 分钟内还在聊')
  assert.equal(judge.isInFollowUp('group:1', now + 11 * 60_000), false, '超过 10 分钟就收工')
})

check('回复时间已过窗口 → 视为过期', () => {
  const judge = makeJudge(makeCtx())
  judge.recordReply({ key: 'group:1', text: '嗯', now: Date.now() - 11 * 60_000 })
  assert.equal(judge.isInFollowUp('group:1'), false)
})

check('窗口内再接一次话，窗口顺延（话题还在继续）', () => {
  const judge = makeJudge(makeCtx())
  const t0 = Date.now()
  judge.recordReply({ key: 'group:1', text: '第一句', now: t0 })
  judge.recordReply({ key: 'group:1', text: '第二句', now: t0 + 8 * 60_000 })
  assert.equal(judge.isInFollowUp('group:1', t0 + 12 * 60_000), true, '顺延后 12 分钟仍有效')
  assert.equal(judge.isInFollowUp('group:1', t0 + 19 * 60_000), false)
})

check('跟进期设 0 → 窗口永不打开', () => {
  const judge = makeJudge(makeCtx(), { judgeFollowUpMin: 0 })
  judge.recordReply({ key: 'group:1', text: '嗯' })
  assert.equal(judge.isInFollowUp('group:1'), false)
})

check('空回复、缺 key 都不开窗（没真发出去就不算说过话）', () => {
  const judge = makeJudge(makeCtx())
  judge.recordReply({ key: 'group:1', text: '   ' })
  judge.recordReply({ key: null, text: '有内容' })
  judge.recordReply({ key: 'group:1' })
  assert.equal(judge.isInFollowUp('group:1'), false)
})

check('窗口按群各算各的', () => {
  const judge = makeJudge(makeCtx())
  judge.recordReply({ key: 'group:1', text: '嗯' })
  assert.equal(judge.isInFollowUp('group:1'), true)
  assert.equal(judge.isInFollowUp('group:2'), false)
})

console.log('\n【接话提示词：只带窗口内的话题】')

await checkAsync('窗口外的老对话不进提示词（免模型把陈年提问当待接的话）', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx, { judgeFollowUpMin: 10, judgeContextMessages: 8 })
  const nowSec = Math.floor(Date.now() / 1000)
  const mixed = [
    { seq: 1, senderId: 1, senderName: '甲', text: '昨天那个报错修好了吗', time: nowSec - 3600 },
    { seq: 2, senderId: 1, senderName: '甲', text: '这个端口占用怎么解', time: nowSec - 120 },
    { seq: 3, senderId: 2, senderName: '乙', text: '换个端口试试', time: nowSec - 60 },
    { seq: 4, senderId: 1, senderName: '甲', text: '那 6701 换成 6702 可以吗', time: nowSec - 5 },
  ]
  await judge.evaluate({ key: 'group:1', scene: 'group', recent: mixed })
  const prompt = ctx.requests[0].messages[0].content[0].text
  assert.equal(prompt.includes('昨天那个报错修好了吗'), false, '1 小时前的话属于旧话题')
  assert.equal(prompt.includes('那 6701 换成 6702 可以吗'), true, '最新一条永远在')
  assert.equal(prompt.includes('这个端口占用怎么解'), true)
})

await checkAsync('判定标准里说明了跟进期时长', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx, { judgeFollowUpMin: 15 })
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  const prompt = ctx.requests[0].messages[0].content[0].text
  assert.match(prompt, /15 分钟/)
  assert.match(prompt, /还在延续这个话题|同一个话题/)
})

console.log('\n【作用域：跟进期里、非触发消息才判】')

/** 开好窗的 judge —— 模拟"机器人刚在群里回过话"。 */
function judgeWithWindow(config = {}) {
  const judge = makeJudge(makeCtx(), config)
  judge.recordReply({ key: 'group:1', text: '你这把打得不错呀' })
  return judge
}

const ask = { msg: { scene: 'group' }, mention: false, decision: { reason: 'not-mentioned' }, key: 'group:1' }

check('开关关闭时不接管', () => {
  const judge = judgeWithWindow({ judgeEnabled: false })
  assert.equal(judge.shouldConsider({ ...ask, cfg: judge.getConfig() }), false)
})

check('窗口外不判（机器人没在跟这轮对话，就没有话题可延续）', () => {
  const judge = makeJudge(makeCtx())
  assert.equal(judge.shouldConsider({ ...ask, cfg: judge.getConfig() }), false)
})

check('窗口内、且不是触发消息 → 交给判定', () => {
  const judge = judgeWithWindow()
  assert.equal(judge.shouldConsider({ ...ask, cfg: judge.getConfig() }), true)
})

check('窗口内但这条 @ 了机器人 → 不判（直接回过了，不必再花钱）', () => {
  const judge = judgeWithWindow()
  assert.equal(
    judge.shouldConsider({ ...ask, cfg: judge.getConfig(), mention: true, decision: { reason: 'at' } }),
    false
  )
})

check('窗口内但关键词命中 → 不判（本地已放行）', () => {
  const judge = judgeWithWindow()
  assert.equal(
    judge.shouldConsider({
      ...ask,
      cfg: judge.getConfig(),
      decision: { accept: true, reason: 'keyword' },
    }),
    false
  )
})

check('窗口内但几率命中 → 不判（几率本身就是触发方式）', () => {
  const judge = judgeWithWindow()
  assert.equal(
    judge.shouldConsider({
      ...ask,
      cfg: judge.getConfig(),
      decision: { accept: true, reason: 'random' },
    }),
    false
  )
})

check('「仅在 @ 时响应」优先于跟进', () => {
  const judge = judgeWithWindow({ replyOnlyWhenMentioned: true })
  assert.equal(judge.shouldConsider({ ...ask, cfg: judge.getConfig() }), false)
})

check('跟进期设 0 → 判定不接管', () => {
  const judge = judgeWithWindow({ judgeFollowUpMin: 0 })
  assert.equal(judge.shouldConsider({ ...ask, cfg: judge.getConfig() }), false)
})

check('档位 ≤20 也照样跟进（@ 或关键词开的窗，窗口内相关消息该接）', () => {
  const judge = judgeWithWindow({ contextSliderPos: 10 })
  assert.equal(judge.shouldConsider({ ...ask, cfg: judge.getConfig() }), true)
})

check('被拒绝的消息（未过白名单 / 黑名单）判定无权翻案', () => {
  const judge = judgeWithWindow()
  for (const reason of ['not-allowed', 'blocked']) {
    assert.equal(
      judge.shouldConsider({ ...ask, cfg: judge.getConfig(), decision: { reason } }),
      false,
      reason
    )
  }
})

check('私聊不判（白名单内本就该回）', () => {
  const judge = judgeWithWindow()
  assert.equal(
    judge.shouldConsider({ ...ask, cfg: judge.getConfig(), msg: { scene: 'private' } }),
    false
  )
})

console.log('\n【统计：验证成本假设】')

await checkAsync('累计 usage 可用于核对"约 500 token/次"', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx, { judgeMinIntervalMs: 0 })
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(judge.stats.calls, 2)
  assert.equal(judge.stats.inputTokens, 974)
  assert.equal(judge.stats.outputTokens, 6)
  assert.equal(judge.stats.cacheReadTokens, 128, '缓存读也要记，否则成本报得比实际好看')
  assert.equal(judge.stats.no, 2)
})

await checkAsync('判定为"要回"会被计数', async () => {
  const ctx = makeCtx({ reply: 'Y' })
  const judge = makeJudge(ctx)
  const r = await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(r.reply, true)
  assert.equal(judge.stats.yes, 1)
})

console.log('\n【常开接话：窗口外也判，但有冷却与限额】')

check('常开未开启时窗口外一律不判（旧行为不变）', () => {
  const judge = makeJudge(makeCtx())
  assert.equal(judge.shouldConsider({ ...ask, cfg: judge.getConfig() }), false)
})

check('常开开启后窗口外也交给判定', () => {
  const judge = makeJudge(makeCtx(), { judgeAlwaysOn: true })
  assert.equal(judge.shouldConsider({ ...ask, cfg: judge.getConfig() }), true)
})

check('常开的冷却：间隔内的下一条不判', () => {
  const judge = makeJudge(makeCtx(), { judgeAlwaysOn: true, judgeProactiveGapMs: 90_000 })
  const t0 = Date.now()
  assert.equal(judge.shouldConsider({ ...ask, cfg: judge.getConfig(), now: t0 }), true)
  assert.equal(
    judge.shouldConsider({ ...ask, cfg: judge.getConfig(), now: t0 + 30_000 }),
    false,
    '90 秒冷却内不该再判'
  )
  assert.equal(judge.shouldConsider({ ...ask, cfg: judge.getConfig(), now: t0 + 91_000 }), true)
})

check('常开的每小时限额：只有真接了话才扣额度', () => {
  const judge = makeJudge(makeCtx(), {
    judgeAlwaysOn: true,
    judgeProactiveGapMs: 0,
    judgeProactivePerHour: 2,
  })
  const t0 = Date.now()
  const check2 = (at) => judge.shouldConsider({ ...ask, cfg: judge.getConfig(), now: at })
  assert.equal(check2(t0), true, '还没记账时能判')
  judge.recordProactive({ key: 'group:1', now: t0 })
  judge.recordProactive({ key: 'group:1', now: t0 + 1_000 })
  assert.equal(check2(t0 + 2_000), false, '额度用尽后不再判')
  assert.equal(check2(t0 + 3_600_001), true, '一小时前的记录会过期')
})

check('常开模式仍尊重 @、白名单与「仅 @ 时响应」', () => {
  const judge = makeJudge(makeCtx(), { judgeAlwaysOn: true })
  const cfg = judge.getConfig()
  assert.equal(judge.shouldConsider({ ...ask, cfg, mention: true }), false)
  assert.equal(judge.shouldConsider({ ...ask, cfg, decision: { reason: 'not-allowed' } }), false)
  assert.equal(judge.shouldConsider({ ...ask, cfg, decision: { reason: 'blocked' } }), false)
  assert.equal(judge.shouldConsider({ ...ask, cfg: { ...cfg, replyOnlyWhenMentioned: true } }), false)
})

check('常开的额度按群独立', () => {
  const judge = makeJudge(makeCtx(), {
    judgeAlwaysOn: true,
    judgeProactiveGapMs: 0,
    judgeProactivePerHour: 1,
  })
  const t0 = Date.now()
  judge.recordProactive({ key: 'group:1', now: t0 })
  const cfg = judge.getConfig()
  assert.equal(judge.shouldConsider({ ...ask, key: 'group:1', cfg, now: t0 }), false, 'A 群额度用尽')
  assert.equal(judge.shouldConsider({ ...ask, key: 'group:2', cfg, now: t0 }), true, 'B 群不受影响')
})

await checkAsync('常开模式问的是「值不值得插一句」，不是「还在延续话题吗」', async () => {
  const ctx = makeCtx({ reply: 'N' })
  const judge = makeJudge(ctx, { judgeFollowUpMin: 10 })
  await judge.evaluate({ key: 'group:1', scene: 'group', recent, mode: 'ambient' })
  const prompt = ctx.requests[0].messages[0].content[0].text
  assert.match(prompt, /值不值得我主动插一句/)
  assert.match(prompt, /还没人回应/)
  assert.equal(/刚刚接过话/.test(prompt), false, '常开模式不能说「你刚接过话」')
})

await checkAsync('常开模式判定不可用 → 闭嘴（fail-closed）', async () => {
  const ctx = makeCtx({ noLlm: true })
  const judge = makeJudge(ctx, { judgeAlwaysOn: true })
  const r = await judge.evaluate({ key: 'group:1', scene: 'group', recent, mode: 'ambient' })
  assert.equal(r.reply, false, '常开下放行会让机器人对每条闲扯都搭腔')
  assert.equal(r.failOpen, false)
})

await checkAsync('跟进期模式判定不可用仍按 failOpen 放行（旧行为不变）', async () => {
  const ctx = makeCtx({ noLlm: true })
  const judge = makeJudge(ctx, {})
  const r = await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(r.reply, true)
  assert.equal(r.failOpen, true)
})

console.log('\n【三项判断：相关 / 同题 / 需要】')

check('三个字母：YYY 才接，任一 N 都不接', () => {
  assert.equal(parseVerdict3('YYY').reply, true)
  assert.equal(parseVerdict3('YYN').reply, false, '不需要我参与就不接')
  assert.equal(parseVerdict3('NYY').reply, false, '与我无关就不接')
  assert.equal(parseVerdict3('YNY').reply, false, '换了话题就不接')
})

check('能逐项看出是哪一关卡住的（排障与调参靠它）', () => {
  const r = parseVerdict3('YYN')
  assert.equal(r.related, true)
  assert.equal(r.same, true)
  assert.equal(r.need, false)
})

check('带标签的写法也能逐项取到，并带上模型自报的理由', () => {
  const r = parseVerdict3('相关=Y 同题=Y 需要=N\n理由：换话题了')
  assert.equal(r.reply, false)
  assert.equal(r.same, true)
  assert.equal(r.need, false)
  assert.equal(r.detail, '换话题了')
})

check('编号写法、空格写法都认（模型不总听话）', () => {
  assert.equal(parseVerdict3('1=Y 2=Y 3=Y').reply, true)
  assert.equal(parseVerdict3('Y Y N').reply, false)
  assert.equal(parseVerdict3('YYN 换了话题').reply, false)
})

check('只有单字母时退化成老行为（三项跟随同一个答案）', () => {
  assert.equal(parseVerdict3('Y').reply, true)
  assert.equal(parseVerdict3('Y').same, true)
  assert.equal(parseVerdict3('N').reply, false)
  assert.equal(parseVerdict3('N').related, false)
})

check('认不出一律不接（解析失败绝不能放行）', () => {
  assert.equal(parseVerdict3('这个不好说').reply, false)
  assert.equal(parseVerdict3('这个不好说').verdict, 'unrecognized')
  assert.equal(parseVerdict3('').verdict, 'empty')
  assert.equal(parseVerdict3(null).reply, false)
})

console.log('\n【话题锚点：第 2 项判断的参照物】')

await checkAsync('跟进期提示词里带上「叫醒我的那句话」', async () => {
  const ctx = makeCtx({ reply: 'YYN' })
  const judge = makeJudge(ctx)
  judge.recordWake({ key: 'group:1', text: '6701 端口被占了怎么办', senderName: '甲', reason: 'at' })
  judge.recordReply({ key: 'group:1', text: '换 6702' })
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  const text = ctx.requests[0].messages[0].content[0].text
  assert.ok(text.includes('【叫醒我的那句话】'), '要单独标出锚点')
  assert.ok(text.includes('6701 端口被占了怎么办'), '要把原话带上')
})

await checkAsync('常开模式没有"叫醒我的话"，不塞锚点', async () => {
  const ctx = makeCtx({ reply: 'YYN' })
  const judge = makeJudge(ctx)
  judge.recordWake({ key: 'group:1', text: '6701 端口被占了怎么办', senderName: '甲' })
  await judge.evaluate({ key: 'group:1', scene: 'group', recent, mode: 'ambient' })
  const text = ctx.requests[0].messages[0].content[0].text
  assert.equal(text.includes('【叫醒我的那句话】'), false, '常开模式没有被叫醒这回事')
})

await checkAsync('锚点只留最新一条（接话后换成那条新消息）', async () => {
  const judge = makeJudge(makeCtx({ reply: 'N' }))
  judge.recordWake({ key: 'group:1', text: '第一句', senderName: '甲' })
  judge.recordWake({ key: 'group:1', text: '第二句', senderName: '乙' })
  assert.equal(judge.wakeAnchor('group:1').text, '第二句')
  assert.equal(judge.wakeAnchor('group:2'), undefined)
})

await checkAsync('锚点是话题判断的依据：三项判断写进提示词，且要求逐项作答', async () => {
  const ctx = makeCtx({ reply: 'YYN' })
  const judge = makeJudge(ctx)
  judge.recordWake({ key: 'group:1', text: '这报错咋整', senderName: '甲' })
  judge.recordReply({ key: 'group:1', text: '看下端口' })
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  const text = ctx.requests[0].messages[0].content[0].text
  assert.match(text, /1 相关/)
  assert.match(text, /2 同题/)
  assert.match(text, /3 需要/)
  assert.match(text, /第一行只写三个字母/)
})

await checkAsync('输出预算给足三项判断（默认 320，太小会被思考吃光）', async () => {
  const ctx = makeCtx({ reply: 'YYN' })
  const judge = makeJudge(ctx)
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.ok(ctx.requests[0].maxTokens >= 256, `实际 ${ctx.requests[0].maxTokens}`)
})

await checkAsync('三项分别计数（看是哪一关最常拦住）', async () => {
  const ctx = makeCtx({ reply: 'YYN' })
  const judge = makeJudge(ctx)
  await judge.evaluate({ key: 'group:1', scene: 'group', recent })
  assert.equal(judge.stats.relatedYes, 1)
  assert.equal(judge.stats.sameYes, 1)
  assert.equal(judge.stats.needYes, 0)
  assert.equal(judge.stats.no, 1)
})

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed ? 1 : 0)
