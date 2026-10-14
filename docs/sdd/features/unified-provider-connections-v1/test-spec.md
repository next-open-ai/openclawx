# UPC-001 · 测试规格

| 场景 | 预期 |
| --- | --- |
| 阿里综合连接，北京，无 Workspace | 自动生成共享域名的 compatible/native/realtime/inference 端点 |
| 阿里综合连接，填写 Workspace | 所有端点切换到相同地域的业务空间专属域名 |
| 通义千问 / OpenAI 新增连接 | 主流程与高级设置均不显示服务类型，默认综合服务，一套凭证配置全部已适配能力 |
| 火山方舟连接 | chat/image/embedding 使用方舟数据面地址 |
| 火山实时语音连接 | 使用新版 API Key 鉴权，不显示或要求 App ID |
| 火山实时语音自动配置 | 建立 `realtime` 模型、默认能力绑定与默认音色；运行时优先使用其密钥、模型、音色和 WebSocket 端点 |
| 火山语音识别与合成连接 | 使用对应语音端点；当前旧版 TTS 适配才显示并要求 App ID |
| 智谱综合连接 | 自动补齐官方 v4 地址并推荐 chat/vision/image/embedding |
| 自定义端点覆盖 | 对应能力优先使用覆盖值 |
| 旧连接 | 无 services/endpoints 时继续使用 baseUrl |
| 保存/读取 | services/endpoints 不丢失，密钥仍进入 secrets/safeStorage |
| 服务类型列表 | OpenAI/阿里不展示选择器；火山仅显示综合模型、语音；旧realtime底层值保留并在界面映射语音；其他单一服务类型无选择器 |
| UPC-T15 火山语音 | 仅API Key可保存并准备ASR/Realtime；有App ID另补TTS，旧realtime配置读写及实时端点不变 |
| UPC-T16 API Key | 新增/编辑默认遮蔽，按钮可显示/隐藏且不提交表单；切换上下文/关闭后遮蔽；显隐状态不持久化、不日志输出 |
| 通义公共端点推荐 | qwen-image-2.0使用dashscope-multimodal，qwen-vl-plus使用兼容接口；空Workspace不阻止，原模型和绑定保留 |
| 旧语音配置 | 未配置统一实时模型时继续回退旧密钥/模型/音色；已配置时旧值不覆盖新模型 |
| 旧语音自动迁移 | 管理员且尚无实时模型时创建火山实时连接/模型/音色/默认绑定；密钥进入安全存储，旧文件不删除；重复加载不重复迁移 |
| 实时模型测试 | 模型行显示“进入通话测试”，打开语音体验并复用完整会话、工作关联、声音表现和复刻能力 |
| 设置入口收敛 | 导航无独立语音页；模型页包含完整实时语音配置和测试区域，测试请求在已挂载组件中可重复触发 |
| 阿里实时模型 | 综合连接可登记 Qwen Audio/Omni Realtime，按 Workspace 派生 WebSocket 地址并使用 Bearer 鉴权 |
| 实时协议适配 | 火山与阿里的建连、首包、音频、文本、工具结果和关闭事件由各自适配器生成，公共 HTTP/SSE 路由不分叉 |
| 动态音色 | 火山与阿里实时模型分别展示兼容音色；Omni 默认 Tina，Qwen Audio 3.1 默认 longanqian_v3.1；自定义 ID 可保存 |
| 用量计量 | Qwen `response.done.usage` 累计为上游 Token/字符；任一供应商都统计 PCM 输入/输出时长；没有上游 usage 时标记为本地计时而非账单 |
- **UPC-T14**：回归确认通义千问 Workspace ID 默认空值、位于高级设置，且提示明确说明标准模型无需填写。
