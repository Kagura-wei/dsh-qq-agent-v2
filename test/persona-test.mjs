/**
 * 人设解析测试 —— 重点覆盖"用户直接粘角色卡 JSON"这个真实场景。
 *
 * 用例取材自线上真实遇到的坏卡：V2 角色卡、尾部多逗号、字段缺引号导致结构损坏。
 * 运行：node test/persona-test.mjs
 */
import assert from 'node:assert/strict'
import { normalizePersonaText, resolvePersona, PERSONAS } from '../lib/personas.js'

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

/** 一张结构完好的 V2 角色卡。注意 description 里用真换行，
 *  JSON.stringify 会把它们编成 \n 转义序列 —— 与用户实际粘贴的形态一致。 */
const GOOD_CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '阿蓝',
    description: '【姓名】阿蓝（Phoebe）\n【性别】女\n【外貌】金色大波浪长发。',
    personality: '温柔可爱、慢热、怕生。',
    scenario: '{{char}} 是 QQ 群里的普通群员。{{user}} 也是群里的人。',
    system_prompt: '',
    post_history_instructions: '保持阿蓝的慢热。',
    tags: ['群聊', '日常'],
  },
})

/** 线上那张卡：尾部多逗号。 */
const TRAILING_COMMA_CARD = GOOD_CARD.replace('"日常"]', '"日常",]')

/** 线上那张卡：字段缺引号，JSON 结构被破坏。 */
const BROKEN_CARD = GOOD_CARD.replace('"system_prompt":"",', '群聊向角色卡：{{char}} 以普通群员身份参与群聊。    "system_prompt":"",')

console.log('\n[人设] 普通文本')
check('非 JSON 文本原样返回', () => {
  const t = '你是一只猫。'
  assert.equal(normalizePersonaText(t), t)
})
check('空值返回空串', () => {
  assert.equal(normalizePersonaText(''), '')
  assert.equal(normalizePersonaText(null), '')
  assert.equal(normalizePersonaText(undefined), '')
})
check('普通文本里的 \\n 不被误还原（避免误伤路径）', () => {
  const t = '看看 C:\\new 目录'
  assert.equal(normalizePersonaText(t), t, '不应把 \\n 变成换行')
})

console.log('\n[人设] 角色卡 JSON')
check('完整 V2 卡：抽出正文而非原样塞 JSON', () => {
  const t = normalizePersonaText(GOOD_CARD, '阿蓝')
  assert.ok(t.includes('【姓名】阿蓝'), '应含 description')
  assert.ok(t.includes('温柔可爱、慢热'), '应含 personality')
  assert.ok(t.includes('QQ 群里的普通群员'), '应含 scenario')
  assert.ok(t.includes('保持阿蓝的慢热'), '应含 post_history_instructions')
  assert.ok(!t.includes('chara_card_v2'), '不应残留 JSON 包装')
  assert.ok(!t.includes('"tags"'), '不应残留元数据字段')
})
check('JSON 里的 \\n 被还原成真换行', () => {
  const t = normalizePersonaText(GOOD_CARD, '阿蓝')
  assert.ok(t.includes('\n'), '应含真换行')
  assert.ok(!t.includes('\\n'), '不应残留字面 \\n')
})
check('{{char}} / {{user}} 被替换', () => {
  const t = normalizePersonaText(GOOD_CARD, '阿蓝')
  assert.ok(t.includes('阿蓝 是 QQ 群里的普通群员'), `{{char}} 未替换: ${t.slice(-120)}`)
  assert.ok(t.includes('对方 也是群里的人'), '{{user}} 未替换')
  assert.ok(!t.includes('{{char}}') && !t.includes('{{user}}'), '不应残留占位符')
})
check('尾部多逗号的坏卡也能解析', () => {
  const t = normalizePersonaText(TRAILING_COMMA_CARD, '阿蓝')
  assert.ok(t.includes('【姓名】阿蓝'), '应抽到 description')
  assert.ok(t.includes('温柔可爱'), '应抽到 personality')
})
check('结构损坏的卡：正则兜底仍能救回完整字段', () => {
  // 线上那张卡就是在 system_prompt 前多了一段裸文本
  const t = normalizePersonaText(BROKEN_CARD, '阿蓝')
  assert.ok(t.includes('【姓名】阿蓝'), '应救回 description')
  assert.ok(t.includes('温柔可爱、慢热'), '应救回 personality')
  assert.ok(t.includes('保持阿蓝的慢热'), '应救回 post_history_instructions')
})
check('完全无法解析的 JSON 退回原文', () => {
  const t = normalizePersonaText('{ 这不是 JSON }', '阿蓝')
  assert.equal(t, '{ 这不是 JSON }')
})

console.log('\n[人设] 与配置的配合')
check('personaText 非空时覆盖 personaId', () => {
  const got = resolvePersona({ personaId: 'xiaojingyu', personaText: '你是一只猫。', botName: '阿蓝' })
  assert.equal(got, '你是一只猫。')
})
check('personaId=none 且无 personaText 时不注入', () => {
  assert.equal(resolvePersona({ personaId: 'none', personaText: '', botName: '阿蓝' }), '')
})
check('personaId=none 但有 personaText 时注入自定义', () => {
  const got = resolvePersona({ personaId: 'none', personaText: '你是一只猫。', botName: '阿蓝' })
  assert.equal(got, '你是一只猫。')
})
check('未配置时回退到内置角色卡', () => {
  const got = resolvePersona({ personaId: 'xiaojingyu', personaText: '', botName: '阿蓝' })
  assert.ok(got.includes('小鲸鱼'), '应取内置角色卡')
  assert.equal(got, PERSONAS.xiaojingyu.text)
})

console.log(`\n通过 ${passed} 项\n`)
