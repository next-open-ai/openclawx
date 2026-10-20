#!/usr/bin/env node

const baseUrl = process.env.OPENCLAWX_LOADTEST_BASE_URL || 'http://127.0.0.1:4329/api';
const adminPassword = 'admin123';
const memberPassword = 'member123';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}, token) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set('x-openclawx-session', token);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${body.message || body.raw || text}`);
  }
  return body;
}

function runContext(label) {
  return {
    profile: {
      id: `profile-${label}`,
      name: 'Load Test Assistant',
      instructions: 'You are a helpful assistant for concurrency load testing.',
      toolIds: [],
    },
    model: {
      provider: 'openai',
      chatModel: 'gpt-test',
      apiKey: 'x',
    },
    skills: [],
    searchProviders: [],
    mcpConnections: [],
    knowledgeBases: [],
    runTimeoutMs: 60000,
    maxSteps: 8,
  };
}

async function ensureBootstrap() {
  const bootstrap = await request('/auth/bootstrap');
  if (bootstrap.needsSetup) {
    return request('/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({
        orgId: bootstrap.orgId || 'local-org',
        username: 'admin',
        displayName: 'Admin',
        password: adminPassword,
      }),
    });
  }
  return request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
  });
}

async function ensureMember(adminToken) {
  const users = await request('/auth/users', {}, adminToken);
  const existing = (users.users || []).find((item) => item.username === 'member');
  if (existing) return existing;
  const created = await request('/auth/users', {
    method: 'POST',
    body: JSON.stringify({
      username: 'member',
      displayName: 'Member',
      password: memberPassword,
      role: 'member',
    }),
  }, adminToken);
  return created.user;
}

async function createSession(token, title) {
  const { session } = await request('/orch/sessions', {
    method: 'POST',
    body: JSON.stringify({ title }),
  }, token);
  return session;
}

async function sendMessage(token, sessionId, content, label) {
  const startedAt = Date.now();
  const body = await request(`/orch/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content,
      context: runContext(label),
    }),
  }, token);
  return { ...body, requestedAt: startedAt };
}

async function getRun(token, runId) {
  const { run } = await request(`/orch/runs/${runId}`, {}, token);
  return run;
}

async function getRuntimeStatus(token) {
  return request('/orch/runtime/status', {}, token);
}

async function waitForRuns(runs, tokensByLabel) {
  const sampleHistory = [];
  const terminal = new Map();
  const started = Date.now();
  while (terminal.size < runs.length) {
    const runtime = await getRuntimeStatus(tokensByLabel.admin);
    sampleHistory.push({
      at: Date.now(),
      dispatcher: runtime.dispatcher ? {
        queued: runtime.dispatcher.counts.queued,
        running: runtime.dispatcher.counts.running,
        highPriorityQueued: runtime.dispatcher.counts.highPriorityQueued,
        normalPriorityQueued: runtime.dispatcher.counts.normalPriorityQueued,
        waitReasons: runtime.dispatcher.runs.map((item) => item.waitReason || 'running'),
      } : null,
    });
    for (const run of runs) {
      if (terminal.has(run.label)) continue;
      const state = await getRun(tokensByLabel[run.owner], run.runId);
      if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') {
        terminal.set(run.label, {
          status: state.status,
          transcript: state.transcript,
          error: state.error || null,
        });
      }
    }
    if (terminal.size === runs.length) break;
    if (Date.now() - started > 45000) throw new Error('Timed out waiting for runs to settle.');
    await sleep(200);
  }
  return { terminal, sampleHistory };
}

function summarizeSamples(sampleHistory) {
  const maxQueued = Math.max(...sampleHistory.map((item) => item.dispatcher?.queued ?? 0), 0);
  const maxRunning = Math.max(...sampleHistory.map((item) => item.dispatcher?.running ?? 0), 0);
  const seenReasons = [...new Set(sampleHistory.flatMap((item) => item.dispatcher?.waitReasons ?? []).filter(Boolean))];
  return { maxQueued, maxRunning, seenReasons };
}

async function runScenario(name, operations, tokensByLabel) {
  const issued = await Promise.all(operations.map(async (op) => {
    const result = await sendMessage(tokensByLabel[op.owner], op.sessionId, op.content, op.label);
    return { ...op, ...result };
  }));
  const { terminal, sampleHistory } = await waitForRuns(issued, tokensByLabel);
  return {
    name,
    issued: issued.map((item) => ({
      label: item.label,
      owner: item.owner,
      sessionId: item.sessionId,
      runId: item.runId,
      turnId: item.turnId,
    })),
    summary: summarizeSamples(sampleHistory),
    terminal: Object.fromEntries([...terminal.entries()]),
  };
}

async function main() {
  const adminAuth = await ensureBootstrap();
  await ensureMember(adminAuth.token);
  const memberAuth = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'member', password: memberPassword }),
  });
  const tokensByLabel = { admin: adminAuth.token, member: memberAuth.token };

  const adminSessionA = await createSession(adminAuth.token, 'admin-a');
  const adminSessionB = await createSession(adminAuth.token, 'admin-b');
  const memberSessionA = await createSession(memberAuth.token, 'member-a');
  const memberSessionB = await createSession(memberAuth.token, 'member-b');

  const userCapScenario = await runScenario('per-user-limit', [
    { label: 'admin-1', owner: 'admin', sessionId: adminSessionA.id, content: 'load test admin one' },
    { label: 'admin-2', owner: 'admin', sessionId: adminSessionB.id, content: 'load test admin two' },
  ], tokensByLabel);

  const globalCapScenario = await runScenario('global-limit-mixed-users', [
    { label: 'admin-3', owner: 'admin', sessionId: adminSessionA.id, content: 'load test admin three' },
    { label: 'admin-4', owner: 'admin', sessionId: adminSessionB.id, content: 'load test admin four' },
    { label: 'member-1', owner: 'member', sessionId: memberSessionA.id, content: 'load test member one' },
    { label: 'member-2', owner: 'member', sessionId: memberSessionB.id, content: 'load test member two' },
  ], tokensByLabel);

  const output = {
    baseUrl,
    scenarios: [userCapScenario, globalCapScenario],
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
