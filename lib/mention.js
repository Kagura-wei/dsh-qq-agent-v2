/**
 * @ 解析：把模型回复里的 @ 标记转成 OneBot at 段。
 *
 * 为什么要显式标记，而不是让模型直接写「@张三」：
 * 模型说话时经常会**提到**某人（"刚才 @张三 说的那个我也看到了"），
 * 那只是在转述，不该给对方弹通知。所以主格式用 [[at:昵称]]，
 * 语义明确、不会和正文里的 @ 混淆。裸 @ 只做精确匹配兜底 ——
 * 昵称对得上才转，对不上就原样当文字，宁可少 @ 也绝不 @ 错人。
 *
 * 切分与 at 段的关系：一条长回复会被切成多条消息发出去，at 段必须
 * 只落在它原本所属的那一片里，否则同一个人会被 @ 好几次。做法是把 at
 * 换成一个哨兵字符混进文本一起切分，切完再按出现顺序还原 —— 位置天然正确。
 */

/**
 * 哨兵：NUL 字符。
 * 群里没人会发它，进正文前也会被清掉；切分算法把它当普通字符，
 * 所以它跟着所属的那一片走。
 */
export const SENTINEL = '\u0000'

/**
 * 显式标记：`[[at:昵称]]` / `[[at:123456]]`。
 * 容错大小写、半/全角冒号、内部空白。
 */
const EXPLICIT_RE = /\[\[\s*at\s*[:：]\s*([^\]\n]{1,40}?)\s*\]\]/gi

/**
 * 裸 `@昵称`。字符类排除空白与常见标点，避免把「@阿蓝，你好」的逗号吃进去。
 * 中括号写进字符类必须转义。
 */
const BARE_RE = /@([^\s@，。！？；：、,.!?;:()[\]【】{}<>《》"'“”‘’…~～|/\\*#\n\r\t]{1,20})/g

/**
 * 从存档条目里收集「最近在群里说过话的人」，作为昵称 → QQ 的查表依据。
 *
 * 不从 OneBot 拉群成员全表：大群几百人，既慢又没必要 —— 想让谁收到通知，
 * 那个人多半正在参与这场对话。从新往旧扫，同名保留最新的那个。
 *
 * @param {Array} entries 按时间正序的存档条目（含 senderId / senderName）
 * @param {{botQq?: number, limit?: number}} options
 * @returns {Array<{name: string, qq: number}>} 最近说过话的排在前面
 */
export function collectMembers(entries, { botQq = 0, limit = 60 } = {}) {
  const bot = Number(botQq) || 0
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 60
  const byName = new Map()
  const list = Array.isArray(entries) ? entries : []

  for (let i = list.length - 1; i >= 0; i--) {
    const qq = Number(list[i]?.senderId)
    if (!Number.isFinite(qq) || qq <= 0) continue
    if (bot && qq === bot) continue // 机器人自己不是可 @ 的对象
    const name = String(list[i]?.senderName ?? '').trim()
    if (!name) continue
    if (!byName.has(name)) {
      if (byName.size >= cap) break
      byName.set(name, { name, qq })
    }
  }
  return [...byName.values()]
}

/**
 * 把回复文本里的 @ 标记解析成 at 段。
 *
 * 返回的 `text` 用 SENTINEL 占住 at 的位置，交给发送层切分与还原；
 * `display` 是去掉标记的可读版本（给判定器看"机器人说了什么"）。
 *
 * @param {string} text 模型原始输出
 * @param {{members?: Array, botQq?: number, max?: number}} options
 * @returns {{text: string, display: string, ats: Array<{name:string,qq:number}>,
 *            unresolved: string[], overflow: string[]}}
 */
export function parseMentions(text, { members = [], botQq = 0, max = 2 } = {}) {
  const bot = Number(botQq) || 0
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 2
  // 原文里万一混进哨兵，先清掉，否则还原时会错位
  const src = String(text ?? '').replaceAll(SENTINEL, '')

  const ats = []
  const unresolved = []
  const overflow = []

  /** 昵称或 QQ 号 → 成员。只认「最近说过话的人」，@ 不到陌生人。 */
  const lookup = (raw) => {
    const key = String(raw ?? '').trim()
    if (!key) return undefined
    const hit = /^\d{3,}$/.test(key)
      ? members.find((m) => Number(m?.qq) === Number(key))
      : members.find((m) => String(m?.name ?? '') === key)
    if (!hit) return undefined
    if (bot && Number(hit.qq) === bot) return undefined // 不 @ 自己
    return hit
  }

  /** 认领一个 @；返回 true 表示已转成 at 段。 */
  const take = (raw) => {
    const hit = lookup(raw)
    if (!hit) {
      unresolved.push(String(raw ?? '').trim())
      return false
    }
    if (ats.length >= cap) {
      overflow.push(hit.name)
      return false
    }
    ats.push(hit)
    return true
  }

  // 一次扫描、按位置顺序处理。
  // 不能先跑一遍显式标记再跑一遍裸 @：那样两批 at 各自成段，混用时
  // 「@张三 然后 [[at:阿蓝]]」的 ats 队列会与文本里哨兵的先后错位，
  // 结果把两个人的 @ 对调。而且显式标记失败后转成 `@名字` 会被裸 @ 规则
  // 二次匹配，同一个名字被记两次"认不出"。
  const hits = []
  for (const m of src.matchAll(EXPLICIT_RE)) {
    hits.push({ start: m.index, end: m.index + m[0].length, name: m[1], explicit: true })
  }
  for (const m of src.matchAll(BARE_RE)) {
    // 防御：昵称里带 @ 时，裸匹配可能落进显式标记内部，跳过
    if (hits.some((h) => m.index >= h.start && m.index < h.end)) continue
    hits.push({ start: m.index, end: m.index + m[0].length, name: m[1], explicit: false })
  }
  hits.sort((a, b) => a.start - b.start)

  let out = ''
  let pos = 0
  for (const h of hits) {
    out += src.slice(pos, h.start)
    pos = h.end
    if (take(h.name)) out += SENTINEL
    else if (h.explicit) out += `@${String(h.name).trim()}`
    else out += src.slice(h.start, h.end) // 裸 @ 认不出就原样留着
  }
  out += src.slice(pos)

  let display = out
  let i = 0
  while (display.includes(SENTINEL) && i < ats.length) {
    display = display.replace(SENTINEL, `@${ats[i].name}`)
    i++
  }
  // 多出来的哨兵（理论上不会有）一并清掉，避免发到群里
  display = display.split(SENTINEL).join('')

  return { text: out, display, ats, unresolved, overflow }
}
