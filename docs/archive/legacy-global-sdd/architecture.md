# OpenClawX 架构与概要设计（历史总规格）

> 状态：历史参考。当前全局架构见 [架构文档](../../architecture/architecture.md)，新功能架构进入 [功能 SDD](../../sdd/README.md)。

## 1. 分层架构

```text
Vue Renderer
  ├─ 对话工作台 / 数字员工 / 技能与连接 / 项目 / 自动化 / 资产库
  ├─ workspace：会话状态、员工选择、受控 Agent 调用
  ├─ projects：项目、任务草案、运行记录的本地持久化
  └─ assets：产物归档与查询
        │ HTTP SSE
Fastify API ── Agent Core ── Vercel AI SDK Provider
                         ├─ Skill runtime：渐进加载、工具与权限判定
                         └─ Workspace：每个运行独立目录
        │ IPC
Electron Main ── SQLite（元数据） + ~/.openclawx（Skill、工作区、资产文件）
```

## 2. 核心模块职责

| 模块 | 职责 | 关键边界 |
| --- | --- | --- |
| `renderer/app/workspace.ts` | 用户会话、员工授权解析、Agent 请求和流式事件映射。 | 交互会话与项目任务使用不同执行入口。 |
| `packages/agent-core` | 将模型流、Skill、工具和权限策略组合为一次运行。 | 模型不能自行扩大权限；工具结果通过事件流返回。 |
| `skill-runtime.ts` | `load_skill`、读写工作区、脚本、依赖和网络工具。 | 文件路径必须限定在 Skill/工作区根目录；危险操作不暴露。 |
| Electron Main | SQLite 元数据、模型密钥保护、资产复制与系统文件交互。 | Renderer 不直接访问宿主文件系统。 |
| `projects.ts` | 项目草案、任务状态、重试/取消标记和项目运行记录。 | 仅保存可序列化业务数据，不保存运行时 Promise 或模型密钥。 |

## 3. Skill 与执行模型

Skill 是“业务指令能力包”，不是自动获得系统权限的插件。运行时分为两条明确边界：

1. **平台基础 Tools**：工作区读写、受控脚本、交付物登记与项目发布属于 Runtime Tool Contract，不进入 Skill 目录、不参与业务路由，也不要求传入 `skillId`。`workspaceAccess`（`read` / `write` / `full`）统一约束 PI 与 AgentScope 的宿主工具；默认 `write` 可完成受控的本地产物生成。
2. **业务 Skill 候选层**：只根据员工授权与任务选择传递名称、描述和风险元信息。
3. **业务指令层**：模型调用 `load_skill` 后读取选中业务 Skill 的 `SKILL.md`。
4. **资源/执行层**：业务 Skill 按需读取资源；平台 Tools 在独立运行工作区中完成受控 I/O 与产物交付。

DSH 目前直接控制其运行目录，尚未具备操作系统级只读沙箱；因此 `read` 任务会被显式拒绝 DSH，必须路由至 PI 或 AgentScope，不能静默降级为可写。

Skill 的执行策略、员工授权、任务权限档位和用户审批均须通过，实际工具才能执行。

### 普通对话协作者

用户可明确选择 1–3 位协作者。协作者与主员工使用独立请求和上下文，并固定为只读权限；其流式摘要与工具过程记录在主答复的协作卡片中。主员工只接收完成协作者的摘要并生成最终答复。该模式不允许协作者递归委派，也不允许其绕过文件、脚本或网络审批边界。

## 4. 项目编排一期设计

### 数据模型

```text
Project
  id, name, goal, status, coordinatorModel, tasks[], summary, activeRunId
ProjectTask
  id, title, objective, employeeId, provider/model, skillIds[], permissionTier
  status, attempts, transcript, error, timestamps
ProjectRun
  id, projectId, taskIds[], status, summary/error, timestamps
```

### 生命周期

```text
选择模板 / 创建目标 → 协调员生成草案 → 用户编辑/确认
  → draft → queued
  → 调度就绪任务：瀑布顺序、并发同层、讨论汇合、DAG 拓扑层 (running → completed | failed)
  → 汇总任务读取成功子任务的结构化输出
  → completed | failed | cancelled
```

### 并发与隔离

- 每个子任务调用 `runProjectTask`，不复用 `activeConversationId` 或当前员工状态。
- 每次 Agent 调用由 Agent Core 创建独立 `runId` 与工作区，因此生成文件可准确归档。
- 并发模板的同层任务使用 `Promise.all`；瀑布模板将任务串成链；讨论模板以多个观点任务汇合到主持任务；DAG 模板以持久化 `dependsOn` 做拓扑分层调度。循环或无效依赖会标记任务失败，不能静默跳过。
- 汇总任务不读取原始聊天历史，只读取成功子任务的结构化文本与资产摘要，控制上下文长度并降低串扰。

### 失败、取消与重试

- 失败任务保存错误、工具过程和已产生资产；用户可将其重新置为队列状态。
- 取消仅取消尚未开始的任务。已经在模型或本地工具中执行的运行自然收尾，避免半途破坏工作区。
- 项目最终状态与运行状态独立记录，便于审计“某次运行”而非仅查看最后结果。

## 5. 数据存储

- SQLite：应用全局键值、资产索引等可查询元数据。
- `~/.openclawx`：Skills、工作区和资产实体文件。
- 当前项目/自动化配置采用桌面存储键持久化；后续可迁移至 SQLite 表而不改变领域模型。
