/**
 * M2 P2 Feishu acceptance (offline fake channel + pure parse/dedupe checks).
 * Requires the local api in memory-echo mode with secrets file set.
 *
 * Launch api: OPENCLAWX_ORCH_RUNNER=memory-echo OPENCLAWX_DATA_DIR=<tmp>
 *   OPENCLAWX_SECRETS_FILE=<file> OPENCLAWX_API_PORT=4416 node apps/api/dist/main.cjs
 * Run: OPENCLAWX_API_PORT=4416 node scripts/gateway-feishu-smoke.mjs
 */
import assert from 'node:assert/strict';
import { createGateway } from '../apps/gateway/dist/gateway.js';
import { parseFeishuEvent, isDuplicateMessage, markMessageProcessed } from '../apps/gateway/dist/adapters/feishu.js';

const port = process.env.OPENCLAWX_API_PORT || '4416';
const apiBase = `http://127.0.0.1:${port}/api/orch`;

async function json(pathname, init) {
  const response = await fetch(`${apiBase}${pathname}`, { headers: init?.body ? { 'content-type': 'application/json' } : undefined, ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname} -> ${response.status}: ${body?.message ?? JSON.stringify(body).slice(0, 200)}`);
  return body;
}

async function seed(key, value) {
  await json('/kv', { method: 'PUT', body: JSON.stringify({ key, value: JSON.stringify(value) }) });
}

function waitFor(fn, timeoutMs = 20_000, label = 'state') {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await fn();
        if (value) return resolve(value);
      } catch {}
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 80);
    };
    void tick();
  });
}

async function main() {
  await seed('workspace.custom-employees', [{ id: 'general', name: '通用助理', instructions: '按要求完成任务。' }]);
  await seed('workspace.employee-runtime-prefs', {
    general: { defaultModelId: 'm1', searchMode: 'off', maxSteps: 12, runTimeoutMs: 120000, mcpToolTimeoutMs: 15000, mcpIds: [], knowledgeProvider: 'off', knowledgeBaseIds: [] },
  });

  // 1) pure parse + dedupe helpers
  const unified = parseFeishuEvent({
    message: { chat_id: 'oc_test123', message_id: 'om_x1', content: JSON.stringify({ text: '你好飞书' }) },
    sender: { sender_id: { open_id: 'ou_9' }, name: '测试用户' },
  });
  assert.ok(unified);
  assert.equal(unified.channelId, 'feishu');
  assert.equal(unified.messageText, '你好飞书');
  markMessageProcessed('om_x1');
  assert.equal(isDuplicateMessage('om_x1'), true, 'message dedupe');
  console.log('[feishu] 1/3 parse + dedupe helpers ok');

  // 2) gateway runtime over the fake Feishu channel (server-assembled chat)
  const gateway = createGateway(
    { apiBaseUrl: apiBase, allowAll: true, channels: { feishu: { enabled: true, appId: 'fake', appSecret: 'fake' } } },
    { fakeFeishu: true },
  );
  assert.ok(gateway.feishuFeed, 'fake feishu feed registered');
  await gateway.feishuFeed({ channelId: 'feishu', threadId: 'oc_test123', userId: 'ou_9', messageText: '帮我整理下会议纪要' });
  await waitFor(async () => (gateway.feishuReplies?.length ?? 0) > 0, 20_000, 'feishu reply');
  assert.match((gateway.feishuReplies ?? [])[0].text, /echo#1/);
  console.log('[feishu] 2/3 chat via fake feishu channel:', (gateway.feishuReplies ?? [])[0].text.slice(0, 40));

  // 3) allowlist applies to feishu too (unauthorized denied)
  await gateway.stop();
  const locked = createGateway(
    { apiBaseUrl: apiBase, allowlist: ['feishu:user:ou_9'], channels: { feishu: { enabled: true, appId: 'fake', appSecret: 'fake' } } },
    { fakeFeishu: true },
  );
  await locked.feishuFeed({ channelId: 'feishu', threadId: 'oc_test123', userId: 'ou_other', messageText: 'hello' });
  await waitFor(async () => (locked.feishuReplies?.length ?? 0) > 0, 5_000, 'feishu denied reply');
  assert.match((locked.feishuReplies ?? [])[0].text, /白名单/);
  console.log('[feishu] 3/3 allowlist denies non-whitelisted feishu user');
  await locked.stop();
  console.log('\n[feishu] ALL PASS');
}

main().catch((error) => {
  console.error('[feishu] FAILED:', error.message);
  process.exit(1);
});
