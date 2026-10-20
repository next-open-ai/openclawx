/**
 * Headless mock-gateway acceptance smoke (M0).
 *
 * Drives the SAME orchestration endpoints the desktop renderer will consume:
 *  1. chat session: send message → run settles → assistant text persisted
 *  2. approval: pending → allow + resumeContext → same turn re-runs (echo#2)
 *  3. project: draft → confirm → scheduler completes tasks → transcripts
 *
 * Requires the API running in smoke mode so no model/network is needed:
 *   OPENCLAWX_ORCH_RUNNER=memory-approval OPENCLAWX_DATA_DIR=<tmp> node apps/api/dist/main.cjs
 *
 * Usage:
 *   OPENCLAWX_API_PORT=4399 node scripts/headless-gateway-smoke.mjs
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

function waitFor(fn, timeoutMs = 8000, label = 'state') {
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

const context = () => ({
  profile: { id: 'general', name: 'General Assistant', instructions: 'You are a helpful assistant.', toolIds: [] },
  model: { provider: 'ollama', chatModel: 'smoke', apiKey: 'ollama' },
  skills: [],
  searchProviders: [],
  mcpConnections: [],
  knowledgeBases: [],
});

async function main() {
  // 1) chat session shared state
  const created = await json('/sessions', { method: 'POST', body: JSON.stringify({ title: 'gateway-smoke', employeeId: 'general' }) });
  const sessionId = created.session.id;
  const message = await json(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '请生成一份测试报告', context: context() }),
  });
  assert.ok(message.runId, 'run started');

  // Either the run settles with text (echo mode), or it parks on approval
  // (approval mode) and must be resolved with resumeContext first.
  const session = await waitFor(async () => {
    const { session: current } = await json(`/sessions/${sessionId}`);
    const assistant = current.messages.find((m) => m.role === 'assistant' && !m.superseded);
    if (assistant?.content?.includes('echo#')) return current;
    const approvals = await json(`/sessions/${sessionId}/approvals`);
    return approvals.pending.length ? { ...current, __pending: approvals.pending } : null;
  }, 8000, 'chat reply or pending approval');

  if (session.__pending?.length) {
    const approval = session.__pending[0].approvals[0];
    assert.equal(approval.status, 'pending');
    const resolved = await json(`/sessions/${sessionId}/approvals/${approval.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ allow: true, scope: 'session', resumeContext: context() }),
    });
    assert.ok(resolved.resumedRunId, 'approval resumed the same turn');
    await waitFor(async () => {
      const { session: current } = await json(`/sessions/${sessionId}`);
      const assistant = current.messages.find((m) => m.role === 'assistant' && !m.superseded);
      return assistant?.content?.includes('echo#') ? true : null;
    }, 8000, 'resumed run reply');
    console.log('[smoke] approval resolved & same-turn resume settled');
  } else {
    console.log('[smoke] chat session run settled:', session.messages.at(-1)?.content.slice(0, 40));
  }
  const settled = await json(`/sessions/${sessionId}`);
  assert.ok(settled.session.messages.some((m) => m.role === 'assistant' && !m.superseded && m.content.includes('echo#')));

  // 3) project scheduling over HTTP
  const project = await json('/projects', {
    method: 'POST',
    body: JSON.stringify({
      goal: '产出一份行业分析报告',
      mode: 'parallel',
      workspacePath: '/tmp/smoke-workspace',
      coordinator: { provider: 'ollama', model: 'smoke' },
      tasks: [
        { title: '调研', objective: '调研行业现状', employeeId: 'general', skillIds: [] },
        { title: '写作', objective: '撰写正文', employeeId: 'general', skillIds: [] },
        { title: '质检', objective: '检查质量', employeeId: 'general', skillIds: [] },
      ],
    }),
  });
  const projectId = project.project.id;
  await json(`/projects/${projectId}/confirm`, { method: 'POST', body: JSON.stringify({ defaultContext: context() }) });

  const done = await waitFor(async () => {
    const { project: current } = await json(`/projects/${projectId}`);
    return current.status === 'completed' ? current : null;
  }, 15_000, 'project completion');
  assert.ok(done.tasks.every((t) => t.status === 'completed'), 'all tasks completed');
  const runs = await json(`/projects/${projectId}/runs`);
  assert.equal(runs.runs.length, 1);
  assert.equal(runs.runs[0].status, 'completed');
  console.log('[smoke] project completed with', done.tasks.length, 'tasks; run status', runs.runs[0].status);

  console.log('\n[smoke] ALL PASS');
}

main().catch((error) => {
  console.error('[smoke] FAILED:', error.message);
  process.exit(1);
});
