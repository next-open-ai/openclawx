# Lightweight projects v1

> UI refinement version: 1.1 · 2026-10-11 · LP-T7 implemented and regression verified.

## Scope and requirements

- LP-R1: new ordinary projects are persistent conversations with a fixed, server-managed directory. Creation requires a name, optionally a goal; creates no Plan, tasks, Run, or model request. Legacy DAG projects and workflow invocations retain their behavior.
- LP-R2: an explicit message creates one independent turn record and Run, with current employee authorization/model resolved server-side. No DAG planning or dependent-node invalidation. Earlier failed turns never poison or rerun with later messages. Concurrent sends are rejected.
- LP-R3: bounded real user/assistant history is supplied to subsequent turns. Successful deliverables seed the next isolated workspace; failed/cancelled executions do not replace project deliverables. Uploaded reference materials remain available.
- LP-R4: the existing composer, live execution, approvals, cancel, files and optional workflow entry remain available. No Plan/DAG/member administration or automatic start on opening ordinary conversation projects.
- LP-R5: preview remains explicit. Generic local static publication snapshots are independently implemented by [PA-V1](../project-application-v1/README.md); LP execution never silently publishes sites or changes existing data-app publishing.
- LP-R7: conversation projects present the selected employee directly, not a planner/coordinator. System messages are labeled “系统”; known redundant admission/creation notices are hidden only in the view, never deleted. No coordinator summary card is shown. A compact live status and per-turn failure/cancellation notice with available structured diagnostics remain visible, including partial replies and failures before any assistant message. Unknown system notices, approvals, tools, assets and explicit workflow results are preserved. Legacy DAG/workflow presentation and execution are unchanged.
- LP-R6 / LP-T6: creation defaults to a system directory or accepts `workspace: {mode: 'custom', parentPath: string}` (or `{mode: 'system'}`). API creates a fresh UUID child, never adopts/renames the selected parent. Invalid, inaccessible, filesystem root or symlink parent directories fail visibly without creating a project. Desktop uses the native picker; browser accepts an explicitly labeled API-host absolute path. Test directory admission, preservation of existing files, separate children, and UI switching. Existing projects retain their paths; omitted workspace remains backward compatible.

## Contracts and compatibility

`POST /projects/conversations`: strict shared Zod `{name, goal?, employeeId?, workspace?: {mode: 'system'} | {mode: 'custom', parentPath: string}}`. Authenticated API creates a UUID-named workspace under the configured data directory by default, or inside the selected existing writable parent; the project is private. Directory admission failure returns HTTP 400 / `PROJECT_DIRECTORY_INVALID` without persisting a project. `kind: conversation` and `defaultEmployeeId` are additive persisted fields; absent kind means legacy DAG. Existing `/projects` creation remains compatible for workflows and data apps. Existing `/instructions` selects an available employee for ordinary projects; API resolves its authorized context. `/confirm` cannot run an empty conversation or replay old turns.

Turn records reuse task/Run persistence and approval execution internally, but have no dependency edges or planning lifecycle. Only the latest explicitly selected turn belongs to its ProjectRun. Failed history is preserved. Rollback: restore old UI entry and stop creating conversation-kind records; never reinterpret these records as legacy DAG or delete their files.

## Tasks / test specification

- LP-T1 contracts/API admission: invalid name, unexpected path, private ownership, no creation Run. Regression `lightweight-project` tests.
- LP-T2 service lifecycle: create empty, two explicit turns, real history, no Plan, earlier failure then successful turn, cancel/reopen, reject full replay/concurrent send. Same regression.
- LP-T3 directory isolation: seed prior files/materials; failure retains prior bytes; promotion fails safely; symlink rejection. Same regression.
- LP-T4 UI: simple creation form (name, optional description); sends use existing composer; empty project has a usable employee picker; hide DAG/start controls for new kind; legacy controls remain. Renderer typecheck/build and fixture regression.
- LP-T5 synchronize architecture/manual and record actual validation, not assumed provider success.
- LP-T7 maps LP-R7 to `project-conversation-presentation.ts`, `ProjectTurnStatus.vue`, the project workspace and terminal UI projection. Test known-message filtering without mutation, unknown notices, legacy identity, partial-reply error deduplication, cancellation, no-reply errors, live/approval states and expandable diagnostics. Regression: `scripts/project-conversation-presentation-regression.mjs`; renderer build and existing project/live-state regressions. No API/storage contract changes or migration; rollback restores presentation only.

## Status

LP-T1–T4 implemented. New ordinary projects use conversation kind; legacy DAG behavior remains. LP-T5 docs synchronized. Local static application publication is implemented separately in PA-V1, not in the LP execution loop.

LP-T6 implemented (2026-10-10): optional shared workspace selection contract, API-owned fresh child directory, native picker entry and browser host-path fallback. API regression in `project-instructions.test.ts` covers relative/missing/file/root/symlink/read-only paths, unchanged parent files, unique children, no project on rejection and no model calls. API tests: 43 passed / 2 opt-in DB skipped; orchestrator: 75 passed. Contracts/API builds and renderer typecheck/build passed (existing Vite warnings unchanged). Creation fixture passed system/custom switching, missing-path disable, retry, simulated desktop IPC cancellation/error/reselection, desktop/mobile overflow checks; screenshots inspected. Actual Electron OS dialog and real supplier runs were not exercised. Existing projects remain untouched; no migration. Restart API and refresh renderer to load this entry. Rollback can hide the new selector; optional workspace omission still uses system defaults.

Validation (2026-10-10):

- `pnpm --filter @openclawx/contracts build`: passed.
- `pnpm --filter @openclawx/orchestrator test`: 75 passed, including explicit-turn/history, failure/cancel/reopen, approvals allowed/denied, conflict and symlink protection.
- `pnpm --filter @openclawx/api test`: 43 passed, 2 opt-in real DB tests skipped; includes strict private empty creation and rejecting legacy sync-run overwrite for conversation projects.
- `pnpm --filter @openclawx/api build` and renderer `typecheck`/`build`: passed; existing Vite chunk-size/mixed-import warnings remain.
- `pnpm concurrency:regression`: passed (synthetic runner).
- `node scripts/workflow-chat-return-regression.mjs`, `node scripts/project-sharing-regression.mjs`: passed.
- `scripts/project-composer-regression.mjs` with existing Playwright/Chrome: passed (default employee, IME, failed/successful send, stop, @ selection, document retry/isolation, synthetic ASR manual confirmation).
- `scripts/lightweight-project-regression.mjs`: production form/handler in isolated Playwright HTTP fixture, desktop/narrow-screen screenshots visually inspected; creation does not plan/execute, failed request retains input, retry succeeds. CLI agent-browser unavailable; existing Playwright Chrome used. Component wiring verified structurally, not an end-to-end real supplier acceptance.

Safety/limitations: renderer never recovers run files automatically into conversation projects; backend sync-run rejects that path. UI-read `.openclawx` metadata does not trigger false file conflicts. A change to project files during execution rejects promotion instead of overwriting. Promotion uses a prepared directory plus rename/rollback; this is not an OS sandbox or a fully journaled power-loss transaction. If rollback itself fails the temporary sibling backup remains for recovery. Large workspaces (>5000 files or 512 MB) are rejected explicitly. Deleting old deliverables through model output is not yet supported; explicit editor/management remains separate. No real provider calls, user-project migrations or external publication were performed.

Loading: restart the running development API to register the new endpoint and refresh/restart renderer. This acceptance did not restart the user's active app process or modify existing projects. No stored-data migration is required; legacy records without kind retain DAG behavior.

### LP-T7 validation · 2026-10-11

Implemented presentation-only refinement: selected employee stays the speaker; known redundant lifecycle messages are hidden without changing stored messages; other system notices use “系统”. Conversation summaries are no longer synthesized/displayed. Inline per-turn errors and expandable structured diagnostics cover partial and absent replies; compact queue/working/approval states and cancellation remain visible. Legacy summaries, explicit workflow entry/results, tools, approvals and assets are unchanged. Manual and generated in-app manual synchronized.

- `pnpm --filter @openclawx/renderer build`: passed (includes Vue/TypeScript checking); existing bundle-size/mixed-import warnings remain. Initial typecheck caught the diagnostic HTTP field name and it was corrected to the shared contract's `status` before the successful rerun.
- `pnpm --filter @openclawx/orchestrator test`: 77 passed; no execution-layer changes.
- `node scripts/project-conversation-presentation-regression.mjs`: passed using existing Playwright/Chrome, with production message template, projection and status component. Error/diagnostic desktop/mobile screenshots inspected; narrow-screen overflow check passed. No extra coordinator summary, preserved selected employee/assets/approval controls, error deduplication and no-reply failure verified.
- Existing `lightweight-project-regression.mjs`, `project-composer-regression.mjs`, `project-live-state-regression.mjs`, `workflow-chat-return-regression.mjs`, `run-diagnostics-regression.mjs`: passed. The diagnostics fixture initially lacked the previously introduced live-state module adapter; it now loads the real pure helper and adds actual conversation terminal-projection assertions, without changing expected legacy behavior.
- `pnpm docs:build`: passed. `git diff --check`: passed.

No API/storage/model selection, planning, fees, or publication behavior changed. No migration, data deletion, user-app restart, or real provider calls. This is isolated fixture validation, not actual Electron/live-provider acceptance. Refresh the renderer to load the UI changes; packaged installations require a rebuilt release. Rollback affects presentation only; original messages and run evidence remain stored.
