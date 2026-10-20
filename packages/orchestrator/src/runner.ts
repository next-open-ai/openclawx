import { streamAgentReply } from '@openclawx/agent-core';
import type { AgentEvent, ChatRequest } from '@openclawx/contracts';

/**
 * Orchestration-facing run handle. Testable without a live model
 * (tests inject a FakeRunner). Production path delegates to agent-core
 * `streamAgentReply`, which resolves an ExecutionBackend
 * (pi / agentscope / dsh) from runtime-settings + ChatRequest.engine —
 * backends are not selected here.
 */
export interface AgentRunner {
  /**
   * Start a run. `emit` receives every AgentEvent as it is produced.
   * Resolves when the run settles (completed/failed/cancelled).
   */
  start(request: ChatRequest, emit: (event: AgentEvent) => void, options?: { abortSignal?: AbortSignal }): Promise<void>;
}

/** Production runner: single agent-core boundary → ExecutionBackend registry. */
export const agentCoreRunner: AgentRunner = {
  async start(request, emit, options) {
    for await (const event of streamAgentReply({
      ...request,
      abortSignal: options?.abortSignal,
    })) {
      emit(event);
    }
  },
};
