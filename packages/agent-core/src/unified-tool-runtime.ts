import type { AgentTool } from '@mariozechner/pi-agent-core';
import type {
  ModelCapability,
  UnifiedToolCategory,
  UnifiedToolDescriptor,
  UnifiedToolInvocation,
  UnifiedToolResult,
} from '@openclawx/contracts';
import { extractToolDetails } from './pi-tools.js';

export type UnifiedToolRegistration = {
  tool: AgentTool<any>;
  category?: UnifiedToolCategory;
  capability?: ModelCapability;
};

export type UnifiedToolSession = {
  descriptors: UnifiedToolDescriptor[];
  /** Native view used by in-process engines; execution still routes through the same registered implementation. */
  nativeTools: AgentTool<any>[];
  invoke(invocation: UnifiedToolInvocation, signal?: AbortSignal): Promise<UnifiedToolResult>;
};

function isoNow() {
  return new Date().toISOString();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Execution-engine-neutral registry and dispatcher.
 * Pi consumes nativeTools; AgentScope and dsh consume descriptors + invoke.
 */
export function createUnifiedToolSession(registrations: UnifiedToolRegistration[]): UnifiedToolSession {
  const byId = new Map<string, UnifiedToolRegistration>();
  const descriptors: UnifiedToolDescriptor[] = [];
  for (const registration of registrations) {
    const id = registration.tool.name;
    if (byId.has(id)) throw new Error(`Duplicate unified tool id: ${id}`);
    byId.set(id, registration);
    descriptors.push({
      id,
      name: registration.tool.name,
      description: registration.tool.description,
      inputSchema: registration.tool.parameters,
      category: registration.category ?? 'platform',
      ...(registration.capability ? { capability: registration.capability } : {}),
    });
  }

  return {
    descriptors,
    nativeTools: registrations.map((item) => item.tool),
    async invoke(invocation, signal) {
      const startedAt = isoNow();
      const registration = byId.get(invocation.toolId);
      if (!registration) {
        return {
          version: 1,
          invocationId: invocation.invocationId,
          toolId: invocation.toolId,
          status: 'failed',
          error: { code: 'TOOL_NOT_FOUND', message: `Unknown tool: ${invocation.toolId}` },
          startedAt,
          completedAt: isoNow(),
        };
      }
      if (signal?.aborted) {
        return {
          version: 1,
          invocationId: invocation.invocationId,
          toolId: invocation.toolId,
          status: 'cancelled',
          error: { code: 'CANCELLED', message: 'Tool invocation was cancelled.' },
          startedAt,
          completedAt: isoNow(),
        };
      }
      const deadlineMs = invocation.deadlineAt ? Date.parse(invocation.deadlineAt) - Date.now() : 0;
      if (invocation.deadlineAt && (!Number.isFinite(deadlineMs) || deadlineMs <= 0)) {
        return {
          version: 1,
          invocationId: invocation.invocationId,
          toolId: invocation.toolId,
          status: 'timed-out',
          error: { code: 'DEADLINE_EXCEEDED', message: 'Tool invocation deadline has elapsed.' },
          startedAt,
          completedAt: isoNow(),
        };
      }
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (deadlineMs > 0) timer = setTimeout(() => controller.abort(), deadlineMs);
      try {
        const raw = await registration.tool.execute(invocation.invocationId, invocation.input, combined);
        const output = extractToolDetails(raw);
        const failed = Boolean(output && typeof output === 'object' && (output as Record<string, unknown>).ok === false);
        return {
          version: 1,
          invocationId: invocation.invocationId,
          toolId: invocation.toolId,
          status: failed ? 'failed' : 'succeeded',
          output,
          ...(failed ? { error: { code: 'TOOL_EXECUTION_FAILED', message: String((output as Record<string, unknown>).error || 'Tool failed.') } } : {}),
          startedAt,
          completedAt: isoNow(),
        };
      } catch (error) {
        const timedOut = controller.signal.aborted && !signal?.aborted;
        const cancelled = Boolean(signal?.aborted);
        return {
          version: 1,
          invocationId: invocation.invocationId,
          toolId: invocation.toolId,
          status: timedOut ? 'timed-out' : cancelled ? 'cancelled' : 'failed',
          error: { code: timedOut ? 'DEADLINE_EXCEEDED' : cancelled ? 'CANCELLED' : 'TOOL_EXECUTION_FAILED', message: errorMessage(error) },
          startedAt,
          completedAt: isoNow(),
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

export function registrationsFromTools(
  tools: AgentTool<any>[],
  metadata: { category?: UnifiedToolCategory; capabilities?: Partial<Record<string, ModelCapability>> } = {},
): UnifiedToolRegistration[] {
  return tools.map((tool) => ({
    tool,
    category: metadata.category,
    capability: metadata.capabilities?.[tool.name],
  }));
}
