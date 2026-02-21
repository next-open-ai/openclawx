# 桌面端使用

OpenClawX Desktop 提供图形界面：会话、智能体、技能、任务、工作区、设置与通道配置等。

---

## 启动方式

| 方式 | 说明 |
|------|------|
| **安装包** | 安装后直接打开 OpenClawX，按引导配置 API Key 与默认模型 |
| **开发环境** | 在仓库根目录执行 `npm run desktop:dev` 启动开发版桌面 |

桌面端与 CLI 共用同一套配置（`~/.openbot/desktop/`）与 Agent 核心，同一台机器上配置一次即可双端使用。

---

## 主要功能入口

- **Dashboard**：概览与快捷入口  
- **智能体（Agents）**：新建/编辑智能体，选择执行方式（本机 / Coze / OpenClawX）、模型、工作区  
- **会话（Sessions）**：历史会话与继续对话  
- **技能（Skills）**：查看与管理已加载技能  
- **任务（Tasks）**：任务列表与执行结果  
- **工作区（Workspace）**：工作区目录与文件  
- **设置（Settings）**：默认模型、API Key、**通道**（飞书/钉钉/Telegram）等  

---

## 智能体与执行方式

在 **设置 → 智能体** 中可：

- 设置**默认智能体**（主智能体角标为「默认」）
- 新建/编辑智能体，选择**执行方式**：
  - **本机（local）**：使用当前模型的 pi-coding-agent 与 Skills
  - **Coze**：代理至 Coze 国内/国际站，需配置站点、Bot ID、Access Token
  - **OpenClawX**：代理至其他 OpenClawX 实例，需配置 baseUrl、可选 API Key

通道使用的默认智能体也可设为 Coze 或 OpenClawX 代理。详见 [代理模式与多节点协作](../features/proxy-mode.md) 与 [智能体配置](../configuration/agents.md)。

---

## 通道配置

在 **设置 → 通道** 中启用并配置飞书、钉钉、Telegram。保存后需**重启 Gateway** 生效。详见 [通道配置](../configuration/channels.md)。

---

## 下一步

- [Web 与 Gateway](gateway-web.md)
- [配置概览](../configuration/config-overview.md)
- [代理模式与多节点协作](../features/proxy-mode.md)

[← 返回文档首页](../README.md)
