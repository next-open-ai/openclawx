# 应用模型能力运行时设计

> 状态：核心实现已同步，待真实 Provider 与安装态三引擎验收  
> 更新：2026-10-07
> 同步源：`quantummate/docs/architecture/application-model-capability-runtime.md`

## 1. 定位与目标

应用模型（Capability Model）负责图片生成与理解、Embedding、ASR、TTS、量子代码、有限问题决策和本体语义匹配等专门能力。它不是主控 Agent 的规划模型，也不替换 Agent Loop；主控模型仍负责理解、规划、选择能力和综合结果。

方案目标：

1. Provider、模型、业务能力和供应商协议分开建模；
2. 一个能力 Backend 供 Pi、AgentScope、DSH 等执行引擎复用；
3. 主控模型通过稳定、类型化的能力工具调用，不接触供应商协议和临时凭证；
4. 同步和异步模型具备统一生命周期、进度、错误与产物语义；
5. 临时 URL 由平台自动归档，不要求主控模型编写 Bash/Python；
6. 长时任务直接向 UI 推送进度，不增加主模型轮次和 Token。

## 2. 概念与边界

| 概念 | 职责 |
| --- | --- |
| 主控模型 | 规划、Agent Loop、能力选择和结果综合 |
| Capability Model Provider | 供应商连接、鉴权和模型目录，例如 OpenAI-compatible、DashScope、eSight |
| Capability Model | 图片、Embedding、ASR、TTS、quantum-code 等模型实例 |
| Capability Router | 按员工开关、任务类型和绑定选择能力模型 |
| Capability Backend | 参数归一、协议调用、异步轮询和产物处理 |
| Unified Tool Interface | 跨执行引擎的目录、调用、结果和生命周期协议 |
| MCP | 可选的远程工具传输或 Backend，不是本机制的必选实现 |

应用模型在产品上属于“模型能力”，在执行形态上复用 Tool Call。Tool Interface 是执行协议，Capability 是业务语义，不能把二者混为一种配置对象。

## 3. 总体架构

```text
Controller LLM / Agent Loop
        │ typed capability invocation
        ▼
Unified Tool Interface
  descriptor · invocationId · result · progress · error
        ▼
Capability Router
  employee switch · binding · auto/preferred/disabled
        ▼
Capability Backend                 ← 与执行引擎无关
  provider adapter · async poller · downloader · artifact writer
        ├── OpenAI-compatible
        ├── DashScope native
        ├── eSight capability provider
        └── future adapters
        ▼
Run Workspace / Artifact Registry

capability.started / progress / completed / failed
        ▼
Orchestrator / SSE / Renderer activity row
```

Pi 消费原生 Tool View；AgentScope 使用 Host Tool Transport；DSH 使用运行级本地桥接。新增 Provider 协议只扩展 Capability Backend，不应修改三个 Agent Loop。

## 4. 配置与路由

Provider 配置保存连接信息；模型配置保存模型 ID、能力类型和可选协议；系统绑定为每类能力选择默认模型。员工侧只提供“使用应用模型”总开关，默认开启：开启时将所有已绑定且配置有效的应用模型以 `auto` 模式提供给智能体，关闭时不提供应用模型。决策模型仍由全局决策守卫策略控制，不混入员工开关。

底层继续兼容以下能力模式契约，供运行级路由和旧数据读取使用；员工 UI 不再要求用户逐类别设置：

| 模式 | 语义 |
| --- | --- |
| `disabled` | 不进入本次运行的模型可见目录 |
| `auto` | 任务匹配时由主控模型调用 |
| `preferred` | 匹配任务时优先使用，但不替换主控模型 |

旧员工配置中缺少总开关时按“开启”迁移；历史逐能力授权记录保留但不再作为运行时选择来源，便于回滚兼容。

路由输出是单次 Run 的不可变快照，至少包含 `capability/provider/baseUrl/modelId/protocol/mode`。密钥仅在运行时注入，禁止进入领域数据、事件或模型上下文。

## 5. 调用与事件契约

```text
CapabilityInvocation
  invocationId, runId, capability, modelId, input, deadlineAt

CapabilityProgress
  invocationId, stage, summary, progress?, elapsedMs?

CapabilityResult
  invocationId, status, output, artifacts, usage?, providerRequestId?

CapabilityError
  invocationId, stage, code, message, retryable, providerStatus?, causeCode?
```

`invocationId` 必须贯穿执行引擎、AgentEvent、Orchestrator、SSE 和 Renderer。开始、进度、完成和失败只能更新同一次调用，禁止仅按工具名关联。

## 6. 同步与异步状态机

```text
prepared
  → submitting
  → queued / running
  → provider-succeeded
  → downloading
  → persisting
  → completed

任一阶段 → failed / timed-out / cancelled
```

建议图片进度：提交 5%～10%，排队/生成 15%～75%，下载 80%，兼容下载 82%，落盘 92%，完成 100%。百分比是阶段性体验指标；供应商提供真实进度时优先使用。进度在同一活动行原位更新，不创建伪步骤，也不触发新的 LLM Step。

## 7. URL 产物闭环

1. Base64 在 Backend 内解码并写入 Run Workspace；
2. URL 仅作为 Backend 内部瞬时信息，不返回主控模型；
3. Node 原生下载优先，网络/TLS 栈不兼容时使用受控系统下载器回退；
4. 校验 HTTP(S)、状态、空文件、最大尺寸和媒体格式；
5. 使用安全相对路径写入 `output/`；
6. 返回 `path + deliverable=true`，触发 `artifact.created` 与资产归档；
7. 主控模型不得再通过 Bash、curl 或 Python重复下载。

临时签名 URL、签名参数和密钥不得进入模型结果、活动摘要和普通日志。图片大小上限应配置化；Quantummate 基线为 25 MB。

## 8. 错误与重试

至少区分：

- `PROVIDER_REQUEST_FAILED`：提交失败；
- `PROVIDER_TASK_FAILED`：异步任务失败；
- `PROVIDER_TASK_TIMEOUT`：任务超时；
- `ARTIFACT_DOWNLOAD_FAILED`：生成成功但下载失败；
- `ARTIFACT_INVALID`：空文件、超限或格式错误；
- `ARTIFACT_PERSIST_FAILED`：工作区落盘失败；
- `CANCELLED`：用户或上层取消。

只有 `retryable` 错误允许有限重试。提示词变化不能修复下载/TLS 错误；生成成功、下载失败时应重试同一产物下载，避免重复生成和计费。

## 9. 安全与模块边界

- 模型 HTTP、轮询和产物下载只允许位于 `packages/agent-core`；
- Renderer 不直接访问 Provider 或签名 URL；
- 只接受 HTTP(S) 产物地址；
- 输出路径执行目录逃逸和符号链接检查；
- 系统下载器使用参数数组，禁止 shell 字符串拼接；
- 取消信号和 deadline 贯穿请求、轮询和下载；
- 日志可记录模型、协议、阶段、耗时和错误码，但不记录密钥或完整签名 URL。

## 10. 可观测性、测试与 Benchmark

每次调用记录 capability、provider、modelId、protocol、invocationId、各阶段耗时、错误阶段、错误码、是否使用兼容下载、用量和归档结果。

回归测试覆盖协议映射、异步状态机、取消/超时、URL 下载、工作区落盘、事件归并和失败语义。Benchmark 覆盖首包时间、总耗时、成功率、质量、成本和模型对比，不能替代正确性测试。

## 11. 扩展流程

新增能力时：

1. 在公共契约增加 capability 和协议枚举；
2. 在 Provider/模型配置声明能力，不新增执行引擎专属配置；
3. 在 Capability Backend 实现协议适配器；
4. 注册稳定、类型化的统一工具入口；
5. 复用 started/progress/completed/failed 和产物语义；
6. 增加正常、异步、取消、超时、Provider 失败和产物失败测试；
7. 更新 SDD、追踪矩阵、部署配置和必要的 Benchmark。

## 12. OpenClawX 当前落地状态

图片理解（VIS-M2）扩展 `vision` 能力，通过统一 `model_understand_images` Tool Backend 调用。主模型视觉直读与应用模型定向识图分开：前者直接图文输入，后者由平台绑定原始问题、最近必要上下文、Run授权的图片白名单，再向视觉模型发起请求。文字结果只是识图证据，不是原图。配置复用Provider/能力绑定/员工开关，无新增vision厂商类型；本轮Pi单员工闭环，其他引擎图片传输仍待后续适配。详见 [VIS-M2规格](../sdd/features/image-understanding/M2-application-vision.md)。

OpenClawX 已同步公共契约、统一 Tool Registry/Dispatcher、员工级能力开关、五类应用模型入口、三类图片协议、异步进度、URL 产物自动落盘，以及 Pi、AgentScope、DSH 对同一 Capability Backend 的复用。`invocationId` 已贯穿执行引擎、Orchestrator、SSE 和 Renderer。非实时语音第二阶段已增加阿里百炼、火山引擎和科大讯飞 Adapter，Provider 专有签名、轮询与音频编码仍收敛在 Capability Backend；TTS 模型可绑定默认系统音色或已授权的克隆音色 ID，主控 Agent 不具备创建声纹的权限。

决策模型以 `decision` 应用模型能力登记：Provider 保存地址和密钥，模型目录保存模型 ID 与决策协议，决策守卫只保存启用、观察/强制、失败策略等使用策略并引用应用模型 ID。旧版独立 JEV 连接在加载时迁移为 Provider + 决策模型；运行开始时解析为不可变的 `DecisionRuntimeConfig`。JEV 是首个 `system-one-v1` Adapter，而不是配置域中的特殊模型类型。

当前状态仍为“待验收”，不是“生产验证完成”。尚需使用真实供应商凭据执行图片、Embedding、ASR、TTS、eSight E2E，验证安装态 AgentScope/DSH 的细粒度进度与取消传播，并补齐统一 usage/成本展示及平台 Benchmark。
