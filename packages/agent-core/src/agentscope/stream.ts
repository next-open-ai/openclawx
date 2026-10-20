import type { AgentEvent, ChatRequest } from '@openclawx/contracts';
import { chatRequestToRunParams } from './client.js';
import { prepareAgentscopeHostTools, type HostToolCall } from './host-tools.js';
import { acquireSharedAgentscopeRunSlot, ensureSharedAgentscopeRuntime, markSharedAgentscopeHandleUnhealthy } from './process.js';
import { resolveAgentWorkspaceRoot } from '../workspace-mode.js';
import { MODEL_CAPABILITY_BY_TOOL } from '../model-capability-runtime.js';

/** Silence between sidecar events before we abort a hung provider stream. */
export const DEFAULT_STREAM_IDLE_MS = 150_000;
const MAX_SIDECAR_START_RETRIES = 1;

const NETWORK_STALL_MESSAGE =
  '网络连接超时或中断了，这次没能完成回答。请检查网络后重试；若正在使用 VPN，也可先切换网络再试。';

function asToolCalls(value: unknown): HostToolCall[] {
  if (!Array.isArray(value)) return [];
  const out: HostToolCall[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.name !== 'string') continue;
    out.push({
      id: row.id,
      name: row.name,
      input: row.input && typeof row.input === 'object' && !Array.isArray(row.input)
        ? (row.input as Record<string, unknown>)
        : {},
    });
  }
  return out;
}

function resolveStreamIdleMs(input: ChatRequest): number {
  const runTimeoutMs = typeof input.runTimeoutMs === 'number' && input.runTimeoutMs > 0
    ? input.runTimeoutMs
    : 1_800_000;
  // Keep idle below the whole-run timeout; floor at 90s for slow MCP tools.
  return Math.max(90_000, Math.min(DEFAULT_STREAM_IDLE_MS, Math.floor(runTimeoutMs / 4)));
}

function friendlyStallMessage(raw: string): string {
  const text = raw.trim() || 'Model request failed.';
  if (/connection\s*error|failed to fetch|fetch failed|terminated|econnreset|econnrefused|enotfound|eai_again|broken pipe|network|ssl|tls|timed?\s*out|timeout|stream idle|remote end closed|temporarily unavailable|socket hang up|ECONNABORTED|UND_ERR/i.test(text)) {
    return NETWORK_STALL_MESSAGE;
  }
  return text;
}

/**
 * Stream a ChatRequest through the AgentScope Sidecar (WebSocket JSON-RPC).
 * Phase 1+: real ReAct when model credentials are present; otherwise stub echo.
 */
export async function* streamAgentReplyViaAgentscope(input: ChatRequest & {
  abortSignal?: AbortSignal;
  runId?: string;
  sessionSummary?: string;
}): AsyncGenerator<AgentEvent> {
  const streamIdleMs = resolveStreamIdleMs(input);
  const baseParams = chatRequestToRunParams(input);
  const hostTools = await prepareAgentscopeHostTools({ ...input, runId: baseParams.runId });
  const params = {
    ...baseParams,
    ...hostTools.runtimePatch,
    streamIdleMs,
    workspaceRoot: resolveAgentWorkspaceRoot({ runId: baseParams.runId, projectWorkspacePath: input.projectWorkspacePath }),
    workspaceAccess: input.workspaceAccess ?? 'write',
    ...(input.sessionSummary ? { sessionSummary: input.sessionSummary } : {}),
  };
  const runId = params.runId;
  const queue: AgentEvent[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  let lastEventAt = Date.now();
  let emittedEvents = 0;
  const bump = () => { wake?.(); wake = null; };
  try {
    for (let attempt = 0; attempt <= MAX_SIDECAR_START_RETRIES; attempt += 1) {
      const lease = await acquireSharedAgentscopeRunSlot({
        runId,
        signal: input.abortSignal,
      });
      const handle = lease.handle;
      handle.client.setHostRequestHandler(runId, async (method, params) => {
        if (method !== 'host.tool.invoke') throw new Error(`Unsupported host method: ${method}`);
        const runId = String(params.runId || '');
        const calls = asToolCalls(params.toolCalls);
        for (const call of calls) {
          const capability = MODEL_CAPABILITY_BY_TOOL[call.name as keyof typeof MODEL_CAPABILITY_BY_TOOL];
          const modelId = input.modelCapabilities?.find((item) => item.capability === capability)?.modelId;
          if (capability && modelId) queue.push({ type: 'capability.started', runId, invocationId: call.id, capability, modelId, summary: call.name });
        }
        bump();
        const results = await hostTools.executeHostToolCalls(runId, calls);
        for (const result of results) {
          const capability = MODEL_CAPABILITY_BY_TOOL[result.name as keyof typeof MODEL_CAPABILITY_BY_TOOL];
          const modelId = input.modelCapabilities?.find((item) => item.capability === capability)?.modelId;
          if (!capability || !modelId) continue;
          queue.push(result.state === 'success'
            ? { type: 'capability.completed', runId, invocationId: result.id, capability, modelId, summary: result.summary || result.name, ok: true }
            : { type: 'capability.failed', runId, invocationId: result.id, capability, modelId, summary: result.summary || result.name });
          try {
            const output = JSON.parse(result.output) as { path?: unknown; deliverable?: unknown };
            if (result.state === 'success' && output.deliverable === true && typeof output.path === 'string') {
              queue.push({ type: 'artifact.created', runId, path: output.path });
            }
          } catch { /* non-JSON tool output */ }
        }
        bump();
        return { executionResults: results };
      });

      const offEvent = handle.client.onEvent((payload) => {
        if (payload.runId !== runId) return;
        if ((payload.event.type === 'tool.started' || payload.event.type === 'tool.completed' || payload.event.type === 'tool.failed')
          && MODEL_CAPABILITY_BY_TOOL[payload.event.toolName as keyof typeof MODEL_CAPABILITY_BY_TOOL]) return;
        lastEventAt = Date.now();
        queue.push(payload.event);
        bump();
      });
      const offFinished = handle.client.onFinished((payload) => {
        if (payload.runId !== runId) return;
        lastEventAt = Date.now();
        done = true;
        bump();
      });
      const onAbort = () => {
        void handle.client.abortRun(runId, 'user').catch(() => undefined);
        bump();
      };
      input.abortSignal?.addEventListener('abort', onAbort, { once: true });

      try {
        await handle.client.startRun(params);
        while (!done || queue.length) {
          if (input.abortSignal?.aborted) {
            yield {
              type: 'run.cancelled',
              runId,
              reason: 'user',
              message: '已由用户中止当前执行。',
            };
            return;
          }
          if (queue.length) {
            const event = queue.shift()!;
            emittedEvents += 1;
            if (event.type === 'run.failed' && 'message' in event && typeof event.message === 'string') {
              yield { ...event, message: friendlyStallMessage(event.message) };
            } else {
              yield event;
            }
            continue;
          }
          if (done) break;

          const idleFor = Date.now() - lastEventAt;
          const waitMs = Math.max(250, streamIdleMs - idleFor);
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, waitMs);
          });

          if (queue.length || done || input.abortSignal?.aborted) continue;
          if (Date.now() - lastEventAt < streamIdleMs) continue;

          void handle.client.abortRun(runId, 'timeout').catch(() => undefined);
          yield {
            type: 'run.failed',
            runId,
            message: NETWORK_STALL_MESSAGE,
          };
          return;
        }
        return;
      } catch (error) {
        markSharedAgentscopeHandleUnhealthy(handle, error);
        const canRetry = attempt < MAX_SIDECAR_START_RETRIES && emittedEvents === 0 && !done;
        if (!canRetry) throw error;
      } finally {
        lease.release();
        handle.client.setHostRequestHandler(runId, null);
        offEvent();
        offFinished();
        input.abortSignal?.removeEventListener('abort', onAbort);
      }
    }
  } finally {
    await hostTools.close();
  }
}

/** Resume a Sidecar run paused on approval. */
export async function resumeAgentscopeRun(input: {
  runId: string;
  confirmed?: boolean;
  grants?: Array<{ skillId: string; capability: string }>;
}): Promise<void> {
  const handle = await ensureSharedAgentscopeRuntime();
  await handle.client.resumeRun(input);
}
