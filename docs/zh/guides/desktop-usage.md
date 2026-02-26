# 桌面端使用

OpenClawX Desktop 提供图形界面：会话、智能体、技能、任务、工作区、设置与通道配置等。本系统中「智能体」「助手」「专家」均指同一概念，可互换使用。

---

## 启动方式

| 方式 | 说明 |
|------|------|
| **安装包** | 安装后直接打开 OpenClawX，按引导配置 API Key 与默认模型 |
### Mac上安装使用（开源非签名发布版本）
   打开如果提示损坏无法使用，则需要如下操作：
   ```bash
   xattr -c /Applications/OpenClawX.app
   #或者
   find /Applications/OpenClawX.app -exec xattr -c {} \; 2>/dev/null
   ```
### Windows上安装使用（开源非签名发布版本）
   待更新


桌面端与 WEB端，CLI端 共用同一套配置（`~/.openbot/desktop/`）与 Agent 核心，同一台机器上配置一次即三端使用。

---

## 主要功能入口

- **Dashboard**：概览与快捷入口  
- **智能体（Agents）**：新建/编辑智能体，选择执行方式（本机 / Coze / OpenClawX / OpenCode）、模型、工作区  
- **会话（Sessions）**：历史会话与继续对话  
- **技能（Skills）**：查看与管理已加载技能  
- **任务（Tasks）**：任务列表与执行结果  
- **工作区（Workspace）**：工作区目录与文件  
- **设置（Settings）**：默认模型、API Key、**通道**（飞书/钉钉/Telegram）等  

更多**典型使用场景**（在对话框中整理下载目录、自动创建并切换智能体、为智能体安装技能、手工配置 MCP、绑定智能体做定时任务等）见 **[使用场景](usage-scenarios.md)**。

---

## 智能体与执行方式

在 **设置 → 智能体** 中可：

- 设置**默认智能体**（主智能体角标为「默认」）
- 新建/编辑智能体，选择**执行方式**：
  - **本机（local）**：使用当前模型的 pi-coding-agent 与 Skills
  - **Coze**：代理至 Coze 国内/国际站，需配置站点、Bot ID、Access Token
  - **OpenClawX**：代理至其他 OpenClawX 实例，需配置 baseUrl、可选 API Key
  - **OpenCode**：代理至 OpenCode 官方 Server（本地需先运行 `opencode serve`），支持 `/init`、`/undo`、`/redo`、`/share`、`/help` 等斜杠指令

通道使用的默认智能体也可设为 Coze、OpenClawX 或 OpenCode 代理。详见 [代理模式与多节点协作](../features/proxy-mode.md) 与 [智能体配置](../configuration/agents.md)。

---

## 对话内切换智能体：// 指令

在**桌面端、Web 端、以及各通道（飞书 / 钉钉 / Telegram）**的对话中，均可使用以 `//` 开头的指令，快速查询或切换当前会话使用的智能体，无需打开设置页。

| 输入 | 说明 |
|------|------|
| `//` 或 `// `（空格） | 切回**主智能体**（default），并提示「已切换到主智能体。」 |
| `//select` | 列出当前可用的智能体（名称与 id），并提示如何切换；不发送给智能体执行 |
| `//名称` 或 `//id` | 切换到指定智能体（按名称或 id 匹配）；若未找到则切回主智能体并提示 |
| `//名称(id)` | 同上，支持「名称(id)」形式同时匹配名称与 id |
| `//智能体名 后面跟消息` | 先切换到该智能体，再将「后面跟消息」作为用户消息发给该智能体 |

**示例**（在任意对话窗口输入）：

- 输入 `//select` → 查看当前可用智能体列表  
- 输入 `//` → 切回主智能体  
- 输入 `//编码助手` → 切换到「编码助手」智能体  
- 输入 `//编码助手 帮我写一段排序代码` → 先切换到编码助手，再发送「帮我写一段排序代码」

切换与列表查询由 Gateway 统一处理，**不会**把 `//` 指令内容发给智能体执行，因此不会触发多余回复或技能汇总。

---

## 通道配置

在 **设置 → 通道** 中启用并配置飞书、钉钉、Telegram。保存后需**重启 Gateway** 生效。详见 [通道配置](../configuration/channels.md)。

---

## 长记忆（RAG）与本地向量

智能体长记忆依赖文本向量（embedding）。桌面端优先使用**在线 RAG 模型**（若在设置中配置）；未配置或不可用时则尝试**本地模型**。

### Electron 下本地 embedding 优先级

桌面端本地向量**仅使用 node-llama-cpp (GGUF)**。默认使用 `embeddinggemma-300M-Q8_0.gguf`（约 0.6 GB），首次运行会按 node-llama-cpp 规则下载到 `~/.cache/llama`。可在桌面配置中设置 `rag.localModelPath`（如本地 GGUF 路径或 `hf:...` URI）覆盖默认模型。若加载失败并出现 `Unexpected token 'with'`，多为依赖链中某包在 ESM 下使用了禁止的 `with` 语句，可升级 Electron 至 Node 22+ 或**在设置中配置 RAG 在线模型**。

若本地 GGUF 不可用或日志出现「本地模型也不可用」，可**在设置中配置 RAG 在线模型**，长记忆同样可用。

### 为何 Electron 里本地模型常不可用？（同是 Node 环境）

桌面端和 CLI 虽都跑在 Node，但 **Electron 自带一套与系统 Node 不同的运行时**：

1. **原生模块（Native Addon）ABI 不一致**  
   **node-llama-cpp** 为 C++ 绑定，按 **Node 的 NODE_MODULE_VERSION（ABI）** 编译。用系统 Node 执行 `npm install` 时，预编译二进制是针对**系统 Node** 的；而 Electron 内置的是**另一版本 Node/V8**，ABI 不同，同一份 .node 在 Electron 主进程里要么加载失败，要么行为异常。

2. **让 Electron 正常使用本地 GGUF**  
   在**安装依赖后**、首次跑桌面开发或打包前，对 Electron 的 Node ABI 重新编译原生模块（含 **node-llama-cpp**）即可：

   - **开发环境**：在仓库根目录已执行 `npm install` 的前提下，进入桌面应用目录执行一次：
     ```bash
     cd apps/desktop && npm run rebuild:native
     ```
     之后再执行 `npm run desktop:dev`。本地 GGUF 即有机会在 Electron 中正常推理。
   - **打包安装包**：`npm run desktop:build` 会在复制 gateway 依赖后自动对 `gateway-dist` 内的原生模块执行 electron-rebuild，无需额外步骤。

   若 rebuild 后仍不可用，可继续使用**设置中的 RAG 在线模型**，长记忆同样可用。

3. **CLI / 纯 Node 为何可以**  
   CLI 使用系统 Node 启动，原生模块的预编译二进制与当前 Node 一致，加载和推理均可正常工作。

---

## 下一步

- [使用场景](usage-scenarios.md)：整理下载目录、创建/切换智能体、安装技能、MCP、定时任务等
- [Web 与 Gateway](gateway-web.md)
- [配置概览](../configuration/config-overview.md)
- [代理模式与多节点协作](../features/proxy-mode.md)

[← 返回文档首页](../README.md)
