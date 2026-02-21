# 快速开始

本文帮助你在约 5 分钟内完成安装、首次对话，并了解桌面端与通道的入口。

---

## 1. 选择安装方式

| 方式 | 适用场景 | 文档 |
|------|----------|------|
| **npm 安装** | 使用 CLI 或自建环境跑 Gateway | [安装与部署 → npm](installation.md#npm-安装) |
| **Desktop 安装包** | 仅用桌面端，无需 Node | [安装与部署 → Desktop](installation.md#desktop-安装包) |
| **Docker** | 容器化部署（规划中） | [安装与部署](installation.md) |

---

## 2. 最快路径：npm + CLI 对话

```bash
# 全局安装
npm install -g @next-open-ai/openclawx

# 登录 Provider（以 DeepSeek 为例，不传 model 则用该 provider 第一个模型）
openbot login deepseek YOUR_DEEPSEEK_API_KEY

# 直接对话
openbot "总结一下当前有哪些技能"
```

未在命令行指定 `--provider` / `--model` 时，将使用桌面缺省智能体配置；也可用 `openbot config set-model deepseek deepseek-chat` 设置缺省模型。

---

## 3. 桌面端入口

- **安装包用户**：安装后打开 OpenClawX，在设置中配置 API Key 与默认模型即可使用。
- **npm 用户**：CLI 与桌面端共用 `~/.openbot/desktop/` 配置，配置一次即可在桌面端直接使用会话、智能体、技能等。

开发环境运行桌面：`npm run desktop:dev`（见 [桌面端使用](desktop-usage.md)）。

---

## 4. Web / Gateway 入口

```bash
# 启动网关（默认端口 38080）
openbot gateway
# 或
openbot gateway --port 38080
```

浏览器或客户端连接 `ws://localhost:38080`，使用 JSON-RPC 调用 `connect`、`agent.chat` 等。详见 [Web 与 Gateway](gateway-web.md)。

---

## 5. 通道入口（飞书 / 钉钉 / Telegram）

1. 在 **设置 → 通道** 中启用对应通道并填写凭证（飞书 App ID/Secret、钉钉 Client ID/Secret、Telegram Bot Token）。
2. 保存后 **重启 Gateway**（`openbot gateway` 或安装包内自带的网关）。
3. 在对应 IM 内 @ 机器人或与机器人对话即可。

详见 [通道配置](../configuration/channels.md)。

---

## 下一步

- [安装与部署](installation.md)：环境要求、npm/Docker/Desktop 详细步骤。
- [CLI 使用](cli-usage.md)：更多命令、技能路径、开机自启。
- [智能体配置](../configuration/agents.md)：本机 / Coze / OpenClawX 执行方式。

[← 返回文档首页](../README.md)
