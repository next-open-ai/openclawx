import { randomUUID } from 'node:crypto';
import { diagnoseModelFailure } from '@workmate/agent-core';
import type { AgentEvent, ChatRequest } from '@workmate/contracts';
import type { OrcEvent } from './events.js';
import type { EventHub } from './hub.js';
import { readJson, writeJson } from './repo.js';
import type { ExecutionDispatcher } from './execution-dispatcher.js';
import type { AgentRunner } from './runner.js';
import type { KeyValueStore } from './storage/kv.js';
import { namespaceKey } from './storage/kv.js';
import type { AccessGrant, AccessScope, GrantCapability, RunActivity, RunApproval, RunRecord, RunStatus } from './types.js';
import { applyUsageEvent, modelInfoFromRequest } from './usage.js';

export type { OrcEvent };

export interface ExecuteAttemptOptions {
  runId?: string;
  sessionId: string;
  orgId?: string;
  ownerUserId?: string;
  userId?: string;
  accessScope?: AccessScope;
  accessGrants?: AccessGrant[];
  kind: 'chat' | 'project-task';
  taskId?: string;
  turnId?: string;
  attemptNo?: number;
  request: ChatRequest;
  /** Abort this attempt (user cancel / timeout). */
  signal?: AbortSignal;
  /** Optional per-attempt deadline; project contracts may override the global default. */
  timeoutMs?: number;
  /** Extra hub topics to publish structural events onto (e.g. project:<id>). */
  extraTopics?: string[];
  /** Trusted server-side delivery boundary; never supplied by HTTP clients. */
  finalizeCompleted?: (run: Readonly<RunRecord>, emit: (event: AgentEvent) => void) => Promise<void>;
}

export const RUN_NS = 'run';

function isDeltaLike(event: AgentEvent): boolean {
  return event.type === 'message.delta' || event.type === 'reasoning.delta';
}

function findRunningActivity(activities: RunActivity[], event: { invocationId?: string; toolName: string }) {
  return [...activities].reverse().find((item) => event.invocationId
    ? item.invocationId === event.invocationId
    : !item.invocationId && item.toolName === event.toolName && item.status === 'running');
}

function mergeActivityDetail(current?: string, next?: string): string | undefined {
  if (!next) return current;
  if (!current) return next.slice(0, 12_000);
  if (current.includes(next)) return current;
  return `${current}\n\n${next}`.slice(0, 12_000);
}

function looksLikeReasoningBlock(text: string) {
  const trimmed = text.replace(/\u0000/g, '').trim();
  if (!trimmed) return false;
  if (/<think[\s>]|<\/think>/i.test(trimmed)) return true;
  return /^(let me\b|i(?:'| wi)ll\b|first[, ]|the workspace is\b|given the breadth\b|rather than\b|i have solid domain knowledge\b|i[' ]?ll proceed\b|let me write\b|我先|让我先|先检查一下|先看一下|我将先|下面我会)/i.test(trimmed);
}

function splitTaggedReasoning(raw: string, inThinkBlock: boolean) {
  let visible = '';
  let reasoning = '';
  let rest = raw;
  let active = inThinkBlock;
  while (rest.length) {
    if (active) {
      const end = rest.search(/<\/think>/i);
      if (end < 0) {
        reasoning += rest;
        rest = '';
      } else {
        reasoning += rest.slice(0, end);
        rest = rest.slice(end).replace(/<\/think>/i, '');
        active = false;
      }
      continue;
    }
    const start = rest.search(/<think(?:\s[^>]*)?>/i);
    if (start < 0) {
      visible += rest;
      rest = '';
    } else {
      visible += rest.slice(0, start);
      rest = rest.slice(start).replace(/<think(?:\s[^>]*)?>/i, '');
      active = true;
    }
  }
  return { visible, reasoning, inThinkBlock: active };
}

/**
 * Executes one agent attempt and records a durable RunRecord.
 *
 * Resumable-run semantics (M0):
 * - A tool that needs approval yields `tool.approval_required`. The engine
 *   keeps collecting events until the model turn settles, then marks the run
 *   `waiting-approval` instead of `completed`.
 * - The caller resolves approvals and starts a *new attempt* of the same turn
 *   with the granted capabilities merged into the request (see chat-session /
 *   project service). Deltas are streamed live over the hub and only final
 *   state is persisted, so approvals/artifacts/activities survive restarts.
 */
export class RunEngine {
  constructor(
    readonly store: KeyValueStore,
    private readonly runner: AgentRunner,
    private readonly hub: EventHub<OrcEvent>,
    private readonly dispatcher: ExecutionDispatcher,
    private readonly runTimeoutMs = 1_800_000,
  ) {}

  private runKey(runId: string): string {
    return namespaceKey(RUN_NS, runId);
  }

  async load(runId: string): Promise<RunRecord | null> {
    return readJson<RunRecord>(this.store, this.runKey(runId));
  }

  async save(run: RunRecord): Promise<void> {
    await writeJson(this.store, this.runKey(run.id), run);
  }

  /** All persisted run records (for usage aggregation). */
  async listRuns(): Promise<RunRecord[]> {
    const keys = await this.store.keys(`${RUN_NS}:`);
    const runs: RunRecord[] = [];
    for (const key of keys) {
      const run = await readJson<RunRecord>(this.store, key);
      if (run) runs.push(run);
    }
    return runs;
  }

  /** Record an approval decision on a run (called by chat/project services). */
  async decideApproval(runId: string, approvalId: string, decision: { allow: boolean; scope?: 'session' | 'always' }): Promise<RunRecord | null> {
    const run = await this.load(runId);
    if (!run) return null;
    const approval = run.approvals.find((item) => item.id === approvalId);
    if (!approval || approval.status !== 'pending') return run;
    approval.status = decision.allow ? 'allowed' : 'denied';
    approval.scope = decision.allow ? decision.scope ?? 'session' : undefined;
    approval.resolvedAt = Date.now();
    await this.save(run);
    this.hub.publish(`run:${runId}`, { type: 'run.approval', runId, approval: { ...approval } });
    return run;
  }

  /**
   * Start an attempt and drive it to completion. Resolves once the run
   * settles. Persisted status transitions happen here; message deltas are
   * only streamed.
   */
  async execute(options: ExecuteAttemptOptions): Promise<RunRecord> {
    const runId = options.runId ?? randomUUID();
    const attemptNo = options.attemptNo ?? 1;
    const now = Date.now();
    const run: RunRecord = {
      id: runId,
      orgId: options.orgId,
      ownerUserId: options.ownerUserId ?? options.userId,
      userId: options.userId ?? options.ownerUserId,
      accessScope: options.accessScope ?? 'private',
      accessGrants: [...(options.accessGrants ?? [])],
      sessionId: options.sessionId,
      kind: options.kind,
      taskId: options.taskId,
      turnId: options.turnId,
      attemptNo,
      status: 'running',
      startedAt: now,
      transcript: '',
      reasoning: '',
      activities: [],
      approvals: [],
      artifacts: [],
      sources: [],
      eventLog: [],
      model: modelInfoFromRequest(options.request.model),
    };

    const topic = `run:${runId}`;
    const sessionTopic = `session:${options.sessionId}`;
    const topics = [...new Set([topic, sessionTopic, ...(options.extraTopics ?? [])])];
    const publish = (event: OrcEvent) => {
      for (const item of topics) this.hub.publish(item, event);
    };

    // Persist a 'running' record BEFORE the attempt starts. Consumers
    // (RunEngine.load / runStatusOf / waitRunningSettle / isParked and the
    // renderer's settle waiters) treat a missing run record as "settled", so
    // without this the scheduler would see the run as finished while it is
    // still executing and never advance to the next task.
    await this.save(run);
    publish({ type: 'run.started', runId, sessionId: options.sessionId, kind: options.kind, taskId: options.taskId, attemptNo });
    let inThinkBlock = false;

    const emit = (event: AgentEvent) => {
      if (event.type === 'reasoning.delta' && event.text) {
        run.reasoning = `${run.reasoning || ''}${event.text}`;
        publish({ type: 'run.reasoning.delta', runId, sessionId: options.sessionId, text: event.text, textOffset: run.reasoning.length - event.text.length });
        scheduleCheckpoint();
        return;
      }
      if (event.type === 'message.delta' && event.text) {
        const raw = event.text.startsWith('\u0000') ? event.text.slice(1) : event.text;
        const tagged = splitTaggedReasoning(raw, inThinkBlock);
        inThinkBlock = tagged.inThinkBlock;
        let visible = tagged.visible;
        let reasoning = tagged.reasoning;
        if (!visible.trim() && !tagged.reasoning.trim() && looksLikeReasoningBlock(raw)) {
          reasoning = `${reasoning}${raw}`;
          visible = '';
        } else if (!run.transcript.trim() && !tagged.reasoning.trim() && looksLikeReasoningBlock(raw)) {
          reasoning = raw;
          visible = '';
        }
        if (reasoning) {
          run.reasoning = `${run.reasoning || ''}${reasoning}`;
          publish({ type: 'run.reasoning.delta', runId, sessionId: options.sessionId, text: reasoning, textOffset: run.reasoning.length - reasoning.length });
        }
        if (visible) {
          run.transcript += visible;
          publish({ type: 'run.delta', runId, sessionId: options.sessionId, text: visible, textOffset: run.transcript.length - visible.length });
        }
        if (visible || reasoning) scheduleCheckpoint();
        return;
      }
      run.eventLog.push(event);
      if (run.eventLog.length > 500) run.eventLog.splice(0, run.eventLog.length - 500);
      switch (event.type) {
        case 'run.started': {
          if (event.engine) {
            run.engine = event.engine;
            publish({
              type: 'run.engine',
              runId,
              sessionId: options.sessionId,
              engine: event.engine,
            });
          }
          scheduleCheckpoint();
          break;
        }
        case 'tool.started': {
          const now = Date.now();
          const activity: RunActivity = { invocationId: event.invocationId, toolName: event.toolName, summary: event.summary, detail: event.detail, status: 'running', startedAt: now, at: now };
          run.activities.push(activity);
          publish({ type: 'run.activity', runId, activity });
          scheduleCheckpoint();
          break;
        }
        case 'tool.progress': {
          const existing = findRunningActivity(run.activities, event);
          const now = Date.now();
          const activity: RunActivity = existing
            ? Object.assign(existing, { summary: event.summary, progress: event.progress, detail: mergeActivityDetail(existing.detail, event.detail), at: now })
            : { invocationId: event.invocationId, toolName: event.toolName, summary: event.summary, detail: event.detail, status: 'running', progress: event.progress, startedAt: now, at: now };
          if (!existing) run.activities.push(activity);
          publish({ type: 'run.activity', runId, activity: { ...activity } });
          scheduleCheckpoint();
          break;
        }
        case 'tool.completed': {
          const existing = findRunningActivity(run.activities, event);
          const now = Date.now();
          // Keep the started summary (often includes args); only flip status.
          const activity: RunActivity = existing
            ? Object.assign(existing, {
                status: event.ok ? 'completed' : 'failed',
                detail: mergeActivityDetail(existing.detail, event.detail),
                durationMs: Math.max(0, now - (existing.startedAt ?? existing.at)),
                at: now,
              })
            : {
                invocationId: event.invocationId, toolName: event.toolName,
                summary: event.summary,
                detail: event.detail,
                status: event.ok ? 'completed' : 'failed',
                startedAt: now,
                durationMs: 0,
                at: now,
              };
          if (!existing) run.activities.push(activity);
          publish({ type: 'run.activity', runId, activity: { ...activity } });
          scheduleCheckpoint();
          break;
        }
        case 'tool.failed': {
          const existing = findRunningActivity(run.activities, event);
          const now = Date.now();
          const activity: RunActivity = existing
            ? Object.assign(existing, {
                status: 'failed',
                summary: event.summary && !existing.summary.includes(event.summary)
                  ? `${existing.summary} — ${event.summary}`
                  : (existing.summary || event.summary),
                detail: mergeActivityDetail(existing.detail, event.detail),
                durationMs: Math.max(0, now - (existing.startedAt ?? existing.at)),
                at: now,
              })
            : {
                invocationId: event.invocationId, toolName: event.toolName,
                summary: event.summary,
                detail: event.detail,
                status: 'failed',
                startedAt: now,
                durationMs: 0,
                at: now,
              };
          if (!existing) run.activities.push(activity);
          publish({ type: 'run.activity', runId, activity: { ...activity } });
          scheduleCheckpoint();
          break;
        }
        case 'capability.started': {
          const now = Date.now();
          const activity: RunActivity = { invocationId: event.invocationId, toolName: `model:${event.capability}`, summary: event.summary, status: 'running', startedAt: now, at: now };
          run.activities.push(activity);
          publish({ type: 'run.activity', runId, activity });
          scheduleCheckpoint();
          break;
        }
        case 'capability.progress': {
          const toolName = `model:${event.capability}`;
          const existing = findRunningActivity(run.activities, { invocationId: event.invocationId, toolName });
          const now = Date.now();
          const activity: RunActivity = existing
            ? Object.assign(existing, { summary: event.summary, progress: event.progress, at: now })
            : { invocationId: event.invocationId, toolName, summary: event.summary, status: 'running', progress: event.progress, startedAt: now, at: now };
          if (!existing) run.activities.push(activity);
          publish({ type: 'run.activity', runId, activity: { ...activity } });
          scheduleCheckpoint();
          break;
        }
        case 'capability.completed':
        case 'capability.failed': {
          const toolName = `model:${event.capability}`;
          const existing = findRunningActivity(run.activities, { invocationId: event.invocationId, toolName });
          const failed = event.type === 'capability.failed' || (event.type === 'capability.completed' && !event.ok);
          const now = Date.now();
          const activity: RunActivity = existing
            ? Object.assign(existing, { status: failed ? 'failed' : 'completed', ...(failed ? { summary: event.summary } : {}), progress: failed ? existing.progress : 100, durationMs: Math.max(0, now - (existing.startedAt ?? existing.at)), at: now })
            : { invocationId: event.invocationId, toolName, summary: event.summary, status: failed ? 'failed' : 'completed', progress: failed ? undefined : 100, startedAt: now, durationMs: 0, at: now };
          if (!existing) run.activities.push(activity);
          publish({ type: 'run.activity', runId, activity: { ...activity } });
          scheduleCheckpoint();
          break;
        }
        case 'tool.approval_required': {
          const approval: RunApproval = {
            id: randomUUID(),
            skillId: event.skillId,
            capability: event.capability as GrantCapability,
            summary: event.summary,
            status: 'pending',
            at: Date.now(),
          };
          run.approvals.push(approval);
          publish({ type: 'run.approval', runId, approval });
          // Approvals must survive a process restart so the UI can resume.
          void this.save(run);
          break;
        }
        case 'artifact.created': {
          const artifact = { path: event.path };
          if (run.artifacts.some((item) => item.path === artifact.path)) {
            scheduleCheckpoint();
            break;
          }
          run.artifacts.push(artifact);
          publish({ type: 'run.artifact', runId, artifact });
          scheduleCheckpoint();
          break;
        }
        case 'project.file.published': {
          const artifact = { path: event.projectPath };
          const isNewArtifact = !run.artifacts.some((item) => item.path === artifact.path);
          if (isNewArtifact) run.artifacts.push(artifact);
          publish({
            type: 'project.file.published',
            runId,
            path: event.path,
            projectPath: event.projectPath,
            projectId: options.kind === 'project-task' ? options.sessionId : undefined,
          });
          // Do not re-broadcast run.artifact when the same path was already archived mid-run.
          if (isNewArtifact) publish({ type: 'run.artifact', runId, artifact });
          scheduleCheckpoint();
          break;
        }
        case 'search.sources': {
          run.sources = event.sources.map((source) => ({ ...source }));
          publish({ type: 'run.sources', runId, sources: run.sources });
          scheduleCheckpoint();
          break;
        }
        case 'run.usage': {
          applyUsageEvent(run, event.usage, event.model, event.capability);
          publish({
            type: 'run.usage',
            runId,
            sessionId: options.sessionId,
            usage: run.usage!,
            model: run.model,
          });
          scheduleCheckpoint();
          break;
        }
        default:
          scheduleCheckpoint();
          break;
      }
    };

    // Persist mid-run progress so a desktop/API restart does not leave an empty
    // "running" record with no activities (workspace files may already exist).
    let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
    let checkpointDirty = false;
    const flushCheckpoint = () => {
      checkpointTimer = undefined;
      if (!checkpointDirty || run.status !== 'running') return;
      checkpointDirty = false;
      void this.save(run);
    };
    const scheduleCheckpoint = () => {
      checkpointDirty = true;
      if (checkpointTimer) return;
      checkpointTimer = setTimeout(flushCheckpoint, 1_500);
    };

    const abortController = new AbortController();
    const onAbort = () => abortController.abort(signal?.reason);
    const signal = options.signal;
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timeoutMs = Math.min(7_200_000, Math.max(5_000, options.timeoutMs ?? options.request.runTimeoutMs ?? this.runTimeoutMs));
    const timeoutId = setTimeout(() => abortController.abort(new Error(`Run timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);

    try {
      const conversationId = String(options.request.conversationId || '').trim()
        || (options.kind === 'chat' ? options.sessionId : '');
      const request: ChatRequest = {
        ...options.request,
        runId,
        runTimeoutMs: timeoutMs,
        // Used by preview_server_start to map conversation SITE asset bundles.
        // Does not change run workspace isolation.
        ...(conversationId ? { conversationId } : {}),
      };
      await this.dispatcher.dispatch({
        runId,
        orgId: options.orgId,
        userId: options.ownerUserId ?? options.userId,
        sessionId: options.sessionId,
        kind: options.kind,
        priority: options.kind === 'chat' ? 'high' : 'normal',
        signal: abortController.signal,
        execute: () => this.runner.start(request, emit, { abortSignal: abortController.signal }),
      });
    } catch (error) {
      const diagnosed = diagnoseModelFailure(error, { phase: 'execution', elapsedMs: Date.now() - run.startedAt });
      if (!abortController.signal.aborted) {
        run.status = 'failed';
        run.error = diagnosed.message;
        run.failure = diagnosed.failure;
      }
    } finally {
      if (checkpointTimer) clearTimeout(checkpointTimer);
      checkpointDirty = false;
    }

    // Agent-core already emits run.completed / run.failed / run.cancelled as
    // events; map terminal state from the event log when needed.
    const lastTerminal = [...run.eventLog].reverse().find((event) => event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled');
    if (lastTerminal && run.status !== 'failed') {
      switch (lastTerminal.type) {
        case 'run.failed':
          run.status = 'failed';
          run.error = lastTerminal.message;
          run.failure = lastTerminal.failure;
          break;
        case 'run.cancelled':
          run.status = 'cancelled';
          run.error = lastTerminal.message;
          run.cancelReason = lastTerminal.reason;
          break;
        case 'run.completed':
          run.status = 'completed';
          break;
      }
    } else if (run.status === 'running') {
      run.status = abortController.signal.aborted ? 'cancelled' : 'failed';
      if (!run.error) {
        const reason = abortController.signal.reason instanceof Error
          ? abortController.signal.reason.message
          : typeof abortController.signal.reason === 'string'
            ? abortController.signal.reason
            : '';
        run.error = abortController.signal.aborted
          ? (reason || '已中止当前执行。')
          : 'Model request failed.';
      }
    }

    const pending = run.approvals.filter((approval) => approval.status === 'pending');
    if (run.status === 'completed' && pending.length > 0) {
      run.status = 'waiting-approval';
    }
    // A provider may report completion while ignoring an already cancelled signal.
    if (abortController.signal.aborted && (run.status === 'completed' || run.status === 'waiting-approval')) {
      run.status = 'cancelled';
      run.error = abortController.signal.reason instanceof Error ? abortController.signal.reason.message : '已中止当前执行。';
      run.cancelReason = signal?.aborted ? 'user' : 'timeout';
    }
    if (run.status === 'completed' && options.finalizeCompleted) {
      try { await options.finalizeCompleted(run, emit); }
      catch (cause) {
        run.status = 'failed';
        run.error = cause instanceof Error ? cause.message : '交付处理失败。';
        emit({ type: 'run.failed', runId, message: run.error });
      } finally {
        // Finalizer events use the same recorder, but cannot leave a late checkpoint.
        if (checkpointTimer) clearTimeout(checkpointTimer);
        checkpointDirty = false;
      }
    }
    // Completed local copies survive cancellation, but cannot announce success.
    if (abortController.signal.aborted && run.status === 'completed') {
      run.status = 'cancelled';
      run.error = abortController.signal.reason instanceof Error ? abortController.signal.reason.message : '已中止当前执行。';
      run.cancelReason = signal?.aborted ? 'user' : 'timeout';
    }
    // Close any activity rows that never received tool.completed (lost events / parallel same-name).
    for (const activity of run.activities) {
      if (activity.status !== 'running') continue;
      const now = Date.now();
      if (run.status === 'completed' || run.status === 'waiting-approval') {
        activity.status = 'completed';
        activity.summary = activity.summary.includes('完成') ? activity.summary : `${activity.summary}（已完成）`;
      } else {
        activity.status = 'failed';
        activity.summary = activity.summary.includes('中止') ? activity.summary : `${activity.summary}（已中止）`;
      }
      activity.durationMs = Math.max(0, now - (activity.startedAt ?? activity.at));
      activity.at = now;
      publish({ type: 'run.activity', runId, activity: { ...activity } });
    }
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onAbort);
    run.finishedAt = Date.now();
    await this.save(run);
    publish({ type: 'run.settled', runId, sessionId: options.sessionId, status: run.status, error: run.error, failure: run.failure });
    if (run.usage) {
      // Dynamic import avoids a circular init with usage.ts; compaction is best-effort.
      void import('./usage.js')
        .then((mod) => mod.maybeCompactUsage({ store: this.store, engine: this }))
        .catch(() => undefined);
    }
    return run;
  }

  /**
   * Mark chat runs left in `running` after a process restart as cancelled.
   * Project-task orphans are handled by ProjectService.recoverOrphanedExecution.
   */
  async recoverOrphanedRuns(): Promise<number> {
    const keys = await this.store.keys(`${RUN_NS}:`);
    let count = 0;
    for (const key of keys) {
      const run = await readJson<RunRecord>(this.store, key);
      if (!run || run.status !== 'running') continue;
      if (run.kind === 'project-task') continue;
      run.status = 'cancelled';
      run.error = '执行进程已中断，对话回合未正常结束。';
      run.cancelReason = 'user';
      run.finishedAt = Date.now();
      await this.save(run);
      this.hub.publish(`run:${run.id}`, {
        type: 'run.settled',
        runId: run.id,
        sessionId: run.sessionId,
        status: run.status,
        error: run.error,
      });
      this.hub.publish(`session:${run.sessionId}`, {
        type: 'run.settled',
        runId: run.id,
        sessionId: run.sessionId,
        status: run.status,
        error: run.error,
      });
      count += 1;
    }
    return count;
  }
}

export type { GrantCapability };
