# 实施与验证状态（2026-10-09）

## RD-T5 余额不足补充（2026-10-11）

已实现：共享 `UPSTREAM_BALANCE` 分类、402/SDK 状态字符串及明确余额/欠费错误识别；对话与项目复用现有失败展示。普通限流、认证失败、未知额度错误不直接认定欠费。错误内容只持久化规范化签名和状态码，不保存供应商响应体或密钥；不改变模型配置、超时、重试与工具执行策略。

验证通过（macOS / Node 22，保留既有工作区改动）：

- contracts build；agent-core build + 全量测试 180 通过，其中分类/实际 Pi SDK 本地 402 专项 3 通过，未调用真实供应商。
- orchestrator test 77 通过，余额错误通过 chat/project 保存到 RunRecord 和终态事件，且在可见回复中展示。首次新增项目断言发现部分 transcript 遮盖余额原因；修复 `appendTaskReply` 后全量重跑通过，其他失败展示策略不变。
- API typecheck/build/test 通过（45 通过，2 外部数据库测试跳过）；renderer typecheck 通过。界面无新增控件，复用现有错误文字与诊断字段展示。
- 文档构建与差异检查在交付前执行；未进行真实欠费账户调用、余额查询或桌面人工验收。

真实账户余额未查询，历史失败不能据此补判为欠费。代码需重启开发 API 或重新打包应用后生效；不自动重启用户当前服务。无数据迁移，旧错误记录不重写。

范围：Workmate。保留已有数据应用专属项目 / 统一 RunEngine 改动，不同步其他子项目，不迁移或重写历史运行，不增加超时，不自动重放工具。

| 需求 / 任务 | 实施 | 验证证据 |
| --- | --- | --- |
| RD-R1/T1 | 已实现规范化失败分类、SDK idle abort 特征保留、RunRecord/run.settled 传递 | agent-core model-failure.test；orchestrator run-diagnostics.test |
| RD-R2/T2 | 已实现准确项目终态、任务诊断详情；最终刷新不因已有 SSE transcript/服务端摘要而跳过 | scripts/run-diagnostics-regression.mjs 执行实际 Vue setup |
| RD-R3/T3 | 已实现刷新单飞、同步短时去重、运行中不重复恢复、标量 watch | 同上客户端回归；renderer typecheck/build；并发专项 |
| RD-R4/T4 | 已完成两条服务入口各成功/失败的隔离演示 | pnpm routes:demo（4 例 + 客户端回归）；步骤见 demo.md |

已执行通过：

- `pnpm routes:demo`：四条服务流程通过；无真实模型、无用户数据读写。
- `pnpm --filter @workmate/agent-core test`：165 通过。
- `pnpm --filter @workmate/orchestrator test`：63 通过。
- `pnpm --filter @workmate/api test`：31 通过，2 跳过（外部 MySQL/PostgreSQL 实测，未配置实测环境）。
- `node scripts/run-diagnostics-regression.mjs`、`node scripts/data-app-create-regression.mjs`：通过。
- contracts/agent-core/orchestrator/API 构建、renderer 类型检查与构建：通过；renderer 现有大 chunk 警告保留，未做无关拆包。
- `pnpm concurrency:regression`：隔离 API + stub sidecar + dsh MCP/Skills 通过。
- `git diff --check`：通过。

未执行：真实 GLM/其他供应商调用、桌面/手机可视化人工验收、真实应用发布。隔离演示仅证明两条服务路线和客户端状态处理，不证明线上供应商稳定性；历史错误缺少的原始证据不能补回。

兼容 / 回滚：failure 字段可选，旧事件和记录可读，无数据库迁移。回滚本期 helper、客户端行为和可选字段即可；不要删除历史运行或已有交付文件。原180秒模型单轮 idle 与30分钟总任务默认时限均未改变。
