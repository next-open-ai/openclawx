# Workmate

**Workmate - a cross-platform, local-first AI workspace for digital employees.**

> **Languages:** [中文 (zh-CN)](README.md) · English
>
> This repository uses a language-split README structure. This file is the full English version.

---

Workmate is a desktop agent workspace where digital employees can chat, run orchestrated projects, use Skills, search knowledge bases / MCP connectors / the web, manage assets, and coordinate through external channels such as Telegram, Feishu, and a remote relay. Heavy orchestration lives in a server-side state machine, so the desktop UI, gateway processes, and future remote terminals can share one consistent view of sessions, approvals, runs, assets, and project state.

See [docs/current-state.md](docs/current-state.md) for the implementation snapshot and validation boundaries.

The repository deliberately keeps the Electron shell thin:

```text
Electron shell  ->  local Fastify API  ->  agent-core (pi / AgentScope / dsh)  ->  providers
Vue renderer  ------ HTTP / SSE -------^
gateway child ------ HTTP / SSE -------^   (Telegram / Feishu / remote relay)
```

## Highlights

| Capability | Description |
| --- | --- |
| Digital employees | Responsibility and authorization units with configurable model, Skills, runtime preferences, and permission tiers |
| Execution backends | Unified `ExecutionBackend` registry with built-in `pi`, optional `AgentScope` sidecar pool, and `dsh` coding sidecar |
| Skills (progressive disclosure) | Authorize metadata first, load `SKILL.md` on demand, then access resources/scripts inside an isolated run workspace |
| Projects and workflows | Ordinary projects use multi-turn conversations and a stable output directory without automatic DAG planning; explicit workflows and legacy DAG projects retain Plan/Run/ChangeSet |
| Task center | Direct or template-based tasks, scheduled/recurring execution, optional parameter/report UIs, and persistent json-result records |
| Data objects and apps | Live connections/local copies, controlled aggregates/JOINs, AI-generated parameterized SQL, reviewed CRUD, MySQL new-table drafts, and a full-window app gallery |
| Query assets and experience | Explicitly saved successful queries; SQLite-first experience cards with asynchronous JSON mirrors and optional configuration-validated background knowledge sync |
| Resumable approvals | Tool approvals park a run in `waiting-approval`; resolving an approval resumes the same turn automatically as a new attempt |
| Session rolling memory | Per-session `memory.summary` plus watermark; long conversations compress automatically while the transcript remains the source of truth |
| Durable tasks | Complex jobs preserve source files, checkpoints, and workspaces across runs, then settle automatically when complete |
| Dual workspaces | Per-run workspaces for process files; final deliverables are promoted into a shared project workspace via `publish_to_project` |
| Application models and decision guards | Image, vision, speech, embedding, quantum-code, decision, and ontology matching are unified capability tools |
| Knowledge / ontology / MCP / web search | Local LanceDB, ontology construction and enhanced retrieval, cloud knowledge, MCP, and web search |
| Realtime voice and mobile chat | Desktop realtime/ASR modes, current-chat work bridge and completion notices; mobile HTTP chat plus scoped HTTPS voice |
| Channels and remote office | Gateway child process with Telegram, Feishu, personal allowlists, and a remote relay device link |
| Local embedding sidecar | Experimental desktop-managed local embedding runtime/proxy with provider registration scaffolding and dedicated design docs |
| Local-first storage | Domain data has a single durable writer (the API process); secrets stay encrypted in the desktop main process and are released only over fork IPC |

## Repository layout

| Path | Role |
| --- | --- |
| `apps/desktop` | Thin Electron main process: windowing, IPC, sql.js secret/asset store, forks API and gateway |
| `apps/renderer` | Vue 3 UI (Vite + Tailwind), browser-only, talks over HTTP/SSE and desktop IPC |
| `apps/api` | Localhost Fastify service hosting orchestration routes and the domain KV writer |
| `apps/gateway` | Gateway child process for Telegram / Feishu / remote relay |
| `packages/contracts` | Shared Zod contracts, the source of truth for runtime payloads and events |
| `packages/agent-core` | Model execution layer and runtime adapters; the only layer that talks to model SDKs |
| `packages/orchestrator` | Server-side session / run / approval / project state machines |
| `packages/channel` | Transport-agnostic channel protocol and message abstractions |
| `packages/tools` | Tool contracts and risk metadata |
| `packages/storage`, `packages/ui-kit` | Reserved placeholders |

See [docs/architecture/architecture.md](docs/architecture/architecture.md) for the current canonical architecture.

## Quick start

Requirements: Node.js `>= 22`, pnpm `>= 10`.  
Python `>= 3.10` is needed only when using AgentScope sidecars.

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm build
pnpm package
```

For the local web launcher / npm runtime:

```bash
pnpm web:build
pnpm web:start
```

For the packaged CLI / npm payload:

```bash
npm install -g @next-open-ai/workmate
workmate doctor
workmate init
workmate start
```

Useful local validation commands:

```bash
pnpm agentscope:smoke
pnpm dsh:regression
pnpm concurrency:regression
pnpm quality:console
```

Default renderer/API/test-console ports: `47831` / `47832` / `47840`.
Default data directory: `~/.workmate`.

## Runtime shapes

Workmate currently supports four practical runtime shapes:

| Runtime | Entry | Support level | Notes |
| --- | --- | --- | --- |
| Desktop | `pnpm dev` / packaged app | Full | Reference experience: Electron IPC, `safeStorage`, native file actions, desktop-managed gateway |
| Web launcher | `pnpm web:build && pnpm web:start` | Supported | Built renderer hosted by the local Fastify API; no Electron-only features |
| npm / CLI | `workmate start` | Supported | Same runtime shape as the web launcher |
| Docker | `deploy/docker/workmate/` | Build-supported | Images exist and are documented; parity is still evolving |

The detailed parity matrix lives in [docs/guides/runtime-modes.md](docs/guides/runtime-modes.md).

## Architecture reality

These points matter most if you are evaluating the current implementation:

- Orchestration is server-owned: `/api/orch/**` and SSE are the canonical session/run/project surface.
- The desktop main process is intentionally thin and does not call models directly.
- Secrets for model/search/channel settings remain in the desktop keyring bridge (`safeStorage`) and are never written into `domain.json`.
- `pi` is the default execution engine; `AgentScope` and `dsh` are optional execution backends under the same product surface.
- The local embedding sidecar is still an incremental feature: architecture, provider contracts, state management, and desktop controls exist; true local inference backends are still being productized.

Relevant docs:

- [docs/architecture/execution-backend.md](docs/architecture/execution-backend.md)
- [docs/architecture/dsh-sidecar.md](docs/architecture/dsh-sidecar.md)
- [docs/architecture/agentscope-abi.md](docs/architecture/agentscope-abi.md)
- [docs/architecture/embedding-local-sidecar-architecture.md](docs/architecture/embedding-local-sidecar-architecture.md)
- [docs/architecture/embedding-local-sidecar-implementation-plan.md](docs/architecture/embedding-local-sidecar-implementation-plan.md)

## Release

Pushing a SemVer tag such as `v0.1.0` triggers the desktop release workflow.

Current CI-packaged installers:

| Platform | Architecture | Installer |
| --- | --- | --- |
| macOS | Apple Silicon (arm64) | `.dmg` |
| Windows | x64 | NSIS `.exe` |

Intel macOS and Linux packaging remain disabled in CI for now; see comments in `.github/workflows/release.yml`.

## Documentation

| Topic | Entry |
| --- | --- |
| Documentation center | [docs/README.md](docs/README.md) |
| Product and requirements | [docs/product/README.md](docs/product/README.md) |
| Project planning | [docs/planning/README.md](docs/planning/README.md) |
| Testing and release acceptance | [docs/quality/README.md](docs/quality/README.md) |
| Platform benchmarks | [docs/benchmarks/README.md](docs/benchmarks/README.md) |
| Canonical architecture | [docs/architecture/architecture.md](docs/architecture/architecture.md) |
| Architecture center | [docs/architecture/README.md](docs/architecture/README.md) |
| Architecture decisions | [docs/architecture/adr/README.md](docs/architecture/adr/README.md) |
| Runtime shapes | [docs/guides/runtime-modes.md](docs/guides/runtime-modes.md) |
| Execution backend abstraction | [docs/architecture/execution-backend.md](docs/architecture/execution-backend.md) |
| Concurrency runtime | [docs/architecture/concurrency-runtime.md](docs/architecture/concurrency-runtime.md) |
| Concurrency verification | [docs/architecture/concurrency-verification.md](docs/architecture/concurrency-verification.md) |
| Gateway milestones | [M0](docs/architecture/gateway-m0.md) · [M0 acceptance](docs/architecture/gateway-m0-acceptance.md) · [M1](docs/architecture/gateway-m1.md) · [M2](docs/architecture/gateway-m2.md) |
| Early historical specs | [docs/archive/legacy-global-sdd/](docs/archive/legacy-global-sdd/README.md) |

## License

MIT License.
