# WP-V1 需求追踪

| 需求/任务 | 实现 | 验证 |
|---|---|---|
| WP-R1/T1 | ProjectComposer 工具插槽；ProjectConversationWorkspace 入口与权限提示；共用 ChatWorkflowPanel | chat-workflow-regression 项目/对话双模式；project-composer-regression |
| WP-R2/T2 | workflowInvocationSourceSchema；WorkflowRuns 快照与独立目录；项目来源路由 | workflow-runs.test WP 用例；contracts/API 类型检查 |
| WP-R3/T3 | org/user 登记隔离；来源读写校验；同一准入锁与恢复接口 | WP API 权限、并发、来源冲突、失败恢复、存储重开测试 |
| WP-R4/T4 | 生产面板历史/状态/成果；ProjectsPage 页面内来源导航栈 | 双模式浏览器；workflow-chat-return-regression 实际导航函数 |
| WP-R5/T5 | 临时 JSON、实际 TXT 上传、确定性 runner 与浏览器 HTTP 替身 | API 40 通过/2 跳过；编排 70 通过；并发专项；API/Renderer 类型构建；文档构建 |

全部测试均未将真实模型成功率或用户实际项目执行作为通过条件。
