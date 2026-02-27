# Usage scenarios

This page describes common scenarios on Desktop and Web/Gateway with step-by-step guidance. In this system, “agent”, “assistant”, and “expert” mean the same thing.

---

## Scenario 1: Organize the local Downloads folder in chat

**Goal:** Have the agent organize your user **Downloads** folder (e.g. by type, rename, or cleanup) without leaving the chat.

**Steps:** (1) Select the **Local file assistant** (or an agent with file skills). (2) In chat, ask in natural language (e.g. “Organize my Downloads by file type into subfolders”). (3) Confirm before any delete/move. (4) Check the result in the conversation or on disk.

---

## Scenario 2: Create and switch to a new assistant

**Goal:** Ask the current agent to “create a new assistant” and then switch the conversation to it.

**Steps:** (1) In chat, say e.g. “Create a beauty assistant for skincare and makeup.” (2) The agent calls **create_agent** (name, optional workspace, system prompt). (3) You see “Created agent «…» (ID: …)”. (4) Say “Switch to that assistant” or “Use the one you just created”; the agent calls **switch_agent**. (5) Later messages are handled by the new agent.

---

## Scenario 3: Add a skill to the current agent

**Goal:** In chat, ask to “install a skill for the current assistant” so only this agent gets it.

**Steps:** (1) Select the target agent (must be local). (2) In chat, e.g. “Install the PDF skill from owner/repo for the current assistant.” (3) The agent calls **install_skill** with the skill URL; it installs into that agent’s workspace. (4) New sessions for that agent load the skill automatically.

---

## Scenario 4: Discover and install a skill (find + install)

**Goal:** Describe what you need; the agent finds a suitable skill and installs it.

**Steps:** (1) Use an agent that has **find-skills** (e.g. default). (2) Say e.g. “Find and install a skill that can handle Excel.” (3) The agent uses find-skills, lists options, then calls **install_skill** for the chosen one. (4) Confirm in **Skills** or by asking a related question.

---

## Scenario 5: Add MCP to an agent (manual)

**Goal:** Give a specific agent MCP (Model Context Protocol) tools (e.g. DB, API, RPA).

**Steps:** (1) **Settings → Agents** → open the agent. (2) Open the **MCP** tab. (3) Add a server: **Name**; for **stdio**: command (e.g. `npx`), args (e.g. `["-y", "yingdao-mcp-server"]`), optional env; for **SSE**: URL and optional headers. (4) Save. New sessions for that agent will load the MCP tools.

---

## Scenario 6: Bind an agent to a scheduled task

**Goal:** Run a task on a schedule (e.g. daily at 9:00) with a **specific agent**.

**Steps:** (1) Open **Tasks**. (2) Create a new task. (3) Choose the **workspace** that corresponds to the agent (workspace ≈ agent for custom agents). (4) Set **message** (prompt sent at run time) and **schedule** (once or cron). (5) Save and enable. (6) View run history under that task.

---

## Scenario 7: Create a Bilibili (B站) download assistant and download a video

**Goal:** Ask the main agent to create an assistant that downloads Bilibili videos to the local machine, switch to it, then send a video URL and have it download the file (e.g. using browser + bash/you-get).

**Steps:** (1) In chat, say e.g. “Create an expert that can download B站 videos and save them locally; name it B站助手 (Bilibili assistant).” (2) The agent calls **create_agent** (name “B站助手”, workspace e.g. `bilibili-assistant`, system prompt for B站 download + browser automation). (3) Say “Yes” or “Switch to B站助手”; the agent calls **switch_agent**. (4) Send a Bilibili video URL, e.g. “Download this B站 video: https://www.bilibili.com/video/BV1xx411c7mD”. (5) The new assistant uses **browser** to open the page and get info, and **bash** to install/run a download tool (e.g. `you-get`) and save the video to its workspace directory. (6) Check the reply for title, quality, file path, and the file on disk.

**Tip:** Download depends on local tools (e.g. Python, `you-get`); the agent may run `pip install you-get` in chat. Files are saved under the assistant’s workspace (e.g. `~/.openbot/workspace/bilibili-assistant/`).

---

## Scenario 8: Use OpenCode with slash commands

**Goal:** Proxy an agent to the [OpenCode](https://opencode.ai/) server so you can use OpenCode's coding features and slash commands (`/init`, `/undo`, `/share`, etc.) in Desktop/Web chat with zero local token usage.

**Steps and details:** (1) **Local mode:** Install OpenCode (e.g. `curl -fsSL https://opencode.ai/install | bash` or `npm install -g opencode-ai`), then run `opencode serve` (default port 4096). **Remote mode:** Use an existing OpenCode server address and port. (2) In OpenClawX: **Settings → Agents** → create or edit an agent → set execution to **OpenCode**; choose local or remote and fill port or address. See [Agent configuration](../configuration/agents.md) and [Proxy mode](../features/proxy-mode.md). (3) In chat with that agent you can use `/init` (analyze project, create AGENTS.md), `/undo`, `/redo`, `/share` (get share link), `/help`. See [OpenCode docs](https://opencode.ai/docs) and [Share](https://opencode.ai/docs/share).

**Official and config:** [opencode.ai](https://opencode.ai/) / [opencode.ai/docs](https://opencode.ai/docs). In OpenClawX: **Settings → Agents**; [Agent configuration](../configuration/agents.md).

---

## Scenario 9: Connect RPA (YingDao) via MCP

**Goal:** Add the YingDao RPA MCP server to an agent so the agent can run RPA flows (e.g. open apps, fill forms, scrape pages) from chat.

**Steps and details:** (1) The [yingdao-mcp-server](https://www.npmjs.com/package/yingdao-mcp-server) npm package exposes RPA as MCP tools. (2) In OpenClawX: **Settings → Agents** → open the agent → **MCP** tab → Add: Name e.g. "YingDao RPA", connection **stdio**, command `npx`, args `["-y", "yingdao-mcp-server"]`, optional env (e.g. `RPA_MODEL`, `SHADOWBOT_PATH`, `USER_FOLDER`). Save; new sessions for that agent will load the MCP. (3) In chat, use natural language to trigger RPA. See [Agent configuration](../configuration/agents.md) and [package docs](https://www.npmjs.com/package/yingdao-mcp-server).

**Official and config:** [yingdao-mcp-server on npm](https://www.npmjs.com/package/yingdao-mcp-server). In OpenClawX: **Settings → Agents** → agent → **MCP** tab.

---

## Scenario 10: Connect Coze (China or international) Bot

**Goal:** Proxy an agent to [Coze](https://www.coze.com) (China or international site) so Desktop/Web/channels use your Coze Bot with zero local token usage.

**Steps and details:** (1) On [Coze China](https://www.coze.cn) or [Coze International](https://www.coze.com), get **Bot ID** and **Access Token** (PAT, OAuth, or JWT). China and international credentials are not interchangeable. (2) In OpenClawX: **Settings → Agents** → set execution to **Coze**; choose region **China (cn)** or **International (com)** and fill Bot ID and Access Token. (3) For channels, set this Coze agent as default in **Settings → Channel configuration**. See [Agent configuration](../configuration/agents.md), [Proxy mode](../features/proxy-mode.md), [Channel configuration](../configuration/channels.md).

**Official and config:** Coze China [www.coze.cn](https://www.coze.cn), International [www.coze.com](https://www.coze.com). In OpenClawX: **Settings → Agents**; [Agent configuration](../configuration/agents.md).

---

## Quick reference

| Scenario | Main entry | Depends on |
|----------|------------|------------|
| Organize Downloads | Chat + Local file assistant | Preinstalled file assistant |
| Create/switch agent | Chat + create_agent / switch_agent | Gateway tools |
| Bilibili download assistant | Chat + create_agent + switch_agent + browser/bash | Browser, you-get (or similar) |
| Install skill for agent | Chat + install_skill | Local agent, skill URL |
| Find + install skill | Chat + find-skills + install_skill | find-skills, local agent |
| Add MCP | Settings → Agent → MCP | — |
| Scheduled task for agent | Tasks → New → choose workspace | Gateway, task scheduler |
| Use OpenCode with slash commands | Settings → Agents (OpenCode) + /init, /undo, /share in chat | Local or remote OpenCode server |
| RPA (YingDao) via MCP | Settings → Agent → MCP (yingdao-mcp-server) | Node/npx, yingdao-mcp-server |
| Coze China/International Bot | Settings → Agents (Coze) + region and Bot ID/Token | Coze Bot and credentials |

---

## Next steps

- [Desktop usage](desktop-usage.md)
- [Web and Gateway](gateway-web.md)
- [Agent configuration](../configuration/agents.md): execution (local/Coze/OpenClawX/OpenCode), MCP, workspace
- [Proxy mode and multi-node](../features/proxy-mode.md): Coze, OpenCode proxy
- [Channel configuration](../configuration/channels.md): default agent per channel
- [Skills system](../features/skills.md)

[← Back to index](../README.md)
