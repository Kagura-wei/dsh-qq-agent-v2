/**
 * 表情包管理界面（插件自带的独立 HTTP 服务）。
 *
 * 为什么不在 DSH WebUI 里做：客户端插件能拿到的只有配置表单（React 渲染的
 * 一组字段），没有"跟服务端插件通信"的通道 —— 图库浏览、上传、删除都需要
 * 服务端能力。与其去啃客户端 RPC，不如起一个只读+受限写的本地小服务：
 * 页面自包含、零构建、手机也能开。
 *
 * 安全边界（这是个会写文件的服务，必须收紧）：
 *   - token 校验：配置里留空则首次启动生成并写进 `<库目录>/.web-token`，
 *     重启不变（链接不会失效），文件权限 0600；
 *   - 所有路径经 store 的白名单校验（isSafeName），不接受任意路径；
 *   - 上传体积上限、只接受图片扩展名；
 *   - 绑定地址可配：默认 0.0.0.0（NAS 上要从 PC 访问），也可改 127.0.0.1。
 */
import http from 'node:http'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DEFAULT_INDEX_URL, installFromDir, installFromGithub, loadCommunityIndex, resolveSource } from './pack.js'
import { IMAGE_EXT, isSafeName } from './store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MAX_UPLOAD = 20 * 1024 * 1024
const INDEX_TTL_MS = 10 * 60 * 1000

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/** 读请求体，带上限。 */
function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体过大（>${Math.round(limit / 1048576)}MB）`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 解析 JSON body（容忍空体）。 */
async function readJson(req) {
  const buffer = await readBody(req, 1024 * 1024)
  if (!buffer.length) return {}
  return JSON.parse(buffer.toString('utf8'))
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length })
  res.end(body)
}

export class MemeWeb {
  constructor({ store, getConfig, logger }) {
    this.store = store
    this.getConfig = getConfig
    this.logger = logger
    this.server = null
    this.token = ''
    this.tokenFromConfig = false
    this.indexCache = { at: 0, entries: [], error: '' }
  }

  /** 取/造访问令牌。配置优先；留空则落在库目录里，重启不变。 */
  async #resolveToken() {
    const configured = String(this.getConfig().memeWebToken ?? '').trim()
    this.tokenFromConfig = Boolean(configured)
    if (configured) return configured
    const file = path.join(this.store.dir, '.web-token')
    try {
      const saved = (await fsp.readFile(file, 'utf8')).trim()
      if (saved) return saved
    } catch {
      /* 首次启动，下面生成 */
    }
    const token = crypto.randomBytes(9).toString('hex')
    await fsp.writeFile(file, `${token}\n`, { mode: 0o600 })
    return token
  }

  async start() {
    if (this.server) return
    const cfg = this.getConfig()
    const host = String(cfg.memeWebHost ?? '0.0.0.0').trim() || '0.0.0.0'
    const port = Number(cfg.memeWebPort) || 3098
    this.token = await this.#resolveToken()

    this.server = http.createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        this.logger.warn(`[表情页] 请求失败 ${req.method} ${req.url}: ${error?.message ?? error}`)
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        else res.end()
      })
    })

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP 监听超时')), 10000)
      this.server.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      this.server.listen(port, host, () => {
        clearTimeout(timer)
        resolve()
      })
    })

    // 令牌不进日志：日志会被截图、贴进 issue，而令牌能直接改库。
    // 只打地址，令牌从配置或 .web-token 文件自取。
    const shown = host === '0.0.0.0' ? '<NAS-IP>' : host
    const tokenHint = this.tokenFromConfig
      ? '令牌见配置项 memeWebToken'
      : `令牌见 ${path.join(this.store.dir, '.web-token')}`
    this.logger.info(`[表情页] 管理界面已监听 http://${shown}:${port}/ —— ${tokenHint}（打开后手填令牌）`)
  }

  async stop() {
    if (!this.server) return
    const server = this.server
    this.server = null
    await new Promise((resolve) => server.close(() => resolve()))
  }

  /** 令牌是否匹配。接受 query / header 两种带法。 */
  #authorized(url, req) {
    if (!this.token) return false
    const fromQuery = url.searchParams.get('token') ?? ''
    const fromHeader = req.headers['x-meme-token'] ?? ''
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const candidate = fromQuery || fromHeader || bearer
    if (!candidate || candidate.length !== this.token.length) return false
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(this.token))
  }

  async #handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname

    // 页面本身不含数据，允许无 token 打开（页面里再输令牌）
    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      const html = await fsp.readFile(path.join(HERE, 'web-ui.html'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    if (!this.#authorized(url, req)) {
      sendJson(res, 401, { ok: false, error: 'token 不正确' })
      return
    }

    if (req.method === 'GET' && route === '/api/state') {
      await this.store.rescan()
      sendJson(res, 200, { ok: true, ...this.store.detail(), indexUrl: this.#indexUrl() })
      return
    }

    if (req.method === 'GET' && route === '/api/index') {
      const refresh = url.searchParams.get('refresh') === '1'
      sendJson(res, 200, { ok: true, ...(await this.#index(refresh)) })
      return
    }

    if (req.method === 'GET' && route === '/img') {
      await this.#serveImage(url, res)
      return
    }

    if (req.method === 'POST') {
      const payload = await this.#dispatch(route, url, req)
      sendJson(res, 200, payload)
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  }

  #indexUrl() {
    return String(this.getConfig().memeIndexUrl ?? '').trim() || DEFAULT_INDEX_URL
  }

  /** 社区索引带缓存，避免每次开页面都去拉一次外网。 */
  async #index(refresh) {
    if (!refresh && Date.now() - this.indexCache.at < INDEX_TTL_MS) {
      return { entries: this.indexCache.entries, error: this.indexCache.error }
    }
    const entries = await loadCommunityIndex(this.#indexUrl(), {
      proxy: this.getConfig().memeProxy ?? '',
      logger: this.logger,
    })
    this.indexCache = {
      at: Date.now(),
      entries,
      error: entries.length ? '' : '索引拉取失败（可在下方手填 owner/repo 安装）',
    }
    return { entries: this.indexCache.entries, error: this.indexCache.error }
  }

  async #serveImage(url, res) {
    const pack = url.searchParams.get('pack') ?? ''
    const cat = url.searchParams.get('cat') ?? ''
    const name = url.searchParams.get('name') ?? ''
    if (![pack, cat, name].every(isSafeName)) {
      sendJson(res, 400, { ok: false, error: '参数非法' })
      return
    }
    const file = path.join(this.store.packsDir, pack, 'memes', cat, name)
    if (!file.startsWith(this.store.packsDir + path.sep)) {
      sendJson(res, 400, { ok: false, error: '路径非法' })
      return
    }
    try {
      const stat = await fsp.stat(file)
      res.writeHead(200, {
        'content-type': MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': 'no-cache',
      })
      fs.createReadStream(file).pipe(res)
    } catch {
      sendJson(res, 404, { ok: false, error: '图片不存在' })
    }
  }

  async #dispatch(route, url, req) {
    try {
      if (route === '/api/upload') return await this.#upload(url, req)
      if (route === '/api/install') {
        const body = await readJson(req)
        return await this.#install(body)
      }
      if (route === '/api/rescan') {
        await this.store.rescan({ force: true })
        return { ok: true, ...this.store.detail() }
      }

      const body = await readJson(req)
      switch (route) {
        case '/api/delete-image':
          await this.store.removeImage(body.pack, body.cat, body.name)
          return { ok: true }
        case '/api/category':
          return await this.#category(body)
        case '/api/remove-pack':
          await this.store.removePack(body.id)
          return { ok: true }
        case '/api/random':
          return await this.#random(body.key)
        default:
          return { ok: false, error: 'not found' }
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  async #upload(url, req) {
    const pack = String(url.searchParams.get('pack') ?? '').trim()
    const cat = String(url.searchParams.get('cat') ?? '').trim()
    const name = decodeURIComponent(String(url.searchParams.get('name') ?? '').trim())
    const ext = path.extname(name).toLowerCase()
    if (!IMAGE_EXT.has(ext)) return { ok: false, error: `只接受图片（${[...IMAGE_EXT].join(' ')}）` }
    if (!isSafeName(cat) || !isSafeName(name)) return { ok: false, error: '分类名或文件名非法' }
    const buffer = await readBody(req)
    if (!buffer.length) return { ok: false, error: '空文件' }
    const packId = pack || (await this.store.ensureLocalPack())
    const saved = await this.store.addImage(packId, cat, name, buffer)
    this.logger.info(`[表情页] 新增表情 ${packId}/${cat}/${saved}（${Math.round(buffer.length / 1024)}KB）`)
    return { ok: true, name: saved, pack: packId, cat }
  }

  async #install(body) {
    const input = String(body.source ?? '').trim()
    const index = this.indexCache.entries
    const resolved = resolveSource(input, { indexEntries: index })
    const options = { proxy: this.getConfig().memeProxy ?? '', replace: body.replace !== false }

    // 表情包仓库动辄几十到几百 MB（实测官方1号 67MB、ATRI 304MB），
    // 下载要几分钟 —— 先落一行日志，免得用户以为卡死了。
    this.logger.info(`[表情页] 开始安装 ${input}（大包需要几分钟，请稍候）`)

    let result
    if (resolved.kind === 'github') result = await installFromGithub(resolved.source, this.store.packsDir, options)
    else if (resolved.kind === 'dir') result = await installFromDir(resolved.path, this.store.packsDir, options)
    else throw new Error('暂不支持直接装 URL 压缩包，请填 owner/repo 或包 id')

    await this.store.rescan({ force: true })
    this.logger.info(
      `[表情页] 已安装表情包 ${result.manifest.id}（${result.manifest.name}）` +
        ` ${Object.keys(result.manifest.categories).length} 分类 / ${result.files} 文件`
    )
    return { ok: true, pack: result.manifest.id, name: result.manifest.name, files: result.files }
  }

  async #category(body) {
    const action = String(body.action ?? '')
    if (action === 'delete') {
      await this.store.removeCategory(body.pack, body.cat)
      return { ok: true }
    }
    const pack = String(body.pack ?? '').trim() || (await this.store.ensureLocalPack())
    if (action === 'rename') {
      // 重命名 = 建新分类 + 移图 + 删旧分类；图少时一次性做完，不必慢慢搬
      const from = String(body.cat ?? '').trim()
      const to = String(body.to ?? '').trim()
      if (!isSafeName(from) || !isSafeName(to)) throw new Error('分类名非法')
      const files = await fsp.readdir(path.join(this.store.packsDir, pack, 'memes', from))
      for (const name of files) {
        const buffer = await fsp.readFile(path.join(this.store.packsDir, pack, 'memes', from, name))
        await this.store.addImage(pack, to, name, buffer)
      }
      await this.store.removeCategory(pack, from)
      return { ok: true }
    }
    const cat = String(body.cat ?? '').trim()
    if (!isSafeName(cat)) throw new Error('分类名非法')
    await this.store.setCategoryDesc(pack, cat, String(body.desc ?? ''))
    return { ok: true, pack }
  }

  /** 抽一张看看（调试用：确认分类真的能出图）。 */
  async #random(key) {
    const hit = await this.store.read(String(key ?? ''), {})
    if (!hit) return { ok: false, error: '该分类没有可用图片（或图超体积上限）' }
    return {
      ok: true,
      pick: { pack: hit.pack, cat: hit.cat, name: hit.name, mime: hit.mime, bytes: hit.buffer.length },
      url:
        `/img?pack=${encodeURIComponent(hit.pack)}&cat=${encodeURIComponent(hit.cat)}` +
        `&name=${encodeURIComponent(hit.name)}`,
    }
  }
}
