import type { AgentEvent, AgentProfile, ChatRequest, ModelConfig } from '@openclawx/contracts';
import { randomUUID } from 'node:crypto';
import type { AgentRunner } from '../index.js';
import type { ChatRunContext } from '../index.js';

/** Build a minimal, valid run context (mirrors a client-supplied payload). */
export function runContext(overrides: Partial<ChatRunContext> = {}): ChatRunContext {
  const profile: AgentProfile = {
    id: 'general',
    name: 'General Assistant',
    instructions: 'You are a helpful assistant.',
    toolIds: [],
  };
  const model: ModelConfig = { provider: 'ollama', chatModel: 'fake-model', apiKey: 'ollama' };
  return {
    profile,
    model,
    skills: [],
    searchProviders: [],
    mcpConnections: [],
    knowledgeBases: [],
    ...overrides,
  };
}

export interface FakeApproval {
  skillId: string;
  capability: 'workspace-write' | 'script-execution' | 'network-access';
  summary: string;
}

export interface FakeMode {
  /** nth call (1-based) that should emit an approval before completing. */
  approvalOnCall?: number;
  approvals?: FakeApproval[];
  /** Optional texts emitted per call (echo mode default). */
  texts?: (request: ChatRequest, callIndex: number) => string;
  /** Simulate a long-running model turn before emitting events. */
  delayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scripted runner: no network. Call 1 may emit an approval_required event and
 * then complete (leaving the run parked in `waiting-approval`); every call
 * echoes a deterministic text so tests can assert transcripts.
 */
export class FakeRunner implements AgentRunner {
  readonly calls: ChatRequest[] = [];
  private readonly mode: FakeMode;

  constructor(mode: FakeMode = {}) {
    this.mode = mode;
  }

  async start(request: ChatRequest, emit: (event: AgentEvent) => void, options?: { abortSignal?: AbortSignal }): Promise<void> {
    this.calls.push(request);
    const runId = randomUUID();
    if (this.mode.delayMs) await sleep(this.mode.delayMs);
    if (options?.abortSignal?.aborted) {
      emit({ type: 'run.cancelled', runId, reason: 'user', message: 'cancelled by test' });
      return;
    }
    const callIndex = this.calls.length;
    if (this.mode.approvalOnCall === callIndex) {
      emit({ type: 'tool.started', runId, toolName: 'load_skill', summary: '加载 Skill' });
      for (const approval of this.mode.approvals ?? []) {
        emit({
          type: 'tool.approval_required',
          runId,
          skillId: approval.skillId,
          capability: approval.capability,
          summary: approval.summary,
        });
      }
      emit({ type: 'run.completed', runId });
      return;
    }
    const text =
      this.mode.texts?.(request, callIndex) ??
      `echo#${callIndex}: ${request.messages.at(-1)?.content ?? ''}`;
    for (const chunk of text.match(/.{1,12}/gs) ?? [text]) {
      emit({ type: 'message.delta', runId, text: chunk });
    }
    emit({ type: 'run.completed', runId });
  }
}

export async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 5_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
