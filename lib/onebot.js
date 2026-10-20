/**
 * 反向 WebSocket 服务端：NapCat(OneBot v11) 主动连过来。
 *
 * 职责边界：只管传输。不认识 Agent、不认识门控。
 * - 收：JSON 事件帧 → 派发给 onEvent 回调
 * - 发：call(action, params) 走 echo 关联，返回 Promise
 */
import { WebSocketServer } from 'ws'

const CONNECT_TIMEOUT_MS = 15000

export class OneBotServer {
  constructor({ getConfig, logger }) {
    this.getConfig = getConfig
    this.logger = logger
    this.wss = null
    this.sockets = new Set()
    this.pending = new Map()
    this.handlers = new Set()
    this.connectHandlers = new Set()
    this.echoSeq = 0
    this.heartbeatTimer = null
  }

  /** 注册事件回调，返回取消函数（便于交给 ctx.effect 管理）。 */
  onEvent(fn) {
    this.handlers.add(fn)
    return () => this.handlers.delete(fn)
  }

  /**
   * 注册「连接建立」回调。
   * 启动时 NapCat 往往还没连上来，get_login_info 只能等连接就绪后再打，
   * 且断线重连后也应重打一次（self_id 可能随登录号变化）。
   */
  onConnect(fn) {
    this.connectHandlers.add(fn)
    return () => this.connectHandlers.delete(fn)
  }

  /** 启动监听。端口占用等失败会 reject，由调用方决定如何上报。 */
  async start() {
    const { host, port } = this.getConfig()
    if (this.wss) return

    await new Promise((resolve, reject) => {
      const server = new WebSocketServer({ host, port })
      const timer = setTimeout(() => {
        reject(new Error(`WS 监听超时: ${host}:${port}`))
      }, CONNECT_TIMEOUT_MS)

      server.on('listening', () => {
        clearTimeout(timer)
        this.wss = server
        this.logger.info(`反向 WS 已监听 ${host}:${port}，等待 NapCat 连接`)
        resolve()
      })
      server.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })

    this.wss.on('connection', (socket, req) => this.#accept(socket, req))
    this.wss.on('error', (error) => this.logger.error(`WS 服务错误: ${error?.message ?? error}`))
    this.#startHeartbeat()
  }

  /** 校验并接管一条 NapCat 连接。 */
  #accept(socket, req) {
    const { accessToken } = this.getConfig()
    if (accessToken && !this.#tokenOk(req, accessToken)) {
      this.logger.warn('拒绝连接：token 校验失败')
      socket.close(1008, 'unauthorized')
      return
    }

    const peer = req.socket.remoteAddress ?? 'unknown'
    this.logger.info(`NapCat 已连接 (${peer})`)
    this.sockets.add(socket)
    socket.isAlive = true

    socket.on('pong', () => {
      socket.isAlive = true
    })
    socket.on('message', (raw) => this.#onMessage(socket, raw))
    socket.on('close', () => {
      this.sockets.delete(socket)
      this.logger.warn(`NapCat 断开 (${peer})，剩余连接 ${this.sockets.size}`)
    })
    socket.on('error', (error) => {
      this.logger.error(`连接错误: ${error?.message ?? error}`)
    })

    for (const fn of this.connectHandlers) {
      try {
        fn({ peer })
      } catch (error) {
        this.logger.error(`连接回调异常: ${error?.stack ?? error}`)
      }
    }
  }

  /** token 支持 Authorization: Bearer 与 ?access_token= 两种写法。 */
  #tokenOk(req, expected) {
    const header = req.headers?.authorization ?? ''
    if (header === `Bearer ${expected}` || header === expected) return true
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      return url.searchParams.get('access_token') === expected
    } catch {
      return false
    }
  }

  #onMessage(socket, raw) {
    let payload
    try {
      payload = JSON.parse(raw.toString())
    } catch {
      return // 心跳等非 JSON 帧，忽略
    }

    // 动作响应：靠 echo 归因
    if (payload.echo != null && this.pending.has(String(payload.echo))) {
      const entry = this.pending.get(String(payload.echo))
      clearTimeout(entry.timer)
      this.pending.delete(String(payload.echo))
      if (payload.retcode === 0 || payload.status === 'ok') entry.resolve(payload.data ?? payload)
      else entry.reject(new Error(`OneBot 动作失败 retcode=${payload.retcode} ${payload.message ?? ''}`))
      return
    }

    if (!payload.post_type) return
    for (const fn of this.handlers) {
      try {
        fn(payload)
      } catch (error) {
        this.logger.error(`事件处理器异常: ${error?.stack ?? error}`)
      }
    }
  }

  /** 发起一个 OneBot 动作。没有任何连接时直接失败，避免无限等待。 */
  call(action, params = {}, timeoutMs = 15000) {
    const socket = this.#pick()
    if (!socket) return Promise.reject(new Error('NapCat 未连接'))
    if (socket.readyState !== socket.OPEN) return Promise.reject(new Error('NapCat 连接未就绪'))

    const echo = `qq-${Date.now()}-${++this.echoSeq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`动作超时: ${action}`))
      }, timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      socket.send(JSON.stringify({ action, params, echo }), (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(error)
      })
    })
  }

  /** 发消息。segments 为 OneBot array 格式的消息段。 */
  async send(scene, peerId, segments, timeoutMs = 15000) {
    const action = scene === 'group' ? 'send_group_msg' : 'send_private_msg'
    const key = scene === 'group' ? 'group_id' : 'user_id'
    return this.call(action, { [key]: peerId, message: segments }, timeoutMs)
  }

  /**
   * 发合并转发（聊天记录卡片）。
   *
   * 长回复逐条发就是刷屏，这里把它包成一条转发消息，群里只占一个气泡。
   * 各实现对节点格式与 action 名不完全一致，所以调用方必须做好失败回退 ——
   * 我们只按 OneBot v11 的标准形态发：node 节点带 { name, uin, content }。
   *
   * @param {Array} nodes 形如 [{ type:'node', data:{ name, uin, content: segments } }]
   */
  async sendForward(scene, peerId, nodes, timeoutMs = 15000) {
    const action = scene === 'group' ? 'send_group_forward_msg' : 'send_private_forward_msg'
    const key = scene === 'group' ? 'group_id' : 'user_id'
    return this.call(action, { [key]: peerId, messages: nodes }, timeoutMs)
  }

  async getLoginInfo() {
    return this.call('get_login_info', {}, 8000)
  }

  #pick() {
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) return socket
    }
    return null
  }

  #startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      for (const socket of this.sockets) {
        if (socket.isAlive === false) {
          this.logger.warn('检测到死连接，主动断开')
          socket.terminate()
          continue
        }
        socket.isAlive = false
        try {
          socket.ping()
        } catch {
          /* 忽略：下次循环会清理 */
        }
      }
    }, 30000)
    this.heartbeatTimer.unref?.()
  }

  async stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('服务已停止'))
    }
    this.pending.clear()
    for (const socket of this.sockets) socket.close(1001, 'server shutting down')
    this.sockets.clear()
    this.handlers.clear()
    this.connectHandlers.clear()

    if (this.wss) {
      const server = this.wss
      this.wss = null
      await new Promise((resolve) => server.close(() => resolve()))
    }
  }
}
