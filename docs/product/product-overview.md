# OpenClawX 产品总览

> 状态：当前总览  
> 更新日期：2026-10-13

## 产品定位

OpenClawX 是本地优先的数字员工与 Agent 工作台，统一组织对话、持续任务、数字员工、应用模型、Skills、MCP/工具、知识库与本体、项目编排、自动化、资产和多运行时，并通过桌面、Web/API、实时语音、手机网页和消息通道提供一致能力。

## 核心用户价值

1. 安全配置和使用多个模型服务；
2. 以职责、Skill、知识和权限组织数字员工；
3. 通过受控工具完成对话和项目任务并产出可追踪资产；
4. 对高影响动作执行权限、审批、审计和回滚；
5. 统一编排本地运行时、Sidecar、MCP 和外部模型；
6. 让需求、设计、实现、测试、评测和发布可追溯。

## 能力地图

| 能力域 | 用户入口 | 详细说明 |
| --- | --- | --- |
| 对话与会话记忆 | Chat/Workspace | [全局架构](../architecture/architecture.md) |
| 持续任务与跨 run 恢复 | 源文件、检查点、工作区、自动完成收敛 | [持续任务 SDD](../sdd/features/conversation-durable-task/README.md) |
| 数字员工与能力授权 | Employees/Capabilities | [历史需求归档](../archive/legacy-global-sdd/requirements.md) |
| 项目与工作流 | 普通项目持续对话、固定成果目录；显式调用工作流，旧 DAG 保留 | [项目编排](../architecture/project-orchestration.md) |
| 模型与 Provider | 多 Provider、应用模型、Embedding、决策守卫 | [应用模型 SDD](../sdd/features/application-model-capabilities/README.md) |
| Skills、Tools、MCP | 渐进加载、审批和 MCP 桥 | [全局架构](../architecture/architecture.md) |
| 知识库、本体和数据能力 | 文档解析、Embedding、本体构建与增强检索 | [本体 RAG](../sdd/features/ontology-rag-phase-1/README.md) |
| 任务中心 | 直接/模板创建、定时周期、可选参数界面与报告、json-result | [任务模板](../architecture/task-template-pilot.md) |
| 数据工作台与应用 | 实时连接/本地副本、聚合/JOIN、SQL 应用、写操作审核、MySQL 新表、应用大厅 | [数据能力平台](../architecture/data-capability-platform.md) |
| 查询资产与经验 | 用户明确收藏成功查询；简短经验卡本地优先、异步副本、可选后台知识库同步 | [查询资产](../sdd/features/agent-data-query-v1/query-assets.md) · [经验](../sdd/features/experience-local-first/README.md) |
| 通道与远程入口 | Gateway、Telegram、飞书、Relay | [Gateway 设计](../architecture/gateway-m1.md) |
| 实时语音与手机对话 | 桌面实时/ASR、工作桥、HTTP/HTTPS 手机入口 | [实时语音 SDD](../sdd/features/realtime-voice-v1/status.md) |
| 多运行时 | pi、AgentScope、dsh | [执行后端](../architecture/execution-backend.md) |
| 工程质量 | 独立测试控制台、白名单回归、日志与报告 | [测试控制台 SDD](../sdd/features/test-console-v1/requirements.md) |

项目级需求见 [需求总览](requirements-overview.md)。
