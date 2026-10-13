# 普通对话手动调用工作流 · WC-V1

状态：第一阶段已实现，隔离验收通过，真实模型待验收。项目显式调用继续在 [WP-V1](../workflow-project-v1/README.md) 中推进，员工工具自动调用尚未开放。复用 WorkflowRuns / ProjectService / RunEngine，不新增执行状态机、不修改其他子项目。

## 需求 / 任务 / 验收追踪

- WC-R8/T8：从普通对话打开工作流执行项目时，左上角显示“返回对话工作台”，返回原对话而非项目列表；从资产/工作流/项目列表进入仍保持“项目列表”。返回来源仅当前导航内存保存，并校验用户、目标项目和原对话仍存在；切换用户或离开项目页清除。原对话被删除则回到对话工作台，不恢复已删除记录；不改变工作流执行状态或持久化。

- WC-R7/T7：输入区工具栏按输入工具、协作功能、模型与发送分组；同组控件等高且文字不被压缩换行。根据输入区实际宽度自适应：空间不足时模型与发送整组换到下一行并靠右，不将模型孤立在左侧；小屏选择器可收缩，发送按钮保持尺寸。移除占用工具栏的冗长附件提示，保留附件菜单说明。不改变发送、语音、工作流及协作行为。浏览器覆盖宽/中/窄输入区、长模型名称及菜单。

- WC-R6/T6：调用入口置于普通对话输入框底部工具栏、“添加协作者”旁，不在输入框上方重复展示按钮或保留空白栏。记录仍在原面板显示；按钮沿用准备/执行禁用态，关闭弹窗回到工具栏触发按钮。仅调整 renderer 布局，不改变执行接口、权限或持久化。验收覆盖入口位置、唯一性、弹窗打开/关闭及既有调用回归。

- WC-R1/T1：普通对话提供“调用工作流”入口，可搜索本人已保存定义，展示步骤及员工数量；选择后填写本次要求或上传文档。明确沿用各员工模型、授权与审批并可能产生费用；不将普通对话的模型覆盖、自动调度或协作者隐式传给工作流。
- WC-R2/T2：contracts 定义手动调用输入（requestId、input、fileIds），来源使用路由中的真实 sessionId，不接受调用方目录。POST `/sessions/:sessionId/workflows/:workflowId/invocations` 在服务端创建独立托管目录、复用工作流快照物化，并仅在项目 draft 时确认。requestId 与来源、定义、输入和文档共同校验，重复提交不重跑已完成项目；中断可重试同一准备记录。启动失败仍可在原调用卡片恢复，不悄悄创建第二个项目。
- WC-R3/T3：GET `/sessions/:sessionId/workflow-invocations` 返回本人来源关联和真实项目摘要；重开对话可恢复卡片。读写分别校验来源会话权限，执行项目仍为调用人私有。不得用请求指定其他用户、组织或目录；文档作用域沿用 org/user/workflow/request。旧工作流记录 source 缺省，不按名称猜测关联，无迁移。
- WC-R4/T4：卡片显示定义快照名称、本次要求、材料、步骤数、真实状态/错误、已登记资产、实际终端节点文本节选；只读投影，不凭模型措辞判断完成。失败/取消保留成果。停止只取消关联项目，恢复仅未完成节点；POST `/sessions/:sessionId/workflow-invocations/:requestId/resume` 与启动共用准入锁，已运行或完成时只返回原关联，旧 draft 卡片不触发全量重跑。重试错误保留输入，发送成功才重置。查看完整结果/审批/继续修改进入同一执行项目，不误将普通对话追问当作重跑。
- WC-R5/T5：列表单飞刷新；运行/审批中低频刷新，隐藏/卸载停止；启动后立即刷新，读取错误显示上次结果未更新和重试入口。运行期间可继续普通对话；不将工作流伪装为普通聊天 activeRun。调用弹窗具有标签、焦点循环/Escape、加载/空态/错误态和移动端溢出边界。

## 契约与兼容

WorkflowExecutionInput/ExecutionLink 增加可选 source `{ kind: 'chat', sessionId }`；调用接口使用不含目录/source 的独立严格输入。摘要新增可选 resultText，取最新真实叶节点 Run 文本并有界截断；成果增加可选 runId，用户点击查看/下载时复用既有幂等归档接口（index.html 为 SITE bundle），不扫描目录、不把登记文件伪称已归档资产。归档失败单独提示且不改任务终态。无需额外模型摘要调用。API 是关联元数据唯一写者，项目/Run 是运行真相源。用户删除会话后不级联删除项目或文件，失去来源读权限则不能通过来源接口访问；项目仍可按原权限单独查看。

无数据迁移；回滚 UI/路由保留已建项目、材料和关联。自动调用、项目嵌套、递归、独立只读结果问答、应用专用卡片、精准费用预估和全双工语音触发不在本阶段；用户通过执行项目继续协作。

## 验证计划

WC-T2/T3/T4：隔离 Fastify + 临时目录 + 确定性 runner 验证来源权限、跨组织、严格输入、并发重试单项目/单调度、快照不变、文档真实落盘、真实结果/失败/取消保留、关联读取重开、删除项目不可复活。WC-T1/T5：隔离 Vue 浏览器验证选择/搜索、文档失败禁用、成功卡片、重试保留、切换对话不串数据、显示错误与结果入口。Contracts 构建、API/Orchestrator 测试、Renderer/API 类型/构建、并发专项。禁止自动调用真实付费模型或重跑用户项目。

## 第一阶段验收记录 · 2026-10-10

后续成果问答已按 [WQ-V1](../workflow-result-qa-v1/README.md) 实现：下文第一阶段“追问不关联上下文”描述仅指默认普通对话；用户明确点击「基于成果提问」后进入独立纯文本问答模式，不修改或重跑项目。

- WC-T2/T3/T4：`pnpm --filter @workmate/api test` 39 通过、0 失败、2 个既有外部数据库环境用例跳过。新增 workflow-runs.test.ts 两项，使用临时 domain.json 实际关闭/重开、TXT 真实上传解析落盘及确定性 runner，验证并发请求一次调度、来源隔离、来源/输入冲突、定义快照不变、严格参数拒绝目录/source 注入、启动中断重试、失败恢复、取消保留登记成果、项目删除不可复活。摘要是实际 Run 文本；模拟成果登记不等于验证真实 PDF 质量。
- WC-T1/T5：`WORKMATE_BROWSER_CHANNEL=chrome WORKMATE_PLAYWRIGHT_MODULE=<本机已有模块路径> node scripts/chat-workflow-regression.mjs` 通过。使用生产 Vue 组件及本机 HTTP 桩：搜索/选择、解析失败禁用与重试、提交失败锁定同一 requestId/要求/文档、停止/恢复、全文入口、登记文件按真实 runId/path 调用既有归档接口、成果卡片、读取失败保留记录、旧请求不串入新对话、隐藏停止刷新和 390px 布局。归档/浏览内容由桩返回，不宣称真实归档文件已验收。
- 验收发现并修复弹窗初始焦点落在随后禁用的搜索框，导致 Escape 失效；固定焦点进入关闭按钮。单飞读取中启动结束会排队补刷，避免较早的空列表响应让新调用卡片消失；浏览器覆盖延迟首轮读取与提交交错。
- `pnpm --filter @workmate/contracts build`、API 类型检查/构建、Renderer 类型检查/构建通过；`pnpm --filter @workmate/orchestrator test` 70/70、`pnpm concurrency:regression`、`node scripts/workflow-algorithm-regression.mjs`、`node scripts/project-live-state-regression.mjs`、`node --check scripts/chat-workflow-regression.mjs`、`git diff --check` 通过。构建保留既有混合导入和大 chunk 告警。
- agent-browser CLI 不可用，按技能回退至本机已有 Playwright 与独立 Chrome；未安装依赖、未访问用户浏览器资料/密钥、未调用真实模型、未重跑用户项目或修改用户 domain.json。仅 Workmate 变更，无迁移；新增可选字段兼容旧调用，回滚代码不删除材料或成果。
- 后续顺序不变：项目内显式调用 → 明确只读结果问答/修改语义 → 员工工具自动调用。本轮普通对话继续输入不会自动注入工作流结果，也不会自动重跑；通过“查看详情 / 继续协作”进入原项目。卡片按约 3 秒低频轮询，不宣称毫秒级推送；专用数据应用卡片与真实模型端到端验收仍待后续。

### WC-T6 入口布局调整 · 2026-10-10

入口移至输入框底部工具栏、“添加协作者”左侧，面板隐藏原触发按钮，空态不保留按钮栏。`scripts/chat-workflow-regression.mjs` 校验生产 ChatWorkspace 入口位置和面板参数，并通过隔离 Vue 工具栏验证唯一入口、打开弹窗、Escape 焦点返回、390px 无溢出及既有调用全流程。测试通过；未调用真实模型。API、运行状态和存储不变，无迁移；回滚仅恢复入口布局。

`pnpm --filter @workmate/renderer build`（含 vue-tsc）通过，保留既有混合导入与大 chunk 告警；`node --check scripts/chat-workflow-regression.mjs`、`git diff --check` 通过。浏览器技能因本机无 agent-browser CLI，回退已有 Playwright/独立 Chrome。此次只验收 renderer 布局与隔离交互，未重跑真实业务任务。

### WC-T7 输入框工具栏整理 · 2026-10-10

使用输入区容器宽度而非整个窗口宽度控制布局，语音/附件为输入工具组，模型/发送为固定操作组；窄输入区整组换行且靠右。统一 36px 控件高度、10px 圆角与间距，长模型名截断；移除工具栏冗长提示，附件说明仍在菜单中。窄屏菜单锚定输入框，避免超出视口。发送/停止补齐无障碍名称，不改变执行行为。

`scripts/chat-composer-layout-regression.mjs` 从生产 ChatWorkspace 抽取工具栏模板和 scoped CSS，以隔离 Vue 状态验证 1500/1100/850/600/390/320px、长模型名、模型/发送对齐、菜单无溢出与执行中禁用状态，全部通过。独立 Chrome 截图已检查宽/中/窄布局；`scripts/chat-workflow-regression.mjs` 既有调用全流程通过。首次布局测试的断点预期错误（使用视口而非输入容器宽度）已按实际容器宽度修正；执行态检查发现停止按钮缺少无障碍名称，已补充并复测通过。未调用真实模型或业务任务，无 API/存储修改和迁移。

最终 `pnpm --filter @workmate/renderer build`（含 vue-tsc）、`node --check scripts/chat-composer-layout-regression.mjs` 和 `git diff --check` 通过。构建保留既有混合导入、大 chunk 告警。回滚只需恢复输入框模板/CSS，无后端或数据回滚要求。

### WC-T8 详情返回原对话 · 2026-10-10

App 为普通对话打开项目单独保存内存来源（用户/对话/项目），ProjectsPage 仅对匹配项目传递返回文案和事件；ProjectConversationWorkspace 默认仍返回项目列表。返回时校验原对话存在，不恢复已删除记录；离开项目页、用户变化及非对话入口清除来源。重载应用不持久化返回来源；执行记录与权限不变，无迁移。

`node scripts/workflow-chat-return-regression.mjs` 通过：执行从生产 App 抽取的导航函数，验证返回原对话、原对话被删除、非对话入口、项目/用户隔离、离开/登出清理，并校验组件事件/默认文案接线。`node scripts/project-sharing-regression.mjs`、`pnpm --filter @workmate/renderer build`（含 vue-tsc）、`git diff --check` 通过。构建保留既有告警；本轮未进行真实桌面点击或业务任务执行。回滚只恢复 renderer 导航与文案，不删除项目/对话。
