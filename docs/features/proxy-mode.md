# 代理模式与多节点协作

智能体除在本机运行（**local**）外，可配置为**代理模式**，将对话转发至 Coze 或另一台 OpenClawX，实现生态接入与多节点协作。

---

## 三种执行方式

| 模式 | 说明 | 配置要点 |
|------|------|----------|
| **local** | 本机执行，使用当前模型的 pi-coding-agent 与 Skills | 默认；无需额外配置 |
| **coze** | 代理至 Coze 平台 | 执行方式选 Coze；**站点**选国内(cn)或国际(com)；分别填写该站点的 **Bot ID**、**Access Token**（PAT / OAuth 2.0 / JWT 等）。`agents.json` 中为 `execution: "coze"`，并含 `coze.region`、`coze.cn` / `coze.com`（botId、apiKey） |
| **openclawx** | 代理至其他 OpenClawX 实例（多节点） | 执行方式选 OpenClawX；填写目标实例 **baseUrl**（如 `http://另一台机器:38080`）、可选 **API Key**。`agents.json` 中为 `execution: "openclawx"`，含 `openclawx.baseUrl`、`openclawx.apiKey`（可选） |

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

## 配置入口

- **桌面端**：「设置 → 智能体」中新建/编辑智能体时可选择执行方式并填写对应凭证。
- **配置文件**：编辑 `~/.openbot/desktop/agents.json`，为智能体设置 `execution` 及 coze / openclawx 对应字段。详见 [智能体配置](../configuration/agents.md)。

---

## 下一步

- [智能体配置](../configuration/agents.md)
- [配置概览](../configuration/config-overview.md)

[← 返回文档首页](../README.md)
