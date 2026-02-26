# OpenClawX Documentation

**文档 (Documentation):** [中文](../zh/README.md) | [English](README.md)

Welcome to OpenClawX. This documentation covers installation, configuration, and advanced features.

---

## Document Structure

```
docs/en/                        # English documentation
├── README.md                   # This page: index and navigation
├── guides/                     # Guides
│   ├── getting-started.md      # Quick start
│   ├── installation.md         # Installation and deployment
│   ├── cli-usage.md            # CLI usage
│   ├── desktop-usage.md        # Desktop usage
│   ├── gateway-web.md          # Web and Gateway
│   └── usage-scenarios.md      # Usage scenarios (desktop/Web)
├── configuration/              # Configuration
│   ├── config-overview.md      # Config overview
│   ├── agents.md                # Agent configuration
│   └── channels.md             # Channel config (Feishu, DingTalk, Telegram)
├── features/                   # Features
│   ├── proxy-mode.md           # Proxy mode and multi-node
│   └── skills.md               # Skills system
├── reference/                  # Reference
│   └── faq.md                  # FAQ
├── release-notes.md            # Release notes
└── channel-streaming-design.md # Channel streaming design (for developers)
```

---

## Getting Started

| Document | Description |
|----------|-------------|
| [Quick Start](guides/getting-started.md) | Get running in ~5 minutes: install, first chat, desktop/channel entry |
| [Installation](guides/installation.md) | npm, Docker, Desktop installer and requirements |

---

## Guides

| Document | Description |
|----------|-------------|
| [CLI Usage](guides/cli-usage.md) | Command line: chat, login, model and skills, auto-start |
| [Desktop Usage](guides/desktop-usage.md) | Desktop install and launch, agents/sessions/skills/settings |
| [Web and Gateway](guides/gateway-web.md) | Start gateway, ports and paths, Web client connection |
| [Usage Scenarios](guides/usage-scenarios.md) | Organize downloads, create/switch agents, install skills, MCP, scheduled tasks |

---

## Configuration

| Document | Description |
|----------|-------------|
| [Config Overview](configuration/config-overview.md) | Config directory, config.json and agents.json |
| [Agent Configuration](configuration/agents.md) | Local/Coze/OpenClawX/OpenCode execution, model and workspace |
| [Channel Configuration](configuration/channels.md) | Feishu, DingTalk, Telegram enable and config |

---

## Features

| Document | Description |
|----------|-------------|
| [Proxy Mode and Multi-Node](features/proxy-mode.md) | Coze, OpenClawX, OpenCode proxy and config |
| [Skills System](features/skills.md) | Agent Skills spec, built-in skills, install and extend |

---

## Reference

| Document | Description |
|----------|-------------|
| [FAQ](reference/faq.md) | Install failures, port in use, channel not replying, etc. |
| [Release Notes](release-notes.md) | Version updates and fixes |

---

## Development and Design

| Document | Description |
|----------|-------------|
| [Channel Streaming Design](channel-streaming-design.md) | Channel streaming and adapters (for developers) |

---

Back to [OpenClawX project home](../../README.md).
