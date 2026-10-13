# 项目编排：Plan / Run / ChangeSet（P0–P1）

> 权威摘要亦见 [architecture.md](architecture.md) §5.2。本文展开数据模型与演进动机。

## 动机

### 新建普通项目：持续对话（LP-V1）

普通项目默认 `kind: conversation`：创建只建立私有空间与固定成果目录，不生成 Plan、不执行模型、不自动启动。每次显式消息建立一个无依赖的独立 turn（复用 task/Run 持久化、审批和执行机制），沿用当前员工授权与模型。近期真实消息有界传入下一轮，历史失败不触发重跑、不影响新轮成功判定。已有成果复制到隔离运行的 `output/`，材料复制到 `inputs/`；只有成功终态前才准备完整成果目录副本并替换，取消/失败/孤儿恢复不晋升未完成文件。符号链接被拒绝；不是操作系统级沙箱。运行交付与应用发布彼此独立，详见下方 PA-V1。规格及证据见 [LP-V1](../sdd/features/lightweight-project-v1/README.md)。

以下 Plan / ChangeSet 规则继续适用于旧项目、工作流执行项目与已有数据应用项目；缺省 kind 保持兼容，不自动迁移。需要多员工协作时，持续对话项目显式调用既有工作流并产生独立执行项目。

新建持续对话项目可选系统保存位置或自选父目录。API 统一创建 UUID 命名的独立子目录并固定保存其路径，不能直接接管用户所选父目录（成果晋升会替换项目目录）。自选目录校验存在、可写、非根目录和非符号链接；浏览器路径指向 API 所在主机，桌面端复用目录选择 IPC。该选项不改变执行隔离与成果晋升规则，也不迁移已有项目。

持续对话项目的静态应用发布另见 [PA-V1](../sdd/features/project-application-v1/README.md)：API 将允许的页面资源保存为项目目录外的不可变内容快照，显式确认后更新单一发布指针；后续 Run 晋升不改发布版。服务端检查读写权限、预览修订与发布版本冲突，使用临时只读票据和 CSP sandbox 提供页面，不把登录凭证交给生成内容。它是本地静态发布，不代替数据应用绑定或公网部署。

早期实现把「规划」和「执行」揉在同一张 `tasks[]` 上：补充指令或改成员时往往整表重写，已完成成果难保留，`mode` 与 `dependsOn` 还存在双语义。P0–P1 目标：

1. **Plan 与 Run 分离**（可版本、可回放）
2. **增量 ChangeSet**（指令 / 失效）代替整图 recreate
3. **统一 DAG 执行**；waterfall/parallel 只是建边策略
4. **任务契约**与 **stale / superseded** 显式失效语义

## 数据模型

```ts
Project {
  plan?: ProjectPlan           // 当前计划元数据
  planHistory?: ProjectPlan[]  // 历史版本元数据（非全量快照）
  changeSets?: ProjectChangeSet[]
  tasks: ProjectTask[]         // 当前 Plan 物化图（含 superseded 历史节点）
  activeRunId?: string
}

ProjectPlan { version, createdAt, strategy, taskIds, note? }

ProjectChangeSet {
  kind: 'instruction' | 'replan' | 'invalidate'
  targetTaskIds, invalidatedTaskIds
  planVersionBefore, planVersionAfter
}

ProjectTask.status:
  draft | queued | running | completed | failed | cancelled
  | stale        // 需重跑
  | superseded   // 已退出当前 Plan

ProjectTask.contract?: { outputs?, acceptance?, timeoutMs?, maxAttempts? }

ProjectRun { planVersion?, changeSetId?, ... }
```

## 运行时

- `applyPlanningStrategy(mode, tasks)`：waterfall/discussion → 链式边；parallel 无边；dag 保留显式边。
- `drain`：**统一 DAG 就绪集**；批次 `await` 执行，审批停车后由 `notifySchedule` **事件唤醒**（P2 混合事件驱动）。
- `dispatchInstruction`：ChangeSet + `invalidateTaskCascade` + `confirm`。
- 项目续聊保留可见消息并按 ChangeSet 增量执行，不因项目已完成触发全量重跑；目标任务的可选 followUp 引用前次 Run，作为有界回答上下文，以当前要求优先。顶部完整调度仍归档旧消息并全量重跑。项目输入、文档作用域与验证见 [PC-V1](../sdd/features/project-conversation-v1/README.md)。
- 恢复未完成步骤同样保留当前对话；仅显式完整新一轮归档旧对话。Renderer 执行前订阅并短时等待 SSE 握手，录入成功的服务端快照采用后再回放缓冲事件；失败降级轮询。运行镜像按 Run ID 保留未 checkpoint 的实时回复，文本/思维增量的可选 textOffset 为 UTF-16 起始偏移，用于去重被轮询快照覆盖的增量；旧消费者可忽略该字段。
- `replanProject`：`mergeReplanTasks` 保留可复用 completed → Plan vN+1。
- `lastAttemptKey`：`{taskId}:plan{v}:attempt{n}`，同键已完成则幂等跳过（P3）。
- 每个任务 attempt 与普通对话共用 RunEngine；contract 的超时覆盖传至同一模型执行预算。隔离数据项目在 RunEngine 的 finalizeCompleted 中晋升交付物，成功或失败落定后只发一次终态，各 SSE 主题与 RunRecord 一致；普通项目默认工作区行为不变。详见 [统一 attempt 第二期](../sdd/features/unified-attempt-v1/README.md)。
- **上下文预算（简单提配）**：依赖证据 / 任务目标 / 项目汇总按 soft→boost 截断，**不中断执行**；步进压缩触达阈值时先提配再摘要（`context-budget.ts` / `context-compaction`）。
- **运行时上下文卫生**：每轮 LLM 调用前剥离 thinking、写文件仅保留路径、命令结果包装截断，再按阈值压缩（详见 `docs/architecture/context-hygiene.md`）。

## 协调员两阶段规划（P2）与协作偏好

旧 DAG 项目/工作流规划时，所选模板是**规划偏好**，不是硬约束；普通项目入口不再展示模板或协调员规划：

1. **Phase 1**：只产出结构（title / employeeId / dependsOn）与建议模式  
2. **Phase 2**：为固定结构填充 objective / contract  
3. 用图形态推断 `suggestedMode`；若与偏好不符 → UI 弹窗建议切换  

实现：`apps/renderer/src/app/workspace.ts`（`generateProjectDraft`）、`project-planning.ts`、`ProjectsPage.vue`。

## API

| 方法 | 路径 |
| --- | --- |
| 创建草案 | `POST /api/orch/projects` |
| 确认开跑 | `POST /api/orch/projects/:id/confirm` |
| 增量指令 | `POST /api/orch/projects/:id/instructions` |
| 成员重规划 | `POST /api/orch/projects/:id/replan` |

## 实现入口

### 可复用工作流与算法目录（WA-V1）

普通对话中的「基于成果提问」另见 [WQ-V1](../sdd/features/workflow-result-qa-v1/README.md)。API 按来源/调用人/执行项目权限重建有界 Run 文本及登记文件清单，用 revision 检测更新；客户端不能提交证据内容或授权路径。ChatSession 将该回合标为 text-only，不创建或恢复持续任务。agent-core 使用模型协议适配器单轮流式回答，不启动执行后端、工具、Skill/MCP、搜索或文件交付；保留 Run 与 token 计量。此模式仅解释保存文本，不读取文件正文或修改成果；项目续聊仍是增量执行。引用快照随当前对话历史保存，后续每次发送重新验权，不追溯清除历史答案。

工作流定义通过用户隔离的 `/api/orch/definitions/workflows` 保存；运行准备接口 `/definitions/workflows/:id/runs` 保存不可变定义快照、本次要求和项目关联，按 requestId 幂等物化独立 DAG 项目，重新生成节点 ID 并映射依赖。关联使用 `workflow-executions:v1:<org>:<user>:<requestId>`，不创建第二套调度器。历史状态、耗时和成果动态读取 ProjectService / RunEngine 的持久化证据；`confirmProject({ resumeIncomplete: true })` 仅恢复失败或取消项目中的未完成节点，默认全量重跑语义不变。固定目录、运行状态与资产仍归原服务，本期没有普通对话自动调用服务。

工作流创建复用项目协调员的两阶段规划，经「描述目标 → 确认流程」保存为定义；可手动编排，规划/保存不执行任务。算法导航目前隐藏，保留既有代码及数据，不开展算法能力迭代。

工作流运行支持独立作用域的文档上传，复用既有附件解析器，fileIds 纳入准备幂等比较；准备时原件和解析节选写入托管项目 `inputs/<requestId>/`，各节点接收材料路径和非指令边界提示。材料清单随运行关联保留，与交付成果分开显示；不新增模型调用或员工权限。旧运行缺省空材料，无迁移。

普通对话和托管项目均提供显式工作流调用入口：两类来源路由复用同一准入、历史及恢复逻辑，source 是 chat/sessionId 或 project/projectId 严格联合。接口在服务端创建独立私有项目及托管目录，来源 DAG、状态、目录与材料不变。来源读写权限独立校验，调用历史按 org/user 隔离，不继承来源共享范围。按 requestId 串行准入并且只启动 draft 项目；安全恢复接口仅恢复 failed/cancelled，运行或完成时返回原关联，避免过期卡片重复全量调度。卡片是 Project/Run 的只读投影，显示终端节点真实文本节选及已登记成果，来源模型不隐式获得工作流上下文。项目详情导航采用页面内来源栈，返回仅导航、不确认或重规划来源项目，避免重挂页面触发草稿自动启动。尚无自动选择、嵌套 DAG 或员工 run_workflow 工具。详见 [WC-V1](../sdd/features/workflow-chat-v1/README.md)、[WP-V1](../sdd/features/workflow-project-v1/README.md)。

算法目录通过 `/api/orch/definitions/algorithms` 保存 Skill 引用与业务元数据；真实算法实现、员工调用授权、脚本/网络审批均复用原 Skill 能力链路。目录不携带可执行脚本或密钥，不作为运行可用性证明。规格与后续边界见 [WA-V1](../sdd/features/workflow-algorithm-v1/README.md)。

- `packages/orchestrator/src/project-plan.ts`
- `packages/orchestrator/src/project.ts`
- 桌面镜像：`apps/renderer/src/features/projects/*`
- 单测：`packages/orchestrator/src/test/project.test.ts`（Plan / ChangeSet / replan merge）
