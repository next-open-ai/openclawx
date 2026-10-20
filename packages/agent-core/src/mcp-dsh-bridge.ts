import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpConnectionRuntime } from '@openclawx/contracts';
import { acquirePooledMcpForBridge, releasePooledMcpForBridge, type PooledMcpHandle } from './mcp-runtime.js';

export type McpDshBridge = {
  name: string;
  url: string;
  /** Rewritten connection for cordis (streamable-http → dsh). */
  connection: McpConnectionRuntime;
  /** Resolves after dsh-mcp-client has called tools/list (plus a short settle). */
  waitUntilListed: (timeoutMs?: number) => Promise<boolean>;
  close: () => Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (!chunks.length) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function createProxyServer(pooled: PooledMcpHandle, onListTools: () => void): Server {
  const server = new Server(
    { name: 'openclawx-mcp-dsh-bridge', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      ...(pooled.instructions ? { instructions: pooled.instructions } : {}),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    onListTools();
    return { tools: pooled.listed.tools ?? [] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await pooled.client.callTool({
      name: request.params.name,
      arguments: (request.params.arguments ?? {}) as Record<string, unknown>,
    });
    return result as CallToolResult;
  });
  return server;
}

/**
 * Serve a warmed MCP client over localhost Streamable HTTP so dsh-mcp-client
 * can attach without a second npx/uvx cold start, and so we can gate the first
 * prompt on tools/list (Cordis may open JSON-RPC before mcp plugins finish).
 */
async function listenBridge(
  connection: McpConnectionRuntime,
  pooled: PooledMcpHandle,
): Promise<McpDshBridge> {
  let listed = false;
  const waiters = new Set<(ok: boolean) => void>();
  const markListed = () => {
    if (listed) return;
    listed = true;
    for (const wake of waiters) wake(true);
    waiters.clear();
  };

  const server = http.createServer(async (req, res) => {
    if (!req.url || !req.url.startsWith('/mcp')) {
      res.writeHead(404).end('not found');
      return;
    }
    const mcp = createProxyServer(pooled, markListed);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      try { await transport.close(); } catch { /* ignore */ }
      try { await mcp.close(); } catch { /* ignore */ }
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('MCP bridge failed to bind'));
        return;
      }
      resolve(addr.port);
    });
  });

  const url = `http://127.0.0.1:${port}/mcp`;
  const token = randomUUID();
  let closed = false;

  return {
    name: connection.name,
    url,
    connection: {
      id: connection.id,
      name: connection.name,
      transport: 'http',
      url,
      apiKey: token,
      enabled: true,
    },
    async waitUntilListed(timeoutMs = 90_000) {
      if (listed) {
        await sleep(300);
        return true;
      }
      const ok = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(resolve);
          resolve(false);
        }, Math.max(1_000, timeoutMs));
        const wake = (value: boolean) => {
          clearTimeout(timer);
          resolve(value);
        };
        waiters.add(wake);
        if (listed) {
          waiters.delete(wake);
          clearTimeout(timer);
          resolve(true);
        }
      });
      if (ok) await sleep(300);
      return ok;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const wake of waiters) wake(false);
      waiters.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 1_500);
      });
      releasePooledMcpForBridge(pooled);
    },
  };
}

/**
 * For each warmed stdio MCP, open a localhost HTTP bridge and rewrite the
 * connection for dsh cordis. Native http/sse connections pass through unchanged.
 */
export async function openDshMcpBridges(
  connections: McpConnectionRuntime[],
): Promise<{
  bridges: McpDshBridge[];
  cordisConnections: McpConnectionRuntime[];
  close: () => Promise<void>;
}> {
  const bridges: McpDshBridge[] = [];
  const cordisConnections: McpConnectionRuntime[] = [];

  for (const connection of connections) {
    if (connection.enabled === false) continue;
    if (connection.transport !== 'stdio') {
      cordisConnections.push(connection);
      continue;
    }
    let pooled: PooledMcpHandle | null = null;
    try {
      pooled = await acquirePooledMcpForBridge(connection);
      const bridge = await listenBridge(connection, pooled);
      pooled = null; // ownership transferred to bridge.close
      bridges.push(bridge);
      cordisConnections.push(bridge.connection);
      console.info('[openclawx] MCP dsh bridge', { name: connection.name, url: bridge.url });
    } catch (error) {
      if (pooled) releasePooledMcpForBridge(pooled);
      console.warn('[openclawx] MCP dsh bridge failed; falling back to stdio', {
        name: connection.name,
        error: error instanceof Error ? error.message : String(error),
      });
      cordisConnections.push(connection);
    }
  }

  let closed = false;
  return {
    bridges,
    cordisConnections,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all(bridges.map((bridge) => bridge.close().catch(() => undefined)));
    },
  };
}
