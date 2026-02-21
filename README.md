# OpenClawX

基于自已的OpenBot重构而来

[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 📚 文档导航

完整使用说明请进入 **[使用文档入口](docs/README.md)**。文档结构如下：

| 分类 | 文档 | 说明 |
|------|------|------|
| **入门** | [快速开始](docs/guides/getting-started.md) | 5 分钟跑通：安装、首次对话、桌面/通道入口 |
| | [安装与部署](docs/guides/installation.md) | npm、Docker、Desktop 安装包及环境要求 |
| **使用指南** | [CLI 使用](docs/guides/cli-usage.md) | 命令行对话、登录、模型与技能、开机自启 |
| | [桌面端使用](docs/guides/desktop-usage.md) | Desktop 安装与启动、智能体/会话/技能/设置 |
| | [Web 与 Gateway](docs/guides/gateway-web.md) | 启动网关、端口与路径、Web 端连接 |
| **配置** | [配置概览](docs/configuration/config-overview.md) | 配置目录、config.json 与 agents.json |
| | [智能体配置](docs/configuration/agents.md) | 本机/Coze/OpenClawX 执行方式与模型 |
| | [通道配置](docs/configuration/channels.md) | 飞书、钉钉、Telegram 启用与配置项 |
| **功能说明** | [代理模式与多节点](docs/features/proxy-mode.md) | Coze 接入、OpenClawX 多节点协作 |
| | [技能系统](docs/features/skills.md) | Agent Skills 规范与扩展 |
| **参考** | [常见问题](docs/reference/faq.md) | 安装失败、端口占用、通道不回复等 FAQ |

<details>
<summary><strong>📂 文档树结构</strong></summary>

```
docs/
├── README.md                   → 文档入口与导航
├── guides/                     → 使用指南
│   ├── getting-started.md      快速开始
│   ├── installation.md         安装与部署
│   ├── cli-usage.md            CLI 使用
│   ├── desktop-usage.md        桌面端使用
│   └── gateway-web.md          Web 与 Gateway
├── configuration/              → 配置说明
│   ├── config-overview.md      配置概览
│   ├── agents.md              智能体配置
│   └── channels.md            通道配置（飞书/钉钉/Telegram）
├── features/                   → 功能说明
│   ├── proxy-mode.md          代理模式与多节点协作
│   └── skills.md              技能系统
├── reference/                  → 参考
│   └── faq.md                 常见问题
└── channel-streaming-design.md 通道流式设计（开发参考）
```

</details>

---

## 特性概览

| 能力 | 说明 |
|------|------|
| **技能架构** | 基于 Agent Skills 规范，支持多路径加载、本地安装与动态扩展；支持技能自我发现与自我迭代 |
| **编码智能体** | 集成 [pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)，支持多轮工具调用与代码执行 |
| **浏览器自动化** | 内置 [agent-browser](https://www.npmjs.com/package/agent-browser)，可导航、填表、截图与数据抓取 |
| **长期记忆** | 向量存储（Vectra）+ 本地嵌入，支持经验总结与会话压缩（compaction） |
| **多端接入** | CLI、WebSocket 网关、Electron 桌面端，同一套 Agent 核心；各端技术栈见下方「各端技术栈」 |
| **多通道接入** | 飞书、钉钉、Telegram 等 IM 通道，Gateway 根据配置注册；入站经统一格式进 Agent，回复经通道回传 |
| **代理模式** | 智能体执行方式可选 **本机** / **Coze** / **OpenClawX**；本机使用当前模型与 Skills，代理则将对话转发至对应平台 |
| **Coze 接入** | 支持 Coze 国内站（api.coze.cn）与国际站（api.coze.com）；按站点分别配置 Bot ID 与 Access Token（PAT/OAuth/JWT），桌面端与通道均可选用 Coze 智能体 |
| **OpenClawX 多节点协作** | 可将智能体代理到另一台 OpenClawX 实例（baseUrl + 可选 API Key），实现多节点分工、负载与协作 |
| **MCP（规划中）** | 为降低 Token 消耗与大模型幻觉，后续将支持 MCP（Model Context Protocol） |

---

## 技术架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              客户端 / 接入层                                  │
├─────────────────┬─────────────────────────────┬─────────────────────────────┤
│   CLI (openbot) │   WebSocket Gateway (JSON-RPC)  │   OpenBot Desktop (Electron)  │
│   Commander     │   ws, 端口 38080              │   Vue 3 + Pinia + Vite       │
└────────┬────────┴──────────────┬──────────────┴──────────────┬──────────────┘
         │                        │                             │
         │                        │  HTTP + Socket.io            │
         ▼                        ▼                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Gateway Server (Node)                             │
│  • 内嵌 Nest（/server-api）• 按 path 分流 • 静态资源 • 自动发现端口             │
└────────────────────────────────────┬────────────────────────────────────────┘
                                      │
         ┌────────────────────────────┼────────────────────────────┐
         ▼                            ▼                            ▼
┌─────────────────┐    ┌─────────────────────────────┐    ┌─────────────────────┐
│  Agent 核心      │    │  Desktop Backend (NestJS)   │    │  Memory / 向量存储   │
│  AgentManager   │    │  server-api/*               │    │  Vectra + 嵌入       │
│  执行方式:      │    │  Agents · Skills · Tasks    │    │  compaction 扩展     │
│  local/coze/    │    │  Auth · Users · Workspace   │    │  sql.js              │
│  openclawx(代理)│    │                             │    │                     │
│  pi-coding-agent│    │                             │    │                     │
│  pi-ai 多模型   │    │                             │    │                     │
└────────┬────────┘    └─────────────────────────────┘    └─────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Tools: read/write/edit · bash · find/grep/ls · browser · install-skill ·   │
│         save-experience (写入记忆) · Proxy(local/coze/openclawx)             │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **CLI**：直接调用 Agent 核心，单次提示或批量脚本；可启动 Gateway（`openbot gateway`）及配置开机自启（`openbot service install/uninstall`）。
- **WebSocket Gateway**（`src/gateway/`）：单进程内嵌 Nest，对外提供 WebSocket（JSON-RPC）与 HTTP；按 path 分流：`/server-api` 走 Nest、`/ws` 为 Agent 对话、`/ws/voice`/`/sse`/`/channel` 为扩展占位，其余为静态资源。根据配置注册**飞书、钉钉、Telegram** 等通道，入站消息经统一格式进入 Agent，回复经该通道发回对应平台。供 Web/移动端连接；支持以开机/登录自启方式常驻（Linux cron、macOS LaunchAgent、Windows 计划任务）。
- **Desktop 后端**（`src/server/`）：NestJS HTTP API，即 **server-api**；可被 Gateway 内嵌或独立监听（默认端口 38081）。会话、智能体配置、技能、任务、工作区、鉴权等由本模块提供。
- **Desktop**：Electron 包一层 Vue 前端 + 上述后端；通过 Gateway 或直连 Desktop 后端与 Agent 通信。
- **Agent 核心**：统一由 `AgentManager` 管理会话、技能注入与工具注册；**执行方式**可为 **local**（本机 pi-coding-agent + Skills）、**coze**（代理至 Coze 国内/国际站）、**openclawx**（代理至其他 OpenClawX 节点，多节点协作）。记忆与 compaction 作为扩展参与 system prompt 与经验写入。

### 项目目录结构

```
openbot/
├── src/                    # 源码（构建输出 dist/）
│   ├── core/               # 公共核心，CLI 与 Gateway 共用
│   │   ├── agent/          # AgentManager、run、技能与配置；proxy/ 代理（local/coze/openclawx）
│   │   ├── config/         # 桌面配置（~/.openbot/desktop）
│   │   ├── memory/         # 向量存储、嵌入、compaction
│   │   ├── installer/      # 技能安装
│   │   └── tools/          # 内置工具（browser、install-skill、save-experience 等）
│   ├── cli/                # CLI 入口与 service 子命令
│   │   ├── cli.ts          # 主入口，构建为 dist/cli/cli.js
│   │   └── service.ts      # 开机自启 install/uninstall/stop
│   ├── gateway/            # WebSocket 网关（内嵌 Nest、path 分流）
│   │   ├── channel/        # 通道模块：多 IM 接入与 Agent 对接
│   │   │   ├── channel-core.ts   # 通道核心（注册、入站/出站统一格式）
│   │   │   ├── registry.ts       # 按配置注册各通道
│   │   │   ├── run-agent.ts      # 入站消息调用 Agent/Proxy，回写通道
│   │   │   ├── session-persistence.ts
│   │   │   ├── types.ts
│   │   │   └── adapters/         # 各平台适配器
│   │   │       ├── feishu.ts     # 飞书 WebSocket 事件
│   │   │       ├── dingtalk.ts   # 钉钉 Stream
│   │   │       └── telegram.ts   # Telegram 长轮询
│   │   ├── channel-handler.ts    # /channel 路由入口
│   │   ├── methods/              # JSON-RPC 方法（connect、agent.chat 等）
│   │   ├── server.ts             # 网关主进程
│   │   └── ...
│   ├── server/             # Desktop 后端（NestJS）
│   ├── cli.ts              # 兼容入口，仅转发到 cli/cli.js
│   └── index.ts            # 包导出
├── apps/
│   ├── desktop/            # Electron + Vue 桌面端
│   ├── web/                # 预留
│   ├── mobile/             # 预留
│   ├── miniprogram/        # 预留
│   └── browser-extension/  # 预留
├── deploy/                 # Docker、K8s 等部署
├── test/                   # 单元与 e2e 测试
├── examples/               # 示例（含 workspace、gateway-client）
└── skills/                 # 技能目录（SKILL.md 规范）
```

### 目录与模块对应

| 目录 | 说明 |
|------|------|
| `src/core/` | **公共核心**：`agent/`（AgentManager、pi-coding-agent、**proxy/** 代理：local/coze/openclawx 适配器）、`config/`（桌面配置）、`memory/`、`installer/`、`tools/`；CLI 与 Gateway 共用。 |
| `src/cli/` | **CLI**：`cli.ts` 主入口（构建为 `dist/cli/cli.js`），`service.ts` 提供开机自启（install/uninstall/stop）。 |
| `src/gateway/` | **WebSocket 网关**：单进程内嵌 Nest，按 path 分流：`/server-api`、`/ws`、`/ws/voice`、`/sse`、`/channel`、`/health`、静态资源（`apps/desktop/renderer/dist`）。 |
| `src/gateway/channel/` | **通道模块**：多 IM 通道接入与 Agent 对接。`channel-core` 统一入站/出站格式与注册；`registry` 按 config 注册飞书/钉钉/Telegram；`run-agent` 将入站消息交给 Agent/Proxy 执行并回写该通道；`adapters/` 下为各平台实现（feishu、dingtalk、telegram）。`channel-handler.ts` 为 `/channel` 路由入口。 |
| `src/server/` | **Desktop 后端**（NestJS），HTTP API 前缀 `server-api`；可内嵌到 Gateway 或独立监听。 |
| `apps/desktop/` | **桌面端**（Electron + Vue），前端构建产物由 Gateway 提供。 |
| `deploy/` | Dockerfile、K8s 等部署配置。 |
| `test/` | 单元与 e2e 测试（config、gateway、server、installer）。 |
| `examples/` | 示例工作区、gateway 客户端等。真实工作区根目录为 `~/.openbot/workspace/`。 |
| `skills/` | 技能目录（SKILL.md 规范）。 |

---

## 各端技术栈

### CLI

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js 20+ |
| 语言 | TypeScript 5.7 |
| 入口 | `openbot`（bin → `dist/cli/cli.js`） |
| 框架 | Commander（子命令：`gateway`、`login`、`config`、`service`） |
| 配置 | `~/.openbot/agent`（API Key、模型、技能等）；`~/.openbot/desktop`（与桌面共用） |
| 开机自启 | `openbot service install` / `uninstall`（Linux cron、macOS LaunchAgent、Windows 计划任务）；`openbot service stop` 停止当前 gateway |

### WebSocket Gateway

| 类别 | 技术 |
|------|------|
| 协议 | JSON-RPC over WebSocket（`ws`） |
| 端口 | 默认 38080，可 `-p` 指定 |
| 架构 | 单进程内嵌 Nest；按 path 分流：`/server-api`、`/ws`、`/ws/voice`、`/sse`、`/channel`、`/health`、静态资源 |
| 职责 | 连接管理、消息路由、鉴权钩子、静态资源（Desktop 前端） |
| 方法 | `connect`、`agent.chat`、`agent.cancel`、`subscribe_session`、`unsubscribe_session` 等 |

### Agent 核心

| 类别 | 技术 |
|------|------|
| 智能体 | @mariozechner/pi-coding-agent |
| 模型/Provider | @mariozechner/pi-ai（DeepSeek、DashScope、OpenAI 等） |
| **代理执行** | **local**（本机） / **coze**（Coze 国内/国际站） / **openclawx**（其他 OpenClawX 节点）；Gateway/Desktop 通过 proxy 适配器统一调用 runForChannelStream 等 |
| 工具 | read/write/edit、bash、find/grep/ls、browser、install-skill、save-experience |
| 技能 | SKILL.md 规范，多路径加载，formatSkillsForPrompt 注入 system prompt |

### Desktop 后端（NestJS）

| 类别 | 技术 |
|------|------|
| 框架 | NestJS 10、Express、Socket.io |
| 前缀 | `server-api` |
| 模块 | Database · Agents · AgentConfig · Skills · Config · Auth · Users · Workspace · Tasks · Usage |
| 数据 | sql.js（SQLite WASM，无需预编译） |

### Desktop 前端（Electron + Vue）

| 类别 | 技术 |
|------|------|
| 壳子 | Electron 28 |
| 前端 | Vue 3、Vue Router、Pinia |
| 构建 | Vite 5 |
| 通信 | axios、socket.io-client |
| 视图 | Dashboard、Agents、AgentChat/AgentDetail、Sessions、Skills、Settings、Tasks、WorkResults、Workspace、Login |
| 国际化 | 自研 useI18n + locales (zh/en) |

### 记忆与向量

| 类别 | 技术 |
|------|------|
| 向量索引 | Vectra（LocalIndex） |
| 嵌入 | 远端 API（config.json 中 RAG 知识库配置的 embedding 模型；未配置时长记忆空转） |
| 扩展 | compaction-extension（会话压缩、摘要入 prompt） |
| 持久化 | 与 agent 目录一致的 memory 目录、sql.js（若用于元数据） |

---

# 一、安装与部署

安装与部署按**安装方式**划分：npm、Docker、Desktop 安装包。任选其一即可使用对应端的 CLI、Web 或 Desktop。

## 环境要求

- **Node.js** ≥ 20（npm 安装与本地开发必需）
- 可选：按所用 Provider 配置 API Key（如 `OPENAI_API_KEY`、`DEEPSEEK_API_KEY`）

---

## 1.1 npm 安装

适用于：使用 **CLI**，或在自有环境中运行 **Gateway（Web）**。

### 前置环境准备

需先安装 **Node.js 20+**（Node >=20）。任选一种方式安装即可：

| 方式 | 说明 |
|------|------|
| **官网安装包** | 打开 [nodejs.org](https://nodejs.org/)，下载 LTS 并安装；安装后终端执行 `node -v` 应显示 v20.x 或更高。 |
| **nvm（推荐）** | 多版本切换方便：`curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh \| bash`，重启终端后 `nvm install 20`、`nvm use 20`。 |
| **macOS (Homebrew)** | `brew install node@20`，或 `brew install nvm` 再用 nvm 安装 20。 |
| **Windows** | 使用 [nodejs.org](https://nodejs.org/) 安装包，或 `winget install OpenJS.NodeJS.LTS`。 |
| **Linux** | 使用发行版包管理器（如 `apt install nodejs`）或 [nvm](https://github.com/nvm-sh/nvm) 安装。 |

安装后请确认：

```bash
node -v   # 应为 v20.x 或 v22.x
npm -v    # 能正常输出版本号
```

### 安装命令

```bash
# 全局安装（测试过 node 版本：20/22；24 太新，部分库需本地编译环境）
npm install -g @next-open-ai/openclawx
```

安装后可直接使用 `openbot` 命令（见下方「使用方式」）。若需从源码构建再安装：

```bash
git clone <repo>
cd openclawx
npm install
npm run build
npm link   # 或 npm install -g . 本地全局安装
```

---

## 1.2 Docker 部署

适用于：在服务器或容器环境中运行 **Gateway**，供 Web/其他客户端连接。

> **说明**：Docker 镜像与编排正在规划中，当前推荐使用 npm 全局安装后执行 `openbot gateway` 部署网关。

规划中的使用方式示例：

```bash
# 示例（以实际仓库/镜像名为准）
# docker pull next-open-ai/openclawx
# docker run -p 38080:38080 -e OPENAI_API_KEY=xxx next-open-ai/openclawx gateway
```

---

## 1.3 Desktop 安装包

适用于：仅使用 **桌面端**，无需 Node 环境。

- 从 [Releases](https://github.com/next-open-ai/openclawx/releases) 下载对应平台的安装包（macOS / Windows）。
- 安装后启动 OpenClawX，按界面引导配置 API Key 与默认模型即可使用。

**macOS 若提示「已损坏、无法打开」**：因安装包未做 Apple 公证，从浏览器下载后会被系统加上「隔离」属性，出现“已损坏”的误报。请用**终端**去掉隔离属性后即可正常打开（一次性操作）：

1. 将下载的 `.dmg` 打开，把 `OpenBot.app` 拖到「应用程序」文件夹（或你想放的目录）。
2. 打开「终端」（应用程序 → 实用工具 → 终端），执行（路径按你实际放置位置修改）：
   ```bash
   xattr -c /Applications/OpenClawX.app
   find /Applications/OpenClawX.app -exec xattr -c {} \; 2>/dev/null
   ```
   若系统支持递归可简化为：`xattr -cr /Applications/OpenClawX.app`
3. 之后像普通应用一样打开 OpenClawX 即可，无需再右键或重复操作。

安装包由仓库通过 **Desktop 打包** 流程生成（见下方「三、开发 → 3.3 Desktop 开发 → Desktop 打包」）。

首次使用建议在设置中配置默认 Provider/模型，或通过 CLI 执行 `openbot login <provider> <apiKey> [model]` / `openbot config set-model <provider> <modelId>`（与桌面端共用 `~/.openbot/desktop/` 配置）。

---

# 二、使用方式

按**使用端**划分：CLI、Web、Desktop；另支持**飞书、钉钉、Telegram** 等通道（见 2.4）；后续将支持 iOS、Android 等。

## 2.1 CLI

在已通过 **npm 安装** 或 **源码构建并 link** 的环境中，在终端使用 `openbot`。

```bash
# 直接对话（使用默认 workspace 与技能）
openbot "总结一下当前有哪些技能"

# 指定技能路径
openbot -s ./skills "用 find-skills 搜一下 PDF 相关技能"

# 仅打印 system/user prompt，不调 LLM
openbot --dry-run --prompt "查北京天气"

# 指定模型与 provider（覆盖桌面缺省）
openbot --model deepseek-chat --provider deepseek "写一段 TypeScript 示例"
```

### CLI 配置（与桌面端共用）

CLI 与桌面端共用**桌面配置**（`~/.openbot/desktop/`）。主要文件：

- **config.json**：全局缺省 provider/model、**defaultModelItemCode**（缺省模型在 configuredModels 中的唯一标识）、缺省智能体 id（`defaultAgentId`）、各 provider 的 API Key/baseUrl、已配置模型列表（configuredModels）等。
- **agents.json**：智能体列表；每个智能体可配置 provider、model、**modelItemCode**（匹配 configuredModels）、工作区。**执行方式**可为 **local** / **coze** / **openclawx**。Coze 代理：`execution: "coze"`，并配置 **region**（`cn` 国内 / `com` 国际）、**coze.cn** / **coze.com**（各含 botId、apiKey），不暴露 endpoint。OpenClawX 代理：`execution: "openclawx"`，配置 **openclawx.baseUrl**、**openclawx.apiKey**（可选）。
- **provider-support.json**：Provider 与模型目录，供设置页下拉选择。

| 操作 | 命令 | 说明 |
|------|------|------|
| 保存 API Key（可选指定模型） | `openbot login <provider> <apiKey> [model]` | 写入 config.json；不传 model 时取该 provider 第一个模型并补齐缺省配置，可直接运行 |
| 设置缺省模型 | `openbot config set-model <provider> <modelId>` | 设置全局缺省 provider、model 及 defaultModelItemCode |
| 查看配置 | `openbot config list` | 列出 providers 与缺省模型 |
| 同步到 Agent 目录 | `openbot config sync` | 生成并写入 `~/.openbot/agent/models.json` |

**首次使用建议**：

```bash
# 方式一：login 后直接对话（不传 model 时自动用该 provider 第一个模型）
openbot login deepseek YOUR_DEEPSEEK_API_KEY
openbot "总结一下当前有哪些技能"

# 方式二：指定模型再 login
openbot login deepseek YOUR_DEEPSEEK_API_KEY deepseek-reasoner
openbot "总结一下当前有哪些技能"

# 方式三：先 login 再单独设置缺省模型
openbot login deepseek YOUR_DEEPSEEK_API_KEY
openbot config set-model deepseek deepseek-chat
openbot config sync
openbot "总结一下当前有哪些技能"
```

未在命令行指定 `--provider` / `--model` 时，CLI 使用缺省智能体对应的配置；单次可用 `--provider`、`--model`、`--api-key` 覆盖。未在配置中保存 API Key 时，会回退到环境变量（如 `OPENAI_API_KEY`、`DEEPSEEK_API_KEY`）。

---

## 2.2 Web

通过 **WebSocket 网关** 使用 OpenBot：先启动网关，再通过 Web 客户端连接。

```bash
# 启动网关（默认端口 38080）
openclawx gateway --port 38080
```

若需网关开机/登录自启，可执行 `openbot service install`（支持 Linux / macOS / Windows）；移除自启用 `openbot service uninstall`，停止当前网关用 `openbot service stop`。

客户端连接 `ws://localhost:38080`，使用 JSON-RPC 调用 `connect`、`agent.chat`、`agent.cancel` 等（详见下方「Gateway API 简述」）。  
前端可自行实现或使用仓库内 Web 示例（若有）。

---

## 2.3 Desktop

- **通过安装包**：安装后直接打开 OpenBot Desktop，登录/配置后即可使用桌面界面（会话、智能体、技能、任务、工作区等）。
- **通过源码**：在「开发」章节中运行 `npm run desktop:dev` 启动开发版桌面。

桌面端与 CLI 共用同一套配置与 Agent 核心，同一台机器上配置一次即可双端使用。

---

## 2.4 通道支持

除 CLI、Web、Desktop 外，OpenClawX 支持通过**通道**将 Agent 对接到第三方 IM/协作平台。通道在 Gateway 启动时根据配置注册并运行：入站消息经统一格式进入 Agent，回复再经该通道发回平台。

### 已支持通道概览

| 通道 | 入站方式 | 出站/流式 | 会话 ID 格式 |
|------|----------|-----------|----------------|
| **飞书** | WebSocket 事件订阅（im.message.receive_v1） | 开放 API + 流式卡片更新 | `channel:feishu:<chat_id>` |
| **钉钉** | dingtalk-stream SDK（Stream 模式） | sessionWebhook POST | `channel:dingtalk:<conversationId>` |
| **Telegram** | 长轮询 getUpdates | sendMessage / editMessageText 流式更新 | `channel:telegram:<chat_id>` |

### 飞书

**说明**：飞书通道通过飞书开放平台与机器人对接。入站使用飞书官方 **WebSocket 事件订阅**（`im.message.receive_v1`）接收用户消息；出站使用 **开放 API** 发送回复。支持**流式输出**：先发一条「思考中」的互动卡片，再随 Agent 生成内容逐次更新同一条卡片，直至整轮对话结束（`agent_end`）。

- **会话与 Agent**：同一飞书会话（单聊或群聊对应一个 `chat_id`）对应一个 Agent Session（`channel:feishu:<chat_id>`），由通道配置中的 `defaultAgentId` 指定使用哪个智能体。
- **能力**：单聊、群聊均可；支持文本消息与流式卡片展示；`turn_end` / `agent_end` 事件会向各端广播，便于前端或其它通道按需处理。

**配置**：enabled、appId、appSecret、defaultAgentId。**用法**：飞书开放平台创建自建应用、开通「机器人」与「接收消息」、事件订阅选 WebSocket；OpenClawX **设置 → 通道** 勾选「启用飞书」并填写 App ID、App Secret → 保存后**重启 Gateway**；在飞书内私聊或群聊 @ 机器人即可，回复以流式卡片更新。也可直接编辑 `~/.openbot/desktop/config.json` 中 `channels.feishu`。

### 钉钉

**说明**：钉钉通道使用 **dingtalk-stream** SDK 的 **Stream 模式**接收机器人消息，通过消息中的 `sessionWebhook` 回传回复；回复发送完成后需 ack 避免钉钉重试。支持单聊、群聊及流式回复。

- **会话与 Agent**：同一钉钉会话（conversationId）对应一个 Agent Session（`channel:dingtalk:<conversationId>`），由通道配置中的 `defaultAgentId` 指定智能体。

**配置**：enabled、clientId、clientSecret、defaultAgentId。**用法**：钉钉开发者后台创建企业内部应用、添加机器人能力并选择 **Stream 模式**；OpenClawX **设置 → 通道** 启用钉钉并填写 Client ID、Client Secret → 保存后**重启 Gateway**。在钉钉内与机器人对话即可。也可编辑 `config.json` 中 `channels.dingtalk`。

### Telegram

**说明**：Telegram 通道使用官方推荐的 **长轮询**（getUpdates）接收消息，无需公网 URL。出站使用 `sendMessage` 发送、`editMessageText` 流式更新同一条消息，直至整轮结束。

- **会话与 Agent**：同一 Telegram 会话（chat_id）对应一个 Agent Session（`channel:telegram:<chat_id>`），由通道配置中的 `defaultAgentId` 指定智能体。

**配置**：enabled、botToken、defaultAgentId。**用法**：通过 [@BotFather](https://t.me/BotFather) 获取 Bot Token；OpenClawX **设置 → 通道** 启用 Telegram 并填写 Bot Token → 保存后**重启 Gateway**。在 Telegram 内与机器人对话即可。也可编辑 `config.json` 中 `channels.telegram`。

未配置或未启用某通道时，Gateway 会跳过该通道启动；若已启用但必填项为空，控制台会提示到「设置 → 通道」检查。

### 2.4.1 代理模式与多节点协作

智能体除在本机运行（**local**）外，可配置为**代理模式**，将对话转发至 Coze 或另一台 OpenClawX，实现生态接入与多节点协作。

| 模式 | 说明 | 配置要点 |
|------|------|----------|
| **local** | 本机执行，使用当前模型的 pi-coding-agent 与 Skills | 默认；无需额外配置 |
| **coze** | 代理至 Coze 平台 | 在桌面端「智能体 → 编辑 → 执行方式」选 Coze；**站点**选国内(cn)或国际(com)；分别填写该站点的 **Bot ID**、**Access Token**（PAT / OAuth 2.0 / JWT 等）。`agents.json` 中对应智能体为 `"execution": "coze"`，并含 `coze.region`、`coze.cn` / `coze.com`（botId、apiKey） |
| **openclawx** | 代理至其他 OpenClawX 实例（多节点） | 执行方式选 OpenClawX；填写目标实例 **baseUrl**（如 `http://另一台机器:38080`）、可选 **API Key**。`agents.json` 中为 `"execution": "openclawx"`，含 `openclawx.baseUrl`、`openclawx.apiKey`（可选） |

- **入口**：桌面端「设置」→「智能体」中新建/编辑智能体时可选择执行方式；通道使用的默认智能体也可设为 Coze 或 OpenClawX 代理。
- **多节点**：多台机器各跑一个 OpenClawX Gateway，将部分智能体指向对方 baseUrl，即可实现分工、专机专用或负载均衡。

---

## 2.5 即将支持

**通道与终端**

| 端 | 说明 |
|----|------|
| **飞书** | 已支持，见上文「2.4 通道支持」。 |
| **钉钉** | 已支持，见上文「2.4 通道支持」。 |
| **Telegram** | 已支持，见上文「2.4 通道支持」。 |
| **iOS** | 规划中 |
| **Android** | 规划中 |

上述端将通过 WebSocket Gateway 或专用适配与现有 Agent 核心对接。

**生态与协议**

| 方向 | 说明 |
|------|------|
| **MCP** | 规划中：支持 MCP 协议，降低 Token 消耗与大模型幻觉，与 Skill 自我发现/迭代形成互补 |
| **Coze 生态** | **已支持**：智能体执行方式可选 coze，按站点（国内 cn / 国际 com）配置 Bot ID 与 Access Token，桌面端与通道均可使用 |
| **OpenClawX 多节点** | **已支持**：执行方式可选 openclawx，通过 baseUrl（及可选 apiKey）将对话代理到另一 OpenClawX 实例，实现多节点协作与负载分工 |

文档与发布节奏后续更新。

---

# 三、开发

面向**参与 OpenBot 源码开发**的读者，按形态分为 CLI、Web（Gateway + 前端）、Desktop 三部分。

## 环境与依赖

- Node.js ≥ 20
- 仓库克隆后安装依赖并构建：

```bash
git clone <repo>
cd openclawx
npm install
npm run build
```

---

## 3.1 CLI 开发

- 入口：`openbot` → bin → `dist/cli/cli.js`
- 技术：Commander（子命令 `gateway`、`login`、`config`、`service`）、TypeScript 5.7
- 配置与数据：`~/.openbot/agent`、`~/.openbot/desktop`（与桌面共用）
- Gateway 开机自启：`openbot service install` / `uninstall` / `stop`（见 `src/cli/service.ts`）

修改 CLI 后重新构建并本地安装：

```bash
npm run build
npm link
openbot --help
```

---

## 3.2 Web 开发（Gateway + 前端）

- **Gateway**：`src/gateway/`，默认端口 38080，可 `-p` 指定；单进程内嵌 Nest，按 path 分流（`/server-api`、`/ws`、静态资源等）；协议 JSON-RPC over WebSocket；职责包括连接管理、消息路由、鉴权、静态资源。
- **方法**：`connect`、`agent.chat`、`agent.cancel`、`subscribe_session`、`unsubscribe_session` 等。

本地启动网关：

```bash
npm run build
openbot gateway --port 38080
```

若仓库内有独立 Web 前端工程，则分别启动 Gateway 与前端 dev server，前端通过 `ws://localhost:38080` 连接。

---

## 3.3 Desktop 开发

- **后端**：NestJS（`src/server/`），前缀 `server-api`，默认端口 38081；Gateway 内嵌时直接挂载该 Express，无独立子进程。
- **前端**：Electron 28 + Vue 3 + Pinia + Vite 5，位于 `apps/desktop/`。

```bash
# 先构建核心（若未构建）
npm run build

# 开发模式（Vite 热更 + Electron）
npm run desktop:dev

# 仅安装桌面依赖
npm run desktop:install
```

### Desktop 打包

从源码构建可安装的桌面安装包（DMG/NSIS/AppImage），供发布或本地安装使用。

**命令（在仓库根目录执行）：**

```bash
npm run desktop:pack
```

该命令会依次执行：

1. **根目录构建**：`npm run build`，生成 `dist/`（含 Gateway、Server、Agent 等）。
2. **桌面构建**：`cd apps/desktop && npm run build`，其中包含：
   - **build:gateway**：若需则再次构建根目录 `dist`；
   - **build:copy-gateway**：将根目录 `dist` 复制到 `apps/desktop/gateway-dist`，写入 `package.json`（`type: "module"` + 生产依赖），并执行 `npm install --production`，得到带 `node_modules` 的 gateway 运行时；
   - **build:renderer**：Vite 构建前端到 `renderer/dist`；
   - **electron-builder**：打包为各平台安装包，并将 `gateway-dist` 作为 **extraResources** 拷贝到应用内 `Contents/Resources/dist`（含 Gateway 代码与依赖），无需用户安装 Node 即可运行。

**产出物：**

- **macOS**：`apps/desktop/dist/` 下生成 `.dmg`、`.zip`（如 `OpenBot Desktop-0.1.1-arm64.dmg`）；
- **Windows**：nsis 安装程序；
- **Linux**：AppImage。

安装包安装后，Gateway 与前端均内嵌在应用内，用户无需单独安装 Node.js。

---

## 测试

```bash
# 单元/集成测试（含 config、gateway、server e2e）
npm test

# 仅 e2e
npm run test:e2e

# 记忆相关测试
npm run test:memory
```

测试分布：`test/config/` 桌面配置、`test/gateway/` 网关、`test/server/` Nest 后端 e2e。

---

# 附录

## Gateway API 简述

- **请求**：`{ "type": "request", "id": "<id>", "method": "<method>", "params": { ... } }`
- **成功响应**：`{ "type": "response", "id": "<id>", "result": { ... } }`
- **错误响应**：`{ "type": "response", "id": "<id>", "error": { "message": "..." } }`
- **服务端事件**：如 `agent.chunk`（流式输出）、`agent.tool`（工具调用）等，格式为 `{ "type": "event", "event": "...", "payload": { ... } }`

常用流程：先 `connect` 建立会话，再通过 `agent.chat` 发送消息并接收流式/事件；`agent.cancel` 取消当前任务。

---

### 社区与交流

扫码加入交流群：

![OpenClawX 交流群](docs/group-1.png)

---

## 许可证

MIT
