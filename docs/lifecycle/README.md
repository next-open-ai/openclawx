# 开发生命周期与阶段产物

OpenClawX 使用 SDD 驱动实现，并在各阶段保留可评审成果。

| 阶段 | 权威输入 | 必需产物 | 退出条件 |
| --- | --- | --- | --- |
| 发现/立项 | 产品目标、问题陈述 | 范围、非目标、需求总览 | 价值和边界明确 |
| 需求 | 功能需求 | requirements、验收条件 | 可测试、编号稳定 |
| 架构 | 需求、全局约束 | ADR、architecture、contracts、state machine | 边界和决策通过 |
| 交互 | 用户故事、架构 | ui-spec、状态与异常流程 | 交互评审通过 |
| 计划 | 已评审规格 | plan、tasks、依赖、回滚 | 可拆分、可排期 |
| 实现 | 当前任务和契约 | 代码、迁移、单元与契约测试 | DoD 满足 |
| 验证 | test-spec | 回归、测试报告、必要的 Benchmark | 门槛通过或风险接受 |
| 发布 | 候选制品 | 发布验收、部署说明、回滚演练 | 可部署、监控和回滚 |

当前规格进入 `docs/sdd/features/`，长期决策进入 `docs/architecture/adr/`，阶段快照进入 `docs/deliverables/`。
