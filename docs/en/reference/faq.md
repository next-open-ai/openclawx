# FAQ

---

## Install and run

**Q: “openbot: command not found” after install?**  
A: Ensure the npm global bin directory is in your PATH (`npm config get prefix` → `bin`), or use `npx openbot`.

**Q: Node version?**  
A: Node.js ≥ 20. Prefer 20 or 22.

**Q: macOS app says “damaged” or “cannot open”?**  
A: Run in Terminal: `xattr -cr /Applications/OpenClawX.app` (adjust path if needed), then open the app.

**Q: Windows install or run fails?**  
A: For the Desktop installer, install [Visual C++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist) (x64) if needed; check antivirus. For npm, you can use `npm install -g @next-open-ai/openclawx --ignore-scripts` to skip optional native modules; long memory then needs online RAG or a local build.

---

## Config and API Key

**Q: Do CLI and Desktop share config?**  
A: Yes. Config lives in `~/.openbot/desktop/` (config.json, agents.json, etc.).

**Q: Auth when no API Key is saved?**  
A: Falls back to env vars (e.g. `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`).

---

## Gateway and ports

**Q: Default port? Can it be changed?**  
A: 38080. Use `openbot gateway --port <port>` to override.

**Q: Port already in use?**  
A: Use `--port` for another port or stop the process using 38080.

**Q: Feishu/DingTalk/Telegram enabled but no reply?**  
A: **Restart the gateway** after saving channel config. Check credentials and defaultAgentId.

---

## Chat and agents

**Q: How do I list or switch the current agent in chat?**  
A: In Desktop, Web, or any channel (Feishu, DingTalk, Telegram), type `//`-prefixed commands: `//select` lists agents, `//name` or `//id` switches to that agent, `//` or `// ` switches back to the default agent. See [Desktop usage → Switching agents in chat](../guides/desktop-usage.md#switching-agents-in-chat-commands).

---

## Channels and proxy

**Q: Can channel default agent be Coze / OpenClawX / OpenCode?**  
A: Yes. Configure an agent with that execution in Settings → Agents and set it as the channel’s defaultAgentId.

**Q: How to set up multi-node?**  
A: Run OpenClawX Gateway on another machine; on this machine set the agent execution to OpenClawX and set baseUrl (and optional apiKey). See [Proxy mode](../features/proxy-mode.md).

---

## Next steps

- [Quick start](../guides/getting-started.md)
- [Config overview](../configuration/config-overview.md)

[← Back to index](../README.md)
