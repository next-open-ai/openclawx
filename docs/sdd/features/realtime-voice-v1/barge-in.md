# RV-BI：桌面实时语音插话打断

版本：1.2；更新：2026-10-14。状态：实施中。范围：桌面实时对话（内嵌条及测试弹窗）；手机独立客户端不在本轮 UI 范围。任务证据见 [status.md](./status.md)。

## 当前行为（BI-R5 / BI-T5，替代1.1本地自动决策）

正常插话完全由供应商检测：API接收其讲话开始信号，递增旧回答栅栏并通知客户端清空播放，不发送重复response.cancel；重复开始事件幂等。删除本地音量/持续时间/文字回声决策及模式开关、无AEC半双工降级；AEC继续请求，音频传输保持现有静音治理。

新增供应商工具stop_voice_playback（无参数、独立于工作开关），仅在用户明确要求停止当前朗读/播报时调用。桥接以当前已完成转写复核停止指令（排除否定、疑问、引用），停止当前语音响应并清空本地播放；不取消文件生成/分析员工，不关闭通话。后台工作仅cancel_work取消。当前没有独立文件朗读生产队列，本轮停止的是当前语音响应，不虚构新增朗读任务系统。工具调用按call_id幂等，新的用户完成转写覆盖旧意图，停止意图只消费一次。

BI-A6：真实Vue回归验证任何强音量/转写不发取消请求、供应商开始事件停播并隔离旧事件、下一轮恢复、桥接停止/手动按钮；API本地WS验证自动事件不发response.cancel、明确语音停止才通过桥取消、否定/疑问/引用拒绝、工作开关关闭仍可停播、员工任务不受影响。

工具参数由contracts的VoicePlaybackStopSchema校验，只接受空对象，不接受模型传入任意任务ID或用户指令替代可信转写。

兼容：新增工具及local.provider_interrupted/local.playback_stopped事件；旧interrupt/diagnostics接口保留兼容，生产UI不再使用本地诊断决策。不迁移持久化配置。以下1.1段落仅保留为历史设计，已由本节替代。

## 需求与任务

- BI-R1 / BI-T1（1.1，BI-T4）：声音和供应商开始事件只作为候选，不能直接停播。稳健自动插话需要实际 AEC 开启、连续高于自适应底噪至少600ms、800ms内的新鲜有效转写、非疑似助手回声；明确停止指令缩至250ms但仍检查回声。无 AEC 降级按钮；提供关闭自动插话开关。手动按钮立即停播，不挂断、不取消工作。
- BI-R2 / BI-T2：认证 POST `/api/voice/realtime/interrupt`，契约 `RealtimeVoiceInterruptSchema`：session_id、可选 responseEpoch。返回 ok、responseEpoch；旧 epoch 请求幂等忽略。SSE upstream.event 附带 responseEpoch。供应商只发送官方 response.cancel，不清除用户音频。
- BI-R3 / BI-T2：按 response ID 与回合边界隔离旧音频、字幕、done 和未执行工具；无 ID 旧输出直到新 response.created，或用户输入完成后的 audio.started 才放行。已接受工作不取消，旧工具执行结果保留但不续播。
- BI-R4 / BI-T3：保留字幕并标记已打断；显示正在听；中断请求失败不结束通话，提示可继续讲话。任务通知只在空闲且客户端确认播放结束时发送，不抢话。

新增认证 POST `/api/voice/realtime/playback`，契约 RealtimeVoicePlaybackSchema：session_id、responseEpoch、busy。只报告播放状态，不改变工作状态。旧 epoch 播放报告忽略。中断/播放 HTTP 客户端 3 秒超时，不自动重试。

VoiceSessionCreateSchema 新增可选 clientPlayback；新版桌面传 true 才等待实际播放结束报告。手机和旧客户端缺省 false，仍按上游生成结束判断空闲，不会因缺少新报告而永久压住通知。

## 测试规格与追踪

- BI-A4 → R1：纯决策及真实 Vue 测试覆盖持续噪声/无文字不打断、开始事件不打断、回声文字不打断、明确指令、正常插话、候选过期、缺失AEC及手动模式、字幕不被候选清空。
- BI-A5 → R2：新增可选 diagnostic 字段及认证 diagnostics 接口，只允许枚举原因/数值/AEC状态；服务端每会话每秒最多一条候选日志，实际中断日志独立，不记录原音频/文字/设备名称。

1.1 当前火山标准协议文档只确认 response.cancel；未找到当前协议可验证的服务端自动打断关闭字段，不套用 RTC 产品的 InterruptMode。此次约束本地停播，不保证供应商不会自行结束生成或识别回声；真机联调待执行。

仅按钮模式/缺失 AEC 降级在回答期间按现有串行 mute/unmute 暂停上行（半双工），手动打断或回答实际播放结束后恢复，不丢已委托工作；此模式不支持边播边自然插话。稳健模式保持全双工，文本匹配只控制本地打断，不撤回已传给供应商的输入。候选启动不修改当前字幕/正在播放状态。新的 response/audio.started 清空旧候选，防止把上一轮用户文字用于新回答打断。开关只存于当前组件，不增加域配置。

- BI-A1 → R2/R3：本地 WS 两供应商协议、重复中断、迟到事件、下一回合、旧工具过滤、身份隔离。
- BI-A2 → R1/R3/R4：真实 Vue 组件 + 模拟 AudioContext，手动及采集插话、暂停 resume 竞态、排队尾音、首音保留和旧事件不复活。
- BI-A3 → R1/R4：renderer 类型/构建，既有语音回归；真实设备扬声器/AEC 误触发与供应商往返延迟需人工验收，不以模拟结果代替。

## 兼容与回滚

新增接口/字段，不改持久化配置。旧客户端忽略 epoch；新版前后端需一起更新。回滚本功能即可恢复旧语音行为，已有工作和资产不受影响。未实现供应商上下文按播放毫秒截断；仅在本地明确标记中断，不宣称已播完整。

协议参考：[火山标准 Realtime](https://docs.volcengine.com/docs/DoubaoVoice/access-mustread?lang=zh)、[千问客户端事件](https://www.alibabacloud.com/help/en/model-studio/client-events)。
