# Quick Start

Get installed, have your first conversation, and find desktop and channel entry points in about 5 minutes.

---

## 1. Choose installation

| Method | When to use | Doc |
|--------|-------------|-----|
| **npm** | CLI or self-hosted Gateway | [Installation → npm](installation.md#npm-installation) |
| **Desktop installer** | Desktop only, no Node | [Installation → Desktop](installation.md#desktop-installer) |
| **Docker** | Container deployment | [Installation](installation.md) |

---

## 2. Fast path: npm + CLI

```bash
# Global install
npm install -g @next-open-ai/openclawx

# Login (e.g. DeepSeek; omit model to use provider default)
openbot login deepseek YOUR_DEEPSEEK_API_KEY

# Chat
openbot "Summarize the skills currently available"
```

Without `--provider` / `--model`, the CLI uses the desktop default agent config. You can set default model with `openbot config set-model deepseek deepseek-chat`.

### Full config via Web

```bash
openbot gateway --port 38080
# Open http://localhost:38080 in a browser for full configuration.
```

---

## 3. Web / Gateway

```bash
openbot gateway
# or
openbot gateway --port 38080
```

Open `http://localhost:38080` or connect clients to `ws://localhost:38080` and use JSON-RPC (`connect`, `agent.chat`, etc.). See [Web and Gateway](gateway-web.md).

---

## 4. Desktop

- **Installer users**: Install OpenClawX, then configure API Key and default model in Settings.
- **macOS “damaged” prompt**: Run in Terminal (path as needed):
  ```bash
  xattr -cr /Applications/OpenClawX.app
  ```
  Then open the app as usual.

See [Desktop usage](desktop-usage.md).

---

## 5. Channels (Feishu / DingTalk / Telegram)

1. Start the desktop app or run **Gateway** (`openbot gateway`).
2. In **Settings → Channels**, enable the channel and fill credentials (Feishu App ID/Secret, DingTalk Client ID/Secret, Telegram Bot Token).
3. Save and **restart Gateway** (or the desktop app).
4. In the IM app, @ the bot or start a chat.

See [Channel configuration](../configuration/channels.md).

---

## Next steps

- [Installation](installation.md)
- [CLI usage](cli-usage.md)
- [Agent configuration](../configuration/agents.md)

[← Back to index](../README.md)
