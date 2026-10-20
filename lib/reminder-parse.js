/**
 * 提醒时间解析：把"明天8点""每天九点半""30分钟后""每周一三五早上7点20"这类说法
 * 转成结构化的触发时间。
 *
 * 两条路 ——
 *   1) 本地正则 `parseLocal()`：常见说法零成本秒出，覆盖群里绝大多数输入；
 *   2) 轻量模型 `buildParsePrompt()` + `parseModelReply()`：只有本地正则啃不动
 *      的才走。用的是 `ctx.llm.stream()`，和"生成会话标题""接话判定"同一条辅助
 *      通道，不装配工具、不带 agent 系统提示，单次约 300 token（主会话的 1/80）。
 *
 * **解析不出来一律返回 null** —— 调用方据此回落到正常聊天流程，让模型自然地
 * 问一句"你是要设提醒吗"。硬猜一个时间然后把提醒发错，比不设更糟。
 *
 * 关于时间基准：全程用本地时区（服务器是 Asia/Shanghai，无夏令时）。
 * 一切"今天/明天"的推导都以调用方传入的 now 为准，模块内不读系统时钟 ——
 * 这样单测可以把时间钉死。
 */

const CN_DIGIT = {
  零: 0,
  〇: 0,
  一: 1,
  壹: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

/** 中文数字 → 阿拉伯数字。支持 十 / 十五 / 二十 / 二十三 / 零五，也直接接受阿拉伯数字。 */
export function cnToNumber(text) {
  const s = String(text ?? '').trim()
  if (!s) return null
  if (/^\d{1,3}$/.test(s)) return Number(s)

  let section = 0
  let seen = false
  for (const ch of s) {
    if (ch === '十') {
      section = (section || 1) * 10
      seen = true
      continue
    }
    const digit = CN_DIGIT[ch]
    if (digit === undefined) return null
    section += digit
    seen = true
  }
  return seen ? section : null
}

// ────────────────────────── 正则拼装 ──────────────────────────

const NUM_SRC = '(?:\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})'
const DAY_SRC = '(今天|今日|今早|今晨|今晚|明天|明日|明早|明晨|明晚|后天|大后天)'
const PERIOD_SRC = '(凌晨|清晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|夜晚|半夜)'
// 「8点半」必须排在「8点」前面：否则第一分支吃掉"8点"就把"半"漏在外面了。
// 末尾的"分"可省 —— 「7点20」和「7点20分」同样常见，少一个可选符就会把
// "7点20" 截成 "7点"（分钟悄悄变 0，这种错最难发现）。
const CLOCK_SRC = `(?:${NUM_SRC}\\s*点半|${NUM_SRC}\\s*(?:[点时]|[:：])\\s*(?:${NUM_SRC}\\s*分?)?)`

/**
 * 绝对时间：`[哪天][时段][时刻]`。
 * 三段都可选，但"时刻"必须有 点/时/:/点半 —— 光一个裸数字不算时间，
 * 否则「买2个苹果」会被当成两点。
 */
const ABS_RE = new RegExp(`${DAY_SRC}?\\s*${PERIOD_SRC}?\\s*(${CLOCK_SRC})`)

/** 时刻本身（不带日期/时段），打头解析。 */
const CLOCK_RE = new RegExp(
  `^(?:${NUM_SRC})\\s*[点时:：]\\s*(?:${NUM_SRC}\\s*分|半)?|^(?:${NUM_SRC})\\s*点半`
)

const RE_DAILY = /(天天|每一天|每天|每日)/
const RE_WEEKLY = /(每(?:周|星期|礼拜))/
const PERIOD_RE = new RegExp(`^(${PERIOD_SRC})`)

const DAY_OFFSET = {
  今天: 0,
  今日: 0,
  今早: 0,
  今晨: 0,
  今晚: 0,
  明天: 1,
  明日: 1,
  明早: 1,
  明晨: 1,
  明晚: 1,
  后天: 2,
  大后天: 3,
}

/** 日子词里自带的时段（「今晚」= 今天晚上）。 */
const DAY_PERIOD = {
  今早: '早上',
  今晨: '早上',
  明早: '早上',
  明晨: '早上',
  今晚: '晚上',
  明晚: '晚上',
}

const WEEKDAY_OF_CHAR = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
}

const WEEKDAY_NAME = ['一', '二', '三', '四', '五', '六', '日']

/** 1=周一 … 7=周日（与 JS 的 0=周日 错开，注意换算）。 */
export function weekdayOf(ms) {
  const d = new Date(ms)
  return d.getDay() === 0 ? 7 : d.getDay()
}

function pad(n) {
  return String(n).padStart(2, '0')
}

/**
 * 取出「时刻」部分。要求写法里带 点/时/:/： 或 点半 —— 裸数字一律不算。
 * @returns {{hour:number, minute:number}|null}
 */
export function readClock(text) {
  const s = String(text ?? '').trim()
  if (!CLOCK_RE.test(s)) return null
  const m = new RegExp(
    `^(\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\\s*(?:[点时]|[:：])\\s*(?:(\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\\s*(分|半)?)?`
  ).exec(s)
  if (!m) return null

  const halfByChar = /点半/.test(s.slice(0, 6))
  const hour = cnToNumber(m[1])
  if (hour == null || hour > 24) return null

  const minRaw = m[2]
  const isHalf = m[3] === '半' || (halfByChar && minRaw == null)
  const minute = isHalf ? 30 : minRaw != null ? cnToNumber(minRaw) : 0
  if (minute == null || minute > 59) return null
  return { hour, minute }
}

/**
 * 时段词修正小时。返回 { hour, dayShift }：晚上12点要落到次日 0 点，
 * 所以时段也可能把日期推一天。
 */
function resolveClock(hour, minute, period) {
  let h = hour
  let dayShift = 0
  if (period) {
    if (/半夜|凌晨/.test(period)) {
      if (h === 12) h = 0
    } else if (/下午|傍晚|晚上|夜里|夜晚/.test(period)) {
      if (h === 12 && /晚上|夜里|夜晚/.test(period)) {
        h = 0
        dayShift = 1
      } else if (h < 12) {
        h += 12
      }
    } else if (/中午/.test(period)) {
      if (h < 6) h += 12
    }
  }
  return { hour: h, minute, dayShift }
}

/** 从「每周…」后面那段里读出周几，返回 { weekdays, rest }。 */
function readWeekdays(str) {
  const chars = Array.from(String(str ?? ''))
  const out = []
  let i = 0
  for (; i < chars.length; i++) {
    const ch = chars[i]
    if (/[\s、,，和及·与]/.test(ch)) continue
    // 「每周7点」里的 7 是小时不是周几：后面紧跟时刻标记就停手
    if (/\d/.test(ch) && /[点时:：]/.test(chars[i + 1] ?? '')) break
    const w = WEEKDAY_OF_CHAR[ch]
    if (w === undefined) break
    if (!out.includes(w)) out.push(w)
  }
  return { weekdays: out, rest: chars.slice(i).join('') }
}

/** 相对时间：「30分钟后」「两小时后」「半小时后」。 */
function parseRelative(src, now) {
  let m = /(?<![点时:：])(半)\s*(?:个)?\s*小时\s*(?:之?后|以后)/.exec(src)
  if (m) {
    return { repeat: 'once', at: now + 30 * 60_000, span: [m.index, m.index + m[0].length], source: 'local' }
  }

  m = /(?<![点时:：])(\d{1,3}|[零〇一二两三四五六七八九十]{1,3})\s*(?:个)?\s*(?:小时|钟头)\s*(?:之?后|以后)/.exec(src)
  if (m) {
    const n = cnToNumber(m[1])
    if (n != null && n > 0 && n <= 72) {
      return { repeat: 'once', at: now + n * 3_600_000, span: [m.index, m.index + m[0].length], source: 'local' }
    }
  }

  m = /(?<![点时:：])(\d{1,4}|[零〇一二两三四五六七八九十]{1,3})\s*(?:分钟|分)\s*(?:之?后|以后)/.exec(src)
  if (m) {
    const n = cnToNumber(m[1])
    if (n != null && n > 0 && n <= 10080) {
      return { repeat: 'once', at: now + n * 60_000, span: [m.index, m.index + m[0].length], source: 'local' }
    }
  }

  m = /(?<![点时:：])(\d{1,4})\s*秒\s*(?:之?后|以后)/.exec(src)
  if (m) {
    const n = Number(m[1])
    if (n > 0 && n <= 3600) {
      return { repeat: 'once', at: now + n * 1000, span: [m.index, m.index + m[0].length], source: 'local' }
    }
  }

  return null
}

/**
 * 本地解析入口。
 *
 * @param {string} text 消息正文（含 @ 与触发词没关系，正则只找时间片段）
 * @param {number} now  当前时间戳（毫秒）
 * @returns {null | {
 *   repeat: 'once'|'daily'|'weekly', at?: number, nextAt?: number,
 *   hour: number, minute: number, weekdays?: number[],
 *   span: [number, number], source: string
 * }}
 */
export function parseLocal(text, now = Date.now()) {
  const src = String(text ?? '')
  if (!src) return null

  const rel = parseRelative(src, now)
  if (rel) return rel

  const abs = ABS_RE.exec(src)
  if (!abs) return null
  const clock = readClock(abs[3])
  if (!clock) return null

  const dayWord = abs[1] ?? ''
  const periodWord = abs[2] ?? ''
  const period = periodWord || DAY_PERIOD[dayWord] || ''
  const { hour, minute, dayShift } = resolveClock(clock.hour, clock.minute, period)
  if (hour > 23 || minute > 59) return null

  const daily = RE_DAILY.exec(src)
  const weekly = RE_WEEKLY.exec(src)

  // 时间片段的完整跨度：把「每天」「每周一」这些前缀也算进去，
  // 否则它们会残留在任务内容里（"每天""每周一"出现在 todo 上很奇怪）。
  let start = abs.index
  let end = abs.index + abs[0].length
  if (daily) {
    start = Math.min(start, daily.index)
    end = Math.max(end, daily.index + daily[0].length)
  }
  if (weekly) {
    start = Math.min(start, weekly.index)
    end = Math.max(end, weekly.index + weekly[0].length)
  }
  const span = [start, end]

  if (daily) {
    const spec = { repeat: 'daily', hour, minute }
    return { ...spec, nextAt: computeNext(spec, now), span, source: 'local' }
  }

  if (weekly) {
    const after = src.slice(weekly.index + weekly[0].length)
    const { weekdays } = readWeekdays(after)
    const spec = { repeat: 'weekly', hour, minute, weekdays: weekdays.length ? weekdays : [weekdayOf(now)] }
    const nextAt = computeNext(spec, now)
    if (nextAt == null) return null
    return { ...spec, nextAt, span, source: 'local' }
  }

  const d = new Date(now)
  d.setDate(d.getDate() + (DAY_OFFSET[dayWord] ?? 0) + dayShift)
  d.setHours(hour, minute, 0, 0)
  let at = d.getTime()

  // 没说哪天、而这个时刻今天已经过了 → 顺延到明天（"8点提醒我"在晚上说就是这个意思）
  if (!dayWord && at <= now) {
    const next = new Date(at)
    next.setDate(next.getDate() + 1)
    at = next.getTime()
  }
  // 明确说了"今天"却已经过去：不猜，交给轻量模型判
  if (at <= now - 60_000) return null

  return { repeat: 'once', at, hour, minute, span, source: 'local' }
}

/**
 * 算下一次触发时刻。
 * @param {{repeat:string, hour:number, minute:number, weekdays?:number[]}} spec
 * @param {number} fromMs 从这一刻往后找（严格大于）
 * @returns {number|null} once 返回 null（一次性没有"下一次"）
 */
export function computeNext(spec, fromMs) {
  if (!spec || spec.repeat === 'once') return null

  if (spec.repeat === 'daily') {
    const cand = new Date(fromMs)
    cand.setHours(spec.hour, spec.minute, 0, 0)
    if (cand.getTime() <= fromMs) cand.setDate(cand.getDate() + 1)
    return cand.getTime()
  }

  if (spec.repeat === 'weekly') {
    const days = Array.isArray(spec.weekdays) && spec.weekdays.length ? spec.weekdays : [weekdayOf(fromMs)]
    for (let i = 0; i < 8; i++) {
      const cand = new Date(fromMs)
      cand.setDate(cand.getDate() + i)
      cand.setHours(spec.hour, spec.minute, 0, 0)
      const wd = cand.getDay() === 0 ? 7 : cand.getDay()
      if (days.includes(wd) && cand.getTime() > fromMs) return cand.getTime()
    }
    return null
  }

  return null
}

/** 毫秒 → 人话（用于回执与提醒正文）。 */
export function formatWhen(rem, now = Date.now()) {
  if (rem.repeat === 'daily') return `每天 ${pad(rem.hour)}:${pad(rem.minute)}`
  if (rem.repeat === 'weekly') {
    const days = Array.isArray(rem.weekdays) && rem.weekdays.length ? rem.weekdays : []
    const names = days.map((w) => `周${WEEKDAY_NAME[w - 1] ?? '?'}`).join('、')
    return `每${names || '周'} ${pad(rem.hour)}:${pad(rem.minute)}`
  }
  const at = Number(rem.nextAt ?? rem.at)
  if (!Number.isFinite(at)) return '某个时间'
  const d = new Date(at)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const diff = dayDiff(d, new Date(now))
  if (diff === 0) return `今天 ${hm}`
  if (diff === 1) return `明天 ${hm}`
  if (diff === 2) return `后天 ${hm}`
  if (diff === -1) return `昨天 ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

function dayDiff(a, b) {
  const x = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
  const y = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
  return Math.round((x - y) / 86_400_000)
}

// ────────────────────────── 任务内容提取 ──────────────────────────

const TRIGGER_WORDS = [
  '别忘了提醒我',
  '记得提醒我',
  '提醒我一下',
  '提醒一下我',
  '提醒一下',
  '提醒我',
  '提醒下我',
  '提醒下',
  '提醒',
  '叫我一下',
  '叫我一声',
  '叫一下我',
  '叫我',
  '叫一下',
  '喊我一下',
  '喊我一声',
  '喊一下我',
  '喊我',
  '喊一下',
  '通知我一下',
  '通知一下我',
  '通知一下',
  '通知我',
  '通知',
  '定个闹钟',
  '设个闹钟',
  '设个提醒',
  '闹钟',
  '别忘了我',
  '别忘了',
  '别忘记',
  '记得',
].sort((a, b) => b.length - a.length)

const POLITE_WORDS = ['帮我', '帮忙', '麻烦', '拜托', '可以', '能不能', '好吗', '好么', '行吗', '谢谢', '一下']

const TAIL_PARTICLES = /(?:吧|啊|哦|呀|呢|嗯|嘛|哈|呗|哟|喔|～|~)\s*$/

/** 去掉 @某人 / 机器人名，剩下的才是人话。 */
export function stripMentions(text, botName) {
  let t = String(text ?? '')
  t = t.replace(/@\s*\d{4,12}/g, ' ')
  if (botName) t = t.split(String(botName)).join(' ')
  return t
}

/**
 * 从原句里抠出"要做什么"。
 *
 * 顺序有讲究：先按 span 精确删掉时间片段（此时下标还对得上原句），
 * 再去 @、去触发词、去标点 —— 反过来做下标就全乱了。
 */
export function extractTask(text, span, botName) {
  const src = String(text ?? '')
  let t = src
  if (Array.isArray(span) && span.length === 2 && span[0] >= 0 && span[1] > span[0]) {
    t = src.slice(0, span[0]) + ' ' + src.slice(span[1])
  }
  t = stripMentions(t, botName)
  t = t.replace(/\[图片\]|\[语音\]|\[表情\d*\]/g, ' ')

  for (const w of TRIGGER_WORDS) t = t.split(w).join(' ')
  for (const w of POLITE_WORDS) t = t.split(w).join(' ')

  t = t.replace(/[，,。.！!？?、；;：:~～「」“”'‘’"（）()【】\[\]<>《》]/g, ' ')
  t = t.replace(/\s+/g, ' ').trim()
  // 语气词只削末尾，且最多两轮 —— 「交作业的」这种内容里的"的"不能动
  for (let i = 0; i < 2; i++) t = t.replace(TAIL_PARTICLES, '').trim()

  return t.slice(0, 120)
}

// ────────────────────────── 意图判定（决定要不要建提醒）──────────────────────────
//
// 这是防误触发的闸门。关键词命中或 @ 机器人只说明"这句话可能跟提醒有关"，
// **不能**说明"说话人正在下指令"。「你提醒他一下」「我记得昨天提醒过」
// 「明天8点开会」这类话群里天天出现，交给词表判断就等于随机打扰。
// 所以建提醒之前，必须由模型点一次头。
//
// 判定只要一个字母：输出极短、延迟极低（约 100 token），比走完整的 JSON
// 解析便宜得多 —— 判定为 N 时连解析都省了。

export const INTENT_SYSTEM = [
  '你在判断群聊里的一句话，是不是在让机器人"设一个定时提醒"。',
  '只回一个字母：Y 或 N。不要解释，不要标点。',
].join('\n')

export function buildIntentPrompt({ text, botName }) {
  return [
    `下面这句话是群聊里的一条消息，群里的机器人叫「${botName || '机器人'}」。`,
    '判断：说话人是不是在让这个机器人「到某个时间提醒他 / 通知他 / 叫他」。',
    '',
    '判 Y（是在设提醒）：',
    '- 明天8点提醒我开会',
    '- 30分钟后叫我一下',
    '- 每天9点喊我打卡',
    '- 每周一三五早上7点20提醒开周会',
    '- 提醒我明天下午三点交材料',
    '',
    '判 N（不是在设提醒）：',
    '- 你提醒他一下（让别人去提醒，不是自己设提醒）',
    '- 我记得昨天好像提醒过这事儿',
    '- 这个提醒功能还挺好用的',
    '- 明天8点开会（只是说安排，没让机器人做什么）',
    '- 明天记得带伞（对别的群友说的话）',
    '- 群里经常有人忘了打卡',
    '',
    '规则：',
    '- 话里没有出现任何时间或时长（几点、明天、N分钟后…）→ N',
    '- 拿不准 → N。少设一次提醒，比乱设一次好。',
    '- 只回 Y 或 N。',
    '',
    `这句话：${escapeBraces(text)}`,
  ].join('\n')
}

/**
 * 解析判定结果。认不出来一律返回 null —— 调用方按"不是提醒"处理（fail-closed）。
 *
 * 找的是前 20 个字符里**第一个 Y/N 字母**，而不是整串比对：模型会把答案包进
 * 代码块（```Y```）、加一句解释，也可能只吐一个字母。⚠️ 别用"剥 ``` 再取首字符"
 * 那套 —— 围栏后的 Y 会被当成语言标记一起吃掉。
 * @returns {'Y'|'N'|null}
 */
export function parseIntentReply(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const hit = /[YNyn]/.exec(s.slice(0, 20))
  if (!hit) return null
  return hit[0].toUpperCase() === 'Y' ? 'Y' : 'N'
}

// ────────────────────────── 轻量模型兜底 ──────────────────────────

export const PARSE_SYSTEM = [
  '你把群聊里的一句话解析成"提醒（闹钟）设置"。',
  '只输出一行 JSON，不要解释，不要代码块，不要多余文字。',
].join('\n')

/** `{{` 在 DSH 的提示词链路里是插值语法，进上下文前一律打散。 */
function escapeBraces(text) {
  return String(text ?? '').replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }')
}

export function buildParsePrompt({ text, now, botName }) {
  const d = now instanceof Date ? now : new Date(now)
  const stamp =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())} 星期${'日一二三四五六'[d.getDay()]}`

  return [
    `现在是 ${stamp}（本地时间，东八区）。`,
    `下面这句话是发给群里的机器人「${botName || '机器人'}」的。`,
    '',
    '把它解析成提醒设置，输出 JSON：',
    '{"ok":true,"repeat":"once","when":"YYYY-MM-DDTHH:mm","weekdays":[],"task":"要做的事"}',
    '',
    '规则：',
    '- 不是提醒/通知请求，或没给出可用的时间 → {"ok":false}',
    '- repeat：只提醒一次填 once；"每天/天天"填 daily；"每周X"填 weekly 并在 weekdays 里填 1-7（周一=1，周日=7），可多个。',
    '- when：24 小时制本地时间，格式 YYYY-MM-DDTHH:mm。once 必须是未来的时刻；daily/weekly 填下一次触发的日期时间。',
    '- task：只写要做的事本身。去掉时间词、"提醒我"这类触发词和标点，不要改写或补充内容。',
    '- 时间含糊（"有空的时候""过会儿"）或者只是话里带了"提醒"两个字而并非要设提醒 → {"ok":false}',
    '- 只输出那一行 JSON。',
    '',
    `这句话：${escapeBraces(text)}`,
  ].join('\n')
}

function extractJson(raw) {
  const s = String(raw ?? '').replace(/```[a-zA-Z]*/g, ' ')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const parsed = JSON.parse(s.slice(a, b + 1))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 解析模型回的那行 JSON。
 * 任何字段说不通就返回 null —— 调用方会回落到正常聊天，不会发出错误的提醒。
 */
export function parseModelReply(raw, now = Date.now()) {
  const obj = extractJson(raw)
  if (!obj || obj.ok !== true) return null

  const repeat = ['once', 'daily', 'weekly'].includes(obj.repeat) ? obj.repeat : 'once'
  const when = String(obj.when ?? '').trim()
  const task = String(obj.task ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  if (!task) return null

  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{1,2})/.exec(when)
  const short = /^(\d{1,2}):(\d{1,2})$/.exec(when)
  let hour
  let minute
  let year = null
  let month = 0
  let day = 0
  if (full) {
    year = Number(full[1])
    month = Number(full[2])
    day = Number(full[3])
    hour = Number(full[4])
    minute = Number(full[5])
  } else if (short) {
    hour = Number(short[1])
    minute = Number(short[2])
  } else {
    return null
  }
  if (!Number.isFinite(hour) || hour > 23 || minute > 59) return null

  if (repeat === 'once') {
    let at
    if (year == null) {
      const d = new Date(now)
      d.setHours(hour, minute, 0, 0)
      at = d.getTime()
      if (at <= now) {
        const next = new Date(at)
        next.setDate(next.getDate() + 1)
        at = next.getTime()
      }
    } else {
      at = new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
      if (!Number.isFinite(at) || at <= now - 60_000) return null
    }
    return { repeat: 'once', at, hour, minute, task, span: null, source: 'llm' }
  }

  const spec = { repeat, hour, minute, task, span: null, source: 'llm' }
  if (repeat === 'weekly') {
    const days = Array.isArray(obj.weekdays)
      ? [...new Set(obj.weekdays.map(Number).filter((n) => Number.isFinite(n) && n >= 1 && n <= 7))]
      : []
    spec.weekdays = days.length ? days : [weekdayOf(now)]
  }
  const nextAt = computeNext(spec, now)
  if (nextAt == null) return null
  return { ...spec, nextAt }
}
