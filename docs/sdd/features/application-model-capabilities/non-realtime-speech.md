# AMC-AUDIO-001 · 非实时 ASR / TTS

> 状态：国内三厂商协议已实现，待真实 Provider 验收  
> 范围：文件式语音转写与语音合成  
> 非目标：实时语音会话、WebRTC/WebSocket 音频流、VAD、打断与边说边播

## 1. 决策

ASR/TTS 继续作为 Capability Model Backend，通过 `model_transcribe_audio` 和 `model_synthesize_speech` 供主控智能体按需调用，不替换主控模型。第二阶段新增阿里百炼、火山引擎和科大讯飞 Adapter；签名、异步任务和专有参数只存在于 `packages/agent-core`，不进入主控 Agent 或执行引擎。

实时语音属于长连接交互通道，未来应建立 Voice Session / Realtime Gateway，不将音频分片包装为高频普通 Tool Call。

## 2. 需求

| ID | 需求 |
| --- | --- |
| AMC-AUDIO-REQ-01 | ASR 接受工作区音频、认证上传生成的录音引用；上传引用安全复制到 Run 工作区，拒绝路径和符号链接逃逸 |
| AMC-AUDIO-REQ-02 | ASR 校验扩展名、空文件和 25 MB 上限，失败不发起 Provider 请求 |
| AMC-AUDIO-REQ-03 | ASR 支持语言、术语提示、text/json/SRT/VTT 和可选分段时间戳 |
| AMC-AUDIO-REQ-04 | ASR 返回简明文本供 Agent 继续推理，完整结果落盘到 `output/` 并登记资产 |
| AMC-AUDIO-REQ-05 | TTS 支持 voice、speed 与 mp3/wav/aac/flac/opus/pcm，输出必须是非空音频且不超过 25 MB |
| AMC-AUDIO-REQ-06 | ASR/TTS 有明确的提交、处理和落盘进度，共享原 invocation ID |
| AMC-AUDIO-REQ-07 | 超时和上层取消传递到 HTTP 请求；网络错误保留方法、Endpoint 和底层 cause |
| AMC-AUDIO-REQ-08 | Provider HTTP 失败保留状态码和服务端消息，不静默改用其他模型 |
| AMC-AUDIO-REQ-09 | 阿里支持 Paraformer 异步录音文件转写和 Qwen-Audio-TTS/CosyVoice 非实时合成 |
| AMC-AUDIO-REQ-10 | 火山支持大模型录音文件极速识别和非实时 TTS，使用专用 Header/请求体 |
| AMC-AUDIO-REQ-11 | 讯飞支持录音文件 upload/getResult 轮询和 WebSocket TTS，使用 AppID/APIKey/APISecret |
| AMC-AUDIO-REQ-12 | TTS `voice` 可使用厂商系统音色或用户已在控制台合法创建的复刻音色 ID |
| AMC-AUDIO-REQ-13 | 创建、更新或删除复刻音色不暴露给主控 Agent；未来必须经过声音权利确认和显式审批 |
| AMC-AUDIO-REQ-14 | 模型选择器按厂商和能力提供常用推荐，远端大目录默认按能力过滤，同时保留“显示全部”和手工录入 |

## 3. 协议与边界

- ASR：`POST {baseUrl}/audio/transcriptions`，multipart form-data。
- TTS：`POST {baseUrl}/audio/speech`，JSON body，响应为音频字节。
- 阿里 ASR：HTTPS 音频 URL 或本地文件经官方临时 OSS 上传后异步提交 `/api/v1/services/audio/asr/transcription`，轮询 `/api/v1/tasks/{taskId}`；OSS 临时引用携带 `X-DashScope-OssResourceResolve: enable`。临时上传限桌面试用；生产使用稳定 OSS/HTTPS URL。
- 阿里 TTS：`/api/v1/services/audio/tts/SpeechSynthesizer`，响应临时 URL 由 Runtime 下载落盘。
- 火山 ASR：`/api/v3/auc/bigmodel/recognize/flash`，工作区音频 Base64 提交。
- 火山 TTS：`/api/v1/tts`，需 AppID 和 Access Token/API Key。
- 讯飞 ASR：`/v2/api/upload` + `/v2/api/getResult`，HMAC-SHA1 签名。
- 讯飞 TTS：`wss://tts-api.xfyun.cn/v2/tts`，对 Agent 仍呈现为一次非实时任务。
- Provider HTTP 只存在于 `packages/agent-core`。
- Renderer、Pi、AgentScope 和 DSH 不感知协议差异。
- 火山、讯飞 Provider 在模型登记界面只开放 ASR/TTS，避免误配为主控对话模型。
- 每个 TTS 模型可配置默认系统音色或已授权的克隆音色 ID；单次调用显式 `voice` 可覆盖默认值。
- 长文本自动分段、音频合并、说话人分离为后续工单。

## 4. 任务

### AMC-ASR-LOCAL-001 · 本地录音转写闭环

需求：聊天支持上传 ≤25 MB 录音；认证 API 保存为随机、不可枚举的录音引用（持有引用即授权 ASR 读取，仅用于转写），不接受任意绝对路径。输入24小时过期，调用时复制到运行工作区。UI 提示录音将发送至已配置厂商。阿里本地录音通过官方临时 OSS 上传后提交 Paraformer，保留公网 HTTPS URL 输入；临时上传限桌面试用，生产使用稳定 OSS/HTTPS URL。

任务：公共上传 Schema、输入暂存与校验、聊天入口、三厂商任务超时/取消/业务失败处理、TXT/JSON 产物；不支持的字幕格式明确拒绝，不将纯文本伪装成 SRT/VTT。讯飞轮询最多100次。

验证：暂存扩展名/大小/路径/过期；阿里 policy→OSS→提交→轮询→转写下载闭环；火山本地 Base64；讯飞业务失败立即停止；取消不继续轮询。真实付费 E2E 独立验收。

| ID | 任务 |
| --- | --- |
| AMC-AUDIO-TASK-01 | 完善 ASR 输入校验、格式参数、进度和转写资产 |
| AMC-AUDIO-TASK-02 | 完善 TTS 格式、语速、输出校验、进度和资产 |
| AMC-AUDIO-TASK-03 | 贯通取消/超时与稳定错误语义 |
| AMC-AUDIO-TASK-04 | 补齐 Mock 协议、安全和产物回归 |
| AMC-AUDIO-TASK-05 | 使用真实 Provider 凭据执行受控 E2E，记录成本和数据边界 |
| AMC-AUDIO-TASK-06 | 新增阿里、火山、讯飞 Provider 配置与安全持久化 |
| AMC-AUDIO-TASK-07 | 实现三厂商 ASR/TTS Adapter 及统一结果归一化 |
| AMC-AUDIO-TASK-08 | 实现厂商/能力推荐模型分组、目录过滤及不过度限制的兜底入口 |

## 5. 测试规格

| ID | 覆盖 |
| --- | --- |
| AMC-AUDIO-TEST-01 | ASR/TTS 命中正确 Endpoint，转写和音频均落盘 |
| AMC-AUDIO-TEST-02 | ASR 拒绝非音频和工作区外输入 |
| AMC-AUDIO-TEST-03 | Provider 4xx 保留方法、URL、状态和消息 |
| AMC-AUDIO-TEST-04 | TTS 格式与 MIME 正确，非音频响应被拒绝 |
| AMC-AUDIO-TEST-05 | 阿里 TTS 临时 URL 下载、火山 ASR/TTS 协议、讯飞 ASR 签名轮询通过 Mock 回归 |
| AMC-AUDIO-TEST-06 | 默认音色随模型配置安全持久化并传递到 Capability Runtime |
| AMC-AUDIO-E2E-01 | 真实 ASR/TTS Provider；未提供凭据前不得标记通过 |

## 6. 迁移与回滚

不改变已有 `asr` / `tts` 模型绑定，旧调用不传新参数时使用 JSON 转写和 MP3 合成默认值。回滚可通过关闭员工的 ASR/TTS 能力开关停止暴露工具，不删除 Provider 配置。

## 7. 过程状态

### AMC-ASR-NET-002 · 上传恢复与新轮次重试

2026-09-25：已实现并通过Mock回归，见[增量规格与证据](asr-upload-recovery.md)。临时OSS上传网络失败允许一次有限重试，转写提交仍不重放；运行内停止不再表述为永久禁止，用户在原会话新一轮明确请求可重试。替代下述NET-001中对所有POST一概禁止恢复的历史规则。agent-core 110/110通过，真实厂商及主模型多轮验收待执行。

### AMC-ASR-NET-001 · 语音传输错误与安全恢复

验证（2026-09-24）：agent-core 全量 107/107 通过；追加请求计数断言后的 speech-http 专项 1/1 通过；API 构建通过。无密钥探测阿里上传凭证入口返回 HTTP 401，说明该入口当前可达，不代表上传/转写/结果下载均可达。未执行用户音频真实转写，实际失败阶段待新诊断确认。

语音 HTTP 统一保留方法、端点（删除签名查询串）、底层错误代码；响应读取也受超时和大小限制保护。只有幂等 GET（上传凭证、任务查询、结果下载）在 fetch 失败时尝试一次独立 Node HTTP/TLS 传输；POST 上传/提交不自动重放。ASR 网络失败后本轮工具返回 retryable=false，后续调用在本地终止，避免改路径/格式重复创建付费任务。取消不得进入备用通道。测试见 `speech-http.test.ts`。附件日志没有底层错误，不能据此声称已定位用户实际失败阶段；真实账号 E2E 仍待验证。

### AMC-AUDIO-FIX-411 · 模型音色匹配与失败终止

- 需求：阿里 TTS 默认音色按具体模型版本解析，UI 与 Runtime 共用目录；显式配置和单次 voice 不被静默覆盖。目录不是完整白名单，保留自定义音色。
- 任务：修复统一 longanyang 默认值；工具描述提供当前模型/默认音色并要求无明确需求时省略 voice；界面提供匹配建议。
- 错误契约：HTTP 4xx（408/429 除外）返回 `retryable:false`、模型/音色/状态码/requestId 和配置修复建议；同一运行遇到此类 TTS 错误后停止发出后续 TTS 请求，下一运行重新建立状态。
- 测试：3.1/3.0 flash/3.0 plus/v3/v2 默认音色；自定义音色保留；411 后改变文字/音色仍不产生重复 HTTP 请求；正常请求产物落盘。
- 兼容：已有 voice 保留；空 voice 使用匹配默认值；未知阿里模型要求明确配置音色，不猜测。真实厂商验收与 Mock 测试分别记录。
- 官方依据：[Qwen-Audio 音色列表及 411 说明](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list)、[CosyVoice 音色列表](https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list)。此前将所有阿里 TTS 的默认音色设为 longanyang 是适配缺陷，不能把 411 直接归类为暂时性服务故障。
- 验证：2026-09-24 `pnpm --filter @openclawx/agent-core test` 103/103 通过，包含五模型默认音色、配置音色保留、411 后连续十次调用只产生一次上游请求、新运行恢复的回归。附件仅含应用 HTTP 访问日志，未包含实际 TTS model/voice；本机 API 读取返回 401，未执行真实付费合成，不声称已复现用户实际参数组合。

| 日期 | 状态 | 证据 |
| --- | --- | --- |
| 2026-09-24 | 实现中 | 冻结非实时范围、OpenAI-compatible 首批协议和安全/产物/错误验收标准 |
| 2026-09-24 | 实现完成，待 E2E | ASR/TTS 产物、输入/输出校验、进度、取消/超时和错误语义已实现；`agent-core` Mock 全量回归 `97/97` 通过，contracts/API/renderer/orchestrator 类型检查、API/renderer/VitePress 生产构建及 `git diff --check` 通过。真实 Provider 凭据未提供，AMC-AUDIO-E2E-01 仍待执行 |
| 2026-09-24 | 国内三厂商协议已实现，待 E2E | 新增阿里百炼、火山引擎、科大讯飞 Provider 配置和 ASR/TTS Adapter；支持模型级默认系统音色与已有复刻音色 ID。阿里 TTS、火山 ASR/TTS、讯飞 ASR 以及讯飞 TTS HMAC-SHA256 签名纳入 Mock 回归，`agent-core` 全量 `102/102` 通过；讯飞 TTS 音频流仍需真实 WebSocket 服务验收。复刻音色创建继续保持人工高风险边界。真实付费 E2E 未执行。 |
| 2026-09-24 | 配置体验完成 | 模型选择器按 Provider 与能力显示常用推荐；远端厂商目录默认进行能力过滤，并保留显示全部、搜索及手工模型 ID 三条兜底路径。 |
| 2026-09-24 | AMC-ASR-LOCAL-001 已实现，Mock 验证通过 | 聊天录音上传入口、25MB 校验、随机录音引用/24小时过期、工作区输入复制；阿里临时 OSS 上传/异步转写；火山 Base64；讯飞业务失败终止、中文语种映射、最多100次退避轮询；取消/超时、TXT/JSON 产物。修复服务端丢弃火山/讯飞能力的旧白名单。agent-core 106/106 通过；真实三厂商音频与付费凭据 E2E 未执行。 |
