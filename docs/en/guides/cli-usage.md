# CLI usage

Use the `openbot` command in a terminal after **npm install** or **build and link** from source.

---

## Basic chat

```bash
# Default workspace and skills
openbot "Summarize the skills currently available"

# Custom skill path
openbot -s ./skills "Use find-skills to search for PDF-related skills"

# Dry run (print prompts, no LLM)
openbot --dry-run --prompt "Beijing weather"

# Override model and provider
openbot --model deepseek-chat --provider deepseek "Write a short TypeScript example"
```

---

## CLI config (shared with Desktop)

CLI and Desktop share **desktop config** (`~/.openbot/desktop/`). See [Config overview](../configuration/config-overview.md).

### Common commands

| Action | Command | Notes |
|--------|---------|-------|
| Save API Key (optional model) | `openbot login <provider> <apiKey> [model]` | Writes config.json |
| Set default model | `openbot config set-model <provider> <modelId>` | Sets default provider/model |
| List config | `openbot config list` | Lists providers and default model |
| Sync to agent dir | `openbot config sync` | Writes `~/.openbot/agent/models.json` |

### First-time example

```bash
openbot login deepseek YOUR_DEEPSEEK_API_KEY
openbot "Summarize the skills currently available"
```

Without `--provider` / `--model`, the default agent config is used; env vars (e.g. `OPENAI_API_KEY`) are used if no API Key is stored.

---

## Gateway auto-start

```bash
openbot service install    # Enable auto-start (Linux / macOS / Windows)
openbot service uninstall  # Disable
openbot service stop       # Stop current gateway
```

---

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `openbot` + prompt | One-off chat |
| `openbot gateway` | Start WebSocket gateway (`-p` for port) |
| `openbot login` | Save provider API Key |
| `openbot config list / set-model / sync` | Config |
| `openbot service install/uninstall/stop` | Gateway auto-start |

---

## Next steps

- [Config overview](../configuration/config-overview.md)
- [Agent configuration](../configuration/agents.md)
- [Desktop usage](desktop-usage.md)

[← Back to index](../README.md)
