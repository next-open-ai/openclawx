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

---

## Next steps

- [Desktop usage](desktop-usage.md)
- [Web and Gateway](gateway-web.md)
- [Agent configuration](../configuration/agents.md)
- [Skills system](../features/skills.md)

[← Back to index](../README.md)
