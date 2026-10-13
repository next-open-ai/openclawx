import { ChatSessionService } from './chat-session.js';
import type { OrcEvent } from './events.js';
import { EventHub, type HubListener } from './hub.js';
import { ProjectService } from './project.js';
import { InMemoryExecutionDispatcher, type ExecutionDispatcher, type ExecutionDispatcherSnapshot } from './execution-dispatcher.js';
import { RunEngine } from './run-engine.js';
import { agentCoreRunner, type AgentRunner } from './runner.js';
import type { ChatRunContext } from './chat-session.js';
import type { DurableTaskSourceInput } from './chat-session.js';
import type { KeyValueStore } from './storage/kv.js';
import type { ProjectTask } from './types.js';
import { JsonFileStore, MemoryStore } from './storage/index.js';
import { DurableTaskService } from './durable-task.js';

export interface OrchestratorOptions {
  store: KeyValueStore;
  runner?: AgentRunner;
  dispatcher?: ExecutionDispatcher;
  runTimeoutMs?: number;
  /** Project work is commonly longer than chat; defaults to 20 minutes. */
  projectTaskTimeoutMs?: number;
  flushDelayMs?: number;
  maxConcurrentRunsGlobal?: number;
  maxConcurrentRunsPerUser?: number;
  maxQueueWaitMs?: number;
  /** Fallback server-side run-context assembly (see ProjectServiceOptions). */
  contextResolver?: (task: ProjectTask, ownerUserId?: string) => ChatRunContext | null | Promise<ChatRunContext | null>;
  /** Fallback chat run-context assembly by employee id (see ChatSessionService). */
  chatContextResolver?: (
    employeeId: string,
    ownerUserId?: string | null,
  ) => ChatRunContext | null | Promise<ChatRunContext | null>;
  /** MCP-only backfill for chat when client context omits connectors. */
  chatMcpConnectionsResolver?: (
    employeeId: string,
    ownerUserId?: string | null,
  ) => ChatRunContext['mcpConnections'] | Promise<ChatRunContext['mcpConnections']>;
  durableTaskSourceResolver?: (sessionId: string, attachments: import('@workmate/contracts').ChatFileAttachment[]) => Promise<DurableTaskSourceInput[]>;
}

/**
 * Facade for the headless orchestration layer (M0).
 *
 * Both the Vue renderer (through the Fastify API) and future channel / relay
 * gateways talk to one Orchestrator instance, which owns the durable state
 * machines for chat sessions, resumable agent runs, and project scheduling.
 */
export class Orchestrator {
  readonly store: KeyValueStore;
  readonly events: EventHub<OrcEvent>;
  readonly engine: RunEngine;
  readonly chat: ChatSessionService;
  readonly projects: ProjectService;
  readonly durableTasks: DurableTaskService;
  readonly dispatcher: ExecutionDispatcher;

  constructor(options: OrchestratorOptions) {
    this.store = options.store;
    this.events = new EventHub<OrcEvent>();
    const runner = options.runner ?? agentCoreRunner;
    const dispatcher = options.dispatcher ?? new InMemoryExecutionDispatcher({
      maxConcurrentRunsGlobal: options.maxConcurrentRunsGlobal,
      maxConcurrentRunsPerUser: options.maxConcurrentRunsPerUser,
      maxQueueWaitMs: options.maxQueueWaitMs,
    });
    this.dispatcher = dispatcher;
    this.engine = new RunEngine(this.store, runner, this.events, dispatcher, options.runTimeoutMs ?? 1_800_000);
    this.durableTasks = new DurableTaskService(this.store);
    this.chat = new ChatSessionService({
      store: this.store,
      hub: this.events,
      engine: this.engine,
      contextResolver: options.chatContextResolver,
      mcpConnectionsResolver: options.chatMcpConnectionsResolver,
      durableTasks: this.durableTasks,
      durableTaskSourceResolver: options.durableTaskSourceResolver,
    });
    this.projects = new ProjectService({
      store: this.store,
      hub: this.events,
      engine: this.engine,
      runTimeoutMs: options.runTimeoutMs ?? 1_800_000,
      projectTaskTimeoutMs: options.projectTaskTimeoutMs,
      maxConcurrentProjectTasks: Math.min(
        options.maxConcurrentRunsGlobal ?? 4,
        options.maxConcurrentRunsPerUser ?? 2,
      ),
      contextResolver: options.contextResolver,
    });
  }

  /** Open against a durable JSON document file (single-writer process). */
  static open(dataFile: string, options?: Omit<OrchestratorOptions, 'store'>): Orchestrator {
    return new Orchestrator({
      ...options,
      store: new JsonFileStore(dataFile, { flushDelayMs: options?.flushDelayMs ?? 50 }),
    });
  }

  /** Open against an ephemeral in-memory store (tests / headless dev). */
  static memory(options?: Omit<OrchestratorOptions, 'store'>): Orchestrator {
    return new Orchestrator({ ...options, store: new MemoryStore() });
  }

  /** Watch an orchestration topic, e.g. `session:<id>` or `project:<id>`. */
  subscribe(topic: string, listener: HubListener<OrcEvent>): () => void {
    return this.events.subscribe(topic, listener);
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  /**
   * Reconcile durable state left behind by a previous process (desktop/API restart).
   * Safe to call once at boot; no-ops when nothing is orphaned.
   */
  async recoverOnBoot(): Promise<{ projects: number; tasks: number; chatRuns: number }> {
    const projectResult = await this.projects.recoverOrphanedExecution();
    const chatRuns = await this.engine.recoverOrphanedRuns();
    return { ...projectResult, chatRuns };
  }

  /** Aggregate token usage across all persisted runs (by model / project / chat). */
  async usageStats() {
    const { buildUsageStats } = await import('./usage.js');
    return buildUsageStats({
      engine: this.engine,
      chat: this.chat,
      projects: this.projects,
    });
  }

  dispatcherSnapshot(): ExecutionDispatcherSnapshot | null {
    const dispatcher = this.dispatcher as ExecutionDispatcher & { snapshot?: () => ExecutionDispatcherSnapshot };
    return typeof dispatcher.snapshot === 'function' ? dispatcher.snapshot() : null;
  }
}
