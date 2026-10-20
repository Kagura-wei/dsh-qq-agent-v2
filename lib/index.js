/**
 * dsh-qq-agent-v2 —— QQ 群聊/私聊 agent（推倒重来版）。
 *
 * 架构：反向 WebSocket（NapCat 主动连）→ 归一化 → 存档 → 门控 → Agent 会话。
 * 行为层参考 K0nd1us/QQ-agent：事件驱动 + 无状态运行 + 响应档位门控。
 *
 * 与宿主已有能力的关系（决策 Q6）：
 *   记忆 / 搜索 / 用量统计一律复用宿主插件（mnemon / free-search / dsh-usage），
 *   本插件只做"把哪些工具暴露给 QQ 会话"的白名单。
 */
import path from 'node:path'
import z from 'schemastery'
import { OneBotServer } from './onebot.js'
import { Archive, sessionKeyOf } from './store.js'
import { normalizeEvent, detectTrigger, decide } from './gate.js'
import { hasImage } from './text.js'
import { describeImageSegments } from './image.js'
import { ImagePrefetcher } from './prefetch.js'
import { Judge } from './judge.js'
import { isAgentUser } from './prompt.js'
import { Runner } from './runner.js'
import { Sender } from './sender.js'
import { ReminderService } from './reminders.js'
import { PERSONAS } from './personas.js'
import { MemeStore } from './meme/store.js'
import { MemeWeb } from './meme/web.js'

/** 内置角色卡 id 列表 + none。用 union 声明，设置页会自动渲染成下拉框。 */
const PERSONA_IDS = ['none', ...Object.keys(PERSONAS)]

export const name = 'dsh-qq-chat-agent'
export const inject = ['agents', 'agentDefaultModel', 'agentPresets', 'settings']

export const Config = z.object({
  // ── 连接（反向 WS：NapCat 连我们）──
  host: z.string().default('0.0.0.0').description('反向 WS 监听地址。NapCat 在容器内时必须为 0.0.0.0。'),
  port: z.number().step(1).min(1).max(65535).default(6701).description('监听端口，需与 NapCat 端反向 WS 地址一致。'),
  accessToken: z.string().role('secret').default('').description('Bearer token，NapCat 端需填相同值；留空则不校验。'),
  botQq: z.number().step(1).default(0).description('机器人 QQ 号，用于群内 @ 检测；0 = 由 OneBot 的 self_id 自动推断。'),

  // ── 白名单（空 = 全部拒绝，安全默认）──
  allowGroups: z.array(z.number().step(1)).default([]).description('允许服务的群号，可添加多个。空 = 拒绝所有群消息。'),
  allowUsers: z.array(z.number().step(1)).default([]).description('允许私聊的 QQ 号，可添加多个。空 = 拒绝所有私聊。'),
  blocklist: z.dict(z.array(z.number().step(1))).default({}).description('群内屏蔽名单：{ "群号": [QQ号, ...] }。'),

  // ── 触发与节奏 ──
  contextSliderPos: z.number().min(0).max(100).default(20).description('响应档位：≤10 仅@；≤20 @+关键词；≤90 按概率随机；>90 全响应。'),
  replyOnlyWhenMentioned: z
    .boolean()
    .default(true)
    .description('群聊仅在 @机器人（或引用机器人的消息）时才响应，非 @ 消息仍存档。'),
  keywords: z.array(z.string()).default([]).description('关键词表。'),
  wakeDelayMs: z.number().step(1).min(0).max(60000).default(2000).description('防抖聚批窗口，期间新消息重置计时。'),
  drainDelayMs: z.number().step(1).min(200).max(60000).default(1200).description('一轮结束后仍有未读时的续跑间隔。'),

  // ── 会话与模型 ──
  cwd: z.string().default('').description('会话工作目录与存档目录（存档落在 <cwd>/qq-archive）。'),
  agentPreset: z.string().default('').description('钉死会话使用的 agent preset，避免工具面漂移。'),
  provider: z.string().default('').description('模型提供商覆盖，留空用宿主默认。'),
  model: z.string().default('').description('模型覆盖，留空用宿主默认。'),
  runTimeoutMs: z.number().step(1).min(10000).max(1800000).default(120000).description('单次运行最长等待时间。'),
  sessionIdleTtlMs: z.number().step(1).min(60000).max(86400000).default(1800000).description('会话空闲多久后回收（毫秒），默认 30 分钟。防止 session 句柄无限增长。'),
  // 上下文窗口：不再按触发类型给不同条数，每个会话各自维护一份最近记录，
  // 通过 systemPrompt 的上下文注入提供，与 user 消息分开。
  contextMessages: z.number().step(1).min(0).max(500).default(30).description('注入最近多少条聊天记录作为上下文；0 = 不注入。各群各自维护，互不干扰。'),
  contextMaxChars: z.number().step(1).min(200).max(50000).default(4000).description('上下文文本上限（字符）。超出时不再从最旧的开始丢，而是按「轮」保留最近几轮、更早的压成摘要（见下两项）。'),
  contextRoundGapMin: z
    .number()
    .step(1)
    .min(1)
    .max(120)
    .default(5)
    .description('「一轮对话」的划分标准：相邻两条消息间隔超过这么多分钟就算新的一轮。按轮保留可以避免把一轮对话劈成两半，让模型看到半截提问。'),
  contextSummaryEnabled: z
    .boolean()
    .default(true)
    .description('上下文超出上限时，用轻量模型把更早的几轮压成一段摘要（不是每轮都调用，只有真的超了才调，且同一批内容只摘要一次）。关闭则直接丢弃更早的内容。'),
  contextSummaryProvider: z.string().default('').description('摘要用的模型提供商，留空沿用主会话设置。'),
  contextSummaryModel: z.string().default('').description('摘要用的模型，留空沿用主会话设置。填便宜的小模型即可，摘要不需要多聪明。'),
  contextSummaryMaxChars: z.number().step(1).min(100).max(2000).default(300).description('摘要的目标长度（字符）。'),
  contextSummaryMaxTokens: z.number().step(1).min(64).max(4096).default(512).description('摘要的输出上限。模型默认档位的思考会先吃一部分，太小会把正文整段吃掉。'),
  contextSummaryTimeoutMs: z.number().step(1).min(2000).max(120000).default(15000).description('单次摘要的超时时间。超时按失败处理，本轮退回截断，不影响正常回复。'),
  contextSummaryMessages: z.number().step(1).min(10).max(1000).default(200).description('单次摘要最多读入多少条旧记录（防极端情况下把一整年的记录塞进一次调用）。'),

  // ── 历史图片描述 ──
  // 上下文注入只能传字符串（回调是同步的，image 块要先异步落盘才行），
  // 所以历史里的图到了注入文本里只剩 `[图片]`。这里用视觉模型补一句话描述。
  contextImageDescEnabled: z
    .boolean()
    .default(true)
    .description('开启后，上下文里的历史图片会用视觉模型补一句描述（形如「[图片: 团战结算截图]」），模型才知道那些图在画什么。注入通道只能传字符串，不带描述时它们只剩「[图片]」三个字。'),
  contextImageDescMax: z.number().step(1).min(0).max(20).default(3).description('每一轮最多为几张新图片生成描述。同一张图只描述一次，之后每轮直接复用缓存。0 = 本功能不生效。'),
  contextImageDescMaxChars: z.number().step(1).min(10).max(200).default(40).description('单张图描述的长度上限（字符），超出截断。'),
  contextImageDescProvider: z.string().default('').description('生成图片描述用的模型提供商，留空沿用主会话设置。必须能读图。'),
  contextImageDescModel: z.string().default('').description('生成图片描述用的模型，留空沿用主会话设置。必须能读图的视觉模型 —— 纯文本模型会把图片直接忽略，描述会变成空话。'),
  contextImageDescMaxTokens: z.number().step(1).min(32).max(2048).default(128).description('图片描述的输出上限。模型默认档位的思考会先吃一部分，太小会把描述整段吃掉。'),

  // ── 运行健壮性 ──
  runRetryDelayMs: z
    .number()
    .step(1)
    .min(1000)
    .max(600000)
    .default(30000)
    .description('一轮跑完却什么都没发出去（模型报错/回合超时）时，隔多久自动重试一次。重试只有一次，再失败就放弃并明确记日志。'),
  healthLogEveryRuns: z
    .number()
    .step(1)
    .min(0)
    .max(1000)
    .default(20)
    .description('每跑完这么多轮，在日志里打一行累计统计（成功/空回复/超时/报错各多少），用来发现「机器人是不是在悄悄变哑」。0 = 不打印。'),

  // ── 发送保护 ──
  maxMessageLength: z.number().step(1).min(100).max(4000).default(1700).description('单条消息最大长度，超出安全切分。'),
  minGapMs: z.number().step(1).min(200).max(60000).default(1000).description('相邻两条消息的最小间隔。'),
  maxGapMs: z.number().step(1).min(200).max(60000).default(3000).description('相邻两条消息的最大间隔。'),
  byLengthMs: z.number().step(1).min(0).max(500).default(120).description('按字数附加的间隔，走 log2(字数+1) 缩放（长回复只是稍微慢一点，不会机械地等十几秒），毫秒。'),
  forwardEnabled: z
    .boolean()
    .default(true)
    .description('回复被切成很多段时，改成发一条「合并转发」的聊天记录卡片，群里只占一个气泡。NapCat 不支持该动作时会自动回退成逐条发送。'),
  forwardMinChunks: z.number().step(1).min(2).max(20).default(3).description('切分超过多少段才走合并转发。'),
  outboundGuardEnabled: z
    .boolean()
    .default(true)
    .description('是否启用出站屏蔽词检查。注：系统提示泄漏检测是内置的、始终生效，不受本开关影响。'),
  outboundBlockWords: z
    .array(z.string())
    .default([])
    .description('出站屏蔽词：回复里出现这些词就整条不发（默认空表，不预设任何词汇）。'),
  maxPerMinute: z.number().step(1).min(1).max(600).default(20).description('每会话每分钟发送上限。'),
  maxPerHour: z.number().step(1).min(1).max(3000).default(200).description('每会话每小时发送上限。'),

  // ── 人设 ──
  botName: z.string().default('小鲸鱼').description('机器人名字，用于提示词与文字提及检测。'),
  personaId: z
    .union(PERSONA_IDS)
    .default('xiaojingyu')
    .description('内置角色卡；none = 不注入。填了 personaText 时以 personaText 为准。'),
  personaText: z.string().role('textarea').default('').description('自定义人设正文，非空时覆盖 personaId。'),
  participation: z.union(['low', 'medium', 'high']).default('medium').description('参与度风格。'),
  rulesExtra: z.string().role('textarea').default('').description('追加到系统提示末尾的规则。'),
  searchEnabled: z.boolean().default(true).description('开启后，机器人遇到拿不准的问题（时事/版本/价格/技术报错等）会先用联网搜索工具查证再回答。需要宿主装有搜索插件（如 free-search）。'),
  imageEnabled: z
    .boolean()
    .default(true)
    .description('开启后，被触发（@ / 关键词 / 几率命中）的消息若带图，图片会交给视觉模型识别；关闭则一律降级为 [图片] 文字占位。注意本开关不决定"要不要回"——带图消息与纯文字走完全相同的触发规则。'),
  longImageMaxParts: z
    .number()
    .step(1)
    .min(0)
    .max(8)
    .default(4)
    .description('长截图（长边超过 8192 像素）会被沿着长边切成几段再发给模型 —— 宿主对单边超过 8192 的图会整张拒收，不切就只能看到「[图片]」。默认最多切 4 段；填 1 = 不切、只把整张缩到能过审（字会糊）；填 0 = 关闭该处理（长图仍按老样子降级占位）。宽度保持原样，所以长截图里的文字依然清晰。'),
  mentionEnabled: z
    .boolean()
    .default(true)
    .description(
      '开启后，机器人在群里回复时可以用 @ 提醒某个群友 —— 由它自己判断该不该 @（仅限最近在该群说过话的人，昵称对不上会退化成普通文字）。@ 会让对方手机弹提醒，比较打扰；关掉则回复里永远不会出现 @。'
    ),
  mentionMax: z
    .number()
    .step(1)
    .min(1)
    .max(10)
    .default(2)
    .description('一条回复里最多 @ 几个人。防止模型一次点一串名字刷屏。'),

  // ── 提醒 / 通知（@ 或关键词 → 定时到点在群里说一声）──
  reminderEnabled: z
    .boolean()
    .default(true)
    .description(
      '开启后，在群里 @ 机器人、或消息里出现提醒词时，先由模型判断这句话是不是在让你设提醒；确认后才解析成定时提醒，到点由机器人直接发言（不经模型）。支持「明天8点提醒我开会」「每天9点打卡」「每周一三五早上7点20开周会」「30分钟后叫我」。'
    ),
  reminderIntentJudge: z
    .boolean()
    .default(true)
    .description(
      '建提醒前先用轻量模型判断「这句话是不是在下指令」（约 100 token）。关掉就回到"出现提醒词/@ 就建"的旧行为，群里闲聊提到提醒两个字容易误触发。'
    ),
  reminderKeywords: z
    .array(z.string())
    .default(['提醒', '叫我', '喊我', '通知', '闹钟'])
    .description('出现这些词只是"让模型看一眼"，不要求 @ 机器人；最终建不建由模型判定。'),
  reminderRequireMention: z
    .boolean()
    .default(false)
    .description(
      '开启后只有 @ 机器人的消息才会进入提醒判定；关闭时消息里带提醒词也会判一次。想彻底安静就打开。'
    ),
  reminderConfirm: z.boolean().default(true).description('设好提醒后是否回一句确认。'),
  reminderConfirmText: z
    .string()
    .role('textarea')
    .default('')
    .description(
      '确认回执模板，留空用默认「好，{when} 提醒你：{task}」。可用占位符：{when} 时间、{task} 内容、{repeat} 周期。'
    ),
  reminderAtCreator: z
    .boolean()
    .default(true)
    .description('群里到点提醒时是否 @ 当初设置提醒的人（更醒目，但会打扰）。'),
  reminderLlmParse: z
    .boolean()
    .default(true)
    .description(
      '本地规则解析不出来时，用轻量模型兜底（不带工具、不带系统提示，单次约 300 token）。关闭则只认常见说法。'
    ),
  reminderProvider: z.string().default('').description('提醒解析用的模型提供商，留空沿用主会话设置。'),
  reminderModel: z.string().default('').description('提醒解析用的模型，留空沿用主会话设置。'),
  reminderCatchUpMin: z
    .number()
    .step(1)
    .min(0)
    .max(720)
    .default(30)
    .description('服务停机跨过触发点时，错过多少分钟以内补发；超出的记日志跳过。0 = 一律不补发。'),
  reminderMaxPerChat: z
    .number()
    .step(1)
    .min(1)
    .max(500)
    .default(50)
    .description('每个群/私聊最多同时存在的提醒条数。'),

  // ── 轻量判定（触发后的跟进期里，判断新消息是否还在同一话题）──
  judgeEnabled: z
    .boolean()
    .default(false)
    .description('开启后，机器人回完话的 10 分钟内，群里接着聊的、没触发到它的消息先判一次相关性，相关才接话。默认关闭。'),
  judgeFollowUpMin: z.number().step(1).min(0).max(720).default(10).description('跟进期时长（分钟）。机器人回完话后这段时间内会挑相关的话接；0 表示关闭跟进，此时只有「常开接话」能判定。'),
  judgeAlwaysOn: z
    .boolean()
    .default(false)
    .description('常开接话：不限跟进期，群里每条没触发到它的消息都先判一次相关性，相关才接话。解决「聊到能接的话题时它一直不出声」。默认关闭。'),
  judgeProactiveGapMs: z.number().step(1).min(0).max(600000).default(90000).description('常开模式下，同一个群两次主动接话的最小间隔（毫秒，默认 90000 = 90 秒），防连发刷屏。'),
  judgeProactivePerHour: z.number().step(1).min(0).max(60).default(8).description('常开模式下，每个群每小时最多主动接话几次。0 表示不限额。'),
  judgeProvider: z.string().default('').description('判定用的模型提供商，留空沿用主会话设置。'),
  judgeModel: z.string().default('').description('判定用的模型，留空沿用主会话设置。填更小更便宜的模型能再省一截。'),
  judgeContextMessages: z.number().step(1).min(1).max(50).default(8).description('判定时带几条最近的聊天记录（只取跟进期内的）。太少判不准，太多白烧钱。'),
  judgeMaxTokens: z.number().step(1).min(4).max(256).default(64).description('判定的输出上限。默认 64：模型默认档位的思考会先吃一部分，太小会把 Y/N 也吃掉。'),
  judgeTimeoutMs: z.number().step(1).min(1000).max(60000).default(8000).description('单次判定的超时时间，超时按"不回"处理。'),
  judgeMinIntervalMs: z.number().step(1).min(0).max(60000).default(1500).description('同一群两次判定的最小间隔。群聊高峰时靠它压住调用量。'),
  judgeMaxInFlight: z.number().step(1).min(1).max(20).default(3).description('同时进行的判定数上限，超出直接跳过。'),
  judgeFailOpen: z.boolean().default(true).description('判定不可用（模型报错/超时/取不到模型）时是否照旧接话。默认开：判定只当刹车，坏了不该让机器人整体静默。'),
  judgePromptExtra: z.string().role('textarea').default('').description('追加到判定标准的额外规则，例如"有人聊到 XX 话题一定要接"。'),

  // ── 表情包（模型按分类标记选图，回复里自动配图）──
  memeEnabled: z
    .boolean()
    .default(true)
    .description(
      '开启后，机器人可以在回复里配表情图：模型从分类表里挑一个键，写成 &&分类键&&，插件把标记换成图片发出。库为空时不注入任何提示词、不花 token。'
    ),
  memeMaxPerReply: z
    .number()
    .step(1)
    .min(0)
    .max(5)
    .default(1)
    .description('一条回复最多发几张表情图。0 = 只识别并剥离标记、但不发图。'),
  memeMaxImageBytes: z
    .number()
    .step(1)
    .min(10240)
    .max(52428800)
    .default(4194304)
    .description('单张表情图的体积上限（字节，默认 4MB）。超过则跳过该张 —— 大图会让发送帧变得很大，容易超时。'),
  memeSendTimeoutMs: z
    .number()
    .step(1)
    .min(5000)
    .max(120000)
    .default(30000)
    .description('发送表情图的动作超时（毫秒）。图片以 base64 内联发送，比纯文本慢，所以单给一个更宽松的值。'),
  memeWebEnabled: z
    .boolean()
    .default(true)
    .description('开启表情包管理界面：一个独立的小网页（不是 DSH 设置页），用来浏览/上传/删除表情、装社区表情包。'),
  memeWebHost: z
    .string()
    .default('0.0.0.0')
    .description('管理界面监听地址。0.0.0.0 = 局域网可访问（NAS 上默认）；127.0.0.1 = 仅本机。'),
  memeWebPort: z.number().step(1).min(1).max(65535).default(3098).description('管理界面端口。'),
  memeWebToken: z
    .string()
    .role('secret')
    .default('')
    .description('管理界面访问令牌。留空则首次启动自动生成，存到库里（<库目录>/.web-token），重启不变 —— 日志只打印地址，令牌请从配置或该文件取。'),
  memeProxy: z
    .string()
    .default('')
    .description('拉取表情包用的 HTTP 代理，例如 http://127.0.0.1:7890。国内直连 GitHub 常常不通，装包失败就先填这个。留空 = 直连。'),
  memeIndexUrl: z
    .string()
    .default('')
    .description('表情包社区索引地址，留空用内置默认（raw.githubusercontent → 自动回退到 codeload 通道，后者在受限网络下更常通）。'),

  // ── 诊断 ──
  logEvents: z.boolean().default(false).description('调试用：把收到的每个会话事件类型打到日志。排障时打开，平时关闭。'),

  // ── 工具面（按触发者身份分层）──
  //
  // 为什么需要这一组：QQ 会话是 ctx.agents.create() 建出来的，默认继承宿主的
  // **全量全局工具**。实测 170 个工具 ≈ 37.9k token/轮，而 176 个会话文件里只有
  // 21 个真调用过工具 —— 绝大多数轮次在为 bash / ego_* / task_board_* 这些
  // 群聊用不到的东西付 schema 钱。裁掉之后省下的固定开销比任何提示词优化都多。
  toolPolicyEnabled: z
    .boolean()
    .default(true)
    .description('按发言人身份裁剪工具面。开：群友的消息只带 chatTools 里的工具，管理员的消息带全量工具。'),
  agentUsers: z
    .array(z.number().step(1))
    .default([])
    .description('管理员 QQ 号：这些人说话时该会话用全量工具（可以派活）；其他人一律用 chatTools 白名单。必须是 QQ 号本身，昵称和自称不作数。'),
  chatTools: z
    .array(z.string())
    .default([
      'web_search',
      'web_fetch',
      'vision_describe',
      'weather',
      'mnemon_recall',
      'mnemon_remember',
      'mnemon_document_search',
    ])
    .description('群聊模式下放行的工具名。必须与宿主的「已知全局工具」精确一致，写错的名字只告警、不生效（不会打断会话）。'),
  allowedGlobalTools: z.array(z.string()).default([]).description('额外放行的工具名，追加到 chatTools。'),
  allowedGlobalToolPrefixes: z
    .array(z.string())
    .default([])
    .description('额外放行的工具名前缀，例如填 mnemon_ 会放行全部记忆工具。慎用：一个前缀往往展开出十几个工具，每轮都要为它们付 schema 钱。'),
})

// ── 为什么整棵 Config 要标 volatile（DSH 0.2.0）──
// 0.2.0 的设置页不再走 settings.register()，改为宿主扫插件条目的 Config：
// dsh-settings 的 describe() 只收录「volatile」字段（volatileForm），
// 一个 volatile 字段都没有时**整个命名空间不会出现在 describe 里**。
// 后果不是"表单少几个输入框"，而是设置页「群聊助手」直接报
// 「当前连接下设置不可用（远程页面只读）」——因为 scope 快照的 status
// 就是 unavailable，与本机/远程无关（2026-10-20 实测：同一页面上
// 通用设置、模型都可编辑，只有本分区不可用）。
// 本插件的设置页本来就是"全部可调项都能热改"，所以整棵树标记 volatile：
// 宿主据此把全部字段纳入表单，并允许写入运行中的 config。
// 注：host/port/accessToken 这类改了要重启才生效，标记后仍可写（落 patch），
// 只是监听器不会立刻重绑——这一点不影响其余项的热生效。
Config.meta.volatile = true

function makeLogger(ctx) {
  const base = ctx.logger?.('dsh-qq-chat-agent') ?? console
  return {
    info: (m) => base.info?.(m) ?? console.log(m),
    warn: (m) => base.warn?.(m) ?? console.warn(m),
    error: (m) => base.error?.(m) ?? console.error(m),
  }
}

export async function apply(ctx, config) {
  const logger = makeLogger(ctx)

  // 设置命名空间：两个大版本的机制不同，都要能跑。
  //   0.1.x —— 插件自己 `settings.register(ns, schema)` 发布命名空间，
  //            返回的 scope.get() 是「patch base + 用户覆盖」的实时值。
  //   0.2.0 —— dsh-settings 删掉了 register()：宿主改在 `settings.describe()`
  //            里按「活跃插件条目」自动派生命名空间 —— ns = 条目 options.id、
  //            schema 取插件导出的 Config，并标注 applies: 'live'。
  //            我们的条目 id 就是 dsh-qq-chat-agent，与这里的命名空间同名，
  //            所以 0.2.0 下拿不到 register 是正常形态。
  //            以前这里打的是 warn（"未找到 ctx.settings"），会让人误以为
  //            配置没生效、跑去查一个不存在的问题，所以降成 info。
  let scope = null
  try {
    if (ctx.settings && typeof ctx.settings.register === 'function') {
      scope = ctx.settings.register('dsh-qq-chat-agent', Config, { base: config })
      logger.info('已注册设置命名空间 → 设置 → 群聊助手')
    } else {
      logger.info('设置命名空间由宿主按插件条目自动派生（0.2.0 机制），配置热生效')
    }
  } catch (error) {
    logger.warn(`注册设置命名空间失败（仅用 patch 配置）: ${error?.message ?? error}`)
  }

  const getConfig = () => {
    try {
      const live = scope?.get?.()
      return live && typeof live === 'object' ? live : config
    } catch {
      return config
    }
  }

  const cwd = config.cwd ? path.resolve(config.cwd) : process.cwd()
  // 机器人自己的 QQ 号：群内 @ 检测、以及"别 @ 自己"都要它。
  // 启动时由 OneBot 的 self_id 补齐（见下方 onConnect），用户也可直接填 botQq。
  let selfId = Number(config.botQq) || 0
  const archive = new Archive({ dir: path.join(cwd, 'qq-archive'), logger })
  const server = new OneBotServer({ getConfig, logger })
  // 出站登记表在 sender 里（它才知道自己发出去的消息号），门控靠它识别"引用我的话"
  const sender = new Sender({ server, getConfig, logger, getSelfId: () => selfId })
  // 图片预热：QQ 的图片地址是带签名的临时地址，几分钟就失效。收到消息立刻抓字节，
  // 后面装配模型输入时直接取（见 prefetch.js）。
  const prefetch = new ImagePrefetcher({ logger, getConfig })
  // 提醒服务：自带落盘与定时扫描，和 agent 会话完全解耦（到点发消息不经模型）
  const reminders = new ReminderService({ ctx, getConfig, sender, archive, logger, dir: cwd })
  // 表情包库：磁盘上是 AstrBot 表情包协议（manifest.json + memes/<分类>/），
  // 所以社区现成的包可以直接装（见 lib/meme/pack.js）。
  const memes = new MemeStore({ getConfig, logger, dir: path.join(cwd, 'qq-memes') })
  const memeWeb = new MemeWeb({ store: memes, getConfig, logger })
  // judge 先建：runner 要在回复发出后回调它，让判定看得见机器人自己说过的话
  const judge = new Judge({ ctx, getConfig, logger })
  const runner = new Runner({
    ctx,
    getConfig,
    archive,
    sender,
    logger,
    prefetch,
    memes,
    onReply: (event) => judge.recordReply(event),
    getSelfId: () => selfId,
    describeExtra: () =>
      `判定 ${judge.stats.calls} 次(Y${judge.stats.yes}/N${judge.stats.no})；图片 ${prefetch.describe()}；` +
      `历史图 ${runner.imageDesc.describe()}；表情 ${memes.state.packs.length} 包/${memes.state.total} 张`,
  })

  const seen = new Set() // 简易去重，防止 NapCat 重连重投

  /**
   * 让一条"确定不会被回应"的消息退出未读队列。
   *
   * 门控不放行（没叫机器人 / 不在跟进期 / 群不在白名单）的消息永远得不到回应，
   * 可它照样躺在存档的未读队列里。攒到下次真被 @ 时，Runner 会把它们整批当成
   * "要对我说的话"灌进同一条 user 消息（上限 MAX_PENDING_PER_RUN 条）：
   *   - 白烧 token，还让模型把十几小时前的旧话当成刚发生的事；
   *   - #syncHistory 的历史窗口终点是"首条未读的 seq"，未读起点越早，
   *     真正该注入的历史被挤得越窄，极端情况（未读占满存档）直接被挤空。
   *
   * 标已读 ≠ 丢消息：条目仍在存档里，之后的上下文注入照样带上它。
   * 延迟到本轮防抖窗口之后再标，是为了不把"@ 我之后紧接着说的那两句"
   * 挡在这一轮的语境之外 —— 那几秒里它们仍可能被同一轮带进去。
   */
  function retireUnread(key, entry) {
    if (entry?.seq == null) return
    const delay = Math.max(1000, getConfig().wakeDelayMs ?? 2000) + 500
    const timer = setTimeout(() => {
      archive.markRead(key, [entry.seq]).catch((error) => {
        logger.warn(`[门控] 标记已读失败 ${key}: ${error?.message ?? error}`)
      })
    }, delay)
    timer.unref?.()
  }

  async function handle(raw) {
    const msg = normalizeEvent(raw)
    if (!msg) return

    const cfg = getConfig()
    const key = sessionKeyOf(msg.scene, msg.peerId)

    // 工具面跟着发言人走：管理员说话 → 全量（能派活），群友说话 → 精简白名单。
    // 必须放在这里而不是触发之后 —— 判定接话是异步的，等它回来再设就晚了；
    // 而且设置本身幂等，不触发回复的那些消息多设一次也无害。
    // 身份只认 senderId（QQ 号），昵称可以随便改。
    if (cfg.toolPolicyEnabled !== false) {
      const isAgent = isAgentUser(cfg, msg.senderId)
      runner.setToolMode(key, isAgent ? 'agent' : 'chat', {
        qq: msg.senderId,
        name: msg.senderName,
      })
    }

    if (msg.messageId && seen.has(msg.messageId)) return
    if (msg.messageId) {
      seen.add(msg.messageId)
      if (seen.size > 2000) seen.clear()
    }

    // 图片预热放在最前面：这一刻地址还有效。晚一步（等聚批、等装配）再下，
    // 撞上签名过期是常态，模型就只能看到 [图片] 占位符。
    if (cfg.imageEnabled !== false && hasImage(msg.segments)) {
      prefetch.warm(msg.segments)
    }

    // 图片取不到时的第一手线索：NapCat 到底给了什么字段
    if (cfg.logEvents && hasImage(msg.segments)) {
      logger.info(`[图片段] ${describeImageSegments(msg.segments)}`)
    }

    let entry
    try {
      entry = await archive.append(key, { ...msg, hasImage: hasImage(msg.segments) })
    } catch (error) {
      logger.error(`存档写入失败 ${key}: ${error?.message ?? error}`)
      return
    }

    const botQq = selfId || Number(cfg.botQq) || 0
    // 三种触发：@ 机器人 / 引用机器人说过的话 / 正文点名。
    // 出站登记表让"引用"这条路成立 —— reply 段本身只有消息号，
    // 得靠我们自己记住"哪些消息号是我发的"。
    const trigger = detectTrigger(msg, {
      botQq,
      botName: cfg.botName,
      isBotMessage: (id) => sender.isBotMessage(id),
    })
    const mention = trigger.mention
    const decision = decide({
      config: cfg,
      msg,
      mention,
      mentionKind: trigger.kind,
      addressedToOther: trigger.addressedToOther,
    })

    // 提醒/通知优先接管：设提醒是个确定性动作，没必要付主会话那 26k token 的
    // 固定前缀（agent 系统提示 + 96 个工具 schema + 记忆快照）。
    // 没命中（不是提醒请求）就返回 false，下面一行不受影响 —— 解析不出来时
    // 宁可交回正常聊天，也不甩一句"我没听懂"。
    if (await reminders.tryHandle({ cfg, msg, mention, decision, key })) return

    if (decision.accept) {
      logger.info(
        `[命中] ${key} reason=${decision.reason} ` +
          `from=${msg.senderId} text="${msg.text.slice(0, 60)}"`
      )
      // 历史不再随触发带来 —— 各群自己那份上下文由 Runner 在每轮开始前刷新，
      // 通过 systemPrompt 的上下文注入交给模型（见 runner.js）。
      runner.schedule(key, { scene: msg.scene, peerId: msg.peerId })
      return
    }

    // 本地门控没放行 → 交给轻量判定决定（异步，不 await：消息处理链路不能被
    // 一次模型调用拖住）。两种模式：
    //   跟进期（windowUntil 内）→ 判"这条还在延续我的话题吗"；
    //   常开接话（judgeAlwaysOn）→ 窗口外也判"值不值得主动插一句"，
    //   频率由冷却与每小时限额兜住（见 judge.js）。
    // 判定不接管时（绝大多数消息）这条就彻底没人管了，必须让它退出未读队列，
    // 否则会一路攒到下次真被 @ 时被整批灌进 user 消息。
    if (!judge.shouldConsider({ cfg, msg, mention, decision, key })) {
      retireUnread(key, entry)
      return
    }

    // 多取一些再由判定器按跟进期截断：窗口是 10 分钟，固定条数取太少
    // 会让话题窗口在热闹的群里被截得过短。常开模式下这几条就是判断背景。
    const mode = judge.isInFollowUp(key) ? 'followup' : 'ambient'
    const recent = archive.getRecentCached(key, 40)
    judge
      .evaluate({ key, scene: msg.scene, recent, mode })
      .then(async (verdict) => {
        if (!verdict.reply) {
          // 判定说"不回"也要把这条标成已读。否则它永远留在未读队列里，
          // 下一次真的要回复时会被整批灌进 user 消息（上限 100 条），
          // 既烧 token 又让模型把陈年旧账当成"刚对我说的话"。
          // 归档后它们会正常并入上下文历史，不会丢。
          if (entry?.seq != null) {
            await archive.markRead(key, [entry.seq]).catch((error) => {
              logger.warn(`[判定] 标记已读失败 ${key}: ${error?.message ?? error}`)
            })
          }
          return
        }
        // 常开模式要记账：它靠"冷却 + 每小时限额"防刷屏，与跟进期不同。
        // 判定被拒的不算 —— 否则额度会被一堆"判完不回"的消息吃光。
        if (mode === 'ambient') judge.recordProactive({ key })
        logger.info(
          `[接话] ${key} ${verdict.reason} mode=${mode} ` +
            `from=${msg.senderId} text="${msg.text.slice(0, 60)}"`
        )
        // mode='followup'：告诉编排层"这次不是被点名，是主动接话"，
        // 于是本轮会额外注入一段"没人点你、可以不说话"的提示（见 prompt.js）。
        runner.schedule(key, { scene: msg.scene, peerId: msg.peerId, mode: 'followup' })
      })
      .catch((error) => {
        // evaluate 内部已经兜过一轮，这里是双保险：绝不让判定异常冒到事件循环外
        logger.error(`[判定异常] ${key}: ${error?.message ?? error}`)
      })
  }

  await ctx.effect(async () => {
    await archive.init()
    await server.start()
    await reminders.init()
    await memes.init()

    // 管理界面是"锦上添花"，起不来（端口被占）不能拖垮整个插件 —— 机器人照常收发。
    if (getConfig().memeWebEnabled !== false) {
      try {
        await memeWeb.start()
      } catch (error) {
        logger.warn(`表情包管理界面启动失败（${error?.message ?? error}），机器人功能不受影响`)
      }
    }

    {
      const rc = getConfig()
      logger.info(
        `提醒功能 ${rc.reminderEnabled === false ? '关闭' : '开启'}` +
          `（提醒词 ${(rc.reminderKeywords ?? []).filter(Boolean).join('/') || '无'}，` +
          `${rc.reminderRequireMention === true ? '仅 @ 生效' : '关键词也生效'}，` +
          `补发窗口 ${rc.reminderCatchUpMin ?? 30} 分钟）`
      )
      logger.info(
        `出站：合并转发 ${rc.forwardEnabled === false ? '关闭' : `≥${rc.forwardMinChunks ?? 3} 段合成一条`}，` +
          `出站屏蔽词 ${(rc.outboundBlockWords ?? []).filter(Boolean).length} 个；` +
          `上下文：按轮保留（间隔 ${rc.contextRoundGapMin ?? 5} 分钟分轮）、` +
          `超 ${rc.contextMaxChars ?? 4000} 字${rc.contextSummaryEnabled === false ? '直接丢弃' : '压成摘要'}；` +
          `历史图 ${rc.contextImageDescEnabled === false ? '只留占位' : `描述开启（每轮最多 ${rc.contextImageDescMax ?? 3} 张）`}；` +
          `长图 ${
            (rc.longImageMaxParts ?? 4) === 0
              ? '不处理（超限即占位）'
              : (rc.longImageMaxParts ?? 4) === 1
                ? '整体缩小'
                : `最多切 ${rc.longImageMaxParts ?? 4} 段`
          }`
      )
      logger.info(
        `表情包 ${rc.memeEnabled === false ? '关闭' : `开启（每条最多 ${rc.memeMaxPerReply ?? 1} 张）`}：` +
          `${memes.state.packs.length} 个包 / ${memes.state.categories.size} 个分类 / ${memes.state.total} 张图` +
          `${memes.empty ? '（库是空的，不会注入提示词；用管理界面装包）' : ''}` +
          `${memes.empty ? '' : '，库目录 ' + memes.dir}`
      )
    }

    const off = server.onEvent(handle)

    // self_id 用于 @ 检测；失败不阻塞，用户可直接填 botQq。
    // 启动瞬间 NapCat 通常还没连上，所以挂在「连接建立」回调里打，断线重连也会重打。
    const offConnect = server.onConnect(() => {
      server
        .getLoginInfo()
        .then((info) => {
          if (info?.user_id) {
            selfId = Number(info.user_id)
            logger.info(`已获取机器人 QQ 号: ${selfId}`)
          }
        })
        .catch((error) => logger.warn(`获取 login info 失败: ${error?.message ?? error}`))
    })

    return async () => {
      off()
      offConnect()
      await runner.stop() // 必须先停编排：session 句柄要先于传输层释放
      await reminders.stop()
      await memeWeb.stop()
      sender.stop()
      prefetch.clear()
      await archive.stop()
      await server.stop()
      logger.info('已停止')
    }
  })
}
