# 测试约定

> 项目级策略和回归目录见 [测试与质量中心](../quality/README.md)；历史场景规格仅供追溯：[早期测试规格](../archive/legacy-global-sdd/test-spec.md)。

## 1. 原则

- **每个模块**公共行为变更必须有可运行回归；禁止只交实现。
- 优先测 **契约、权限、路径隔离、状态机、并发**，而非供应商 SDK 内部。
- 已有脚本回归必须纳入相关 PR 的自检。
- 测试应验证对外行为和稳定契约，避免把内部实现细节固化为不可重构的断言。
- 外部模型和第三方服务默认使用 mock/stub；真实服务测试必须记录模型、参数、环境、成本和数据边界。

## 2. 分层

| 层级 | 范围 | 入口 |
|------|------|------|
| 静态 | 类型 / 构建 | `pnpm --filter @openclawx/renderer typecheck`、各包 build |
| 单元 | 权限、路径、调度、纯函数 | 各包 `vitest` / `pnpm test` |
| 集成 | Fastify SSE、工具事件、存储 | 临时工作区 + mock Provider |
| 专项回归 | 并发运行时、dsh MCP/Skills | `pnpm concurrency:regression`、`pnpm dsh:regression` |
| E2E / 人工 | 桌面流式、审批、真模型 | 开发态 / 安装包 |

## 3. 模块落测约定

新增或大改下列包时，同步补测试（或扩展现有回归脚本）：

- `packages/orchestrator` — Plan/Run/审批/取消
- `packages/agent-core` — backend 选择、工具权限、工作区路径
- `packages/contracts` — schema 破坏性变更的兼容用例
- `apps/api` — orch 路由与 SSE
- `apps/gateway` — 适配器白名单与消息归一

## 4. 必测基线（摘要）

- [ ] 路径穿越（`../`、绝对路径、符号链接）被拒绝
- [ ] 只读权限无法写文件/跑脚本绕过审批
- [ ] 取消/失败不丢已成功产物与运行记录
- [ ] 并发任务工作区隔离、资产不互相覆盖
- [ ] 未配置模型时错误可读、UI/API 不崩溃

## 5. 命令

```bash
pnpm test
pnpm concurrency:regression
pnpm dsh:regression
```

需要图形化运行、查看实时日志或保留本地执行记录时，使用 `pnpm quality:console` 打开统一测试控制台（默认 `http://127.0.0.1:47840`）。控制台只运行代码内白名单命令；并发测试默认预览，显式选择实测后才访问本地 OpenClawX API。

发布前清单见 `docs/releases/checklist.md`。

## 6. 测试证据

测试记录至少包含提交或工作区状态、执行日期、环境、命令、结果和失败项。统一使用 `通过`、`失败`、`未执行`、`不适用`、`风险接受`，不得用“应该没问题”代替结论。性能和能力比较进入 `docs/benchmarks/`，不能用 Benchmark 得分代替功能正确性。
