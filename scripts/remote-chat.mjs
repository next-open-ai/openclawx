/**
 * Remote "chat without client context" acceptance (M0).
 *
 * Same server-side assembler path the desktop chat now uses: create a server
 * session, POST a message with NO `context`, and let the orchestrator resolve
 * the employee's model/skills. Under the `memory-approval` runner the first
 * turn parks on approval, then `allow` WITHOUT `resumeContext` must auto-resume
 * via the resolver and settle (echo#2).
 *
 * Launch:  OPENCLAWX_SECRETS_FILE=<file> OPENCLAWX_ORCH_RUNNER=memory-approval \
 *          OPENCLAWX_DATA_DIR=<tmp> OPENCLAWX_API_PORT=4406 node apps/api/dist/main.cjs
 * Run:     OPENCLAWX_API_PORT=4406 node scripts/remote-chat.mjs
 */
import assert from 'node:assert/strict';

const port = process.env.OPENCLAWX_API_PORT || '47832';
const base = `http://127.0.0.1:${port}/api/orch`;

async function json(pathname, init) {
  const response = await fetch(`${base}${pathname}`, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
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

  const created = await json('/sessions', { method: 'POST', body: JSON.stringify({ title: 'remote-chat', employeeId: 'general' }) });
  const sessionId = created.session.id;

  // No context → server assembles it from KV + keyring.
  await json(`/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ content: '帮我整理一个待办清单' }) });

  // memory-approval runner: first turn parks waiting for approval.
  const pending = await waitFor(async () => {
    const result = await json(`/sessions/${sessionId}/approvals`);
    return result.pending.length ? result.pending : null;
  }, 10_000, 'pending approval (server-assembled run)');
  const approval = pending[0].approvals[0];

  // Allow WITHOUT resumeContext → the server must auto-resume (echo#2).
  await json(`/sessions/${sessionId}/approvals/${approval.id}/resolve`, { method: 'POST', body: JSON.stringify({ allow: true, scope: 'session' }) });

  const session = await waitFor(async () => {
    const current = await json(`/sessions/${sessionId}`);
    const assistant = current.session.messages.find((m) => m.role === 'assistant' && !m.superseded);
    return assistant?.content?.includes('echo#2') ? current.session : null;
  }, 10_000, 'auto-resumed assistant reply');
  assert.ok(session.messages.some((m) => m.role === 'user' && m.content === '帮我整理一个待办清单'));

  console.log('[remote-chat] server-assembled turn + approval auto-resume settled:', session.messages.at(-1)?.content.slice(0, 40));
  console.log('[remote-chat] ALL PASS');
}

main().catch((error) => {
  console.error('[remote-chat] FAILED:', error.message);
  process.exit(1);
});
