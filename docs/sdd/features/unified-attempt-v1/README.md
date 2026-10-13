# 对话与项目执行收敛 · 第二期

范围：沿用现有 RunEngine，不增加平行执行器、不合并 UI/领域记录、不迁移历史数据。本期统一 attempt 超时与完成交付边界；对话记忆、审批续跑及项目 DAG 仍由各自服务管理。

## 需求、任务与契约

- UAT-R1/T1：RunEngine 是唯一 attempt 执行入口。选择 timeoutMs > request.runTimeoutMs > 引擎默认值，经 5 秒～2 小时限制，传给 dispatcher 与 runner 的 request.runTimeoutMs 保持一致；领域层可显式覆盖（持续任务、项目 contract）。runId 保持统一。
- UAT-R2/T2：新增仅服务端可信的 ExecuteAttemptOptions.finalizeCompleted 回调。仅真实 completed 且无待审批、无取消时执行；回调错误将 attempt 标为 failed，所有主题只在完成交付后收到唯一 run.settled。数据项目隔离工作区晋升移到该边界；普通项目与普通对话无回调，行为兼容。
  晋升工具增加可选 strict 模式：数据项目必须传播复制/读取失败；旧调用继续 best-effort。无 output 目录不等于复制失败，应用可用仍以实际绑定为准。多文件晋升非整体事务，失败时可保留部分已复制文件，发布应用的 SQL HTML 不由晋升覆盖。
- UAT-R3/T3：上游异常/取消不能被先前 run.completed 掩盖。保留部分文本与产物；取消、失败、审批停车不执行完成回调。活动、产物、审批、终态与持久化仍走原事件契约。
- UAT-R4/T4：数据应用优化通过 export_data_app_custom_site 获取真实当前页面、使用最新 Schema、绑定原 appId；成功优化不新建项目，失败保留旧版。补充隔离真实工具验收，非模型生成质量验收。

公共 HTTP/SSE/持久化结构不变；内部 TypeScript ExecuteAttemptOptions 增加可选回调，无客户端传入路径或函数。回滚恢复旧 RunEngine/ProjectService 调用即可，无数据库迁移。

## 测试规格

- UAT-T1：chat/project-task 两种运行均验证实际 runner deadline 与 engine deadline 一致；显式覆盖、默认/上限/下限及 runId。
- UAT-T2/T3：交付门控时仍无 settled；交付成功事件先于 settled，失败仅 failed；所有主题终态一致。取消、审批、上游异常不晋升，保留部分输出。既有 chat/project 审批、重试、活动与并发专项回归。
- UAT-T4：隔离 API + SQL + 原生工作区工具执行创建、导出、编辑和再次绑定，原 app/project/URL 不变；执行失败保留旧 HTML。

真实模型验收须用户指定模型并确认调用范围；默认不用现有用户密钥。状态和测试结果另记，未执行不得标为通过。

## 状态与验证（2026-10-09）

UAT-T1～T4 的实现与隔离验证完成，未合并对话/项目界面，未迁移数据，未同步子项目。项目化入口第一期已有修改保留。

- `pnpm --filter @workmate/agent-core test`：164 项通过，新增严格/兼容晋升的实际文件复制故障测试。
- `pnpm --filter @workmate/orchestrator test`：59 项通过，含一致预算、终态门控、真实项目文件晋升失败、上游异常、审批停车、交付期间取消、部分产物保留。
- `pnpm --filter @workmate/api typecheck` / `test` / `build`：通过；测试 31 项通过，2 项真实外部数据库验收跳过。应用后续运行的真实工具导出/编辑/再次绑定、最新 Schema、原 app/project/URL 保持，以及失败保留已发布 HTML 已验收；runner 为确定性桩，不代表真实模型表现。
- `pnpm concurrency:regression`：通过（临时目录、AgentScope 桩、全局/用户容量、dsh Skill/MCP 桥接）。
- `node scripts/data-app-create-regression.mjs` / `node scripts/data-workbench-ux-regression.mjs`：通过；`git diff --check` 通过。本轮无新 UI，未重复桌面界面验收。

故障注入曾发现晋升工具吞掉复制错误，已修复为数据项目严格模式，旧调用默认兼容。验收测试中曾将明细 API 当成带 publishUrl 的列表 DTO，已按实际接口改用列表核验地址；未因此改变接口。最初过程文件过滤测试错误地假定所有 output 中的 Python 文件都应拒绝，已使用既有的 tmp 过程目录验证，没有改变既有交付文件规则。

真实模型创建/页面验证/绑定及桌面完整闭环：未执行，等待用户指定模型并确认服务调用；未读取现有用户密钥、未发生模型费用。后续继续收敛领域层审批/取消入口之前，先完成该验收。多文件晋升不是整体事务，严格失败不回滚已经复制的文件；保留现有产物规则不变。
