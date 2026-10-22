/**
 * 出站检查测试 —— 覆盖两件容易互相打架的事：
 *   1. 推理泄漏（模型的内心盘算被当正文吐出来）必须拦住；
 *   2. 正常聊天一句都不能误杀。
 *
 * 线上故障（2026-10-22，群 100000001）：菲比在群里发了一段英文盘算
 * "乙 says … not addressed to me — participation medium … Keep it very
 * short.这心态挺好…"。旧指纹只认插件自己的中文 section 标题（【角色设定】之类），
 * 一个都命中不了，于是原样发了出去。
 *
 * 样本形态与线上会话一致（turn 96 是实际漏出去的那条，turn 61/71 是同一种
 * 形态的 reasoning 块）；群号、QQ 号、昵称与原文均已替换为假数据，只保留
 * 触发指纹的那层英文元话语结构。
 *
 * 运行：node test/safety-test.mjs
 */
import assert from 'node:assert/strict'
import { checkOutbound, looksLikeReasoningLeak } from '../lib/safety.js'

/** 真机 turn 96：这条**实际发出去了**，是本次要修的那条。 */
const REAL_LEAK_96 = `
乙 says honestly they'd get excited seeing any 国乒 player. Casual, not addressed to me — participation medium. A light short comment could fit: 见到谁都激动，这才是真球迷。

Keep it very short.这心态挺好，见谁都激动说明是真爱，不是挑着看`

/** 真机 turn 61 的 reasoning 块（同一形态，只是那轮恰好被分到了 reasoning 通道）。 */
const REAL_REASONING_61 = `乙 says: 天天都会去看排行榜有没有新的 — about 美食俘虏 (manga rankings?). This is a 接话 turn (not addressed to me). I could reply casually. Topic: reading 美食的俘虏, waiting for updates. Something short: "美食俘虏后面接 海贼王重刷 或者 银魂" Hmm. Better keep it in-character, short.

Actually 乙's line: "天天都会去看排行榜有没有新的" — probably about 剑之圣女 manga updates or 美食俘虏. I can reply something like "排行榜翻烂了也就那几本" — short and natural.

Let me reply: "排行榜翻烂了也就那几本在更". Keep it short.`

/** 真机 turn 71 的 reasoning 块。 */
const REAL_REASONING_71 = `Now respond to the latest message m00404: 甲: @10002 不要吵. And 乙 talking about 云顶s1.

甲 said "不要吵" to me — meaning stop bickering? Hmm. Actually 丙 and 乙 were chatting. 甲 @me "不要吵". Wait, did I say something provocative? My last message: "连败吃利息攒血量，最后收菜一波梭哈，确实是云顶老手". 丙 also said "肯定是个资深的云顶玩家" — they were talking about Faker. Hmm. 甲 says "不要吵" possibly to me and 丙 both.

Actually 甲 @ me specifically "不要吵". Since it's a direct address, I should respond briefly, not with "-". Also 乙 says he played 云顶 s1, then switched to 铲子 (金铲铲).

Best: brief, non-confrontational reply ack`

/** 真机上正常发出过的回复（同一个人、同一批群）—— 一句都不许拦。 */
const NORMAL = [
  '排行榜翻烂了也就那几本还在更\n\n&&sigh',
  '行，那我收声。铲子和云顶到底哪个手感更顺？',
  '这心态挺好，见谁都激动说明是真爱，不是挑着看',
  '那段转发一共 3 条聊天记录：视频是近距离拍的湍急水流，能看到水花溅起，还有人伸手靠近水面',
  '哈哈哈笑死，这张表情包我收下了',
  '云顶 s1 我也玩过，那时候还在用剑魔打工',
  '确实，乙 说得对',
  '在的在的，刚在忙',
  '这道题我会：先算边长再开方',
  '你要不要试试重启一下？',
  '［图片］这个角度拍得不错',
]

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ✓ ${name}`)
}

// ── 1. 真机泄漏样本必须全部拦住 ──
for (const [label, text] of [
  ['turn 96（实际发出的那条）', REAL_LEAK_96],
  ['turn 61 的 reasoning', REAL_REASONING_61],
  ['turn 71 的 reasoning', REAL_REASONING_71],
]) {
  const r = checkOutbound(text)
  assert.equal(r.ok, false, `应判为泄漏：${label}`)
  assert.equal(r.reason, 'reasoning-leak', `reason 应为 reasoning-leak：${label}`)
  ok(`拦住 ${label}`)

  const probe = looksLikeReasoningLeak(text)
  assert.equal(probe.leak, true)
  assert.ok(probe.detail, '要给出命中的判据，方便排障')
}

// ── 2. 正常回复一句都不许误杀 ──
for (const text of NORMAL) {
  const r = checkOutbound(text)
  assert.equal(r.ok, true, `误杀了正常回复：${JSON.stringify(text)} → ${r.detail ?? ''}`)
}
ok(`${NORMAL.length} 条正常回复零误杀`)

// ── 3. 中文系统提示泄漏仍走原来的 reason（不能混进 reasoning-leak）──
const promptLeak = checkOutbound('【角色设定】你是一个叫菲比的群友……')
assert.equal(promptLeak.ok, false)
assert.equal(promptLeak.reason, 'leak')
ok('提示词泄漏仍判 leak')

// ── 4. 屏蔽词优先级不变，且开关能关推理检测 ──
const worded = checkOutbound('这句话里有 违禁词 三个字', { words: ['违禁词'] })
assert.equal(worded.ok, false)
assert.equal(worded.reason, 'word')
ok('自定义屏蔽词仍判 word')

const off = checkOutbound(REAL_LEAK_96, { reasoningLeakEnabled: false })
assert.equal(off.ok, true, '关掉推理检测后应放行（排障用）')
ok('推理检测开关生效')

// ── 5. 边界：空串、纯表情、单行英文短语都不该被当成泄漏 ──
for (const text of ['', '   ', '&&sigh', 'OK', 'hmm', 'nice', '-']) {
  const r = checkOutbound(text)
  assert.equal(r.ok, true, `边界样本不该拦：${JSON.stringify(text)}`)
}
ok('空串/短英文/纯标记不误判')

// ── 6. 英文密度够但不是在安排怎么回 —— 不许拦 ──
const pureEnglishAnswer = checkOutbound(
  'The quick brown fox jumps over the lazy dog and then it keeps running down the hill until it reaches the river bank where it stops to drink some water and rest for a while before heading home'
)
assert.equal(pureEnglishAnswer.ok, true, '纯英文回答（无元话语）不该拦')
ok('纯英文回答不误判')

console.log(`\n全部通过（${passed} 项）`)
