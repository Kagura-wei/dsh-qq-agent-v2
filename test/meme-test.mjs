/**
 * 表情包（lib/meme/*）单测。
 *
 * 锁住的行为：
 *   - 标记 `&&键&&` **一律**从出站文本剥离（含不认识/空/畸形写法），只有命中
 *     分类表的才产生 picks —— 协议泄漏到群里是不可接受的；
 *   - 库按 AstrBot 协议扫描（多包同名分类合并成池）、随机取图、体积超限拒发；
 *   - tar 解包与本地目录安装；
 *   - 分类表进提示词前已打散 `{{`（否则 DSH 装配阶段会抛错打断整轮）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { stripMemeTags, limitPicks } from '../lib/meme/parse.js'
import { buildMemePrompt } from '../lib/meme/prompt.js'
import { MemeStore, isSafeName } from '../lib/meme/store.js'
import { MemeWeb } from '../lib/meme/web.js'
import { untarGz } from '../lib/meme/tar.js'
import { installFromDir, resolveSource, validateManifest } from '../lib/meme/pack.js'

const logger = { info() {}, warn() {}, error() {} }
let passed = 0
function check(label, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${label}`)
  } catch (error) {
    console.error(`  FAIL ${label}\n       ${error.message}`)
    process.exitCode = 1
  }
}
async function checkAsync(label, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${label}`)
  } catch (error) {
    console.error(`  FAIL ${label}\n       ${error.stack ?? error.message}`)
    process.exitCode = 1
  }
}

// ────────────────────────── tar 构造（只为测试解包） ──────────────────────────

function tarHeader(name, size) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii')
  header.write('        ', 148, 8, 'ascii') // 校验位先填空格
  header.write('0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

/** 用给定文件造一个 tar.gz。 */
function makeTarGz(entries) {
  const blocks = []
  for (const { name, body } of entries) {
    const data = Buffer.from(body)
    blocks.push(tarHeader(name, data.length), data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

// ────────────────────────── 解析 ──────────────────────────

console.log('parse:')
check('命中的标记生成 picks 并从正文剥离', () => {
  const r = stripMemeTags('先缓一缓，我在。\n&&happy&&', ['happy', 'sad'])
  assert.equal(r.text, '先缓一缓，我在。')
  assert.deepEqual(r.picks, ['happy'])
})

check('整行只有标记 → 整行丢弃（不留空行）', () => {
  const r = stripMemeTags('好耶\n&&happy&&\n\n', ['happy'])
  assert.equal(r.text, '好耶')
})

check('行内标记 → 只摘标记，保留同行正文', () => {
  const r = stripMemeTags('嗯嗯 &&shy&& 别夸了', ['shy'])
  assert.equal(r.text, '嗯嗯 别夸了')
  assert.deepEqual(r.picks, ['shy'])
})

check('不认识的键：剥离但不发图，记进 invalid', () => {
  const r = stripMemeTags('哈哈\n&&nonexistent&&', ['happy'])
  assert.equal(r.text, '哈哈')
  assert.deepEqual(r.picks, [])
  assert.deepEqual(r.invalid, ['nonexistent'])
})

check('空标记 &&&& 也剥离', () => {
  const r = stripMemeTags('文字&&&&', ['happy'])
  assert.equal(r.text, '文字')
})

check('重复标记去重，保持出现顺序', () => {
  const r = stripMemeTags('&&sad&&\n&&happy&&\n&&sad&&', ['sad', 'happy'])
  assert.deepEqual(r.picks, ['sad', 'happy'])
})

check('大小写与空格归一化', () => {
  const r = stripMemeTags('&& HAPPY &&', ['happy'])
  assert.deepEqual(r.picks, ['happy'])
})

check('纯标记回复 → 正文为空', () => {
  const r = stripMemeTags('&&happy&&', ['happy'])
  assert.equal(r.text, '')
  assert.deepEqual(r.picks, ['happy'])
})

check('无标记时正文原样（含空行）', () => {
  const body = '第一段\n\n第二段'
  assert.equal(stripMemeTags(body, ['happy']).text, body)
})

check('limitPicks 截断 / 关闭', () => {
  assert.deepEqual(limitPicks(['a', 'b', 'c'], 2), ['a', 'b'])
  assert.deepEqual(limitPicks(['a'], 0), [])
  assert.deepEqual(limitPicks(['a'], undefined), [])
})

// ────────────────────────── 提示词 ──────────────────────────

console.log('prompt:')
check('空分类不注入', () => {
  assert.equal(buildMemePrompt([], {}), '')
})

check('分类表包含键与用途，并交代写法', () => {
  const text = buildMemePrompt([{ key: 'happy', desc: '庆祝、开心' }], { maxPerReply: 1 })
  assert.match(text, /happy - 庆祝、开心/)
  assert.match(text, /&&分类键&&/)
  assert.match(text, /最多 1 张/)
})

check('分类描述里的 {{ 被打散（防插值抛错）', () => {
  const text = buildMemePrompt([{ key: 'x', desc: '含 {{model}} 的说明' }], {})
  assert.ok(!text.includes('{{'), '仍含 {{')
})

check('超长描述被截断', () => {
  const text = buildMemePrompt([{ key: 'x', desc: '啊'.repeat(200) }], {})
  assert.ok(text.length < 400)
})

// ────────────────────────── 库 ──────────────────────────

console.log('store:')
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'meme-test-'))
const packsRoot = path.join(tmp, 'packs')
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

async function makePackIn(root, id, name, categories, images) {
  const dir = path.join(root, id)
  await fsp.mkdir(path.join(dir, 'memes'), { recursive: true })
  await fsp.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ schema_version: 1, id, name, version: '1.0.0', categories })
  )
  for (const [cat, files] of Object.entries(images)) {
    await fsp.mkdir(path.join(dir, 'memes', cat), { recursive: true })
    for (const file of files) {
      await fsp.writeFile(path.join(dir, 'memes', cat, file), PNG)
    }
  }
  return dir
}

const makePack = (id, name, categories, images) => makePackIn(packsRoot, id, name, categories, images)

await makePack('p1', '包一', { happy: { description: '开心' }, sad: { description: '难过' } }, {
  happy: ['a.png', 'b.png'],
  sad: ['c.gif'],
})
await makePack('p2', '包二', { happy: { description: '' } }, { happy: ['d.jpg'] })

const store = new MemeStore({ getConfig: () => ({}), logger, dir: tmp })
await checkAsync('init 扫描出两个包的合并分类池', async () => {
  await store.init()
  assert.deepEqual(store.keys().sort(), ['happy', 'sad'])
  const happy = store.categories().find((c) => c.key === 'happy')
  assert.equal(happy.count, 3, '同名分类应合并')
  assert.equal(happy.desc, '开心')
  assert.equal(store.detail().total, 4)
})

await checkAsync('pick 命中分类返回文件，未知分类返回 null', async () => {
  const hit = store.pick('happy')
  assert.ok(hit, 'happy 有图，不该返回 null')
  assert.ok(['.png', '.jpg'].includes(path.extname(hit.path)), `意外的扩展名 ${hit.path}`)
  assert.equal(store.pick('nope'), null)
})

await checkAsync('read 校验类型与体积，超限拒发', async () => {
  const hit = await store.read('sad', {})
  assert.equal(hit.mime, 'image/gif')
  assert.ok(hit.buffer.length > 0)
  const big = await store.read('sad', { memeMaxImageBytes: 1 })
  assert.equal(big, null, '超限应跳过')
})

await checkAsync('rescan 内容未变时 hash 不变（避免会话反复重建）', async () => {
  const rev = store.detail().revision
  const changed = await store.rescan()
  assert.equal(changed, false)
  assert.equal(store.detail().revision, rev)
})

await checkAsync('addImage 落盘并刷新；重名自动加序号', async () => {
  const first = await store.addImage('p1', 'happy', 'new.png', PNG)
  const second = await store.addImage('p1', 'happy', 'new.png', PNG)
  assert.equal(first, 'new.png')
  assert.equal(second, 'new_1.png')
  assert.equal(store.categories().find((c) => c.key === 'happy').count, 5)
})

await checkAsync('addImage 拒绝非法分类名与格式', async () => {
  await assert.rejects(() => store.addImage('p1', '../evil', 'x.png', PNG), /分类名非法/)
  await assert.rejects(() => store.addImage('p1', 'happy', 'x.txt', PNG), /不支持的图片格式/)
})

await checkAsync('removeCategory 连目录带图一起删', async () => {
  await store.removeCategory('p1', 'sad')
  assert.deepEqual(store.keys(), ['happy'])
  assert.equal(fs.existsSync(path.join(packsRoot, 'p1', 'memes', 'sad')), false)
})

await checkAsync('removePack 删整包', async () => {
  await store.removePack('p2')
  assert.deepEqual(store.detail().packs.map((p) => p.id), ['p1'])
})

check('isSafeName 挡住路径穿越', () => {
  assert.equal(isSafeName('happy'), true)
  assert.equal(isSafeName('..'), false)
  assert.equal(isSafeName('a/b'), false)
  assert.equal(isSafeName(''), false)
})

// ────────────────────────── 资源包 ──────────────────────────

console.log('pack:')
check('validateManifest 拒绝无分类 / 非法 id', () => {
  assert.throws(() => validateManifest({ id: 'x', categories: {} }), /categories/)
  assert.throws(() => validateManifest({ id: '../x', categories: { a: {} } }), /manifest\.id 不可用/)
})

check('validateManifest 兼容字符串形式的分类描述', () => {
  const m = validateManifest({ id: 'x', categories: { happy: '开心' } })
  assert.equal(m.categories.happy.description, '开心')
})

await checkAsync('untarGz 解出文件与内容', async () => {
  const gz = makeTarGz([
    { name: 'repo-main/manifest.json', body: '{"id":"p"}' },
    { name: 'repo-main/memes/happy/a.png', body: PNG },
  ])
  const files = untarGz(gz)
  assert.equal(files.length, 2)
  assert.equal(files[0].name, 'repo-main/manifest.json')
  assert.equal(files[1].data.length, PNG.length)
})

const srcDir = path.join(tmp, 'src', 'mypack')
await checkAsync('installFromDir 只复制协议内容（丢脚本/预览大图）', async () => {
  await fsp.mkdir(path.join(srcDir, 'memes', 'happy'), { recursive: true })
  await fsp.writeFile(
    path.join(srcDir, 'manifest.json'),
    JSON.stringify({ id: 'from-dir', name: '本地包', version: '2.0.0', categories: { happy: { description: '开心' } } })
  )
  await fsp.writeFile(path.join(srcDir, 'memes', 'happy', 'x.png'), PNG)
  await fsp.writeFile(path.join(srcDir, 'evil.sh'), 'rm -rf /')
  await fsp.writeFile(path.join(srcDir, 'README.md'), '# hi')

  const result = await installFromDir(srcDir, packsRoot)
  assert.equal(result.manifest.id, 'from-dir')
  const dir = path.join(packsRoot, 'from-dir')
  assert.equal(fs.existsSync(path.join(dir, 'memes', 'happy', 'x.png')), true)
  assert.equal(fs.existsSync(path.join(dir, 'evil.sh')), false, '包外文件不该被装进来')
  assert.equal(fs.existsSync(path.join(dir, 'README.md')), false)
})

await checkAsync('安装后库能立刻扫到新包', async () => {
  await store.rescan({ force: true })
  assert.ok(store.detail().packs.some((p) => p.id === 'from-dir'))
})

check('resolveSource 解析四种写法', () => {
  assert.equal(resolveSource('anka-afk/astrbot-meme-pack-official-01').source.repo, 'anka-afk/astrbot-meme-pack-official-01')
  assert.equal(resolveSource('a/b#v1.0.0@sub').source.ref, 'v1.0.0')
  assert.equal(resolveSource('a/b#v1.0.0@sub').source.subpath, 'sub')
  assert.equal(resolveSource('https://github.com/a/b/tree/dev/packs/x').source.subpath, 'packs/x')
  assert.equal(resolveSource('/tmp/some-pack').kind, 'dir')
})

await checkAsync('resolveSource 命中索引 id', async () => {
  const hit = await resolveSource('official-001', {
    indexEntries: [{ id: 'official-001', name: '官方1号', source: { type: 'github', repo: 'a/b', ref: 'main', subpath: '.' } }],
  })
  assert.equal(hit.kind, 'github')
  assert.equal(hit.source.repo, 'a/b')
})

// ────────────────────────── 管理界面（HTTP） ──────────────────────────

console.log('web:')
// 单独一套库，避免跟上面的用例互相干扰；复用 p1 的造包函数
const webDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'meme-web-'))
const webCfg = { memeWebEnabled: true, memeWebHost: '127.0.0.1', memeWebPort: 13398, memeWebToken: '' }
await makePackIn(path.join(webDir, 'packs'), 'p1', '包一', { happy: { description: '开心' } }, { happy: ['a.png'] })
const webStore = new MemeStore({ getConfig: () => webCfg, logger, dir: webDir })
await webStore.init()
const web = new MemeWeb({ store: webStore, getConfig: () => webCfg, logger })
try {
  await web.start()
} catch (error) {
  console.error(`  FAIL 管理界面起不来：${error.message}`)
  process.exitCode = 1
}
const base = `http://127.0.0.1:${webCfg.memeWebPort}`
const token = web.token

async function call(pathname, options = {}) {
  const res = await fetch(`${base}${pathname}`, options)
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body, res }
}

await checkAsync('页面本身可无 token 打开（数据接口才要令牌）', async () => {
  const res = await fetch(`${base}/`)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.match(html, /表情包管理/)
})

await checkAsync('缺 token / 错 token 一律 401', async () => {
  assert.equal((await call('/api/state')).status, 401)
  assert.equal((await call('/api/state?token=wrong')).status, 401)
})

await checkAsync('带 token 拿到库状态', async () => {
  const { status, body } = await call(`/api/state?token=${token}`)
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.ok(body.total > 0, '库里应已有图片')
})

await checkAsync('上传图片（原始字节）后立即可见', async () => {
  const before = (await call(`/api/state?token=${token}`)).body
  const res = await fetch(`${base}/api/upload?token=${token}&pack=p1&cat=happy&name=up.png`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: PNG,
  })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)
  const after = (await call(`/api/state?token=${token}`)).body
  assert.equal(after.total, before.total + 1)
})

await checkAsync('拒绝非图片扩展名', async () => {
  const res = await fetch(`${base}/api/upload?token=${token}&pack=p1&cat=happy&name=x.txt`, {
    method: 'POST',
    body: PNG,
  })
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.match(body.error, /只接受图片/)
})

await checkAsync('图片读取接口按 pack/cat/name 取字节', async () => {
  const res = await fetch(`${base}/img?token=${token}&pack=p1&cat=happy&name=a.png`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.equal((await res.arrayBuffer()).byteLength, PNG.length)
})

await checkAsync('路径穿越被拒（不许读库外文件）', async () => {
  const { status, body } = await call(
    `/img?token=${token}&pack=p1&cat=..&name=${encodeURIComponent('../../../etc/passwd')}`
  )
  assert.ok(status === 400 || status === 404, `应被拒，实际 ${status}`)
  assert.equal(body.ok, false)
})

await checkAsync('新建分类 → 出现在状态里', async () => {
  const res = await fetch(`${base}/api/category?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'create', pack: 'p1', cat: 'sleepy', desc: '困了' }),
  })
  assert.equal((await res.json()).ok, true)
  const state = (await call(`/api/state?token=${token}`)).body
  const cat = state.categories.find((c) => c.key === 'sleepy')
  assert.ok(cat, '新分类应存在')
  assert.equal(cat.desc, '困了')
})

await checkAsync('抽一张：返回真实图片信息（不含字节）', async () => {
  const res = await fetch(`${base}/api/random?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'happy' }),
  })
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.ok(body.pick.name)
  assert.ok(body.pick.bytes > 0)
  assert.equal(body.pick.buffer, undefined, '不该把图片字节塞进 JSON')
})

await checkAsync('删除图片', async () => {
  const res = await fetch(`${base}/api/delete-image?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pack: 'p1', cat: 'happy', name: 'up.png' }),
  })
  assert.equal((await res.json()).ok, true)
  const state = (await call(`/api/state?token=${token}`)).body
  const happy = state.categories.find((c) => c.key === 'happy')
  assert.ok(!happy.images.some((i) => i.name === 'up.png'))
})

await checkAsync('安装本地目录（管理页"手填来源"那条路）', async () => {
  const res = await fetch(`${base}/api/install?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: srcDir }),
  })
  const body = await res.json()
  assert.equal(body.ok, true, body.error)
  assert.equal(body.pack, 'from-dir')
})

await checkAsync('移除包', async () => {
  const res = await fetch(`${base}/api/remove-pack?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'from-dir' }),
  })
  assert.equal((await res.json()).ok, true)
  const state = (await call(`/api/state?token=${token}`)).body
  assert.ok(!state.packs.some((p) => p.id === 'from-dir'))
})

check('token 落盘，重启后不变（链接不会失效）', () => {
  assert.equal(fs.existsSync(path.join(webDir, '.web-token')), true)
  assert.equal(fs.readFileSync(path.join(webDir, '.web-token'), 'utf8').trim(), token)
})

await web.stop()

await fsp.rm(tmp, { recursive: true, force: true })
await fsp.rm(webDir, { recursive: true, force: true })
console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : ''}`)
