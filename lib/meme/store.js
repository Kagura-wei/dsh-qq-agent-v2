/**
 * 表情包库。
 *
 * 磁盘布局直接沿用 AstrBot 表情包协议（`anka-afk/astrbot-meme-pack-index`
 * 的 ASTRBOT_MEME_PACK_PROTOCOL），这样社区里现成的 12 个包解压即用：
 *
 *   <dir>/packs/<packId>/manifest.json      { id, name, version, categories: {键: {description}} }
 *   <dir>/packs/<packId>/memes/<分类名>/*.png
 *
 * 为什么不自己发明格式：分类描述的措辞（"当对话包含抱怨、批评或强烈反对时
 * 使用"）本身就是提示词素材，社区包是按它写的；换格式等于把现成资源全部作废。
 *
 * 多包合并成**一个分类池**：不同包里的同名分类合并到同一键下（社区包普遍
 * 都叫 happy/sad/shy，合并后选图面更宽）。冲突描述取第一个非空的。
 *
 * 快照有指纹（hash）：只有内容真的变了才 bump revision。上层（runner）靠
 * 它决定要不要把新分类表注入会话 —— 指纹抖动会导致会话反复重建。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

/** 协议允许的图片格式（与上游 IMAGE_EXTENSIONS 保持一致）。 */
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

/** 分类名 / 包 id 的长度上限，防止畸形 manifest 把目录名撑爆。 */
const MAX_NAME = 64

/** 包内允许带进库的文件前缀（协议里的可移植内容，其余一律丢弃）。 */
const KEEP_PREFIX = ['memes/', 'previews/']
const KEEP_FILES = new Set(['manifest.json', 'semantic_metadata.json'])

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/**
 * 分类名 / 包 id 是否可用作目录名。
 * 挡的是路径穿越（`..`、`/`、`\`）与控制字符 —— 这些名字最终会拼进文件系统。
 */
export function isSafeName(value) {
  const name = String(value ?? '').trim()
  if (!name || name.length > MAX_NAME) return false
  if (name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\')) return false
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f]/.test(name)
}

/** 统一的随机取图：crypto 的均匀分布，避免 Math.random 在大库上的偏斜。 */
function pickIndex(size) {
  return crypto.randomInt(size)
}

export class MemeStore {
  /**
   * @param {{getConfig: Function, logger: object, dir: string}} options
   *   dir = 库根目录（与 qq-archive 同级）
   */
  constructor({ getConfig, logger, dir }) {
    this.getConfig = getConfig
    this.logger = logger
    this.dir = path.resolve(dir)
    this.packsDir = path.join(this.dir, 'packs')
    this.state = { revision: 0, hash: '', categories: new Map(), packs: [], total: 0 }
    /** 每个分类上次发出的图，避免连续两次撞同一张（观感上很像复读）。 */
    this.lastPick = new Map()
    this.ready = false
  }

  async init() {
    await fsp.mkdir(this.packsDir, { recursive: true })
    await this.rescan({ force: true })
    this.ready = true
  }

  /** 分类键数组（给解析器做白名单）。只含有图的分类 —— 空的选了也发不出图。 */
  keys() {
    return [...this.state.categories.values()].filter((c) => c.images.length).map((c) => c.key)
  }

  /** 分类清单（给提示词）。空分类不进提示词：让模型选中一个发不出图的键没意义。 */
  categories() {
    return [...this.state.categories.values()]
      .filter((c) => c.images.length)
      .map((c) => ({
        key: c.key,
        desc: c.desc,
        count: c.images.length,
      }))
  }

  /** 只读快照，含每张图的绝对路径（web 管理页要用）。 */
  detail() {
    return {
      revision: this.state.revision,
      dir: this.dir,
      total: this.state.total,
      packs: this.state.packs,
      categories: [...this.state.categories.values()].map((c) => ({
        key: c.key,
        desc: c.desc,
        images: c.images.map((i) => ({ pack: i.pack, cat: i.cat, name: i.name, size: i.size })),
      })),
    }
  }

  /** 库是否为空 —— 空库时上层完全不注入表情包提示词，零 token 成本。 */
  get empty() {
    return this.state.total === 0
  }

  /**
   * 重新扫描磁盘。
   *
   * 目录 mtime 没变就直接返回（web 上传、外部解包都会改 mtime，够用且便宜）。
   * @param {{force?: boolean}} options
   * @returns {Promise<boolean>} 内容是否真的变了
   */
  async rescan({ force = false } = {}) {
    let mtime = 0
    try {
      mtime = (await fsp.stat(this.packsDir)).mtimeMs
    } catch {
      await fsp.mkdir(this.packsDir, { recursive: true })
    }
    if (!force && mtime && mtime === this.mtimeMs) return false
    this.mtimeMs = mtime

    const next = { categories: new Map(), packs: [], total: 0 }
    const signature = []

    let entries = []
    try {
      entries = await fsp.readdir(this.packsDir, { withFileTypes: true })
    } catch (error) {
      this.logger.warn(`读表情包目录失败: ${error?.message ?? error}`)
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeName(entry.name)) continue
      const packDir = path.join(this.packsDir, entry.name)
      const manifest = await this.#readManifest(packDir)
      if (!manifest) continue

      const memesDir = path.join(packDir, 'memes')
      let cats = []
      try {
        cats = (await fsp.readdir(memesDir, { withFileTypes: true })).filter((d) => d.isDirectory())
      } catch {
        cats = []
      }

      let packImages = 0
      for (const catEntry of cats) {
        const cat = catEntry.name
        if (!isSafeName(cat)) continue
        let files = []
        try {
          files = await fsp.readdir(path.join(memesDir, cat), { withFileTypes: true })
        } catch {
          continue
        }
        const images = []
        for (const file of files) {
          if (!file.isFile()) continue
          const ext = path.extname(file.name).toLowerCase()
          if (!IMAGE_EXT.has(ext)) continue
          images.push({
            pack: manifest.id,
            cat,
            name: file.name,
            path: path.join(memesDir, cat, file.name),
            size: 0, // 体积在发送时才 stat —— 扫描阶段逐个 stat 上千张图太慢
            ext,
          })
        }
        // 空分类照样登记：管理页要能显示"刚建好、还没传图"的分类，
        // 否则"新建分类 → 上传"这条流程第一步就把自己藏起来了。
        // 提示词与解析白名单只认有图的分类（见 categories / keys）。
        packImages += images.length
        signature.push(`${manifest.id}/${cat}/${images.length}/${images.map((i) => i.name).join(',')}`)

        const key = cat.trim().toLowerCase()
        const existing = next.categories.get(key)
        const desc = String(manifest.categories?.[cat]?.description ?? '').trim()
        if (existing) {
          existing.images.push(...images)
          if (!existing.desc && desc) existing.desc = desc
        } else {
          next.categories.set(key, { key, desc, images })
        }
      }

      next.total += packImages
      next.packs.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description ?? '',
        images: packImages,
      })
      signature.push(`${manifest.id}|${manifest.name}|${manifest.version}|${packImages}`)
    }

    const hash = crypto.createHash('sha1').update(signature.sort().join('\n')).digest('hex')
    if (!force && hash === this.state.hash) return false

    const before = this.state.total
    this.state = { revision: this.state.revision + 1, hash, ...next }
    this.lastPick.clear()
    if (before !== next.total || force) {
      this.logger.info(
        `[表情] 库已刷新 rev=${this.state.revision}：${this.state.packs.length} 个包、` +
          `${this.state.categories.size} 个分类、${this.state.total} 张图`
      )
    }
    return true
  }

  /**
   * 随机取一张该分类的图。
   *
   * @param {string} key 分类键
   * @returns {{path: string, name: string, pack: string, cat: string, ext: string}|null}
   */
  pick(key) {
    const category = this.state.categories.get(String(key ?? '').trim().toLowerCase())
    if (!category?.images.length) return null
    const images = category.images
    let hit = images[pickIndex(images.length)]
    // 撞上刚发过的那张就再抽一次（库里只有一张时保持原样）
    if (images.length > 1 && hit.path === this.lastPick.get(category.key)) {
      hit = images[pickIndex(images.length)]
    }
    this.lastPick.set(category.key, hit.path)
    return hit
  }

  /**
   * 取图并读成字节，顺带做体积校验。
   *
   * 超大图会让 base64 后的 WS 帧涨到十几 MB，NapCat 那边可能直接拒绝或超时；
   * 宁可少发一张，也不要卡住整轮回复。
   *
   * @returns {Promise<{buffer: Buffer, mime: string, name: string, pack: string, cat: string}|null>}
   */
  async read(key, cfg = {}) {
    const hit = this.pick(key)
    if (!hit) return null
    const limit = Number(cfg.memeMaxImageBytes) || 4 * 1024 * 1024
    try {
      const stat = await fsp.stat(hit.path)
      if (stat.size > limit) {
        this.logger.warn(
          `[表情] ${hit.pack}/${hit.cat}/${hit.name} ${Math.round(stat.size / 1024)}KB ` +
            `超过上限 ${Math.round(limit / 1024)}KB，跳过`
        )
        return null
      }
      const buffer = await fsp.readFile(hit.path)
      return {
        buffer,
        mime: MIME[hit.ext] ?? 'image/png',
        name: hit.name,
        pack: hit.pack,
        cat: hit.cat,
      }
    } catch (error) {
      this.logger.warn(`[表情] 读图失败 ${hit.path}: ${error?.message ?? error}`)
      return null
    }
  }

  // ─────────────────────────── 写操作（web 管理页用） ───────────────────────────

  /** 库必须至少有一个包才能往里传图；没有就建一个本地包。 */
  async ensureLocalPack(packId = 'local') {
    const id = isSafeName(packId) ? packId : 'local'
    const packDir = path.join(this.packsDir, id)
    const manifestPath = path.join(packDir, 'manifest.json')
    if (!fs.existsSync(manifestPath)) {
      const manifest = {
        schema_version: 1,
        id,
        name: '本地表情包',
        version: '1.0.0',
        description: '在管理页上传的表情',
        categories: {},
      }
      await fsp.mkdir(path.join(packDir, 'memes'), { recursive: true })
      await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    }
    return id
  }

  async #readManifest(packDir) {
    const file = path.join(packDir, 'manifest.json')
    try {
      const raw = await fsp.readFile(file, 'utf8')
      const data = JSON.parse(raw.replace(/^\uFEFF/, ''))
      const id = String(data.id ?? '').trim() || path.basename(packDir)
      if (!isSafeName(id)) return null
      const categories = {}
      for (const [name, meta] of Object.entries(data.categories ?? {})) {
        if (!isSafeName(name)) continue
        categories[name] = { description: String(meta?.description ?? '') }
      }
      return {
        id,
        name: String(data.name ?? id).trim() || id,
        version: String(data.version ?? '').trim() || '-',
        description: String(data.description ?? '').trim(),
        categories,
      }
    } catch (error) {
      this.logger.warn(`跳过表情包 ${path.basename(packDir)}：manifest.json 不可用（${error?.message ?? error}）`)
      return null
    }
  }

  /** 更新 manifest 里的分类描述（新建分类 = 写一条空描述）。 */
  async setCategoryDesc(packId, category, desc) {
    const packDir = await this.#requirePack(packId)
    const manifestPath = path.join(packDir, 'manifest.json')
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
    manifest.categories = manifest.categories ?? {}
    manifest.categories[category] = { ...(manifest.categories[category] ?? {}), description: String(desc ?? '') }
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    await fsp.mkdir(path.join(packDir, 'memes', category), { recursive: true })
    await this.rescan({ force: true })
  }

  /** 存一张上传的图。文件名冲突时自动加序号，不覆盖已有表情。 */
  async addImage(packId, category, name, buffer) {
    if (!isSafeName(category)) throw new Error('分类名非法')
    const packDir = await this.#requirePack(packId)
    const ext = path.extname(String(name ?? '')).toLowerCase()
    if (!IMAGE_EXT.has(ext)) throw new Error(`不支持的图片格式：${ext || '未知'}`)
    const dir = path.join(packDir, 'memes', category)
    await fsp.mkdir(dir, { recursive: true })
    const target = await this.#uniquePath(dir, String(name))
    await fsp.writeFile(target, buffer)
    if (!(await this.#hasCategory(packDir, category))) {
      await this.setCategoryDesc(packId, category, '')
      return path.basename(target)
    }
    await this.rescan({ force: true })
    return path.basename(target)
  }

  async removeImage(packId, category, name) {
    const packDir = await this.#requirePack(packId)
    if (!isSafeName(category) || !isSafeName(name)) throw new Error('文件名非法')
    const file = path.join(packDir, 'memes', category, path.basename(name))
    await fsp.unlink(file)
    await this.rescan({ force: true })
  }

  /** 删分类：连目录带图一起删。 */
  async removeCategory(packId, category) {
    const packDir = await this.#requirePack(packId)
    if (!isSafeName(category)) throw new Error('分类名非法')
    await fsp.rm(path.join(packDir, 'memes', category), { recursive: true, force: true })
    const manifestPath = path.join(packDir, 'manifest.json')
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
    if (manifest.categories) delete manifest.categories[category]
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    await this.rescan({ force: true })
  }

  async removePack(packId) {
    const packDir = path.join(this.packsDir, this.#safeId(packId))
    await fsp.rm(packDir, { recursive: true, force: true })
    await this.rescan({ force: true })
  }

  #safeId(packId) {
    const id = String(packId ?? '').trim()
    if (!isSafeName(id)) throw new Error('包 id 非法')
    return id
  }

  async #requirePack(packId) {
    const id = this.#safeId(packId)
    const packDir = path.join(this.packsDir, id)
    if (!fs.existsSync(path.join(packDir, 'manifest.json'))) throw new Error(`表情包不存在：${id}`)
    return packDir
  }

  async #hasCategory(packDir, category) {
    try {
      return (await fsp.stat(path.join(packDir, 'memes', category))).isDirectory()
    } catch {
      return false
    }
  }

  async #uniquePath(dir, name) {
    const ext = path.extname(name)
    const base = path.basename(name, ext)
    let candidate = path.join(dir, name)
    let i = 1
    while (fs.existsSync(candidate)) {
      candidate = path.join(dir, `${base}_${i}${ext}`)
      i++
    }
    return candidate
  }
}

export { KEEP_FILES, KEEP_PREFIX }
