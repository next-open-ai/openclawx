# 独立语音输入 V1

## 需求与任务

- ASR-01 / ASR-T1：配置默认入口 realtime / input，旧配置默认 realtime；ASR 独立开关，默认复用实时语音密钥，可切换独立密钥。密钥不进入 domain KV 或客户端，仅服务端 0600 文件保存，读取掩码。
- ASR-02 / ASR-T2：独立 ASR 服务端连接，16 kHz 单声道 PCM，双向流式识别，不调用 Agent/TTS/工作桥。官方协议适配在 agent-core；API 托管用户会话与 SSE。
- ASR-03 / ASR-T3：聊天入口按模式启动，输入框内嵌语音条实时投影修正后的全量文字，结束收音等待最终结果后可编辑并手动发送。已有草稿和失败/关闭时已识别文字保留；设置页保留独立录音测试与确认模式。详见 VUI-01–04。
- ASR-04 / ASR-T4：严格用户/组织隔离，未配置/未开通/握手/协议错误显示明确消息；音频只存内存，连接最多 2 分钟，结束等待最多 10 秒，API 最多 20 会话/每用户 2 个。端到端模式绝不创建 ASR 连接，字幕继续使用既有事件。

## 契约与状态

Schema：packages/contracts/src/voice-asr.ts。POST /api/voice/asr/{session,audio,finish,close}；GET /api/voice/asr/events?session_id=UUID。事件 connected/transcript(text,isFinal)/completed(text)/error(message)/closed。文本为全量覆盖，不将 delta 累加。finish 幂等；结束包只发送一次，禁止 finish 后上传。会话绑定由服务端鉴权产生，前端不得指定 URL/资源/密钥。SSE 断开仅取消订阅，显式关闭或 TTL 清理连接。

配置新增 voiceMode、asrEnabled、asrReuseKey、asrApiKey、asrResourceId、asrEnablePunc、asrEnableItn。公开 DTO 只含 asrConfigured/asrApiKeyMasked/asrKeySource。独立密钥清除必须显式 clearAsrApiKey；选择独立模式且密钥为空时拒绝连接，不偷偷回退。

## 验证与回滚

ASR-R1：旧配置默认、独立/复用/环境变量选择、掩码与密钥保持/清除（01）。ASR-R2：二进制 gzip/序号/末包/错误/损坏帧，mock WS 生命周期与超时（02）。ASR-R3：鉴权、跨用户拒绝、容量、finish/close（04）。UI 构建与人工验收录音修订、草稿追加、不自动发送、取消（03）。使用 `pnpm --filter @openclawx/api test`、agent-core test、typecheck、build。真实服务测试只传合成测试音频，记录 Key 权限结果，不泄露密钥。

兼容：新增字段无强制迁移，旧 API 调用保持新字段；回滚可切换 realtime 或关闭 ASR。ASR 与端到端独立计费，实际 Key 可用性由火山开通与配额决定。

协议来源：[官方双向流式 ASR](https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh)。默认 bigmodel_async，资源 volc.seedasr.sauc.duration；不复用 Seeduplex JSON 协议。
