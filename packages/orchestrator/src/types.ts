import type { AgentEvent } from '@openclawx/contracts';

/**
 * Canonical domain records owned by the orchestration service.
 *
 * These deliberately mirror the shapes the Vue renderer already uses
 * (conversation/chat message/project/task) so desktop UI and future channel /
 * relay gateways map onto the same state machine with minimal friction.
 */

/* ------------------------------------------------------------------ *
 * Chat sessions (普通对话)
 * ------------------------------------------------------------------ */

export type ChatRole = 'user' | 'assistant';
export type AccessScope = 'private' | 'org-shared' | 'delegated';

export interface AccessGrant {
  subjectType: 'user';
  subjectId: string;
  permissions: Array<'read' | 'write'>;
  createdAt: number;
  expiresAt?: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  attachments?: import('@openclawx/contracts').ChatImageAttachment[];
  fileAttachments?: import('@openclawx/contracts').ChatFileAttachment[];
  /** Server-produced, bounded attachment content for model context only. */
  attachmentContext?: string;
  workflowResult?: import('@openclawx/contracts').WorkflowResultReference;
  responseMode?: 'text-only';
  createdAt: number;
  /** Turn id — the user message that started the exchange. */
  turnId?: string;
  /** Run attempt that produced this assistant message. */
  runId?: string;
  /** Durable task selected for this turn, when the chat was upgraded to task mode. */
  durableTaskId?: string;
  /** Older attempts of the same turn are hidden from the canonical view. */
  superseded?: boolean;
}

export type GrantCapability = 'workspace-write' | 'script-execution' | 'network-access';

/**
 * Derived session rolling memory. Transcript (`messages`) remains the source of
 * truth; this summary is rebuildable and may lag until the next roll/flush.
 */
export interface SessionMemory {
  /** Rolling continuity brief for reopen / context assembly. */
  summary: string;
  /** Last message id fully absorbed into `summary` (canonical view). */
  coveredUntilId: string;
  updatedAt: number;
  /** True when new turns exist beyond the watermark and may need a flush. */
  dirty: boolean;
}

export interface ChatSession {
  id: string;
  kind: 'chat';
  orgId?: string;
  /** Canonical owner field for future sharing/RBAC evolution. */
  ownerUserId?: string;
  /** Legacy owner field kept for compatibility during migration. */
  userId?: string;
  /** Minimal local sharing scope; defaults to `private`. */
  accessScope?: AccessScope;
  /** Explicit delegated access grants for non-owner users. */
  accessGrants?: AccessGrant[];
  title: string;
  /** Currently selected employee for this session. */
  employeeId: string;
  /** Currently selected model (client-resolved, non-secret label payload). */
  modelLabel?: string;
  messages: ChatMessage[];
  /** Rolling summary for long chats; optional until first roll/flush. */
  memory?: SessionMemory;
  /** Future channel binding, e.g. channel:telegram:<chatId>. */
  channelBinding?: { channelId: string; threadId: string } | null;
  /** Most recently selected non-terminal durable task. */
  activeDurableTaskId?: string;
  /** Per-session approvals granted this run (skillId -> capabilities). */
  grantsSession: Record<string, GrantCapability[]>;
  /** Persistent approvals (skillId -> capabilities). */
  grantsAlways: Record<string, GrantCapability[]>;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ *
 * Agent runs (可续跑 run 语义)
 * ------------------------------------------------------------------ */

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting-approval';

export interface RunActivity {
  invocationId?: string;
  progress?: number;
  toolName: string;
  summary: string;
  /** Bounded, redacted diagnostic detail. Currently populated for Bash. */
  detail?: string;
  status: 'running' | 'completed' | 'failed';
  startedAt?: number;
  durationMs?: number;
  at: number;
}

export interface RunApproval {
  id: string;
  skillId: string;
  capability: GrantCapability;
  summary: string;
  status: 'pending' | 'allowed' | 'denied';
  at: number;
  resolvedAt?: number;
  /** Requested scope when resolved (session or always). */
  scope?: 'session' | 'always';
}

export interface RunArtifact {
  path: string;
  /** Populated when the client archives the artifact into the asset library. */
  assetId?: string;
  assetName?: string;
  assetSizeBytes?: number;
  createdAt?: number;
}

export interface RunSearchSource {
  title: string;
  url: string;
  source?: string;
}

/** Non-secret model / channel used for a run (for usage attribution). */
export interface RunModelInfo {
  provider: string;
  chatModel: string;
  baseUrl?: string;
  providerLabel?: string;
}

/** One LLM step's token counters within a run. */
export interface RunUsageStep {
  at: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  model?: RunModelInfo;
  capability?: import('@openclawx/contracts').ModelCapability;
}

export interface RunUsageModelBucket extends RunModelInfo {
  capability?: import('@openclawx/contracts').ModelCapability;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/** Aggregated token usage for one execution record. */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** Bounded per-step breakdown (newest kept when capped). */
  steps: RunUsageStep[];
  /** Durable per-model totals; keeps attribution accurate when old steps are trimmed. */
  byModel?: RunUsageModelBucket[];
}

export interface RunRecord {
  id: string;
  orgId?: string;
  /** Canonical owner field for future sharing/RBAC evolution. */
  ownerUserId?: string;
  /** Legacy owner field kept for compatibility during migration. */
  userId?: string;
  /** Snapshot of sharing scope when this run started. */
  accessScope?: AccessScope;
  /** Snapshot of delegated access when this run started. */
  accessGrants?: AccessGrant[];
  /** Owning session id (chat session or project id). */
  sessionId: string;
  kind: 'chat' | 'project-task';
  taskId?: string;
  /** Turn anchor in chat sessions. */
  turnId?: string;
  attemptNo: number;
  status: RunStatus;
  error?: string;
  startedAt: number;
  failure?: import('@openclawx/contracts').RunFailure;
  finishedAt?: number;
  /** Accumulated assistant text (final). */
  transcript: string;
  /** Accumulated hidden reasoning / thinking text, never fed to later turns. */
  reasoning?: string;
  activities: RunActivity[];
  approvals: RunApproval[];
  artifacts: RunArtifact[];
  sources: RunSearchSource[];
  /** Bounded event log for replay/debug. */
  eventLog: AgentEvent[];
  /** Reason when cancelled. */
  cancelReason?: 'user' | 'timeout';
  /** Model / provider channel that executed this run. */
  model?: RunModelInfo;
  /** Token consumption for this execution (input/output/cache/…). */
  usage?: RunUsage;
  /** Resolved execution backend (pi / agentscope / dsh). */
  engine?: import('@openclawx/contracts').AgentEngineId;
}

/* ------------------------------------------------------------------ *
 * Projects (项目对话 / 编排)
 * ------------------------------------------------------------------ */

export type ProjectStatus = 'draft' | 'running' | 'completed' | 'failed' | 'cancelled';
/**
 * Task lifecycle on the active Plan.
 * - `stale`: completed/queued work invalidated by a ChangeSet; must re-run
 * - `superseded`: removed from the active Plan (kept for history only)
 */
export type ProjectTaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stale'
  | 'superseded';
/** Planning strategy — only used to materialize DAG edges; runtime is always DAG. */
export type ProjectMode = 'waterfall' | 'parallel' | 'discussion' | 'dag';
export type PermissionTier = 'read-only' | 'default' | 'full';

/** Optional contract attached to a plan node (P1). */
export interface ProjectTaskContract {
  /** Expected deliverable hints (paths / kinds). */
  outputs?: string[];
  /** Acceptance criteria in natural language. */
  acceptance?: string;
  /** Soft step budget for one attempt. */
  maxSteps?: number;
  /** Soft timeout for one attempt (ms). */
  timeoutMs?: number;
  /** Max attempts before the scheduler leaves the task failed. */
  maxAttempts?: number;
}

export interface ProjectTask {
  id: string;
  title: string;
  objective: string;
  /** Latest project follow-up; previous answer is loaded from durable Run evidence. */
  followUp?: { content: string; previousRunId?: string };
  employeeId: string;
  skillIds: string[];
  dependsOn: string[];
  permissionTier: PermissionTier;
  status: ProjectTaskStatus;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  runId?: string;
  error?: string;
  /** Task-level contract (outputs / acceptance / retry budget). */
  contract?: ProjectTaskContract;
  /** Plan version that last mutated this node. */
  planVersion?: number;
  /**
   * Idempotency key for the latest attempt (P3).
   * Format: `{taskId}:plan{version}:attempt{n}` — prevents duplicate execution
   * of the same logical attempt after crash/retry storms.
   */
  lastAttemptKey?: string;
}

/**
 * Versioned execution plan (P0). `Project.tasks` is the materialized graph for
 * the active plan; history keeps prior versions' metadata (not full snapshots).
 */
export interface ProjectPlan {
  version: number;
  createdAt: number;
  strategy: ProjectMode;
  taskIds: string[];
  note?: string;
}

export type ProjectChangeSetKind = 'instruction' | 'replan' | 'invalidate';

/**
 * Incremental mutation against an active plan (P0). Instructions and partial
 * invalidations produce a ChangeSet instead of rewriting the whole graph.
 */
export interface ProjectChangeSet {
  id: string;
  createdAt: number;
  kind: ProjectChangeSetKind;
  summary: string;
  targetTaskIds: string[];
  invalidatedTaskIds: string[];
  planVersionBefore: number;
  planVersionAfter: number;
}

export interface ProjectMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  employeeId?: string;
  taskId?: string;
  createdAt: number;
  changeSetId?: string;
  /** Owning project-run id when known (helps separate current vs historical threads). */
  runId?: string;
}

export interface ProjectRun {
  id: string;
  projectId: string;
  orgId?: string;
  /** Canonical owner field for future sharing/RBAC evolution. */
  ownerUserId?: string;
  /** Legacy owner field kept for compatibility during migration. */
  userId?: string;
  /** Snapshot of sharing scope when this project run started. */
  accessScope?: AccessScope;
  /** Snapshot of delegated access when this project run started. */
  accessGrants?: AccessGrant[];
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  taskIds: string[];
  summary?: string;
  error?: string;
  /** Plan version this run was opened against. */
  planVersion?: number;
  /** Originating ChangeSet when this run was opened by an instruction. */
  changeSetId?: string;
  /** Conversation snapshot archived when a later run starts. */
  messages?: ProjectMessage[];
}

export interface Project {
  /** Absent on legacy DAG/workflow projects. */
  kind?: 'conversation';
  defaultEmployeeId?: string;
  id: string;
  orgId?: string;
  /** Canonical owner field for future sharing/RBAC evolution. */
  ownerUserId?: string;
  /** Legacy owner field kept for compatibility during migration. */
  userId?: string;
  /** Minimal local sharing scope; defaults to `private`. */
  accessScope?: AccessScope;
  /** Explicit delegated access grants for non-owner users. */
  accessGrants?: AccessGrant[];
  name: string;
  goal: string;
  status: ProjectStatus;
  mode: ProjectMode;
  workspacePath: string;
  /** Opt-in isolated task execution; default preserves legacy project-root execution. */
  executionWorkspaceMode?: 'isolated';
  tasks: ProjectTask[];
  messages: ProjectMessage[];
  createdAt: number;
  updatedAt: number;
  activeRunId?: string;
  summary?: string;
  /** Active plan metadata (versioned). */
  plan?: ProjectPlan;
  /** Previous plan versions (metadata only, newest last). */
  planHistory?: ProjectPlan[];
  /** Recent change sets (capped). */
  changeSets?: ProjectChangeSet[];
  /** Coordinator metadata supplied by the client at confirm time. */
  coordinator?: { provider: string; model: string };
  /** Grants applied while tasks of this project run (advisory for assemblers). */
  grantsSession?: Record<string, GrantCapability[]>;
  grantsAlways?: Record<string, GrantCapability[]>;
}

export interface ProjectTaskTranscript {
  runId: string;
  assistantContent: string;
  activities: RunActivity[];
  approvals: RunApproval[];
  artifacts: RunArtifact[];
  sources: RunSearchSource[];
  status: RunStatus;
  error?: string;
}
