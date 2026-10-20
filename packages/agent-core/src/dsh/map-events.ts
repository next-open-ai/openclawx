import type { AgentEvent } from '@openclawx/contracts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textFromContentBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

function reasoningFromContentBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'thinking' && typeof block.thinking === 'string') parts.push(block.thinking);
  }
  return parts.join('');
}

/** Correlates dsh tool/call → tool/result (result events often omit `name`). */
export type DshEventMapContext = {
  toolNamesByCallId: Map<string, string>;
};

export function createDshEventMapContext(): DshEventMapContext {
  return { toolNamesByCallId: new Map() };
}

function extractCallId(data: Record<string, unknown>, message: Record<string, unknown> | null): string {
  if (typeof data.callId === 'string' && data.callId) return data.callId;
  const source = message && isRecord(message.source) ? message.source : null;
  if (source && typeof source.callId === 'string' && source.callId) return source.callId;
  if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (typeof block.toolCallId === 'string' && block.toolCallId) return block.toolCallId;
    }
  }
  return '';
}

function toolResultFailed(data: Record<string, unknown>, message: Record<string, unknown> | null): boolean {
  if (data.error) return true;
  if (!Array.isArray(message?.content)) return false;
  return message.content.some((block) => isRecord(block) && block.isError === true);
}

/**
 * Map one DeepSeek Harness session-log event onto zero or more OpenClawX AgentEvents.
 * Only emits user-visible text deltas (not reasoning) and tool activity.
 */
export function mapDshSessionEvent(
  runId: string,
  event: unknown,
  ctx: DshEventMapContext = createDshEventMapContext(),
): AgentEvent[] {
  if (!isRecord(event) || typeof event.type !== 'string') return [];
  const data = isRecord(event.data) ? event.data : {};
  const out: AgentEvent[] = [];

  switch (event.type) {
    case 'assistant/chunk': {
      const chunk = isRecord(data.chunk) ? data.chunk : null;
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
        out.push({ type: 'message.delta', runId, text: chunk.text });
      } else if (chunk?.type === 'thinking-delta' && typeof chunk.text === 'string' && chunk.text) {
        out.push({ type: 'reasoning.delta', runId, text: chunk.text });
      }
      break;
    }
    case 'assistant/message': {
      const message = isRecord(data.message) ? data.message : null;
      const text = textFromContentBlocks(message?.content);
      const reasoning = reasoningFromContentBlocks(message?.content);
      if (reasoning) {
        out.push({ type: 'reasoning.delta', runId, text: `\u0000${reasoning}` });
      }
      if (text) {
        out.push({ type: 'message.delta', runId, text: `\u0000${text}` });
      }
      if (isRecord(data.usage)) {
        const usage = data.usage;
        const inputTokens = Math.max(0, Math.round(Number(usage.inputTokens ?? usage.prompt_tokens ?? 0)) || 0);
        const outputTokens = Math.max(0, Math.round(Number(usage.outputTokens ?? usage.completion_tokens ?? 0)) || 0);
        const reasoningTokens = Math.max(0, Math.round(Number(usage.reasoningTokens ?? 0)) || 0);
        const cacheReadTokens = Math.max(0, Math.round(Number(usage.cacheReadTokens ?? 0)) || 0);
        out.push({
          type: 'run.usage',
          runId,
          usage: {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens + reasoningTokens,
            ...(reasoningTokens ? { reasoningTokens } : {}),
            ...(cacheReadTokens ? { cacheReadTokens } : {}),
          },
        });
      }
      break;
    }
    case 'tool/call': {
      const name = String(data.name || 'tool');
      const callId = extractCallId(data, null);
      if (callId) ctx.toolNamesByCallId.set(callId, name);
      const args = String(data.arguments || '').slice(0, 200);
      out.push({
        type: 'tool.started',
        runId,
        ...(callId ? { invocationId: callId } : {}),
        toolName: name,
        summary: args ? `${name}(${args})` : name,
      });
      break;
    }
    case 'tool/result': {
      const message = isRecord(data.message) ? data.message : null;
      const callId = extractCallId(data, message);
      const name = String(
        message?.name
        || data.name
        || (callId ? ctx.toolNamesByCallId.get(callId) : undefined)
        || 'tool',
      );
      const failed = toolResultFailed(data, message);
      const summary = failed
        ? String((isRecord(data.error) && data.error.name) || `${name} failed`)
        : `${name} completed`;
      if (failed) {
        out.push({ type: 'tool.failed', runId, ...(callId ? { invocationId: callId } : {}), toolName: name, summary });
      } else {
        out.push({ type: 'tool.completed', runId, ...(callId ? { invocationId: callId } : {}), toolName: name, summary, ok: true });
      }
      if (callId) ctx.toolNamesByCallId.delete(callId);
      break;
    }
    case 'turn/end': {
      const reason = isRecord(data.reason) ? data.reason : null;
      const kind = String(reason?.kind || '');
      if (kind === 'error') {
        const message = String(reason?.message || reason?.error || 'DeepSeek Harness turn failed.');
        out.push({ type: 'run.failed', runId, message });
      }
      break;
    }
    default:
      break;
  }

  return out;
}

/** Strip the assembled-message sentinel used to distinguish fallback full text. */
export function unwrapAssembledDelta(text: string): { assembled: boolean; text: string } {
  if (text.startsWith('\u0000')) return { assembled: true, text: text.slice(1) };
  return { assembled: false, text };
}
