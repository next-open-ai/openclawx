# Web 与 Gateway

通过 **WebSocket 网关** 使用 OpenClawX：先启动网关，再通过 Web 客户端或第三方 IM 通道连接。

**配置与访问地址**：可使用 **`http://localhost:38080`**（本机）或 **`http://你的IP:38080`**（局域网/远程）进行配置与使用。WebSocket 使用 `ws://` 同 host/端口（如 `ws://localhost:38080` 或 `ws://你的IP:38080`）；HTTP 接口（如 `/server-api`、`/health`）及静态资源均通过上述 HTTP 地址访问。

---

## 启动网关

**npm 方式**：

```bash
# 默认端口 38080
openbot gateway

# 指定端口
openbot gateway --port 38080
```

若需开机/登录自启：`openbot service install`；移除自启用 `openbot service uninstall`，停止当前网关用 `openbot service stop`。

**Docker 方式**：若通过 [Docker 部署](installation.md#docker-部署) 启动，服务同样监听 38080 端口。启动后在浏览器中打开 **`http://localhost:38080`** 或 **`http://宿主机IP:38080`** 即可进行配置与使用，与 npm 启动网关的 Web 使用方式一致。

---

## 路径与职责

| 路径 | 说明 |
|------|------|
| `/server-api` | Desktop 后端（NestJS）HTTP API |
| `/ws` | Agent 对话（JSON-RPC over WebSocket） |
| `/ws/voice`、`/sse`、`/channel` | 扩展占位（语音、SSE、通道） |
| `/health` | 健康检查 |
| 其余 | 静态资源（如 Desktop 前端 `apps/desktop/renderer/dist`） |

---

## 客户端连接

- **HTTP / 配置与使用**：`http://localhost:38080` 或 `http://你的IP:38080`（访问 server-api、健康检查、静态资源等）。
- **WebSocket 连接**：`ws://localhost:38080` 或 `ws://你的IP:38080`（或你指定的 host/端口）。
- 协议：JSON-RPC over WebSocket
- 常用方法：`connect`、`agent.chat`、`agent.cancel`、`subscribe_session`、`unsubscribe_session` 等

前端可自行实现或使用仓库内 Web 示例（若有）。

更多**典型使用场景**（整理下载目录、创建/切换智能体、安装技能、MCP、绑定智能体做定时任务等）见 **[使用场景](usage-scenarios.md)**。

---

## 通道与网关

飞书、钉钉、Telegram 等通道在 Gateway 启动时根据配置注册：入站消息经统一格式进入 Agent，回复经该通道发回。启用通道后需**重启 Gateway** 生效。详见 [通道配置](../configuration/channels.md)。

---

## 下一步

- [使用场景](usage-scenarios.md)：桌面/Web 典型场景指导
- [快速开始](getting-started.md)
- [通道配置](../configuration/channels.md)
- [常见问题](../reference/faq.md)

[← 返回文档首页](../README.md)
