# OpenBot
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**一个桌面级OpenClaw实现** 是基于 Agent Skills的**一体化 AI 助手平台**，核心部分支持 CLI、WebSocket 网关与桌面端。除提供可自我升级扩展的 AI Agent 引擎及多通道、多终端接入外，后续将支持 MCP 以降低 Token 消耗与大模型幻觉，并接入现有AI Agent 生态，成为一个互联互通的Agent平台。

---

## 特性概览

| 能力 | 说明 |
|------|------|
| **技能架构** | 基于 Agent Skills 规范，支持多路径加载、本地安装与动态扩展；支持技能自我发现与自我迭代 |
| **编码智能体** | 集成 [pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)，支持多轮工具调用与代码执行 |
| **浏览器自动化** | 内置 [agent-browser](https://www.npmjs.com/package/agent-browser)，可导航、填表、截图与数据抓取 |
| **长期记忆** | 向量存储（Vectra）+ 本地嵌入，支持经验总结与会话压缩（compaction） |
| **多端接入** | CLI、WebSocket 网关、Electron 桌面端，同一套 Agent 核心；各端技术栈见下方「各端技术栈」 |
| **MCP（规划中）** | 为降低 Token 消耗与大模型幻觉，后续将支持 MCP（Model Context Protocol） |
| **生态接入（规划中）** | 接入现有 AI Agent 生态，下一步计划接入 Coze 生态 |

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
│  pi-coding-agent│    │  Agents · Skills · Tasks    │    │  compaction 扩展     │
│  pi-ai 多模型   │    │  Auth · Users · Workspace   │    │  sql.js              │
└────────┬────────┘    └─────────────────────────────┘    └─────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Tools: read/write/edit · bash · find/grep/ls · browser · install-skill ·   │
│         save-experience (写入记忆)                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **CLI**：直接调用 Agent 核心，单次提示或批量脚本；可启动 Gateway（`openbot gateway`）及配置开机自启（`openbot service install/uninstall`）。
- **WebSocket Gateway**（`src/gateway/`）：单进程内嵌 Nest，对外提供 WebSocket（JSON-RPC）与 HTTP；按 path 分流：`/server-api` 走 Nest、`/ws` 为 Agent 对话、`/ws/voice`/`/sse`/`/channel` 为扩展占位，其余为静态资源。供 Web/移动端连接；支持以开机/登录自启方式常驻（Linux cron、macOS LaunchAgent、Windows 计划任务）。
- **Desktop 后端**（`src/server/`）：NestJS HTTP API，即 **server-api**；可被 Gateway 内嵌或独立监听（默认端口 38081）。会话、智能体配置、技能、任务、工作区、鉴权等由本模块提供。
- **Desktop**：Electron 包一层 Vue 前端 + 上述后端；通过 Gateway 或直连 Desktop 后端与 Agent 通信。
- **Agent 核心**：统一由 `AgentManager` 管理会话、技能注入与工具注册；记忆与 compaction 作为扩展参与 system prompt 与经验写入。

### 项目目录结构

```
openbot/
├── src/                    # 源码（构建输出 dist/）
│   ├── core/               # 公共核心，CLI 与 Gateway 共用
│   │   ├── agent/          # AgentManager、run、技能与配置
│   │   ├── config/         # 桌面配置（~/.openbot/desktop）
│   │   ├── memory/         # 向量存储、嵌入、compaction
│   │   ├── installer/      # 技能安装
│   │   └── tools/          # 内置工具（browser、install-skill、save-experience 等）
│   ├── cli/                # CLI 入口与 service 子命令
│   │   ├── cli.ts          # 主入口，构建为 dist/cli/cli.js
│   │   └── service.ts      # 开机自启 install/uninstall/stop
│   ├── gateway/            # WebSocket 网关（内嵌 Nest、path 分流）
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
└── skills/                 # 内置技能（find-skills、agent-browser）
```

### 目录与模块对应

| 目录 | 说明 |
|------|------|
| `src/core/` | **公共核心**：`agent/`（AgentManager、pi-coding-agent）、`config/`（桌面配置）、`memory/`、`installer/`、`tools/`；CLI 与 Gateway 共用。 |
| `src/cli/` | **CLI**：`cli.ts` 主入口（构建为 `dist/cli/cli.js`），`service.ts` 提供开机自启（install/uninstall/stop）。 |
| `src/gateway/` | **WebSocket 网关**：单进程内嵌 Nest，按 path 分流：`/server-api`、`/ws`、`/ws/voice`、`/sse`、`/channel`、`/health`、静态资源（`apps/desktop/renderer/dist`）。 |
| `src/server/` | **Desktop 后端**（NestJS），HTTP API 前缀 `server-api`；可内嵌到 Gateway 或独立监听。 |
| `apps/desktop/` | **桌面端**（Electron + Vue），前端构建产物由 Gateway 提供。 |
| `deploy/` | Dockerfile、K8s 等部署配置。 |
| `test/` | 单元与 e2e 测试（config、gateway、server、installer）。 |
| `examples/` | 示例工作区、gateway 客户端等。真实工作区根目录为 `~/.openbot/workspace/`。 |
| `skills/` | 内置技能（SKILL.md 规范）。 |

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

### 内置技能

| 技能 | 说明 |
|------|------|
| find-skills | 发现与安装 Cursor/Agent 技能 |
| agent-browser | 浏览器自动化（Playwright/agent-browser CLI） |

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
npm install -g @next-open-ai/openbot
```

安装后可直接使用 `openbot` 命令（见下方「使用方式」）。若需从源码构建再安装：

```bash
git clone <repo>
cd openbot
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
# docker pull next-open-ai/openbot
# docker run -p 38080:38080 -e OPENAI_API_KEY=xxx next-open-ai/openbot gateway
```

---

## 1.3 Desktop 安装包

适用于：仅使用 **桌面端**，无需 Node 环境。

- 从 [Releases](https://github.com/next-open-ai/openbot/releases) 下载对应平台的安装包（macOS / Windows）。
- 安装后启动 OpenBot，按界面引导配置 API Key 与默认模型即可使用。

**macOS 若提示「已损坏、无法打开」**：因安装包未做 Apple 公证，从浏览器下载后会被系统加上「隔离」属性，出现“已损坏”的误报。请用**终端**去掉隔离属性后即可正常打开（一次性操作）：

1. 将下载的 `.dmg` 打开，把 `OpenBot.app` 拖到「应用程序」文件夹（或你想放的目录）。
2. 打开「终端」（应用程序 → 实用工具 → 终端），执行（路径按你实际放置位置修改）：
   ```bash
   xattr -c /Applications/OpenBot.app
   find /Applications/OpenBot.app -exec xattr -c {} \; 2>/dev/null
   ```
   若系统支持递归可简化为：`xattr -cr /Applications/OpenBot.app`
3. 之后像普通应用一样打开 OpenBot 即可，无需再右键或重复操作。

安装包由仓库通过 **Desktop 打包** 流程生成（见下方「三、开发 → 3.3 Desktop 开发 → Desktop 打包」）。

首次使用建议在设置中配置默认 Provider/模型，或通过 CLI 执行 `openbot login <provider> <apiKey> [model]` / `openbot config set-model <provider> <modelId>`（与桌面端共用 `~/.openbot/desktop/` 配置）。

---

# 二、使用方式

按**使用端**划分：CLI、Web、Desktop；后续将支持 iOS、Android、飞书等。

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
- **agents.json**：智能体列表；每个智能体可配置 provider、model、**modelItemCode**（匹配 configuredModels）、工作区。
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
openbot gateway --port 38080
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

## 2.4 即将支持

**通道与终端**

| 端 | 说明 |
|----|------|
| **iOS** | 规划中 |
| **Android** | 规划中 |
| **飞书** | 规划中 |

上述端将通过 WebSocket Gateway 或专用适配与现有 Agent 核心对接。

**生态与协议**

| 方向 | 说明 |
|------|------|
| **MCP** | 支持 MCP 协议，降低 Token 消耗与大模型幻觉，与 Skill 自我发现/迭代形成互补 |
| **Coze 生态** | 接入现有 AI Agent 生态，下一步计划接入 Coze |

文档与发布节奏后续更新。

---

# 三、开发

面向**参与 OpenBot 源码开发**的读者，按形态分为 CLI、Web（Gateway + 前端）、Desktop 三部分。

## 环境与依赖

- Node.js ≥ 20
- 仓库克隆后安装依赖并构建：

```bash
git clone <repo>
cd openbot
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

## 各端技术栈

详见上文「各端技术栈」章节（CLI、WebSocket Gateway、Agent 核心、Desktop 后端/前端、记忆与向量、内置技能）。

---

## 内置技能

| 技能 | 说明 |
|------|------|
| find-skills | 发现与安装 Cursor/Agent 技能 |
| agent-browser | 浏览器自动化（Playwright/agent-browser CLI） |

---

## 许可证

MIT
