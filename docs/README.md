# OpenClawX 文档中心

本页是产品、架构、开发、测试、评测、部署和编码智能体的统一文档入口。

当前实现快照：[OpenClawX 当前功能状态](current-state.md)（2026-10-13）。操作步骤见 [用户手册](guides/user-manual.md)，与应用内手册同源。

综合方法与传统项目改造指南：[AI 编程项目的工程文档体系与实践方法论](ai-engineering-documentation-methodology.md)。

## 按角色进入

| 角色 | 首要入口 | 继续阅读 |
| --- | --- | --- |
| 产品/需求 | [产品总览](product/product-overview.md) | [项目需求总览](product/requirements-overview.md)、功能 SDD |
| 当前能力核对 | [当前功能状态](current-state.md) | 用户手册、功能 SDD、质量证据 |
| 架构/设计 | [架构中心](architecture/README.md) | [全局架构](architecture/architecture.md)、ADR |
| 开发者/编码智能体 | [智能体规则导读](engineering/agent-guidelines.md) | [工程规则](engineering/README.md)、当前功能 SDD |
| 项目/评审 | [计划中心](planning/README.md) | [生命周期](lifecycle/README.md)、[阶段成果](deliverables/README.md) |
| 测试/质量 | [测试与质量中心](quality/README.md) | 回归套件、阶段测试、版本验收 |
| 平台评测 | [Benchmark 中心](benchmarks/README.md) | 平台特征、基线、数据集和报告 |
| 运维/发布 | [部署与运行](deploy/README.md) | [发布记录](releases/README.md) |

## 文档信息架构

| 目录 | 内容 | 权威性 |
| --- | --- | --- |
| `product/` | 产品定位、能力地图和项目级需求 | 产品与需求总览 |
| `architecture/` | 全局架构、专题设计与 ADR | 当前架构事实源 |
| `sdd/features/` | 功能需求、契约、计划、任务、测试和状态 | 当前功能事实源 |
| `planning/` | 跨功能路线图和计划总索引 | 项目计划入口 |
| `engineering/` | 编码、测试、SDD、文档和评审规则 | 工程执行事实源 |
| `quality/` | 测试策略、回归、阶段测试和版本验收 | 测试方法与证据入口 |
| `benchmarks/` | 平台特征评测、基线、数据集和报告 | 评测事实源 |
| `deliverables/` | 各阶段冻结评审成果 | 历史快照 |
| `guides/` | 用户与开发指南 | 使用入口 |
| `migrations/` | 运行时和版本迁移 | 迁移入口 |
| `deploy/` | 配置、部署、监控和回滚 | 操作事实源 |
| `releases/` | 发布版本、验收和限制 | 对应版本事实源 |
| `archive/` | 已废弃或已替代资料 | 历史参考 |

## 文档站与离线 HTML

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
```

静态产物位于 `docs/.vitepress/dist/`。构建使用相对资源路径，可复制到任意静态文件服务器或打包归档；完整搜索和主题交互应通过静态服务器查看。

## 权威性原则

当前行为以功能 SDD 为准；长期架构取舍以 Accepted ADR 为准；Deliverables 保存阶段冻结结论；Quality 保存测试证据；Benchmarks 保存平台特征评测；Archive 仅供追溯。详细规则见 [文档治理](engineering/documentation.md)。
