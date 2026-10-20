# AGENTS

本文件是人类开发者和各类编码智能体进入仓库时必须遵守的最高级工程约定。它定义不可绕过的边界、任务执行顺序和交付标准；具体方法由 `docs/engineering/` 展开。

## 必守红线

1. **回归测试**：新模块 / 公共行为变更必须带可运行回归；合入前至少跑相关包 `test`，涉及并发/dsh 时跑 `pnpm concurrency:regression` / `pnpm dsh:regression`。
2. **分层清晰**：renderer 不 import Electron/Node；**只有** `packages/agent-core` 可调用模型 SDK；编排状态在 `@openclawx/orchestrator`（由 `apps/api` 托管）。
3. **强模块化**：契约以 `@openclawx/contracts`（Zod）为单一事实源；通道协议与传输解耦（`@openclawx/channel`）。
4. **域数据单写者**：domain KV 仅 api 进程写入；密钥在主进程 `safeStorage`，禁止写进 domain.json。
5. **小步可回滚**：改行为前先读权威架构文档；禁止无关大重构。
6. **规格驱动**：公共行为或跨包接口必须有稳定需求/任务 ID、契约与关联测试后再实现。
7. **状态不造假**：文档完成、代码实现、测试通过是不同状态，不得将未执行测试标为通过。

## 工作契约

### EasyMate业务同步

共同业务变更应同步同目录EasyMate的对应契约、实现及回归，并运行其 `pnpm work-results:parity` 检查已登记成果检索模块。EasyMate继续保持单Pi Agent，不同步AgentScope/DSH、多Agent内核或OpenClawX品牌/端口/运行时路径；产品差异必须记录。此门禁只覆盖登记模块，不代表全业务自动同步。

开始修改前必须：

1. 检查工作区状态，识别并保护用户已有改动；
2. 阅读本文件、相关工程规则、全局架构和当前功能 SDD；
3. 明确任务范围、非目标、受影响模块、公共契约和验证方式；
4. 公共行为缺少需求、任务或测试规格时，先补规格；
5. 涉及删除、覆盖、迁移、外部发布或不可逆操作时，先确认精确对象和恢复路径。

实施过程中必须保持修改小而聚焦。发现相邻问题时记录为独立任务，不以“顺手优化”为由扩大范围。禁止覆盖、回滚或格式化用户未授权的改动。

## 文档优先级

1. 安全与模块红线：当前目录及父目录 `AGENTS.md`；
2. 长期架构决策：`docs/architecture/adr/` 中 Accepted ADR；
3. 全局架构：`docs/architecture/architecture.md`；
4. 当前功能行为：`docs/sdd/features/<feature>/`；
5. 工程执行方法：`docs/engineering/`；
6. 阶段历史：`docs/deliverables/`，仅作冻结快照。

当文档冲突时，先按上述层级确认事实源；无法消解的冲突必须显式报告，不得自行选择更方便实现的一份。

## 变更类型与最低交付物

| 变更类型 | 最低要求 |
| --- | --- |
| 纯内部实现 | 关联任务、相关单元测试或回归证据 |
| 公共行为或跨包接口 | requirements、contracts、tasks、test-spec 和追踪关系 |
| 模块边界或长期取舍 | 更新全局/专题架构，必要时新增 ADR |
| 配置、数据或协议变化 | 版本策略、迁移、兼容性、回滚和契约测试 |
| UI/交互变化 | 状态、空态、错误态、权限态和验收场景 |
| 性能或能力优化 | 正确性回归；需要比较时建立 Benchmark，不用 Benchmark 代替测试 |
| 发布或部署变化 | 发布验收、部署说明、监控指标和回滚步骤 |

## 标准执行流程

```text
确认范围 → 读取事实源 → 更新规格 → 拆分任务 → 最小实现
        → 分层验证 → 同步状态与证据 → 汇报结果和剩余风险
```

- 规格与实现冲突：先修正规格并完成必要评审；
- 实现与测试冲突：以契约和需求判断预期，禁止仅修改测试来迎合实现；
- 测试失败：报告根因和影响，不得标记完成；
- 无法执行测试：说明未执行原因、替代检查和残余风险。

## 验证与交付报告

验证范围必须与风险相称，至少覆盖受影响包；跨包、配置、并发、权限和发布变更应扩大到类型检查、构建、集成或专项回归。最终报告必须包含：

- 实际改动及未改动范围；
- 实际执行的命令与结果；
- 未执行项及原因；
- 配置迁移、兼容性、回滚和已知风险；
- 相关规格、任务、测试或报告入口。

## 详规

| 文档 | 内容 |
|------|------|
| [docs/engineering/architecture.md](docs/engineering/architecture.md) | 分层与模块边界（工程摘要） |
| [docs/engineering/testing.md](docs/engineering/testing.md) | 回归 / 冒烟约定 |
| [docs/engineering/coding-standards.md](docs/engineering/coding-standards.md) | 编码标准 |
| [docs/engineering/sdd-workflow.md](docs/engineering/sdd-workflow.md) | SDD 工作流 |
| [docs/engineering/documentation.md](docs/engineering/documentation.md) | 文档治理 |
| [docs/engineering/review-checklist.md](docs/engineering/review-checklist.md) | 规格与代码评审门禁 |
| [docs/planning/README.md](docs/planning/README.md) | 总计划与路线图 |
| [docs/quality/README.md](docs/quality/README.md) | 测试、回归与验收 |
| [docs/benchmarks/README.md](docs/benchmarks/README.md) | 平台特征评测 |
| [docs/engineering/README.md](docs/engineering/README.md) | 索引 |

权威详细架构以 [docs/architecture/architecture.md](docs/architecture/architecture.md) 为准；统一入口见 [docs/README.md](docs/README.md)。

## 常用命令（摘要）

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm concurrency:regression   # 含 dsh MCP/Skills 桥接
pnpm dsh:regression
pnpm docs:build
```
