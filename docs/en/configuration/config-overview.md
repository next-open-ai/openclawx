# Config overview

OpenClawX config lives in the **desktop config directory**, shared by CLI, Desktop, and Gateway.

---

## Config directories

| Directory | Description |
|-----------|-------------|
| `~/.openbot/desktop/` | Desktop config root (shared) |
| `~/.openbot/agent/` | Agent-side config (e.g. models.json, from `openbot config sync`) |

---

## Main config files

| File | Description |
|------|-------------|
| **config.json** | Default provider/model, defaultModelItemCode, defaultAgentId, API keys, configured models, channels |
| **agents.json** | Agent list: provider, model, modelItemCode, workspace, **execution** (local/coze/openclawx/opencode) and proxy fields |
| **provider-support.json** | Provider and model catalog (usually shipped with the package) |

---

## Priority

- CLI uses the default agent when `--provider` / `--model` are not set.
- One-off override: `--provider`, `--model`, `--api-key`.
- If no API Key is stored, env vars (e.g. `OPENAI_API_KEY`) are used.

---

## Next steps

- [Agent configuration](agents.md)
- [Channel configuration](channels.md)

[← Back to index](../README.md)
