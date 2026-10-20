# AMC-001 · 通用应用模型机制

> 类型：平台能力工单  
> 状态：首批能力与国产生图协议实现完成，待真实 Provider 验收  
> 优先级：P0  
> 创建日期：2026-09-24  
> 前置依赖：[UTI-001 · 统一 Agent Tool Interface](../unified-tool-interface/README.md)  
> 首批迁移对象：eSight `quantum-code`、图片生成、Embedding、ASR、TTS

近期增量：

- [Provider 自动配置](provider-auto-configuration.md)——新增连接时生成推荐模型、缺失 binding 和默认员工按需授权，同时保留完整手动调整能力。
- [首次使用验证与模型健康状态](provider-first-use-health.md)——以真实应用模型调用结果更新可用性与诊断，不额外发起付费探测。
- [多模态输入与应用模型用量](composer-ux-and-usage.md)——输入框附件交互专业化，应用模型Token按实际Provider/模型/能力独立归属。

## 1. 问题

应用模型在交互上属于模型服务和模型能力，在 Agent Loop 中则通过结构化 Tool Call 被触发。若把它实现为某个执行引擎的特殊工具或把 eSight 建成特殊 Provider 类型，会造成模型管理、调用协议和治理重复。

## 2. 目标

在 UTI-001 之上建立唯一的 Model Capability Tool Backend。应用模型按能力注册、绑定和授权，执行引擎仅看到统一 Tool Descriptor；Backend 负责选择模型、调用供应商协议、归一化结果并产生能力事件。

```text
Unified Agent Tool Interface
  -> Model Capability Tool Backend
      -> Capability Gate / Binding Resolver
      -> Capability Provider Adapter
          -> chat/code | image | embedding | transcription | speech
      -> Capability Result / Artifact / Usage / Events
```

## 3. 范围

### 首批能力

```text
quantum-code | image | embedding | asr | tts
```

### 包含

- 通用能力目录、模型绑定、智能体授权和渐进披露；
- 统一 `CapabilityInvocation`、`CapabilityResult`、错误、产物、usage 和事件；
- OpenAI-compatible 首批 Provider Adapter；
- 图片生成按能力与协议分离，首批支持 OpenAI Images、DashScope 同步多模态和 DashScope 异步文生图；
- 不同能力使用各自标准协议，不强行走 Chat Completion；
- eSight 作为 `quantum-code` 模型实例，不新增 eSight Provider 类型；
- 图片和语音产物登记、Embedding 结构化向量结果；
- 主控模型与能力模型独立配置、计量和审计。

### 不包含

- 替换 Agent 主执行模型；
- 在执行引擎中复制 Provider HTTP/SDK 逻辑；
- 量子代码执行和真机操作；这些属于 `quantum.run` Tool/Sandbox；
- 把 Capability Model 暴露成用户手工维护的 MCP Server；
- 未经治理的训练数据自动回流。

## 4. 强制边界

1. 应用模型通过 UTI 注册为 `category=model-capability` 的 Tool Backend；
2. Pi、AgentScope、dsh 不出现模型供应商条件分支；
3. Provider HTTP/SDK 只能位于 `packages/agent-core`；
4. 模型服务描述连接方式，应用模型描述用途，两者不得合并；
5. disabled 能力不生成 Tool Descriptor，不消耗主控模型上下文；
6. `tool.*` 表示统一工具生命周期，`capability.*` 表示应用模型领域事件；二者共享 invocation ID；
7. API Key 不进入 Tool Descriptor、Prompt、事件和持久化业务数据。

## 5. 实施拆解

| 子任务 | 内容 | 主要模块 |
| --- | --- | --- |
| AMC-001-01 | 将现有五类能力工具迁移到统一 Tool Backend | `packages/agent-core` |
| AMC-001-02 | 冻结 Capability Invocation/Result/Event 公共契约 | `packages/contracts` |
| AMC-001-03 | 实现 Capability Gate、Binding Resolver 和授权快照 | `agent-core`、`orchestrator` |
| AMC-001-04 | 实现 chat/code、image、embedding、ASR、TTS Adapter | `packages/agent-core` |
| AMC-001-05 | 接入统一产物、usage、错误和 capability 事件 | `agent-core`、`orchestrator` |
| AMC-001-06 | 收敛模型服务/应用模型/智能体授权 UI | `apps/renderer`、`apps/api` |
| AMC-001-07 | 将 eSight M2 现有实现迁移为首个 quantum-code 模型实例 | `agent-core`、SDD |
| AMC-001-08 | 五能力、三引擎和真实 Provider 分层验收 | tests、quality、benchmarks |
| AMC-001-09 | 国内图片模型协议分层、配置迁移与 mock 回归 | contracts、agent-core、renderer、API |

## 6. 验收标准

- [ ] 五类能力均可在“模型服务 → 应用模型”中配置和绑定；
- [ ] 每个智能体可独立设置关闭、按需使用、优先使用；
- [ ] 同一能力 Backend 注册一次即可供所有执行引擎调用；
- [ ] 新增能力时不修改 Pi、AgentScope、dsh Agent Loop；
- [ ] eSight 不出现在 Provider 类型枚举中，只作为量子编程模型实例；
- [ ] 五类能力分别命中正确供应商协议；
- [ ] disabled 不暴露 Schema，未绑定或不可用时错误可解释；
- [ ] 图片/TTS 产物可追踪，Embedding/ASR 返回结构稳定；
- [ ] 主控模型与能力模型 usage、延迟和成本分别记录；
- [ ] Provider 失败不会静默切换模型或执行引擎。

## 7. 测试要求

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| AMC-T-001 | 五能力 Provider mock | 分别命中 chat、image、embedding、transcription、speech 协议 |
| AMC-T-002 | 三执行引擎调用同一能力 | 相同 CapabilityInvocation/Result/Event，无引擎专属 Provider 分支 |
| AMC-T-003 | disabled / 无绑定 / Provider 不健康 | 不暴露或返回稳定可解释错误，不静默降级 |
| AMC-T-004 | 图片与 TTS 产物 | 写入受控工作区并登记 artifact |
| AMC-T-005 | ASR 路径和符号链接逃逸 | 拒绝工作区外输入 |
| AMC-T-006 | usage 分账 | 主控模型和应用模型分别计量且可汇总 |
| AMC-T-007 | 配置迁移 | v2/v3 数据保留，eSight 专属 UI 表达消失 |
| AMC-T-008 | 真实 Provider 受控 E2E | 记录模型版本、环境、成本和数据边界 |
| AMC-IMG-T-001～005 | 三类图片协议、迁移和错误 | 命中正确端点，异步任务可轮询，错误可诊断 |

## 8. 依赖与顺序

```text
UTI-001 契约与 Registry
  -> AMC Backend 接入
  -> Pi/AgentScope/dsh 一致性回归
  -> eSight 与多模态真实 Provider 验收
```

AMC 可以先基于 UTI 草案开发 Provider Adapter，但不得在 UTI Transport 稳定前复制三套引擎接入代码，也不得以 Pi 私有工具形态标记平台能力完成。

## 9. 迁移与回滚

- 将现有 Pi `createModelCapabilityTools` 包装/迁移为统一 Model Capability Tool Backend；
- 保持现有模型设置 v3 数据兼容，不改变主控模型选择；
- 迁移期允许旧 Pi 注册路径受特性开关保护，但只保留一个 Provider Runtime；
- 回滚通过关闭能力绑定或智能体授权恢复原主控路径，不删除模型服务配置。

## 10. 完成定义

UTI-001 已完成，AMC-T-001～008 达到对应环境可执行范围，三个执行引擎无需能力专属适配即可调用五类应用模型，并完成真实 Provider 验收后，本工单方可标记完成。

## 11. 过程状态

2026-09-25 新增第六类应用能力 `vision`（图片理解）：复用统一工具与员工授权，文本主模型调用视觉应用模型时自动携带原始问题、必要上下文及原图；[VIS-M2](../image-understanding/M2-application-vision.md) 管理其需求、任务和验收。历史“五类能力”范围不包含此增量；当前只完成Pi会话附件闭环，不宣称其他引擎已完成图片理解。

| 时间 | 状态 | 结果与证据 |
| --- | --- | --- |
| 2026-09-24 | 待评审 | 工单建立，确定应用模型是统一 Tool Interface 上的一类 Backend |
| 2026-09-24 | 进行中 | 五类模型迁移为统一 Model Capability Tool Session；eSight 专属 Provider UI 被移除 |
| 2026-09-24 | 进行中 | Pi 使用 Native Transport，AgentScope 使用 Host Transport，dsh 使用 run-scoped MCP Transport；三者共享同一 Provider Runtime |
| 2026-09-24 | 实现完成，待真实 Provider 验收 | 五类 mock Provider 协议测试、disabled 隐藏、公共契约、AgentScope/dsh Transport 专项测试通过；真实 eSight/图片/ASR/TTS 服务未提供，AMC-T-008 未执行 |
| 2026-09-24 | 首批国产生图协议完成，待 E2E | 接受 ADR-0003；增加 `imageProtocol` 配置和 OpenAI Images、DashScope 同步、DashScope 异步适配器。图片专项 5/5、四包类型检查、renderer 与文档生产构建通过；智谱、火山、阿里真实端点尚未验收，腾讯/百度不在本批范围。详见 [AMC-IMG-001](image-generation-protocols.md) |
| 2026-09-24 | 图片产物闭环与活动去重完成 | Provider 临时 URL 由 `agent-core` 自动下载到 Run 工作区，模型只收到本地 `path`；工具/能力事件以 `invocationId` 跨三引擎、Orchestrator、SSE、Renderer 归并，消除同名调用重复失败记录。图片专项 5/5、同名调用回归 1/1、四包类型检查及 renderer/VitePress 构建通过。 |
| 2026-09-24 | OpenClawX 同步完成，待真实 Provider 验收 | 五类能力、员工开关、三类图片协议、异步进度及 URL 产物闭环已同步；图片专项 `5/5`、UTI 专项 `4/4`、同名 invocation 回归 `1/1`、契约回归、五包类型检查、API 与 Renderer 构建通过。未使用真实供应商凭据执行付费 E2E。 |
| 2026-09-24 | 非实时 ASR/TTS 工程闭环，待真实 Provider 验收 | 文件式 ASR 与 TTS 完成工作区安全、格式/大小校验、进度、取消/超时、转写/音频资产和稳定错误。实时 Voice Session 明确不在本轮范围。详见 [AMC-AUDIO-001](non-realtime-speech.md)。 |
| 2026-09-25 | Provider 自动配置工程闭环 | 内置推荐 Profile 可在新增连接时自动补齐模型、binding、默认员工按需授权，并可从 Provider 卡幂等重跑；既有手工配置不覆盖，完成后仍可逐项调整。通义 Workspace 分支、未知兼容 Provider 回退、脚本与隔离浏览器流程通过；真实 Provider 首次使用验证仍保留。详见 [AMC-AUTO-CONFIG-001](provider-auto-configuration.md)。 |
| 2026-09-25 | M3.1 被动首次使用验证实现 | 应用模型真实调用终态可按能力和模型更新最近健康状态，区分可用、配置、权限和临时服务错误；模型页展示时间与精简诊断，不执行额外付费探测、不自动切换。分类与持久化回归通过，真实 Provider 验收待执行。详见 [AMC-HEALTH-001](provider-first-use-health.md)。 |

实现状态不等于产品验收：真实 Provider、独立 usage/成本完整展示和安装态三引擎 E2E 未完成前，本工单不得标记“已验证”。

本批最终状态：`AMC-001-09` 已实现并通过 mock/构建验证，进入“待真实 Provider 验收”；AMC-001 总工单维持“待真实 Provider 验收”，不提前关闭。OpenClawX `agent-core` 全量回归 `92/92` 通过。
