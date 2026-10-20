import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpConnectionRuntime } from '@openclawx/contracts';
import { openDshMcpBridges } from '../mcp-dsh-bridge.js';
import { warmMcpConnections } from '../mcp-runtime.js';

test('openDshMcpBridges passes through http connections unchanged', async () => {
  const remote: McpConnectionRuntime = {
    id: 'remote',
    name: 'Remote',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    enabled: true,
  };
  const opened = await openDshMcpBridges([remote]);
  try {
    assert.equal(opened.bridges.length, 0);
    assert.equal(opened.cordisConnections.length, 1);
    assert.deepEqual(opened.cordisConnections[0], remote);
  } finally {
    await opened.close();
  }
});

test('openDshMcpBridges rewrites warmed stdio to localhost http and signals tools/list', async () => {
  // Tiny fake MCP via `node -e` stdio is heavy; use the filesystem server only when
  // npx is available. Prefer a local echo-style command that speaks MCP is hard —
  // instead skip unless OPENCLAWX_TEST_MCP_STDIO is set, and always cover pass-through.
  const command = process.env.OPENCLAWX_TEST_MCP_STDIO?.trim();
  if (!command) {
    assert.ok(true, 'skip live stdio bridge (set OPENCLAWX_TEST_MCP_STDIO to enable)');
    return;
  }
  const [bin, ...args] = command.split(/\s+/);
  const conn: McpConnectionRuntime = {
    id: 'test-stdio',
    name: 'TestStdio',
    transport: 'stdio',
    command: bin!,
    args,
    enabled: true,
  };
  const warm = await warmMcpConnections([conn], { toolTimeoutMs: 60_000 });
  assert.ok(warm.items[0]?.ok, warm.items[0]?.error || 'warm failed');
  const opened = await openDshMcpBridges([conn]);
  try {
    assert.equal(opened.bridges.length, 1);
    const bridge = opened.bridges[0]!;
    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.equal(bridge.connection.transport, 'http');
    assert.equal(bridge.connection.url, bridge.url);
    assert.equal(opened.cordisConnections[0], bridge.connection);

    const client = new Client({ name: 'bridge-test', version: '0.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(bridge.url));
    await client.connect(transport);
    const listed = await client.listTools();
    assert.ok((listed.tools?.length ?? 0) > 0);
    await client.close();

    const ready = await bridge.waitUntilListed(5_000);
    assert.equal(ready, true);
  } finally {
    await opened.close();
    warm.release();
  }
});
