import { randomUUID } from 'node:crypto';
import type { AgentEvent, ChatRequest } from '@openclawx/contracts';
import type { AgentRunner } from './runner.js';

export interface ScriptedRunnerMode {
  /** Emit one approval_required on the first call of each run, then echo. */
  approvalOnFirstCall?: boolean;
  skillId?: string;
  capability?: 'workspace-write' | 'script-execution' | 'network-access';
  approvalSummary?: string;
  /** Simulate latency so waiting/streaming paths can be observed. */
  delayMs?: number;
}

/**
 * Deterministic runner for headless smoke tests and local demos (no network,
 * no model credentials). Activated in apps/api only when
 * `OPENCLAWX_ORCH_RUNNER=memory-echo|memory-approval`. Never used in production
 * defaults — agent-core remains the only real model boundary.
 */
export class ScriptedRunner implements AgentRunner {
  readonly calls: ChatRequest[] = [];
  private readonly mode: ScriptedRunnerMode;

  constructor(mode: ScriptedRunnerMode = {}) {
    this.mode = mode;
  }

  async start(request: ChatRequest, emit: (event: AgentEvent) => void, options?: { abortSignal?: AbortSignal }): Promise<void> {
    this.calls.push(request);
    const runId = randomUUID();
    if (this.mode.delayMs) await new Promise((resolve) => setTimeout(resolve, this.mode.delayMs));
    if (options?.abortSignal?.aborted) {
      emit({ type: 'run.cancelled', runId, reason: 'user', message: '已中止当前执行。' });
      return;
    }
    if (this.mode.approvalOnFirstCall && this.calls.length === 1) {
      emit({
        type: 'tool.approval_required',
        runId,
        skillId: this.mode.skillId ?? 'document-workbench',
        capability: this.mode.capability ?? 'workspace-write',
        summary: this.mode.approvalSummary ?? '需要写入运行工作区，等待审批。',
      });
      emit({ type: 'run.completed', runId });
      return;
    }
    const text = `echo#${this.calls.length}: ${request.messages.at(-1)?.content ?? ''}`;
    for (const chunk of text.match(/.{1,16}/gs) ?? [text]) {
      emit({ type: 'message.delta', runId, text: chunk });
    }
    emit({ type: 'run.completed', runId });
  }
}

/** Echo-only scripted runner factory (activated via OPENCLAWX_ORCH_RUNNER). */
export function createScriptedRunner(approvalMode = false, overrides: Partial<ScriptedRunnerMode> = {}): ScriptedRunner {
  return new ScriptedRunner({
    ...(approvalMode ? { approvalOnFirstCall: true } : {}),
    ...overrides,
  });
}
