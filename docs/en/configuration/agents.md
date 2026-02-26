# Agent configuration

Agents are defined in `~/.openbot/desktop/agents.json` and can be edited in Desktop under **Settings → Agents**.

**Terminology:** In this system, “agent”, “assistant”, and “expert” mean the same thing. Names like “XX assistant” or “XX expert” are display names for agents.

---

## Execution modes

Each agent has one **execution** mode:

| Mode | Description |
|------|-------------|
| **local** | Run on this machine with pi-coding-agent and Skills; set provider/model (or modelItemCode) |
| **coze** | Proxy to Coze; set region and Bot ID, Access Token |
| **openclawx** | Proxy to another OpenClawX instance; set baseUrl, optional apiKey |
| **opencode** | Proxy to [OpenCode](https://opencode.ai/) (local `opencode serve` or remote); set port or address, optional password, working directory, model |

---

## agents.json outline

- **local**: `runnerType: "local"`, provider, model, modelItemCode, workspace.
- **Coze**: `runnerType: "coze"`, region (cn/com), coze.cn / coze.com (botId, apiKey).
- **OpenClawX**: `runnerType: "openclawx"`, openclawx.baseUrl, openclawx.apiKey.
- **OpenCode**: `runnerType: "opencode"`, opencode object (mode, port, address, password, model, workingDirectory).

**defaultAgentId** in config.json sets the default agent; channels can override with their own defaultAgentId.

---

## Desktop workflow

- Under **Settings → Agents**, create/edit agents and set execution and credentials.
- Set one agent as default; channels can use any configured agent as their default.

See [Proxy mode and multi-node](../features/proxy-mode.md).

---

## Next steps

- [Config overview](config-overview.md)
- [Channel configuration](channels.md)
- [Proxy mode](../features/proxy-mode.md)

[← Back to index](../README.md)
