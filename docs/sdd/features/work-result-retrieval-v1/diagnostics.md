# WR-R9 / WR-T9 · 语义检索诊断

2026-10-15后续：本文12秒截止及关键词降级描述已由[WR-R10元数据查找与可用降级](metadata-search.md)替代（30秒截止），本页保留当轮验证记录。

2026-10-15；状态：已实现，隔离测试通过；API全量类型检查存在原有阻塞，真实供应商待验收。

## 需求与契约

WR-R9：语音成果语义检索每次记录一条结构化终态日志，包含随机关联编号、语音/对话关联、模型来源（employee_text）、实际供应商/模型、候选数量、选中数量及总耗时。明确区分模型缺失、密钥缺失、解析配置失败、来源不可访问、主动取消、12秒截止、供应商错误、输出截断、非法JSON、结构校验失败及无效候选ID。成功但零匹配仍是成功，不等于服务不可用。

内部 WorkResultRanking 增加可选 diagnostic；Zod 契约统一在 contracts。诊断不进入工具返回、前端或语音模型上下文，不记录搜索词、文件名/正文/摘要、URL、密钥、原始异常或供应商返回体。API 沿现有 voice.lifecycle 日志通道输出 event=work_results.semantic。日志回调失败不影响检索。

## 任务与测试

WR-T9：core 分类并保留安全诊断，API 绑定模型解析与日志，实时会话接线；WR-T9 回归覆盖真实SDK本地桩的成功/空结果、非法JSON/结构、候选ID错误、密钥缺失、配置缺失、供应商错误、输出截断、主动取消与真实截止；API回归验证模型来源、关联编号、耗时与隐私及日志异常隔离。

范围：仅增强可观测性。不修改模型选择、12秒截止、检索/关键词降级策略，不增加重试或时间/类型过滤，不调用真实供应商。无持久化或客户端协议迁移；可选内部字段兼容原调用方，回滚本轮源码并重新构建即可。加载新版API、重新开始通话后生效；真实现场原因需要复现后根据日志确认。

## 验证

实际执行：`pnpm --filter @openclawx/contracts build`通过；`pnpm --filter @openclawx/agent-core test`（含构建）215项全部通过；`pnpm --filter @openclawx/api test`131项，129通过、2个真实数据库用例按环境跳过；`pnpm --filter @openclawx/api build`通过；`pnpm docs:build`、`git diff --check`通过。

`pnpm --filter @openclawx/api typecheck`失败于原有 `src/modules/voice/barge-in.test.ts:65` 的raw参数隐式any（TS7006）；本轮未修改该测试文件，没有把构建/测试成功当作全量类型检查成功。没有调用真实供应商、访问用户成果、重启用户服务或修改模型配置，现场根因仍待新版日志复现。本轮不改变并发调度/DSH或前端，未运行其专项回归。

复现后搜索日志的 `work_results.semantic`：`code=MODEL_MISSING/API_KEY_MISSING`核对员工文本模型配置，`MODEL_RESOLUTION_FAILED`核对配置解析，`TIMEOUT`为12秒截止，`CANCELLED`为主动取消，`PROVIDER_ERROR`为供应商请求失败，`OUTPUT_TRUNCATED`为输出长度截断，`INVALID_JSON/INVALID_RESPONSE/INVALID_CANDIDATE`分别表示格式/契约/候选ID问题。`RANKED`且selectedCount=0表示有效空匹配，不是调用失败。HTTP状态只在SDK暴露可信数值status时记录，不猜测、不保存原始错误文本。日志终态覆盖实际执行的语义ranker，未进入ranker的空候选/空query不产生此日志。
