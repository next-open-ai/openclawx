# RV-SN：启动就绪与完成通知正文隔离

版本1.0；2026-10-14；已实现，模拟回归通过，真机待验收。范围：实时会话及桌面初始化；不修改任务调度或供应商正常打断职责。证据见[status.md](./status.md)。

- SN-R1 / SN-T1：先准备麦克风，再请求实时会话；未就绪不启动音频泵。API只在供应商确认初始配置后就绪，Volc session.created、Qwen session.updated（不是Qwen连接自动发出的session.created）。25秒整体上限，失败/提前关闭释放资源；无音频/工具自动重试。
- SN-R2 / SN-T2：local.connected表示模型会话确认，而非socket.open；结构化记录ws_open/config_ready/first_audio/startup_failed/closed，含会话ID/阶段/耗时，不记录凭据、提示词、音频。首次错误给出阶段，不能将失败伪装为已就绪。
- SN-R3 / SN-T3：完成通知发送的可朗读正文仅为用户通知文本，不拼“系统完成通知/只在客户端播报/不要调用工具”等控制前缀；行为约束放初始instructions，不塞进播报内容。沿用已有排队/音色/实际播放进度，不引入额外TTS或浏览器朗读。

SN-A1：两供应商本地WS，延迟确认前音频为0、确认后可上传、Qwen创建事件不误当配置完成；关闭/初始化错误拒绝等待者，无无限等待；日志不含敏感正文。
SN-A2：真实Vue模拟，麦克风授权未完成不创建远端会话、授权取消无泄漏、连接后单次采集、迟到会话关闭，保留原语音回归。
SN-A3：适配器初始/更新instructions与通知正文分离，发送文本等于通知正文，不含控制前缀。

兼容：HTTP创建将等待供应商确认，新客户端保持connecting直至成功。旧客户端仍接收local.connected。无持久化迁移；回滚本变更会恢复早期启动时序，不改变资产/任务。真机首次授权、弱网、供应商播报内容准确性需人工验收。

协议核对：[千问WebSocket启动顺序](https://www.alibabacloud.com/help/en/model-studio/realtime-websocket-overview)、[火山标准事件映射](https://docs.volcengine.com/docs/DoubaoVoice/access-mustread?lang=zh)。用户原日志未包含首次语音错误，本次修复已确认的时序风险，不宣称已实测原报错根因。
