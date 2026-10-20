import { randomUUID } from 'node:crypto';
import { cleanupConversationSessionWorkspaces, deleteChatImages, readChatImage, assertVisionSupported, resolveExecutionBackend, loadExecutionRoutingConfig } from '@openclawx/agent-core';
import { ChatFilesSchema, ChatImagesSchema } from '@openclawx/contracts';
import type { ChatRequest, ModelConfig } from '@openclawx/contracts';
import type { EventHub, HubListener } from './hub.js';
import { deleteKey, listJsonIds, readJson, writeJson } from './repo.js';
import type { OrcEvent } from './run-engine.js';
import { RunEngine } from './run-engine.js';
import {
  buildSessionModelMessages,
  estimateSessionMemoryChars,
  rollSessionMemory,
  shouldRollSessionMemory,
  uncoveredMessages,
} from './session-memory.js';
import type { KeyValueStore } from './storage/kv.js';
import { namespaceKey } from './storage/kv.js';
import type { ChatMessage, ChatSession, GrantCapability, RunRecord } from './types.js';
import { isDurableTaskResumeIntent, shouldCreateDurableTask, type DurableTaskService } from './durable-task.js';

export const SESSION_KEY_PREFIX = 'sessions:';
const SESSION_NS = 'sessions';
const RUN_NS = 'run';

/**
 * A full run request minus its message history. The caller (desktop UI or a
 * gateway) supplies resolved runtime context (employee profile, model, skill
 * runtime payloads, providers). Secrets never cross the persistence boundary.
 */
export type ChatRunContext = Omit<ChatRequest, 'messages'>;

export interface DurableTaskSourceInput {
  attachmentId: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface ChatSessionServiceOptions {
  store: KeyValueStore;
  hub: EventHub<OrcEvent>;
  engine: RunEngine;
  /**
   * Server-side run-context assembly fallback for chat messages / approval
   * resumes when the caller sends no `context` (remote gateway, desktop in
   * server-backed mode). Resolves for the session's employee; null → the
   * caller sees a clear "model not configured" style error.
   */
  contextResolver?: (
    employeeId: string,
    ownerUserId?: string | null,
  ) => ChatRunContext | null | Promise<ChatRunContext | null>;
  /**
   * MCP-only backfill when the client sends a context with empty
   * `mcpConnections` (common when model comes from the client but MCP prefs
   * were not loaded yet, or full contextResolver returns null without a model).
   */
  mcpConnectionsResolver?: (
    employeeId: string,
    ownerUserId?: string | null,
  ) => ChatRunContext['mcpConnections'] | Promise<ChatRunContext['mcpConnections']>;
  durableTasks?: DurableTaskService;
  /** Resolve verified chat-file originals only after a request becomes a durable task. */
  durableTaskSourceResolver?: (sessionId: string, attachments: import('@openclawx/contracts').ChatFileAttachment[]) => Promise<DurableTaskSourceInput[]>;
}

export interface SendUserMessageInput {
  content: string;
  attachments?: import('@openclawx/contracts').ChatImageAttachment[];
  fileAttachments?: import('@openclawx/contracts').ChatFileAttachment[];
  attachmentContext?: string;
  workflowResult?: import('@openclawx/contracts').WorkflowResultReference;
  responseMode?: 'text-only';
  /** Resolved runtime context; when omitted the service uses its resolver. */
  context?: ChatRunContext;
  /** Override the session employee recorded with the message. */
  employeeId?: string;
  /** Voice work must not replace an already running or preparing text turn. */
  rejectIfActive?: boolean;
}

export interface ResolveApprovalInput {
  sessionId: string;
  approvalId: string;
  allow: boolean;
  scope?: 'session' | 'always';
  /** Required to resume a waiting-approval run (fresh resolved runtime). */
  resumeContext?: ChatRunContext;
}

const FALLBACK_EMPTY_REPLY = '（本轮未返回文本。可重试，或检查模型 / MCP 是否正常。）';

function normalizeSessionOwnership(session: ChatSession): ChatSession {
  const ownerUserId = session.ownerUserId ?? session.userId;
  if (ownerUserId) {
    session.ownerUserId = ownerUserId;
    session.userId = session.userId ?? ownerUserId;
  }
  session.accessScope = session.accessScope ?? 'private';
  session.accessGrants = Array.isArray(session.accessGrants) ? session.accessGrants : [];
  return session;
}

export class ChatSessionService {
  private readonly store: KeyValueStore;
  private readonly hub: EventHub<OrcEvent>;
  private readonly engine: RunEngine;
  private readonly contextResolver?: ChatSessionServiceOptions['contextResolver'];
  private readonly mcpConnectionsResolver?: ChatSessionServiceOptions['mcpConnectionsResolver'];
  private readonly durableTasks?: DurableTaskService;
  private readonly durableTaskSourceResolver?: ChatSessionServiceOptions['durableTaskSourceResolver'];
  /** Active run aborts per session (one run at a time, mirroring the UI). */
  private readonly activeAborts = new Map<string, AbortController>();
  private readonly abortRunIds = new WeakMap<AbortController, string>();
  private readonly preparingTurns = new Map<string, number>();
  private readonly runAttempts = new Map<string, number>();

  constructor(options: ChatSessionServiceOptions) {
    this.store = options.store;
    this.hub = options.hub;
    this.engine = options.engine;
    this.contextResolver = options.contextResolver;
    this.mcpConnectionsResolver = options.mcpConnectionsResolver;
    this.durableTasks = options.durableTasks;
    this.durableTaskSourceResolver = options.durableTaskSourceResolver;
  }

  /** Resolve a run context for an employee (caller payload first, else resolver). */
  private async resolveContextFor(
    employeeId: string,
    explicit?: ChatRunContext,
    ownerUserId?: string | null,
  ): Promise<ChatRunContext | null> {
    let resolved: ChatRunContext | null = explicit ?? null;
    if (!resolved && this.contextResolver) {
      try {
        resolved = (await this.contextResolver(employeeId, ownerUserId)) ?? null;
      } catch {
        resolved = null;
      }
    }
    if (!resolved) return null;
    if (!resolved.mcpConnections?.length) {
      let mcp: ChatRunContext['mcpConnections'] = [];
      if (this.mcpConnectionsResolver) {
        try {
          mcp = (await this.mcpConnectionsResolver(employeeId, ownerUserId)) ?? [];
        } catch {
          mcp = [];
        }
      }
      if (!mcp.length && this.contextResolver) {
        try {
          const fallback = (await this.contextResolver(employeeId, ownerUserId)) ?? null;
          mcp = fallback?.mcpConnections ?? [];
        } catch {
          mcp = [];
        }
      }
      if (mcp.length) resolved = { ...resolved, mcpConnections: mcp };
    }
    // Client may omit engine after a prefs load race; backfill from server resolver.
    if (!resolved.engine && this.contextResolver) {
      try {
        const fallback = (await this.contextResolver(employeeId, ownerUserId)) ?? null;
        if (fallback?.engine) resolved = { ...resolved, engine: fallback.engine };
      } catch {
        // ignore
      }
    }
    return resolved;
  }

  private sessionKey(id: string): string {
    return namespaceKey(SESSION_NS, id);
  }

  /* ------------------------------------------------------------------ *
   * Session CRUD
   * ------------------------------------------------------------------ */

  async createChatSession(
    input: {
      title?: string;
      employeeId?: string;
      channelBinding?: ChatSession['channelBinding'];
      orgId?: string;
      ownerUserId?: string;
      userId?: string;
      accessScope?: ChatSession['accessScope'];
      accessGrants?: ChatSession['accessGrants'];
    } = {},
  ): Promise<ChatSession> {
    const now = Date.now();
    const ownerUserId = input.ownerUserId ?? input.userId;
    const session: ChatSession = {
      id: randomUUID(),
      kind: 'chat',
      orgId: input.orgId,
      ownerUserId,
      userId: ownerUserId,
      accessScope: input.accessScope ?? 'private',
      accessGrants: [...(input.accessGrants ?? [])],
      title: input.title?.trim() ? input.title.trim().slice(0, 80) : '新对话',
      employeeId: input.employeeId ?? 'general',
      messages: [],
      grantsSession: {},
      grantsAlways: {},
      channelBinding: input.channelBinding ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.saveSession(session);
    return session;
  }

  async getChatSession(id: string): Promise<ChatSession | null> {
    const session = await readJson<ChatSession>(this.store, this.sessionKey(id));
    return session ? normalizeSessionOwnership(session) : null;
  }

  async listChatSessions(): Promise<ChatSession[]> {
    const ids = await listJsonIds(this.store, SESSION_KEY_PREFIX);
    const sessions: ChatSession[] = [];
    for (const id of ids) {
      const session = await this.getChatSession(id);
      if (session) sessions.push(session);
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteChatSession(id: string): Promise<void> {
    const session = await this.getChatSession(id);
    if (!session) return;
    const runIds = [
      ...new Set(
        session.messages
          .map((message) => String(message.runId || '').trim())
          .filter(Boolean),
      ),
    ];
    await deleteKey(this.store, this.sessionKey(id));
    for (const message of session.messages) {
      if (message.runId) await deleteKey(this.store, namespaceKey(RUN_NS, message.runId));
    }
    // Best-effort: remove conversation staging (Agent temp scripts / .python-packages).
    await cleanupConversationSessionWorkspaces(runIds).catch(() => undefined);
    await this.durableTasks?.deleteForConversation(id).catch(() => undefined);
    await deleteChatImages(id);
    this.hub.publish(`session:${id}`, { type: 'session.deleted', sessionId: id });
  }

  /**
   * Reset conversational context while preserving the session identity and
   * related durable domain data (tasks, asset references, ownership, grants).
   * This is intentionally different from deleteChatSession.
   */
  async clearChatSession(id: string): Promise<ChatSession | null> {
    const session = await this.getChatSession(id);
    if (!session) return null;
    const abort = this.activeAborts.get(id);
    if (abort && !abort.signal.aborted) abort.abort();
    this.activeAborts.delete(id);
    const runIds = [...new Set(session.messages.map((message) => String(message.runId || '').trim()).filter(Boolean))];
    for (const runId of runIds) await deleteKey(this.store, namespaceKey(RUN_NS, runId));
    await cleanupConversationSessionWorkspaces(runIds).catch(() => undefined);
    await deleteChatImages(id);
    session.messages = [];
    session.memory = undefined;
    session.activeDurableTaskId = undefined;
    session.grantsSession = {};
    session.title = '新对话';
    session.updatedAt = Date.now();
    await this.saveSession(session);
    this.hub.publish(`session:${id}`, { type: 'session.updated', sessionId: id });
    return session;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.engine.load(runId);
  }

  /** Canonical conversation view (superseded attempts of a turn are hidden). */
  messagesOf(session: ChatSession): ChatMessage[] {
    return session.messages.filter((message) => !message.superseded);
  }

  /* ------------------------------------------------------------------ *
   * Messaging / runs
   * ------------------------------------------------------------------ */

  /**
   * Append a user message and execute a run for it. Any active run in the
   * same session is aborted first (same semantics as the desktop chat).
   */
  async sendUserMessage(sessionId: string, input: SendUserMessageInput): Promise<{ runId: string; turnId: string; attemptNo: number }> {
    if (input.rejectIfActive && (this.preparingTurns.get(sessionId) || (this.activeAborts.has(sessionId) && !this.activeAborts.get(sessionId)!.signal.aborted))) {
      throw new Error('当前对话已有工作正在执行，请等待完成后再提交语音工作。');
    }
    this.preparingTurns.set(sessionId, (this.preparingTurns.get(sessionId) || 0) + 1);
    try { return await this.sendUserMessageTurn(sessionId, input); }
    finally {
      const remaining = (this.preparingTurns.get(sessionId) || 1) - 1;
      if (remaining) this.preparingTurns.set(sessionId, remaining); else this.preparingTurns.delete(sessionId);
    }
  }

  private async sendUserMessageTurn(sessionId: string, input: SendUserMessageInput): Promise<{ runId: string; turnId: string; attemptNo: number }> {
    const session = await this.getChatSession(sessionId);
    if (!session) throw new Error('Chat session not found.');

    const text = input.content.trim();
    if (!text) throw new Error('Message content is empty.');

    const attachments = ChatImagesSchema.parse(input.attachments ?? []);
    const fileAttachments = ChatFilesSchema.parse(input.fileAttachments ?? []);
    const verifiedImageInputs = await Promise.all(attachments.map((image) => readChatImage(sessionId, image.id)));
    const verifiedAttachments = verifiedImageInputs.map((image) => image.attachment);
    const turnId = randomUUID();
    const runId = randomUUID();
    const now = Date.now();
    const activeTask = this.durableTasks && session.activeDurableTaskId
      ? await this.durableTasks.get(session.activeDurableTaskId)
      : null;
    // Do not silently attach every later conversation turn to a paused/waiting
    // task. Only an actively running turn or an explicit resume continues it.
    let durableTask = input.responseMode !== 'text-only' && activeTask?.status === 'running' ? activeTask : null;
    if (input.responseMode !== 'text-only' && this.durableTasks && isDurableTaskResumeIntent(text)) {
      durableTask = await this.durableTasks.latestResumable(session.id);
    }
    if (input.responseMode !== 'text-only' && !durableTask && this.durableTasks && shouldCreateDurableTask(text, fileAttachments.length + verifiedAttachments.length)) {
      durableTask = await this.durableTasks.create({ conversationId: session.id, objective: text });
    }
    const taskContext = durableTask
      ? [
          `[Durable task: ${durableTask.title}]`,
          `Objective: ${durableTask.objective}`,
          'Task sources are under .task/source/; other files restored from previous attempts are under .task/. Inspect and reuse them before recreating work.',
          'Write current user-facing deliverables under output/. This run will be checkpointed automatically.',
        ].join('\n')
      : '';
    const attachmentContext = [input.attachmentContext?.trim(), taskContext].filter(Boolean).join('\n\n').slice(0, 40_000);
    const taskFields = durableTask ? { durableTaskId: durableTask.id } : {};
    const userMessage: ChatMessage = { id: randomUUID(), role: 'user', content: text, ...(input.workflowResult ? { workflowResult: input.workflowResult } : {}), ...(input.responseMode ? { responseMode: input.responseMode } : {}), ...(verifiedAttachments.length ? { attachments: verifiedAttachments } : {}), ...(fileAttachments.length ? { fileAttachments } : {}), ...(attachmentContext ? { attachmentContext } : {}), ...taskFields, createdAt: now, turnId };
    const assistantMessage: ChatMessage = { id: randomUUID(), role: 'assistant', content: '', ...taskFields, createdAt: now, turnId, runId };
    const attemptNo = 1;

    session.employeeId = input.employeeId ?? session.employeeId;
    const employeeId = input.employeeId ?? session.employeeId;
    const ownerUserId = session.ownerUserId ?? session.userId ?? null;
    const runContext = await this.resolveContextFor(employeeId, input.context, ownerUserId);
    if (!runContext) {
      throw new Error('缺少运行上下文（模型/Skill 配置）。请先在桌面端配置模型。');
    }
    const visionHistory = buildSessionModelMessages({ ...session, messages: [...session.messages, userMessage] });
    if (visionHistory.some((message) => message.attachments?.length)) {
      const routing = loadExecutionRoutingConfig();
      assertVisionSupported(visionHistory, runContext.model.supportsVision, resolveExecutionBackend({ ...routing, employeeEngine: runContext.engine }).id, runContext.modelCapabilities);
    }
    if (durableTask && this.durableTasks) {
      try {
        for (const image of verifiedImageInputs) {
          await this.durableTasks.addSourceFile(durableTask.id, {
            attachmentId: image.attachment.id, name: image.attachment.name,
            mimeType: image.attachment.mimeType, bytes: image.bytes,
          });
        }
        if (fileAttachments.length) {
          if (!this.durableTaskSourceResolver) throw new Error('Task source resolver is not configured.');
          const sources = await this.durableTaskSourceResolver(sessionId, fileAttachments);
          const expected = new Set(fileAttachments.map((item) => item.id));
          if (sources.length !== expected.size || sources.some((item) => !expected.has(item.attachmentId))) {
            throw new Error('Task source resolver returned mismatched attachments.');
          }
          for (const source of sources) await this.durableTasks.addSourceFile(durableTask.id, source);
        }
        durableTask = await this.durableTasks.get(durableTask.id) ?? durableTask;
      } catch (cause) {
        await this.durableTasks.setStatus(durableTask.id, 'failed').catch(() => undefined);
        throw new Error(`无法保存持续任务源文件：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    const previous = this.activeAborts.get(sessionId);
    if (input.rejectIfActive && previous && !previous.signal.aborted) throw new Error('当前对话已有工作正在执行，请等待完成后再提交语音工作。');
    if (previous && !previous.signal.aborted) previous.abort();
    const abort = new AbortController();
    this.activeAborts.set(sessionId, abort);
    this.abortRunIds.set(abort, runId);
    session.messages.push(userMessage, assistantMessage);
    if (durableTask) session.activeDurableTaskId = durableTask.id;
    if (session.title === '新对话') session.title = text.slice(0, 28);
    await this.saveSession(session);

    if (durableTask) await this.durableTasks?.prepareRun(durableTask.id, runId).catch(() => undefined);

    const request = this.requestForTurn(session, runContext, turnId);
    void this.settleRun(session.id, runId, turnId, attemptNo, { ...request, runId }, assistantMessage.id, abort.signal);
    return { runId, turnId, attemptNo };
  }

  async abortActiveRun(sessionId: string, expectedRunId?: string): Promise<boolean> {
    const abort = this.activeAborts.get(sessionId);
    if (!abort || abort.signal.aborted) return false;
    if (expectedRunId && this.abortRunIds.get(abort) !== expectedRunId) return false;
    abort.abort();
    return true;
  }

  /**
   * Build a ChatRequest for a turn: context + session rolling memory + recent
   * uncovered history (or full history when no summary exists yet).
   */
  private requestForTurn(session: ChatSession, context: ChatRunContext, turnId: string): ChatRequest {
    const current = session.messages.find(message => message.turnId === turnId && message.role === 'user');
    if (current?.responseMode === 'text-only') return {
      ...context, responseMode: 'text-only', conversationId: session.id,
      model: { ...context.model, enableSearch: false },
      skills: [], mcpConnections: [], searchProviders: [], knowledgeBases: [], modelCapabilities: [], decisionRuntime: undefined,
      projectWorkspacePath: undefined, workspaceAccess: 'read',
      messages: [{ role: 'user', content: `${current.content}\n\n${current.attachmentContext || ''}` }],
    };
    const history = buildSessionModelMessages(session, { turnId });
    return { ...context, conversationId: session.id, messages: history };
  }

  private async settleRun(sessionId: string, runId: string, turnId: string, attemptNo: number, request: ChatRequest, assistantMessageId: string, signal: AbortSignal) {
    const ownerSession = await this.getChatSession(sessionId);
    try {
      const durableTaskId = ownerSession?.messages.find((item) => item.id === assistantMessageId)?.durableTaskId;
      // Durable file-production tasks routinely include several model/tool turns
      // plus a long encoder/converter process. Give them a separate ceiling;
      // ordinary chat continues to honor the employee's configured budget.
      const timeoutMs = durableTaskId
        ? Math.max(request.runTimeoutMs ?? 0, 1_800_000)
        : request.runTimeoutMs;
      const effectiveRequest = timeoutMs ? { ...request, runTimeoutMs: timeoutMs } : request;
      const run = await this.engine.execute({
        runId,
        sessionId,
        kind: 'chat',
        taskId: durableTaskId,
        turnId,
        attemptNo,
        request: effectiveRequest,
        timeoutMs,
        signal,
        orgId: ownerSession?.orgId,
        ownerUserId: ownerSession?.ownerUserId ?? ownerSession?.userId,
        accessScope: ownerSession?.accessScope,
        accessGrants: ownerSession?.accessGrants,
      });
      if (run.taskId) await this.durableTasks?.settleRun(run.taskId, run).catch(() => undefined);
      const session = await this.getChatSession(sessionId);
      if (!session) return;
      const message = session.messages.find((item) => item.id === assistantMessageId);
      if (message) {
        // Supersede older assistant attempts of the same turn.
        for (const other of session.messages) {
          if (other.role === 'assistant' && other.turnId === turnId && other.id !== message.id && !other.superseded) other.superseded = true;
        }
        const text = run.transcript.trim();
        const terminalError = run.status === 'cancelled'
          ? `⏹ ${run.error ?? '已中止当前执行。'}`
          : run.status === 'failed'
            ? `⚠ 本次执行未完成：${run.error ?? 'Model request failed.'}`
            : '';
        // A provider may emit a partial sentence before its stream fails. That
        // sentence is useful context, but must never hide the terminal error.
        if (terminalError) message.content = text ? `${text}\n\n${terminalError}` : terminalError;
        else if (text) message.content = text;
        else if (run.status !== 'waiting-approval') message.content = FALLBACK_EMPTY_REPLY;
        message.runId = run.id;
      }
      session.updatedAt = Date.now();
      if (run.status !== 'waiting-approval') {
        await this.refreshSessionMemory(session, effectiveRequest.model, { force: false });
      } else if (session.memory) {
        session.memory = { ...session.memory, dirty: true };
      } else {
        session.memory = { summary: '', coveredUntilId: '', updatedAt: Date.now(), dirty: true };
      }
      await this.saveSession(session);
    } finally {
      if (this.activeAborts.get(sessionId)?.signal === signal) this.activeAborts.delete(sessionId);
    }
  }

  /**
   * Roll session memory when over budget (or forced on flush). Marks dirty
   * when uncovered turns remain. Never truncates the transcript.
   */
  private async refreshSessionMemory(session: ChatSession, model: ModelConfig, options: { force: boolean }) {
    try {
      const { memory } = await rollSessionMemory({ session, model, force: options.force });
      session.memory = memory;
      if (!options.force) session.memory.dirty = true;
    } catch {
      if (session.memory) session.memory = { ...session.memory, dirty: true };
      else session.memory = { summary: '', coveredUntilId: '', updatedAt: Date.now(), dirty: true };
    }
  }

  /**
   * Flush rolling memory for a session (switch/idle/close). Rolls when over
   * budget or when force-folding excess beyond the recent window; clears dirty
   * when maintenance completes (or when there is nothing to fold).
   */
  async flushSessionMemory(sessionId: string, model?: ModelConfig): Promise<ChatSession | null> {
    const session = await this.getChatSession(sessionId);
    if (!session) return null;
    const summary = session.memory?.summary || '';
    const uncovered = uncoveredMessages(session.messages, session.memory?.coveredUntilId);
    const needsWork = Boolean(session.memory?.dirty)
      || shouldRollSessionMemory({ summary, uncovered, force: true })
      || estimateSessionMemoryChars(summary, uncovered) >= 24_000;
    if (!needsWork) return session;

    const runContext = await this.resolveContextFor(
      session.employeeId,
      undefined,
      session.ownerUserId ?? session.userId ?? null,
    );
    const resolvedModel = model ?? runContext?.model;
    if (!resolvedModel) {
      await this.saveSession(session);
      return session;
    }
    await this.refreshSessionMemory(session, resolvedModel, { force: true });
    if (session.memory) session.memory.dirty = false;
    await this.saveSession(session);
    return session;
  }

  /* ------------------------------------------------------------------ *
   * Approvals (resumable-run semantics)
   * ------------------------------------------------------------------ */

  /** Runs of this session that are parked waiting for approval. */
  async pendingApprovals(sessionId: string): Promise<RunRecord[]> {
    const session = await this.getChatSession(sessionId);
    if (!session) return [];
    const runs: RunRecord[] = [];
    for (const message of session.messages) {
      if (!message.runId) continue;
      const run = await this.engine.load(message.runId);
      if (run && run.status === 'waiting-approval' && run.approvals.some((approval) => approval.status === 'pending') && !runs.some((item) => item.id === run.id)) {
        runs.push(run);
      }
    }
    return runs;
  }

  /**
   * Decide a pending approval. When allowed with `resumeContext`, the same
   * turn is re-run as a fresh attempt with the grant applied — the durable
   * equivalent of the desktop UI's approve-and-retry.
   */
  async resolveApproval(input: ResolveApprovalInput): Promise<{ run: RunRecord | null; resumedRunId?: string; turnId?: string }> {
    const session = await this.getChatSession(input.sessionId);
    if (!session) throw new Error('Chat session not found.');

    const waiting = await this.findWaitingRun(session, input.approvalId);
    if (!waiting) throw new Error('Approval is not pending.');

    const approval = waiting.approvals.find((item) => item.id === input.approvalId);
    await this.engine.decideApproval(waiting.id, input.approvalId, { allow: input.allow, scope: input.scope });
    if (input.allow && approval) this.applyGrant(session, approval.skillId, approval.capability, input.scope ?? 'session');

    // Allowed but no explicit resume payload: fall back to the server-side
    // context resolver so a remote/desktop client can approve with no secrets.
    const resumeContext = input.resumeContext ?? (await this.resolveContextFor(
      session.employeeId,
      undefined,
      session.ownerUserId ?? session.userId ?? null,
    ));
    if (!input.allow || !resumeContext) {
      await this.saveSession(session);
      return { run: waiting };
    }

    const turnId = waiting.turnId;
    if (!turnId) {
      await this.saveSession(session);
      return { run: waiting };
    }
    const userMessage = this.messagesOf(session)
      .filter((message) => message.role === 'user' && message.turnId === turnId)
      .at(-1);
    if (!userMessage) {
      await this.saveSession(session);
      return { run: waiting };
    }

    const previous = this.activeAborts.get(session.id);
    if (previous && !previous.signal.aborted) previous.abort();
    const abort = new AbortController();
    this.activeAborts.set(session.id, abort);

    const attemptNo = waiting.attemptNo + 1;
    const resumedRunId = randomUUID();
    this.abortRunIds.set(abort, resumedRunId);
    const assistantId = this.assistantForTurn(session, turnId, resumedRunId);
    const durableTaskId = userMessage.durableTaskId;
    const resumedAssistant = session.messages.find((message) => message.id === assistantId);
    if (resumedAssistant && durableTaskId) resumedAssistant.durableTaskId = durableTaskId;
    if (durableTaskId) await this.durableTasks?.prepareRun(durableTaskId, resumedRunId).catch(() => undefined);
    const request = this.requestForTurn(session, resumeContext, turnId);
    void this.settleRun(session.id, resumedRunId, turnId, attemptNo, { ...request, runId: resumedRunId }, assistantId, abort.signal);
    await this.saveSession(session);
    return { run: waiting, resumedRunId, turnId };
  }

  /** Record a grant on the session (session-scoped or always-scoped). */
  private applyGrant(session: ChatSession, skillId: string, capability: GrantCapability, scope: 'session' | 'always') {
    const target = scope === 'always' ? session.grantsAlways : session.grantsSession;
    const list = target[skillId] ?? [];
    if (!list.includes(capability)) list.push(capability);
    target[skillId] = list;
  }

  private async findWaitingRun(session: ChatSession, approvalId: string): Promise<RunRecord | null> {
    for (const message of session.messages) {
      if (!message.runId) continue;
      const run = await this.engine.load(message.runId);
      if (run && run.approvals.some((approval) => approval.id === approvalId && approval.status === 'pending')) return run;
    }
    return null;
  }

  /** Reuse the turn's assistant placeholder for the resumed attempt. */
  private assistantForTurn(session: ChatSession, turnId: string, runId: string): string {
    const existing = session.messages.find((message) => message.role === 'assistant' && message.turnId === turnId && !message.superseded);
    if (existing) {
      existing.runId = runId;
      existing.content = '';
      return existing.id;
    }
    const id = randomUUID();
    session.messages.push({ id, role: 'assistant', content: '', createdAt: Date.now(), turnId, runId });
    return id;
  }

  private async saveSession(session: ChatSession): Promise<void> {
    normalizeSessionOwnership(session);
    session.updatedAt = Date.now();
    await writeJson(this.store, this.sessionKey(session.id), session);
    this.hub.publish(`session:${session.id}`, { type: 'session.updated', sessionId: session.id });
  }

  /** Watch every orchestration event published on a session's topic. */
  subscribe(sessionId: string, listener: HubListener<OrcEvent>): () => void {
    return this.hub.subscribe(`session:${sessionId}`, listener);
  }
}

/** Run records kept reachable from the session for engine bookkeeping. */
export { RUN_NS };
