# AMC-AUTO-CONFIG-001 · Provider 自动配置

> 状态：工程实现与隔离环境验收完成，待真实 Provider 首次使用验证 · 2026-10-14

## 目标与需求

- AUTO-R1：用户新增Provider连接时，默认可一键应用Workmate内置的稳定推荐组合；系统生成模型登记、系统默认、能力绑定和默认员工按需授权。
- AUTO-R2：只填补缺失项，不覆盖用户已有默认模型、能力绑定、员工模式、自定义模型、音色或协议设置；可重复运行且结果幂等。
- AUTO-R3：按Provider Profile选择能力。阿里 Workspace ID 可留空并使用 API Key 所属的默认业务空间；仅在用户显式填写时派生专属 MaaS 域名。协议和默认音色自动推断。
- AUTO-R4：自动配置不执行付费推理或上传数据，状态标记为“已配置，首次使用验证”；连接测试仍为独立无推理检查。未知兼容Provider无可靠目录时不猜模型。
- AUTO-R5：配置完成后用户仍可在“模型”页逐项修改，在“数字员工”页关闭或调整能力，在Provider专家设置中修改Endpoint、Workspace和凭证。
- AUTO-R6：现有Provider卡支持重新运行自动配置，以补齐新能力；删除Provider仍使用原有确认和清理流程。
- AUTO-R7：自动配置以版本化“常用推荐”清单为主，不依赖厂商远程目录完整性。远程目录只作为可选补充；拉取失败、缺项或返回过多时，不影响常用推荐、自动配置和手工录入。
- AUTO-R8：通义自动配置使用当前公共端点可用的新版对话、图片理解、图片生成、ASR、TTS 和端到端实时语音模型；智谱自动配置使用 `glm-5.3` 对话模型，并提供免费 `glm-4.6v-flash` 图片理解、`cogview-3-flash` 图片生成和 `cogvideox-flash` 视频生成。保留用户已有选择，不将 GLM-5.3 或 embedding-3 标记为免费；视频模型必须具备真实异步测试、预览和运行工作区交付能力。

## 默认策略

每种能力取内置推荐列表第一项；对话模型同时声明其已知视觉能力。非chat能力生成全局binding；仅为当前默认员工补齐缺失的`auto`授权，不批量改动其他员工。已经存在的全局能力binding优先于新Provider推荐。

Provider没有可信建议时返回“需要手动配置”，不伪造成功。模型目录是建议而非白名单，手工录入和完整目录继续保留。

模型选择按以下优先级展示和处理：

1. Workmate内置的常用、稳定、成本适中的推荐模型；
2. 厂商远程目录中按能力特征过滤后的候选模型；
3. 用户主动选择“显示全部”查看远程返回的其余模型；
4. 手工录入目录未返回或刚发布的模型ID。

远程目录不得反向覆盖或裁剪内置推荐，也不自动批量登记远程返回的全部模型。内置清单随Workmate版本评审更新，避免“流行”退化为不可审计的在线热度判断。

## 任务与测试

- AUTO-T1：建立纯函数Provider Profile与幂等合并结果。
- AUTO-T2：新增已适配连接默认直接自动配置，Provider卡可再次补齐；完成后自动保存并显示摘要与手动调整入口。
- AUTO-T3：验证阿里Workspace分支、现有配置保护、默认员工授权、未知Provider、幂等、自动选择与常用推荐清单一致、类型/构建和浏览器流程。
- AUTO-T4 → AUTO-R8：回归智谱三种推荐模型 ID、图像协议、候选清单、重复配置幂等和旧默认/图像绑定保护；Renderer 类型检查及构建。
- AUTO-T5 → AUTO-R8：CogView-3-Flash 按智谱图像接口提交 model/prompt/size，不发送 OpenAI 专有的 n/response_format；隔离 HTTP 桩验证 URL 返回、下载和工作区保存。其他 OpenAI Images 行为不变；执行 agent-core test。
- AUTO-T6 → AUTO-R8：验证智谱免费视频异步提交、结果轮询、MP4 下载与测试预览；验证通义和智谱新增默认模型不会覆盖已有用户绑定。

## 通义与智谱推荐更新 · 2026-10-14

来源：[智谱模型价格与免费模型](https://docs.bigmodel.cn/cn/guide/start/pricing)、[智谱视频生成异步 API](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E8%A7%86%E9%A2%91%E7%94%9F%E6%88%90%E5%BC%82%E6%AD%A5)。免费政策及限额以官方为准。GLM-5.3 为纯文本且必须启用思考，不把它登记为视觉模型；当前 GLM 请求路径不发送禁用思考参数。本次仅更新内置推荐配置，不迁移或覆盖用户持久化选择。现有连接主动重新运行推荐配置后补齐新模型，已有默认需用户自行切换。

验收证据（2026-10-14，当前开发工作区）：`node scripts/provider-auto-config-regression.mjs` 通过；API/Renderer 类型检查通过；`pnpm --filter @workmate/agent-core test` 205/205、`pnpm --filter @workmate/api test` 104/104（另 2 项环境验收跳过）通过；`git diff --check` 通过。未使用真实凭证调用模型，故账号权限、免费限额和真实响应质量仍待用户首次使用验证。无配置结构版本变更；回滚本次推荐清单不会删除已登记模型。

## 迁移与回滚

不修改持久化版本和旧配置；仅用户新增连接或主动点击时运行。回滚UI入口不会删除已生成条目，用户可继续手动维护或逐项删除。

## 实施结果与验收证据

- 新增已适配 Provider 时直接采用推荐配置，不要求普通用户理解或选择自动配置开关；未知兼容 Provider 继续手工配置。
- 自动配置基于内置 Provider Profile 补齐模型登记、能力 binding、系统缺失默认项及当前默认员工的 `auto` 授权；Provider 卡可随时重新运行补齐。
- 自动流程不覆盖已有对话默认、应用模型 binding、员工授权、协议和音色。重复运行新增模型数为 0，结果幂等。
- 2026-10-14 同步通义推荐：对话与图片理解默认 `qwen3.8-flash`，图片生成默认 `qwen-image-3.0`，录音文件识别默认 `qwen-audio-3.1-asr-flash-filetrans`，语音合成与端到端实时语音分别使用 `qwen-audio-3.1-tts-flash`、`qwen-audio-3.1-realtime-plus`。Workspace ID 留空时继续使用 DashScope 公共端点。
- 2026-10-14 同步智谱推荐：对话默认 `glm-5.3`；免费图片理解、图片生成和视频生成分别默认 `glm-4.6v-flash`、`cogview-3-flash`、`cogvideox-flash`。视频能力使用 `/videos/generations` 提交异步任务，经 `/async-result/{id}` 轮询后下载 MP4。
- 通义千问使用 `qwen-image-3.0` 与 OpenAI Images 兼容协议；Workspace ID 留空时使用 DashScope 公共端点，填写后派生专属 MaaS 端点。
- 完成后 Provider 卡保持收起，并显示“查看并手动调整”；模型页可继续逐项修改，未知 OpenAI-compatible Provider 转入手动配置。
- `scripts/provider-auto-config-regression.mjs` 已覆盖推荐配置、Workspace 分支、既有设置保护、幂等和未知 Provider 回退。
- 常用推荐始终独立于远程目录展示；远程列表只去重补充，并支持能力过滤、显示全部及手工录入。
- Renderer/API 类型检查、应用模型与自动配置回归通过；新增通义连接生成 7 个推荐模型，新增智谱连接生成对话、图片理解、图片生成、视频生成和向量模型。真实厂商调用仍留待有效凭证首次使用验证。

当前自动化是受版本管理的推荐 Profile，不是厂商远程模型目录自动发现。配置阶段不会执行付费推理、上传业务数据或宣称连接有效；真实凭证、地域权限、模型开通状态在首次实际使用时验证。
