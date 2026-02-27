# Release notes

This document records feature updates and fixes for OpenClawX.

---

## [0.8.32] – current

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
