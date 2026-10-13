import type { AgentEvent, AgentProfile, ModelConfig } from '@workmate/contracts';
import type { OpcaiTool, ToolPolicy } from '@workmate/tools';
import { summarizeSessionMemory as summarizeSessionMemoryImpl } from './context-compaction.js';

export * from './skills.js';
export * from './mcp-runtime.js';
export * from './skill-runtime.js';
export * from './workspace-mode.js';
export * from './workspace-write.js';
export * from './json-repair.js';
export * from './context-sanitize.js';
export * from './context-compaction.js';
export * from './search-runtime.js';
export * from './knowledge-runtime.js';
export * from './document-parser.js';
export * from './ontology-runtime.js';
export * from './ontology-extraction.js';
export * from './experience/index.js';
export * from './pi-model.js';
export * from './model-failure.js';
export * from './image-input.js';
export * from './pi-tools.js';
export * from './capability-kernel.js';
export * from './model-capability-runtime.js';
export * from './unified-tool-runtime.js';
export * from './pi-capability-adapter.js';
export * from './preview-server.js';
export * from './python-runtime.js';
export * from './workspace-scrap.js';
export * from './agentscope-capability-adapter.js';
export * from './dsh-capability-adapter.js';
export * from './pi-skills.js';
export {
  streamAgentReply,
  DEFAULT_RUN_TIMEOUT_MS,
  resolveAgentEngine,
  resolveExecutionBackend,
  registerExecutionBackend,
  unregisterExecutionBackend,
  getExecutionBackend,
  listExecutionBackends,
  availableExecutionBackendIds,
  registerBuiltinExecutionBackends,
  resetExecutionBackendRegistryForTests,
  loadExecutionRoutingConfig,
} from './stream-reply.js';
export type {
  AgentEngineId,
  ExecutionBackend,
  ExecutionBackendCapabilities,
  ExecutionBackendStreamInput,
  BackendResolveInput,
  ExecutionRoutingConfig,
} from './stream-reply.js';
export * from './agentscope/index.js';
export * from './dsh/index.js';

/**
 * Workmate agent boundary.
 * Execution backends (registry): default **pi**; optional **AgentScope** sidecar;
 * **dsh** DeepSeek Harness coding sidecar (JSON-RPC; requires runtime install).
 * Switch: `WORKMATE_AGENT_ENGINE=pi|agentscope|dsh` or `resolveExecutionBackend` hints.
 */
export interface AgentRuntime {
  start(input: { profile: AgentProfile; prompt: string; tools: OpcaiTool[] }): AsyncIterable<AgentEvent>;
  cancel(runId: string): void;
}

export class PolicyEngine implements ToolPolicy {
  requiresApproval(risk: OpcaiTool['risk']): boolean {
    return risk !== 'read';
  }
}

export const defaultProfile: AgentProfile = {
  id: 'general',
  name: 'General Assistant',
  instructions: 'You are a helpful assistant.',
  toolIds: [],
};

/** Durable session-memory summarizer (ModelConfig → plain turns) via pi. */
export async function summarizeSessionMemory(input: {
  model: ModelConfig;
  previousSummary?: string;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
}): Promise<string | null> {
  return summarizeSessionMemoryImpl(input);
}
export { storeAudioInput, deleteAudioInput } from './audio-input.js';
export { createModelCapabilityTools } from './model-capability-runtime.js';
export { testVisionCapabilityDataUrl } from './vision-capability.js';
export { evaluateDecision, createDecisionAgentTool, guardAgentTools } from './decision-runtime.js';
export { VolcengineAsrStream } from './volcengine-asr.js';
export { withDataQueryAccess, type DataQueryExecutor } from './data-query-runtime.js';
