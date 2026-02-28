# 代理模式与多节点协作

智能体除在本机运行（**local**）外，可配置为**代理模式**，将对话转发至 Coze、另一台 OpenClawX、[OpenCode](https://opencode.ai/) 官方 Server 或本机 **Claude Code** CLI，实现生态接入与多节点协作。

---

## 五种执行方式

| 模式 | 说明 | 配置要点 |
|------|------|----------|
| **local** | 本机执行，使用当前模型的 pi-coding-agent 与 Skills | 默认；无需额外配置 |
| **coze** | 代理至 Coze 平台 | 执行方式选 Coze；**站点**选国内(cn)或国际(com)；分别填写该站点的 **Bot ID**、**Access Token**（PAT / OAuth 2.0 / JWT 等）。`agents.json` 中为 `runnerType: "coze"`，并含 `coze.region`、`coze.cn` / `coze.com`（botId、apiKey） |
| **openclawx** | 代理至其他 OpenClawX 实例（多节点） | 执行方式选 OpenClawX；填写目标实例 **baseUrl**（如 `http://另一台机器:38080`）、可选 **API Key**。`agents.json` 中为 `runnerType: "openclawx"`，含 `openclawx.baseUrl`、`openclawx.apiKey`（可选） |
| **opencode** | 代理至 OpenCode 官方 Server | 执行方式选 OpenCode；本地模式需先运行 `opencode serve`（默认端口 4096），填写端口；远程模式填写地址与端口。可选密码、工作目录、默认模型。对话支持 `/init`、`/undo`、`/redo`、`/share`、`/help` 等斜杠指令，分享链接会回显到对话 |
| **claude_code** | 代理至本机 Claude Code CLI | 执行方式选 Claude Code；需本机已安装 `claude`（如 `npm install -g @anthropic-ai/claude-code`）并执行 `claude login`。可选工作目录（不填则使用智能体工作区）。`agents.json` 中为 `runnerType: "claude_code"`，可选 `claudeCode.workingDirectory` |

---

## Coze 接入

- 支持 **国内站**（api.coze.cn）与 **国际站**（api.coze.com），按站点分别配置 Bot ID 与 Access Token。
- Access Token 类型：PAT、OAuth 2.0、JWT/服务模式等，以 Coze 平台说明为准。
- 入口：桌面端「设置 → 智能体」中新建/编辑智能体，执行方式选 Coze；通道使用的默认智能体也可设为 Coze 智能体。

---

## OpenClawX 多节点协作

- 将智能体代理到另一台 OpenClawX 实例：配置 **baseUrl**（如 `http://另一台机器:38080`）、可选 **apiKey**。
- 多台机器各跑一个 OpenClawX Gateway，将部分智能体指向对方 baseUrl，即可实现分工、专机专用或负载均衡。

---

## OpenCode 代理

- 将智能体代理至 [OpenCode](https://opencode.ai/) 官方 Server：本地需先在本机运行 `opencode serve`（默认端口 4096），在桌面端选择执行方式 OpenCode、模式「本地」并填写端口；远程模式填写地址与端口。可选配置密码（对应服务端 `OPENCODE_SERVER_PASSWORD`）、工作目录、默认模型。
- 对话为流式回复；支持斜杠指令：`/init`（分析项目并生成 AGENTS.md）、`/undo`、`/redo`、`/share`（分享链接会回显）、`/help`。与 OpenCode TUI 使用方式一致。

---

## Claude Code 代理

- 将智能体代理至本机 [Claude Code](https://github.com/anthropics/claude-code) CLI：需先在本机安装 Claude Code（如 `npm install -g @anthropic-ai/claude-code`）并执行 `claude login` 完成鉴权。
- 在桌面端选择执行方式 **Claude Code**；可选配置**工作目录**（不填则使用该智能体对应工作区路径 `~/.openbot/workspace/<workspace>/`）。对话由 Claude Code CLI 执行，本机 0 Token 消耗。

---

## 配置入口

- **桌面端**：「设置 → 智能体」中新建/编辑智能体时可选择执行方式并填写对应凭证。
- **配置文件**：编辑 `~/.openbot/desktop/agents.json`，为智能体设置 `runnerType` 及 coze / openclawx / opencode / claude_code 对应字段。详见 [智能体配置](../configuration/agents.md)。

---

## 下一步

- [智能体配置](../configuration/agents.md)
- [配置概览](../configuration/config-overview.md)

[← 返回文档首页](../README.md)
