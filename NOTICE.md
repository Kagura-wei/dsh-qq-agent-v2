# 第三方代码与素材声明

本项目以 MIT 许可发布（见 `LICENSE`）。下列部分来自第三方，遵循其原始许可。

## K0nd1us/QQ-agent（MIT）

- **用途**：行为层设计参考（事件驱动 + 无状态运行 + 响应档位门控）。
- **直接移植的代码**：`lib/personas.js` 内置角色卡库（人设语气、去 AI 味规则、黑名单、示例），
  由原 `src/personas.js` 移植后做架构适配（去掉对 `send_message` 等不存在工具的依赖）。
  改动说明见该文件头部注释。
- **来源**：https://github.com/K0nd1us/QQ-agent
- **许可**：MIT。原项目的版权声明与许可全文见其仓库 `LICENSE`；
  按 MIT 要求，本仓库保留上述署名，并在 `lib/personas.js` 文件头标注来源。

## anka-afk/astrbot-meme-pack-index（表情包社区索引）

- **用途**：`lib/meme/pack.js` 默认从该仓库拉取社区表情包索引
  （`community-index.json`），并按其条目下载各表情包。
- **说明**：本项目**不分发**这些表情包，仅在运行时按用户操作下载；各表情包的版权与许可归属其原仓库。

## AstrBot 表情包协议

- **用途**：表情包库的磁盘格式（`manifest.json` + `memes/<分类>/*`）与 AstrBot 生态保持一致，
  以便直接安装社区现成的包。仅为格式兼容，未拷贝其代码。
