# @openclawx/orchestrator

服务端编排核心：聊天会话、可续跑 run、项目调度与域 KV。

## Session Rolling Memory（会话级滚动记忆）

普通对话的长上下文策略。**消息全文（`messages`）是唯一真相**；`session.memory` 是可重建的派生状态。

### 字段

```ts
memory?: {
  summary: string          // 滚动连续性摘要
  coveredUntilId: string   // 摘要已覆盖到的最后一条 canonical message id
  updatedAt: number
  dirty: boolean           // 离开会话时是否需要 flush
}
```

### 行为

| 时机 | 行为 |
| --- | --- |
| 组装 `ChatRequest` | 有摘要时注入 `[OpenClawX context summary]` + `coveredUntilId` **之后**的原文；无摘要则用全量历史 |
| Run 结束（`settleRun`） | 若「摘要 + 未覆盖原文」超过约 24k 字符 → LLM 滚动摘要并推进水位线；标记 `dirty` |
| 切换/新建会话（桌面） | `POST /sessions/:id/memory/flush`：必要时强制折叠超出最近窗口的原文，清除 `dirty` |

单次 run 内的 `prepareStep` 压缩（`agent-core/context-compaction`）仍是安全网，**不写回** session。

实现：`src/session-memory.ts` + `ChatSessionService.requestForTurn` / `flushSessionMemory`。

更完整的架构说明见仓库 [`docs/design/architecture.md`](../../docs/design/architecture.md) §5.1.1。

## 项目双工作区与 `publish_to_project`

项目任务会把 `projectWorkspacePath` 与稳定 `runId` 注入 `ChatRequest`：

- 过程产物 → `~/.openclawx/workspaces/<runId>/`
- 用户可见交付 → 调用 `publish_to_project` 写入 `project.workspacePath`（左侧项目文件树）

详见 [`docs/design/architecture.md`](../../docs/design/architecture.md) §5.2 与 [`docs/design/project-orchestration.md`](../../docs/design/project-orchestration.md)。

### P2 / P3 补充

- **两阶段规划**：结构 → 目标；协作模板为偏好，不匹配时桌面弹窗建议切换。
- **事件驱动调度**：审批停车后由 schedule pulse 唤醒；普通批次仍 await 结算。
- **Attempt 幂等**：`lastAttemptKey = taskId:plan{v}:attempt{n}`，避免同一逻辑 attempt 重复执行。
