/**
 * Remote "confirm without context" acceptance (M0).
 *
 * Proves the server-side context assembler: with domain KV seeded (employee
 * catalog + runtime prefs) and the keyring loaded via OPENCLAWX_SECRETS_FILE,
 * a remote terminal can confirm a desktop project with `{}` — no client-side
 * runContext — and the orchestrator resolves model/skills/harness itself.
 *
 * Launch:  OPENCLAWX_SECRETS_FILE=<file> OPENCLAWX_ORCH_RUNNER=memory-echo \
 *          OPENCLAWX_DATA_DIR=<tmp> OPENCLAWX_API_PORT=4404 node apps/api/dist/main.cjs
 * Run:     OPENCLAWX_API_PORT=4404 node scripts/remote-project-confirm.mjs
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
      setTimeout(tick, 60);
    };
    void tick();
  });
}

async function main() {
  await seed('workspace.custom-employees', [{ id: 'general', name: '通用助理', instructions: '按要求完成任务。' }]);
  await seed('workspace.employee-runtime-prefs', {
    general: { defaultModelId: 'm1', searchMode: 'off', maxSteps: 12, runTimeoutMs: 120000, mcpToolTimeoutMs: 15000, mcpIds: [], knowledgeProvider: 'off', knowledgeBaseIds: [] },
  });

  const created = await json('/projects', {
    method: 'POST',
    body: JSON.stringify({
      goal: '产出一份远程确认的项目报告',
      mode: 'waterfall',
      workspacePath: '/tmp/remote-workspace',
      coordinator: { provider: 'ollama', model: 'chat-x' },
      tasks: [
        { id: 't1', title: '任务一', objective: '先写提纲', employeeId: 'general', skillIds: [] },
        { id: 't2', title: '任务二', objective: '再写正文', employeeId: 'general', skillIds: [] },
      ],
    }),
  });
  const projectId = created.project.id;

  // No runContextByTask / defaultContext — server assembler must take over.
  await json(`/projects/${projectId}/confirm`, { method: 'POST', body: JSON.stringify({}) });

  const done = await waitFor(async () => {
    const { project: current } = await json(`/projects/${projectId}`);
    return current.status === 'completed' ? current : null;
  }, 20_000, 'remote project completion');

  assert.ok(done.tasks.every((task) => task.status === 'completed'), 'tasks completed via server assembly');
  for (const task of done.tasks) {
    const { transcript } = await json(`/projects/${projectId}/tasks/${task.id}/transcript`);
    assert.ok(transcript?.transcript?.length > 0, `transcript for ${task.id}`);
  }
  console.log('[remote-confirm] server-assembled confirm completed tasks:', done.tasks.map((t) => `${t.title}:${t.status}`).join(', '));
  console.log('[remote-confirm] ALL PASS');
}

main().catch((error) => {
  console.error('[remote-confirm] FAILED:', error.message);
  process.exit(1);
});
