import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { dataRoutes, publicDataAppRoutes } from './routes.js';
import { getOrchestrator } from '../orchestration/routes.js';
import { applyParentSecrets } from '../orchestration/secrets.js';
import { createSkillExecutionTools } from '@openclawx/agent-core';
import { createRequire } from 'node:module';
import { AppProjectCoordinator } from './app-project.js';
import type { ProjectService } from '@openclawx/orchestrator';

test('DAP-R2: retry recovers a project created before association persistence without duplicate launch', async () => {
  const require = createRequire(import.meta.url);
  const sqlRoot = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
  const SQL = await require(path.join(sqlRoot, 'sql-wasm.js'))({ wasmBinary: fs.readFileSync(path.join(sqlRoot, 'sql-wasm.wasm')) });
  const db = new SQL.Database(); AppProjectCoordinator.migrate(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-app-recovery-'));
  let interrupted = true; let creations = 0; let starts = 0;
  const projects = new Map<string, object>();
  // Simulate a durable project write followed by interruption before the SQL link write.
  const service = {
    async createDraftOnce(id: string, draft: object) {
      if (!projects.has(id)) { projects.set(id, { ...draft, id }); creations++; }
      if (interrupted) { interrupted = false; throw new Error('synthetic preparation interruption'); }
      return projects.get(id);
    },
    async getProject(id: string) { return projects.get(id); },
    async confirmProject() { starts++; },
  } as unknown as ProjectService;
  const coordinator = new AppProjectCoordinator(db, () => {}, service, root);
  const input = { requestId: randomUUID(), sourceId: 'source', tableId: 'table', employeeId: 'general', permissionTier: 'default' as const, appType: '管理后台' as const, idea: '查询' };
  const appIds = new Set<string>();
  const prepare = (id: string) => { appIds.add(id); return { name: '恢复测试', prompt: 'synthetic' }; };
  try {
    await assert.rejects(coordinator.create({ orgId: 'org', userId: 'owner' }, input, prepare), /interruption/);
    const recovered = await coordinator.create({ orgId: 'org', userId: 'owner' }, input, prepare);
    assert.equal(recovered.started, true);
    await coordinator.create({ orgId: 'org', userId: 'owner' }, input, prepare);
    assert.equal(appIds.size, 1); assert.equal(creations, 1); assert.equal(starts, 1);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('DAP-R1–R5: project-only creation, replay/conflict, owned project execution, latest schema and safe delivery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-app-project-api-'));
  const keys = ['OPENCLAWX_DATA_DIR', 'OPENCLAWX_WORKSPACES_DIR', 'OPENCLAWX_ASSET_STAGING_DIR', 'OPENCLAWX_API_ORIGIN', 'OPENCLAWX_ORCH_RUNNER', 'OPENCLAWX_ORCH_RUNNER_DELAY_MS'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.OPENCLAWX_DATA_DIR = root; process.env.OPENCLAWX_WORKSPACES_DIR = path.join(root, 'runs');
  process.env.OPENCLAWX_ASSET_STAGING_DIR = path.join(root, 'runs');
  process.env.OPENCLAWX_ORCH_RUNNER = 'memory-echo'; process.env.OPENCLAWX_ORCH_RUNNER_DELAY_MS = '500';
  // Synthetic keyring + scripted runner: no model server or actual credentials are used.
  applyParentSecrets({ model: { activeProvider: 'ollama', providers: [{ provider: 'ollama', chatModel: 'synthetic', apiKey: 'synthetic' }] } });
  const app = Fastify();
  app.addHook('preHandler', async request => { request.auth = { userId: String(request.headers['x-test-user'] || 'owner'), orgId: 'test', username: 'test', displayName: 'test', role: 'admin', sessionId: 'test' }; });
  await app.register(dataRoutes, { prefix: '/api' }); await app.register(publicDataAppRoutes, { prefix: '/api' });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 }); process.env.OPENCLAWX_API_ORIGIN = origin;
  const request = (url: string, body: object) => app.inject({ method: 'POST', url: `/api${url}`, payload: body });
  const wait = async (id: string) => { for (let i = 0; i < 60; i++) { const project = await getOrchestrator().projects.getProject(id); if (project?.status !== 'running') return project; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Project did not settle'); };
  try {
    const imported = await request('/data/import', { name: 'synthetic.json', contentBase64: Buffer.from('[{"city":"上海","amount":100}]').toString('base64') });
    assert.equal(imported.statusCode, 200); const source = imported.json();
    const input = { requestId: randomUUID(), sourceId: source.id, tableId: source.tables[0].id, idea: '城市金额查询', employeeId: 'general', name: '项目应用' };
    const [a, b] = await Promise.all([request('/data/apps/project-create', input), request('/data/apps/project-create', input)]);
    assert.equal(a.statusCode, 200, a.body); assert.equal(b.statusCode, 200, b.body);
    const created = a.json(); assert.equal(created.app.id, b.json().app.id); assert.equal(created.projectId, b.json().projectId);
    assert.equal(created.app.appType, '自定义应用');
    assert.equal([a.json(), b.json()].filter(result => result.started).length, 1);
    assert.equal(created.app.delivery.status, 'awaiting-binding');
    assert.equal((await getOrchestrator().projects.listProjects()).length, 1);
    const conflict = await request('/data/apps/project-create', { ...input, idea: '不同的请求' }); assert.equal(conflict.statusCode, 409);
    const unauthorized = await app.inject({ method: 'POST', url: `/api/data/apps/${created.app.id}/project-execute`, headers: { 'x-test-user': 'other' }, payload: { requestId: randomUUID(), idea: '越权' } }); assert.equal(unauthorized.statusCode, 404);
    const running = await request(`/data/apps/${created.app.id}/project-execute`, { requestId: randomUUID(), idea: '并发优化' }); assert.equal(running.statusCode, 409, running.body);
    const project = await wait(created.projectId); assert.equal(project?.status, 'completed');
    assert.doesNotMatch(project!.tasks[0].objective, /类型偏好/);
    assert.match(project!.tasks[0].objective, /不受预设应用类型限制/);
    assert.equal(project?.executionWorkspaceMode, 'isolated'); assert.equal(project?.ownerUserId, 'owner');
    assert.ok(project?.workspacePath.startsWith(path.join(root, 'projects')));
    assert.equal((await getOrchestrator().chat.listChatSessions()).length, 0);
    const listed = (await app.inject({ method: 'GET', url: '/api/data/apps' })).json(); assert.equal(listed.length, 1); assert.equal(listed[0].projectId, created.projectId);
    // Actual workspace tools bind a deterministic page; this is not model generation quality acceptance.
    const token = new URL(listed[0].publishUrl).searchParams.get('token');
    const tools = createSkillExecutionTools({ skills: [], runId: project!.tasks[0].runId!, workspaceAccess: 'write' });
    const invoke = async (name: string, params: object) => (await tools.find(tool => tool.name === name)!.execute('acceptance', params)).details as { ok: boolean };
    assert.equal((await invoke('write_workspace_file', { path: 'output/index.html', content: '<!doctype html><html><body><h1>合成交付页面</h1></body></html>' })).ok, true);
    assert.equal((await invoke('bind_data_app_custom_site', { appId: created.app.id, token, path: 'output/index.html' })).ok, true);
    const annotated = await app.inject({ method: 'PATCH', url: `/api/data/sources/${source.id}/annotations`, payload: { description: '最新金额口径，不含退款' } }); assert.equal(annotated.statusCode, 200);
    // UAT-R4: preserve the existing published document in the next isolated run,
    // then edit/rebind it using the actual gateway tools (not a model-quality test).
    const optimized = await request(`/data/apps/${created.app.id}/project-execute`, { requestId: randomUUID(), idea: '保留已有内容并增加筛选' });
    assert.equal(optimized.statusCode, 200, optimized.body); assert.equal(optimized.json().projectId, created.projectId);
    const optimizedProject = await wait(created.projectId); assert.equal(optimizedProject?.status, 'completed');
    assert.ok(optimizedProject?.tasks[0].objective.includes('最新金额口径'));
    assert.doesNotMatch(optimizedProject!.tasks[0].objective, /类型偏好/);
    assert.ok(optimizedProject?.tasks[0].objective.includes('export_data_app_custom_site'));
    const nextRunId = optimizedProject!.tasks[0].runId!;
    assert.notEqual(nextRunId, project!.tasks[0].runId!);
    const iterationTools = createSkillExecutionTools({ skills: [], runId: nextRunId, workspaceAccess: 'write' });
    const invokeIteration = async (name: string, params: object) => (await iterationTools.find(tool => tool.name === name)!.execute('iteration', params)).details as { ok: boolean };
    assert.equal((await invokeIteration('export_data_app_custom_site', { appId: created.app.id, token, path: 'output/index.html' })).ok, true);
    const exported = fs.readFileSync(path.join(root, 'runs', nextRunId, 'output/index.html'), 'utf8');
    assert.ok(exported.includes('合成交付页面'));
    assert.equal((await invokeIteration('write_workspace_file', { path: 'output/index.html', content: exported.replace('</body>', '<p>新增筛选</p></body>') })).ok, true);
    assert.equal((await invokeIteration('bind_data_app_custom_site', { appId: created.app.id, token, path: 'output/index.html' })).ok, true);
    const sameApp = (await app.inject({ method: 'GET', url: `/api/data/apps/${created.app.id}` })).json();
    const iterationList = (await app.inject({ method: 'GET', url: '/api/data/apps' })).json();
    assert.equal(iterationList[0].publishUrl, listed[0].publishUrl); assert.equal(sameApp.projectId, created.projectId);
    assert.equal((await getOrchestrator().projects.listProjects()).length, 1);
    const published = await app.inject({ method: 'GET', url: `/api/data-apps/${created.app.id}/site?token=${encodeURIComponent(token!)}` });
    assert.equal(published.statusCode, 200); assert.ok(published.body.includes('合成交付页面')); assert.ok(published.body.includes('新增筛选'));
    applyParentSecrets({}); // Missing model must fail honestly while retaining the published site.
    const iteration = { requestId: randomUUID(), idea: '增加筛选' };
    const result = await request(`/data/apps/${created.app.id}/project-execute`, iteration); assert.equal(result.statusCode, 200, result.body);
    const failed = await wait(created.projectId); assert.equal(failed?.status, 'failed'); assert.ok(failed?.tasks[0].objective.includes('最新金额口径'));
    const beforeRuns = (await getOrchestrator().projects.listProjectRuns(created.projectId)).length;
    assert.equal((await request(`/data/apps/${created.app.id}/project-execute`, iteration)).statusCode, 200);
    assert.equal((await getOrchestrator().projects.listProjectRuns(created.projectId)).length, beforeRuns);
    const retained = (await app.inject({ method: 'GET', url: `/api/data/apps/${created.app.id}` })).json(); assert.equal(retained.delivery.status, 'custom-ready');
    const afterFailure = await app.inject({ method: 'GET', url: `/api/data-apps/${created.app.id}/site?token=${encodeURIComponent(token!)}` });
    assert.ok(afterFailure.body.includes('新增筛选'));
    await getOrchestrator().projects.removeProject(created.projectId);
    assert.equal((await request(`/data/apps/${created.app.id}/project-execute`, { requestId: randomUUID(), idea: '继续' })).statusCode, 410);
  } finally {
    await getOrchestrator().close(); await app.close(); applyParentSecrets({});
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
