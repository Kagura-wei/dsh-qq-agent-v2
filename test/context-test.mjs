/**
 * 上下文规划 / 摘要器 / 图片预热 / 出站安全 / 提示词段落 的单元测试。
 * 运行：node test/context-test.mjs
 */
import assert from 'node:assert/strict'
import { planContext, splitRounds, estimateTokens } from '../lib/context.js'
import { Summarizer } from '../lib/summarize.js'
import { ImagePrefetcher, imageKeyOf } from '../lib/prefetch.js'
import { checkOutbound, LEAK_PATTERNS } from '../lib/safety.js'
import { buildFollowUpRules, buildSystemPrompt } from '../lib/prompt.js'
import { trimSegments } from '../lib/store.js'

const logger = { info() {}, warn() {}, error() {} }

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

console.log('\n[上下文] 分轮')
check('相邻消息间隔超过阈值就算新的一轮', () => {
  const entries = [
    { seq: 1, time: 0, senderName: '甲', text: '第一轮' },
    { seq: 2, time: 10, senderName: '乙', text: '第一轮还在说' },
    { seq: 3, time: 700, senderName: '甲', text: '第二轮' },
  ]
  const rounds = splitRounds(entries, { gapMs: 300_000 })
  assert.equal(rounds.length, 2)
  assert.equal(rounds[0].length, 2)
  assert.equal(rounds[1].length, 1)
})
check('全部消息都在一轮里时只有一轮', () => {
  const rounds = splitRounds([{ time: 0 }, { time: 5 }, { time: 9 }], { gapMs: 300_000 })
  assert.equal(rounds.length, 1)
})

console.log('\n[上下文] 按轮保留 + 超阈值才摘要')
const rounds3 = [
  { seq: 1, time: 0, senderName: '甲', text: 'A'.repeat(200) },
  { seq: 2, time: 5, senderName: '乙', text: 'B'.repeat(200) },
  { seq: 3, time: 600, senderName: '甲', text: 'C'.repeat(200) },
  { seq: 4, time: 605, senderName: '乙', text: 'D'.repeat(200) },
  { seq: 5, time: 1200, senderName: '丙', text: 'E'.repeat(200) },
]

check('没超预算时原样注入，不需要摘要', () => {
  const p = planContext(rounds3.slice(0, 2), { scene: 'group', maxChars: 4000, gapMs: 300_000 })
  assert.equal(p.over, false)
  assert.equal(p.oldEntries.length, 0)
  assert.ok(p.recentText.includes('A') && p.recentText.includes('B'))
})
check('超预算时：最近一轮完整保留，更早的轮次交给摘要', () => {
  const p = planContext(rounds3, { scene: 'group', maxChars: 500, gapMs: 300_000 })
  assert.equal(p.over, true)
  assert.ok(p.oldEntries.length > 0, '应有需要摘要的旧轮次')
  assert.ok(p.recentText.includes('E'.repeat(50)), '最新一轮必须在')
  assert.ok(!p.recentText.includes('A'.repeat(50)), '最旧的轮次应被挪去摘要')
})
check('⚠️ 最新一轮自己就超预算时也完整保留（不许切成半句）', () => {
  const entries = [
    { seq: 1, time: 0, senderName: '甲', text: '旧的一堆话'.repeat(40) },
    { seq: 2, time: 900, senderName: '乙', text: 'Z'.repeat(600) },
  ]
  const p = planContext(entries, { scene: 'group', maxChars: 200, gapMs: 300_000 })
  assert.equal(p.over, true)
  assert.ok(p.recentText.includes('Z'.repeat(600)), '最新一轮必须一字不少')
})
check('只有一轮且超预算时不强行摘要（没有更早的轮次）', () => {
  const entries = [{ seq: 1, time: 0, senderName: '甲', text: 'x'.repeat(900) }]
  const p = planContext(entries, { scene: 'group', maxChars: 200, gapMs: 300_000 })
  assert.equal(p.over, true)
  assert.equal(p.oldEntries.length, 0)
})
check('空输入返回空计划', () => {
  assert.deepEqual(planContext([], { scene: 'group' }), {
    recentText: '',
    oldEntries: [],
    over: false,
    chars: 0,
  })
})
check('token 粗估：中文一字一 token，英文按 4 字符一 token', () => {
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('hello'), 2)
})

console.log('\n[摘要] 增量与失败兜底')
{
  /** 假 ctx：llm.stream 产出一段文本，并记录每次调用。 */
  function fakeCtx({ reply = '这是一段摘要', fail = false } = {}) {
    const calls = []
    return {
      calls,
      get: (key) => {
        if (key === 'llm') {
          return {
            stream: async function* (options) {
              calls.push(options)
              if (fail) throw new Error('模型炸了')
              yield { type: 'text-delta', text: reply }
              yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
              yield { type: 'finish', reason: 'stop' }
            },
          }
        }
        if (key === 'agentDefaultModel') {
          return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        }
        return undefined
      },
    }
  }
  const cfg = { contextMaxChars: 4000 }
  const entries = [
    { seq: 1, time: 0, senderName: '甲', text: '旧话一' },
    { seq: 2, time: 1, senderName: '乙', text: '旧话二' },
  ]

  await checkAsync('生成摘要并把调用的提示词写全', async () => {
    const ctx = fakeCtx()
    const s = new Summarizer({ ctx, getConfig: () => cfg, logger })
    const text = await s.get({ key: 'group:1', scene: 'group', entries })
    assert.equal(text, '这是一段摘要')
    assert.equal(ctx.calls.length, 1)
    assert.ok(ctx.calls[0].messages[0].content[0].text.includes('旧话一'), '应带上旧记录')
    assert.equal(ctx.calls[0].temperature, 0, '摘要不该有随机性')
  })

  await checkAsync('同一批旧记录不重复摘要（缓存生效）', async () => {
    const ctx = fakeCtx()
    const s = new Summarizer({ ctx, getConfig: () => cfg, logger })
    await s.get({ key: 'group:1', scene: 'group', entries })
    await s.get({ key: 'group:1', scene: 'group', entries })
    assert.equal(ctx.calls.length, 1, '第二次应命中缓存')
  })

  await checkAsync('边界推进后增量重压（带上已有摘要）', async () => {
    const ctx = fakeCtx()
    const s = new Summarizer({ ctx, getConfig: () => cfg, logger })
    await s.get({ key: 'group:1', scene: 'group', entries })
    await s.get({
      key: 'group:1',
      scene: 'group',
      entries: [...entries, { seq: 3, time: 2, senderName: '丙', text: '新的一句' }],
    })
    assert.equal(ctx.calls.length, 2, '边界变了要重新压')
    assert.ok(ctx.calls[1].messages[0].content[0].text.includes('这是一段摘要'), '要带上已有摘要')
  })

  await checkAsync('模型不可用时返回 undefined（调用方退回截断）', async () => {
    const ctx = fakeCtx({ fail: true })
    const s = new Summarizer({ ctx, getConfig: () => cfg, logger })
    assert.equal(await s.get({ key: 'group:1', scene: 'group', entries }), undefined)
    assert.equal(s.stats.errors, 1)
  })

  await checkAsync('宿主没有 llm 服务时静默跳过', async () => {
    const s = new Summarizer({ ctx: { get: () => undefined }, getConfig: () => cfg, logger })
    assert.equal(await s.get({ key: 'group:1', scene: 'group', entries }), undefined)
  })
}

console.log('\n[图片预热]')
await checkAsync('缓存键对"原始段"与"存档裁剪后的段"一致', async () => {
  const raw = { type: 'image', data: { url: 'http://x/a.png', file: 'a.png', file_size: 123 } }
  const trimmed = trimSegments([raw])[0]
  assert.equal(imageKeyOf(raw), imageKeyOf(trimmed), '两边算出来必须是同一个键，否则预热白做')
})
await checkAsync('预热后直接命中，不再走网络', async () => {
  let fetches = 0
  const fetchImpl = async () => {
    fetches++
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).buffer }
  }
  const p = new ImagePrefetcher({ logger, fetchImpl })
  const seg = { type: 'image', data: { url: 'http://x/pre.png' } }
  p.warm([seg])
  const got = await p.get(seg)
  assert.equal(got.hit, true)
  assert.ok(got.atts?.length, '应拿到预热好的字节')
  assert.equal(got.atts[0].mediaType, 'image/png')
  assert.equal(fetches, 1)
  // 第二次取：纯内存
  const again = await p.get(seg)
  assert.equal(again.hit, true)
  assert.equal(fetches, 1, '不该再下一次')
  assert.equal(p.stats.failed, 0)
})
await checkAsync('预热失败要记住（负缓存），不重复等超时', async () => {
  let fetches = 0
  const fetchImpl = async () => {
    fetches++
    return { ok: false, status: 400, arrayBuffer: async () => new ArrayBuffer(0) }
  }
  const p = new ImagePrefetcher({ logger, fetchImpl })
  const seg = { type: 'image', data: { url: 'http://x/expired.png' } }
  p.warm([seg])
  const first = await p.get(seg)
  assert.equal(first.hit, true, '预热过就算命中')
  assert.deepEqual(first.atts, [], '失败了就是没有字节')
  const second = await p.get(seg)
  assert.equal(second.hit, true, '第二次仍应视为已知失败')
  assert.equal(fetches, 1, '不该为了同一张注定失败的图再等一次超时')
  assert.equal(p.stats.failed, 1)
})
await checkAsync('没预热过的图返回 hit=false（调用方自行兜底）', async () => {
  const p = new ImagePrefetcher({ logger })
  const got = await p.get({ type: 'image', data: { url: 'http://x/never.png' } })
  assert.equal(got.hit, false)
})
await checkAsync('超过字节上限时淘汰最旧的', async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])
  const p = new ImagePrefetcher({
    logger,
    maxBytes: 8,
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer }),
  })
  p.warm([{ type: 'image', data: { url: 'http://x/1.png' } }])
  await p.get({ type: 'image', data: { url: 'http://x/1.png' } })
  p.warm([{ type: 'image', data: { url: 'http://x/2.png' } }])
  await p.get({ type: 'image', data: { url: 'http://x/2.png' } })
  assert.ok(p.cache.size <= 1, `应被字节上限压住，实际 ${p.cache.size} 项`)
  assert.ok(p.bytes <= 8 || p.bytes === 0)
})

console.log('\n[出站安全]')
check('正常回复放行', () => assert.equal(checkOutbound('今天天气不错').ok, true))
check('空回复放行（由别的分支处理）', () => assert.equal(checkOutbound('').ok, true))
check('复述系统提示原文 → 拦下', () => {
  for (const probe of ['【角色设定（管理员设置）】你是…', '【安全边界（最高优先级）】', '【你的处境】你在群里']) {
    const r = checkOutbound(probe)
    assert.equal(r.ok, false, `应拦下: ${probe}`)
    assert.equal(r.reason, 'leak')
  }
})
check('默认不预设任何屏蔽词', () => {
  assert.equal(LEAK_PATTERNS.length > 0, true)
  assert.equal(checkOutbound('一个完全正常的句子').ok, true)
})
check('管理员配置的屏蔽词生效并回报命中词', () => {
  const r = checkOutbound('这局我开了外挂', { words: ['外挂'] })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'word')
  assert.equal(r.detail, '外挂')
})
check('屏蔽词忽略空白项', () => assert.equal(checkOutbound('随便什么', { words: ['', '   '] }).ok, true))

console.log('\n[系统提示] 接话段与敏感话题')
check('接话段说明没人点名、允许不发言，并禁止暴露机制', () => {
  const t = buildFollowUpRules({ botName: '阿蓝' })
  assert.ok(t.includes('接话'))
  assert.ok(t.includes('没有 @ 你'))
  assert.ok(t.includes('`-`'))
  assert.ok(/不要提及/.test(t))
  assert.ok(t.includes('阿蓝'), '应带上机器人名字')
})
check('主系统提示含现实政治敏感话题规则', () => {
  const p = buildSystemPrompt({ botName: '测试' }, { scene: 'group' })
  assert.ok(p.includes('现实政治'), '缺政治敏感话题规则')
  assert.ok(p.includes('不参与对骂'), '缺冲突规则')
})
check('接话段与主系统提示是两段独立的文本（不混进系统提示）', () => {
  const p = buildSystemPrompt({ botName: '测试' }, { scene: 'group' })
  assert.ok(!p.includes('本次是「接话」'), '接话段不该出现在常规系统提示里')
})

console.log(`\n通过 ${passed} 项\n`)
