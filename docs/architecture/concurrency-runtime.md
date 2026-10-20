# OpenClawX 并发执行机制与进程拓扑

> 状态：随实现演进维护。本文聚焦 **multi-session / multi-user / AgentScope sidecar pool** 的运行时并发机制。
> 权威总览仍以 `architecture.md` 为准；本文展开“如何并发运行、如何隔离、如何观测、当前边界在哪”。

## 1. 目标与范围

本阶段的目标不是分布式集群，而是先把单机 Web / Desktop 场景下的并发能力做扎实：

- 多个网页标签页可同时打开同一 OpenClawX 实例
- 多个本地用户可在同一 API 进程下并发发起 run
- 同一 `session` 不会因并发发言而破坏上下文顺序
- AgentScope 不再被视为单实例黑盒，而是可池化、可限流、可观测、可恢复

当前范围：

- 单台机器
- 单个 `apps/api` 进程
- 进程内 `dispatcher`
- 同一宿主进程管理的 AgentScope sidecar 池

不在本阶段范围内：

- 多 API 实例共享全局队列
- 跨机器 sidecar 池
- 分布式锁 / 外部队列 / 多租户跨节点配额协调

## 2. 进程拓扑

```text
Browser / Renderer / Gateway Client
  -> HTTP / SSE
apps/api (Fastify, single local process)
  -> @openclawx/orchestrator
     -> InMemoryExecutionDispatcher
        -> capacity queue / priority scheduling / per-session lane
     -> RunEngine
        -> @openclawx/agent-core
           -> AgentScope sidecar pool
              -> sidecar-1 (Python process, WS RPC)
              -> sidecar-2 (Python process, WS RPC)
              -> ...
```

关键点：

1. `apps/api` 是当前单机模式下的唯一编排入口。
2. `dispatcher` 运行在 Node 进程内，负责决定哪个 run 此刻可以进入执行。
3. sidecar 池中的每个 AgentScope 实例都是独立 Python 子进程，各自占有自己的端口和 WS RPC 连接。
4. run 一旦被分配到某个 sidecar，就在那个具体进程中执行。

### 2.1 回归测试入口

为避免并发机制只停留在“设计成立”，仓库已提供可重复执行的真实 sidecar 回归入口：

```bash
pnpm concurrency:regression
```

该入口会自动准备 AgentScope runtime、启动隔离 API、运行并发压测并输出 JSON 结果，可作为单机并发能力的日常回归基线。

## 3. 隔离模型

### 3.1 身份与运行隔离

当前主链路已接入以下隔离键：

- `orgId`：未来团队协作与租户演进预留
- `userId`：用户级并发与数据所有权隔离
- `sessionId`：对话会话隔离，同一 session 强制串行
- `runId`：单次执行隔离，也是 sidecar host tool 路由的关键键

### 3.2 为什么 `sessionId` 必须串行

同一会话内如果两个 run 同时写入 transcript、同时读取旧上下文，会造成：

- 用户消息和 assistant 回复交错
- 会话摘要覆盖边界错误
- 审批恢复链路混乱

因此当前策略是：

- **同一 `sessionId` 的 chat run 串行**
- **不同 session 之间允许并发**
- **project-task 不受 session lane 串行约束**

## 4. Dispatcher：第一层并发治理

`@openclawx/orchestrator` 中的 `InMemoryExecutionDispatcher` 是当前单机模式下的第一层运行时调度器。

它负责四类约束：

1. 同 session 串行
2. 全局并发上限
3. 单用户并发上限
4. 优先级队列与防饥饿

### 4.1 容量控制

当前调度器支持：

- `maxConcurrentRunsGlobal`
- `maxConcurrentRunsPerUser`
- `maxQueueWaitMs`

效果：

- 全局系统不会因瞬时大量 run 而全部直接压进模型层
- 单个用户无法长期独占所有执行槽位
- 排队中的 run 不会无限悬挂

### 4.2 显式容量等待队列

当前已从“广播唤醒后竞争容量”的粗粒度方式，演进为**显式容量队列**：

- run 无法立即进入时，会进入 dispatcher 等待队列
- 释放容量时，由调度器主动选择下一个可运行任务
- 队列中的 run 会携带：
  - `runId`
  - `userId`
  - `priority`
  - `queuedAt`

这使得系统可以做更可解释的调度，而不是依赖 Promise 唤醒竞争时序。

### 4.3 短任务优先与长任务让行

当前默认优先级提示：

- `chat` -> `high`
- `project-task` -> `normal`

当前策略不是绝对抢占，而是：

- 先优先放行高优先级任务
- 但连续放行高优先级任务达到阈值后，如果普通优先级队列中也有可运行任务，则让一个普通优先级任务先执行

这样可以兼顾：

- 短任务响应更快
- 长任务不被永久饿死

### 4.4 Dispatcher 当前可观测状态

当前可通过运行时状态接口看到：

- `running`
- `queued`
- `activeSessions`
- `activeUsers`
- `highPriorityQueued`
- `normalPriorityQueued`
- 每个 run 的 `priority / state / waitReason / queuedAt / startedAt`

`waitReason` 当前包括：

- `session-lane`
- `user-capacity`
- `global-capacity`

## 5. AgentScope Sidecar Pool：第二层并发治理

dispatcher 决定“谁可以进入执行”；sidecar 池决定“进入执行的 run 落到哪个 Python 进程”。

### 5.1 为什么要池化

单 sidecar 虽然简单，但在并发场景下容易出现：

- 同一个 Python 解释器争抢 CPU / 内存
- host tool 回调过于拥挤
- 一个 sidecar 异常时拖累所有 run

因此当前已演进为**sidecar 池**：

- `sidecarPoolSize`：sidecar 实例数
- `sidecarSharedMaxRuns`：每个 sidecar 的最大并发 run 数

### 5.2 sidecar 池中的实例关系

sidecar 池中的每个 AgentScope 实例：

- 都是独立 Python 子进程
- 拥有自己的本地端口
- 拥有自己的 WebSocket JSON-RPC 客户端连接
- 拥有自己的 active run 计数

这意味着：

- 某个实例异常，不必拖垮整个池
- 调度可以按实例负载分摊
- 观测可以精确到单个实例

### 5.3 sidecar 选择策略

当前策略：

- 仅在健康实例中选择
- 仅在实例尚未达到单实例容量上限时选择
- 优先选择当前 `activeRuns` 更少的实例

这是一个轻量、稳定、可解释的负载分配方式。

### 5.4 run 级隔离

sidecar 并发安全的关键不只是“多进程”，还包括**run 级 host tool 路由隔离**。

当前实现已支持：

- 按 `runId` 维护独立 host request handler
- sidecar 回调 `host.tool.invoke` 时，用 `runId` 精确路由到对应宿主执行上下文

如果没有这层隔离，多 run 共用一个 sidecar 时会出现“后来的 handler 覆盖前面的 handler”的问题。

## 6. 故障治理与恢复

### 6.1 sidecar 容量等待

如果所有健康 sidecar 都达到单实例容量上限：

- 新 run 会在 sidecar 池层排队
- 等待时间超过阈值后失败

当前阈值：

- `OPENCLAWX_AGENTSCOPE_QUEUE_WAIT_MS`

### 6.2 异常实例摘除

当前以下情况会把 sidecar 标记为异常：

- 进程退出
- 进程错误事件
- `startRun` / WS 调用直接抛错

异常 sidecar 不再继续参与新 run 分配。

### 6.3 冷却恢复

异常 sidecar 会进入冷却期：

- 冷却期内不参与调度
- 仍保留在状态面板里，便于观察
- 冷却结束且没有 active runs 后，会被回收

当前冷却参数：

- `OPENCLAWX_AGENTSCOPE_RESTART_COOLDOWN_MS`

### 6.4 自动补位

如果健康 sidecar 数低于目标池大小：

- 系统会自动再拉起新的 sidecar 实例

这样可以在异常之后尽快恢复健康容量。

### 6.5 平滑缩容

如果用户把目标池大小调小：

- 空闲实例会被优先停掉
- 正在执行中的实例不会被强杀

这保证了缩容不会直接打断在途 run。

### 6.6 安全重试与实例切换

当前已支持一种保守但安全的重试：

- 如果 run 在 `startRun` 阶段失败
- 且尚未产生任何流式事件
- 则自动切换到另一个健康 sidecar 再重试一次

故意不做的事情：

- 已经产生流式输出后，不做透明重放

原因是那样会带来重复输出、重复工具执行与不可逆副作用风险。

## 7. 运行时观测

当前 `设置 -> 通用 -> 运行时并发状态` 已能看到两层状态：

### 7.1 Dispatcher 视角

- 全局并发上限
- 单用户并发上限
- 高优先级突发阈值
- 高/普通优先级排队数量
- 每个 run 的状态、等待原因与时长

### 7.2 Sidecar 池视角

- 目标池大小
- 健康 sidecar 数
- 异常实例数
- 冷却中的实例数
- sidecar 排队超时阈值
- 重启冷却时长
- 每个 sidecar 的：
  - `status`
  - `port`
  - `activeRuns`
  - `lastError`
  - `cooldownRemainingMs`

当前状态推送方式：

- `GET /api/runtime/status`
- `GET /api/runtime/status/stream`（SSE）

## 8. 当前适用范围

可以认为当前已经比较适合：

- 单机部署
- 单个 API 进程
- 多标签页
- 多本地用户
- 中等并发

还不应直接视为已完成的范围：

- 多 API 进程共享调度
- 跨机器 sidecar 池
- 分布式租户级配额
- 流式中途失败后的无损迁移

## 9. 后续演进建议

如果继续向生产级高并发 Web 服务推进，建议下一阶段重点是：

1. 把 `dispatcher` 从进程内状态演进到外部协调层
2. 引入更细粒度任务画像，而不是仅按 `chat / project-task`
3. 补 sidecar 熔断窗口、失败率阈值与自愈指标
4. 增加系统化压测、故障注入与回归基线
