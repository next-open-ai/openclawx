# 实时语音 V1 架构

桌面插话采用本地立即清空 AudioBufferSource 队列 + 播放 generation 取消 resume 竞态；API 的 VoiceResponseGate 按 response ID/epoch 隔离旧消息与未执行工具，供应商发送 response.cancel，不关闭连接、不清除用户输入。已接受工作继续执行，迟到工具结果保留本地结果事件、不触发旧语音续播。完成通知等待输入、生成、工具及实际播放全部空闲。[接口与回滚](./barge-in.md)。

1.2（替代1.1）：供应商负责正常插话；API根据供应商讲话开始事件隔离旧回答并发出local.provider_interrupted，UI只清空旧播放，不发重复response.cancel。删除VoiceBargeIn与半双工模式开关。明确停止播报由stop_voice_playback桥接工具处理，复核当前完成转写，不调用cancel_work。旧诊断接口兼容保留，UI不再上报本地插话决策。

启动与通知：[SN-R1–R3](./startup-notices.md)。Renderer先准备麦克风，API创建等待供应商确认初始配置（Volc session.created / Qwen session.updated），之后才启动采集上传。socket.open不再表示模型ready，25秒初始化截止/关闭/错误统一释放等待者。通知控制规则放session instructions，可朗读payload仅传正文，沿用现有播放进度与礼让。

```text
OpenClawX Renderer
  ├─ getUserMedia (AEC / NS / AGC)
  ├─ PCM 16 kHz 上行
  └─ PCM 24 kHz 播放
          │ OpenClawX 登录态
          ▼
OpenClawX API /api/voice/realtime/*
  ├─ 用户鉴权与会话归属
  ├─ 火山凭证托管
  ├─ 会话生命周期与 SSE
  └─ 火山 WebSocket 协议适配
          │ X-Api-Key，仅服务端
          ▼
火山实时语音 WebSocket
```

OpenClawX API 默认从权限为 `0600` 的本地服务端配置文件读取 API Key，设置接口只回传末四位掩码；`OPENCLAWX_VOLCENGINE_REALTIME_API_KEY` 可作为运维环境变量覆盖。可用 `OPENCLAWX_VOLCENGINE_REALTIME_URL` 覆盖上游地址；默认是火山双工实时对话地址。这条能力随 OpenClawX 独立部署和发布。

工作能力关联默认关闭，此时使用空工具列表。启用后仅注册四个受控工具，通过 OpenClawX 编排器执行独立工作会话，复用员工的 Skill、MCP 与审批规则；火山会话不直接访问用户工作区。工具结果只包含状态和产物数量，完整输出保存在工作台。详见 [工作桥接设计](./work-bridge.md)。

独立语音输入使用 `/api/voice/asr/*`，在 agent-core 中适配 SAUC binary v1 / gzip WebSocket，API 负责鉴权、归属、SSE 与容量。Renderer 采集 16 kHz PCM，识别结果全量覆盖修正，最终文字经用户确认追加到聊天草稿，不进入编排器执行。默认复用实时语音密钥；独立配置可通过 `OPENCLAWX_VOLCENGINE_ASR_API_KEY` 覆盖。端到端链路不创建 ASR 连接。详见 [语音输入设计](./asr-input.md)。
