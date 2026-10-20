/**
 * 长图切段（lib/image.js 的 planSlices / toImageAttachments）。
 *
 * 背景：宿主的附件服务在解码前先量尺寸，单边超过 8192 就整张拒收
 * （`Image exceeds the configured per-side pixel limit.`），长截图必然撞上。
 * 这里锁住的行为是：**不超限的图一个字节都不动**，超限的图沿长边切段、宽度保持。
 */
import assert from 'node:assert/strict'
import { planSlices, toImageAttachments } from '../lib/image.js'

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
    console.error(`  FAIL ${label}\n       ${error.message}`)
    process.exitCode = 1
  }
}

// ── 假 sharp：只记录被要求做了什么，不真的处理像素 ──
function makeFakeSharp(meta, log = []) {
  return () => {
    const api = {
      metadata: async () => meta,
      extract(region) {
        log.push(['extract', region])
        return api
      },
      flatten() {
        log.push(['flatten'])
        return api
      },
      resize(w, h) {
        log.push(['resize', w, h])
        return api
      },
      jpeg() {
        log.push(['jpeg'])
        return api
      },
      toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    }
    return api
  }
}

/** 8 字节的"PNG 魔数"够 image.js 认出类型，不会真去解码。 */
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).toString('base64')
const seg = () => ({ type: 'image', data: { file: `base64://${PNG_B64}`, url: '' } })

console.log('planSlices')
check('普通图（800×600）不用动', () => {
  assert.equal(planSlices(800, 600), undefined)
})
check('正好卡在单边上限上的图不用动', () => {
  assert.equal(planSlices(690, 8192), undefined)
})
check('只是超过"原样存储"额度（4M 像素）也不切 —— 宿主会自己缩', () => {
  assert.equal(planSlices(2048, 2048), undefined)
  assert.equal(planSlices(3000, 1400), undefined, '4.2M 像素，宿主自己会缩，切段只会白花 token')
})
check('长截图（690×12115）切 2 段，宽度保持', () => {
  const plan = planSlices(690, 12115)
  assert.equal(plan.vertical, true)
  assert.equal(plan.parts, 2)
  assert.equal(plan.sliceLen, 6058)
})
check('宽幅长图（12000×200）沿横向切', () => {
  const plan = planSlices(12000, 200)
  assert.equal(plan.vertical, false)
  assert.equal(plan.parts, 2)
  assert.equal(plan.sliceLen, 6000)
})
check('maxParts 卡住时每段变长（而不是少切一块丢掉）', () => {
  const plan = planSlices(690, 40000, { maxParts: 2 })
  assert.equal(plan.parts, 2)
  assert.equal(plan.sliceLen, 20000)
  assert.equal(plan.parts * plan.sliceLen >= 40000, true, '必须覆盖整张图')
})
check('maxParts=1 时只有一段（等于"整体缩小"模式）', () => {
  const plan = planSlices(690, 12115, { maxParts: 1 })
  assert.equal(plan.parts, 1)
  assert.equal(plan.sliceLen, 12115)
})
check('尺寸不合法时不规划', () => {
  assert.equal(planSlices(0, 100), undefined)
  assert.equal(planSlices(NaN, 100), undefined)
})

console.log('toImageAttachments')
await checkAsync('普通图：原样返回一张，不碰 sharp 的 extract', async () => {
  const log = []
  const atts = await toImageAttachments(seg(), { logger, sharp: makeFakeSharp({ width: 800, height: 600 }, log) })
  assert.equal(atts.length, 1)
  assert.equal(atts[0].mediaType, 'image/png', '没超限就不该转码')
  assert.equal(log.some((entry) => entry[0] === 'extract'), false)
})

await checkAsync('长截图：切成 2 段 jpeg，名字带序号', async () => {
  const log = []
  const atts = await toImageAttachments(seg(), {
    logger,
    sharp: makeFakeSharp({ width: 690, height: 12115 }, log),
  })
  assert.equal(atts.length, 2)
  assert.deepEqual(
    atts.map((a) => a.mediaType),
    ['image/jpeg', 'image/jpeg']
  )
  assert.deepEqual(
    atts.map((a) => a.name),
    ['image-1.jpg', 'image-2.jpg']
  )
  const regions = log.filter((e) => e[0] === 'extract').map((e) => e[1])
  assert.deepEqual(regions, [
    { left: 0, top: 0, width: 690, height: 6058 },
    { left: 0, top: 6058, width: 690, height: 6057 },
  ])
  assert.equal(log.some((e) => e[0] === 'resize'), false, '正常切法下每段都在宿主额度内，不该再缩')
})

await checkAsync('maxParts=0：完全不处理，原样一张', async () => {
  const log = []
  const atts = await toImageAttachments(seg(), {
    logger,
    maxParts: 0,
    sharp: makeFakeSharp({ width: 690, height: 12115 }, log),
  })
  assert.equal(atts.length, 1)
  assert.equal(log.length, 0, '关掉了就一次都不该调 sharp')
})

await checkAsync('探测尺寸失败时原样送（交给宿主自己判断）', async () => {
  const badSharp = () => ({ metadata: async () => { throw new Error('unsupported') } })
  const atts = await toImageAttachments(seg(), { logger, sharp: badSharp })
  assert.equal(atts.length, 1)
  assert.equal(atts[0].mediaType, 'image/png')
})

await checkAsync('切片中途失败时不返回半截结果', async () => {
  let calls = 0
  const flaky = () => {
    const api = {
      metadata: async () => ({ width: 690, height: 12115 }),
      extract: () => api,
      flatten: () => api,
      resize: () => api,
      jpeg: () => api,
      toBuffer: async () => {
        calls++
        if (calls > 1) throw new Error('out of memory')
        return Buffer.from([0xff, 0xd8, 0xff, 0xd9])
      },
    }
    return api
  }
  const atts = await toImageAttachments(seg(), { logger, sharp: flaky })
  assert.equal(atts.length, 1, '切不出完整一套就退回原图，不能让模型看到半张')
  assert.equal(atts[0].mediaType, 'image/png', '退回的是原图，不是那个半截 jpeg')
})

await checkAsync('取不到字节时返回空数组', async () => {
  const atts = await toImageAttachments({ type: 'image', data: { url: '', file: 'nope.jpg' } }, { logger })
  assert.deepEqual(atts, [])
})

console.log(`\n${passed} 项通过`)
