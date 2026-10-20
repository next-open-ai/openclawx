# OpenClawX compatibility layer v1

> Status: 已实施并验证
> Architecture baseline: `dcf3207`

## Repository replacement

- `/Users/ctrip/code/pro/tools/openclawx` is the current OpenClawX checkout on
  `main`.
- The clean legacy checkout is preserved outside the new repository at
  `/Users/ctrip/code/pro/tools/openclawx-legacy-backup-20261020`, so it is not
  included in workspace discovery or desktop packaging.
- The completed replacement is an independent OpenClawX codebase. `origin`
  pushes to both the Gitee and GitHub OpenClawX repositories.
- GitHub Actions uses a split CI/release model. Expensive DSH and
  concurrency regression jobs stay disabled in hosted Actions, pull requests
  build without uploading installers, and tagged releases package only macOS
  arm64 and Windows x64 artifacts.
- The renderer size gate measures the largest emitted asset rather than the
  aggregate assets directory. This keeps a meaningful per-chunk budget without
  failing merely because the application contains multiple lazy/static assets.

## Scope

The new OpenClawX uses a modular agent architecture rather than continuing the
legacy runtime. This repository is the source of truth for contracts,
orchestration, storage, desktop lifecycle, and channel protocol.

### Requirements

- **OCX-R1**: preserve the modular behavior and package boundaries unless
  an explicit compatibility contract requires an extension.
- **OCX-R2**: expose OpenCode and Claude Code through `@openclawx/agent-core`
  `ExecutionBackend`; no provider calls may be placed in renderer, API,
  gateway, or orchestrator.
- **OCX-R2a**: expose Coze only as an explicit workflow integration node. The
  project scheduler and RunEngine remain the execution/audit owner; the hidden
  `coze-workflow` adapter is not offered as a normal employee engine.
- **OCX-R3**: support Telegram, Feishu, and DingTalk through
  `@openclawx/channel` `UnifiedMessage` / `IChannel`; vendor payloads must not
  escape adapter modules.
- **OCX-R4**: channel credentials are secrets. They must not be stored in domain
  KV or logged. Non-secret enablement and identifiers remain in `channels.v1`.
- **OCX-R5**: legacy `runnerType` and `~/.openbot` files are migration inputs
  only. The new runtime uses OpenClawX engine IDs and `~/.openclawx` storage.

## Compatibility contracts

| Capability | New owner | Compatibility boundary |
| --- | --- | --- |
| Coze | workflow node + private `agent-core` adapter | AgentEvent stream; workflow-only admission |
| OpenCode | `packages/agent-core` | AgentEvent stream; session scoped to conversation |
| Claude Code | `packages/agent-core` | AgentEvent stream; child process cancellation |
| Telegram | `apps/gateway` | native OpenClawX adapter |
| Feishu | `apps/gateway` | native OpenClawX adapter |
| DingTalk | `apps/gateway` | Stream inbound + session webhook outbound |

## Error and rollback rules

- Missing credentials/configuration fails the selected adapter with a readable
  `run.failed`; it never silently falls back to another engine.
- Gateway starts all independently valid enabled channels. One invalid channel
  must not leak its secret or change another channel's configuration.
- Rollback removes the compatibility adapter registration and leaves OpenClawX
  domain data intact. No destructive storage migration is part of v1.

## Phase-2 runtime configuration

This phase deliberately keeps external credentials out of domain KV and run
records. The API process receives them from its runtime environment:

- OpenCode: `OPENCLAWX_OPENCODE_BASE_URL`, optional
  `OPENCLAWX_OPENCODE_USERNAME`, `OPENCLAWX_OPENCODE_PASSWORD`, and
  `OPENCLAWX_OPENCODE_MODEL` (`provider/model`).
- Claude Code: optional `OPENCLAWX_CLAUDE_CODE_BIN` and
  `OPENCLAWX_CLAUDE_CODE_CWD`; authentication remains owned by the installed
  Claude Code CLI.
- Coze default connection: `OPENCLAWX_COZE_BOT_ID`,
  `OPENCLAWX_COZE_API_KEY`, optional region/base URL. Named workflow connection
  `sales-cn` may instead use the `OPENCLAWX_COZE_SALES_CN_*` prefix.

The follow-up settings task will move these values into the existing keyring /
safe-storage path without changing the execution contracts.

## Tasks and tests

| Task | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| OCX-T1 create modular OpenClawX repository | R1 | 完成 | `main` at and after `22e6dad` |
| OCX-T2 DingTalk channel adapter/config | R3,R4 | 已验证 | `pnpm --filter @openclawx/gateway test`; `pnpm build` |
| OCX-T3 external execution contracts | R2,R4,R5 | 已实现 | contracts/agent-core tests |
| OCX-T4 Coze workflow node | R2a | 已验证 | schema/context/SSE parser + full build |
| OCX-T5 OpenCode backend | R2 | 已验证 | backend registration + agent-core regression |
| OCX-T6 Claude Code backend | R2 | 已验证 | stream-json parser + agent-core regression |
| OCX-T7 settings UI and legacy import | R4,R5 | 待开始 | API/renderer regression |
| OCX-T8 replace legacy checkout and align CI | R1 | 已验证 | backup + full build + size gate |
| OCX-T9 unify product identity and repository naming | R1,R4,R5 | 已验证 | full build, docs build, API/agent/gateway regression |
