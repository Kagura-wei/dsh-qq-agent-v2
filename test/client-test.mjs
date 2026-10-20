/**
 * 客户端半边冒烟测试（离线，不需要浏览器）。
 *
 * 覆盖：
 *   1. client.js 能被 __ModuleLoader__ 正常加载并返回 { inject, apply }
 *   2. apply 会向 'settings.section' 注册「群聊助手」条目
 *   3. 分区的 inject 能拿到 scope / settingsSchema / schemaRaw
 *   4. 组件能被 React 渲染成 HTML（用 react-dom/server）
 *   5. 表单能读出现有值、能识别"已覆盖"、能保存草稿
 *
 * 运行：node test/client-test.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

const require_ = createRequire(import.meta.url)

// react 只在本地测试时需要（线上由 DSH 客户端框架注入）。
// 装在别处时用 REACT_HOME 指过去；默认空 = 按模块名正常解析。
// 找不到就跳过 —— 这个测试不该成为别人 checkout 后的绊脚石。
const REACT_HOME = process.env.REACT_HOME ?? ''
let React
let renderToStaticMarkup
try {
  const load = (name) => (REACT_HOME ? require_(path.join(REACT_HOME, name)) : require_(name))
  React = load('react')
  renderToStaticMarkup = load('react-dom/server').renderToStaticMarkup
} catch {
  try {
    React = require_('react')
    renderToStaticMarkup = require_('react-dom/server').renderToStaticMarkup
  } catch {
    console.log('\n[客户端] 跳过：未安装 react/react-dom（设 REACT_HOME 或 npm i -D react react-dom）\n')
    process.exit(0)
  }
}

// ── 1. 搭一个最小 DOM 假环境，只为让模块加载期不炸 ──
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      loaded = entry
    },
  },
}

// ── 2. 用宿主真实的 Config schema，保证字段名与线上一致 ──
const { Config } = await import('../lib/index.js')

// ── 3. 加载客户端模块 ──
await import('../lib/client.js')

assert.ok(loaded, 'client.js 应该调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-qq-agent-v2')

// factory 的 require 由框架注入：react 用真货，其余给最小桩
const mod = loaded.factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return { render: () => {}, unmountComponentAtNode: () => {} }
  throw new Error(`未预期的依赖: ${name}`)
})

let passed = 0
function check(label, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${label}`)
  } catch (error) {
    console.error(`  FAIL ${label}: ${error.message}`)
    process.exitCode = 1
  }
}

console.log('\n[客户端] 模块导出')
check('导出 inject 数组', () => {
  assert.ok(Array.isArray(mod.inject))
  assert.ok(mod.inject.includes('slots'))
  assert.ok(mod.inject.includes('configForms'))
  // cordis 硬约束：没声明的服务一访问就抛，且错误发生在 inject 阶段，
  // 连错误边界都接不住 —— 表现为分区一片空白。这三个必须都在。
  assert.ok(mod.inject.includes('settingsSchema'), 'inject 里必须有 settingsSchema')
})
check('导出 apply 函数', () => assert.equal(typeof mod.apply, 'function'))

// ── 4. 假 ctx：记录 slots 注册，提供 configForms ──
const snapshot = {
  status: 'ready',
  value: { port: 6701, allowGroups: [10001], contextSliderPos: 100, logEvents: false },
  base: {},
  user: { allowGroups: [10001] }, // 标记为"已覆盖"
  revision: 3,
  writable: true,
  mode: 'host',
}

const writes = []
const scope = {
  getSnapshot: () => ({ ...snapshot, schemaRaw: undefined }),
  subscribe: () => () => {},
  set: async (field, value) => {
    writes.push([field, value])
  },
  unset: async () => {},
}

const registrations = []
const injected = []

/** 模拟 describe 面（镜像）：只有从这里能拿到 schema 信封。 */
let mirrorReady = false
let mirrorSubscriber = null
const mirrorFace = {
  getSnapshot: () => ({
    status: mirrorReady ? 'ready' : 'idle',
    view: mirrorReady ? { namespaces: [{ ns: 'dsh-qq-chat-agent', schema: Config.toJSON?.() ?? {} }] } : undefined,
  }),
  subscribe: (fn) => {
    mirrorSubscriber = fn
    return () => {
      mirrorSubscriber = null
    }
  },
}

const ctx = {
  slots: {
    inject: (name, fn) => {
      assert.equal(name, 'settings.section', '应该注入 settings.section 槽位')
      registrations.push({ name, dispose: fn() })
    },
    register: (options, component) => {
      injected.push({ options, component })
      return () => {}
    },
  },
  configForms: {
    get: (ns) => {
      assert.equal(ns, 'dsh-qq-chat-agent', '命名空间必须与宿主一致')
      return scope
    },
    describe: () => mirrorFace,
  },
  settingsSchema: {
    rehydrate: () => Config,
  },
}

console.log('\n[客户端] 分区注册')
mod.apply(ctx)

check('已向 settings.section 注入', () => assert.equal(registrations.length, 1))
check('inject 回调交回 disposer（不是 undefined）', () => {
  // 少了它，插件卸载时槽位注册无法注销
  assert.equal(typeof registrations[0].dispose, 'function', '应返回 register 的 disposer')
})
check('分区 id / order / label 正确', () => {
  assert.equal(injected.length, 1)
  assert.equal(injected[0].options.name, 'settings.section')
  assert.equal(injected[0].options.id, 'qq-agent')
  assert.equal(typeof injected[0].options.order, 'number')
  assert.equal(injected[0].options.label(), '群聊助手')
})
check('分区组件是函数组件', () => assert.equal(typeof injected[0].component, 'function'))

// cordis 对未声明服务的访问会抛，且发生在 inject 阶段（早于渲染），
// 错误边界接不住 —— 这正是分区白屏的成因。这里模拟该守卫，确认不崩。
console.log('\n[客户端] cordis 服务守卫')
check('settingsSchema 取不到时不中断注册', () => {
  const registered = []
  const guarded = {
    slots: {
      inject: (_name, fn) => {
        fn()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
    configForms: { get: () => scope, describe: () => mirrorFace },
    get settingsSchema() {
      throw new Error('cannot get property "settingsSchema" without inject')
    },
  }
  assert.doesNotThrow(() => mod.apply(guarded), 'apply 不应把异常抛出去')
  assert.equal(registered.length, 1, '仍应完成注册')
  assert.equal(registered[0].options.id, 'qq-agent')
})

// ── 5. 渲染 ──
const Section = injected[0].component
const props = injected[0].options.inject()

console.log('\n[客户端] 镜像未就绪时不自乱')
const htmlPending = renderToStaticMarkup(React.createElement(Section, props))
check('schema 还没到时显示等待文案（而不是空表单）', () =>
  assert.ok(htmlPending.includes('正在读取配置项定义'), `实际: ${htmlPending.slice(0, 200)}`)
)

// 镜像 ready：schema 到位，应渲染出完整表单
mirrorReady = true

console.log('\n[客户端] 渲染')
let html = ''
try {
  html = renderToStaticMarkup(React.createElement(Section, props))
} catch (error) {
  console.error('  渲染抛错:', error.message)
}

check('能渲染出 HTML 而不抛错', () => assert.ok(html.length > 0, 'HTML 不应为空'))
check('渲染出分区内容（含连接端口当前值）', () => {
  assert.ok(html.includes('6701'), `应含连接端口当前值，实际片段: ${html.slice(0, 300)}`)
})
check('渲染出多个分组标题', () => {
  for (const g of ['连接', '白名单', '人设']) {
    assert.ok(html.includes(g), `缺少分组「${g}」`)
  }
})
check('已覆盖字段带角标', () => assert.ok(html.includes('已覆盖'), 'allowGroups 应标记为已覆盖'))
check('渲染出保存按钮', () => assert.ok(html.includes('保存'), '应有保存按钮'))
check('渲染的字段覆盖 schema 全部字段', () => {
  const allNames = Config.dict ? Object.keys(Config.dict) : []
  assert.ok(allNames.length > 30, `schema 字段数应 > 30，实际 ${allNames.length}`)
  const missing = allNames.filter((name) => !html.includes(name))
  assert.equal(missing.length, 0, `以下字段未渲染: ${missing.join(', ')}`)
  console.log(`      （已覆盖 ${allNames.length} 个字段）`)
})

// ── 6. 只读与不可用态 ──
console.log('\n[客户端] 状态兜底')
check('只读时渲染只读提示', () => {
  const readOnlyScope = { ...scope, getSnapshot: () => ({ ...snapshot, writable: false }) }
  const readOnlyProps = { ...props, scope: readOnlyScope }
  const out = renderToStaticMarkup(React.createElement(Section, readOnlyProps))
  assert.ok(out.includes('只读'), '应提示只读')
})
check('loading 态渲染加载文案', () => {
  const loadingScope = { ...scope, getSnapshot: () => ({ status: 'loading' }) }
  const out = renderToStaticMarkup(
    React.createElement(Section, { ...props, scope: loadingScope })
  )
  assert.ok(out.includes('正在读取配置'), '应提示加载中')
})
check('unavailable 态提示去本机设置', () => {
  const naScope = { ...scope, getSnapshot: () => ({ status: 'unavailable' }) }
  const out = renderToStaticMarkup(React.createElement(Section, { ...props, scope: naScope }))
  assert.ok(out.includes('不可用'), '应提示不可用')
})
check('拿不到 scope 时显示诊断而不是白屏', () => {
  const out = renderToStaticMarkup(
    React.createElement(Section, { binder: props.binder, settingsSchema: props.settingsSchema })
  )
  assert.ok(out.includes('没拿到可用的 configForms'), `应显示诊断，实际: ${out.slice(0, 200)}`)
  assert.ok(out.includes('props 键'), '诊断里应列出实际收到的 props 键')
})
check('bind 失败时显示原因而不是白屏', () => {
  const out = renderToStaticMarkup(
    React.createElement(Section, { ...props, bindError: new Error('namespace not registered') })
  )
  assert.ok(out.includes('绑定设置命名空间失败'), '应显示绑定失败')
  assert.ok(out.includes('namespace not registered'), '应带上原始错误信息')
})

console.log('\n[客户端] 档位活说明（概率要跟 gate.js 的算法一致）')
{
  const renderWith = (over) => {
    const s = { ...scope, getSnapshot: () => ({ ...snapshot, value: { ...snapshot.value, ...over } }) }
    return renderToStaticMarkup(React.createElement(Section, { ...props, scope: s }))
  }

  check('档位 5：说明"只回应 @ 你"', () => {
    const out = renderWith({ contextSliderPos: 5, replyOnlyWhenMentioned: false })
    assert.ok(out.includes('只回应 @ 你'), `实际: ${out.slice(0, 400)}`)
  })
  check('档位 15：说明只回 @ 与关键词', () => {
    const out = renderWith({ contextSliderPos: 15, replyOnlyWhenMentioned: false })
    assert.ok(out.includes('@ 与关键词命中'), '应说明关键词档')
  })
  check('档位 30：算出 14.3% 概率', () => {
    // (30-20)/70 = 14.2857% -> 14.3%
    const out = renderWith({ contextSliderPos: 30, replyOnlyWhenMentioned: false })
    assert.ok(out.includes('14.3%'), `应显示 14.3%，实际: ${out.slice(0, 500)}`)
  })
  check('档位 50：算出 42.9% 概率', () => {
    const out = renderWith({ contextSliderPos: 50, replyOnlyWhenMentioned: false })
    assert.ok(out.includes('42.9%'), '应显示 42.9%')
  })
  check('档位 90：算出 100.0% 概率', () => {
    const out = renderWith({ contextSliderPos: 90, replyOnlyWhenMentioned: false })
    assert.ok(out.includes('100.0%'), '应显示 100.0%')
  })
  check('档位 100：说明为全响应', () => {
    const out = renderWith({ contextSliderPos: 100, replyOnlyWhenMentioned: false })
    assert.ok(out.includes('每条消息都会回应'), '应说明全响应')
  })
  check('开启"仅在 @ 时响应"时给出联动提醒', () => {
    const out = renderWith({ contextSliderPos: 50, replyOnlyWhenMentioned: true })
    assert.ok(out.includes('「仅在 @ 时响应」已开启'), '应提醒档位此时不生效于群聊非 @')
  })
  check('没配关键词时点出这一点', () => {
    const out = renderWith({ contextSliderPos: 50, keywords: [], replyOnlyWhenMentioned: false })
    assert.ok(out.includes('没有配关键词'), '应提示关键词为空')
  })
  check('配了关键词时把它列出来', () => {
    const out = renderWith({ contextSliderPos: 50, keywords: ['阿蓝', '小鲸鱼'], replyOnlyWhenMentioned: false })
    assert.ok(out.includes('阿蓝、小鲸鱼'), '应列出关键词')
  })

  check('档位 100 + 判定开启：明说跟进判定不会被调用', () => {
    const out = renderWith({
      contextSliderPos: 100,
      judgeEnabled: true,
      judgeFollowUpMin: 10,
      replyOnlyWhenMentioned: false,
    })
    assert.ok(out.includes('跟进判定不会被调用'), `实际: ${out.slice(0, 400)}`)
    assert.ok(out.includes('没有需要判定的消息'), '开关说明也应点出这一档没有可判的消息')
  })
  check('档位 21–90 + 判定开启：概率照旧，另说跟进期', () => {
    const out = renderWith({
      contextSliderPos: 50,
      judgeEnabled: true,
      judgeFollowUpMin: 10,
      keywords: ['阿蓝'],
      replyOnlyWhenMentioned: false,
    })
    assert.ok(out.includes('42.9%'), '几率是独立触发方式，概率要照旧显示')
    assert.ok(out.includes('回完话后的 10 分钟内'), `实际: ${out.slice(0, 400)}`)
  })
  check('档位 ≤20 + 判定开启：窗口期照样跟进', () => {
    const out = renderWith({
      contextSliderPos: 15,
      judgeEnabled: true,
      judgeFollowUpMin: 10,
      replyOnlyWhenMentioned: false,
    })
    assert.ok(out.includes('只回应 @ 与关键词命中的消息'), '基本口径不变')
    assert.ok(out.includes('接着聊的相关消息也会接'), '但也该说明窗口期能跟进')
  })
  check('判定关闭时仍显示随机概率', () => {
    const out = renderWith({ contextSliderPos: 50, judgeEnabled: false, replyOnlyWhenMentioned: false })
    assert.ok(out.includes('42.9%'), '关闭判定应回到概率口径')
    assert.ok(out.includes('不再跟进话题'), '并说明不再跟进')
  })
  check('跟进期 0 分钟：说明判定不会被调用', () => {
    const out = renderWith({ contextSliderPos: 50, judgeEnabled: true, judgeFollowUpMin: 0 })
    assert.ok(out.includes('关闭跟进'), `实际: ${out.slice(0, 400)}`)
    assert.ok(out.includes('判定一次都不会被调用'), '开关说明要点出判定不会被调用')
  })
  check('跟进期 0 分钟 + 常开接话开着 → 不再说判定不会运行', () => {
    const out = renderWith({
      contextSliderPos: 50,
      judgeEnabled: true,
      judgeFollowUpMin: 0,
      judgeAlwaysOn: true,
    })
    assert.ok(out.includes('常开接话'), `实际: ${out.slice(0, 600)}`)
    assert.equal(out.includes('判定一次都不会被调用'), false, '常开开着时判定照样跑')
  })
  check('常开接话：说明它不受窗口限制，并带出限额', () => {
    const out = renderWith({
      contextSliderPos: 50,
      judgeEnabled: true,
      judgeFollowUpMin: 10,
      judgeAlwaysOn: true,
      judgeProactivePerHour: 6,
    })
    assert.ok(out.includes('不再受跟进期限制'), `实际: ${out.slice(0, 700)}`)
    assert.ok(out.includes('每小时最多 6 次'), '应带出每小时限额')
  })
  check('常开接话开着但总开关没开 → 提示先开话题跟进', () => {
    const out = renderWith({ judgeEnabled: false, judgeAlwaysOn: true })
    assert.ok(out.includes('「话题跟进」总开关还关着'), `实际: ${out.slice(0, 700)}`)
  })
  check('常开限额填 0 → 提示不限次数的副作用', () => {
    const out = renderWith({ judgeEnabled: true, judgeAlwaysOn: true, judgeProactivePerHour: 0 })
    assert.ok(out.includes('不限次数'), `实际: ${out.slice(0, 700)}`)
  })
  check('跟进期时长会写进说明', () => {
    const out = renderWith({ contextSliderPos: 50, judgeEnabled: true, judgeFollowUpMin: 30 })
    assert.ok(out.includes('30 分钟'), `实际: ${out.slice(0, 400)}`)
    assert.ok(out.includes('顺延'), '应说明窗口会顺延')
  })
  check('没开话题跟进时，跟进期字段提示要先开开关', () => {
    const out = renderWith({ judgeEnabled: false, judgeFollowUpMin: 20 })
    assert.ok(out.includes('要先打开「话题跟进」开关才生效'), `实际: ${out.slice(0, 600)}`)
  })
  check('判定故障兜底开关说清两种口径', () => {
    const on = renderWith({ judgeFailOpen: true })
    assert.ok(on.includes('照旧接话'), `实际: ${on.slice(0, 400)}`)
    const off = renderWith({ judgeFailOpen: false })
    assert.ok(off.includes('一律不接话'), '关掉时应说明会一起沉默')
  })
  check('毫秒字段换算成人话', () => {
    const out = renderWith({ sessionIdleTtlMs: 1800000, runTimeoutMs: 120000 })
    assert.ok(out.includes('30 分钟'), '会话回收应显示 30 分钟')
    assert.ok(out.includes('2 分钟'), '运行超时应显示 2 分钟')
  })
}

console.log(`\n通过 ${passed} 项\n`)
