/**
 * 极简 HTTP(S) GET，**支持 HTTP 代理**。
 *
 * 为什么不用 fetch：Node 的 fetch（undici）默认不读 `HTTPS_PROXY` 环境变量，
 * 而国内机器上 GitHub 基本必须走代理 —— 表现是"请求挂死直到超时"，很难排查。
 * 这里手写一遍：直连用 https.request；走代理时 HTTPS 先 CONNECT 打隧道，
 * HTTP 则用绝对 URI 交给代理转发。零依赖，不需要用户装 undici。
 *
 * 只做 GET + 跟随重定向 + 体积上限。装表情包够用。
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'

const USER_AGENT = 'dsh-qq-agent-meme/1.0'
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

/** 解析代理地址。接受 `http://user:pass@host:port`、`host:port` 两种写法。 */
export function parseProxy(proxy) {
  const raw = String(proxy ?? '').trim()
  if (!raw) return null
  let url
  try {
    url = new URL(raw.includes('://') ? raw : `http://${raw}`)
  } catch {
    return null
  }
  if (!url.hostname) return null
  return {
    host: url.hostname,
    port: Number(url.port) || 80,
    auth:
      url.username || url.password
        ? `Basic ${Buffer.from(
            `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
          ).toString('base64')}`
        : '',
  }
}

/** 通过 HTTP 代理打一条 CONNECT 隧道，返回已握手的 TLS socket。 */
function openTunnel(proxy, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: proxy.auth ? { 'proxy-authorization': proxy.auth } : {},
      timeout: timeoutMs,
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`代理拒绝 CONNECT：HTTP ${res.statusCode}`))
        return
      }
      const secure = tls.connect({ socket, servername: targetHost }, () => resolve(secure))
      secure.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('代理连接超时')))
    req.on('error', reject)
    req.end()
  })
}

/**
 * 发一次 GET。
 * @param {{target: URL, socket?: object, proxy?: {host:number|string, port:number}, timeoutMs: number, maxBytes: number}} params
 * @returns {Promise<{body?: Buffer, redirect?: string}>}
 */
function getOnce({ target, socket, proxy, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const secure = target.protocol === 'https:'
    const headers = { 'user-agent': USER_AGENT, accept: '*/*', 'accept-encoding': 'identity' }
    const options = { method: 'GET', headers, timeout: timeoutMs, agent: false }

    if (socket) {
      // 隧道内：目标由 createConnection 决定，Host 头按真实域名
      options.createConnection = () => socket
      options.host = target.hostname
      options.port = Number(target.port) || 443
      options.path = `${target.pathname}${target.search}`
    } else if (proxy) {
      // 明文代理转发：请求行用绝对 URI
      options.host = proxy.host
      options.port = proxy.port
      options.path = target.toString()
      headers.host = target.host
    } else {
      options.hostname = target.hostname
      options.port = Number(target.port) || (secure ? 443 : 80)
      options.path = `${target.pathname}${target.search}`
    }

    const closer = (error) => {
      socket?.destroy()
      error ? reject(error) : null
    }

    const req = (secure ? https : http).request(options, (res) => {
      if (REDIRECT_CODES.has(res.statusCode)) {
        res.resume()
        const location = res.headers.location
        socket?.destroy()
        if (!location) reject(new Error('重定向缺少 Location'))
        else resolve({ redirect: new URL(location, target).toString() })
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        socket?.destroy()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > maxBytes) {
          req.destroy(new Error(`文件过大（>${Math.round(maxBytes / 1048576)}MB）`))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        socket?.destroy()
        resolve({ body: Buffer.concat(chunks) })
      })
      res.on('error', closer)
    })

    req.on('timeout', () => req.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)))
    req.on('error', closer)
    req.end()
  })
}

/**
 * GET 一个 URL，自动跟随重定向。
 *
 * 两道时间闸：`timeoutMs` 是**静止超时**（多久没收到数据就当断了），
 * `deadlineMs` 是**总时长上限** —— 表情包动辄十几 MB，只有静止超时的话，
 * 一个细水长流的坏连接能把管理页的"安装"按钮挂到天荒地老。
 *
 * @param {string} url
 * @param {{proxy?: string, timeoutMs?: number, deadlineMs?: number, maxBytes?: number, redirects?: number}} options
 * @returns {Promise<Buffer>}
 */
export async function httpGet(
  url,
  {
    proxy = '',
    timeoutMs = 60000,
    deadlineMs = 10 * 60 * 1000,
    maxBytes = 200 * 1024 * 1024,
    redirects = 5,
  } = {}
) {
  const proxyInfo = parseProxy(proxy)
  let target = new URL(url)
  const deadline = Date.now() + deadlineMs

  for (let hop = 0; hop <= redirects; hop++) {
    const remain = deadline - Date.now()
    if (remain <= 0) throw new Error(`下载超时（超过 ${Math.round(deadlineMs / 1000)}s）`)

    const useTunnel = proxyInfo && target.protocol === 'https:'
    const usePlainProxy = proxyInfo && target.protocol !== 'https:'
    const socket = useTunnel
      ? await openTunnel(proxyInfo, target.hostname, Number(target.port) || 443, Math.min(timeoutMs, remain))
      : null

    const res = await getOnce({
      target,
      socket,
      proxy: usePlainProxy ? proxyInfo : null,
      timeoutMs: Math.min(timeoutMs, remain),
      maxBytes,
    })
    if (res.body) return res.body
    target = new URL(res.redirect)
  }

  throw new Error('重定向次数过多')
}
