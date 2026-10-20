# OpenClawX 通道网关 · M0 设计与实现记录

> 状态：M0 核心已实现（`@openclawx/orchestrator` + api orchestration 模块 + desktop 域存储转发）。
> 本文记录决策、架构、接口与后续里程碑。不修改业务行为、不引入 UI 变化。

## 1. 背景与目标

把"普通对话 + 项目对话"的编排从渲染层下沉为**服务端可复用层**，使桌面 UI 与未来的通道/远程中继网关共享同一套会话/项目状态机，并为工具审批提供**可续跑 run** 语义。

已确认的产品决策（供 M1+ 使用）：

1. 编排并入 `apps/api` 进程；通道网关为独立子进程、由桌面拉起。
2. IM 通道一期为个人自用（白名单 chat/group/user）。
3. 通道默认权限档 `default`，高危操作需显式确认或到桌面处理。
4. 远程中继自建（有公网域名/证书），桌面设备出连 + 纯转发。
5. 项目对话一期 = 远程操作桌面已有项目并查看执行过程（不在通道新建）。
6. openclawx（限制性 MIT，所有权属我方）：协议可借鉴/复制；本实现从零编写。

## 2. 分层

```text
Vue Renderer ──────────┐
                       ▼
        apps/api (Fastify, 单进程宿主)
          ├─ /api/chat          (既有 stateless 流式)
          ├─ /api/orch/**       (新增: 结构化编排 REST+SSE)
          │     └─ @openclawx/orchestrator   (编排层，新增)
          │           ├─ ChatSessionService (普通对话)
          │           ├─ ProjectService    (项目状态机/调度器)
          │           ├─ RunEngine         (可续跑 run、审批停车/决议)
          │           └─ KeyValueStore     (域存储单写者)
          └─ 域数据: ~/.openclawx/domain.json (OPENCLAWX_DATA_DIR)
Electron Main: sql.js 仅存密钥(模型/搜索配置, safeStorage)与资产
               storageGet/Set IPC → 转发 /api/orch/kv
```

## 3. 关键设计

### 3.1 域存储服务化（单写者）

- 新增 `KeyValueStore` 接口 + `JsonFileStore`（临时文件 + 原子 rename）。
- **api 进程是域数据唯一写者**：employees/skills/policies/sessions/projects/runs
  等统一经 orchestrator 落盘。
- 桌面主进程 `openclawx:storage-get/set` 转发到 `/api/orch/kv`；启动时一次性
  迁移旧 sql.js 中除 `model-settings`/`search-settings` 外的键（api 已有则跳过）。
- 密钥不跨边界：模型/搜索配置仍在主进程 safeStorage；后续经 fork IPC keyring 下发。

### 3.2 可续跑 run（M0 语义）

- `RunEngine.execute`：结构事件（tool/approval/artifact/search/终态）持久化，
  `message.delta` 仅透传（hub/SSE）。
- 工具审批事件到达后 run 以 `waiting-approval` 停车；`resolveApproval`：
  - allow + resumeContext → 同一 turn 以**新 attempt** 续跑（grant 写入
    `grantsSession/grantsAlways`，服务端复刻桌面 approve-and-retry 语义）；
  - deny → 记录决议不续跑；会话视图隐藏被 supersede 的旧 attempt。
- 单会话单活动 run；并发写同一文档由 per-key mutex 串行化。

### 3.3 服务端运行时组装（远程 confirm 无 context）

- `apps/api/src/modules/orchestration/context-assembler.ts`：`resolveTaskContext(store, task)`
  读域 KV（员工目录、技能目录 `capabilities.skills.v2` + 员工策略
  `capabilities.employee-policies`、运行时偏好 `workspace.employee-runtime-prefs`、
  MCP/KB 配置）并叠加 keyring 密钥，组装一次任务 run context（profile/model/skills
  /search/mcp/kb）。平台工作区能力由运行时 Tool Contract 提供，不作为 Skill 注入。缺失项优雅降级；无模型则任务失败并
  给出明确提示。接入 `ProjectService.contextResolver` 兜底：`confirm` 不携带
  `runContextByTask/defaultContext` 时（远程终端场景）自动组装。
- 密钥通道：`secrets.ts` → api 子进程启动后经 fork IPC 向 Electron 主进程请求一次性
  解密快照（`model`/`search`），主进程 `startApi` 注册 `message` 应答；仅存内存、绝不落盘。
  本地验收可用 `OPENCLAWX_SECRETS_FILE` 预置同构 JSON（桌面运行不经过此路径）。
- 待办：渲染层侧的同款 normalize 下沉后，本文件将大幅收缩为纯共享函数调用。

### 5.2 远程 confirm（无客户端 context）验收

`scripts/remote-project-confirm.mjs`：预置域 KV（员工目录+运行时偏好）并以
`OPENCLAWX_SECRETS_FILE` 载入 keyring 后，远程终端仅 `POST /projects` + `confirm {}`，
服务端组装器自动解析模型（ollama/chat-x）、提供平台工作区 Tools 并完成
waterfall 两任务 → `[remote-confirm] ALL PASS`。

### 3.4 项目调度

- 状态机：draft → running(queued/running/parked) → completed/failed/cancelled；
- 模式：parallel/DAG（并发+dependsOn）、waterfall/discussion（严格串行）；
- 任务级审批 park（调度器跳过并轮询，决议后自动续跑并继续 drain）；
- 取消：abort 活动任务 + 队列标记 cancelled；协调员汇总为独立 engine run。

## 4. HTTP 接口（前缀 `/api/orch`）

| 方法/路径 | 说明 |
|---|---|
| GET/PUT/DELETE `/kv` | 域 KV 代理（renderer storageGet/Set 转发） |
| POST/GET/DELETE `/sessions[/:id]` | 会话 CRUD |
| POST `/sessions/:id/messages` | 发消息并启动 run（body: content, context） |
| POST `/sessions/:id/cancel` | 中止活动 run |
| POST `/sessions/:id/memory/flush` | 会话滚动记忆 flush（切换/离开时；摘要+水位线） |
| GET `/sessions/:id/runs`、`/runs/:runId` | run 记录/回放 |
| GET `/sessions/:id/approvals` | 待审批列表 |
| POST `/sessions/:id/approvals/:aid/resolve` | 审批决议（allow/deny + resumeContext） |
| POST/GET/PATCH/DELETE `/projects[/:id]` | 项目 CRUD（draft） |
| POST `/projects/:id/confirm` | 启动调度（runContextByTask/defaultContext/summaryContext） |
| POST `/projects/:id/cancel` | 取消活动运行 |
| POST `/projects/:id/tasks/:tid/retry` | 重试失败任务 |
| GET `/projects/:id/tasks/:tid/transcript` | 任务 run 记录 |
| POST `/projects/:id/tasks/:tid/approvals/:aid/resolve` | 任务审批决议 |
| GET `/projects/:id/runs` | 项目运行历史 |
| GET `/events?session=&project=&run=` | SSE 事件订阅（心跳 15s） |

`context` 字段 = `Omit<ChatRequest,'messages'>`（profile/model/skills/providers），
含瞬时密钥仅存在于请求内存，永不落盘。

## 5. 验证

- `packages/orchestrator`: `pnpm typecheck` ✓；`node --test` 9/9 ✓
  （双客户端共享状态、审批 park/resume/deny、parallel/DAG/waterfall、任务审批、
  contextResolver 兜底、cancel）。
- `apps/api`: `typecheck` ✓、`tsup build` ✓；本地冒烟（独立数据目录/端口）验证
  health、会话/项目 CRUD、KV 往返、SSE 连接、domain.json 持久化 ✓。
- `apps/desktop` typecheck ✓；主进程 node --check ✓。
- renderer：修复存量类型错误 —— `tsconfig.app.json` 切到 `moduleResolution: bundler`
  （Vite/Vue 语义，解除 92 处 NodeNext 扩展名报错）+ kb-config 比较/缺失 import 修复；
  `vue-tsc -b` ✓、`vite build` ✓。
- 全仓 `build`（contracts/tools/storage/agent-core/orchestrator/api/renderer）逐包 ✓。

### 5.1 HTTP 边界验收（无头网关冒烟）

api 提供 `OPENCLAWX_ORCH_RUNNER=memory-echo|memory-approval` 确定性 runner
（无模型/网络），配合 `scripts/headless-gateway-smoke.mjs`（真实 HTTP 客户端，
等价于未来桌面 renderer / 网关的调用方式）跑通：

- 会话：创建 → 发消息 → run 落定 → 会话持久化含用户/助手消息；
- 审批：`waiting-approval` 停车 → `resolve allow + resumeContext` →
  同 turn 新 attempt 续跑（echo#2），grant 写入会话；
- 项目：draft → `confirm(defaultContext)` → 并行 3 任务全 completed →
  project-run 记录 `completed`，任务 transcript 可查。

两种 runner 模式均 `[smoke] ALL PASS`（4401/4402 端口验证）。运行方式见
`scripts/headless-gateway-smoke.mjs` 头部注释。

## 6. 下一步（M0 收尾 / M1 起点）

- [ ] renderer 项目页/项目对话迁到 `/api/orch/projects`（服务端执行 + SSE 看进度）；
- [ ] renderer 普通对话可选迁到 sessions；
- [ ] M1：Gateway 子进程 + channel-protocol（借鉴 openclawx UnifiedMessage/registry）
      + Telegram 通道；
