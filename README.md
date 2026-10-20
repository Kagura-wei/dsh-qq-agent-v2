# dsh-qq-agent-v2

把 DeepSeek Harness（DSH）的 Agent 接到 QQ 群聊/私聊的插件：**NapCat 反向 WebSocket → 白名单门控 → Agent 会话 → 分层工具面**。

不是关键词问答机器人，是"群里有个能干活的人"：它记得住上下文、能看图、能联网查证、管理员可以随时派活（跑命令、查文件、调工具），普通群友则只拿到一个很小的工具白名单。

> 行为层设计参考 [K0nd1us/QQ-agent](https://github.com/K0nd1us/QQ-agent)：事件驱动 + 无状态运行 + 响应档位门控。

---

## 特性

| | |
|---|---|
| **反向 WS** | 本插件是服务端，NapCat（OneBot v11）主动连进来。NapCat 在 Docker 里也能用，只要监听 `0.0.0.0` |
| **白名单门控** | 群号 / 私聊 QQ 号双层白名单，空 = 全部拒绝。群内可再配屏蔽名单 |
| **响应档位** | 一个 0–100 的滑杆同时控制"什么消息才回"：仅 @ → +关键词 → 按几率 → 全回 |
| **引用即触发** | 引用机器人的消息等同 @，不需要再打一遍 @ |
| **上下文记忆** | 每群一份会话，按"轮"（默认 5 分钟间隔）注入最近记录；超出预算时用便宜小模型把更早的轮压成摘要 |
| **图片理解** | 入站图片交给视觉模型识别；长截图沿长边切段，避免被宿主整张拒收（单边 8192 上限） |
| **历史图片描述** | 注入通道只能传字符串，历史图会退化成 `[图片]` —— 这里用视觉模型补一句描述并缓存 |
| **相关性判定** | 跟进期 / 常开接话两种模式，用轻量通道（约 250 token）判"这话是不是在跟我说"，避免每条群聊都烧主会话 |
| **分层工具面** | 管理员（`agentUsers`）拿宿主全量工具，其他人只拿 `chatTools` 白名单 —— 实测 170 个工具 ≈ 3.8 万 token/轮 |
| **提醒** | "提醒我 10 分钟后..." 由模型判定意图后落盘，到点直接发，不经模型；支持查看/取消 |
| **表情包** | 模型在回复里写 `&&分类&&` 就会附一张该分类的表情；自带独立管理页（浏览/上传/装社区包） |
| **出站保护** | 系统提示泄漏指纹内置生效；限频、长度切分、多段转合并转发卡片 |

---

## 架构

```
NapCat (OneBot v11)
      │  反向 WebSocket（NapCat 主动连 6701）
      ▼
┌─────────────────────────────────────────────────────────────┐
│ OneBotServer   解析事件 → normalizeEvent                    │
│ Archive        每群/每人一份消息存档（JSONL）                │
│ Gate           allowlist → 触发判定 → 响应档位  ← 省 token 的关键 │
│ Judge          轻量模型判"要不要接话"（可关）                 │
│ Runner         组装会话：上下文注入 + 工具白名单 + 提示词      │
│ Sender         切分 / 合并转发 / 限频 / 出站检查              │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
DSH Agent 会话（provider / model / preset 可覆盖）
```

关键设计取舍：**门控放在最外层**。一次主会话请求实测约 2.6 万 token，且 89% 是固定开销（工具 schema + 系统提示），跟"回不回这条消息"无关。所以任何"先跑一轮再决定要不要说"的做法都是烧钱，必须在进去之前就判死。

---

## 安装

**前置条件**

- DSH 0.2.x（`dsh` CLI 可用）
- NapCat（或任何 OneBot v11 实现），能访问到跑 DSH 的那台机器
- 想看图的话，宿主要有能读图的 provider（例如 `workbuddy-cn-vision` + `deepseek-v4.1-flash`）

**装包**

```bash
# 包根目录先装依赖（只有 ws，schemastery 由宿主提供）
npm install

# 以 web profile 为例
dsh plugin --profile web add <包名或本地路径>
```

> 命令与参数以你的 DSH 版本的 `dsh plugin --help` 为准。装好后插件会被写进该 profile 的 `cordis.patch.yml` 的 `insert:` 段，并带上本包自带的 `cordis.patch.yml`（里面只声明 `id: dsh-qq-chat-agent`）。

**校验配置没写坏**

```bash
dsh --dump-config --profile web | grep -A20 dsh-qq-chat-agent
```

**NapCat 端**

在 NapCat 里添加一个**反向 WebSocket**客户端，地址填 `ws://<DSH 机器 IP>:6701`，Token 与插件里的 `accessToken` 保持一致（插件留空则不校验）。

> NapCat 跑在 Docker 里时，容器访问宿主机一般走 `172.17.0.1`；插件监听 `0.0.0.0` 才能被连上。同一条反向 WS 只能接一个消费方，别和别的 QQ 插件抢。

---

## 配置

写在 profile 的 `cordis.patch.yml` 里（**不是** `~/.dsh/settings.yaml`）：

```yaml
- insert:
    - id: dsh-qq-chat-agent
      name: dsh-qq-agent-v2
      config:
        host: 0.0.0.0
        port: 6701
        botQq: 123456789          # 填了就不用靠 self_id 推断
        allowGroups: [123456789]  # 空 = 一个群都不回
        allowUsers: [123456789]   # 空 = 一个私聊都不回
        cwd: /opt/dsh             # 存档 <cwd>/qq-archive、表情库 <cwd>/qq-memes、提醒 <cwd>/qq-reminders.json
        keywords: ['小鲸鱼']
        contextSliderPos: 20      # 响应档位，见下
        agentUsers: [123456789]   # 管理员，只认 QQ 号
```

改完要**重启 DSH** 才生效（设置页的写入也只落 patch 文件，不会热更新运行中的实例）。

### 响应档位 `contextSliderPos`

| 档位 | 行为 |
|---|---|
| ≤ 10 | 只回 @（含引用机器人） |
| ≤ 20 | @ + 关键词命中 |
| ≤ 90 | 按概率随机（档位即几率） |
| > 90 | 每条都回 |

⚠️ 档位 89 已经是 98.6% 命中，几乎等于"全回"。想让机器人安静，别调这个，去开 `judgeEnabled` / `judgeAlwaysOn` —— 它们走轻量通道，一条约 250 token。

### 常被调的几组

| 配置 | 说明 |
|---|---|
| `allowGroups` / `allowUsers` / `blocklist` | 白名单三件套，空列表 = 拒绝 |
| `replyOnlyWhenMentioned` | 群聊是否只认 @（非 @ 消息仍会存档） |
| `wakeDelayMs` / `drainDelayMs` | 聚批窗口 / 续跑间隔，群里刷屏时不用每句都开一轮 |
| `contextMessages` / `contextMaxChars` / `contextRoundGapMin` | 上下文条数 / 字符预算 / 第几轮划分 |
| `contextSummary*` | 超预算时用哪个小模型摘要、摘要多长、超时多少 |
| `imageEnabled` / `longImageMaxParts` | 看图总开关 / 长图最多切几段（`0` 关闭、`1` 只缩放） |
| `judgeEnabled` / `judgeAlwaysOn` / `judgeProactivePerHour` | 跟进期接话 / 常开接话 / 每群每小时上限 |
| `judgeFailOpen` | 判定挂了要不要照旧回复（默认开：判定只当刹车） |
| `toolPolicyEnabled` / `agentUsers` / `chatTools` | 工具面分层开关 / 谁能派活 / 群友能用的工具白名单 |
| `reminderEnabled` / `reminderIntentJudge` | 提醒总开关 / 是否让模型先判"这是不是个提醒" |
| `memeEnabled` / `memeWebEnabled` / `memeWebPort` | 表情包 / 管理页 / 管理页端口（默认 3098） |
| `forwardEnabled` / `forwardMinChunks` | 多段回复转合并转发卡片 / 几段起转 |
| `outboundGuardEnabled` / `outboundBlockWords` | 出站屏蔽词（默认空表，不预设词汇） |
| `healthLogEveryRuns` | 每 N 轮打一行累计统计，用来发现"机器人悄悄变哑" |

完整字段列表见 `lib/index.js` 里的 `Config`，每项都带说明（设置页也是从这个 schema 渲染出来的）。

---

## 表情包

回复里出现 `&&分类&&` 就会被剥离并附上一张该分类的表情（`memeMaxPerReply` 控制张数，`0` = 只剥离不发）。所有 `&&...&&` 一律剥离，只有命中分类表才发图。

库目录 `<cwd>/qq-memes/`，结构：

```
qq-memes/
├── manifest.json
└── memes/
    └── <分类>/
        └── *.png|jpg|gif
```

管理页（`memeWebEnabled`）是个独立小网页，用来浏览 / 上传 / 删除表情、装社区表情包。装包要能访问 GitHub，国内建议填 `memeProxy`（如 `http://127.0.0.1:7890`）。

访问令牌（`memeWebToken` 留空则首次启动自动生成到 `qq-memes/.web-token`，权限 0600）**不会写进日志** —— 启动日志只打地址，令牌请从配置或该文件取。

---

## 测试

```bash
npm test        # 13 个自测文件串行跑
node test/mention-test.mjs   # 或者单个跑
```

无外部依赖、不连真机：假 OneBot 服务端 + 假 ctx，覆盖门控、上下文、判定、图片切段、表情包、提醒、工具白名单、设置页渲染。

`client-test.mjs` 需要 `react` / `react-dom` 才能渲染设置页；没装会自动跳过（不算失败）。装在别处时指过去即可：

```bash
REACT_HOME=/path/to/node_modules node test/client-test.mjs
```

真机联调另有 `judge-e2e.mjs`（连接本机跑着的插件，模拟 NapCat 发消息），用环境变量控制：

```bash
E2E_SELF=<机器人QQ> E2E_GROUP=<群号> E2E_SENDERS='名字:QQ||名字2:QQ2' node judge-e2e.mjs
```

---

## 已知限制

- 只实现 OneBot v11 的反向 WS，不支持 HTTP 上报 / 正向 WS
- 会话历史里**图片本身不进上下文**，只留一句描述（注入通道只能传字符串）
- 上传的视频段不会被处理（要视频理解得另装插件）
- 工具白名单只管"继承自宿主的工具"，挡不掉 preset 自己注册的工具
- 用户在会话运行中切换身份（管理员↔群友），工具面要等这一轮结束才变

---

## 许可

[MIT](LICENSE)。

内置角色卡库移植自 [K0nd1us/QQ-agent](https://github.com/K0nd1us/QQ-agent)（MIT），
其余第三方来源（表情包社区索引、AstrBot 表情包协议）见 [NOTICE.md](NOTICE.md)。
