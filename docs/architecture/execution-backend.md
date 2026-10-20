# ExecutionBackend：统一执行抽象

> 状态：已落地注册表；内置 `pi` / `agentscope` / `dsh`。  
> 与 `architecture.md`、`concurrency-runtime.md`、`agentscope-abi.md` 配套。

## 1. 目标

在 **不拆散 Orchestrator 产品面** 的前提下，支持多个 agent 执行引擎：

| id | 形态 | 状态 |
|----|------|------|
| `pi` | API 进程内 pi-agent-core | ✅ 默认 |
| `agentscope` | Python Sidecar 池 | ✅ 可选 |
| `dsh` | DeepSeek Harness 编码 Sidecar（JSON-RPC） | ✅ Phase 1（需本机 runtime） |

原则：

- **编排唯一**：会话 / Run / 审批 / SSE / dispatcher 只认 `ChatRequest` → `AgentEvent`
- **后端可插拔**：具体循环、工具、沙箱属于各 `ExecutionBackend`
- **路由可演进**：今日靠 env；明日靠员工 / 意图 hints，不改 Orchestrator

## 2. 分层

```text
Renderer / Gateway
  → /api/orch  (Orchestrator + AgentRunner)
       → streamAgentReply(input, resolve?)
            → resolveExecutionBackend(...)
            → backend.stream(...)   // pi | agentscope | dsh
```

- `packages/orchestrator` → `AgentRunner`（可测试注入）
- `packages/agent-core` → `ExecutionBackend` 注册表 + `streamAgentReply`

## 3. API（`@openclawx/agent-core`）

| 符号 | 作用 |
|------|------|
| `ExecutionBackend` | `{ id, label, capabilities, stream }` |
| `registerExecutionBackend` | 注册 / 覆盖 |
| `resolveExecutionBackend` | 解析本回合后端 |
| `streamAgentReply` | 产品入口：resolve 后 stream |
| `resolveAgentEngine` | 兼容旧调用，返回 id |
| `listExecutionBackends` | 观测 / 设置页 |

### 解析优先级

1. `override`（调用方强制）
2. `OPENCLAWX_AGENT_ENGINE` **且** `OPENCLAWX_AGENT_ENGINE_FORCE=1`（运维强制，绕过 allowlist）
3. `ChatRequest.engine` / 员工 prefs（须 ∈ `enabledEngines`）
4. runtime-settings `defaultEngine`（须 ∈ allowlist）
5. `preferCoding` → `dsh` / `preferProcessIsolation` → `agentscope`（须 ∈ allowlist）
6. 软 `OPENCLAWX_AGENT_ENGINE`（无 FORCE 时仅作回退，须 ∈ allowlist）
7. allowlist 中第一个已注册后端，否则 `pi`

> 注意：桌面启动器**不再**默认注入 `OPENCLAWX_AGENT_ENGINE=pi`，否则会盖住员工配置的 dsh。

### 两层配置

| 层 | 存储 | 字段 |
|----|------|------|
| 部署 | `~/.openclawx/runtime-settings.json`（`/api/settings/runtime`） | `enabledEngines`, `defaultEngine` |
| 员工 | `workspace.employee-runtime-prefs` | `engine: pi\|agentscope\|dsh\|null`（null=继承默认） |

显式请求未注册的 id 会 **抛错**。员工选了未启用引擎时 **回退** 到 default / allowlist。

### capabilities（供路由 / 配额）

- `coding` / `sandbox` / `processIsolated` / `pooled`

并发层（dispatcher）仍全局限流；后续可按 `capabilities` 做 **per-backend 配额**（见 concurrency-runtime 演进）。

## 4. 接入 dsh

详见 [dsh-sidecar.md](dsh-sidecar.md)。摘要：

1. `ExecutionBackend` `id: 'dsh'` 已在 `execution-backends.ts` 注册
2. 本机需 sibling `deepseek-harness` 或 `OPENCLAWX_DSH_BIN`（可选 `OPENCLAWX_DSH_ROOT`）
3. 默认按回合用 OpenClawX `ModelConfig` 生成 `llm-pi-ai` cordis；`OPENCLAWX_DSH_CORDIS` 可覆盖
4. `OPENCLAWX_AGENT_ENGINE=dsh`、设置页默认引擎、或员工 prefs `engine: dsh`（须在 enabledEngines 内）
5. 事件经自包含 JSON-RPC 客户端映射为 `AgentEvent`

## 5. 关键路径

| 文件 | 说明 |
|------|------|
| `packages/agent-core/src/execution-backend.ts` | 类型 + 注册表 + resolve |
| `packages/agent-core/src/execution-backends.ts` | 内置 pi / agentscope 注册 |
| `packages/agent-core/src/stream-reply.ts` | 产品入口 |
| `packages/orchestrator/src/runner.ts` | `agentCoreRunner` → `streamAgentReply` |
