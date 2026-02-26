# Installation and deployment

By **method**: npm, Docker, or Desktop installer. Pick one to use CLI, Web, or Desktop.

---

## Requirements

- **Node.js** ≥ 20 (for npm install and local development)
- Optional: API Key for your provider (e.g. `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`)

---

## npm installation

For **CLI** or self-hosted **Gateway (Web)**.

### Node.js 20+

Install Node.js 20+ (e.g. [nodejs.org](https://nodejs.org/), nvm, Homebrew, or Windows installer). Then:

```bash
node -v   # v20.x or v22.x
npm -v
```

### Install

```bash
npm install -g @next-open-ai/openclawx
```

Then use the `openbot` command. To build from source:

```bash
git clone <repo>
cd openclawx
npm install
npm run build
npm link   # or npm install -g .
```

---

## Docker deployment

Use the `deploy/` compose files. See project root [README](../../README.md) “Docker deployment” section for `docker-compose.yaml` (CI image) and `docker-compose-dev.yaml` (local build). Port **38080** is exposed.

---

## Desktop installer

For **Desktop** only; no Node required.

- Download the installer for your platform (macOS / Windows) from [Releases](https://github.com/next-open-ai/openclawx/releases).
- Install and launch OpenClawX, then set API Key and default model in the UI.

### macOS “damaged” or “cannot open”

If the app is quarantined, run in Terminal (adjust path if needed):

```bash
xattr -cr /Applications/OpenClawX.app
```

Then open the app. Configure default provider/model in Settings; CLI and Desktop share `~/.openbot/desktop/` config.

---

## Next steps

- [Quick start](getting-started.md)
- [CLI usage](cli-usage.md)
- [Config overview](../configuration/config-overview.md)

[← Back to index](../README.md)
