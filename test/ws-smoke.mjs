/**
 * 冒烟：反向 WS 服务能起来、能收事件、echo 能归因、token 能拒绝。
 * 运行：node test/ws-smoke.mjs
 */
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { OneBotServer } from '../lib/onebot.js'

const logger = { info() {}, warn() {}, error() {} }
const config = { host: '127.0.0.1', port: 16701, accessToken: 'tk-test' }
const server = new OneBotServer({ getConfig: () => config, logger })

const received = []
server.onEvent((e) => received.push(e))

await server.start()
console.log('  ok  WS 服务已监听')

// 1) 带正确 token 连接并上报事件
const ws = new WebSocket('ws://127.0.0.1:16701', {
  headers: { authorization: 'Bearer tk-test' },
})
await new Promise((resolve, reject) => {
  ws.on('open', resolve)
  ws.on('error', reject)
})
// 服务端收到动作请求时，按 echo 回一个成功响应
ws.on('message', (raw) => {
  const payload = JSON.parse(raw.toString())
  if (payload.action) {
    ws.send(JSON.stringify({ echo: payload.echo, retcode: 0, data: { message_id: 12345 } }))
  }
})

ws.send(
  JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    group_id: 10001,
    user_id: 555,
    message: [{ type: 'text', data: { text: '你好' } }],
  })
)
await new Promise((r) => setTimeout(r, 200))
assert.equal(received.length, 1, '应收到 1 条事件')
assert.equal(received[0].group_id, 10001)
console.log('  ok  收到上报事件')

// 2) call() 走 echo 关联拿回数据
const result = await server.call('send_group_msg', { group_id: 1, message: [] })
assert.equal(result.message_id, 12345)
console.log('  ok  动作 echo 关联正确')

// 3) 错误 token 必须被拒绝。
// 注意：握手已完成，客户端会先触发 open 再收到 close，所以判 close code 而非 open。
const closeCode = await new Promise((resolve) => {
  const bad = new WebSocket('ws://127.0.0.1:16701')
  bad.on('close', (code) => resolve(code))
  bad.on('error', () => resolve(-1))
})
assert.equal(closeCode, 1008, `token 错误应被 1008 拒绝，实际 close code=${closeCode}`)
console.log('  ok  错误 token 被拒绝 (1008)')

// 3b) 被拒绝的连接不该进入服务端 sockets
const before = received.length
const sneaky = new WebSocket('ws://127.0.0.1:16701')
sneaky.on('open', () => {
  sneaky.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 1 }))
})
await new Promise((r) => setTimeout(r, 300))
assert.equal(received.length, before, '未授权连接上报的事件不应被接受')
sneaky.close()
console.log('  ok  未授权连接的上报被丢弃')

// 4) 未连接时 call 应快速失败而不是挂住
await server.stop()
await assert.rejects(() => server.call('send_group_msg', {}), /未连接/)
console.log('  ok  离线时 call 快速失败')

console.log('\n冒烟全部通过\n')
