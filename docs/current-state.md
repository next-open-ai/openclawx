# Workmate 当前功能状态

> 实现快照日期：2026-10-13
> 口径：以当前工作区实现、功能 SDD 和已执行回归为准；“已实现”不自动等于真实 Provider、真实设备或安装包验收完成。

## 当前产品能力

| 能力域 | 当前状态 | 事实源 |
| --- | --- | --- |
| 对话与数字员工 | 服务端会话、滚动记忆、工具审批、资产交付和员工权限已接入 | [全局架构](architecture/architecture.md) |
| 持续任务 | 复杂任务可保存源文件、检查点和工作区，跨 run 恢复；完成后自动收敛，清空消息不等于删除 Session | [持续任务 SDD](sdd/features/conversation-durable-task/README.md) |
| 应用模型 | 图片生成/理解、Embedding、ASR、TTS、量子代码、决策和本体语义匹配统一按能力注册；Provider 使用“厂商模板→连接→服务端点→模型”，阿里/火山/智谱支持服务化自动端点；员工端使用一个总开关 | [应用模型 SDD](sdd/features/application-model-capabilities/README.md) · [统一 Provider](sdd/features/unified-provider-connections-v1/requirements.md) |
| 决策守卫 | 决策模型纳入应用模型管理，可用于工具执行前守卫和主模型按需调用；默认关闭、超时降级并支持扩展其他决策模型 | [决策运行时](sdd/features/decision-runtime/jev-decision-runtime.md) |
| 知识库与本体 | 普通文档解析后可生成候选本体；支持引导、审核、发布、两跳图查询、语义实体链接及 `kb_search` 增强检索 | [本体 RAG 状态](sdd/features/ontology-rag-phase-1/status.md) |
| 实时语音 | 桌面实时对话与独立 ASR 已模块化；实时凭证、模型、音色和端点统一归入 Provider/模型；运行时通过可扩展适配器支持火山 SeedDuplex 与阿里 Qwen Audio/Omni Realtime、Function Calling 工作桥、简短完成播报、5 秒长静音 mute 和旧配置回退 | [实时语音状态](sdd/features/realtime-voice-v1/status.md) |
| 手机对话 | 提供 HTTP 文字/文件快捷入口和 HTTPS 安全语音入口；TLS 前置只暴露手机对话路径 | [手机语音](sdd/features/realtime-voice-v1/mobile-voice.md) |
| 轻量项目与工作流 | 普通项目不自动调用 AI/规划 DAG；选中员工多轮执行，固定成果目录；显式调用独立工作流，支持来源返回及恢复 | [轻量项目](sdd/features/lightweight-project-v1/README.md) · [项目编排](architecture/project-orchestration.md) |
| 任务中心与模板 | 直接/模板创建；手动/一次/间隔/日/周/月执行；独立模板弹窗，可选参数 UI 与报告编辑，json-result 留存 | [任务模板架构](architecture/task-template-pilot.md) |
| 数据对象与网关 | MySQL/PostgreSQL 实时对象默认只读、按对象开启写入；保留本地副本；结构化聚合、日期桶、HAVING、Top N、登记关系 JOIN 及条件聚合 | [实时对象](sdd/features/live-data-objects-v1/README.md) · [关联查询](sdd/features/structured-data-query-v2/README.md) |
| 数据应用与大厅 | 默认整个对象，Schema 优先，AI 参数化 SQL 经网关校验登记；预览使用当前身份；写 SQL 审核后直接提交；MySQL 建表草稿独立审核；品牌图标打开已发布数据应用大厅 | [SQL/预览/写入/建表](sdd/features/managed-data-app-v1/sql-operations.md) |
| 员工问数与可信查询资产 | Pi/AgentScope 按员工关联对象只读问数，普通问数仍用结构化查询；仅用户明确要求才收藏成功查询，运行复核权限与 Schema | [员工问数](sdd/features/agent-data-query-v1/README.md) · [查询资产](sdd/features/agent-data-query-v1/query-assets.md) |
| 经验记忆 | 不依赖 Embedding；本地 SQLite 为事实源、JSON 副本异步有界写；组织内共享且记录来源；知识库仅配置验证可用后后台同步/语义预取 | [经验规格](sdd/features/experience-local-first/README.md) · [验证证据](sdd/features/experience-local-first/status.md) |
| 测试网站 | 独立本机质量控制台可运行白名单回归、并发专项并保存日志/报告，默认端口 `47840` | [测试控制台 SDD](sdd/features/test-console-v1/requirements.md) |

## 运行与端口

| 服务 | 默认地址 | 说明 |
| --- | --- | --- |
| Renderer 开发界面 | `127.0.0.1:47831` | 避开常见的 `5173` |
| Workmate API | `127.0.0.1:47832` | Desktop、Web launcher 与 Gateway 共用正式 API |
| 手机 HTTPS 前置 | 独立可配置端口 | 仅代理 `/api/chat-mobile/`，不暴露管理接口 |
| 测试控制台 | `127.0.0.1:47840` | `pnpm quality:console` 启动 |

默认数据目录为 `~/.workmate`。端口可由对应环境变量覆盖，但客户端、代理和测试目标必须同步。

## 已知验收边界

- Provider mock、类型检查和构建通过不代表所有第三方模型账号、地域、额度和内容安全策略已经真实验收。
- 实时语音具备真实服务握手证据，但不同麦克风、手机浏览器、证书信任和弱网仍需目标设备人工验收。
- 本体增强已进入默认 `kb_search` 链路，但细粒度知识权限、稳定文档版本绑定和真实业务数据集评测仍需继续完善。
- 测试控制台仅面向本机工程测试，不是生产多用户测试平台，也不开放远程命令执行。

新增能力边界：DSH 尚未接入数据问数及经验工具；AgentScope 经验按需加载，Pi 另有每轮预召回。普通问数不是连接级任意 SQL；SQL 应用暂不支持跨连接、批量写入、子查询/CTE/UNION。建表只支持 MySQL 新 InnoDB 表/索引，不支持旧表 ALTER/DROP。

应用 SQL 审核后不逐次弹平台确认，服务端权限及对象写入开关仍每次检查；数据测试界面保留自身确认。未知提交结果不自动重试；事务试写回滚不保证自增号或外部副作用还原。应用大厅只收录已发布可交付数据应用，不包括普通项目静态快照；链接/二维码不授予数据权限、不自动公网部署。

本次文档同步未使用真实模型、业务库或发布用户应用。历史分阶段测试记录保留当时口径，不代表所有新增能力已在安装包中通过完整端到端验收。

## 同步规则

功能变化时依次更新：功能 SDD → 本页 → 产品/架构/质量索引 → 用户手册 → 应用内手册派生文件。历史交付快照和 Archive 不回写为当前状态。
