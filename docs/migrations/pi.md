# OpenClawX × pi 迁移进度

## 已完成

### Phase 1
1. 从 `opcai` 全量复制为 `tools/openclawx`，品牌/包名/`~/.openclawx` 数据目录已切换。
2. `streamAgentReply` 改为 `@mariozechner/pi-agent-core` + `pi-ai` 驱动。
3. 对外仍产出原有 `AgentEvent`；orchestrator / UI / Electron 打包方式不变。

### Phase 2（工具原生）
1. `defineAgentTool` + TypeBox（含 pi-ai `StringEnum`）作为唯一工具工厂。
2. Skill / 搜索 / 知识库 / 经验工具全部改为 `AgentTool[]`，去掉 AI SDK `tool()` 桥接。

### Phase 3（MCP + skills 目录）
1. MCP 改用官方 `@modelcontextprotocol/sdk`（stdio / SSE / streamable HTTP）。
2. 技能目录用 `pi-coding-agent` 的 `formatSkillsForPrompt` / `loadSkillsFromDir`；员工策略与审批闸保留。

### Phase 4（自动 summary / compaction）
1. 会话滚动记忆 `summarizeSessionMemory` → pi `generateSummary`（失败时 `completeSimple` 降级）。
2. Run 内 `Agent.transformContext` → `shouldCompact` + `generateSummary` 自动压缩。
3. `convertToLlm` 使用 pi-coding-agent 官方转换。
4. **agent-core 已移除全部 `@ai-sdk/*` / `ai` 依赖。**

## 抽象边界（保持）

```
UI / orchestrator / AgentEvent / AgentSkillRuntime / 审批策略 / session.memory
        ↓
agent-core：pi Agent + AgentTool + pi skills + MCP SDK + pi generateSummary
```

## 本地开发

```bash
cd tools/openclawx
pnpm install
pnpm dev
pnpm package
```

注意：数据目录为 `~/.openclawx`，与 `~/.opcai` 隔离。
