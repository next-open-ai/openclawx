# AMC-IMG-001 · 国内图片生成协议规格

> 状态：首批协议已通过 mock 与构建验证，待真实 Provider 验收  
> 日期：2026-09-24  
> 决策：[ADR-0003](../../../architecture/adr/0003-image-generation-provider-protocols.md)

## 1. 需求

| 编号 | 需求 | 验收标准 |
| --- | --- | --- |
| AMC-IMG-REQ-01 | Provider、能力和协议独立建模 | `image` 模型可显式保存协议；不新增 eSight 或生图专属 Provider 类型 |
| AMC-IMG-REQ-02 | 支持 OpenAI Images 兼容协议 | 调用 `/images/generations`，接受 URL 或 Base64 |
| AMC-IMG-REQ-03 | 支持 DashScope 同步多模态协议 | 调用 `/api/v1/services/aigc/multimodal-generation/generation` 并解析多模态图片 URL |
| AMC-IMG-REQ-04 | 支持 DashScope 异步文生图协议 | 提交 `image-synthesis`、读取 `task_id`、轮询 `/api/v1/tasks/{id}` |
| AMC-IMG-REQ-05 | 保持三执行引擎无供应商逻辑 | Pi、AgentScope、dsh 继续复用同一 Model Capability Backend |
| AMC-IMG-REQ-06 | 兼容旧配置 | 缺少协议时按 Provider 与模型 ID 推断，不删除模型记录 |
| AMC-IMG-REQ-07 | 错误可诊断 | HTTP 错误包含状态、方法和请求 URL；任务失败/超时包含 Task ID |
| AMC-IMG-REQ-08 | 临时 URL 自动归档 | Provider 返回 URL 时由 `agent-core` 下载到本次 Run 工作区，只向主控模型返回本地 `path`；禁止要求主控模型调用 Bash/Python 下载 |
| AMC-IMG-REQ-09 | 下载边界安全 | 只接受 HTTP(S)，空文件、非图片内容和超过 25 MB 的结果明确失败，不把签名 URL 写入工具结果 |
| AMC-IMG-REQ-10 | 异步过程可见 | 长时调用通过同一 `invocationId` 更新现有活动行，至少呈现提交、排队/生成、下载、落盘阶段；可得时显示等待秒数和进度百分比 |
| AMC-IMG-REQ-11 | 下载兼容性 | Node 直接下载失败时由 `agent-core` 自动切换受控系统下载通道；两条路径都失败时返回阶段、错误码与底层原因，不得笼统归类为 Provider 生成失败 |
| AMC-IMG-REQ-12 | 百炼最简配置 | Qwen Provider 支持可选 Workspace ID；不单独要求用户配置地域，而从共享 API Host 推断地域并生成专属域名；自定义 Host 优先 |
| AMC-IMG-REQ-13 | 配置可持久化 | 桌面端必须保存 v3、`workspaceId`、`imageProtocol`、能力绑定和智能体能力开关，重启后语义不退化 |
| AMC-IMG-REQ-14 | 网络错误可诊断 | `fetch` 未取得 HTTP 响应时保留方法、脱敏 Endpoint 和底层 cause code，不只显示 `fetch failed` |
| AMC-IMG-REQ-15 | 协议自动选择 | 普通用户只看到“自动选择”；具体协议仅在高级设置中覆盖，并显示自动解析结果 |
| AMC-IMG-REQ-16 | Qwen-Image 前置校验 | Qwen-Image 3.0/Pro 使用公共 DashScope Host 且缺少 Workspace 时，在配置界面提示并在发起网络请求前返回可操作错误 |

## 2. 契约

公共协议枚举：`openai-images`、`dashscope-multimodal`、`dashscope-image-async`。

`ConfiguredModel.imageProtocol` 是持久化配置；解析后的 `ModelCapabilityRuntime.imageProtocol` 是单次 Run 快照。字段仅对 `capability=image` 生效。内部工具保持 `model_generate_image(prompt, size?)`，成功结果必须包含 `modelId`、`protocol`、工作区相对 `path` 和 `deliverable=true`；异步调用额外返回 `taskId`。Provider 的远端 URL 仅作为运行时内部瞬时传输信息，不进入模型可见结果。

## 3. 自动推荐与迁移

| Provider/模型 | 默认协议 |
| --- | --- |
| 非 Qwen Provider | `openai-images`，用户可在高级配置覆盖 |
| `qwen-image-3.0*` | `openai-images` |
| `wan2.1`～`wan2.5`、`wanx*` | `dashscope-image-async` |
| 其他 Qwen 图片模型，包括 Qwen-Image 原生、Wan 2.6/2.7 | `dashscope-multimodal` |

旧 v3 配置不强制重写；运行时与 UI 使用同一推断规则提供兼容默认值。保存后可显式持久化用户选择。

Qwen 的普通配置只暴露 API Key 与可选 Workspace ID。默认共享 Host 为北京；Workspace ID 存在时，系统按当前共享 Host 隐含的地域生成 `{workspaceId}.{region}.maas.aliyuncs.com`。其他地域通过高级 API Host 表达，不增加独立地域字段；企业代理或其他自定义 Host 不被自动改写。

## 4. 请求映射

- OpenAI Images：`POST {baseUrl}/images/generations`，发送 `model/prompt/size/n/response_format`。
- DashScope 同步：归一服务根地址后调用 `/api/v1/services/aigc/multimodal-generation/generation`，尺寸由 `1024x1024` 转为 `1024*1024`。
- DashScope 异步：提交请求带 `X-DashScope-Async: enable`；轮询只接受 `SUCCEEDED/SUCCESS` 为成功，`FAILED/CANCELED/CANCELLED` 为失败，总 deadline 首期为 300 秒。

## 5. 测试与追踪

| 测试 | 覆盖需求 | 当前结果 |
| --- | --- | --- |
| AMC-IMG-T-001 | REQ-02 | Mock Base64 结果写入工作区，通过 |
| AMC-IMG-T-002 | REQ-03/05 | 同步原生路径、嵌套请求和 URL 解析，通过 |
| AMC-IMG-T-003 | REQ-04/05 | 异步 Header、提交、GET 轮询和 Task ID，通过 |
| AMC-IMG-T-004 | REQ-06 | 类型检查与缺省运行时推断，通过；持久化迁移专项待补 |
| AMC-IMG-T-005 | REQ-07 | 404 的状态、方法、URL 和服务端消息断言通过；异步失败终态专项待补 |
| AMC-IMG-T-006 | REQ-08/09 | 同步、异步 URL 结果自动下载为工作区 PNG，工具结果不含 URL，通过 |
| AMC-IMG-T-007 | REQ-10/11 | 模拟 Node TLS `ECONNRESET` 后兼容下载成功；异步 RUNNING 轮询产生阶段进度，通过 |
| AMC-IMG-T-008 | REQ-12～14 | 北京/新加坡 Workspace Host 推导、自定义 Host 保留、网络 cause 诊断通过；桌面持久化由类型检查与人工结构复核覆盖 |
| AMC-IMG-T-009 | REQ-15/16 | 协议缺省不持久化、UI 高级覆盖、Qwen-Image 缺少 Workspace 本地失败用例通过 |
| AMC-IMG-E2E-001 | REQ-02～04 | 智谱、火山、阿里真实服务未执行 |

2026-09-24 验证证据：图片协议专项测试 `5/5` 通过，其中同步、异步 URL 均验证自动下载与本地路径返回；contracts、agent-core、orchestrator、renderer 类型检查通过；同名工具 invocation 回归 `1/1` 通过；renderer 和 VitePress 生产构建通过；`git diff --check` 通过。OpenClawX `agent-core` 全量回归 `92/92` 通过。

2026-09-24 现场缺陷复盘：真实 CogView 调用已返回临时 CDN URL，但 Node 22 `fetch` 对该 CDN 在 TLS 建连前报 `ECONNRESET`；同机 Python/curl 能访问，因此此前由模型编写 Python 下载时成功，改为 Node 自动下载后失败。修复后下载仍由 `agent-core` 负责，Node 原生路径失败会自动切换受控 `curl`，并通过 `capability.progress` 在原活动行展示阶段和进度，不回退为主控模型自行下载。

2026-09-24 OpenClawX 同步证据：图片专项 `5/5`、统一工具专项 `4/4`、同名 invocation 回归 `1/1`、相关包类型检查、API 与 Renderer 生产构建均通过；真实 Provider E2E 保持待验收。

2026-09-24 百炼配置闭环：采用“API Key + 可选 Workspace ID + 高级 API Host”，不增加独立地域字段；地域由 Host 隐含。修复桌面端 v2 降级保存，补充 Workspace 专属域名解析和网络异常诊断。`agent-core` 全量回归 `94/94`、五包类型检查、API/Renderer/VitePress 生产构建及差异检查通过；真实阿里 Qwen-Image E2E 仍需用户凭据验收。

2026-09-24 协议交互收敛：图片协议默认改为“自动选择（推荐）”，手工覆盖移入高级设置；Qwen-Image 3.0 缺少 Workspace 时不再向公共接口发送必然失败的请求，并提供“去配置 Provider”入口。`agent-core` 全量回归 `95/95`、相关类型检查、Renderer 与 VitePress 构建通过。

## 6. 非目标与后续

- 腾讯 TC3 同步/异步适配器；
- 百度 OAuth Token 和异步任务适配器；
- 图片编辑、多图输入、流式组图；
- 资产库长期保留策略与清理策略（Run 工作区自动落盘已完成）；
- 成本、图片张数与供应商 request ID 的完整统一计量。
