import { randomUUID } from 'node:crypto';
import type { AgentEvent, ChatRequest } from '@openclawx/contracts';

export const AGENTSCOPE_PROTOCOL_VERSION = '1';

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

export type AgentEventNotify = {
  runId: string;
  seq: number;
  event: AgentEvent;
};

export type HelloResult = {
  runtimeVersion: string;
  protocolVersion: string;
  packageVersion?: string;
  engine: string;
  capabilities: string[];
};

export type HealthResult = {
  ok: boolean;
  uptimeMs: number;
  activeRuns: number;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type HostRequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Thin WebSocket JSON-RPC client for the AgentScope Sidecar.
 * Uses dynamic import('ws') so agent-core stays usable when ws is not resolved yet.
 */
export class AgentscopeRpcClient {
  private socket: import('ws').WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly eventHandlers = new Set<(payload: AgentEventNotify) => void>();
  private readonly finishedHandlers = new Set<(payload: { runId: string; status: string; message?: string }) => void>();
  private readonly hostHandlersByRun = new Map<string, HostRequestHandler>();
  private nextId = 1;

  constructor(private readonly url: string) {}

  setHostRequestHandler(runId: string, handler: HostRequestHandler | null) {
    if (!runId.trim()) return;
    if (handler) this.hostHandlersByRun.set(runId, handler);
    else this.hostHandlersByRun.delete(runId);
  }
  async connect(timeoutMs = 8_000): Promise<void> {
    if (this.socket && this.socket.readyState === 1) return;
    const { default: WebSocket } = await import('ws');
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`AgentScope runtime connect timeout: ${this.url}`));
      }, timeoutMs);
      socket.once('open', () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.on('message', (data) => this.onMessage(String(data)));
        socket.on('close', () => this.failAll(new Error('AgentScope runtime socket closed')));
        socket.on('error', (error) => this.failAll(error instanceof Error ? error : new Error(String(error))));
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.failAll(new Error('AgentScope runtime client closed'));
  }

  onEvent(handler: (payload: AgentEventNotify) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onFinished(handler: (payload: { runId: string; status: string; message?: string }) => void): () => void {
    this.finishedHandlers.add(handler);
    return () => this.finishedHandlers.delete(handler);
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 15_000): Promise<T> {
    if (!this.socket || this.socket.readyState !== 1) throw new Error('AgentScope runtime not connected');
    const id = String(this.nextId++);
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`AgentScope RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket!.send(JSON.stringify(payload));
    });
    return result as T;
  }

  async hello(): Promise<HelloResult> {
    return this.request<HelloResult>('runtime.hello', {
      clientVersion: '0.1.0',
      protocolVersion: AGENTSCOPE_PROTOCOL_VERSION,
    });
  }

  async health(): Promise<HealthResult> {
    return this.request<HealthResult>('runtime.health', {});
  }

  async startRun(params: Record<string, unknown> & { runId: string }): Promise<{ runId: string; accepted: boolean }> {
    return this.request('agent.run.start', params);
  }

  async abortRun(runId: string, reason?: 'user' | 'timeout'): Promise<{ runId: string; aborted: boolean }> {
    return this.request('agent.run.abort', { runId, ...(reason ? { reason } : {}) });
  }

  async resumeRun(params: {
    runId: string;
    confirmed?: boolean;
    grants?: Array<{ skillId: string; capability: string }>;
  }): Promise<{ runId: string; accepted: boolean }> {
    return this.request('agent.run.resume', params);
  }

  async summarizeMemory(params: {
    model: Record<string, unknown>;
    previousSummary?: string;
    turns: Array<{ role: 'user' | 'assistant'; content: string }>;
  }): Promise<{ summary: string }> {
    return this.request('agent.memory.summarize', params, 60_000);
  }

  private async replyHost(id: JsonRpcId, result?: unknown, error?: { code: number; message: string }) {
    if (!this.socket || this.socket.readyState !== 1) return;
    if (error) {
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, error }));
      return;
    }
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  private onMessage(raw: string) {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const record = asRecord(message);
    if (!record || record.jsonrpc !== '2.0') return;

    // Server → client request (host bridge).
    if (typeof record.method === 'string' && 'id' in record && record.result === undefined && record.error === undefined) {
      const id = record.id as JsonRpcId;
      const params = asRecord(record.params) ?? {};
      void (async () => {
        try {
          const runId = typeof params.runId === 'string' ? params.runId : '';
          const handler = runId ? this.hostHandlersByRun.get(runId) ?? null : null;
          if (!handler) throw new Error(`No host tool handler registered for run ${runId || '(missing runId)'}`);
          const result = await handler(record.method as string, params);
          await this.replyHost(id, result);
        } catch (error) {
          await this.replyHost(id, undefined, {
            code: -32030,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      return;
    }

    if ('id' in record && (record.result !== undefined || record.error !== undefined)) {
      const id = String(record.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (record.error) {
        const err = asRecord(record.error);
        pending.reject(new Error(err?.message ? String(err.message) : 'AgentScope RPC error'));
        return;
      }
      pending.resolve(record.result);
      return;
    }

    if (typeof record.method === 'string' && !('id' in record)) {
      const params = asRecord(record.params) ?? {};
      if (record.method === 'agent.event') {
        const event = asRecord(params.event);
        if (!event || typeof params.runId !== 'string' || typeof event.type !== 'string') return;
        const notify: AgentEventNotify = {
          runId: params.runId,
          seq: Number(params.seq ?? 0),
          event: event as unknown as AgentEvent,
        };
        for (const handler of this.eventHandlers) handler(notify);
        return;
      }
      if (record.method === 'agent.run.finished') {
        if (typeof params.runId !== 'string' || typeof params.status !== 'string') return;
        const payload = {
          runId: params.runId,
          status: params.status,
          ...(typeof params.message === 'string' ? { message: params.message } : {}),
        };
        for (const handler of this.finishedHandlers) handler(payload);
      }
    }
  }

  private failAll(error: Error) {
    for (const [, pending] of this.pending) pending.reject(error);
    this.pending.clear();
  }
}

export function chatRequestToRunParams(request: ChatRequest & { runId?: string }): Record<string, unknown> & { runId: string } {
  return {
    runId: request.runId ?? randomUUID(),
    profile: request.profile,
    messages: request.messages,
    model: {
      provider: request.model.provider,
      chatModel: request.model.chatModel,
      baseUrl: request.model.baseUrl,
      providerLabel: request.model.providerLabel,
      disableThinking: request.model.disableThinking,
      enableSearch: request.model.enableSearch,
      // Never forward apiKey over the wire in logs; still pass for local sidecar.
      apiKey: request.model.apiKey,
    },
    skills: request.skills,
    searchProviders: request.searchProviders,
    mcpConnections: request.mcpConnections,
    knowledgeBases: request.knowledgeBases,
    projectWorkspacePath: request.projectWorkspacePath,
    maxSteps: request.maxSteps,
    runTimeoutMs: request.runTimeoutMs,
    mcpToolTimeoutMs: request.mcpToolTimeoutMs,
  };
}
