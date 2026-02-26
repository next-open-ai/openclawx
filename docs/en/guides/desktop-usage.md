# Desktop usage

OpenClawX Desktop provides a UI for sessions, agents, skills, tasks, workspace, settings, and channel config. In this system, “agent”, “assistant”, and “expert” mean the same thing and can be used interchangeably.

---

## How to start

| Method | Notes |
|--------|-------|
| **Installer** | Install OpenClawX and configure API Key and default model in the UI |

**macOS (unsigned build):** If the app is reported as damaged, run in Terminal:

```bash
xattr -cr /Applications/OpenClawX.app
```

Desktop, Web, and CLI share the same config (`~/.openbot/desktop/`) and agent core.

---

## Main areas

- **Dashboard**: Overview and shortcuts  
- **Agents**: Create/edit agents, set execution (local / Coze / OpenClawX / OpenCode), model, workspace  
- **Sessions**: History and continue chat  
- **Skills**: View and manage loaded skills  
- **Tasks**: Task list and run history  
- **Workspace**: Workspace directory and files  
- **Settings**: Default model, API Key, **Channels** (Feishu, DingTalk, Telegram), etc.

For **usage scenarios** (organize downloads, create/switch agents, install skills, MCP, scheduled tasks), see [Usage scenarios](usage-scenarios.md).

---

## Agents and execution

Under **Settings → Agents** you can:

- Set the **default agent**
- Create/edit agents and choose **execution**:
  - **Local**: pi-coding-agent and Skills on this machine
  - **Coze**: Proxy to Coze (region, Bot ID, Access Token)
  - **OpenClawX**: Proxy to another OpenClawX instance (baseUrl, optional apiKey)
  - **OpenCode**: Proxy to [OpenCode](https://opencode.ai/) (local `opencode serve` or remote)

Channels can use any configured agent as their default. See [Proxy mode](../features/proxy-mode.md) and [Agent configuration](../configuration/agents.md).

---

## Switching agents in chat: `//` commands

In **Desktop, Web, and all channels** (Feishu, DingTalk, Telegram), you can use `//`-prefixed commands in the conversation to query or switch the current session’s agent without opening Settings.

| Input | Description |
|-------|-------------|
| `//` or `// ` (space) | Switch back to the **default (main) agent**; shows “Switched to main agent.” |
| `//select` | List available agents (name and id) and how to switch; does not run the agent |
| `//name` or `//id` | Switch to the given agent (by name or id); if not found, switch to default and show a message |
| `//name(id)` | Same as above; supports “name(id)” format |
| `//agent name  then your message` | Switch to that agent, then send “then your message” as the user message to it |

**Examples** (in any chat):

- Type `//select` → see the list of available agents  
- Type `//` → switch back to the main agent  
- Type `//Code Assistant` → switch to the “Code Assistant” agent  
- Type `//Code Assistant help me write a sort function` → switch to Code Assistant and send “help me write a sort function”

Switching and list display are handled by the Gateway and **do not** send the `//` command to the agent, so they do not trigger extra replies or skill summaries.

---

## Channel configuration

Under **Settings → Channels**, enable and configure Feishu, DingTalk, Telegram. **Restart Gateway** after saving. See [Channel configuration](../configuration/channels.md).

---

## Long memory (RAG) and local embedding

Agent long memory uses text embeddings. Desktop prefers an **online RAG model** if configured; otherwise it may use a **local model**. If local GGUF is unavailable in Electron, configure an online RAG model in Settings.

---

## Next steps

- [Usage scenarios](usage-scenarios.md)
- [Web and Gateway](gateway-web.md)
- [Config overview](../configuration/config-overview.md)
- [Proxy mode](../features/proxy-mode.md)

[← Back to index](../README.md)
