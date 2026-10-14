# 实时语音 V1 测试规范

- BI-A1/A2：`pnpm --filter @workmate/api test` 的 barge-in.test 与 `node scripts/voice-composer-regression.mjs` 覆盖桌面打断，详见 [barge-in.md](./barge-in.md)。

> 手机 HTTPS 专项：API test 覆盖显式关闭、外部证书/Origin/端口配置校验、托管 CA 与服务器证书生成、IP SAN、CA 稳定性，以及只允许 `/api/chat-mobile/` GET/POST；人工使用 iOS/Android 安装并信任二维码提供的 CA，验证 HTTPS 页面、麦克风、SSE、文件上传，并确认 `/api/settings`、`/api/orch` 等路径在 HTTPS 端口返回 404。

- 静态：`pnpm typecheck`。
- 构建：`pnpm build`。
- 手工：在「设置 > 语音」保存 API Key 后启动测试，从通话测试页确认麦克风授权、转写、文本增量、音频播放、静音、结束均正常。
- 持久化：不设置环境变量重启 Workmate，确认配置仍显示已配置且能完成火山真实 WebSocket 握手。
- 音色复刻：使用有效预付费音色槽位和小于 10 MB 的支持格式音频训练；确认可查询训练状态并选择可用音色。
- 安全：浏览器请求体不含 `api_key`；跨用户使用另一个会话 ID 返回 404；关闭关联时工具列表为空，服务端拒绝工作工具执行。
- 工作桥接：`pnpm --filter @workmate/api test` 覆盖重复调用去重、跨用户拒绝、关闭开关、长输出隔离、审批续跑和显式取消。详见 `work-bridge.md` 的 VWB-R1–R4。
- 工作状态闭环：语音工作处于 accepted/queued/running/待审批/取消中时，主输入区必须锁定且显示“工作执行中”；进入 completed/failed/cancelled 后立即解锁。模拟“模型先输出半句再失败”，关联对话必须同时显示半句和准确失败原因，不能把上游中断误报为 PDF 导出失败。
- Skill 一致性：API test 写入两个用户各自的 Skill/策略 KV，确认语音工作只加载当前所有者关联的 PDF Skill；作用域数据缺失时仍兼容旧版非作用域配置。真实联调确认执行步骤出现 `render_pdf_report`，而不是临时编写 PDF 脚本。
- 故障：不配置 Key 时点击开始通话，UI 显示“实时语音服务尚未启用”，普通文本聊天仍可使用。
- 实时传输：默认能力必须关闭实验性活动门控；桌面按 20ms 帧持续上传，手机按固定实时节奏上传且不得发送客户端重复 commit。上游 error 应显示不含密钥的可诊断原因。
- 静音协议：手动静音立即发送 mute；自动静音仅在持续约 5 秒数字静音后发送一次 mute 并停止音频。恢复时先 unmute 后上传积累的短前置音频。不得以长时间纯零 PCM 保持会话，避免 `Abnormal silence audio`。
- 字幕：收起状态只显示最新一句且无定时器、无前后翻页；展开后可查看全部本页字幕，新增或修订内容后预览仍保持最新一句。
- ASR：API test 覆盖 ASR-R1/R3 配置/掩码/隔离/容量/SSE；agent-core test 覆盖 ASR-R2 二进制协议、修订、末包、finish 幂等与超时。界面检查模式切换、独立密钥、保存测试、聊天入口与取消；真实麦克风录音、文字准确率和草稿追加需人工验收。
