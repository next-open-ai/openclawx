# 编码与设计标准

## 1. 总则

- 与现有 monorepo 风格一致；小步改动，禁止无关大重构。
- **可读、可测、可替换** 优先于炫技抽象。
- 密钥、Token、用户隐私不进日志与 Git。

## 2. TypeScript / 包

- 共享类型与 Zod schema 放 `@openclawx/contracts`，不要在 app 内私自叉一份。
- 跨包 API 保持稳定；破坏性变更要有迁移说明与测试。
- `any` 仅在边界短暂使用并尽快收窄；公共导出必须有明确类型。

## 3. 进程与安全

- renderer：纯浏览器；网络只打本机 API / 受控 IPC。
- 工具执行：遵守员工权限档位与审批；工作区外写入默认拒绝。
- 主进程密钥：`safeStorage`；经 fork IPC 一次性下发，不落 domain.json。

## 4. Agent / 运行时

- 新执行后端实现 `ExecutionBackend`（或现行等价抽象），不要在 orchestrator 内嵌 SDK。
- AgentScope / dsh sidecar 变更同步设计文档与回归脚本。
- 流式事件字段与现有 SSE/ABI 对齐（见 `docs/architecture/agentscope-abi.md` 等）。

## 5. 文档

- 功能行为变化更新对应功能 SDD；只有全局边界、长期取舍或工程规则变化才更新 `architecture/` 或 `engineering/`。
- 公共导出、配置、事件和错误语义变化必须同步契约、迁移说明和测试。
- 注释只写非显而易见的约束（并发、续跑、权限）。

## 6. 错误、可观测性与兼容性

- 边界错误使用稳定错误码或结构化错误，不依赖字符串匹配控制流程。
- 日志包含必要的 run/session/request 关联信息，但不得记录密钥、完整 Prompt 或敏感内容。
- 重试必须有次数、退避、幂等和终止条件；取消信号应贯穿长耗时调用。
- 配置和持久化结构变化必须版本化，迁移失败不得破坏原数据。

## 7. 禁止

- renderer 直接调模型 SDK 或写 domain KV。
- 多写者争用 `~/.openclawx` 域数据。
- 提交密钥、大数据 runtime、本机绝对路径配置。
- 用文档代替测试。
- 捕获异常后静默成功，或用默认值掩盖数据和契约错误。
