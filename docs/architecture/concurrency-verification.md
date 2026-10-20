# OpenClawX 并发压测与验收清单

> 目的：把“看起来能并发”推进到“有证据证明可靠”。
> 适用范围：当前单机、单 API 进程、AgentScope sidecar 池模式。

## 1. 验收目标

本清单主要验证四件事：

1. 多 session、多用户并发执行不会互相串话或破坏状态
2. dispatcher 的限流、优先级、排队与超时行为符合预期
3. sidecar 池的分流、故障摘除、冷却恢复、自动补位与缩容符合预期
4. 运行时观测面板与实际执行状态一致

## 2. 压测前准备

### 2.1 建议环境

- Node.js >= 22
- `OPENCLAWX_AGENT_ENGINE=agentscope`
- 本机 CPU / 内存可承载至少 `2` 个 sidecar 实例
- 已完成 `openclawx init`
- 至少配置一个可稳定返回的模型 provider

### 2.2 建议运行参数

基础压测建议先从以下参数起步：

```bash
export OPENCLAWX_AGENT_ENGINE=agentscope
export OPENCLAWX_MAX_CONCURRENT_RUNS_GLOBAL=4
export OPENCLAWX_MAX_CONCURRENT_RUNS_PER_USER=2
export OPENCLAWX_MAX_QUEUE_WAIT_MS=120000
export OPENCLAWX_AGENTSCOPE_POOL_SIZE=2
export OPENCLAWX_AGENTSCOPE_SHARED_MAX_RUNS=4
export OPENCLAWX_AGENTSCOPE_QUEUE_WAIT_MS=120000
export OPENCLAWX_AGENTSCOPE_RESTART_COOLDOWN_MS=15000
```

然后启动：

```bash
pnpm dev
```

### 2.3 一键回归入口

为了把并发压测纳入日常回归，仓库已提供：

```bash
pnpm concurrency:regression
```

该命令会自动执行以下步骤：

1. 准备或复用可用的 AgentScope runtime
2. 创建隔离的临时 `OPENCLAWX_DATA_DIR`
3. 启动独立 API 进程并显式启用 sidecar 池
4. 运行 `scripts/concurrency-loadtest.mjs`
5. 输出 JSON 结果并清理临时进程与目录

默认回归参数：

```text
global=2
perUser=1
dispatcherQueueWaitMs=120000
sidecarPoolSize=2
sidecarMaxRuns=1
sidecarQueueWaitMs=120000
sidecarRestartCooldownMs=15000
```

如需覆盖，可在命令前设置对应环境变量，例如：

```bash
OPENCLAWX_AGENTSCOPE_POOL_SIZE=3 \
OPENCLAWX_AGENTSCOPE_SHARED_MAX_RUNS=2 \
pnpm concurrency:regression
```

## 3. 基础验收清单

### A. 多 session 并发

- [ ] 同一用户创建 `3` 个不同 session，并同时发送请求
- [ ] 预期：三个 session 均可进入运行，不发生 transcript 串话
- [ ] 预期：运行时状态面板中可看到多个 session 并发运行
- [ ] 预期：各自 `runId` 独立，最终消息回写到各自 session

### B. 同 session 串行

- [ ] 在同一 session 中快速连续发送 `2-3` 条消息
- [ ] 预期：后续 run 进入 `session-lane` 等待，而不是并发执行
- [ ] 预期：运行时面板可明确显示等待原因是 `session-lane`
- [ ] 预期：前一个 run 完成后，下一个 run 才开始

### C. 多用户并发

- [ ] 本地创建至少 `2` 个用户账号
- [ ] 两个用户分别打开浏览器标签页，同时发起请求
- [ ] 预期：用户之间可以并发执行
- [ ] 预期：一个用户的本地存储与会话列表不会污染另一个用户
- [ ] 预期：状态面板中的 `activeUsers` 能反映当前活跃用户数

## 4. Dispatcher 验收清单

### D. 全局并发上限

- [ ] 把 `OPENCLAWX_MAX_CONCURRENT_RUNS_GLOBAL` 设为 `2`
- [ ] 同时发起 `4` 个可观测长请求
- [ ] 预期：最多 `2` 个进入运行，其余进入 dispatcher 队列
- [ ] 预期：等待原因为 `global-capacity`
- [ ] 预期：面板中的 `running=2`，`queued=2`

### E. 单用户并发上限

- [ ] 把 `OPENCLAWX_MAX_CONCURRENT_RUNS_PER_USER` 设为 `1`
- [ ] 同一用户从多个标签页同时发起 `3` 个请求
- [ ] 预期：只有 `1` 个 run 在运行，其余等待
- [ ] 预期：等待原因为 `user-capacity`

### F. 优先级与让行

- [ ] 同时准备两类负载：
  - 短任务：普通 chat 请求
  - 长任务：project-task 或带明显工具调用/长推理的任务
- [ ] 在系统容量紧张时同时发起
- [ ] 预期：短任务优先开始
- [ ] 预期：长任务不会一直饿死，应在高优先级突发阈值后获得执行机会
- [ ] 预期：面板中可以看到 `highPriorityQueued` 与 `normalPriorityQueued`

### G. Dispatcher 排队超时

- [ ] 把 `OPENCLAWX_MAX_QUEUE_WAIT_MS` 暂时调低到 `5000`
- [ ] 构造足够多的并发请求，使部分 run 无法及时得到容量
- [ ] 预期：超时 run 进入失败态
- [ ] 预期：错误信息明确指向 dispatcher queue timeout

## 5. Sidecar 池验收清单

### H. 多 sidecar 分流

- [ ] 将 `Sidecar 实例数` 配为 `2` 或以上
- [ ] 同时发起多个 run
- [ ] 预期：状态面板中可见多个不同 sidecar 端口
- [ ] 预期：`activeRuns` 会分散在多个 sidecar 实例上，而不是只压在一个进程

### I. 单实例容量上限

- [ ] 将 `每个 Sidecar 最大并发` 设为 `1`
- [ ] 池大小设为 `2`
- [ ] 同时发起 `4` 个请求
- [ ] 预期：最多 `2` 个 run 进入 sidecar 运行，另外 `2` 个在 sidecar 层等待
- [ ] 预期：等待中的 run 能在状态面板里观察到

### J. Sidecar 队列超时

- [ ] 将 `OPENCLAWX_AGENTSCOPE_QUEUE_WAIT_MS` 暂时调低到 `5000`
- [ ] 构造足够多请求使 sidecar 层持续无空闲容量
- [ ] 预期：超时 run 失败
- [ ] 预期：错误信息明确指向 sidecar pool queue timeout

### K. 异常实例摘除与自动补位

- [ ] 运行中手动终止某个 sidecar 进程，或制造其 `startRun` 失败
- [ ] 预期：该实例被标记为 `unhealthy` 或进入 `cooldown`
- [ ] 预期：后续新 run 不再优先分配给该实例
- [ ] 预期：健康实例数低于目标池大小时，会自动补起新实例

### L. 冷却与恢复观察

- [ ] 在 sidecar 异常后观察状态面板
- [ ] 预期：可以看到实例处于 `cooldown`
- [ ] 预期：能看到剩余冷却时间
- [ ] 预期：冷却期结束后，异常空闲实例会被回收

### M. 缩容

- [ ] 先把池大小升到 `3`
- [ ] 再将池大小下调到 `1`
- [ ] 预期：空闲实例逐步退出
- [ ] 预期：仍在执行中的 sidecar 不被强制中断

### N. 启动前失败自动切换

- [ ] 制造某个 sidecar 在 `startRun` 阶段失败
- [ ] 预期：当前 run 自动切换到另一健康 sidecar
- [ ] 预期：仅重试 `1` 次
- [ ] 预期：如果已产生流式事件，则不会透明重放

## 6. 观测一致性验收

### O. 状态面板与真实执行一致

- [ ] 运行时并发状态面板保持开启
- [ ] 同时观察请求发起、run 完成、sidecar 异常、池补位
- [ ] 预期：面板中的：
  - `running / queued`
  - `activeUsers / activeSessions`
  - `highPriorityQueued / normalPriorityQueued`
  - `sidecars / unhealthySidecars / coolingSidecars`
  与实际现象一致

### P. SSE 与回退轮询

- [ ] 正常状态下观察“实时流已连接”
- [ ] 人为让 SSE 断开
- [ ] 预期：面板可回退为轮询
- [ ] 恢复 SSE 后，预期：面板重新进入实时状态

## 7. 压测记录模板

建议每轮压测至少记录以下信息：

```text
日期：
机器配置：
Node 版本：
是否 Desktop / Web：
模型提供商：

dispatcher 参数：
- global:
- perUser:
- queueWaitMs:
- highPriorityBurstLimit:

sidecar 参数：
- poolSize:
- maxRunsPerSidecar:
- queueWaitMs:
- restartCooldownMs:

压测场景：
并发数：
用户数：
session 数：

结果：
- 成功数：
- 失败数：
- 平均开始等待时长：
- 最大排队时长：
- 是否出现串话：
- 是否出现 run 丢失：
- 是否出现 sidecar 异常：
- 是否成功补位：

结论：
```

## 8. 最近一次真实 sidecar 池回归结果

在本机使用真实 AgentScope sidecar 池回归，参数如下：

```text
engine=agentscope
global=2
perUser=1
sidecarPoolSize=2
sidecarMaxRuns=1
```

结果摘要：

- `per-user-limit`
  - `maxQueued=1`
  - `maxRunning=1`
  - 观察到 `user-capacity`
  - 两个 admin run 全部 `completed`
- `global-limit-mixed-users`
  - `maxQueued=2`
  - `maxRunning=2`
  - 观察到 `user-capacity` 与 `global-capacity`
  - admin/member 四个 run 全部 `completed`

说明：

- 此轮使用 stub 路径验证并发调度、排队、sidecar 分流与收敛，不依赖外部模型服务稳定性
- 若改为真实模型提供商做回归，需区分“运行时并发机制失败”和“上游模型/网络波动失败”

## 9. 通过门槛建议

若要认为当前单机并发机制“可靠可交付”，建议至少满足：

- [ ] 连续 `3` 轮多 session 并发，无串话、无 run 丢失
- [ ] 多用户并发下，用户配额与全局配额行为符合预期
- [ ] sidecar 异常注入后，能成功摘除并补位
- [ ] 缩容不影响在途 run
- [ ] `startRun` 失败切换重试符合预期
- [ ] 状态面板与真实执行一致
- [ ] 压测中未出现不可解释的卡死、僵尸 run、无限排队

## 10. 建议的下一步自动化

当前清单偏人工与半人工。后续建议逐步自动化为：

1. 将 `pnpm concurrency:regression` 接入 CI 或发布前检查
2. sidecar 故障注入脚本
3. 队列与优先级断言脚本
4. SSE 状态一致性快照脚本
5. 发布前最小并发回归套件
