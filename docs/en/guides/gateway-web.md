# Web and Gateway

Use OpenClawX via the **WebSocket gateway**: start the gateway, then connect with a Web client or IM channels.

**Configuration and access URL**: You can use **`http://localhost:38080`** (local) or **`http://yourIP:38080`** (LAN/remote) for configuration and use. WebSocket uses the same host/port with `ws://` (e.g. `ws://localhost:38080` or `ws://yourIP:38080`); HTTP endpoints (e.g. `/server-api`, `/health`) and static assets are served at the same HTTP base URL.

---

## Start the gateway

**npm**:

```bash
openbot gateway
# or
openbot gateway --port 38080
```

For auto-start on boot: `openbot service install`; to remove: `openbot service uninstall`; to stop: `openbot service stop`.

**Docker**: If you started the service via [Docker deployment](installation.md#docker-deployment), it also listens on port 38080. Open **`http://localhost:38080`** or **`http://yourIP:38080`** in a browser to configure and use the same Web UI as with npm.

---

## Paths and roles

| Path | Description |
|------|-------------|
| `/server-api` | Desktop backend (NestJS) HTTP API |
| `/ws` | Agent chat (JSON-RPC over WebSocket) |
| `/ws/voice`, `/sse`, `/channel` | Reserved (voice, SSE, channel) |
| `/health` | Health check |
| Others | Static assets (e.g. Desktop UI) |

---

## Client connection

- **HTTP / configuration and use**: `http://localhost:38080` or `http://yourIP:38080` (server-api, health check, static assets).
- **WebSocket**: `ws://localhost:38080` or `ws://yourIP:38080` (or your host/port).
- Protocol: JSON-RPC over WebSocket
- Methods: `connect`, `agent.chat`, `agent.cancel`, `subscribe_session`, `unsubscribe_session`, etc.

For **usage scenarios** (organize downloads, create/switch agents, install skills, MCP, scheduled tasks), see [Usage scenarios](usage-scenarios.md).

---

## Channels and gateway

Feishu, DingTalk, Telegram register when the gateway starts. Inbound messages are normalized and sent to the agent; replies are sent back via the channel. **Restart the gateway** after changing channel config. See [Channel configuration](../configuration/channels.md).

---

## Next steps

- [Usage scenarios](usage-scenarios.md)
- [Quick start](getting-started.md)
- [Channel configuration](../configuration/channels.md)
- [FAQ](../reference/faq.md)

[← Back to index](../README.md)
