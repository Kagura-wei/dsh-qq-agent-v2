/**
 * 表情包资源包：校验、安装、卸载。
 *
 * 沿用 AstrBot 表情包协议，所以社区索引仓库里现成的包可以直接装：
 *   community-index.json → entries[].source = { type:'github', repo, ref, subpath }
 *   → GET https://codeload.github.com/<repo>/tar.gz/<ref>
 *   → 解 tar.gz → 定位 subpath → 只挑 manifest.json / memes/ 写进库。
 *
 * 只挑协议声明的文件：包里可能夹带脚本、大预览图、作者的本机数据，
 * 一并复制过来既浪费空间又是安全隐患。可移植内容之外的东西一律丢弃。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { untarGz } from './tar.js'
import { httpGet } from './net.js'
import { KEEP_FILES, KEEP_PREFIX, isSafeName } from './store.js'

/** 默认社区索引。可在设置里改，方便自建镜像。 */
export const DEFAULT_INDEX_URL =
  'https://raw.githubusercontent.com/anka-afk/astrbot-meme-pack-index/main/community-index.json'

/**
 * 下载体积上限。
 *
 * 实测社区包的仓库体积：示例包 5.8MB、官方1号 67MB、ATRI 304MB、蓝色大肥鱼 460MB
 * —— 表情包本来就是"几百张图"的体量，上限给小了会在解压前就被拒。
 */
const MAX_DOWNLOAD = 600 * 1024 * 1024

/** 单个包的下载总时长上限。大包 + 慢网络下十几分钟是常态，不能卡死在默认值上。 */
const DOWNLOAD_DEADLINE_MS = 30 * 60 * 1000

/**
 * 校验并归一化 manifest。
 * @returns {{id: string, name: string, version: string, description: string, categories: object}}
 */
export function validateManifest(data, fallbackId = '') {
  if (!data || typeof data !== 'object') throw new Error('manifest 不是对象')
  const id = String(data.id ?? fallbackId ?? '').trim()
  if (!isSafeName(id)) {
    // 模板仓库里常见原样留着占位符的 id，报错时把原值带上，一眼能看出是哪种问题
    throw new Error(
      `manifest.id 不可用（读到「${id || '(空)'}」）：只能用小写字母/数字/._-，长度 1-64，不能含斜杠`
    )
  }

  const categories = {}
  for (const [name, meta] of Object.entries(data.categories ?? {})) {
    if (!isSafeName(name)) continue
    categories[name] = {
      description: String(meta?.description ?? (typeof meta === 'string' ? meta : '')).trim(),
    }
  }
  if (!Object.keys(categories).length) throw new Error('manifest.categories 为空')

  return {
    id,
    name: String(data.name ?? id).trim() || id,
    version: String(data.version ?? '').trim() || '-',
    description: String(data.description ?? '').trim(),
    categories,
  }
}

/** subpath 归一化：必须留在包内，不许 `..`。 */
function safeSubpath(raw) {
  const value = String(raw ?? '.').trim().replace(/^\/+|\/+$/g, '')
  if (!value || value === '.') return ''
  if (value.split('/').includes('..') || value.includes('\\')) throw new Error(`subpath 非法：${raw}`)
  return value
}

/**
 * 把一串"包内文件"落成库里的一个包。
 * @returns {{manifest: object, files: number, bytes: number}}
 */
async function writePack(packsRoot, manifest, entries, { replace = true } = {}) {
  const packDir = path.join(packsRoot, manifest.id)
  if ((await exists(path.join(packDir, 'manifest.json'))) && !replace) {
    throw new Error(`表情包已存在：${manifest.id}`)
  }
  await fsp.rm(packDir, { recursive: true, force: true })
  await fsp.mkdir(path.join(packDir, 'memes'), { recursive: true })

  let files = 0
  let bytes = 0
  for (const entry of entries) {
    const rel = entry.name
    if (!KEEP_FILES.has(rel) && !KEEP_PREFIX.some((prefix) => rel.startsWith(prefix))) continue
    if (rel.split('/').includes('..')) continue
    const target = path.join(packDir, rel)
    if (!target.startsWith(packDir + path.sep)) continue
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, entry.data)
    files++
    bytes += entry.data.length
  }

  // 以校验过的 manifest 覆盖包内那份：顺手统一 BOM / 缩进 / 非法分类名
  await fsp.writeFile(
    path.join(packDir, 'manifest.json'),
    JSON.stringify({ schema_version: 1, ...manifest }, null, 2),
    'utf8'
  )

  return { manifest, files, bytes }
}

async function exists(target) {
  try {
    await fsp.stat(target)
    return true
  } catch {
    return false
  }
}

/** 从本地目录安装（用户手动 scp 上来的包，或管理页填的服务器路径）。 */
export async function installFromDir(srcRoot, packsRoot, options = {}) {
  const root = path.resolve(srcRoot)
  const raw = JSON.parse((await fsp.readFile(path.join(root, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, ''))
  const manifest = validateManifest(raw, path.basename(root))
  const entries = await walk(root)
  return writePack(packsRoot, manifest, entries, options)
}

/** 递归读目录成 { name（相对路径）, data }。 */
async function walk(root, prefix = '') {
  const out = []
  for (const entry of await fsp.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...(await walk(root, rel)))
    } else if (entry.isFile()) {
      out.push({ name: rel, data: await fsp.readFile(path.join(root, rel)) })
    }
  }
  return out
}

/** 下载 URL → Buffer，带体积上限与超时（走 net.js 的代理感知实现）。 */
async function download(url, { timeoutMs = 60000, proxy = '', deadlineMs = DOWNLOAD_DEADLINE_MS } = {}) {
  return httpGet(url, { timeoutMs, proxy, maxBytes: MAX_DOWNLOAD, deadlineMs })
}

/** 从 GitHub 仓库安装（走 codeload tar.gz，不需要 API token）。 */
export async function installFromGithub(source, packsRoot, options = {}) {
  const repo = String(source.repo ?? '').trim()
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`repo 格式应为 owner/repo：${repo}`)
  const ref = String(source.ref ?? 'main').trim() || 'main'
  const subpath = safeSubpath(source.subpath)

  const url = `https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(ref)}`
  const buffer = await download(url, options)
  const files = untarGz(buffer)

  // codeload 的 tar 顶层固定是 `<repo>-<ref>/`，剥掉一层再对 subpath
  const stripped = files
    .map((file) => {
      const cut = file.name.indexOf('/')
      return cut === -1 ? null : { name: file.name.slice(cut + 1), data: file.data }
    })
    .filter(Boolean)

  const scoped = subpath
    ? stripped
        .filter((file) => file.name === subpath || file.name.startsWith(subpath + '/'))
        .map((file) => ({ name: file.name === subpath ? '' : file.name.slice(subpath.length + 1), data: file.data }))
        .filter((file) => file.name)
    : stripped

  const manifestFile = scoped.find((file) => file.name === 'manifest.json')
  if (!manifestFile) throw new Error(`包里没有 manifest.json（repo=${repo} ref=${ref} subpath=${subpath || '.'}）`)
  const manifest = validateManifest(
    JSON.parse(manifestFile.data.toString('utf8').replace(/^\uFEFF/, '')),
    repo.split('/')[1]
  )
  return writePack(packsRoot, manifest, scoped, options)
}

/**
 * 解析用户填的来源。
 *
 * 支持四种写法，管理页一个输入框全吃掉：
 *   - 表情包 id（来自社区索引，例如 official-001）
 *   - owner/repo
 *   - owner/repo#ref@subpath
 *   - 完整 URL（github.com 页面 / codeload tar.gz / 索引 json 里的 source 对象）
 */
export function resolveSource(input, { indexEntries = [] } = {}) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('来源为空')

  const byId = indexEntries.find((entry) => entry.id === raw)
  if (byId) return { kind: 'github', source: byId.source, name: byId.name }

  const shorthand = raw.match(/^([\w.-]+\/[\w.-]+)(?:#([^@\s]+))?(?:@(.+))?$/)
  if (shorthand && !raw.includes('://')) {
    return {
      kind: 'github',
      source: { type: 'github', repo: shorthand[1], ref: shorthand[2] || 'main', subpath: shorthand[3] || '.' },
    }
  }

  if (!raw.includes('://')) return { kind: 'dir', path: raw }

  const url = new URL(raw)
  if (url.hostname.endsWith('github.com')) {
    const parts = url.pathname.replace(/^\/+/, '').split('/')
    const repo = `${parts[0]}/${parts[1]}`
    let ref = 'main'
    let subpath = '.'
    if (parts[2] === 'tree' && parts[3]) {
      ref = parts[3]
      subpath = parts.slice(4).join('/') || '.'
    }
    return { kind: 'github', source: { type: 'github', repo, ref, subpath } }
  }
  if (url.hostname.endsWith('codeload.github.com')) {
    const parts = url.pathname.replace(/^\/+/, '').split('/')
    return { kind: 'github', source: { type: 'github', repo: `${parts[0]}/${parts[1]}`, ref: parts[3] ?? 'main', subpath: '.' } }
  }
  return { kind: 'url', url: raw }
}

/**
 * 从 raw.githubusercontent 的 URL 反推仓库位置。
 *
 * 用途：`raw.githubusercontent.com` 在很多网络下直接不可达（实测本机走代理
 * 也是 000），而 `codeload.github.com` 通。于是索引拉取失败时改成"下载索引
 * 仓库的 tarball 再从里面读文件"——慢一点，但能通。
 */
function rawToRepo(url) {
  const hit = String(url ?? '').match(
    /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/
  )
  if (!hit) return null
  return { repo: `${hit[1]}/${hit[2]}`, ref: hit[3], file: hit[4] }
}

/** 下载仓库 tarball 并取出其中一个文件。 */
async function readFileFromRepo({ repo, ref, file }, options) {
  const buffer = await download(`https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(ref)}`, options)
  const wanted = file.replace(/^\/+/, '')
  for (const entry of untarGz(buffer)) {
    const cut = entry.name.indexOf('/')
    if (cut === -1) continue
    if (entry.name.slice(cut + 1) === wanted) return entry.data
  }
  throw new Error(`仓库 ${repo}@${ref} 里没有 ${wanted}`)
}

/**
 * 拉社区索引。两级兜底，全失败返回空数组（管理页仍可手填 owner/repo 安装）。
 */
export async function loadCommunityIndex(url = DEFAULT_INDEX_URL, { proxy = '', logger } = {}) {
  try {
    const buffer = await download(url, { proxy, timeoutMs: 30000, deadlineMs: 90000 })
    const packs = parseIndex(buffer)
    if (packs.length) return packs
  } catch (error) {
    logger?.warn?.(`拉取索引失败（${error?.message ?? error}），尝试回退通道`)
  }

  const repo = rawToRepo(url)
  if (repo) {
    try {
      const buffer = await readFileFromRepo(repo, { proxy, timeoutMs: 30000, deadlineMs: 90000 })
      const packs = parseIndex(buffer)
      if (packs.length) return packs
    } catch (error) {
      logger?.warn?.(`回退通道也失败（${error?.message ?? error}）`)
    }
  }

  logger?.warn?.('表情包索引不可用，可在管理页手填 owner/repo 安装')
  return []
}

function parseIndex(buffer) {
  const data = JSON.parse(buffer.toString('utf8'))
  const packs = Array.isArray(data?.packs) ? data.packs : []
  return packs.filter((entry) => entry?.id && entry?.source)
}
