# ADR-0001：eSight 作为能力模型 Provider 接入

> 状态：已接受  
> 日期：2026-09-23  
> 接受日期：2026-09-23  
> 决策基线：eSight SDD 0.3.0  
> 决策所有者：OpenClawX 架构组
> 需求与验证：[应用模型能力 SDD](../../sdd/features/application-model-capabilities/README.md)

## 1. 决策摘要

OpenClawX 将 eSight 作为 `quantum-code` 能力模型接入现有模型管理和运行时：

- eSight 通过 OpenAI-compatible HTTP API 被 Model Provider 调用；
- 主控 Agent 继续使用强通用模型负责规划、Loop、工具选择和汇总；
- Capability Router 根据能力选择 eSight，不替换主控模型；
- Agent 表现层可使用类似 function/tool call 的结构化 capability call；
- 内部 Dispatcher 必须区分 Model Provider 后端与 Tool/MCP 后端；
- 编译、模拟、真机和外部状态操作继续通过 Tool/MCP 完成；
- eSight 输出必须由独立 Verifier 验证。

OpenClawX 已有模型管理，因此不为 eSight 新建一套平行 Model Gateway。若现有运行时缺少能力路由、健康、熔断和审计，则在现有模型运行时内补齐，而非部署重复网关。

## 2. 上下文

eSight 是量子领域小模型，具有领域代码生成和修复能力，但其长程规划、复杂 Agent Loop 和长上下文能力弱于主流通用模型。与此同时，Quantummate 已经具备 Provider/模型配置、Agent、工具和 MCP 能力。

系统需要同时解决：

1. 如何让主控 Agent 在量子任务中利用 eSight；
2. 如何避免用 eSight 替换整个 Agent 大脑；
3. 如何区分“调用专业模型”和“执行外部动作”；
4. 如何复用统一结构化调用体验，而不混淆模型和工具治理；
5. 如何扩展到图片、语音、embedding 等其他专业模型。

## 3. 决策驱动因素

- 最大化复用 Quantummate 已有模型管理能力；
- 保持主控模型的规划和循环质量；
- 让 eSight 专注窄域、可验证的量子代码任务；
- 避免双模型网关、双权限和双路由；
- 支持模型版本、成本、token 和健康治理；
- 支持工具权限、幂等、审批和副作用治理；
- 允许 Agent 在统一结构化调用机制下使用两类后端；
- 保持未来多模态模型接入的可扩展性。

## 4. 决策细节

### 4.1 双模型角色

```text
Agent Model
  - 意图理解
  - 任务规划
  - Loop 控制
  - 工具选择
  - 最终汇总

Capability Model: eSight
  - 量子代码生成
  - 量子代码修复
  - 量子领域解释
  - SDK 迁移子任务
```

二者必须可独立配置和升级。切换 eSight 版本不改变 Agent 主模型；切换 Agent 主模型不改变 eSight Champion。

### 4.2 统一 Dispatcher、不同后端

```text
Agent function/capability call
            |
    Capability Dispatcher
       /              \
Model Capability     Tool Capability
       |                    |
Provider Runtime       Tool/MCP Runtime
       |                    |
eSight / ASR / Image   Sandbox / Device / DB
```

统一的是结构化调用、trace 和编排体验；不统一的是后端语义与治理策略。

### 4.3 Provider 类型

Quantummate 的 Provider Runtime 应按能力区分接口，而不是把所有模型压入 Chat Completion：

| Provider 接口 | 典型能力 |
| --- | --- |
| Chat/Code Provider | 通用模型、eSight |
| Vision Provider | 图片理解 |
| Image Generation Provider | 图片生成 |
| Speech-to-Text Provider | 语音识别 |
| Text-to-Speech Provider | 语音合成 |
| Embedding Provider | bge-m3 等向量模型 |
| Rerank Provider | 检索重排 |

### 4.4 Model Provider 与 Tool/MCP 的治理差异

| 维度 | Model Provider | Tool/MCP |
| --- | --- | --- |
| 语义 | 推理、生成、编码、转换 | 查询或改变外部状态 |
| 重点参数 | messages、temperature、max tokens、模型版本 | schema、权限、超时、幂等、审批 |
| 观测 | token、时延、成本、模型版本 | 状态、错误码、资源 ID、副作用 |
| 失败策略 | 重试、换模型、能力降级 | 重试、补偿、查询状态、人工确认 |
| 示例 | eSight、ASR、图片生成、embedding | quantum.run、submit_device、文件和数据库 |

### 4.5 eSight 端到端链路

```text
主控 Agent
  -> capability=quantum-code
  -> Dispatcher
  -> eSight Provider 组装版本化领域提示
  -> POST eSight /v1/chat/completions
  -> 得到代码
  -> quantum.run Tool/MCP
  -> Verifier
  -> 成功返回，或将结构化错误交给 eSight 修复
  -> 达到轮次上限后升级/终止
```

## 5. 备选方案

### 方案 A：eSight 替换主控 Agent 模型

不采纳。eSight 当前适合窄域代码生成，不适合默认承担复杂规划、长上下文和通用 Tool Loop。可以保留受控实验模式，但不是生产默认路径。

### 方案 B：把 eSight 包装为 MCP Server

不采纳为主路径。虽然可将 `generate_quantum_code` 表现为工具调用，但 MCP 会混淆模型路由与工具路由，并弱化流式生成、模型参数、token、上下文窗口和模型版本治理。对外 MCP Tool 可以间接使用 eSight，但底层仍必须进入 Provider Runtime。

### 方案 C：为 eSight 单独建设 Model Gateway

不采纳。Quantummate 已有模型管理，重复建设将产生双注册表、双权限、双熔断、双观测和版本不一致。仅当未来多个独立平台共享模型、需要跨语言统一治理时，再评估拆分独立服务。

### 方案 D：所有能力都作为 Tool

不采纳为内部架构。Agent 表现层可以统一为结构化调用，但 Provider 和 Tool 必须保留类型区分，以支持正确的生命周期、权限和指标。

## 6. 后果

### 正面影响

- 充分利用 eSight 专业能力而不牺牲主 Agent 质量；
- 与现有模型管理和 `packages/agent-core` 边界一致；
- Tool/MCP 权限和模型治理不互相污染；
- 可以自然扩展图像、语音、embedding、rerank 等 Provider；
- 量子代码形成可执行、可修复、可回流的闭环。

### 成本与风险

- 需要实现 Capability Dispatcher 和 Provider/Tool 类型区分；
- 需要维护量子领域提示模板及版本；
- 需要独立 Verifier 和安全执行环境；
- 能力子调用可能增加延迟和 token 成本；
- 若路由分类错误，可能漏用 eSight 或错误委派。

## 7. 约束

- 只有 `packages/agent-core` 可调用模型 SDK 或模型 HTTP 接口；
- 契约在 `@openclawx/contracts` 中定义；
- 编排状态归 `@openclawx/orchestrator`，由 `apps/api` 托管；
- eSight 端点和密钥不得出现在 renderer、Skill 文本或域数据中；
- 生成代码必须经过 Verifier；
- 修复循环必须有硬上限；
- 不允许静默调用外部模型；
- Online、Evaluation、Training 端点不得混用。

## 8. 决策复审条件

出现以下任一情况时复审：

1. eSight 经基准验证具备与主控模型相当的长程 Agent 能力；
2. Quantummate 出现多个独立业务系统共享模型运行时；
3. MCP 协议新增原生、标准化的模型 Provider 语义；
4. eSight 不再提供 OpenAI-compatible API；
5. 模型能力调用的流式、多模态或实时需求超出现有 Runtime 能力。

## 9. M0 补充决策

- 首期 `requestTimeoutMs=60000`，`totalDeadlineMs=300000`；总 deadline 优先于单请求超时；
- v2→v3 往返保留未知 capability 记录但不激活、不路由；安全、权限和执行策略对象出现未知字段时拒绝保存；
- Verifier 基础设施超时只允许一次幂等重试，且不计修复轮次、不得突破总 deadline；
- `preferred` 只在任务已匹配时提高委派优先级；置信度不足时保持主控路径，不弹出阻塞式询问；
- 单次任务覆盖在任务创建页设置，运行详情页只展示最终有效策略和来源；
- Qiskit 首期执行采用独立 Sandbox Adapter。CI 使用 Fake Verifier；受控 E2E 使用无网络、非 root、只读基础文件系统并设置 CPU、内存、进程数和时限的 OCI 容器；环境不具备这些隔离条件时不得降级为宿主机直接执行；
- 真实 eSight 端点、模型版本和 Sandbox 实例属于里程碑环境准入，不阻塞本 ADR 的架构接受，也不能在未验证时标记对应里程碑通过；
- `BM-ESIGHT-001` 以 controller-only/`disabled` 为基线，对 `auto`、`preferred` 比较成本与质量，不以 Token 单指标决定是否启用。
