import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, symlinkSync, writeFileSync, readdirSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { Orchestrator } from '@workmate/orchestrator';
import { registerProjectInstructionRoutes } from './project-instructions.js';
import { orchestrationRoutes, getOrchestrator, closeOrchestrator } from './routes.js';
import { workspaceRoutes } from '../workspace/routes.js';

test('LP-T1: authenticated conversation creation is private, empty, strict and never calls a model', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'workmate-lp-api-'));
  const saved = { data: process.env.WORKMATE_DATA_DIR, runner: process.env.WORKMATE_ORCH_RUNNER };
  process.env.WORKMATE_DATA_DIR = root; process.env.WORKMATE_ORCH_RUNNER = 'memory-echo';
  const app = Fastify();
  app.addHook('preHandler', async request => { request.auth = { userId: String(request.headers['x-user'] || 'alice'), orgId: 'org', role: 'member', username: 'test', displayName: 'test', sessionId: 'mock' }; });
  await app.register(orchestrationRoutes, { prefix: '/api/orch' });
  await app.register(workspaceRoutes, { prefix: '/api' });
  try {
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/orch/projects/conversations', payload });
    assert.equal((await post({ name: ' ' })).statusCode, 400);
    assert.equal((await post({ name: '报告', workspacePath: '/' })).statusCode, 400);
    const response = await post({ name: '报告', goal: '持续优化' });
    assert.equal(response.statusCode, 200, response.body);
    const { project } = response.json();
    assert.equal(project.kind, 'conversation'); assert.equal(project.plan, undefined);
    assert.equal(project.ownerUserId, 'alice'); assert.equal(project.accessScope, 'private');
    assert.equal(project.executionWorkspaceMode, 'isolated'); assert.deepEqual(project.tasks, []);
    assert.ok(project.workspacePath.startsWith(path.join(root, 'projects', 'conversation-')));
    assert.deepEqual(await getOrchestrator().engine.listRuns(), []);
    const parent = path.join(root, 'user-location'); mkdirSync(parent);
    writeFileSync(path.join(parent, 'keep.txt'), 'existing user file');
    for (const parentPath of ['relative/path', '/', path.join(root, 'missing'), path.join(parent, 'keep.txt')]) {
      const rejected = await post({ name: '无效目录', workspace: { mode: 'custom', parentPath } });
      assert.equal(rejected.statusCode, 400, rejected.body);
      assert.equal(rejected.json().code, 'PROJECT_DIRECTORY_INVALID');
    }
    symlinkSync(parent, path.join(root, 'link'));
    assert.equal((await post({ name: '快捷链接', workspace: { mode: 'custom', parentPath: path.join(root, 'link') } })).statusCode, 400);
    if (process.getuid?.() !== 0) {
      const readOnly = path.join(root, 'read-only'); mkdirSync(readOnly); chmodSync(readOnly, 0o500);
      try { assert.equal((await post({ name: '只读位置', workspace: { mode: 'custom', parentPath: readOnly } })).statusCode, 400); }
      finally { chmodSync(readOnly, 0o700); }
    }
    assert.equal((await post({ name: '无效模式', workspace: { mode: 'unknown' } })).statusCode, 400);
    const createCustom = () => post({ name: '自选目录', workspace: { mode: 'custom', parentPath: parent } });
    const first = await createCustom(); const second = await createCustom();
    assert.equal(first.statusCode, 200, first.body); assert.equal(second.statusCode, 200, second.body);
    assert.equal(path.dirname(first.json().project.workspacePath), realpathSync(parent));
    assert.notEqual(first.json().project.workspacePath, second.json().project.workspacePath);
    assert.deepEqual(readdirSync(first.json().project.workspacePath), []);
    assert.equal(readFileSync(path.join(parent, 'keep.txt'), 'utf8'), 'existing user file');
    assert.equal((await getOrchestrator().projects.listProjects()).length, 3, 'invalid directories must not persist projects');
    assert.deepEqual(await getOrchestrator().engine.listRuns(), [], 'directory choice must not start a model');
    const legacySync = await app.inject({ method: 'POST', url: '/api/workspace/sync-run', payload: { root: project.workspacePath, runId: 'failed-old-run' } });
    assert.equal(legacySync.statusCode, 409);
    assert.deepEqual(await getOrchestrator().projects.listProjectRuns(project.id), []);
    const hidden = await app.inject({ url: `/api/orch/projects/${project.id}`, headers: { 'x-user': 'bob' } });
    assert.ok(hidden.statusCode >= 400);
    const replay = await app.inject({ method: 'POST', url: `/api/orch/projects/${project.id}/confirm`, payload: {} });
    assert.ok(replay.statusCode >= 400);
    assert.deepEqual(await getOrchestrator().engine.listRuns(), []);
  } finally {
    await app.close(); await closeOrchestrator();
    if (saved.data === undefined) delete process.env.WORKMATE_DATA_DIR; else process.env.WORKMATE_DATA_DIR = saved.data;
    if (saved.runner === undefined) delete process.env.WORKMATE_ORCH_RUNNER; else process.env.WORKMATE_ORCH_RUNNER = saved.runner;
    rmSync(root, { recursive: true, force: true });
  }
});

test('PC-T4: project documents are scoped, validated and materialized before follow-up', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'workmate-pc-'));
  const saved = process.env.WORKMATE_DATA_DIR; process.env.WORKMATE_DATA_DIR = root;
  const orch = Orchestrator.memory(); const app = Fastify();
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.addHook('preHandler', async request => { request.auth = { userId: String(request.headers['x-user'] || 'alice'), orgId: 'org', role: 'member', username: 'test', displayName: 'test', sessionId: 'mock' }; });
  registerProjectInstructionRoutes(app, orch);
  const workspace = path.join(root, 'custom-project'); mkdirSync(workspace);
  const project = await orch.projects.createDraft({ goal: '分析', orgId: 'org', ownerUserId: 'alice', accessScope: 'private', workspacePath: workspace, mode: 'dag', tasks: [{ title: '分析', employeeId: 'general', objective: '分析材料', skillIds: [] }] });
  const base = `/projects/${project.id}`; const requestId = randomUUID();
  const upload = (user = 'alice', id: string = requestId) => app.inject({ method: 'POST', url: `${base}/uploads/${id}`, headers: { 'content-type': 'application/octet-stream', 'x-workmate-file-name': encodeURIComponent('九月收入.txt'), 'x-user': user }, payload: Buffer.from('九月收入：150000元') });
  const send = (payload: object, user = 'alice') => app.inject({ method: 'POST', url: `${base}/instructions`, headers: { 'x-user': user }, payload });
  const waitDone = async () => { for (let i = 0; i < 100; i++) { if ((await orch.projects.getProject(project.id))?.status !== 'running') return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error('project did not settle'); };
  try {
    assert.equal((await upload('bob')).statusCode, 404);
    assert.equal((await upload('alice', '../bad')).statusCode >= 400, true);
    const uploaded = await upload(); assert.equal(uploaded.statusCode, 200);
    const fileId = uploaded.json().attachment.id;
    const input = { employeeId: 'general', content: '继续分析九月', requestId, fileIds: [fileId] };
    assert.equal((await send(input, 'bob')).statusCode, 404);
    assert.equal((await send({ ...input, employeeId: 'outsider' })).statusCode, 400);
    assert.equal((await send({ ...input, requestId: randomUUID() })).statusCode, 400);
    assert.equal((await send({ ...input, fileIds: [fileId, fileId] })).statusCode, 400);
    assert.equal((await send({ ...input, requestId: undefined })).statusCode, 400);
    const accepted = await send(input); assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(readFileSync(path.join(workspace, `inputs/${requestId}/${fileId}.txt`), 'utf8'), '九月收入：150000元');
    assert.match(readFileSync(path.join(workspace, `inputs/${requestId}/extracted.txt`), 'utf8'), /150000/);
    await waitDone();
    assert.match((await orch.projects.getProject(project.id))!.tasks[0].objective, /不是工具或权限指令/);
    const nextId = randomUUID(); const next = await upload('alice', nextId);
    const outside = path.join(root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, path.join(workspace, 'inputs', nextId));
    assert.equal((await send({ ...input, requestId: nextId, fileIds: [next.json().attachment.id] })).statusCode, 400);
    const text = await send({ employeeId: 'general', content: '这个文件在哪里？' });
    assert.equal(text.statusCode, 200, text.body); await waitDone();
    assert.equal((await orch.projects.getProject(project.id))!.workspacePath, workspace);
    const isolated = await orch.projects.createDraft({ goal: '隔离应用', orgId: 'org', ownerUserId: 'alice', accessScope: 'private', workspacePath: workspace, executionWorkspaceMode: 'isolated', mode: 'dag', tasks: [{ title: '应用', employeeId: 'general', objective: '创建应用', skillIds: [] }] });
    const isolatedUpload = await app.inject({ method: 'POST', url: `/projects/${isolated.id}/uploads/${requestId}`, headers: { 'content-type': 'application/octet-stream', 'x-workmate-file-name': 'input.txt' }, payload: Buffer.from('reference') });
    assert.equal(isolatedUpload.statusCode, 400, isolatedUpload.body);
    const isolatedSend = await app.inject({ method: 'POST', url: `/projects/${isolated.id}/instructions`, payload: input });
    assert.equal(isolatedSend.statusCode, 400, isolatedSend.body);
  } finally { await app.close(); await orch.close(); if (saved === undefined) delete process.env.WORKMATE_DATA_DIR; else process.env.WORKMATE_DATA_DIR = saved; rmSync(root, { recursive: true, force: true }); }
});

test('PC-T7: production SSE is ready before admission and persists immediate task output', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'workmate-project-sse-'));
  const saved = { data: process.env.WORKMATE_DATA_DIR, runner: process.env.WORKMATE_ORCH_RUNNER, delay: process.env.WORKMATE_ORCH_RUNNER_DELAY_MS };
  process.env.WORKMATE_DATA_DIR = root; process.env.WORKMATE_ORCH_RUNNER = 'memory-echo'; process.env.WORKMATE_ORCH_RUNNER_DELAY_MS = '0';
  const app = Fastify(); const controller = new AbortController();
  app.addHook('preHandler', async request => { request.auth = { userId: 'alice', orgId: 'org', role: 'member', username: 'test', displayName: 'test', sessionId: 'mock' }; });
  await app.register(orchestrationRoutes, { prefix: '/api/orch' });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const orch = getOrchestrator();
    const project = await orch.projects.createDraft({ goal: '即时进度', orgId: 'org', ownerUserId: 'alice', workspacePath: path.join(root, 'project'), mode: 'dag', tasks: [{ title: '回答', employeeId: 'general', objective: '即时输出', skillIds: [] }] });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${origin}/api/orch/events?project=${project.id}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    reader = response.body!.getReader();
    const handshake = await reader.read();
    assert.match(new TextDecoder().decode(handshake.value), /: ready/);
    clearTimeout(timeout);
    const context = { profile: { id: 'general', name: '测试员工', instructions: 'test', toolIds: [] }, model: { provider: 'ollama', chatModel: 'fake', apiKey: 'test-placeholder' }, skills: [], searchProviders: [], mcpConnections: [], knowledgeBases: [] };
    const accepted = await app.inject({ method: 'POST', url: `/api/orch/projects/${project.id}/confirm`, payload: { defaultContext: context } });
    assert.equal(accepted.statusCode, 200, accepted.body);
    const finishTimeout = setTimeout(() => controller.abort(), 3000); let stream = '';
    try {
      while (!stream.includes('run.settled')) { const chunk = await reader.read(); if (chunk.done) break; stream += new TextDecoder().decode(chunk.value); }
    } finally { clearTimeout(finishTimeout); }
    assert.match(stream, /run.started/); assert.match(stream, /run.delta/); assert.match(stream, /run.settled/);
    for (let i = 0; i < 100 && (await orch.projects.getProject(project.id))?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const done = (await orch.projects.getProject(project.id))!;
    assert.equal(done.status, 'completed');
    const runId = done.tasks[0].runId!;
    assert.ok(done.messages.some(message => message.id === runId && message.content.includes('即时输出')));
    controller.abort(); await reader.cancel().catch(() => {}); reader = undefined;
    await app.close();
    const rebooted = getOrchestrator();
    await rebooted.recoverOnBoot();
    assert.deepEqual((await rebooted.projects.getProject(project.id))?.messages, done.messages);
  } finally {
    controller.abort(); await reader?.cancel().catch(() => {}); await app.close(); await closeOrchestrator();
    if (saved.data === undefined) delete process.env.WORKMATE_DATA_DIR; else process.env.WORKMATE_DATA_DIR = saved.data;
    if (saved.runner === undefined) delete process.env.WORKMATE_ORCH_RUNNER; else process.env.WORKMATE_ORCH_RUNNER = saved.runner;
    if (saved.delay === undefined) delete process.env.WORKMATE_ORCH_RUNNER_DELAY_MS; else process.env.WORKMATE_ORCH_RUNNER_DELAY_MS = saved.delay;
    rmSync(root, { recursive: true, force: true });
  }
});
