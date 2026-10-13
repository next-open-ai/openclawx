import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, truncateSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { Orchestrator, type AgentRunner } from '@workmate/orchestrator';
import { PublishProjectApplicationSchema, type ProjectApplicationView } from '@workmate/contracts';
import { registerProjectApplicationRoutes, projectSiteRoutes } from './project-application-routes.js';
import { projectApplications, ProjectApplications } from './project-application.js';
import type { AuthPrincipal } from '../auth/service.js';

const alice: AuthPrincipal = { userId: 'alice', orgId: 'org', role: 'member', username: 'alice', displayName: 'Alice', sessionId: 'fixture' };
const context = { profile: { id: 'general', name: 'fixture', instructions: 'fixture', toolIds: [] }, model: { provider: 'ollama' as const, chatModel: 'fixture', apiKey: 'fixture' }, skills: [], searchProviders: [], mcpConnections: [], knowledgeBases: [] };

test('PA-T1/T2/T3/T5/T6: independent turns, preview, publish, failure preservation and restart continuation', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workmate-project-app-'));
  const saved = { data: process.env.WORKMATE_DATA_DIR, runs: process.env.WORKMATE_WORKSPACES_DIR };
  process.env.WORKMATE_DATA_DIR = root; process.env.WORKMATE_WORKSPACES_DIR = path.join(root, 'runs');
  const workspace = path.join(root, 'project'); mkdirSync(path.join(workspace, 'inputs'), { recursive: true });
  writeFileSync(path.join(workspace, 'inputs/private.json'), '{"private":"do not publish"}');
  let calls = 0;
  const runner: AgentRunner = { async start(request, emit, options) {
    calls++; const directory = path.join(root, 'runs', request.runId!, 'output');
    if (calls > 1) assert.match(readFileSync(path.join(directory, 'index.html'), 'utf8'), calls === 2 ? /version one/ : /version two/);
    if (request.messages.at(-1)?.content === 'hold busy check') {
      await new Promise<void>(resolve => options?.abortSignal?.aborted ? resolve() : options?.abortSignal?.addEventListener('abort', () => resolve(), { once: true }));
      emit({ type: 'run.cancelled', runId: request.runId!, reason: 'user', message: 'synthetic cancel' }); return;
    }
    const version = calls === 1 ? 'version one' : calls === 2 ? 'version two' : calls === 5 ? 'version three after restart' : 'failed change';
    if (calls === 5) assert.ok(request.messages.some(message => message.role === 'assistant' && message.content.includes('version two')), 'history survives reopen');
    writeFileSync(path.join(directory, 'index.html'), `<html><head><link rel="stylesheet" href="assets/site.css"></head><body><h1>${version}</h1><script src="assets/site.js"></script></body></html>`);
    mkdirSync(path.join(directory, 'assets'), { recursive: true });
    writeFileSync(path.join(directory, 'assets/site.css'), 'h1 { color: blue }'); writeFileSync(path.join(directory, 'assets/site.js'), 'window.appReady = true;');
    if (calls === 3) emit({ type: 'run.failed', runId: request.runId!, message: 'synthetic failure' });
    else { emit({ type: 'message.delta', runId: request.runId!, text: `Completed ${version}` }); emit({ type: 'run.completed', runId: request.runId! }); }
  } };
  let orch = Orchestrator.open(path.join(root, 'domain.json'), { runner, contextResolver: () => context });
  const app = Fastify();
  await app.register(async secured => {
    secured.addHook('preHandler', async request => { request.auth = { ...alice, userId: String(request.headers['x-user'] ?? 'alice'), orgId: String(request.headers['x-org'] ?? 'org') }; });
    registerProjectApplicationRoutes(secured, orch);
  }, { prefix: '/api/orch' });
  let managed = false;
  await app.register(projectSiteRoutes, { prefix: '/api', orchestrator: () => orch, dataApp: async (projectId, principal) => {
    assert.equal(projectId, 'p'); assert.equal(principal.userId, 'alice'); return managed ? 'synthetic-app' : undefined;
  } });
  const base = '/api/orch/projects/p/application';
  const post = (action: string, payload?: object, headers?: Record<string, string>) => app.inject({ method: 'POST', url: `${base}/${action}`, payload, headers });
  const get = () => app.inject({ url: base });
  const send = async (content: string) => {
    await orch.projects.dispatchInstruction('p', { employeeId: 'general', content });
    for (let i = 0; i < 150; i++) { if ((await orch.projects.getProject('p'))?.status !== 'running') return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('synthetic turn did not settle');
  };
  try {
    await orch.projects.createDraftOnce('p', { kind: 'conversation', name: 'App', goal: '', mode: 'dag', tasks: [], workspacePath: workspace, ownerUserId: 'alice', orgId: 'org', accessScope: 'private' });
    assert.equal(calls, 0); assert.equal((await get()).json().entrypoint, null);
    assert.equal((await post('preview')).json().code, 'APPLICATION_ENTRY_MISSING');
    assert.equal((await post('view')).statusCode, 404);
    assert.equal((await post('publish', { revision: 'fake', expectedVersion: null })).statusCode, 400);
    assert.equal(PublishProjectApplicationSchema.safeParse({ revision: 'a'.repeat(64), expectedVersion: null, root: '/' }).success, false);
    await send('create application');
    const response = await post('preview'); assert.equal(response.statusCode, 200, response.body);
    const one = response.json<ProjectApplicationView>(); assert.equal(one.fileCount, 3);
    assert.equal((await get()).json().published, null, 'preview never publishes');
    const previewContent = await app.inject({ url: one.viewPath }); assert.match(previewContent.body, /version one/);
    assert.ok(!previewContent.body.includes('window.workmateData='), 'ordinary static apps get no SDK');
    managed = true;
    const dataPreview = await app.inject({ url: one.viewPath });
    assert.match(dataPreview.body, /window.workmateData=/); assert.match(dataPreview.body, /workmate.app.query/);
    assert.ok(!dataPreview.body.includes('x-workmate-session'), 'read-only view ticket carries no data identity');
    managed = false;
    assert.match(String(previewContent.headers['content-security-policy']), /sandbox allow-scripts allow-forms/);
    assert.doesNotMatch(String(previewContent.headers['content-security-policy']), /allow-same-origin/);
    assert.match(String(previewContent.headers['content-security-policy']), /connect-src 'none'/);
    const siteBase = one.viewPath.replace('index.html', '');
    assert.equal((await app.inject({ url: siteBase + 'assets/site.js' })).statusCode, 200);
    assert.equal((await app.inject({ url: siteBase + 'inputs/private.json' })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/project-sites/invalid/index.html' })).statusCode, 401);
    await assert.rejects(projectApplications(orch).content(one.viewPath.split('/')[3], '../domain.json'), /路径/);
    const initial = await post('publish', { revision: one.revision, expectedVersion: null }); assert.equal(initial.statusCode, 200, initial.body);
    assert.equal((await post('publish', { revision: one.revision, expectedVersion: null })).json().published.publishedAt, initial.json().published.publishedAt);
    for (const headers of [{ 'x-user': 'bob' }, { 'x-org': 'other' }] as Record<string, string>[]) {
      assert.equal((await post('preview', undefined, headers)).statusCode, 403);
      assert.equal((await post('publish', { revision: one.revision, expectedVersion: one.revision }, headers)).statusCode, 403);
    }
    const publishedView = (await post('view')).json<ProjectApplicationView>();
    await send('modify application');
    assert.match(readFileSync(path.join(workspace, 'index.html'), 'utf8'), /version two/);
    assert.match((await app.inject({ url: publishedView.viewPath })).body, /version one/, 'new turn does not auto-publish');
    assert.equal((await post('publish', { revision: one.revision, expectedVersion: one.revision })).statusCode, 409);
    const two = (await post('preview')).json<ProjectApplicationView>(); assert.notEqual(two.revision, one.revision);
    assert.equal((await post('publish', { revision: two.revision, expectedVersion: null })).statusCode, 409);
    const flush = orch.store.flush.bind(orch.store); let failFlush = true;
    await flush(); // Drain unrelated project persistence before injecting this publish failure.
    orch.store.flush = async () => { if (failFlush) { failFlush = false; throw Error('synthetic disk full'); } await flush(); };
    const failed = await post('publish', { revision: two.revision, expectedVersion: one.revision });
    assert.equal(failed.statusCode, 500, failed.body); assert.equal((await get()).json().published.version, one.revision);
    orch.store.flush = flush;
    const updates = await Promise.all([post('publish', { revision: two.revision, expectedVersion: one.revision }), post('publish', { revision: two.revision, expectedVersion: one.revision })]);
    assert.ok(updates.every(result => result.statusCode === 200));
    assert.equal(updates[0].json().published.publishedAt, updates[1].json().published.publishedAt);
    await send('fail application change');
    assert.equal((await orch.projects.getProject('p'))?.status, 'failed');
    assert.match(readFileSync(path.join(workspace, 'index.html'), 'utf8'), /version two/);
    assert.equal((await get()).json().published.version, two.revision);
    const current = (await post('view')).json<ProjectApplicationView>();
    assert.match((await app.inject({ url: current.viewPath })).body, /version two/);
    await orch.projects.dispatchInstruction('p', { employeeId: 'general', content: 'hold busy check' });
    for (let i = 0; i < 100 && Number(calls) !== 4; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 4);
    assert.equal((await post('preview')).statusCode, 409, 'running project cannot preview an unfinished draft');
    assert.equal((await post('publish', { revision: two.revision, expectedVersion: two.revision })).statusCode, 409);
    assert.match((await app.inject({ url: current.viewPath })).body, /version two/, 'published view remains usable during a Run');
    await orch.projects.cancelActiveRun('p');
    for (let i = 0; i < 100 && (await orch.engine.listRuns()).some(run => run.status === 'running'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    await orch.close(); orch = Orchestrator.open(path.join(root, 'domain.json'), { runner, contextResolver: () => context });
    await orch.recoverOnBoot();
    assert.equal((await projectApplications(orch).status(alice, 'p')).published?.version, two.revision);
    await assert.rejects(projectApplications(orch).content(current.viewPath.split('/')[3], 'index.html'), /过期/);
    // A new turn after failure/cancellation/restart must neither replay history nor update publication.
    await send('continue after restart');
    assert.equal(calls, 5);
    assert.equal((await orch.projects.getProject('p'))?.status, 'completed');
    assert.match(readFileSync(path.join(workspace, 'index.html'), 'utf8'), /version three after restart/);
    const reopened = projectApplications(orch);
    assert.equal((await reopened.status(alice, 'p')).published?.version, two.revision);
    const stillTwo = await reopened.publishedView(alice, 'p');
    assert.match((await reopened.content(stillTwo.viewPath.split('/')[3], 'index.html')).bytes.toString(), /version two/);
    const three = await reopened.preview(alice, 'p');
    await reopened.publish(alice, 'p', { revision: three.revision, expectedVersion: two.revision });
    assert.equal((await reopened.status(alice, 'p')).published?.version, three.revision);
    let now = Date.now(); const clocked = new ProjectApplications(orch, root, () => now);
    const expiring = await clocked.publishedView(alice, 'p'); now += 31 * 60 * 1000;
    await assert.rejects(clocked.content(expiring.viewPath.split('/')[3], 'index.html'), /过期/);
  } finally {
    await app.close(); await orch.close();
    if (saved.data === undefined) delete process.env.WORKMATE_DATA_DIR; else process.env.WORKMATE_DATA_DIR = saved.data;
    if (saved.runs === undefined) delete process.env.WORKMATE_WORKSPACES_DIR; else process.env.WORKMATE_WORKSPACES_DIR = saved.runs;
    rmSync(root, { recursive: true, force: true });
  }
});

test('PA-T2/T5: nested entry, excluded materials, unsafe files, limits and permission revocation', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workmate-project-site-safety-'));
  const orch = Orchestrator.memory(); const service = new ProjectApplications(orch, root);
  const workspace = path.join(root, 'project'); mkdirSync(path.join(workspace, 'output'), { recursive: true });
  const page = path.join(workspace, 'output/index.html'); writeFileSync(page, '<h1>nested application</h1>');
  for (const directory of ['inputs', 'scripts', '.workmate']) { mkdirSync(path.join(workspace, 'output', directory)); writeFileSync(path.join(workspace, 'output', directory, 'secret.html'), 'private'); }
  writeFileSync(path.join(workspace, 'output/secret.env'), 'PRIVATE=secret');
  try {
    await orch.projects.createDraftOnce('safe', { kind: 'conversation', name: 'safe', goal: '', mode: 'dag', tasks: [], workspacePath: workspace, orgId: 'org', ownerUserId: 'alice' });
    const view = await service.preview(alice, 'safe'); assert.equal(view.entrypoint, 'output/index.html'); assert.equal(view.fileCount, 1);
    symlinkSync(path.join(root, 'outside'), path.join(workspace, 'output/link'));
    await assert.rejects(service.preview(alice, 'safe'), /符号链接/); rmSync(path.join(workspace, 'output/link'));
    truncateSync(page, 9 * 1024 * 1024); await assert.rejects(service.preview(alice, 'safe'), /8MB/); writeFileSync(page, '<h1>nested application</h1>');
    const resources = path.join(workspace, 'output/assets'); mkdirSync(resources);
    for (let i = 0; i < 501; i++) writeFileSync(path.join(resources, `${i}.js`), 'void 0');
    await assert.rejects(service.preview(alice, 'safe'), /500/); rmSync(resources, { recursive: true }); mkdirSync(resources);
    const image = Buffer.alloc(7 * 1024 * 1024);
    for (let i = 0; i < 5; i++) writeFileSync(path.join(resources, `${i}.png`), image);
    await assert.rejects(service.preview(alice, 'safe'), /32MB/); rmSync(resources, { recursive: true });
    await orch.projects.updateAccess('safe', { accessScope: 'delegated', accessGrants: [{ subjectType: 'user', subjectId: 'bob', permissions: ['read'], createdAt: Date.now() }] });
    const bob = { ...alice, userId: 'bob' }; const bobView = await service.preview(bob, 'safe');
    await assert.rejects(service.publish(bob, 'safe', { revision: bobView.revision, expectedVersion: null }), /无权/);
    await orch.projects.updateAccess('safe', { accessScope: 'private', accessGrants: [] });
    await assert.rejects(service.content(bobView.viewPath.split('/')[3], 'index.html'), /无权/);
    await orch.projects.createDraftOnce('legacy', { goal: 'legacy', mode: 'dag', tasks: [], workspacePath: workspace, orgId: 'org', ownerUserId: 'alice' });
    await assert.rejects(service.status(alice, 'legacy'), /持续对话/);
    await orch.store.set('project-application:v1:safe', JSON.stringify({ version: '../../../', entrypoint: 'index.html', resources: ['domain.json'], fileCount: 1, bytes: 1, publishedAt: Date.now() }));
    await assert.rejects(service.publishedView(alice, 'safe'), /发布记录不完整/, 'untrusted metadata must never select a filesystem root');
  } finally { await orch.close(); rmSync(root, { recursive: true, force: true }); }
});
