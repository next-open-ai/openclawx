# UTI-001 · 统一 Agent Tool Interface

> 类型：平台基础设施工单  
> 状态：实现完成，待验收  
> 优先级：P0  
> 创建日期：2026-09-24  
> 依赖：现有 `ExecutionBackend`、Pi Tool、AgentScope Host Tool、dsh MCP Bridge  
> 阻塞：AMC-001 通用应用模型机制

## 1. 问题

Pi、AgentScope、dsh 已分别具备工具调用路径，但目录表示、执行入口、结果、取消和事件映射仍由各后端自行处理。若直接在每个引擎中接入应用模型，将造成三套 Schema 注册、Provider 调用和事件逻辑，并使新增能力必须修改所有 Agent Loop。

## 2. 目标

建立唯一、执行引擎无关的 Agent Tool Interface。工具注册一次后，Pi、AgentScope、dsh 均能发现和调用；执行引擎只保留 Transport Adapter。

```text
ExecutionBackend
  -> Tool Transport Adapter
  -> Unified Tool Catalog / Invocation / Result / Event
  -> Tool Backend
```

## 3. 范围

### 包含

- 归一化 `ToolDescriptor`、`ToolInvocation`、`ToolResult`、`ToolError` 和生命周期事件；
- 统一 Tool Registry、授权过滤、名称冲突规则、取消、deadline 和结果限长；
- Pi、AgentScope、dsh Transport Adapter；
- Platform Tool、MCP Tool 和未来 Model Capability Tool 的统一注册入口；
- `tool.*` 基础事件以及由上层 Backend 衍生领域事件的扩展点；
- 每次调用使用稳定 `invocationId` 贯穿引擎、Orchestrator、SSE 和 Renderer，禁止仅按工具名关联开始/结束事件；
- 长时调用可发出 `tool.progress` / `capability.progress`，按同一 `invocationId` 原位更新，不增加伪步骤或消耗额外模型轮次；
- 同一测试工具跨三个执行引擎的一致性回归。

### 不包含

- eSight、图片、Embedding、ASR、TTS 的供应商协议；
- 业务能力路由、模型绑定和模型计费；
- Tool/MCP 业务实现重写；
- 将所有工具强制转换为远程 MCP 服务。

## 4. 架构约束

1. `@openclawx/contracts` 是公共 DTO 和事件的事实源；
2. `packages/agent-core` 持有 Registry、Dispatcher 和 Transport Adapter；
3. Tool Backend 不感知 `pi | agentscope | dsh`；
4. Transport Adapter 不包含工具业务逻辑；
5. Renderer、API、Orchestrator 不直接调用 Tool Backend；
6. disabled/未授权工具不得进入模型可见目录；
7. MCP 是一种 Tool Backend/Transport，不是统一接口本身。

## 5. 拟定公共契约

```text
ToolDescriptor
  id, name, description, inputSchema, category, risk, permissions

ToolInvocation
  version, invocationId, runId, traceId, toolId, input,
  deadlineAt, authorizationContext

ToolResult
  status, output, artifacts, usage, error, startedAt, completedAt

ToolTransportAdapter
  publishCatalog(descriptors)
  invoke(invocation)
  cancel(invocationId)
```

具体字段须先在 `@openclawx/contracts` 以 Zod 冻结，禁止从某一引擎的私有 Tool 类型直接导出为公共契约。

## 6. 实施拆解

| 子任务 | 内容 | 主要模块 |
| --- | --- | --- |
| UTI-001-01 | 盘点三引擎工具 Schema、调用、结果和事件差异 | `packages/agent-core`、`runtimes` |
| UTI-001-02 | 冻结公共 Tool ABI 和稳定错误码 | `packages/contracts` |
| UTI-001-03 | 实现 Tool Registry、Dispatcher 和授权过滤 | `packages/agent-core` |
| UTI-001-04 | Pi 改为消费统一 Registry | `packages/agent-core` |
| UTI-001-05 | AgentScope Host Tool 改为统一 Transport Adapter | `packages/agent-core`、AgentScope runtime |
| UTI-001-06 | dsh Bridge 改为统一 Transport Adapter | `packages/agent-core`、dsh runtime |
| UTI-001-07 | 统一事件、取消、deadline、产物和错误映射 | `contracts`、`agent-core` |
| UTI-001-08 | 三引擎契约与集成回归 | `packages/agent-core/src/test`、scripts |

## 7. 验收标准

- [ ] 同一测试工具只注册一次，Pi、AgentScope、dsh 均能发现并调用；
- [ ] 三个引擎产生语义一致的 invocation、result 和事件；
- [x] 同名连续/并发调用按 `invocationId` 独立结算，SSE 与轮询合并不重复；
- [ ] 未授权工具不进入任何引擎的模型上下文；
- [ ] 取消和 deadline 能从执行引擎传递到 Tool Backend；
- [ ] Tool Backend 源码中没有执行引擎判断；
- [ ] Transport Adapter 源码中没有具体工具业务分支；
- [ ] 现有 Platform/MCP 工具行为和权限回归通过；
- [ ] 新增 Tool Backend 不需要修改三个 Agent Loop。

## 8. 测试要求

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| UTI-T-001 | 单个 echo 工具跨三引擎调用 | 输入、输出和事件一致 |
| UTI-T-002 | 工具未授权 | 三引擎目录均不可见，且无调用请求 |
| UTI-T-003 | 重名工具注册 | 按稳定规则拒绝或命名空间化，不静默覆盖 |
| UTI-T-004 | deadline/取消 | Backend 收到终止信号并返回稳定状态 |
| UTI-T-005 | 工具异常和超大输出 | 错误结构稳定，输出被安全裁剪 |
| UTI-T-006 | MCP、Platform Tool 回归 | 既有功能、权限和产物不退化 |
| UTI-T-007 | 两个同名工具调用交错结束 | 每个调用只显示一条活动，状态与各自 `invocationId` 对应 |

## 9. 迁移与回滚

- 采用适配器包裹现有工具实现，先双轨验证，再移除各引擎私有分发；
- 不同时重写工具业务实现；
- 保留旧路径的短期特性开关，发生回归时可按执行引擎回退；
- 回滚不得改变公共 Tool ABI 或已持久化事件。

## 10. 完成定义

所有验收项和 UTI-T-001～006 通过，三引擎不再持有独立工具业务分发逻辑，并形成可供 AMC-001 复用的稳定 Registry/Dispatcher/Transport 接口后，工单方可标记完成。

## 11. 过程状态

| 时间 | 状态 | 结果与证据 |
| --- | --- | --- |
| 2026-09-24 | 待评审 | 工单建立，冻结“注册一次、三引擎调用”的目标与边界 |
| 2026-09-24 | 进行中 | 在 `@openclawx/contracts` 增加 Descriptor/Invocation/Result v1；实现 `unified-tool-runtime.ts` Registry/Dispatcher |
| 2026-09-24 | 进行中 | Pi 改为消费统一 Session；AgentScope 的 MCP 与应用模型工具统一进入 Host Transport；dsh 增加 run-scoped 本地 MCP Transport |
| 2026-09-24 | 实现完成，待验收 | UTI 专项测试覆盖注册、重复 ID、deadline、取消、AgentScope Host Transport、dsh MCP Transport；五包类型检查通过 |
| 2026-09-24 | 边界复核通过 | 国产生图新增三类 Provider Adapter 时未修改 Pi、AgentScope、dsh Tool Transport 或 Agent Loop，验证供应商协议可以只扩展 AMC Backend；UTI 状态仍为“待验收”，不因 AMC 局部回归提前关闭。 |
| 2026-09-24 | 缺陷修复完成 | `invocationId` 已贯穿 Pi、AgentScope、dsh、Orchestrator、SSE 与 Renderer；新增同名 Bash 交错结束回归，修复按 `toolName` 合并导致的重复失败活动。 |
| 2026-10-03 | Bash 可观测性增强 | Pi Bash 活动保存经过脱敏和限长的命令与输出；Orchestrator 合并起止详情，聊天执行步骤可按需展开，并区分用户中止与命令自身失败。 |
| 2026-10-03 | 长任务误取消修复 | Bash 详情入口收进状态行；Renderer 不再用 120 秒界面静默阈值取消服务端运行，长编码任务统一服从服务端可配置运行超时。 |
| 2026-10-03 | 默认执行预算调整 | 数字员工、Agent Core、AgentScope、Orchestrator 与项目调度的整轮默认超时统一为 30 分钟；旧的 10 分钟默认配置自动迁移。 |
| 2026-10-03 | 前端等待预算对齐 | 移除聊天镜像层固定 12 分钟截止线；等待器按实际运行预算加两分钟结算缓冲，避免前端先于服务端取消长任务。 |
| 2026-09-24 | OpenClawX 同步完成，待 E2E | UTI 实现已同步到 OpenClawX；专项测试 `4/4`、同名 invocation 回归 `1/1`、五包类型检查、API 与 Renderer 生产构建通过。真实安装态 AgentScope/DSH E2E 尚未执行。 |

当前验收说明：UTI 新增专项用例通过；OpenClawX `agent-core` 全量 `92/92` 通过。真实 AgentScope/dsh runtime E2E 仍需在具备运行环境时执行，因此本工单保持“待验收”。
