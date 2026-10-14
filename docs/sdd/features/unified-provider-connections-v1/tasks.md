# UPC-001 · 实施任务

- [x] UPC-T1：在 contracts 建立服务类型、端点与厂商模板的单一事实源。
- [x] UPC-T2：扩展 Provider 实例，支持服务类型与端点覆盖，并按模型能力解析运行时地址。
- [x] UPC-T3：Provider 新建/编辑界面增加服务类型，默认折叠高级地址，展示系统派生端点。
- [x] UPC-T4：API 与 Electron 安全存储保留新增非敏感元数据。
- [x] UPC-T5：覆盖阿里、火山、智谱、旧配置回退。
- [x] UPC-T6：同步架构、用户手册与当前状态。
- [x] UPC-T7：将实时语音凭证、模型、音色与端点接入统一 Provider/模型，保留旧设置回退。
- [x] UPC-T8：通义千问主流程隐藏服务拆分，高级设置保留专业拆分入口。
- [x] UPC-T9：旧实时语音自动迁移到安全 Provider/模型，并从实时模型行进入完整通话测试。
- [x] UPC-T10：取消独立语音设置导航，把实时语音完整配置区域合入模型页。
- [x] UPC-T11：建立实时语音供应商适配器注册表，接入火山与阿里 Qwen Realtime，并保留未知供应商的明确拒绝边界。
- [x] UPC-T12：实时模型配置按供应商展示推荐模型、常用音色和协议能力说明。
- [x] UPC-T13：归一化实时语音用量事件，在通话界面展示供应商、模型、Token 或音频计时及计量来源。
- [x] UPC-T14：将服务类型的可见性收敛为 Provider 策略；千问与 OpenAI 全程隐藏拆分选项，仅火山保留必要的产品线选择。

真实账号、地域、额度和模型开通状态仍属于发布前人工验收，不以本地回归替代。
- [x] 将通义千问 Workspace ID 收入高级设置，默认留空并补充例外场景说明。
- [x] UPC-T15（2026-10-14）：新增/编辑火山只显示综合模型、语音；语音可准备ASR/Realtime、App ID可选补TTS；兼容旧realtime值，更新阿里图片推荐及协议、保留已有绑定。
- [x] UPC-T16（2026-10-14）：共用API Key显隐输入组件，默认遮蔽、上下文变化重置、非提交按钮；真实组件脚本回归显隐状态和输入事件，无密钥日志/持久化显隐状态。

本次验证：`node scripts/provider-auto-config-regression.mjs`、`node scripts/provider-key-input-regression.mjs`、renderer build（含类型检查/手册生成）、`node scripts/user-manual-regression.mjs`、`pnpm docs:build`、`git diff --check`通过。agent-core build +全量test 205项通过，DashScope同步图片HTTP桩同时覆盖wan2.7-image和qwen-image-2.0的模型/路径/参数/下载。初次扩展测试循环有局部变量作用域编译错误，修正后全量重跑通过。

未使用真实凭证、付费模型调用、真实浏览器/桌面交互或安装包验收；Key组件以实际脚本VM及SFC构建验证，不冒充浏览器点击验收。前端保留既有chunk警告。无存储迁移、未重启服务或修改已保存连接。已有阿里默认绑定不自动替换，重新自动配置补齐推荐后由用户选用。
