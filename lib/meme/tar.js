/**
 * 极简 tar 解包（USTAR + GNU 长名）。
 *
 * 为什么手写：装表情包要能从 GitHub 直接拉包，而 codeload 给的是 tar.gz。
 * 为这一个用途装 tar-stream / node-tar 两个依赖不划算 —— 插件现在就只依赖 ws，
 * 保持"解压 tar 的代码 90 行、零依赖"比引一棵依赖树值得。
 *
 * 只支持解包，不支持打包；忽略 pax 扩展头与权限位，只关心 文件/目录/长名。
 */
import zlib from 'node:zlib'

/** 读 NUL 结尾的定长字符串。 */
function cstr(buffer, start, length) {
  const slice = buffer.subarray(start, start + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

/** 八进制字段。tar 用 '\0'/' ' 填充，空即 0。 */
function octal(buffer, start, length) {
  const raw = cstr(buffer, start, length).trim()
  if (!raw) return 0
  const value = parseInt(raw, 8)
  return Number.isFinite(value) ? value : 0
}

/**
 * 解 tar（已 gunzip 的裸 tar）。
 * @param {Buffer} buffer
 * @returns {Array<{name: string, data: Buffer}>} 只含普通文件
 */
export function untar(buffer) {
  const files = []
  let offset = 0
  let longName = ''

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break // 两个空块 = 结束

    const name = cstr(header, 0, 100)
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156] || 0x30)
    const prefix = cstr(header, 345, 155)

    const dataStart = offset + 512
    const payload = buffer.subarray(dataStart, dataStart + size)
    offset = dataStart + Math.ceil(size / 512) * 512

    if (type === 'L') {
      // GNU 长文件名：内容就是下一个条目的真名
      longName = payload.toString('utf8').replace(/\0.*$/s, '')
      continue
    }
    if (type === 'K' || type === 'x' || type === 'g' || type === '5') continue

    const full = longName || (prefix ? `${prefix}/${name}` : name)
    longName = ''
    if (type !== '0' && type !== '\0' && type !== '') continue
    files.push({ name: full.replace(/^\.\//, ''), data: Buffer.from(payload) })
  }

  return files
}

/**
 * 解 tar.gz。
 * @param {Buffer} buffer
 * @returns {Array<{name: string, data: Buffer}>}
 */
export function untarGz(buffer) {
  return untar(zlib.gunzipSync(buffer))
}
