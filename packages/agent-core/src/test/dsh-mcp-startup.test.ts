import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOpenClawXDshCordisYaml } from '../dsh/cordis-compose.js';
import type { OpenClawXDshModelRoute } from '../dsh/model-route.js';

const route: OpenClawXDshModelRoute = {
  provider: 'openclawx',
  model: 'test-model',
  api: 'openai-completions',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  displayName: 'Test',
  contextWindow: 128_000,
  maxTokens: 8_192,
  env: {},
};

test('dsh cordis requires MCP startup success before jsonrpc accepts traffic', () => {
  const yaml = buildOpenClawXDshCordisYaml({
    route,
    mcpConnections: [
      {
        id: 'mcp-baseline-akshare',
        name: 'AKShare',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'quanters-akshare-mcp'],
        enabled: true,
      },
    ],
  });
  assert.match(yaml, /failOnStartupError: true/);
  assert.doesNotMatch(yaml, /failOnStartupError: false/);
});
