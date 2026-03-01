# Local inference: 0 Tokens

When an agent runs **locally (local)** and uses a **local GGUF model**, inference is done on your machine via [node-llama-cpp](https://github.com/nicolo-ribani/node-llama-cpp), with **no cloud API calls**, so **0 Token usage**. This page explains setup, usage, and the **one-click save Tokens** behavior.

---

## One-click save Tokens (summary)

- **What it means:** In Settings, set the default (or an agent’s) **Provider to local** and **model to an installed local GGUF**. Then that agent’s chats use **no cloud Tokens**—no code changes, no proxy; everything runs on your machine (Q&A, tools, skills).
- **When to use:**
  - Private or sensitive conversations you don’t want sent to the cloud
  - Limited or paid cloud API quotas; daily chat at zero cost
  - Offline or air-gapped environments with no cloud access
- **Difference from proxy 0 Tokens:** Proxy mode (Coze/OpenCode, etc.) uses “0 Tokens on this machine, inference on their side.” Local inference is “inference on this machine too, 0 cloud Tokens end-to-end.”

---

## Setup

### 1. Download and manage local models

1. Open **Settings → Model config → Local models**.
2. Under “Recommended models (click to download),” click **Download** for the model you want (e.g. Qwen3 4B/7B, EmbeddingGemma). Already installed models are not shown there.
3. Under “Installed local models” you can see what’s installed; names match the recommended list.
4. If the default model file is missing, the local service will not auto-start at gateway startup; download or confirm a model first, then start the service (step 2).

### 2. Start the local model service

1. On the same page, in “Start local model service”:
   - **Status:** “Ready” means it’s running; “Unavailable” means not started or default model file missing.
   - Choose **LLM model** and **Embedding model** (or “Use default”).
   - Click **Start local model service** (or “Restart…” if already running) and wait until ready.
2. Once ready, inference and embeddings use the local process and **no cloud Tokens**.

### 3. Use local model for an agent

1. Open **Settings → Agents** and edit the agent (or the default one).
2. Set **Execution** to **Local**.
3. In **Settings → Model config**, configure the **local** provider:
   - Add or select a local model (name matches “Installed local models”).
   - Set it as default, or pick this local model in the agent’s model field.
4. Optionally set **Context size** (default 32K) for that local model in agent or model config.

After this, that agent’s conversations and tool calls run locally with **0 cloud Token usage**.

---

## Usage

- **Desktop / Web:** Set the default or current-session agent to the “local + local model” agent and chat as usual; replies come from the local GGUF.
- **Channels (Feishu, DingTalk, Telegram, WeChat):** Set the channel’s default agent to that local agent; channel chats then use local inference, 0 Tokens.
- **CLI:** In `~/.openbot/desktop/` config, set defaultAgent or the agent’s provider to local and model to the local model (or modelItemCode). Then use `openbot chat` etc.

---

## FAQ

- **Service not ready / unavailable:** Make sure you clicked “Start local model service” under Local models. If the default model file is missing, download or select an installed model first, then start.
- **Slow first reply or timeout:** Cold start or first token can be slow; the UI uses a 3-minute request timeout and a 90-second “first chunk” timeout. Stream completion is determined by agent_end.
- **Names:** Recommended models come from `presets/recommended-local-models.json`; installed list shows matching display names. Installed models are excluded from the “recommended to download” list.

---

## See also

- [Agent configuration](../configuration/agents.md): local execution and model/workspace
- [Config overview](../configuration/config-overview.md): config.json, agents.json, model config location

[← Back to index](../README.md)
