# AMC-HEALTH-001 · Provider 首次使用验证与模型健康状态

> 状态：M3.1～M3.2 状态可信度工程闭环，待真实 Provider 验收 · 2026-09-25

## 需求

- HEALTH-R1：自动配置只表示“已配置”，不得伪装成“已验证”。
- HEALTH-R2：应用模型第一次真实调用成功或失败后，按实际模型和能力记录最近验证结果；配置阶段不得为验证而发起付费推理或上传数据。
- HEALTH-R3：状态至少区分：尚未验证、最近调用可用、配置或模型有误、权限或凭证有误、服务暂时不可用。
- HEALTH-R4：失败摘要最多保留500字符，不保存请求正文、业务文件、API Key或供应商原始响应体。
- HEALTH-R5：模型页展示状态、验证时间和诊断摘要；用户可继续修改Provider、模型ID、协议和员工授权，不自动切换模型。
- HEALTH-R6：只使用带`modelId`的终态`capability.completed/failed`事件，运行中和普通Tool事件不得改变健康状态。
- HEALTH-R7：修改模型协议、音色、Embedding参数等调用配置，或修改所属Provider运行连接信息后，必须清除旧健康状态，避免历史“可用”误导用户。
- HEALTH-R8：错误状态提供下一步诊断建议；系统不得因失败静默切换模型。已有Embedding显式测试也写入同一健康状态。
- HEALTH-R9：Provider列表按连接汇总应用模型的可用、异常、待验证数量，并可直接进入模型明细；Provider连接测试与应用模型真实验证必须保持概念分离。
- HEALTH-R10：健康结果超过30天后标记“需重新验证”，不得继续计入当前可用或异常；保留历史摘要供排查，并允许用户手动清除。

## 设计

```text
真实 Capability 调用
  -> agent-core capability.completed / capability.failed
  -> SSE（capability + modelId + summary + ok）
  -> Renderer transport observer
  -> 按 capability + modelId + 当前 binding 消歧
  -> 更新 ConfiguredModel.health
  -> 设置存储（meta，不含凭证）
  -> 模型设置页展示
```

健康状态是“最近一次真实调用结果”，不是持续监控，也不是厂商SLA。相同模型ID存在于多个连接且无法通过当前binding唯一定位时不写入，避免误归属。错误分类只用于辅助诊断，原始精简摘要仍保留供用户判断。

## 数据契约

`ConfiguredModel.health`：

- `status`: `available | configuration_error | permission_error | temporarily_unavailable`
- `checkedAt`: ISO时间
- `summary`: 最多500字符的终态摘要

字段为可选项，旧配置天然迁移为“尚未实际验证”；删除该字段即可回滚显示，不影响模型调用。

## 任务与验收

- HEALTH-T1：贯通终态事件到设置存储，成功标记可用，失败分类并记录时间。
- HEALTH-T2：API设置分离保存health元数据，密钥仍只进入secrets。
- HEALTH-T3：模型列表展示五类状态，不改变自动配置、远程目录或手动配置流程。
- HEALTH-T4：回归覆盖403权限、404配置、网络临时失败及health清洗保留。
- HEALTH-T5：模型或Provider运行配置变化后状态自动失效；配置、权限和临时服务错误显示不同处理建议。
- HEALTH-T6：Provider卡展示健康汇总，数量严格来源于该连接下已登记模型，不把“连接可达”当作“模型可用”。
- HEALTH-T7：验证结果按固定时效转为历史状态，Provider汇总单独计数；下一次真实调用可覆盖，手动清除后回到未验证。

## 非目标与后续

本阶段不实现通用主动付费探测、定时健康检查、自动故障转移或真实成本估算。已有Embedding测试属于用户明确触发的最小调用；后续如为图片、ASR、TTS增加“立即验证”，必须在调用前明确提示费用、测试输入和数据外发目的地。

## 验证证据

- `scripts/provider-auto-config-regression.mjs`：权限、配置、临时网络错误分类及health清洗保留通过。
- `@openclawx/renderer`、`@openclawx/api`类型检查通过；Renderer生产构建通过。
- API包测试、VitePress生产构建和`git diff --check`通过。
- 未使用真实供应商凭据执行付费调用，因此状态保持“待真实 Provider 验收”，不标记产品验收完成。
