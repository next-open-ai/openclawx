# OpenClawX M0 验收清单

> 与 `docs/architecture/gateway-m0.md` 配套；每条给出可复现的验证入口与状态。

## A. 服务端可复用编排层（`@openclawx/orchestrator`，由 apps/api 托管）

| # | 验收点 | 验证入口 | 状态 |
|---|---|---|---|
| A1 | 域存储单写者：KV 接口 + 内存/JSON 原子落盘 | `packages/orchestrator/src/storage/*` | ✅ |
| A2 | 普通对话会话状态机（消息回合、superseded、单活动 run） | `src/chat-session.ts` | ✅ |
| A3 | 可续跑 run：审批 parking → `waiting-approval` → 决议 → 同 turn 新 attempt | `src/run-engine.ts`、`src/chat-session.ts` | ✅ |
| A4 | 项目状态机 + 调度（parallel/DAG/waterfall/discussion）+ 任务级审批 + 取消/重试 | `src/project.ts` | ✅ |
| A5 | 文档级并发安全（per-key mutex，并行任务结算不丢更新） | `src/lock.ts` | ✅ |
| A6 | 单测全绿 | `cd packages/orchestrator && node --test dist/test/*.test.js` | ✅ 9/9 |
| A7 | 无头/网关与桌面共享同一状态（双实例同一 store 观察一致） | A6 用例 1 / HTTP 冒烟 | ✅ |

## B. 域存储服务化（桌面与网关共享）

| # | 验收点 | 验证入口 | 状态 |
|---|---|---|---|
| B1 | 主进程 `storageGet/Set` IPC 转发 `/api/orch/kv`（降级回 sql.js） | `apps/desktop/src/main/index.cjs` | ✅ |
| B2 | 一次性迁移旧 sql.js 域键（跳过密钥键、不覆盖已有） | 同上 `migrateDomainKvToApi` | ✅ |
| B3 | `OPENCLAWX_DATA_DIR` 注入 + `domain.json` 持久化 | 起服后检查 `~/.openclawx/domain.json` | ✅ |
| B4 | 密钥不落盘：fork IPC keyring（`openclawx:secrets` 一次性解密快照） | `secrets.ts` + 主进程 `message` 应答 | ✅ |

## C. HTTP 边界（renderer 与未来网关统一消费）

| # | 验收点 | 验证入口 | 状态 |
|---|---|---|---|
| C1 | REST：sessions/messages/approvals/projects/confirm/cancel/retry/transcript/runs | `/api/orch/**`（routes.ts） | ✅ |
| C2 | SSE 事件订阅（心跳 15s；run/project/session 主题） | `scripts/watch-project.mjs` 实况 | ✅ |
| C3 | 无头网关冒烟（echo/approval 双 runner） | `OPENCLAWX_ORCH_RUNNER=… node dist/main.cjs` + `scripts/headless-gateway-smoke.mjs` | ✅ ALL PASS |
| C4 | 远程 confirm 无 context（服务端组装：KV + keyring） | `OPENCLAWX_SECRETS_FILE=…` + `scripts/remote-project-confirm.mjs` | ✅ ALL PASS |

## D. 构建与类型

| # | 验收点 | 验证入口 | 状态 |
|---|---|---|---|
| D1 | orchestrator / api / desktop typecheck | `corepack pnpm --filter @openclawx/<p> typecheck` | ✅ |
| D2 | renderer `vue-tsc -b`（历史错误已修复：bundler 解析 + kb/import 修复） | `cd apps/renderer && corepack pnpm exec vue-tsc -b` | ✅ |
| D3 | 逐包 build（contracts/tools/storage/agent-core/orchestrator/api/renderer） | `corepack pnpm --filter @openclawx/<p> build` | ✅ |

## E. 渲染层接入（迁移切片）

| # | 验收点 | 验证入口 | 状态 |
|---|---|---|---|
| E1 | renderer 项目页/项目对话切到 `/api/orch/projects`（服务端调度+轮询/SSE 进度、transcript、取消/删除服务端） | ProjectsPage 双模式（`managedServer`），`vue-tsc -b` ✓ `vite build` ✓ | ✅（编译级） |
| E2 | renderer 普通对话切到服务端 sessions（桌面会话=服务端会话、SSE 流式镜像、审批决议走服务器自动续跑、资产走 IPC） | `workspace.ts` 双模式 + `services/orchestration.ts`；`vue-tsc -b` ✓ `vite build` ✓ | ✅（编译级） |
| E3 | HTTP 验收：chat 无 context + 审批 allow（无 resumeContext）自动续跑 | `scripts/remote-chat.mjs`（memory-approval + `OPENCLAWX_SECRETS_FILE`） | ✅ ALL PASS |
| E4 | 桌面人工 QA（起 App → 会话/项目 → 审批/资产/重启一致性） | `pnpm dev` 手动 | ⏳ 需人工 |

## 完成判据
A–D 与 E1–E3 全 ✅，`vue-tsc -b`/`vite build`/全仓 build 通过后即达 M0 服务层目标；
E4 桌面人工 QA 为发布前最后一道（无图形环境无法在此自动执行）。
