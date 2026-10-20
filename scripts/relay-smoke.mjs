/**
 * M2 P3 relay acceptance (local, offline): self-hosted RelayServer + gateway
 * device link + a remote terminal over the wire envelope.
 *
 *  1. device registers (hello) with the relay;
 *  2. terminal sends request {deviceId, text} → forwarded → gateway runtime
 *     (server-assembled chat) → text response routed back;
 *  3. text command surface (/help) works over the same envelope.
 *
 * Launch api: OPENCLAWX_ORCH_RUNNER=memory-echo OPENCLAWX_DATA_DIR=<tmp>
 *   OPENCLAWX_SECRETS_FILE=<file> OPENCLAWX_API_PORT=4418 node apps/api/dist/main.cjs
 * Run: OPENCLAWX_API_PORT=4418 node scripts/relay-smoke.mjs
 */
import assert from 'node:assert/strict';
import { RelayServer } from '../apps/gateway/dist/relay/server.js';
import { createGateway } from '../apps/gateway/dist/gateway.js';

const port = process.env.OPENCLAWX_API_PORT || '4418';
const apiBase = `http://127.0.0.1:${port}/api/orch`;
const RELAY_PORT = 8790;
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;

async function json(pathname, init) {
  const response = await fetch(`${apiBase}${pathname}`, { headers: init?.body ? { 'content-type': 'application/json' } : undefined, ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname} -> ${response.status}: ${body?.message ?? JSON.stringify(body).slice(0, 200)}`);
  return body;
}

async function seed(key, value) {
  await json('/kv', { method: 'PUT', body: JSON.stringify({ key, value: JSON.stringify(value) }) });
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('ws connect error')));
  });
}

function waitForMessage(ws, predicate, timeoutMs = 20_000, label = 'frame') {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      try {
        const frame = JSON.parse(typeof event.data === 'string' ? event.data : '');
        if (predicate(frame)) {
          ws.removeEventListener('message', onMessage);
          resolve(frame);
        }
      } catch {}
    };
    ws.addEventListener('message', onMessage);
    setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error(`timeout waiting for ${label}`));
    }, timeoutMs);
  });
}

function request(ws, method, params, id = `t-${Date.now()}`) {
  ws.send(JSON.stringify({ type: 'request', id, method, params }));
  return waitForMessage(ws, (frame) => frame.type === 'response' && frame.id === id, 20_000, `response ${id}`);
}

async function main() {
  await seed('workspace.custom-employees', [{ id: 'general', name: '通用助理', instructions: '按要求完成任务。' }]);
  await seed('workspace.employee-runtime-prefs', {
    general: { defaultModelId: 'm1', searchMode: 'off', maxSteps: 12, runTimeoutMs: 120000, mcpToolTimeoutMs: 15000, mcpIds: [], knowledgeProvider: 'off', knowledgeBaseIds: [] },
  });

  const server = new RelayServer('');
  await server.listen(RELAY_PORT);
  const gateway = createGateway(
    {
      apiBaseUrl: apiBase,
      allowAll: true,
      channels: { relay: { enabled: true, baseUrl: RELAY_URL, deviceId: 'dev-1', token: '' } },
    },
    {},
  );
  assert.ok(gateway.relayReady, 'relay device link created');
  await gateway.relayReady;
  console.log('[relay] 1/3 device registered');

  const terminal = await openWs(RELAY_URL);
  const chat = await request(terminal, 'message', { deviceId: 'dev-1', userId: 'terminal-a', text: '远程帮我整理待办' });
  assert.ok(chat.result?.ok, 'chat request ok');
  assert.match(chat.result?.text ?? '', /echo#1/);
  console.log('[relay] 2/3 terminal chat via relay:', chat.result.text.slice(0, 40));

  const help = await request(terminal, 'message', { deviceId: 'dev-1', text: '/help' });
  assert.match(help.result?.text ?? '', /可用指令/);
  console.log('[relay] 3/3 command surface over relay ok');

  terminal.close();
  await gateway.stop();
  await server.close();
  console.log('\n[relay] ALL PASS');
}

main().catch((error) => {
  console.error('[relay] FAILED:', error.message);
  process.exit(1);
});
