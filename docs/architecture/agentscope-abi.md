# OpenClawX × AgentScope Engine ABI v1

> Status: authoritative for the Sidecar boundary. Product orchestration stays in TypeScript; AgentScope runs in a local Python process.

## 1. Transport

- **WebSocket** on `127.0.0.1` only
- Framing: **JSON-RPC 2.0** text messages (one JSON object per WS message)
- Auth: handshake query `?token=<one-shot>` injected by the parent API process
- Default path: `/v1/agent`

Message rules:

| Shape | Meaning |
| --- | --- |
| object with `id` + `method` | Request |
| object with `id` + `result`/`error` | Response |
| object with `method` and **no** `id` | Notification |

## 2. Methods

### Client → Runtime

| Method | Params | Result |
| --- | --- | --- |
| `runtime.hello` | `{ clientVersion, protocolVersion }` | `{ runtimeVersion, protocolVersion, engine, capabilities[] }` |
| `runtime.health` | `{}` | `{ ok, uptimeMs, activeRuns }` |
| `agent.run.start` | `AgentRunStartParams` (ChatRequest-compatible subset + `runId`) | `{ runId, accepted }` |
| `agent.run.abort` | `{ runId, reason?: 'user'\|'timeout' }` | `{ runId, aborted }` |
| `agent.run.resume` | `{ runId, confirmed?, grants[] }` | `{ runId, accepted }` |
| `agent.memory.summarize` | `{ model, previousSummary?, turns[] }` | `{ summary }` |

### Runtime → Client (requests)

| Method | Params | Result |
| --- | --- | --- |
| `host.tool.invoke` | `{ runId, replyId, toolCalls[{id,name,input}] }` | `{ executionResults[{id,name,output,state,artifactPath?}] }` |

### Runtime → Client (notifications)

| Method | Params |
| --- | --- |
| `agent.event` | `{ runId, seq, event: AgentEvent }` |
| `agent.run.finished` | `{ runId, status: 'completed'\|'failed'\|'cancelled'\|'waiting-approval', message? }` |

`seq` is monotonic per `runId` starting at 1.

## 3. AgentEvent mapping (AS → product)

OpenClawX UI / orchestrator consume **existing** `@openclawx/contracts` `AgentEvent` types. The runtime must emit these shapes inside `agent.event`.

| AgentScope / runtime signal | AgentEvent `type` | Notes |
| --- | --- | --- |
| `ReplyStartEvent` / run accepted | `run.started` | Emit once per attempt |
| `TextBlockDeltaEvent.delta` | `message.delta` | Incremental piece |
| `ToolCallStartEvent` | `tool.started` | `toolName`, short `summary` |
| `ToolResultEndEvent` success | `tool.completed` | `ok: true` |
| `ToolResultEndEvent` error | `tool.failed` | |
| `RequireUserConfirmEvent` | `tool.approval_required` | Then `waiting-approval` |
| `RequireExternalExecutionEvent` | `tool.started` + host invoke | Host returns results → continue |
| Deliverable path from host write | `artifact.created` | Relative workspace path |
| `ModelCallEndEvent` | `run.usage` | Map tokens → `TokenUsage` |
| `ReplyEndEvent` completed | `run.completed` | Also `agent.run.finished` |
| `ReplyEndEvent` error | `run.failed` | |
| Abort / timeout | `run.cancelled` | `reason: user\|timeout` |

Hook guidance (AgentScope):

- Prefer **agent middleware / `pre_reply` / `post_reply` / tool wrappers** over scraping `print`
- Stream tokens via model streaming callbacks → `message.delta`
- Interrupt → `handle_interrupt` / cancel scope → `run.cancelled`

## 4. Capabilities advertisement

`runtime.hello.result.capabilities` may include:

- `agent.run` — full ReAct path (Phase 1+)
- `tools.workspace` — workspace file/script tools
- `tools.mcp` — MCP tool bridge
- `skills.catalog` — Agent Skill directories
- `memory.session` — session summary support
- `stub.echo` — P0 echo path for protocol tests (no real LLM)

## 5. Engine selection (API / desktop)

| Env | Effect |
| --- | --- |
| `OPENCLAWX_AGENT_ENGINE=pi` | Default. In-process pi loop (unchanged EasyAI path). |
| `OPENCLAWX_AGENT_ENGINE=agentscope` | `streamAgentReply` goes through Sidecar. |
| `OPENCLAWX_AGENTSCOPE_ENABLED=1` | Spawn/connect runtime even when engine is still `pi` (warm-up / health). |
| `OPENCLAWX_AGENTSCOPE_PYTHON` | Python executable (default `python3`). |
| `OPENCLAWX_AGENTSCOPE_TOKEN` | One-shot WS token (parent-generated). |

## 6. Compatibility

Until Phase 2 is complete, `agent.run.start` may return JSON-RPC error `-32010` (`engine.not_ready`) when AgentScope ReAct is not wired; protocol smoke uses `stub.echo` capability only.
