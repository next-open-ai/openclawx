# ADR-0003：图片应用模型采用能力与协议分离的适配器架构

> 状态：已接受  
> 日期：2026-09-24  
> 关联工单：[AMC-001](../../sdd/features/application-model-capabilities/README.md)  
> 详细规格：[图片生成协议规格](../../sdd/features/application-model-capabilities/image-generation-protocols.md)

## 决策

阿里百炼连接采用最简配置：API Key 与可选 Workspace ID；地域不作为普通字段，而由 API Host 隐含。北京使用默认共享 Host，其他地域或企业代理使用高级自定义 Host。填写 Workspace ID 且 Host 是已知 DashScope 共享域名时，运行时生成对应地域的 Workspace 专属域名；自定义 Host 始终优先。

图片生成继续作为 `image` 应用模型能力，通过统一 Tool Interface 暴露为 `model_generate_image`。模型服务保存连接和凭据，应用模型保存模型 ID、能力与图片协议；执行引擎不感知供应商协议。

首批冻结三个协议适配器：

| 协议 ID | 适用范围 |
| --- | --- |
| `openai-images` | OpenAI、智谱 GLM-Image/CogView、火山 Seedream、Qwen-Image 3.0 和兼容服务 |
| `dashscope-multimodal` | Qwen-Image 原生接口、Wan 2.6/2.7 等同步多模态接口 |
| `dashscope-image-async` | Wan 2.5 及更早的提交任务与轮询接口 |

腾讯 TC3 和百度 OAuth/异步任务不伪装成上述协议，后续分别增加专用适配器。

## 理由

- `image` 只说明业务能力，不能决定 HTTP 路径；
- Provider 品牌不能稳定决定协议，同一阿里服务内部就存在三种协议；
- 显式协议使迁移、测试和错误诊断可重复；
- 共享 Provider Runtime 可保证新增厂商不修改 Pi、AgentScope、dsh Agent Loop；
- 旧配置可通过 Provider 与模型 ID 推断协议，避免破坏已有数据。

## 约束

1. 模型 HTTP 仅位于 `packages/agent-core`；
2. 协议公共枚举位于 `@openclawx/contracts`；
3. 404 必须报告状态码、方法和脱敏请求 URL，不得解释为提示词错误；
4. 异步协议必须有总 deadline、终态判断和稳定 Task ID；
5. Provider 返回的临时 URL 必须作为可追踪结果，后续资产持久化任务负责及时归档；
6. 不根据执行引擎选择 Provider Adapter。

## 后果

国产生图服务可以复用一个能力入口，同时保留协议差异。应用模型配置会增加一个高级协议字段，并需要维护协议级契约测试。腾讯和百度仍属后续范围，不能标记为已支持。
