# OpenClawX 使用文档

**Documentation:** [中文](README.md) · [English](../en/README.md)

欢迎使用 OpenClawX。本文档提供从安装、配置到进阶功能的完整使用说明。

---

## 文档结构

```
docs/zh/                        # 中文文档
├── README.md                   # 本页：文档入口与导航
├── guides/                     # 使用指南
│   ├── getting-started.md      # 快速开始
│   ├── installation.md         # 安装与部署
│   ├── cli-usage.md            # CLI 使用
│   ├── desktop-usage.md        # 桌面端使用
│   ├── gateway-web.md          # Web 与 Gateway
│   └── usage-scenarios.md      # 使用场景（桌面/Web 典型场景指导）
├── configuration/              # 配置说明
│   ├── config-overview.md      # 配置概览
│   ├── agents.md               # 智能体配置
│   └── channels.md             # 通道配置（飞书 / 钉钉 / Telegram / 微信）
├── features/                   # 功能说明
│   ├── proxy-mode.md          # 代理模式与多节点协作
│   ├── skills.md               # 技能系统
│   └── plugins.md              # 插件与扩展（安装、编写、用户手册）
├── reference/                  # 参考
│   └── faq.md                  # 常见问题
├── release-notes.md            # 发布说明
└── channel-streaming-design.md # 通道流式设计（开发/设计参考）
```

---

## 入门

| 文档 | 说明 |
|------|------|
| [快速开始](guides/getting-started.md) | 5 分钟跑通：安装、首次对话、桌面/通道入口 |
| [安装与部署](guides/installation.md) | npm、Docker、Desktop 安装包及环境要求 |

---

## 使用指南

| 文档 | 说明 |
|------|------|
| [CLI 使用](guides/cli-usage.md) | 命令行：对话、登录、模型与技能、开机自启 |
| [桌面端使用](guides/desktop-usage.md) | Desktop 安装与启动、智能体/会话/技能/设置 |
| [Web 与 Gateway](guides/gateway-web.md) | 启动网关、端口与路径、Web 端连接方式 |
| [使用场景](guides/usage-scenarios.md) | 桌面/Web 典型场景：整理下载目录、创建/切换智能体、安装技能、MCP、定时任务等 |

---

## 配置

| 文档 | 说明 |
|------|------|
| [配置概览](configuration/config-overview.md) | 配置目录、config.json 与 agents.json 位置与作用 |
| [智能体配置](configuration/agents.md) | 本机/Coze/OpenClawX/OpenCode 执行方式、模型与工作区 |
| [通道配置](configuration/channels.md) | 飞书、钉钉、Telegram、微信的启用与配置项 |

---

## 功能说明

| 文档 | 说明 |
|------|------|
| [代理模式与多节点协作](features/proxy-mode.md) | Coze、OpenClawX、OpenCode 代理与配置要点 |
| [技能系统](features/skills.md) | Agent Skills 规范、内置技能、安装与扩展 |
| [插件与扩展](features/plugins.md) | 扩展目录、CLI 命令、编写约定与用户手册 |

---

## 参考

| 文档 | 说明 |
|------|------|
| [常见问题](reference/faq.md) | 安装失败、端口占用、通道不回复等 FAQ |
| [发布说明](release-notes.md) | 各版本功能更新与问题修复记录 |

---

## 开发与设计

| 文档 | 说明 |
|------|------|
| [通道流式设计](channel-streaming-design.md) | 通道流式输出与适配设计（面向开发者） |

---

返回 [OpenClawX 项目首页](../../README.md)。
