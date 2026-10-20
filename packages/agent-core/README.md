# @openclawx/agent-core

模型执行层（纯 pi 栈）：

- **循环**：`@mariozechner/pi-agent-core` + `pi-ai`
- **工具**：TypeBox + `defineAgentTool`
- **Skill 目录**：`pi-coding-agent` `formatSkillsForPrompt` / `loadSkillsFromDir`
- **MCP**：`@modelcontextprotocol/sdk`
- **压缩 / 会话摘要**：`generateSummary` + `shouldCompact` + `Agent.transformContext`

## 上下文相关能力

| 能力 | API | 作用范围 |
| --- | --- | --- |
| 会话滚动摘要 | `summarizeSessionMemory` | orchestrator `rollSessionMemory` |
| Run 内自动压缩 | `compactAgentContext`（经 `transformContext`） | 单次 agent run 超窗时 |
| Summary 注入块 | `sessionSummaryMessagePair` | 与会话记忆共用前缀 |
| 项目交付晋升 | `publish_to_project` | 项目绑定 run |

会话水位线与落盘仍在 `@openclawx/orchestrator`。
