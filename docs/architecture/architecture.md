# Workmate 项目架构、模块与主要逻辑（当前权威）

> 状态：随实现演进维护；与 `README(.zh-CN)`、`docs/architecture/gateway-m*.md` 保持一致。
> 目标读者：新成员快速建立全局观、评审人核对模块边界与数据流。
> 2026-10-13 产品能力快照见 [`docs/current-state.md`](../current-state.md)。

## 1. 产品定位与总览

2026-10-14 工作成果只读检索：API共用成果目录服务按可信用户/组织查询归档资产元数据及私有会话关联Run；语音与Pi/AgentScope复用search_work_results/read_work_result，语音卡片继续走现有认证打开/下载。非空搜索由agent-core使用当前文字模型对最多60项候选名称及有界对话摘要做一次语义筛选（12秒截止、无重试）；关键词负责优先召回与显式降级兜底，模型只能选真实候选ID。身份从持久化Run或语音认证绑定，不作为模型参数；文件只读归档目录内有界文本/PDF，无磁盘扫描、自动重新生成或新向量库。普通工作状态可按当前会话查找，无需伪造UUID。详见[WR-v1](../sdd/features/work-result-retrieval-v1/README.md)。

当前普通项目以持续对话和固定成果目录工作，不默认规划 DAG；旧项目及显式工作流保留计划调度。任务中心提供可选模板、周期执行和结构化运行记录。数据应用使用服务端网关校验登记 SQL，前端只有无凭据 SDK；MySQL 建表草稿独立审核。详见 [数据能力平台](data-capability-platform.md)与[任务模板](task-template-pilot.md)。

文档读取统一由agent-core的readDocument服务处理，资产、聊天附件、本地知识库导入共用格式适配器及结果契约；支持现有PDF、DOCX、PPTX/PPSX、文本/HTML和表格。基础读取不调用LLM或派单，返回解析器、页数、截断、警告和明确错误/建议动作。Pi/AgentScope通过只读read_document工具读取受限工作区文档。语音桥接只转发：模型判断需要进一步处理时，显式调用通用start_work（可携带真实assetIds），由独立委托服务交付原文件副本并启动当前员工，沿用Skill授权/审批及任务状态，不重写原文件。PDF中文CMap/标准字体本地携带，桌面只带资源及许可证，不携带第二套渲染器。详见[统一文档服务UD-v1](../sdd/features/unified-document-service-v1/README.md)；取代WR-R8的PDF自动派单。

经验与查询资产独立：agent-core 经验 SQLite 记录可信来源，JSON 副本异步有界写；固定知识库只按配置阶段可用状态后台同步/预取。Pi 每轮预召回，AgentScope 按需加载，DSH 暂不接。API 查询资产仅用户明确收藏成功查询时保存，按用户/组织隔离，复用网关复核权限，不自动保存业务结果。见 [经验规格](../sdd/features/experience-local-first/README.md)与[查询资产](../sdd/features/agent-data-query-v1/query-assets.md)。

任务模板参数界面采用单一编辑入口：明确从编辑项目返回时，将最新有效 UI 同步至模板草稿，内容哈希未变则不增加 revision、不撤销验证。高级设置暂隐藏但不删除已有配置；最终验证与发布仍由用户明确操作，运行锁、权限及快照校验继续生效。详见 [任务模板架构](task-template-pilot.md)。

任务报告采用同样的独立项目编辑与返回草稿流程，但 SDK 只读取当前运行结果，不复用参数数据查询权限。模板默认输出要求可由任务覆盖，结果与报告快照随运行保存；后续模板编辑不改变历史。默认结果界面无需定制，JSON 记录始终保留。

Workmate 是**本地优先的数字员工工作台**：不是单一聊天工具，而是把「对话 / 项目编排 / Skills / 知识库 / 自动化 / 资产」组织在**数字员工**职责之下，并通过**本地通道网关**让外部 IM（Telegram/飞书）与**远程中继终端**也能调度同一套能力。

工程上最重要的三个约定：

1. **编排在服务端，UI 只是客户端**：会话、运行、审批、项目状态机都归 `@workmate/orchestrator` 所有（由 `apps/api` 进程托管），桌面渲染层与未来终端走同一组 `/api/orch` REST/SSE；
2. **域数据单写者**：domain KV 只由 api 进程写入（`~/.workmate/domain.json`）；Electron 主进程仅保留密钥与资产元数据；
3. **分层依赖单向**：renderer 不 import Electron/Node；只有 `packages/agent-core` 能调用 Vercel AI SDK；通道协议层（`@workmate/channel`）与传输实现解耦。

```text
┌────────────────────────── Electron 桌面（本地） ──────────────────────────┐
│                                                                          │
│  Vue Renderer (apps/renderer) ────────┐                                   │
│      ├─ Chat / Employees / Skills / Knowledge / Assets / Automations     │
│      └─ 远程办公·连接门户 (P1)         │  HTTP/SSE(/api/orch)             │
│                                       ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐           │
│  │ apps/api（Fastify，端口 47832，localhost）                     │           │
│  │   ├─ /api/chat        (旧 stateless 流式，兼容)               │           │
│  │   ├─ /api/orch/**     (REST + SSE)                           │           │
│  │   └─ @workmate/orchestrator   ← 编排层（唯一运行层）              │           │
│  └───────────────────────────────▲──────────────────────────────┘           │
│                                  │ /api/orch                                │
│  apps/gateway ── fork 拉起 ──────┘    @workmate/channel 协议                   │
│     Telegram 适配器 / 飞书适配器 / RelayDeviceClient(远程中继出连)             │
└────────────────────────────────────────────────────────────────────────────┘
```

## 2. 进程模型

| 进程 | 职责 | 生命周期 |
| --- | --- | --- |
| Electron Main | 窗口、IPC、sql.js（资产 + `safeStorage` 密钥）、**fork** api 与 gateway | 用户启停 |
| `apps/api`（子进程） | Fastify 服务 + orchestrator；持有 domain KV 单写者 | 由 Main fork，随桌面启停 |
| `apps/gateway`（子进程） | 通道入站/出站、白名单、把线程映射为 `/api/orch` 会话 | `channels.v1` 有启用通道时由 Main fork；可 `gateway-restart` |
| Renderer | 浏览器内 Vue | 窗口内 |
| Test Console（工程辅助） | 独立 Python 标准库本机服务；白名单启动回归/并发专项并保存日志与报告 | 由开发者执行 `pnpm quality:console` 启停，不进入产品安装运行链路 |

密钥通道：api 启动后与 gateway 启动后各自向 Main 发起 fork IPC 一次性索取解密快照（模型/搜索配置、通道 token），仅存内存。

模型连接采用统一的 Provider 结构：厂商模板定义动态凭证与端点规则，连接实例持有一组可复用凭证，服务端点按 chat/image/embedding/asr/tts/realtime 区分，模型归属连接并按能力解析端点。阿里百炼可在一个综合连接中共享凭证并派生 HTTP/WebSocket 地址；火山方舟与火山语音可拆为同厂商的多个连接；智谱使用正式 GLM 模板。旧的单 `baseUrl` 连接继续作为兼容回退。详见 `docs/sdd/features/unified-provider-connections-v1/`。

## 3. 模块与边界（apps）

| 模块 | 关键职责 | 边界/约定 |
| --- | --- | --- |
| `apps/desktop/src/main/index.cjs` | 窗口与 IPC；sql.js：`app_kv`(密钥/资产)、`settings.channels.v1`(加密凭证)、资产文件；`storage-get/set` 转发 `/api/orch/kv`；fork 管理 api/gateway；域迁移 | 不执行模型调用 |
| `apps/renderer` | 全部 UI；组合式 store（无 Pinia）；`services/api.ts`（旧流式 chat）与 `services/orchestration.ts`（/api/orch 客户端 + SSE） | 无 Node/Electron import |
| `apps/api` | HTTP 编排接口 + 域 KV 代理 + SSE 事件流 | 只 bind 127.0.0.1 |
| `apps/gateway` | 通道运行时：`GatewayRuntime`(会话映射/指令面/审批/项目)、适配器(telegram/feishu)、relay 设备链接、配置(KV 或文件) | 凭证不自持（向 Main 索取或显式文件，用于桩/CI） |

语音服务在 API 内采用独立能力边界：`voice/routes.ts` 仅为组合根，`realtime-routes.ts` 管理全双工会话，`asr-routes.ts` 管理单向语音输入，`chat-mobile/voice.ts` 管理手机令牌范围适配。会话生命周期保持隔离；实时语音的凭证、端点、模型和音色由统一 Provider/模型配置提供，通话行为仍由语音偏好管理，旧独立配置只作兼容回退。详见 `docs/sdd/features/voice-services-modularization-v1/` 与 `unified-provider-connections-v1/`。

### 渲染层「远程办公/连接」门户（P1）
侧栏 `remote` 视图提供 Telegram/飞书凭证、白名单、默认员工及网关状态/重启；主进程提供对应 IPC。Workmate 已有本地用户/组织及 admin/member 登录体系；通道白名单仍是独立的入口控制，不能视为完整的数据调用者委托授权。

## 4. 模块与边界（packages）

| 包 | 职责 | 说明 |
| --- | --- | --- |
| `contracts` | Zod 契约与 `AgentEvent` 事件并集 | 单一事实源 |
| `agent-core` | 唯一模型执行层：`ExecutionBackend` 注册表 + `streamAgentReply`（默认 **pi**，可选 **AgentScope** / **dsh** sidecar）、provider 适配、step 压缩、`summarizeSessionMemory`、Skill/MCP | 不感知会话持久化 |
| `agent-core/decision-runtime` | 可插拔有限问题决策模型、`decision_evaluate` 与工具执行前守卫；默认关闭、超时降级和短时熔断 | 不替代确定性权限规则；首个适配器为 Jev/System One |
| `tools` | `OpcaiTool{id,risk,inputSchema,execute}` + `ToolPolicy` | 契约层 |
| `orchestrator` | **编排核心**（见 §5）：含 **Session Rolling Memory** | 纯 Node，测试友好（runner 可注入） |
| `channel` | 通道协议与核心 | 传输无关 |
| `storage` / `ui-kit` | 占位 | 待接入 |

### 4.1 通用资源访问边界

`ResourceAccessPolicy` 与 `WorkspaceCapabilityKernel` 是文件访问授权的共享事实源，不通过提示文字判断是否开启。Pi 原生 read/write/edit/grep/find/ls/bash 和 AgentScope 宿主桥接统一检查：工作区按 read/write/full 权限访问；可信宿主登记的外部输入只允许逐文件读取，不扩展父目录或写权限。用户上传继续通过托管材料/附件工具提供，不接受模型自行声明路径授权。

文件校验覆盖真实路径、符号链接、新建路径祖先、悬空链接，Skill 专用路径及资产提交/大文件落盘复用检查。授权 Skill 仍通过专用工具和现有审批；数据库/API 通过已授权连接。材料不足时的业务收敛独立于权限层。

Shell 字符串检查仅拦截明显越界探查，不是任意代码沙箱，也不消除检查与使用之间的竞态。DSH 原生文件工具不经过宿主逐调用检查，本期只同步资源契约和成果提交边界；完整强隔离需独立插件或 OS 沙箱。详见 WA-V1.6。

## 5. `@workmate/orchestrator` 主要逻辑（M0 核心）

文件构成：

- `storage/{kv,memory,json-file}.ts`：`KeyValueStore` 接口 + JSON 原子落盘（可换 sql.js）；`lock.ts` per-key mutex 串行化文档级读写。
- `chat-session.ts`：会话 CRUD、消息回合（superseded 视图）、单会话单活动 run、审批决议与**续跑**；无 client context 时经 `contextResolver` 服务端组装；**Session Rolling Memory**（见 §5.1.1）。
- `session-memory.ts`：滚动摘要预算/水位线/组装与 roll 纯逻辑。
- `run-engine.ts`：一次 agent attempt 的执行与记录——结构事件持久化（tool/approval/artifact/sources/终态），`message.delta` 仅透传；审批出现则终态为 `waiting-approval`（停车）。

对话与项目已共用 RunEngine、dispatcher、事件和 RunRecord。本轮收敛统一 attempt 超时：显式 timeoutMs 优先，其次 request.runTimeoutMs，再用引擎默认值；5 秒～2 小时限制后的同一值传入模型执行层。数据项目的完成交付通过仅服务端可信的 finalizeCompleted 边界处理，交付成功/失败落定后才持久化并发布唯一 run.settled。取消、审批停车、上游异常不进入完成晋升。领域差异（对话记忆、项目 DAG、续跑与工作区策略）仍由各自服务管理，不增加第二套执行器。规格见 [统一 attempt 第二期](../sdd/features/unified-attempt-v1/README.md)。
- `project.ts` / `project-plan.ts`：项目 **Plan/Run/ChangeSet** 状态机与统一 DAG 调度器（strategy 仅建边与并发）、任务级审批停车、增量指令失效、成员 replan merge、取消/重试、协调汇总；并发写由 mutex 保护。
- `types.ts` / `events.ts` / `hub.ts`：规范记录、统一 OrcEvent、进程内发布订阅（供 SSE）。
- `runner.ts`/`echo-runner.ts`：真实 agent-core runner 与无网确定性 runner（验收/冒烟用）。

### 5.1 会话与“可续跑 run”

```
客户端/通道 POST /api/orch/sessions/:id/messages {content}   （context 可省）
  → ChatSessionService.sendUserMessage
      → 服务端组装上下文（KV 员工/技能/偏好 + keyring 模型/搜索）
      → requestForTurn：注入 session.memory.summary + 未覆盖原文（或全量历史）
      → RunEngine.execute：工具审批 → 事件流出（SSE）→ 终态 waiting-approval
  → settleRun：写回 transcript；阈值滚动摘要；标记 dirty
  → /approvals/:id/resolve {allow, scope?}
      → engine 记录决议、写入 grants → 自动续跑同 turn 新 attempt
  → 会话/运行记录持久化（重启可恢复、桌面与网关同源）
  → 切换会话时 POST /sessions/:id/memory/flush（桌面离开钩子）
```

#### 5.1.1 Session Rolling Memory（会话级滚动记忆）

长对话的**本会话**连续性，不是跨会话用户画像。

| 原则 | 说明 |
| --- | --- |
| 真相源 | `ChatSession.messages` 始终完整保留；summary **从不**替代 transcript |
| 派生状态 | `memory.{summary, coveredUntilId, updatedAt, dirty}` 挂在同一 session 记录上（domain KV） |
| 打开/续聊 | 有摘要时模型只看到 summary 注入块 + 水位线之后的原文；UI 仍可展示全文 |
| 阈值滚动 | `summary + 未覆盖原文` ≳ 24k 字符 → LLM 摘要旧段、推进 `coveredUntilId`、保留最近 ~8 条原文 |
| Flush | 桌面 `startChat` / `selectConversation` 离开时调用 flush；强制折叠超出最近窗口的增量并清 `dirty` |
| 与 step compaction 关系 | `agent-core` 的 `prepareStep` 只压缩**当次 run**；会话记忆跨重开、跨多次 run |

实现入口：`packages/orchestrator/src/session-memory.ts`、`packages/orchestrator/README.md`。
桌面普通对话在 Electron 内自动走该路径（双模式；协作者等旧特性降级保留）；`message.delta` 对 IM/网关当前采用**终态轮询回传**（确定性），SSE 直播列入后续迭代。

### 5.1.2 项目双工作区与交付物晋升

项目执行刻意拆成两层目录：

| 层 | 路径 | 可见性 | 用途 |
| --- | --- | --- | --- |
| Run workspace | `~/.workmate/workspaces/<runId>/` | 不对用户文件树展示 | 过程脚本、`.py`/`.sh`、临时生成器 |
| Project workspace | `~/.workmate/projects/<name>-<id>/` | 左侧「项目文件」树 | 最终交付（HTML/CSS/JS/文案/图片…） |

规则：

1. 工具默认只写 run workspace（`write_workspace_file` / `run_workspace_script`）。
2. 普通项目任务请求兼容注入 `projectWorkspacePath` + 与编排层一致的 `runId`；数据应用专属项目设置 `executionWorkspaceMode: isolated`，执行请求不携带固定项目写目录，文件晋升由 RunEngine 完成交付边界驱动。
3. 普通项目推荐在交付就绪时调用 `publish_to_project` 即时晋升；agent-core 正常结束也会晋升。隔离数据项目由服务端 finalizeCompleted 晋升，晋升失败则 Run 失败，不先广播完成再修正。晋升使用 `promoteWorkspaceDeliverablesToProject`；过程脚本（`.py`/`.sh`、`tools/`/`scripts/`/`tmp/`）拒绝晋升。
4. 客户端仅对已结束任务按 `runId` 做 deliverable sync 恢复，同一用户/root/run 单飞并短时去重；运行中依赖发布事件，文件树自动刷新不重复恢复。若编排 `runId` 与 agent 实际工作区目录曾不一致，会从 `RunRecord.eventLog` 解析真实 workspace id。sync 的 `cpSync` filter **必须允许目录遍历**，否则根目录/子目录一旦返回 false 会整树跳过。
5. 事件：`project.file.published` → UI 刷新文件树。

实现：`packages/agent-core/src/skill-runtime.ts`（`publish_to_project` / auto-promote）、`packages/orchestrator/src/project.ts`（注入路径）、`apps/desktop/.../index.cjs`（sync）、`apps/renderer/.../ProjectConversationWorkspace.vue`。

普通对话和项目共用 RunEngine 的失败真相：模型层输出可选规范化 `failure`（分类码、阶段、耗时、HTTP 状态/传输码），编排层保存在 RunRecord 并通过 run.settled 传播。只保留允许的错误特征，不保存任意上游响应体、凭据或 Prompt；连接中断不直接归因为用户网络。项目终态读取完整运行记录，即使已有 SSE 文本也要补齐错误诊断。详见 `docs/sdd/features/run-diagnostics-v1/`。

### 5.1.3 多 session / 多用户并发治理

当前单机并发治理采用“两层调度”：

1. `InMemoryExecutionDispatcher` 负责会话串行、全局/单用户容量限制、显式等待队列、排队超时，以及 `chat` 高优先级与 `project-task` 普通优先级的防饥饿调度；
2. `agent-core` 中的 AgentScope sidecar pool 负责 Python 进程级分流、单实例容量限制、异常摘除、冷却恢复、自动补位、平滑缩容，以及 `startRun` 阶段失败时的一次安全切换重试。

隔离键当前已覆盖：

- `orgId`
- `userId`
- `sessionId`
- `runId`

运行时观测入口：

- `GET /api/runtime/status`
- `GET /api/runtime/status/stream`
- 设置页 `通用 -> 运行时并发状态`

详细说明见：

- `docs/architecture/concurrency-runtime.md`
- `docs/architecture/concurrency-verification.md`

### 5.2 项目编排：Plan / Run / ChangeSet（P0–P1）

新建普通项目已轻量化为 `kind: conversation`：创建不调用模型或规划 DAG，发送消息才产生独立 Run。固定成果目录跨轮复用，隔离工作区成功后晋升，失败/取消保留已有成果；需要协作时显式调用独立工作流。旧项目、工作流执行与既有数据应用项目保留以下 DAG 规则，不迁移历史。详见 [LP-V1](../sdd/features/lightweight-project-v1/README.md)。

持续对话项目另有显式本地静态应用发布：预览不可变快照，确认后切换 API 所有的发布指针，后续 Run 不自动覆盖；临时只读票据与隔离页面不携带登录凭据。此能力不执行服务器程序，不代替数据应用或公网部署，详见 [PA-V1](../sdd/features/project-application-v1/README.md)。

数据应用关联的项目复用该快照预览，但注入无凭据数据 SDK，由已登录可信宿主调用数据网关，与数据应用发布页共用操作协议；普通静态项目不开放数据能力。AI 可直接生成参数化 SQL，网关 AST 校验后测试登记；写入定义必须经用户批准并明确开启对象写入，模型工具不执行实际写入。详见 [MDA-SQL](../sdd/features/managed-data-app-v1/sql-operations.md)。

当前已批准的新增/修改/删除由页面直接提交，不逐次弹平台确认；网关仍每次鉴权、核对对象写入及定义版本。数据测试界面确认独立保留；MySQL 新业务表使用独立结构开关及审核，不混入 CRUD 授权。

项目调度从「整表重写任务列表」升级为**版本化计划 + 增量失效 + 统一 DAG 执行**：

```text
Goal
  → Coordinator / 模板 产出 Plan v1（tasks + DAG edges + 可选 contract）
  → 人确认 → 打开 ProjectRun（绑定 planVersion）
  → Scheduler 始终按 DAG：dependsOn 满足才就绪；mode 只决定并发度与「如何生成边」
  → 用户 @员工 发指令 → ChangeSet(instruction)
        · 目标任务 append 指令并标 stale
        · 下游依赖级联 stale（上游 completed 保留）
        · 新开 Run，只重跑 stale/失败节点
  → 成员增删 → Plan vN+1（replan）
        · merge：尽量保留可复用的 completed 节点
        · 移除节点 → superseded（历史保留，不参与调度）
```

| 概念 | 说明 |
| --- | --- |
| **Plan** | `project.plan`（version / strategy / taskIds）；`planHistory` 仅存元数据 |
| **Run** | `ProjectRun` 一次执行实例，携带 `planVersion` / 可选 `changeSetId` |
| **ChangeSet** | 增量变更记录（instruction / replan / invalidate），写入 `project.changeSets` |
| **stale** | 因上游或指令失效、需重跑；不等于删除 |
| **superseded** | 已退出当前 Plan，仅作历史 |
| **contract** | 可选任务契约：`outputs` / `acceptance` / `timeoutMs` / `maxAttempts` |

**统一 DAG**：`waterfall` / `discussion` 在建图时物化为线性 `dependsOn`；`parallel` 无边；`dag` 使用显式边。运行时 `drain` 只走依赖就绪集；策略控制并发。调度为 **P2 混合事件驱动**：就绪批次 await 完成，审批停车靠 `notifySchedule` 唤醒。任务 attempt 带 **P3 idempotency key**（`lastAttemptKey`）。

新建时协作模板为**偏好**：协调员两阶段规划（结构→目标）；图形态与偏好不符时弹窗建议切换（见 `project-orchestration.md`）。

API：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| confirm | `POST /projects/:id/confirm` | 打开 Run；completed/superseded 跳过，其余入队 |
| instructions | `POST /projects/:id/instructions` | ChangeSet + 级联 stale + confirm |
| replan | `POST /projects/:id/replan` | Plan vN+1 merge + 依赖校验 |

实现：`packages/orchestrator/src/project-plan.ts`、`project.ts`；桌面镜像见 `apps/renderer/.../ProjectsPage.vue`。

### 5.2.1 项目调度（执行环）

```
创建(本地生成草案/模板) → POST /api/orch/projects(draft, Plan v1)
→ confirm {}（服务端按任务员工组装模型/Skills/权限档）
→ ProjectService.runScheduler/drain：
    DAG 依赖解析、策略并发、任务级审批 park、
    取消(abort+队列标记)、失败重试(contract.maxAttempts)、完成汇总
→ 任务 transcript、项目 runs、SSE project 主题事件（桌面轮询/订阅镜像）
```

> 旧称「按 mode 分支串行/并行两套调度」已废弃；mode 只影响建图与并发。
### 5.3 域存储与密钥（单写者 + keyring）

数据库密码的 IPC 和桌面开发模式共用主进程 safeStorage 密文存储。开发 supervisor 独立启动 API 时，经主进程 loopback 随机端口及运行期 capability 通道按需读取/写入，描述符仅允许内部桌面身份注册且不落盘；断桥不降级明文或临时内存。纯 Node API（无桌面）仍只有会话密码。详见 LDO-R8，所有域元数据仍由 API 单写，主进程仅写密文。

- Main 的 `storage-get/set` → 转发 `/api/orch/kv`（失败降级旧 sql.js）；启动时一次性迁移旧域键（跳过密钥键）。
- 模型/搜索/通道 token：Main sql.js + `safeStorage`；经 fork IPC（`workmate:secrets` / `workmate:channels:secrets`）一次性下发给子进程，绝不落盘 domain.json。

## 6. 通道与远程办公（M1/M2）

协议层 `packages/channel`：`UnifiedMessage / UnifiedReply / StreamSink / IChannel / IInboundTransport / IOutboundTransport`；`registry`（注册/分发/启停）；`core.handleChannelMessage`：授权 → 优先 `sendStream` 占位+累积（节流），否则整段收集一次发送。

`apps/gateway`：`GatewayRuntime.process` 把「通道:线程」映射为服务端会话；文本指令面：`/chat /employee /pending /approve|deny <id> /projects /project <id>|start|cancel`；白名单规则 `channel:user/chat[:user]`（默认拒绝）。

| 适配器/通道 | 入站 | 出站 | 状态 |
| --- | --- | --- | --- |
| Telegram | 长轮询 getUpdates | sendMessage / editMessageText 流式 | 代码+桩验收；真机待凭证 |
| 飞书 Feishu | WS 长连接 `im.message.receive_v1`（去重） | text / interactive 卡片 create→patch 流式 | 代码+桩验收；真机待凭证 |
| 远程中继 Relay | 中继服务器转发请求 | 信封 `request/response/event` | 最小实现+桩验收；公网部署待做 |

中继协议（`apps/gateway/src/relay/*`）：设备 `hello` 注册、`params.deviceId` 路由、`device.ping` 心跳直答、响应回路由；`RelayDeviceClient` 主动出连（心跳/指数退避重连），请求 `message {text}` 复用 `GatewayRuntime` 指令面。

## 7. 构建 / 发布

- 包顺序（根与 desktop 的 build 脚本）：contracts → tools → storage → **channel → gateway** → agent-core → orchestrator → api → renderer。
- dev：`apps/desktop/scripts/dev.mjs` 串行构建依赖后起 Vite + Electron（main/preload 变更才重启 Electron）。
- 发布 CI（`release.yml`）：macOS arm64(macos-14)、macOS Intel x64(macos-13)、Windows x64 三个原生 runner → dmg/dmg/exe；publish 校验恰 3 个安装包并生成 SHA-256。
- 无头验收脚本：`scripts/headless-gateway-smoke.mjs`、`remote-project-confirm.mjs`、`remote-chat.mjs`、`gateway-stub-smoke.mjs`、`gateway-feishu-smoke.mjs`、`relay-smoke.mjs`。

## 8. 验收与状态

| 里程碑 | 交付 | 验收证据 |
| --- | --- | --- |
| M0 编排层 | orchestrator + /api/orch + 域单写者 + 可续跑审批 | 单测 11/11；HTTP/远程冒烟 ALL PASS；桌面项目/会话接入（编译级） |
| M1 网关+Telegram | channel 协议 + gateway + Telegram/白名单 | channel 4/4；gateway-stub ALL PASS |
| M2 门户/飞书/中继 | IPC 凭证链路 + 远程办公页(P1) + 飞书 + relay | feishu/relay 桩验收 ALL PASS；typecheck/build 全绿 |

细节与真机人工步骤见各里程碑文档。

## 9. 已知限制与后续

- 网关对 IM/中继的会话回复目前为**确定性轮询取终态**；SSE 直播（先订后发问题）待迭代。
- 中继为**纯转发最小实现**：无订阅/广播/离线队列；外部终端 Web 控制台与设备配对 UI 待做。
- `packages/storage`、`packages/ui-kit` 仍为占位；部分旧文档（`docs/architecture/overview.md`、`docs/sdd/*`）为早期描述，以本文档与 `docs/architecture/*` 为准。
- 本地用户/组织身份已实现；跨用户数据委托、服务账号及企业级行列权限不在当前首期范围，通道白名单不能代替它们。
