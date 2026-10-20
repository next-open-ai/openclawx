# Workspace writing V2 (FW-V2)

Status: 已验证（本地自动化回归）；真实供应商运行待验收 · 2026-10-11.

## Requirements / implementation / tests

- FW-R1/T1: bounded larger complete payloads, UTF-8 byte limit 96,000 retained. Content max32,000 chars; chunk/append max16,000 chars. Recommend 8,000-char fragments, not guessed exact counts; valid medium CSS/JS should need one write rather than shell merge. Provider output truncation is still possible; never declare truncated content complete.
- FW-R2/T2: staged status tool returns content-free state, nextSeq and actual byte/part counts. Total count optional and discouraged by default; explicit status totalParts=null releases a mistaken declaration without discarding accepted pieces; positive replacement cannot be below accepted count. Same seq/text retry is idempotent; differing text/ordering is rejected with recovery state/code. No guessed repair or automatic reset.
- FW-R3/T3: run/workspace-scoped staged access, bounded sessions and TTL; no active-session eviction. Committing locks assembly; failed/cancelled persistence preserves accepted parts; successful finish consumes only afterward and is idempotent within tool instance. No cross-run/restart recovery claim.
- FW-R4/T4: shared per-target serialization, bounded append final size, atomic sibling-temp replacement, existing permission/extension/realpath checks retained. Cancellation before commit rejects; temp cleanup and old file preservation on pre-commit failure. Existing TOCTOU caveat remains; no OS sandbox claim.
- FW-R5/T5: logical tool failures display actual bounded error, not generic progress alone. Keep existing 50-step/model/time limits, no automatic retry/model calls and no security relaxation.

Contracts: additive workspace_write_status({writeId,totalParts?:number|null}); shared WorkspaceWriteState/Error schemas in contracts. Existing write/start/append/finish names and seq meaning retained. Legacy total/reset callers still supported; no persisted migration. Modules: contracts, agent-core workspace-write/skill-runtime/pi-runtime, runtime tests. Not changing task-template UI, artifact-source staging protocol, native Pi write tools or DSH filesystem engine. Tests: exact unicode/byte bounds, ambiguous payloads, sequence retry/conflict, total recovery, scope isolation, status, incomplete/failed/retried/concurrent finish, cancellation, file append cap, path/symlink denial and production tool schema admission; old regressions/full agent-core tests and builds. Rollback tool/schema changes together; ephemeral staging lost on restart, on-disk successful files retained. No edits to reported user project or real model retries.

## Tasks / traceability

| Task | Requirement / test | Implementation | Status |
| --- | --- | --- | --- |
| FW-01 Larger bounded payloads | FW-R1/T1 | workspace-write constants/body validation, production tool schemas | 完成 |
| FW-02 Recoverable assembly | FW-R2/T2 | shared contracts, status, duplicate seq, explicit total repair | 完成 |
| FW-03 Safe commit lifecycle | FW-R3/T3, FW-R4/T4 | scope/session bounds, commit lock/retention/cache, target lock/temp rename | 完成 |
| FW-04 Truthful diagnostics | FW-R5/T5 | Pi tool.failed for logical failures; real Pi loop mocked-provider regression | 完成 |
| FW-05 Verification/documentation | FW-R1–R5 | runtime tests, architecture guide and this evidence | 完成（真实模型待验收） |

## Verification evidence (2026-10-11)

- `pnpm --filter @openclawx/contracts build`: passed.
- `pnpm --filter @openclawx/agent-core test`: 190 passed, including five new FW tests. Real SDK argument validator admits ~14KB CSS and ~20KB JS in one call each; wrong total, duplicate/conflicting sequences, denied paths, concurrent append, cancellation and failed persistence covered. This is deterministic capability verification, not a live-model latency benchmark.
- `pnpm --filter @openclawx/orchestrator test`: 94 passed.
- `pnpm --filter @openclawx/api test`: 48 passed, 2 skipped (existing suite skips).
- `pnpm --filter @openclawx/api build`: passed.
- `pnpm concurrency:regression`: passed, isolated temporary data directory, DSH bridge regression and AgentScope stub concurrency/load tests. No real model billing.
- `git diff --check`: passed.

No renderer changes in FW-V2, no live supplier test or retry of the reported project, and no running service restarted. Runtime changes require restarting the current development/backend process. Existing persisted tasks/files need no migration. Rollback only the FW-V2 changes (preserve other working-tree edits); restarting loses unfinished in-memory sessions, not committed files.
