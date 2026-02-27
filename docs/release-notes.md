# 发布说明 (Release Notes)

本文档记录 OpenClawX 各版本的功能更新与问题修复。

---

## [0.8.38] - 当前

### 在线搜索（web_search）

- **多种在线搜索能力**
  - 智能体新增 **在线搜索** 工具（`web_search`）：模型在对话中可按需调用以获取联网信息（如实时新闻、天气、概念解释等）。
  - 支持多 Provider：**DuckDuckGo**（默认，无需 API Key，基于 duck-duck-scrape）；**Brave Search**（需在设置中配置 Brave API Key 或环境变量 `BRAVE_API_KEY`）。
  - 智能体详情 → 基本配置中可**按智能体启用/关闭**在线搜索，并选择 Provider（DuckDuckGo 或 Brave）；设置 → 通用中可配置 **Brave Search API Key**。
  - 当所选 Provider 不可用（如选择了 Brave 但未配置 Key）时，工具以**空转**方式注册：模型仍可见并调用 `web_search`，执行时返回友好提示，引导用户配置或切换 Provider。

### 其他

- 问题修复与依赖更新。

---

## [0.8.36]

### MCP 与配置

- **MCP 加载优化**
  - MCP 服务器加载与工具注册流程优化，会话创建时更稳定、可观测；连接与重试进度经统一出口推送，便于前端展示。
- **配置优化**
  - 智能体与全局配置的读写与校验优化，MCP 等配置项的保存与生效更一致。

### 其他

- 问题修复与依赖更新。

---

## [0.8.32]

### 会话消息与 MCP

- **会话消息统一出口（session-outlet）**
  - 引入 `session-outlet` 模块：Gateway 启动时通过 `setSessionOutlet(outlet)` 注入全局出口，各模块仅需 `sessionId` + 消息即可经 `sendSessionMessage(sessionId, message)` 发送会话级系统消息，无需透传 outlet。
  - 通道、Desktop、Web 等端注册消费者后，可统一接收 `turn_end`、`agent_end`、`mcp.progress` 等系统消息；对话内 `//` 指令执行结果也经该出口以系统消息推送。

- **MCP 进度推送**
  - MCP 层不再透传 `sessionOutlet`：`getMcpToolDefinitions` 仅接收 `sessionId`，在连接/重试等进度时直接调用全局 `sendSessionMessage(sessionId, { type: "system", code: "mcp.progress", payload })`，与 Gateway 注入的出口解耦。

### 其他

- 问题修复与依赖更新。

---

## [0.8.28]

### 其他

- 问题修复与稳定性改进；Docker 与 CI 构建可用该版本 tag。

---

## [0.8.26]

### MCP 与 RPA（影刀）

- **MCP 支持**
  - 智能体已支持 [MCP](https://modelcontextprotocol.io/)（Model Context Protocol）：可为每个智能体配置多台 MCP 服务器（stdio 本地进程或 SSE 远程），会话创建时自动加载对应工具。
  - 配置方式：桌面端智能体详情 → MCP 配置 Tab；支持标准 JSON 格式（`mcpServers` 为对象，key 为服务器名称，value 为 command/args/env 或 url/headers），可单条表单编辑也可整段 JSON 编辑后应用。
  - 保存后通过「配置更新即生效」机制，下次使用该智能体对话时会自动用新配置重建会话，无需重启应用。

- **RPA（影刀）**
  - 通过 MCP 可接入影刀 RPA：在智能体 MCP 配置中添加 [yingdao-mcp-server](https://www.npmjs.com/package/yingdao-mcp-server)（如命令 `npx -y yingdao-mcp-server`，环境变量可选 `RPA_MODEL`、`SHADOWBOT_PATH`、`USER_FOLDER` 等），即可在对话中调用影刀自动化能力。

### 其他

- npm 打包已包含 `presets` 目录，通过 npm 安装后预装智能体与技能可正常合并到本地配置（需在包目录下执行或设置 `OPENBOT_PRESETS_DIR`）。

---

## [0.8.18]

### 智能体与工作区

- **删除智能体时的行为**
  - 删除智能体时，会同时删除该智能体对应工作区在**数据库**中的相关数据（会话、定时任务、收藏、token 使用记录等）。
  - 工作区在磁盘上的目录默认**保留**；删除确认弹窗中提供可选勾选项「同时删除该工作区在磁盘上的目录及文件」，勾选后才会删除磁盘目录。
  - 主智能体（default）对应的工作区目录不可删除。

### 对话与流式

- **中止/中断当前对话**
  - 输入框右侧的「中止」按钮可正确中断当前轮次：本地智能体通过 `session.abort()`，代理智能体（Coze/OpenClawX/OpenCode）通过注册的 AbortController 中止进行中的请求。
  - 前端会随之中止状态并恢复为可再次输入；支持通过 `agent.cancel` 传入 `agentId` 以精确定位会话。

### OpenCode 代理

- **流式回复**
  - OpenCode 代理的普通对话改为流式返回：使用 `promptAsync` + `event.subscribe()`，按 `message.part.updated`（含 `delta`）与 `session.idle` 推送内容，前端可逐字展示助手回复。
  - 仅转发助手消息的 part，过滤用户消息 part，避免用户问题被回显；发送 delta 时更新已发送长度，避免整段重复显示。

- **斜杠指令**
  - 统一使用 **`/command`** 形式：`/init`、`/help`、`/undo`、`/redo`、`/share` 等（输入框占位与说明已同步）。
  - `/init` 通过 `session.command({ command: "init", arguments })` 调用；失败时展示「执行失败」及原因，成功时展示「执行成功」或接口返回文案；单次请求超时调整为 5 分钟，避免大项目分析被过早中断。
  - `/undo`、`/redo` 改为使用 SDK 的 `session.revert` / `session.unrevert`，不再走 `session.command`，避免服务端 `command3.agent` 未定义报错；无可撤销消息时提示「没有可撤销的助手消息」。
  - `/share` 返回的分享链接会从接口 `data.share.url` 取出并回显到对话（如「分享链接：https://opncd.ai/share/xxx」）。
  - 指令执行失败时统一调用 `onDone()` 并展示可读错误信息，避免前端一直处于“执行中”状态。

- **错误展示**
  - OpenCode 相关错误统一经 `formatErrorMessage` 处理（含 `err.data?.message`），避免前端显示 `[object Object]`，改为可读的错误信息。

### 桌面端 UI

- **对话页**
  - 发送消息后、首包返回前，助手位置显示「思考中…」及三点跳动动画，表示正在执行。
  - 智能体选择区：容器与芯片样式优化（玻璃态、主题色高光）；左右滑动箭头改为圆形按钮与 SVG 图标，hover 时高亮。
  - 清除对话记录按钮从顶部右侧移至**顶部左侧**（与会话列表切换、标题同一行）。
- **主菜单（左侧边栏）**
  - 选中项去掉左侧竖条标记；选中态改为渐变背景、细边框与柔和阴影，风格与整体统一。
- **智能体列表页**
  - 左侧第一个 Tab 文案由「本地智能体」改为「**智能体**」；两个 Tab（智能体 / 代理智能体）字体加大（`font-size: var(--font-size-base)`），与页面风格一致。
- **智能体详情（代理智能体）**
  - 基本配置中移除「模型配置」与「是否使用经验（长记忆）」两项，仅保留图标、显示名、工作空间、描述与保存；左侧「基本配置」「代理配置」Tab 字体加大。

### 其他

- 修复 AgentConfigModule 与 ConfigModule/WorkspaceModule 的循环依赖，通过 `forwardRef` 正确加载模块。

---

## 版本格式说明

- 版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
- 日期格式为 `YYYY-MM-DD`，可选标注在版本后。
- 新增功能、行为变更与重要修复会在此记录，便于升级与排查问题。

---

*如有遗漏或需要补充的历史版本，可直接在本文件中按上述格式追加。*
