# 技能系统

OpenClawX 基于 **Agent Skills** 规范，支持多路径加载、本地安装与动态扩展，以及技能自我发现与自我迭代。

---

## 规范与加载

- 技能遵循 **SKILL.md** 规范，包含描述、触发条件、能力说明等。
- 支持多路径加载：内置技能（如 `skills/`）、用户目录、通过 `openbot -s <path>` 指定路径。
- 技能内容会经 `formatSkillsForPrompt` 注入到 Agent 的 system prompt，供模型按需调用。

---

## 内置技能

| 技能 | 说明 |
|------|------|
| **find-skills** | 发现与安装 Cursor/Agent 技能 |
| **agent-browser** | 浏览器自动化（Playwright/agent-browser CLI）：导航、填表、截图、数据抓取等 |

---

## 使用方式

- **CLI**：`openbot -s ./skills "用 find-skills 搜一下 PDF 相关技能"`，或依赖默认加载路径。
- **Desktop**：在技能页面查看已加载技能；与 CLI 共用同一套 Agent 核心与配置。
- **安装**：通过 find-skills 发现并安装技能，或按 SKILL.md 规范将技能放到指定目录并加入加载路径。

---

## 扩展与开发

- 自定义技能需符合 SKILL.md 规范，并放入被加载的目录。
- 开发与打包说明见项目根目录 README 的「三、开发」章节。

---

## 下一步

- [CLI 使用](../guides/cli-usage.md)
- [配置概览](../configuration/config-overview.md)

[← 返回文档首页](../README.md)
