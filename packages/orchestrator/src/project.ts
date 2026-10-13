import { randomUUID } from 'node:crypto';
import { prepareConversationWorkspace, publishConversationWorkspace } from './project-workspace.js';
import os from 'node:os';
import path from 'node:path';
import { cleanWorkspaceScrap, promoteWorkspaceDeliverablesToProject } from '@workmate/agent-core';
import type { EventHub, HubListener } from './hub.js';
import { deleteKey, listJsonIds, readJson, writeJson } from './repo.js';
import type { OrcEvent } from './events.js';
import { RunEngine } from './run-engine.js';
import type { ChatRunContext } from './chat-session.js';
import type { KeyValueStore } from './storage/kv.js';
import { namespaceKey } from './storage/kv.js';
import { withKeyLock } from './lock.js';
import type {
  GrantCapability,
  Project,
  ProjectMessage,
  ProjectRun,
  ProjectTask,
  ProjectTaskContract,
  RunRecord,
} from './types.js';
import {
  applyPlanningStrategy,
  bumpPlan,
  buildAttemptKey,
  concurrencyForStrategy,
  createChangeSet,
  ensureProjectPlan,
  invalidateTaskCascade,
  isDependencySatisfied,
  isTerminalTaskStatus,
  mergeReplanTasks,
  normalizeContract,
  pushChangeSet,
} from './project-plan.js';
import { buildDependencyBlock, buildSummaryEvidence, fitObjective } from './context-budget.js';

export const PROJECT_KEY_PREFIX = 'projects:';
export const PROJECT_RUN_KEY_PREFIX = 'project-run:';
const PROJECT_NS = 'projects';
const PROJECT_RUN_NS = 'project-run';

const PARKED_POLL_MS = 400;

/** Attempt identity prevents a follow-up from replacing an older answer to the same task. */
function appendTaskReply(project: Project, task: ProjectTask, run: RunRecord, projectRunId?: string) {
  if (run.status === 'running' || run.status === 'waiting-approval') return;
  const transcript = run.transcript.trim();
  const content = run.status === 'failed' && run.failure?.code === 'UPSTREAM_BALANCE' && run.error
    ? [transcript, `⚠ 本次执行未完成：${run.error}`].filter(Boolean).join('\n\n')
    : transcript || run.error;
  if (!content || project.messages.some(message => message.id === run.id)) return;
  project.messages.push({ id: run.id, role: 'assistant', content, employeeId: task.employeeId, taskId: task.id,
    runId: projectRunId, createdAt: run.finishedAt ?? Date.now() });
}

function runWorkspaceRoot(runId: string) {
  return path.join(
    process.env.WORKMATE_WORKSPACES_DIR || path.join(os.homedir(), '.workmate', 'workspaces'),
    runId,
  );
}

function isRetryableRunFailure(error?: string | null) {
  const text = String(error || '');
  if (!text) return false;
  return /reasoning_content|Expected ',' or '\]' after array element in JSON|Unexpected token .* in JSON|Unterminated string|Bad control character|JSON at position|Invalid input|tool arguments/i.test(text)
    || /network|timeout|timed out|socket hang up|econnreset|econnaborted|fetch failed/i.test(text.toLowerCase());
}

/** Step-budget abort after real deliverables should not fail the whole DAG node. */
function isStepBudgetFailureWithDeliverables(run: RunRecord) {
  const text = String(run.error || '');
  if (!/工具调用步数超过上限|步数超过上限|max steps|step limit/i.test(text)) return false;
  return (run.artifacts?.length ?? 0) > 0;
}

export interface ProjectTaskDraft {
  /** Stable client id (optional); preserved so dependsOn references survive. */
  id?: string;
  title: string;
  objective: string;
  employeeId: string;
  skillIds: string[];
  dependsOn?: string[];
  /** Optional task contract (outputs / acceptance / retry). */
  contract?: ProjectTaskContract;
  permissionTier?: ProjectTask['permissionTier'];
}

export interface CreateProjectDraftInput {
  kind?: 'conversation';
  defaultEmployeeId?: string;
  name?: string;
  goal: string;
  mode: 'waterfall' | 'parallel' | 'discussion' | 'dag';
  workspacePath: string;
  executionWorkspaceMode?: 'isolated';
  orgId?: string;
  ownerUserId?: string;
  userId?: string;
  accessScope?: Project['accessScope'];
  accessGrants?: Project['accessGrants'];
  coordinator?: { provider: string; model: string };
  tasks: ProjectTaskDraft[];
}

export interface ProjectServiceOptions {
  store: KeyValueStore;
  hub: EventHub<OrcEvent>;
  engine: RunEngine;
  runTimeoutMs?: number;
  projectTaskTimeoutMs?: number;
  /** Keep project scheduling at or below dispatcher capacity. */
  maxConcurrentProjectTasks?: number;
  /**
   * Optional fallback that resolves a run context for a task when the caller
   * did not supply `runContextByTask`/`defaultContext` (e.g. a remote gateway
   * confirming a project). Return null to leave the task failed with a clear
   * message. Never persists secrets.
   */
  contextResolver?: (task: ProjectTask, ownerUserId?: string) => ChatRunContext | null | Promise<ChatRunContext | null>;
}

export interface ConfirmProjectInput {
  /** Explicit recovery of a failed/cancelled project; successful nodes stay intact. */
  resumeIncomplete?: boolean;
  /** Per-task resolved run context (required unless `defaultContext` covers it). */
  runContextByTask?: Record<string, ChatRunContext>;
  /** Fallback context for tasks without an explicit entry. */
  defaultContext?: ChatRunContext;
  /** Optional coordinator context; when given the project runs a summary turn. */
  summaryContext?: ChatRunContext;
  /** Optional ChangeSet that opened this run (instruction / invalidate). */
  changeSetId?: string;
}

export interface ResolveProjectApprovalInput {
  projectId: string;
  taskId: string;
  approvalId: string;
  allow: boolean;
  scope?: 'session' | 'always';
  /** Context needed to re-run the task attempt after granting. */
  resumeContext?: ChatRunContext;
}

function draftToTask(draft: ProjectTaskDraft): ProjectTask {
  return {
    id: draft.id ?? randomUUID(),
    title: draft.title.trim().slice(0, 120) || '未命名任务',
    objective: draft.objective.trim(),
    employeeId: draft.employeeId,
    skillIds: [...(draft.skillIds ?? [])],
    dependsOn: [...(draft.dependsOn ?? [])],
    permissionTier: draft.permissionTier ?? 'default',
    status: 'draft',
    attempts: 0,
    contract: normalizeContract(draft.contract),
  };
}

/** Validate dependsOn references and reject cycles before the scheduler runs. */
export function validateProjectTaskGraph(
  tasks: Array<{ id: string; title?: string; dependsOn?: string[]; status?: string }>,
): void {
  const active = tasks.filter((task) => task.status !== 'superseded');
  const ids = new Set(active.map((task) => task.id));
  for (const task of active) {
    for (const dep of task.dependsOn ?? []) {
      if (!ids.has(dep)) {
        throw new Error(`任务「${task.title || task.id}」依赖了不存在的任务。`);
      }
    }
  }
  const byId = new Map(active.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error('任务依赖存在环，无法调度。');
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of active) visit(task.id);
}

export interface DispatchProjectInstructionInput {
  employeeId: string;
  content: string;
  /** Optional display label for the system/user message (e.g. employee name). */
  employeeLabel?: string;
}

export interface ReplanProjectInput {
  tasks: ProjectTaskDraft[];
  note?: string;
}

export interface UpdateProjectAccessInput {
  accessScope?: Project['accessScope'];
  accessGrants?: Project['accessGrants'];
}

interface MutateResult<R> {
  project: Project;
  result: R;
}

function normalizeProjectOwnership(project: Project): Project {
  const ownerUserId = project.ownerUserId ?? project.userId;
  if (ownerUserId) {
    project.ownerUserId = ownerUserId;
    project.userId = project.userId ?? ownerUserId;
  }
  project.accessScope = project.accessScope ?? 'private';
  project.accessGrants = Array.isArray(project.accessGrants) ? project.accessGrants : [];
  return project;
}

function normalizeProjectRunOwnership(run: ProjectRun): ProjectRun {
  const ownerUserId = run.ownerUserId ?? run.userId;
  if (ownerUserId) {
    run.ownerUserId = ownerUserId;
    run.userId = run.userId ?? ownerUserId;
  }
  run.accessScope = run.accessScope ?? 'private';
  run.accessGrants = Array.isArray(run.accessGrants) ? run.accessGrants : [];
  return run;
}

export class ProjectService {
  private readonly store: KeyValueStore;
  private readonly hub: EventHub<OrcEvent>;
  private readonly engine: RunEngine;
  private readonly runTimeoutMs: number;
  private readonly projectTaskTimeoutMs: number;
  private readonly maxConcurrentProjectTasks: number;
  private readonly taskAborts = new Map<string, AbortController>();
  private readonly contextResolver?: ProjectServiceOptions['contextResolver'];
  /** Transient (never persisted): summary context keyed by active run id. */
  private readonly summaryContextByRun = new Map<string, ChatRunContext>();
  /** Event-driven schedule waiters (P2): wake drain when a task settles. */
  private readonly scheduleWaiters = new Map<string, Set<() => void>>();
  /** Monotonic pulse counter to avoid lost wakeups between wait calls. */
  private readonly scheduleEpoch = new Map<string, number>();
  /** In-flight task starts for a project run (dedupe concurrent pulses). */
  private readonly launchingTasks = new Map<string, Set<string>>();
  /** Ownership spans the entire scheduler, not only individual execute calls. */
  private readonly liveProjectRuns = new Map<string, string>();

  constructor(options: ProjectServiceOptions) {
    this.store = options.store;
    this.hub = options.hub;
    this.engine = options.engine;
    this.runTimeoutMs = options.runTimeoutMs ?? 1_800_000;
    this.projectTaskTimeoutMs = Math.min(7_200_000, Math.max(30_000, options.projectTaskTimeoutMs ?? 1_200_000));
    this.maxConcurrentProjectTasks = Math.max(1, Math.round(options.maxConcurrentProjectTasks ?? 2));
    this.contextResolver = options.contextResolver;
  }

  private projectKey(id: string): string {
    return namespaceKey(PROJECT_NS, id);
  }

  private projectRunKey(id: string): string {
    return namespaceKey(PROJECT_RUN_NS, id);
  }

  /**
   * After an API/desktop process restart, in-flight `execute()` calls are gone
   * but RunRecords may still say `running`. Settle those orphans, promote any
   * leftover workspace deliverables, and close project runs that can finish.
   */
  async recoverOrphanedExecution(): Promise<{ projects: number; tasks: number }> {
    const ids = await listJsonIds(this.store, PROJECT_KEY_PREFIX);
    let projectsTouched = 0;
    let tasksTouched = 0;
    for (const id of ids) {
      // Boot recovery may overlap the first API requests. Serialize with all
      // scheduler writes and never save a snapshot captured before a live run.
      const recovered = await withKeyLock(`project-doc:${id}`, async () => {
        const project = await this.getProject(id);
        if (!project || project.status !== 'running' || this.liveProjectRuns.has(id)) return null;
        let changed = false;
        for (const task of project.tasks) {
          if (task.status !== 'running' || !task.runId) continue;
          // Live attempts register an AbortController; absence means orphaned.
          if (this.taskAborts.has(task.id)) continue;
          const run = await this.engine.load(task.runId);
          if (run?.status === 'waiting-approval') continue;
          if (run && run.status !== 'running') {
            if (run.status === 'completed') {
              task.status = 'completed';
              task.error = run.error;
            } else {
              task.status = run.status === 'cancelled' ? 'cancelled' : 'failed';
              task.error = run.error;
            }
            task.finishedAt = run.finishedAt ?? Date.now();
            changed = true;
            tasksTouched += 1;
            continue;
          }
          const settled = await this.settleOrphanedTask(project, task, run);
          if (settled) {
            changed = true;
            tasksTouched += 1;
          }
        }

        // Scheduler orphan: project still "running" but no live execute() and no
        // task currently running — remaining queued work will never start.
        const hasLiveAttempt = project.tasks.some((task) => this.taskAborts.has(task.id));
        const hasRunningTask = project.tasks.some((task) => task.status === 'running');
        if (!hasLiveAttempt && !hasRunningTask && project.activeRunId) {
          for (const task of project.tasks) {
            if (task.status !== 'queued') continue;
            task.status = 'failed';
            task.error = '调度进程已中断，排队任务未执行。可点击「恢复执行」继续未完成步骤。';
            task.finishedAt = Date.now();
            changed = true;
            tasksTouched += 1;
          }
        }

        if (!changed && hasLiveAttempt) return null;
        if (!changed && hasRunningTask) return null;
        // Even with no task mutations, close a project whose tasks are all terminal.
        const allTerminal = project.tasks.every(
          (task) => task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled',
        );
        if (!changed && !(allTerminal && project.activeRunId)) return null;

        projectsTouched += 1;
        await this.saveProject(project);
        this.hub.publish(`project:${project.id}`, { type: 'project.updated', projectId: project.id });
        return { id: project.id, activeRunId: project.activeRunId };
      });
      if (recovered) await this.maybeFinish(recovered.id, recovered.activeRunId);
    }
    return { projects: projectsTouched, tasks: tasksTouched };
  }

  private async settleOrphanedTask(project: Project, task: ProjectTask, run: RunRecord | null): Promise<boolean> {
    if (!task.runId) return false;
    const workspaceRoot = runWorkspaceRoot(task.runId);
    let published = 0;
    if (project.workspacePath && project.kind !== 'conversation') {
      try {
        published = (await promoteWorkspaceDeliverablesToProject(workspaceRoot, project.workspacePath)).length;
      } catch {
        published = 0;
      }
    }
    const hasProgress =
      Boolean(run?.transcript?.trim()) ||
      (run?.activities?.length ?? 0) > 0 ||
      (run?.artifacts?.length ?? 0) > 0 ||
      published > 0;
    const now = Date.now();
    const message = hasProgress
      ? `执行进程已中断；已根据运行工作区回收 ${published || run?.artifacts?.length || 0} 个交付物。`
      : '执行进程已中断，任务未正常结束。可重试该任务。';

    if (run && run.status === 'running') {
      run.status = 'failed';
      run.error = message;
      run.finishedAt = now;
      if (hasProgress && !run.transcript.trim()) {
        run.transcript = `（任务产出已写入工作区；${message}）`;
      } else if (!hasProgress && !run.transcript.trim()) {
        run.transcript = message;
      }
      await this.engine.save(run);
      const settled = {
        type: 'run.settled' as const,
        runId: run.id,
        sessionId: run.sessionId,
        status: run.status,
        error: run.error,
      };
      this.hub.publish(`run:${run.id}`, settled);
      this.hub.publish(`project:${project.id}`, settled);
    }

    task.status = 'failed';
    task.finishedAt = now;
    task.error = message;
    this.hub.publish(`project:${project.id}`, {
      type: 'project.task',
      projectId: project.id,
      taskId: task.id,
      status: task.status,
      runId: task.runId,
    });
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Project CRUD (draft state)
   * ------------------------------------------------------------------ */

  /** Trusted service entry for recoverable preparation across separate stores. */
  async createDraftOnce(id: string, input: CreateProjectDraftInput): Promise<Project> {
    return withKeyLock(`project-create:${id}`, async () => {
      const existing = await this.getProject(id);
      if (existing) {
        if (existing.orgId !== input.orgId || (existing.ownerUserId ?? existing.userId) !== (input.ownerUserId ?? input.userId)) throw new Error('Project ownership mismatch.');
        return existing;
      }
      return this.createDraft(input, id);
    });
  }

  async createDraft(input: CreateProjectDraftInput, reservedId?: string): Promise<Project> {
    const now = Date.now();
    const ownerUserId = input.ownerUserId ?? input.userId;
    const tasks = input.kind === 'conversation' ? [] : input.tasks.map(draftToTask);
    applyPlanningStrategy(input.mode, tasks);
    validateProjectTaskGraph(tasks);
    const plan = {
      version: 1,
      createdAt: now,
      strategy: input.mode,
      taskIds: tasks.map((task) => task.id),
      note: '初始规划',
    };
    for (const task of tasks) task.planVersion = 1;
    const project: Project = {
      kind: input.kind,
      defaultEmployeeId: input.defaultEmployeeId,
      id: reservedId ?? randomUUID(),
      orgId: input.orgId,
      ownerUserId,
      userId: ownerUserId,
      accessScope: input.accessScope ?? 'private',
      accessGrants: [...(input.accessGrants ?? [])],
      name: (input.name ?? '').trim() || input.goal.trim().slice(0, 32),
      goal: input.goal.trim(),
      status: 'draft',
      mode: input.kind === 'conversation' ? 'dag' : input.mode,
      workspacePath: input.workspacePath,
      executionWorkspaceMode: input.kind === 'conversation' ? 'isolated' : input.executionWorkspaceMode,
      coordinator: input.coordinator,
      grantsSession: {},
      grantsAlways: {},
      tasks,
      plan: input.kind === 'conversation' ? undefined : plan,
      planHistory: [],
      changeSets: [],
      messages: [
        {
          id: randomUUID(),
          role: 'system',
          content:
            input.kind === 'conversation' ? '项目已就绪。发送问题开始工作，成果将保存在当前项目目录。' : '项目已创建（Plan v1）。确认启动后，调度器按 DAG 依赖执行；waterfall/parallel 等仅用于生成边。',
          createdAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    await this.saveProject(project);
    return project;
  }

  /** Replace tasks on a draft project (before any run exists). */
  async updateDraft(id: string, patch: { name?: string; goal?: string; mode?: Project['mode']; workspacePath?: string; tasks?: ProjectTaskDraft[] }): Promise<Project | null> {
    const out = await this.mutateProject(id, (project) => {
      if (project.status !== 'draft') throw new Error('Only draft projects can be edited.');
      if (project.kind === 'conversation' && (patch.tasks || patch.mode || patch.workspacePath)) throw new Error('持续对话项目不能配置 DAG 或更换成果目录。');
      if (patch.name !== undefined) project.name = patch.name.trim().slice(0, 80) || project.name;
      if (patch.goal !== undefined) project.goal = patch.goal.trim();
      if (patch.mode !== undefined) project.mode = patch.mode;
      if (patch.workspacePath !== undefined) project.workspacePath = patch.workspacePath;
      if (patch.tasks) {
        const byId = new Map(project.tasks.map((task) => [task.id, task]));
        const next = patch.tasks.map((draft) => {
          const task = draftToTask(draft);
          const existing = draft.id ? byId.get(draft.id) : undefined;
          if (existing) task.id = existing.id;
          return task;
        });
        validateProjectTaskGraph(next);
        project.tasks = next;
      }
    });
    return out?.project ?? null;
  }

  async updateAccess(id: string, patch: UpdateProjectAccessInput): Promise<Project | null> {
    const out = await this.mutateProject(id, (project) => {
      const scope = patch.accessScope;
      if (scope === 'private' || scope === 'org-shared' || scope === 'delegated') {
        project.accessScope = scope;
      }
      if (Array.isArray(patch.accessGrants)) {
        project.accessGrants = patch.accessGrants
          .filter((grant) => grant?.subjectType === 'user' && grant.subjectId && Array.isArray(grant.permissions) && grant.permissions.length > 0)
          .map((grant) => ({
            subjectType: 'user' as const,
            subjectId: String(grant.subjectId),
            permissions: [...new Set(grant.permissions.filter((item): item is 'read' | 'write' => item === 'read' || item === 'write'))],
            createdAt: Number(grant.createdAt || Date.now()),
            expiresAt: grant.expiresAt ? Number(grant.expiresAt) : undefined,
          }))
          .filter((grant) => grant.permissions.length > 0);
      }
      if (project.accessScope !== 'delegated') project.accessGrants = [];
    });
    return out?.project ?? null;
  }

  /**
   * Rebuild the task graph after roster changes (Plan vN+1).
   * Merges completed nodes when possible; marks removed nodes superseded.
   */
  async replanProject(id: string, input: ReplanProjectInput): Promise<Project | null> {
    if (!input.tasks?.length) throw new Error('tasks are required.');
    const out = await this.mutateProject(id, (project) => {
      if (project.status === 'running') throw new Error('Project is running.');
      if (project.kind === 'conversation') throw new Error('持续对话项目不需要重新规划；请发送消息或调用工作流。');
      ensureProjectPlan(project);
      const incoming = input.tasks.map(draftToTask);
      applyPlanningStrategy(project.mode, incoming);
      const roster = new Set(incoming.map((task) => task.employeeId));
      const merged = mergeReplanTasks(project.tasks, incoming, roster);
      validateProjectTaskGraph(merged);
      const active = merged.filter((task) => task.status !== 'superseded');
      const plan = bumpPlan(
        project,
        input.note ?? '成员变更后重新规划',
        active,
      );
      for (const task of active) {
        if (task.status !== 'completed') {
          task.status = 'draft';
          task.error = undefined;
          task.runId = undefined;
        }
        task.planVersion = plan.version;
      }
      project.tasks = merged;
      project.status = 'draft';
      project.summary = undefined;
      project.activeRunId = undefined;
      const changeSet = createChangeSet({
        kind: 'replan',
        summary: input.note ?? `Plan 升级到 v${plan.version}`,
        targetTaskIds: active.map((task) => task.id),
        invalidatedTaskIds: active.filter((task) => task.status !== 'completed').map((task) => task.id),
        planVersionBefore: plan.version - 1,
        planVersionAfter: plan.version,
      });
      pushChangeSet(project, changeSet);
      project.messages.push({
        id: randomUUID(),
        role: 'system',
        content:
          input.note ??
          `协调员已发布 Plan v${plan.version}：保留可复用的已完成节点，其余任务待调度器按 DAG 执行。`,
        createdAt: Date.now(),
        changeSetId: changeSet.id,
      });
    });
    return out?.project ?? null;
  }

  /**
   * Follow-up instruction as a ChangeSet: invalidate target + downstream (stale),
   * keep upstream completed, then open a new Run via confirm.
   */
  async dispatchInstruction(
    id: string,
    input: DispatchProjectInstructionInput,
    confirmInput: ConfirmProjectInput = {},
  ): Promise<{ project: Project; run: ProjectRun } | null> {
    return withKeyLock(`project-turn:${id}`, () => this.dispatchInstructionUnlocked(id, input, confirmInput));
  }

  private async dispatchInstructionUnlocked(
    id: string,
    input: DispatchProjectInstructionInput,
    confirmInput: ConfirmProjectInput = {},
  ): Promise<{ project: Project; run: ProjectRun } | null> {
    const content = input.content.trim();
    if (!content) throw new Error('Instruction content is required.');
    const employeeId = input.employeeId.trim();
    if (!employeeId) throw new Error('employeeId is required.');
    const label = (input.employeeLabel ?? employeeId).trim() || employeeId;

    let changeSetId: string | undefined;
    await this.mutateProject(id, async (project) => {
      if (project.status === 'running') throw new Error('Project is already running.');
      if (project.kind === 'conversation') {
        // Each send is an independent turn, not a replan of previous work.
        const target = draftToTask({ title: content.slice(0, 80), objective: content, employeeId, skillIds: [], dependsOn: [] });
        project.tasks.push(target);
        project.defaultEmployeeId = employeeId;
        changeSetId = target.id;
        project.messages.push({ id: randomUUID(), role: 'user', content, employeeId, taskId: target.id, changeSetId, createdAt: Date.now() });
        project.summary = undefined;
        return;
      }
      const plan = ensureProjectPlan(project);
      const target =
        [...project.tasks].reverse().find(
          (task) => task.employeeId === employeeId && task.status !== 'superseded',
        ) ??
        project.tasks.find(
          (task) => task.employeeId === employeeId && task.status !== 'superseded',
        );
      if (!target) throw new Error('Selected employee is not a project member.');

      // Older projects did not persist task replies in the project thread. Restore only real Run evidence.
      for (const task of project.tasks) {
        if (!task.runId || project.messages.some(message => message.id === task.runId)) continue;
        const prior = await this.engine.load(task.runId);
        if (prior && prior.status !== 'running') appendTaskReply(project, task, prior);
      }

      const now = Date.now();
      target.followUp = { content, previousRunId: target.runId ?? target.followUp?.previousRunId };
      target.objective = `${target.objective}\n\n本轮项目指令：${content}`;
      const invalidated = invalidateTaskCascade(project.tasks, target.id, {
        planVersion: plan.version,
      });

      const changeSet = createChangeSet({
        kind: 'instruction',
        summary: `@${label}: ${content.slice(0, 120)}`,
        targetTaskIds: [target.id],
        invalidatedTaskIds: invalidated,
        planVersionBefore: plan.version,
        planVersionAfter: plan.version,
      });
      pushChangeSet(project, changeSet);
      changeSetId = changeSet.id;

      project.messages.push({
        id: randomUUID(),
        role: 'user',
        content: `@${label} ${content}`,
        employeeId,
        taskId: target.id,
        createdAt: now,
        changeSetId: changeSet.id,
      });
      project.messages.push({
        id: randomUUID(),
        role: 'system',
        content:
          invalidated.length > 1
            ? `ChangeSet 已应用：失效 ${label} 及 ${invalidated.length - 1} 个下游节点（stale）。上游已完成任务保留；调度器将按 DAG 增量重跑。`
            : `ChangeSet 已应用：失效 ${label}（无下游依赖）。调度器将增量重跑该节点。`,
        createdAt: Date.now(),
        changeSetId: changeSet.id,
      });
      project.summary = undefined;
    });

    const result = await this.confirmProject(id, {
      ...confirmInput,
      changeSetId,
    });
    return result;
  }

  async getProject(id: string): Promise<Project | null> {
    const project = await readJson<Project>(this.store, this.projectKey(id));
    return project ? normalizeProjectOwnership(project) : null;
  }

  async listProjects(): Promise<Project[]> {
    const ids = await listJsonIds(this.store, PROJECT_KEY_PREFIX);
    const projects: Project[] = [];
    for (const id of ids) {
      const project = await this.getProject(id);
      if (project) projects.push(project);
    }
    return projects.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async removeProject(id: string): Promise<void> {
    const project = await this.getProject(id);
    if (!project) return;
    await this.cancelActiveRun(id, 'deleted');
    const workspacePath = String(project.workspacePath || '').trim();
    await deleteKey(this.store, this.projectKey(id));
    const runs = await this.listProjectRuns(id);
    for (const run of runs) await deleteKey(this.store, this.projectRunKey(run.id));
    // Keep deliverables; only scrub Agent process scrap (scripts / .python-packages / …).
    if (workspacePath) await cleanWorkspaceScrap(workspacePath).catch(() => undefined);
  }

  async listProjectRuns(projectId: string): Promise<ProjectRun[]> {
    const keys = await this.store.keys(PROJECT_RUN_KEY_PREFIX);
    const runs: ProjectRun[] = [];
    for (const key of keys) {
      const run = await readJson<ProjectRun>(this.store, key);
      if (run && run.projectId === projectId) runs.push(normalizeProjectRunOwnership(run));
    }
    return runs.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Latest settled run record for a task (transcript/activities/approvals). */
  async taskTranscript(task: ProjectTask): Promise<RunRecord | null> {
    if (!task.runId) return null;
    return this.engine.load(task.runId);
  }

  /* ------------------------------------------------------------------ *
   * Execution
   * ------------------------------------------------------------------ */

  async confirmProject(id: string, input: ConfirmProjectInput = {}): Promise<{ project: Project; run: ProjectRun } | null> {
    const out = await this.mutateProject(id, async (project) => {
      if (project.status === 'running') throw new Error('Project is already running.');
      if (input.resumeIncomplete && project.status !== 'failed' && project.status !== 'cancelled') throw new Error('Only failed or cancelled projects can be resumed.');
      if (project.kind === 'conversation' && !input.changeSetId) throw new Error('请发送新消息继续项目；不会自动重跑历史对话。');
      const plan = project.kind === 'conversation' ? undefined : ensureProjectPlan(project);
      if (project.kind !== 'conversation') applyPlanningStrategy(project.mode, project.tasks.filter((task) => task.status !== 'superseded'));
      validateProjectTaskGraph(project.tasks);
      const activeTasks = project.tasks.filter((task) => task.status !== 'superseded' && (project.kind !== 'conversation' || task.id === input.changeSetId));
      if (project.status === 'draft' && activeTasks.length === 0) throw new Error('Project has no tasks to run.');
      const now = Date.now();
      const restartAll = !input.changeSetId && !input.resumeIncomplete && (project.status === 'completed' || project.status === 'failed' || project.status === 'cancelled');

      // Keep a historical snapshot; follow-ups and recovery retain the visible
      // thread, while explicit full scheduling starts a fresh thread.
      const keepMessages = input.changeSetId || input.resumeIncomplete
        ? project.messages
        : [];
      const archiveMessages = input.changeSetId
        ? project.messages.filter((message) => message.changeSetId !== input.changeSetId)
        : [...project.messages];
      if (archiveMessages.length) {
        const priorRuns = await this.listProjectRuns(project.id);
        const archiveTarget = priorRuns.find((run) => run.status !== 'running') ?? priorRuns[0];
        if (archiveTarget) {
          archiveTarget.messages = archiveMessages.map((message) => ({ ...message }));
          if (!archiveTarget.summary && project.summary) archiveTarget.summary = project.summary;
          await writeJson(this.store, this.projectRunKey(archiveTarget.id), archiveTarget);
        }
      }

      const projectRun: ProjectRun = {
        id: randomUUID(),
        projectId: project.id,
        orgId: project.orgId,
        ownerUserId: project.ownerUserId ?? project.userId,
        userId: project.userId ?? project.ownerUserId,
        accessScope: project.accessScope ?? 'private',
        accessGrants: [...(project.accessGrants ?? [])],
        startedAt: now,
        status: 'running',
        taskIds: activeTasks.map((task) => task.id),
        planVersion: plan?.version,
        changeSetId: input.changeSetId,
        messages: [],
      };
      project.activeRunId = projectRun.id;
      project.status = 'running';
      project.summary = undefined;
      project.messages = [
        ...keepMessages,
        {
          id: randomUUID(),
          role: 'system',
          content: input.resumeIncomplete ? '已恢复未完成步骤，原对话与已完成成果保留。'
            : input.changeSetId ? '已收到补充问题，正在原项目中继续处理。'
            : archiveMessages.length
            ? '新一轮调度已开始。上一轮对话已归档到历史运行。'
            : '本轮调度已开始。',
          createdAt: now,
          runId: projectRun.id,
        },
      ];
      for (const task of project.tasks) {
        if (project.kind === 'conversation' && !activeTasks.includes(task)) continue;
        // Full re-schedule after a terminal project resets completed work; otherwise keep successes.
        if (task.status === 'superseded') continue;
        if (!restartAll && task.status === 'completed') continue;
        task.status = 'queued';
        task.error = undefined;
        task.attempts = 0;
        task.runId = undefined;
        task.startedAt = undefined;
        task.finishedAt = undefined;
      }
      await writeJson(this.store, this.projectRunKey(projectRun.id), projectRun);
      // Register before releasing the document lock: boot recovery must not
      // mistake the gap before runScheduler/execute for an abandoned run.
      this.liveProjectRuns.set(id, projectRun.id);
      return { projectRun };
    });
    if (!out) return null;
    if (input.summaryContext) this.summaryContextByRun.set(out.result.projectRun.id, input.summaryContext);

    void this.runScheduler(id, out.result.projectRun.id, input).catch(async (error) => {
      await this.finishProjectRun(id, out!.result.projectRun.id, 'failed', undefined, error instanceof Error ? error.message : '项目调度失败。');
    });
    return { project: out.project, run: out.result.projectRun };
  }

  async cancelActiveRun(projectId: string, reason = 'user'): Promise<boolean> {
    const out = await this.mutateProject(projectId, async (project) => {
      if (!project.activeRunId) return { cancelled: false };
      const activeRunId = project.activeRunId;
      for (const task of project.tasks) {
        if (task.status === 'running') {
          const abort = this.taskAborts.get(task.id);
          if (abort && !abort.signal.aborted) abort.abort();
        } else if (task.status === 'queued') {
          task.status = 'cancelled';
        }
      }
      project.activeRunId = undefined;
      project.status = 'cancelled';
      project.summary = undefined;
      const run = await readJson<ProjectRun>(this.store, this.projectRunKey(activeRunId));
      if (run) {
        run.status = 'cancelled';
        run.finishedAt = Date.now();
        run.error = '已由用户取消。';
        await writeJson(this.store, this.projectRunKey(run.id), run);
      }
      return { cancelled: true };
    });
    void reason;
    return out?.result.cancelled ?? false;
  }

  /** Re-run one failed/cancelled task (does not restart the whole project). */
  async retryTask(projectId: string, taskId: string, context?: ChatRunContext): Promise<boolean> {
    const project = await this.getProject(projectId);
    const task = project?.tasks.find((item) => item.id === taskId);
    if (!project || !task) throw new Error('Task not found.');
    if (project.status === 'draft') throw new Error('Project has not started yet.');
    if (task.status === 'running') throw new Error('Task is already running.');

    const runContext = context ?? ((await this.contextResolver?.(task, project.ownerUserId ?? project.userId)) ?? undefined);
    if (!runContext) throw new Error('No run context available; configure a model first.');
    const started = await this.startTask(projectId, task, runContext);
    if (started) await this.maybeFinish(projectId);
    return started;
  }

  /** Decide a task's pending approval; when allowed re-runs that task. */
  async resolveProjectApproval(input: ResolveProjectApprovalInput): Promise<{ resumed?: boolean }> {
    const project = await this.getProject(input.projectId);
    const task = project?.tasks.find((item) => item.id === input.taskId);
    if (!project || !task || !task.runId) throw new Error('Task run not found.');
    const run = await this.engine.load(task.runId);
    const approval = run?.approvals.find((item) => item.id === input.approvalId);
    if (!run || !approval || approval.status !== 'pending') throw new Error('Approval is not pending.');

    await this.engine.decideApproval(run.id, input.approvalId, { allow: input.allow, scope: input.scope });

    if (!input.allow) {
      // Deny: settle every remaining pending approval on this run, flip the run
      // to cancelled, and mark the parked task cancelled so the scheduler can
      // continue to the next task instead of waiting forever.
      for (const item of run.approvals) {
        if (item.status === 'pending') {
          item.status = 'denied';
          item.resolvedAt = Date.now();
        }
      }
      run.status = 'cancelled';
      run.finishedAt = Date.now();
      run.error = '工具授权被拒绝，任务已跳过。';
      await this.engine.save(run);
      await this.mutateProject(input.projectId, (current) => {
        const target = current.tasks.find((item) => item.id === task.id);
        if (target && target.status === 'running') {
          target.status = 'cancelled';
          target.finishedAt = Date.now();
          target.error = '工具授权被拒绝，任务已跳过。';
        }
      });
      this.hub.publish(`project:${input.projectId}`, { type: 'project.task', projectId: input.projectId, taskId: task.id, status: 'cancelled', runId: run.id });
      this.notifySchedule(input.projectId);
      return { resumed: false };
    }

    await this.mutateProject(input.projectId, (current) => {
      if (approval) this.applyGrant(current, approval.skillId, approval.capability, input.scope ?? 'session');
    });

    // Allow: resume the same task as a new attempt. When the client sent no
    // context, assemble it server-side; also carry the granted network host into
    // the resumed context so the same tool call does not immediately re-park.
    let resumeContext = input.resumeContext ?? ((await this.contextResolver?.(task, project.ownerUserId ?? project.userId)) ?? undefined);
    if (!resumeContext) return { resumed: false };
    if (approval?.capability === 'network-access') this.grantNetworkHostToContext(resumeContext, approval.summary);
    const resumed = await this.startTask(input.projectId, task, resumeContext);
    this.notifySchedule(input.projectId);
    return { resumed };
  }

  /** Add the host named in a network-access approval to every skill's allowed hosts. */
  private grantNetworkHostToContext(context: ChatRunContext, summary: string): void {
    const match = /([a-z0-9.-]+\.[a-z]{2,})/i.exec(summary ?? '');
    if (!match) return;
    const host = match[1].toLowerCase();
    for (const skill of context.skills ?? []) {
      const execution = (skill as { execution?: { allowedNetworkHosts?: string[] } }).execution;
      if (execution && !(execution.allowedNetworkHosts ?? []).includes(host)) {
        execution.allowedNetworkHosts = [...(execution.allowedNetworkHosts ?? []), host];
      }
    }
  }

  private applyGrant(project: Project, skillId: string, capability: GrantCapability, scope: 'session' | 'always') {
    const target = scope === 'always' ? project.grantsAlways! : project.grantsSession!;
    const list = target[skillId] ?? [];
    if (!list.includes(capability)) list.push(capability);
    target[skillId] = list;
  }

  /* ------------------------------------------------------------------ *
   * Scheduler internals (event-driven, P2)
   * ------------------------------------------------------------------ */

  private notifySchedule(projectId: string): void {
    this.scheduleEpoch.set(projectId, (this.scheduleEpoch.get(projectId) ?? 0) + 1);
    const waiters = this.scheduleWaiters.get(projectId);
    if (!waiters?.size) return;
    for (const wake of waiters) wake();
    waiters.clear();
  }

  private waitForScheduleSignal(
    projectId: string,
    timeoutMs: number,
    seenEpoch: number,
  ): Promise<'signal' | 'timeout'> {
    if ((this.scheduleEpoch.get(projectId) ?? 0) > seenEpoch) return Promise.resolve('signal');
    return new Promise((resolve) => {
      let settled = false;
      const finish = (reason: 'signal' | 'timeout') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const set = this.scheduleWaiters.get(projectId);
        set?.delete(onSignal);
        resolve(reason);
      };
      const onSignal = () => finish('signal');
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      let set = this.scheduleWaiters.get(projectId);
      if (!set) {
        set = new Set();
        this.scheduleWaiters.set(projectId, set);
      }
      set.add(onSignal);
      // Re-check after registration to close the race with notifySchedule.
      if ((this.scheduleEpoch.get(projectId) ?? 0) > seenEpoch) finish('signal');
    });
  }

  private async runScheduler(projectId: string, projectRunId: string, input: ConfirmProjectInput): Promise<void> {
    try {
      await this.drain(projectId, projectRunId, input);
      await this.maybeFinish(projectId, projectRunId);
    } finally {
      if (this.liveProjectRuns.get(projectId) === projectRunId) {
        this.liveProjectRuns.delete(projectId);
        this.scheduleWaiters.delete(projectId);
        this.scheduleEpoch.delete(projectId);
        this.launchingTasks.delete(projectId);
      }
    }
  }

  private async isAlive(projectId: string, projectRunId: string): Promise<boolean> {
    const project = await this.getProject(projectId);
    return Boolean(project && project.activeRunId === projectRunId && project.status === 'running');
  }

  private async runStatusOf(task: ProjectTask): Promise<RunRecord['status'] | undefined> {
    if (!task.runId) return undefined;
    const run = await this.engine.load(task.runId);
    return run?.status;
  }

  private async isParked(task: ProjectTask): Promise<boolean> {
    if (task.status !== 'running') return false;
    return (await this.runStatusOf(task)) === 'waiting-approval';
  }

  private async resolveTaskContext(
    task: ProjectTask,
    input: ConfirmProjectInput,
    ownerUserId?: string,
  ): Promise<ChatRunContext | undefined> {
    let runContext = input.runContextByTask?.[task.id] ?? input.defaultContext;
    if (!runContext && this.contextResolver) {
      try {
        runContext = (await this.contextResolver(task, ownerUserId)) ?? undefined;
      } catch {
        runContext = undefined;
      }
    }
    return runContext;
  }

  /**
   * Run ready tasks up to `slots`, awaiting this batch to settle (P2 hybrid):
   * completion is deterministic; approval parking wakes the drain via notifySchedule.
   */
  private async runReadyBatch(
    projectId: string,
    projectRunId: string,
    input: ConfirmProjectInput,
    ready: ProjectTask[],
    slots: number,
  ): Promise<number> {
    if (slots <= 0 || !ready.length) return 0;
    const batch = ready.slice(0, slots);
    let launching = this.launchingTasks.get(projectId);
    if (!launching) {
      launching = new Set();
      this.launchingTasks.set(projectId, launching);
    }
    for (const task of batch) launching.add(task.id);
    await Promise.allSettled(
      batch.map(async (task) => {
        try {
          if (!(await this.isAlive(projectId, projectRunId))) return;
          const ownerProject = await this.getProject(projectId);
          const runContext = await this.resolveTaskContext(task, input, ownerProject?.ownerUserId ?? ownerProject?.userId);
          if (!runContext) {
            await this.mutateProject(projectId, (fresh) => {
              const target = fresh.tasks.find((item) => item.id === task.id);
              if (target) {
                target.status = 'failed';
                target.error = '缺少该任务的运行上下文（模型/Skill 配置）。请先在桌面端配置模型或指定默认上下文。';
              }
            });
            return;
          }
          const maxAttempts = task.contract?.maxAttempts;
          if (maxAttempts && task.attempts >= maxAttempts) {
            await this.mutateProject(projectId, (fresh) => {
              const target = fresh.tasks.find((item) => item.id === task.id);
              if (target) {
                target.status = 'failed';
                target.error = `已达到最大尝试次数（${maxAttempts}）。`;
              }
            });
            return;
          }
          await this.startTask(projectId, task, runContext);
        } finally {
          this.launchingTasks.get(projectId)?.delete(task.id);
          this.notifySchedule(projectId);
        }
      }),
    );
    return batch.length;
  }

  private async drain(projectId: string, projectRunId: string, input: ConfirmProjectInput): Promise<void> {
    for (;;) {
      const project = await this.getProject(projectId);
      if (!project || !(await this.isAlive(projectId, projectRunId))) return;
      const limit = Math.min(concurrencyForStrategy(project.mode), this.maxConcurrentProjectTasks);
      const launching = this.launchingTasks.get(projectId) ?? new Set();

      const parked = new Map<string, ProjectTask>();
      const running: ProjectTask[] = [];
      const queued: ProjectTask[] = [];
      for (const task of project.tasks) {
        if (task.status === 'superseded') continue;
        if (task.status === 'running' && (await this.isParked(task))) parked.set(task.id, task);
        else if (task.status === 'running' || launching.has(task.id)) running.push(task);
        else if (task.status === 'queued') queued.push(task);
      }

      const ready: ProjectTask[] = [];
      let dependencyFailureChanged = false;
      for (const task of queued) {
        if (launching.has(task.id)) continue;
        const blockedByFailure = (task.dependsOn ?? []).some((depId) => {
          const dep = project.tasks.find((item) => item.id === depId);
          return dep?.status === 'failed' || dep?.status === 'cancelled';
        });
        if (blockedByFailure) {
          dependencyFailureChanged = true;
          await this.mutateProject(projectId, (fresh) => {
            const target = fresh.tasks.find((item) => item.id === task.id);
            if (target && target.status === 'queued') {
              target.status = 'failed';
              target.error = '前置任务失败，无法继续。';
            }
          });
          continue;
        }
        const depsOk = (task.dependsOn ?? []).every((depId) => {
          const dep = project.tasks.find((item) => item.id === depId);
          if (!dep) return true;
          return isDependencySatisfied(dep.status);
        });
        if (!depsOk) continue;
        ready.push(task);
      }

      // Reload before classifying deeper descendants: this pass used a snapshot
      // from before their immediate predecessor was marked failed.
      if (dependencyFailureChanged) continue;

      const slots = Math.max(0, limit - running.filter((task) => !parked.has(task.id)).length);
      if (ready.length > 0 && slots > 0) {
        await this.runReadyBatch(projectId, projectRunId, input, ready, slots);
        continue;
      }

      if (parked.size > 0) {
        const epoch = this.scheduleEpoch.get(projectId) ?? 0;
        await this.waitForScheduleSignal(projectId, this.runTimeoutMs + 60_000, epoch);
        continue;
      }

      if (running.length > 0) {
        const epoch = this.scheduleEpoch.get(projectId) ?? 0;
        await this.waitForScheduleSignal(projectId, 15_000, epoch);
        continue;
      }

      if (queued.length > 0) {
        await this.mutateProject(projectId, (fresh) => {
          for (const task of fresh.tasks) {
            if (task.status === 'queued') {
              task.status = 'failed';
              task.error = '存在循环依赖或无法满足的前置条件，无法继续。';
            }
          }
        });
      }
      return;
    }
  }

  /** Called after every task settles. Closes the project run when done. */
  private async maybeFinish(projectId: string, onlyRunId?: string): Promise<void> {
    const out = await this.mutateProject(projectId, async (project) => {
      if (!project.activeRunId) return { summaryContext: undefined, needsSummary: false };
      if (onlyRunId && project.activeRunId !== onlyRunId) return { summaryContext: undefined, needsSummary: false };

      const parkedIds = new Set<string>();
      for (const task of project.tasks) {
        if (await this.isParked(task)) parkedIds.add(task.id);
      }
      const busy = project.tasks.some(
        (task) =>
          task.status === 'queued' ||
          task.status === 'stale' ||
          (task.status === 'running' && !parkedIds.has(task.id)),
      );
      if (busy || parkedIds.size > 0) return { summaryContext: undefined, needsSummary: false };

      const activeRunId = project.activeRunId;
      const summaryContext = this.summaryContextByRun.get(activeRunId);
      const currentRun = await readJson<ProjectRun>(this.store, this.projectRunKey(project.activeRunId));
      const active = project.tasks.filter((task) => task.status !== 'superseded' && (project.kind !== 'conversation' || currentRun?.taskIds.includes(task.id)));
      const hasFailures = active.some((task) => task.status === 'failed');
      const allDone = active.every((task) => isTerminalTaskStatus(task.status));

      const status: ProjectRun['status'] = hasFailures ? 'failed' : project.kind === 'conversation' && active.some(task => task.status === 'cancelled') ? 'cancelled' : allDone ? 'completed' : 'cancelled';
      const run = await readJson<ProjectRun>(this.store, this.projectRunKey(activeRunId));
      if (run) {
        normalizeProjectRunOwnership(run);
        run.status = status;
        run.finishedAt = Date.now();
        run.summary = project.summary;
        run.error = hasFailures ? '存在失败任务。' : undefined;
        await writeJson(this.store, this.projectRunKey(run.id), run);
      }
      project.activeRunId = undefined;
      project.status = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
      this.summaryContextByRun.delete(activeRunId);
      return { summaryContext, needsSummary: Boolean(summaryContext && allDone && !hasFailures) };
    });
    if (out?.result.needsSummary && out.result.summaryContext) {
      await this.runSummaryAfterFinish(projectId, out.result.summaryContext);
    }
  }

  /** Execute one task attempt. Returns false when the run is no longer valid. */
  private async startTask(projectId: string, task: ProjectTask, context: ChatRunContext): Promise<boolean> {
    const projectSnap = await this.getProject(projectId);
    const planVersion = projectSnap?.plan?.version ?? 1;
    const nextAttempt = (projectSnap?.tasks.find((item) => item.id === task.id)?.attempts ?? task.attempts) + 1;
    const attemptKey = buildAttemptKey(task.id, planVersion, nextAttempt);

    // P3 idempotency: if this attempt key already completed, skip re-execution.
    const existing = projectSnap?.tasks.find((item) => item.id === task.id);
    if (existing?.lastAttemptKey === attemptKey && existing.runId) {
      const prior = await this.engine.load(existing.runId);
      if (prior?.status === 'completed') {
        await this.mutateProject(projectId, (latest) => {
          const target = latest.tasks.find((item) => item.id === task.id);
          if (target && target.status !== 'completed') {
            target.status = 'completed';
            target.error = undefined;
          }
        });
        this.notifySchedule(projectId);
        return true;
      }
    }

    const runId = randomUUID();
    const abortHolder: { controller?: AbortController } = {};
    const out = await this.mutateProject(projectId, (project) => {
      if (project.status !== 'running' || !project.activeRunId) return { started: false };
      const current = project.tasks.find((item) => item.id === task.id);
      if (!current || current.status === 'cancelled' || current.status === 'superseded') return { started: false };
      // Another pulse may have claimed this task already.
      if (current.status === 'running' && current.runId && current.lastAttemptKey === attemptKey) {
        return { started: false };
      }
      abortHolder.controller = new AbortController();
      this.taskAborts.set(task.id, abortHolder.controller);
      current.status = 'running';
      current.attempts = nextAttempt;
      current.startedAt = Date.now();
      current.error = undefined;
      current.runId = runId;
      current.lastAttemptKey = attemptKey;
      current.planVersion = planVersion;
      return { started: true };
    });
    if (!out?.result.started) return false;
    const signal = abortHolder.controller?.signal ?? new AbortController().signal;

    const currentTask = (await this.getProject(projectId))?.tasks.find((item) => item.id === task.id);
    const project = await this.getProject(projectId);
    const promptTask = currentTask ?? task;
    const dependencyEntries: Array<{ title: string; content: string }> = [];
    for (const depId of promptTask.dependsOn ?? []) {
      const dep = project?.tasks.find((item) => item.id === depId);
      if (!dep || dep.status !== 'completed') continue;
      const transcript = await this.taskTranscript(dep);
      dependencyEntries.push({
        title: dep.title,
        content: transcript?.transcript?.trim() || '',
      });
    }
    const outputHint = promptTask.contract?.outputs?.length
      ? `\n\n本任务要求的交付文件/目录：\n- ${promptTask.contract.outputs.join('\n- ')}`
      : '';
    const acceptanceHint = promptTask.contract?.acceptance?.trim()
      ? `\n\n验收标准：\n${promptTask.contract.acceptance.trim()}`
      : '';
    const userContent = `${fitObjective(promptTask.objective)}${outputHint}${acceptanceHint}${buildDependencyBlock(dependencyEntries)}`;
    const previousReply = promptTask.followUp?.previousRunId
      ? (await this.engine.load(promptTask.followUp.previousRunId))?.transcript?.slice(-6_000)
      : undefined;
    const request = {
      ...context,
      runId,
      ...(project?.workspacePath && project.executionWorkspaceMode !== 'isolated' ? { projectWorkspacePath: project.workspacePath } : {}),
      messages: [
        { role: 'user' as const, content: userContent },
        ...(previousReply ? [{ role: 'assistant' as const, content: previousReply }] : []),
        ...(promptTask.followUp ? [{ role: 'user' as const, content: `继续当前项目对话，以本轮问题为准；原目标及上次回答是背景，不要无故重做已完成工作。需要核查文件时使用当前授权项目目录。\n\n本轮问题：${promptTask.followUp.content}` }] : []),
      ],
    };
    let workspaceRevision: string | undefined;
    if (project?.kind === 'conversation') {
      try { workspaceRevision = await prepareConversationWorkspace(project.workspacePath, runWorkspaceRoot(runId)); }
      catch (cause) { this.taskAborts.delete(task.id); throw cause; }
      const history = project.messages.filter(message => (message.role === 'user' || message.role === 'assistant') && message.taskId !== task.id).slice(-12);
      request.messages = [
        { role: 'user', content: `当前为持续项目对话。项目说明仅作背景：${project.goal.slice(0, 4000)}\n已有成果位于 output/；参考材料位于 inputs/。优先增量修改，不重做已完成工作。仅本轮成功后才会更新固定成果目录。` },
        ...history.map(message => ({ role: message.role as 'user' | 'assistant', content: message.content.slice(-4000) })),
        { role: 'user', content: userContent },
      ];
    }
    let run: RunRecord;
    try {
      run = await this.engine.execute({
        runId,
        sessionId: projectId,
        orgId: project?.orgId,
        ownerUserId: project?.ownerUserId ?? project?.userId,
        accessScope: project?.accessScope,
        accessGrants: project?.accessGrants,
        kind: 'project-task',
        taskId: task.id,
        attemptNo: (currentTask ?? task).attempts,
        request,
        signal,
        timeoutMs: promptTask.contract?.timeoutMs ?? this.projectTaskTimeoutMs,
        extraTopics: [`project:${projectId}`],
        ...(project?.executionWorkspaceMode === 'isolated' && project.workspacePath ? {
          finalizeCompleted: async (completed: Readonly<RunRecord>, emit: (event: import('@workmate/contracts').AgentEvent) => void) => {
            try {
              const published = project.kind === 'conversation'
                ? await publishConversationWorkspace(runWorkspaceRoot(completed.id), project.workspacePath, signal, workspaceRevision)
                : await promoteWorkspaceDeliverablesToProject(runWorkspaceRoot(completed.id), project.workspacePath, { strict: true });
              for (const file of published) emit({ type: 'project.file.published', runId: completed.id, ...file });
            } catch (cause) {
              throw new Error(`项目交付目录写入失败：${cause instanceof Error ? cause.message : '无法发布文件'}`);
            }
          },
        } : {}),
      });
    } finally {
      this.taskAborts.delete(task.id);
    }

    await this.mutateProject(projectId, (latest) => {
      const target = latest.tasks.find((item) => item.id === task.id);
      if (!target || target.runId !== run.id) return;
      if (latest.status !== 'running' && latest.status !== 'cancelled') return;
      appendTaskReply(latest, target, run, latest.activeRunId);
      target.finishedAt = Date.now();
      const maxAttempts = target.contract?.maxAttempts ?? 1;
      if (run.status === 'completed') {
        target.status = 'completed';
        target.error = run.error;
      } else if (run.status === 'cancelled') {
        target.status = 'cancelled';
        target.error = run.error;
      } else if (run.status === 'waiting-approval') {
        target.status = 'running';
        target.error = '任务等待审批后继续。';
      } else if (project?.kind !== 'conversation' && run.status === 'failed' && isStepBudgetFailureWithDeliverables(run)) {
        // Files already landed in the project; treat as completed so downstream DAG can continue.
        target.status = 'completed';
        target.error = undefined;
      } else if (run.status === 'failed' && target.attempts < maxAttempts && isRetryableRunFailure(run.error)) {
        target.status = 'queued';
        target.error = `上次尝试因瞬时格式/连接问题失败，正在自动重试（${target.attempts}/${maxAttempts}）：${run.error}`;
      } else {
        target.status = 'failed';
        target.error = run.error;
      }
      this.hub.publish(`project:${latest.id}`, { type: 'project.task', projectId: latest.id, taskId: task.id, status: target.status, runId: run.id });
    });
    this.notifySchedule(projectId);
    return true;
  }

  /** Runs the coordinator summary after the project run finished. */
  private async runSummaryAfterFinish(projectId: string, context: ChatRunContext): Promise<void> {
    const project = await this.getProject(projectId);
    if (!project) return;
    const entries: Array<{ title: string; content: string }> = [];
    for (const task of project.tasks) {
      if (task.status !== 'completed') continue;
      const transcript = await this.taskTranscript(task);
      entries.push({
        title: task.title,
        content: transcript?.transcript?.trim() || '(无文本输出)',
      });
    }
    const evidence = buildSummaryEvidence(entries);
    const messageId = randomUUID();
    await this.mutateProject(projectId, (fresh) => {
      fresh.messages.push({
        id: messageId,
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        taskId: 'summary',
        runId: fresh.activeRunId,
      });
    });
    const request = {
      ...context,
      messages: [
        {
          role: 'user' as const,
          content: `项目目标：${project.goal}\n\n已完成子任务结果（已按预算提配截断，仅作参考）：\n${evidence}\n\n请汇总最终交付。不要虚构失败任务的信息。`,
        },
      ],
    };
    const run = await this.engine.execute({
      runId: randomUUID(),
      sessionId: projectId,
      orgId: project.orgId,
      ownerUserId: project.ownerUserId ?? project.userId,
      accessScope: project.accessScope,
      accessGrants: project.accessGrants,
      kind: 'project-task',
      taskId: 'summary',
      attemptNo: 1,
      request,
      extraTopics: [`project:${projectId}`],
    });
    await this.mutateProject(projectId, (fresh) => {
      const target = fresh.messages.find((item) => item.id === messageId);
      if (target) target.content = run.transcript.trim() || '(汇总未返回文本。)';
      fresh.summary = run.transcript.trim() || fresh.summary;
    });
  }

  private async finishProjectRun(projectId: string, projectRunId: string, status: ProjectRun['status'], summary?: string, error?: string) {
    await this.mutateProject(projectId, async (project) => {
      if (!project.activeRunId || project.activeRunId !== projectRunId) return;
      const run = await readJson<ProjectRun>(this.store, this.projectRunKey(projectRunId));
      if (run) {
        normalizeProjectRunOwnership(run);
        run.status = status;
        run.finishedAt = Date.now();
        run.summary = summary ?? project.summary;
        run.error = error;
        await writeJson(this.store, this.projectRunKey(run.id), run);
      }
      project.activeRunId = undefined;
      project.status = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
      project.summary = summary ?? project.summary;
    });
  }

  /** Serialized read-modify-write of one project document. */
  private async mutateProject<R>(id: string, fn: (project: Project) => Promise<R> | R): Promise<MutateResult<R> | null> {
    return withKeyLock(`project-doc:${id}`, async () => {
      const project = await readJson<Project>(this.store, this.projectKey(id));
      if (!project) return null;
      normalizeProjectOwnership(project);
      const result = await fn(project);
      project.updatedAt = Date.now();
      await writeJson(this.store, this.projectKey(id), project);
      this.hub.publish(`project:${id}`, { type: 'project.updated', projectId: id });
      return { project, result };
    });
  }

  private async saveProject(project: Project): Promise<void> {
    normalizeProjectOwnership(project);
    project.updatedAt = Date.now();
    await writeJson(this.store, this.projectKey(project.id), project);
    this.hub.publish(`project:${project.id}`, { type: 'project.updated', projectId: project.id });
  }

  /** Watch every orchestration event published on a project's topic. */
  subscribe(projectId: string, listener: HubListener<OrcEvent>): () => void {
    return this.hub.subscribe(`project:${projectId}`, listener);
  }
}
