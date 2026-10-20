/**
 * 话题跟进验证：向假群连投几条消息，观察插件日志里的 [判定] / [接话] / [回复] 行。
 *
 * 与早先版本的区别（为什么必须这样）：
 *   1. **应答 OneBot 动作帧**。插件发送时 `#pick()` 取"Set 里第一个 OPEN 连接"，
 *      且要等 echo 响应才算发送成功；假连接不回 ok，发送就算失败，
 *      `onReply` 不触发 → 跟进期窗口永远开不了，整条链路测不出来。
 *   2. **抢在 NapCat 前面连上**。连接顺序 = Set 插入顺序，只有排在 NapCat 之前，
 *      这条假连接才会被 `#pick()` 选中（回执也只回到这里，不会真发到 QQ 群）。
 *      所以脚本会在监听端口一打开就接入，并重试到成功为止。
 *
 * 用法：先起本脚本（它会轮询等端口），再启动 DSH。
 * E2E_TEXTS 用 || 分隔，支持这些前缀：
 *   期望:文本        期望为 Y/N/?（只用于打印对照）
 *   ~90~文本         先等 90 秒再发（用来跨过跟进期窗口）
 *   IMG:文本         发一张图
 *   AT<qq>:文本      **第一个段是 @ 别人**（验证"在对别人说话"时不误触发）
 *   R:文本           带 reply 段，引用机器人**上一条**发出的消息
 *                   （会先等机器人真的回过话；验证"引用机器人"这条触发）
 */
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'

const URL_ = 'ws://127.0.0.1:6701'
const GROUP = Number(process.env.E2E_GROUP ?? 999999)
/** 机器人自己的 QQ（假 OneBot 服务端返回的 self_id / 登录信息）。真机 E2E 用 E2E_SELF 覆盖。 */
const SELF = Number(process.env.E2E_SELF ?? 10003)
const GAP_MS = Number(process.env.E2E_GAP ?? 14000)
const CONNECT_WAIT_MS = Number(process.env.E2E_CONNECT_WAIT ?? 60000)

/** 多发言人轮转，避免整段历史看起来像一个人自言自语。 */
const SENDERS = (process.env.E2E_SENDERS ?? 'tester:10002||阿May:100200')
  .split('||')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [name, id] = s.split(':')
    return { name, id: Number(id) }
  })

const CASES = (process.env.E2E_TEXTS ?? '今天天气不错啊||谁能帮我看看这个报错是怎么回事||哈哈')
  .split('||')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    // 可选前缀：`~90~` = 先等 90 秒再发（用来跨过跟进期窗口）
    let pause = 0
    const p = /^~(\d+)~([\s\S]*)$/.exec(s)
    let body = s
    if (p) {
      pause = Number(p[1])
      body = p[2]
    }

    // `AT<qq>:` = 首个消息段就是 @ 别人（考察误触发防护）
    let atQq = 0
    const a = /^AT(\d+):([\s\S]*)$/.exec(body)
    if (a) {
      atQq = Number(a[1])
      body = a[2]
    }

    // `R:` = 带 reply 段，引用机器人上一条消息（考察"引用机器人"这条触发）
    let replyToLast = false
    const r = /^R:([\s\S]*)$/.exec(body)
    if (r) {
      replyToLast = true
      body = r[1]
    }

    const m = /^([YN?]):([\s\S]*)$/.exec(body)
    const base = m
      ? { expect: m[1].toUpperCase(), text: m[2], pause }
      : { expect: '?', text: body, pause }
    // `IMG:` 前缀 = 发一张图（URL 是假的，插件取图失败会降级 [图片]，但门控照样触发）
    if (base.text.startsWith('IMG:')) {
      return { ...base, isImage: true, text: base.text.slice(4), atQq, replyToLast }
    }
    return { ...base, atQq, replyToLast }
  })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 机器人发出去的消息号（由假连接的 ok 回执给出），`R:` 用例要靠它引用。 */
const botMessageIds = []

function groupEvent(text, sender, isImage = false, { atQq = 0, replyTo = 0 } = {}) {
  let segments = []
  // at 必须放第一个段：门控的误触发防护正是看"第一个有效段是不是 @ 别人"
  if (atQq) segments.push({ type: 'at', data: { qq: String(atQq) } })
  if (replyTo) segments.push({ type: 'reply', data: { id: String(replyTo) } })
  if (isImage) {
    // E2E_IMG_URL：真图挂在本地 http 上，走 NapCat 的真实形态（http url）。
    // 大图必须用这条 —— 存档对 base64 内联有体积上限，大 base64 会被裁掉，
    // 于是"存档里的段"算不出缓存键，图片在装配阶段就丢了（E2E 假象，不是线上问题）。
    // E2E_IMG_FILE：小图以 base64:// 直嵌（NapCat 语义），插件不走网络直接解码。
    const imgSeg = process.env.E2E_IMG_URL
      ? { type: 'image', data: { url: process.env.E2E_IMG_URL, file: 'e2e-long.jpg' } }
      : process.env.E2E_IMG_FILE
        ? { type: 'image', data: { file: `base64://${readFileSync(process.env.E2E_IMG_FILE).toString('base64')}` } }
        : { type: 'image', data: { url: 'https://gchat.qpic.cn/fake-e2e.jpg', file: 'e2e.image' } }
    if (text) segments.push({ type: 'text', data: { text } })
    segments.push(imgSeg)
  } else {
    segments.push({ type: 'text', data: { text } })
  }
  const raw = (atQq ? `[CQ:at,qq=${atQq}]` : '') + (replyTo ? `[CQ:reply,id=${replyTo}]` : '') + text
  return JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 9100000 + Math.floor(Math.random() * 100000),
    group_id: GROUP,
    user_id: sender.id,
    self_id: SELF,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: sender.id, nickname: sender.name, card: sender.name },
    message: segments,
    raw_message: raw,
  })
}

/** 等监听端口打开后接入；抢在 NapCat 之前成为第一条连接。 */
async function connectFirst() {
  const deadline = Date.now() + CONNECT_WAIT_MS
  let attempt = 0
  while (Date.now() < deadline) {
    attempt++
    const ws = new WebSocket(URL_)
    const ok = await new Promise((resolve) => {
      ws.once('open', () => resolve(true))
      ws.once('error', () => resolve(false))
    })
    if (ok) {
      console.log(`已连接（第 ${attempt} 次尝试）—— 应排在 NapCat 之前`)
      return ws
    }
    await sleep(120)
  }
  throw new Error('等不到 WS 监听端口')
}

let seq = 0
const actions = []

/**
 * 把出站消息段渲染成一行可读文本，at 段标成【@qq】。
 *
 * 这是验证「机器人真的 @ 了人」的唯一外部证据：插件日志只说"解析出谁"，
 * 到底有没有把 at 段发出去，只有这里看得到。
 */
function describeOutbound(payload) {
  if (payload.action !== 'send_group_msg' && payload.action !== 'send_private_msg') return ''
  const msg = payload.params?.message
  if (typeof msg === 'string') return `  「${msg.slice(0, 120)}」`
  if (!Array.isArray(msg)) return ''
  const text = msg
    .map((s) => {
      if (s?.type === 'text') return String(s.data?.text ?? '')
      if (s?.type === 'at') return `【@${s.data?.qq}】`
      if (s?.type === 'image') return '[图片]'
      return `[${s?.type ?? '?'}]`
    })
    .join('')
  const ats = msg.filter((s) => s?.type === 'at').length
  return `  「${text.slice(0, 140)}」${ats ? `  ← 含 ${ats} 个 at 段` : ''}`
}

const ws = await connectFirst()

// 插件发的每个动作都要回 ok：回执决定"发送是否算成功"，而只有发出去才会开窗。
ws.on('message', (raw) => {
  let payload
  try {
    payload = JSON.parse(raw.toString())
  } catch {
    return
  }
  if (payload.echo == null) return
  actions.push(payload.action)
  console.log(`  <- 收到动作 ${payload.action}（第 ${actions.length} 个）${describeOutbound(payload)}`)
  const isSend = payload.action === 'send_group_msg' || payload.action === 'send_private_msg'
  const messageId = 880000 + seq++
  // 记住机器人自己发出去的消息号：`R:` 用例要用它构造 reply 段，
  // 插件侧靠出站登记表认出"这是在引用我说的那句话"。
  if (isSend) botMessageIds.push(messageId)
  ws.send(
    JSON.stringify({
      status: 'ok',
      retcode: 0,
      echo: payload.echo,
      data: payload.action === 'get_login_info' ? { user_id: SELF, nickname: '阿蓝' } : { message_id: messageId },
    })
  )
})

let n = 0
console.log(`开始投递 ${CASES.length} 条（群 ${GROUP}，间隔 ${GAP_MS}ms）`)
for (const c of CASES) {
  if (c.pause > 0) {
    console.log(`   … 先等 ${c.pause}s（跨窗口用）`)
    await sleep(c.pause * 1000)
  }
  if (c.replyToLast) {
    // 等机器人真的发过话，否则引用不到东西（消息号来自假连接的 ok 回执）
    const deadline = Date.now() + 90000
    while (!botMessageIds.length && Date.now() < deadline) await sleep(500)
    if (!botMessageIds.length) {
      console.log('!! 机器人一直没发出消息，R: 用例拿不到可引用的消息号，跳过')
      continue
    }
    console.log(`   … 引用的消息号 = ${botMessageIds[botMessageIds.length - 1]}`)
    await sleep(1500)
  }
  const sender = SENDERS[n % SENDERS.length]
  n++
  const replyTo = c.replyToLast ? botMessageIds[botMessageIds.length - 1] : 0
  console.log(
    `→ [${sender.name}] ${c.atQq ? `@${c.atQq} ` : ''}${replyTo ? `(引用 ${replyTo}) ` : ''}` +
      `${c.isImage ? '[图片]' : c.text}   期望=${c.expect}`
  )
  ws.send(groupEvent(c.text, sender, c.isImage, { atQq: c.atQq, replyTo }))
  await sleep(GAP_MS)
}
console.log(`投递完毕，等 30s 让最后一条跑完（累计收到 ${actions.length} 个动作）`)
await sleep(30000)
ws.close()
process.exit(0)
