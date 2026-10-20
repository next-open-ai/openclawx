import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpConnectionRuntime } from '@openclawx/contracts';
import type { UnifiedToolSession } from './unified-tool-runtime.js';

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

/** Run-scoped localhost transport for engines that consume tools through MCP. */
export async function openUnifiedToolMcpBridge(input: {
  runId: string;
  session: UnifiedToolSession;
  name?: string;
}): Promise<{
  connection: McpConnectionRuntime;
  waitUntilListed(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}> {
  let listed = false;
  const waiters = new Set<(ok: boolean) => void>();
  const markListed = () => {
    listed = true;
    for (const wake of waiters) wake(true);
    waiters.clear();
  };
  const createServer = () => {
    const server = new Server({ name: input.name ?? 'openclawx-unified-tools', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      markListed();
      return { tools: input.session.descriptors.map((item) => ({ name: item.name, description: item.description, inputSchema: item.inputSchema as any })) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const invocationId = `dsh-${crypto.randomUUID()}`;
      const result = await input.session.invoke({
        version: 1,
        invocationId,
        runId: input.runId,
        toolId: request.params.name,
        input: (request.params.arguments ?? {}) as Record<string, unknown>,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result.output ?? { ok: false, error: result.error?.message }) }],
        isError: result.status !== 'succeeded',
      } as CallToolResult;
    });
    return server;
  };
  const httpServer = http.createServer(async (req, res) => {
    if (!req.url?.startsWith('/tools')) return void res.writeHead(404).end('not found');
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.method === 'POST' ? await readJsonBody(req) : undefined);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      if (!address || typeof address === 'string') return reject(new Error('Unified tool bridge failed to bind.'));
      resolve(address.port);
    });
  });
  return {
    connection: { id: `unified-tools-${input.runId}`, name: input.name ?? 'application-models', transport: 'http', url: `http://127.0.0.1:${port}/tools`, enabled: true },
    async waitUntilListed(timeoutMs = 90_000) {
      if (listed) return true;
      return new Promise<boolean>((resolve) => {
        const wake = (ok: boolean) => { clearTimeout(timer); resolve(ok); };
        const timer = setTimeout(() => { waiters.delete(wake); resolve(false); }, timeoutMs);
        waiters.add(wake);
      });
    },
    async close() {
      for (const wake of waiters) wake(false);
      waiters.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
