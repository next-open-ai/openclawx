# 项目手动调用工作流 · WP-V1

状态：已实现，隔离验收通过，真实模型待验收。版本 1.0；更新 2026-10-10。关联 [WC-V1](../workflow-chat-v1/README.md)、[项目编排](../../../architecture/project-orchestration.md)。

## 需求、任务与验收

- WP-R1/T1：服务端管理项目输入工具栏提供“调用工作流”，复用普通对话选择/要求/材料弹窗和卡片。运行中暂不可新调用；只读用户不显示可执行入口，API 始终独立验权。旧本地项目无服务端来源，不展示入口；隔离数据应用项目可调用独立工作流，但不传原工作区。无材料自动继承、无自动触发、无 DAG 嵌套。
- WP-R2/T2：沿用 WorkflowRuns 准备快照、托管目录、requestId 准入锁及 ProjectService/RunEngine。source 扩展为严格联合 `{kind:'chat',sessionId}` 或 `{kind:'project',projectId}`。新调用项目私有且独立；来源项目任务、状态、目录不变。输入沿用严格 WorkflowInvocationInput，不允许指定目录/来源/用户；来源从真实路由参数读取。
- WP-R3/T3：GET `/projects/:projectId/workflow-invocations`，POST `/projects/:projectId/workflows/:workflowId/invocations`，POST `/projects/:projectId/workflow-invocations/:requestId/resume`。列表要求来源可读，发起/恢复要求来源可写，沿用 org/user 的调用人隔离；共享项目不自动共享独立执行成果，也不显示其他调用人的私有调用。旧 chat/source 缺省记录兼容。相同 requestId 不可跨来源种类或项目复用；重复提交/并发恢复只调度一次，完成不重跑；失败/取消保留部分结果，恢复未完成步骤。
- WP-R4/T4：项目显示真实状态、步骤、文本节选、登记文件，可停止/恢复/进入详情；低频单飞轮询，切换来源、隐藏、卸载无旧结果串入。返回原项目用页面内导航栈，不卸载来源页面、不用持久化焦点重挂造成草稿自动启动。执行详情左上角“返回来源项目”；多次手动进入详情可逐级返回，普通对话的返回入口不变。返回只导航，不执行工作流。
- WP-R5/T5：API 用临时 JSON 存储/实际 TXT 上传/确定性 runner 验证权限、只读、跨组织、快照、材料、来源隔离、并发幂等、完成重放、失败恢复、删除来源后子项目保留与重开列表。浏览器隔离验收复用面板的项目路由、材料/错误重试、卡片与导航；同时跑 chat 回归、API/Renderer 类型构建、编排测试及并发专项。

## 边界、兼容与回滚

API 是来源关联唯一写者，项目/Run 是执行状态真相；卡片不向原项目模型自动注入结果，不自动拷贝原项目材料/成果。不授权员工调用 run_workflow，不扩展审批权限，不调用额外摘要模型。每次运行可能产生各员工模型费用。

source 新增可选联合分支，无数据迁移。旧调用保持原路由/结构。回滚 UI/路由不删除执行项目、上传文档或历史关联。共享来源的其他用户如需结果，应显式设置执行项目共享，而非继承来源权限。真实模型、麦克风、既有用户项目不纳入未确认的实测范围。

## 当前证据

- API 回归：40 通过、2 跳过，含新增 WP-T2/T3/T5 临时存储、实际文档上传和失败恢复用例；编排测试 70 通过。API 类型检查、构建通过。
- 浏览器：`WORKMATE_WORKFLOW_SOURCE=project node scripts/chat-workflow-regression.mjs` 与默认 chat 模式均通过。生产面板覆盖正确来源路由、文档解析失败/重试、启动幂等、停止恢复、结果及资产、来源切换、隐藏停轮询、390px 布局与焦点返回；服务端均为隔离替身。
- `node scripts/workflow-chat-return-regression.mjs` 通过，直接运行生产导航函数，覆盖新子项目加载、逐级返回、返回原对话、无权/缺失目标、来源切换竞态和来源删除。项目输入组件浏览器回归通过，保留文字、文档及模拟 ASR 确认。
- Renderer 类型检查和生产构建、`pnpm docs:build` 通过；构建仍有既有包体积/混合导入警告。并发专项通过（用户/全局限额、AgentScope stub 与 DSH MCP/Skill）。
- 不得将隔离测试视为真实供应商端到端验收。未调用真实模型、未访问用户既有项目、未测试真实麦克风；不实现自动调用、结果自动注入问答或嵌套 DAG。
