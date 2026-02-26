# Proxy mode and multi-node

Besides running locally (**local**), agents can use **proxy mode** to forward conversations to Coze, another OpenClawX instance, or the [OpenCode](https://opencode.ai/) server.

---

## Execution modes

| Mode | Description | Config |
|------|-------------|--------|
| **local** | Run on this machine with pi-coding-agent and Skills | Default |
| **coze** | Proxy to Coze | Set execution to Coze; region (cn/com); Bot ID and Access Token per site |
| **openclawx** | Proxy to another OpenClawX instance | Set baseUrl (e.g. `http://other-host:38080`), optional apiKey |
| **opencode** | Proxy to OpenCode | Local: run `opencode serve` (port 4096), set port; remote: set address and port. Optional password, working directory, model. Supports `/init`, `/undo`, `/redo`, `/share`, `/help` in chat |

---

## Coze

Supports **China** (api.coze.cn) and **international** (api.coze.com). Configure Bot ID and Access Token per site. Set in **Settings → Agents** when creating/editing an agent.

---

## OpenClawX multi-node

Point an agent at another OpenClawX gateway via **baseUrl** and optional **apiKey**. Run gateways on multiple machines and assign agents to different nodes for load or specialization.

---

## OpenCode

Run `opencode serve` locally or use a remote OpenCode server. In Desktop, set execution to OpenCode and fill port (local) or address and port (remote). Optional password, working directory, default model. Chat is streamed; slash commands match OpenCode TUI.

---

## Next steps

- [Agent configuration](../configuration/agents.md)
- [Config overview](../configuration/config-overview.md)

[← Back to index](../README.md)
