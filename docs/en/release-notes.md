# Release notes

This document records feature updates and fixes for OpenClawX.

---

## [0.8.38] – current

### Web search (web_search)

- **Multiple web search providers**
  - New **web search** tool (`web_search`) for agents: the model can call it during chat to fetch up-to-date information (e.g. news, weather, definitions).
  - Supported providers: **DuckDuckGo** (default, no API key, via duck-duck-scrape); **Brave Search** (requires Brave API key in Settings → General or env `BRAVE_API_KEY`).
  - Per-agent toggle and provider choice in Agent detail → Basic config; Brave API key in Settings → General.
  - When the selected provider is unavailable (e.g. Brave chosen but no key), the tool is still registered in **no-op mode**: the model can call it and receives a clear message guiding the user to configure or switch provider.

### Other

- Bug fixes and dependency updates.

---

## [0.8.36]

### MCP and configuration

- **MCP loading**: Improved MCP server loading and tool registration; session creation is more stable and observable; connection/retry progress is sent through the shared outlet for the UI.
- **Configuration**: Better handling of agent and global config read/write and validation; MCP and other options save and apply more consistently.

### Other

- Bug fixes and dependency updates.

---

## [0.8.32]

### Session outlet and MCP

- **Session message outlet (session-outlet)**: Gateway sets a global outlet via `setSessionOutlet(outlet)`. Any module can send session-level system messages with `sendSessionMessage(sessionId, message)` (e.g. `turn_end`, `agent_end`, `mcp.progress`, `//` command results) without passing the outlet through the call chain.
- **MCP progress**: MCP layer no longer receives `sessionOutlet`; it uses global `sendSessionMessage(sessionId, { type: "system", code: "mcp.progress", payload })` for connection/retry progress.

### Other

- Bug fixes and dependency updates.

---

## [0.8.28]

### Other

- Bug fixes and stability improvements; Docker and CI builds available for this tag.

---

## [0.8.26]

### MCP and RPA (YingDao)

- **MCP**: Agents support [MCP](https://modelcontextprotocol.io/). Configure MCP servers (stdio or SSE) per agent in Desktop **Settings → Agent → MCP**. Config applies on next session; no app restart.
- **RPA (YingDao)**: Add [yingdao-mcp-server](https://www.npmjs.com/package/yingdao-mcp-server) in agent MCP config (e.g. `npx -y yingdao-mcp-server`) to use YingDao RPA in chat.

### Other

- npm package includes `presets`; preinstalled agents and skills merge into local config after install.

---

## [0.8.18]

### Agents and workspace

- Deleting an agent removes its workspace data from the DB (sessions, scheduled tasks, favorites, token usage). Disk workspace directory is kept unless user opts to delete it. Default agent workspace cannot be deleted.

### Chat and streaming

- Abort button correctly stops the current turn (local and proxy agents). OpenCode proxy uses streaming replies and slash commands: `/init`, `/undo`, `/redo`, `/share`, `/help`.

---

For the full history and details, see the [Chinese release notes](../zh/release-notes.md).

[← Back to index](../README.md)
