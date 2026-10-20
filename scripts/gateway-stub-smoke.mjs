/**
 * M1 stub end-to-end acceptance: gateway + offline stub channel against a real
 * orchestrator API (memory-echo runner, secrets file set).
 *
 *  1. allowlist denies an unknown user
 *  2. plain chat text → server-assembled session run settles (echo)
 *  3. /projects list and /project start <id> schedule a server project;
 *     project completes and its status is observable
 *
 * Launch api: OPENCLAWX_ORCH_RUNNER=memory-echo OPENCLAWX_DATA_DIR=<tmp>
 *   OPENCLAWX_SECRETS_FILE=<file> OPENCLAWX_API_PORT=4410 node apps/api/dist/main.cjs
 * Run: OPENCLAWX_API_PORT=4410 node scripts/gateway-stub-smoke.mjs
 */
import assert from 'node:assert/strict';
import { unregisterChannel, listChannels } from '../packages/channel/dist/index.js';
import { createGateway } from '../apps/gateway/dist/gateway.js';

const port = process.env.OPENCLAWX_API_PORT || '4410';
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

function waitFor(fn, timeoutMs = 15_000, label = 'state') {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await fn();
        if (value) return resolve(value);
      } catch {}
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 60);
    };
    void tick();
  });
}

function clearRegistry() {
  for (const channel of listChannels()) unregisterChannel(channel.id);
}

async function main() {
  await seed('workspace.custom-employees', [{ id: 'general', name: '通用助理', instructions: '按要求完成任务。' }]);
  await seed('workspace.employee-runtime-prefs', {
    general: { defaultModelId: 'm1', searchMode: 'off', maxSteps: 12, runTimeoutMs: 120000, mcpToolTimeoutMs: 15000, mcpIds: [], knowledgeProvider: 'off', knowledgeBaseIds: [] },
  });

  // 1) allowlist denies an unknown user
  clearRegistry();
  const locked = createGateway({ apiBaseUrl: apiBase, allowlist: ['stub:user:u-owner'] }, { stub: true });
  await locked.stubFeed({ channelId: 'stub', threadId: 'chat-x', userId: 'stranger', messageText: 'hello' });
  await waitFor(async () => (locked.stubReplies?.length ?? 0) > 0, 3_000, 'denied reply');
  assert.match((locked.stubReplies ?? [])[0].text, /白名单/);
  console.log('[gateway-stub] 1/3 allowlist denied stranger');
  await locked.stop();
  clearRegistry();

  // 2) plain chat text → server-assembled session run (echo)
  const allowed = createGateway({ apiBaseUrl: apiBase, allowAll: true }, { stub: true });
  await allowed.stubFeed({ channelId: 'stub', threadId: 'chat-1', userId: 'u-owner', messageText: '你好，帮我列一个清单' });
  await waitFor(async () => (allowed.stubReplies?.length ?? 0) > 0, 20_000, 'chat reply');
  assert.match((allowed.stubReplies ?? [])[0].text, /echo#1/);
  console.log('[gateway-stub] 2/3 chat reply via gateway session:', (allowed.stubReplies ?? [])[0].text.slice(0, 40));

  // 3) /projects + /project start schedules the server project
  const project = await json('/projects', {
    method: 'POST',
    body: JSON.stringify({
      goal: '网关验收项目', mode: 'waterfall', workspacePath: '/tmp/gw-ws',
      coordinator: { provider: 'ollama', model: 'chat-x' },
      tasks: [
        { title: '任务一', objective: '第一步', employeeId: 'general', skillIds: [] },
        { title: '任务二', objective: '第二步', employeeId: 'general', skillIds: [] },
      ],
    }),
  });
  const projectId = project.project.id;
  const startReply = (allowed.stubReplies ?? []).length;
  await allowed.stubFeed({ channelId: 'stub', threadId: 'chat-1', userId: 'u-owner', messageText: `/project start ${projectId}` });
  await waitFor(async () => (allowed.stubReplies?.length ?? 0) > startReply, 5_000, 'start reply');
  assert.match((allowed.stubReplies ?? [])[startReply].text, /已启动项目/);

  await waitFor(async () => (await json(`/projects/${projectId}`)).project.status === 'completed', 25_000, 'project complete');
  const done = await json(`/projects/${projectId}`);
  assert.ok(done.project.tasks.every((t) => t.status === 'completed'));
  console.log('[gateway-stub] 3/3 /project start scheduled via gateway, tasks completed:', done.project.tasks.length);
  await allowed.stop();
  clearRegistry();
  console.log('\n[gateway-stub] ALL PASS');
}

main().catch((error) => {
  console.error('[gateway-stub] FAILED:', error.message);
  process.exit(1);
});
