import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmdirSync, readFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { Orchestrator, JsonFileStore, type AgentRunner, type ChatRunContext } from '@workmate/orchestrator';
import { workflowInvocationInputSchema, workflowInvocationResultSchema, workflowExecutionInputSchema, workflowExecutionSummarySchema, workflowInvocationSourceSchema } from '@workmate/contracts';
import { registerDefinitionRoutes } from './definition-routes.js';
import { registerWorkflowRunRoutes, WorkflowRuns } from './workflow-runs.js';
import { resolveWorkflowResultQuestion } from './workflow-result-question.js';
import { orchestrationRoutes, getOrchestrator, closeOrchestrator } from './routes.js';

const context: ChatRunContext = { profile: { id: 'general', name: 'Test', instructions: '', toolIds: [] }, model: { provider: 'ollama', chatModel: 'synthetic', apiKey: '' }, skills: [], searchProviders: [], mcpConnections: [], knowledgeBases: [] };
async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('synthetic workflow did not settle');
}
test('WQ-T2/T4: production messages route revalidates evidence, preserves strict references and ignores client evidence', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'workmate-wq-http-'));
  const saved = { data: process.env.WORKMATE_DATA_DIR, runner: process.env.WORKMATE_ORCH_RUNNER };
  process.env.WORKMATE_DATA_DIR = root; process.env.WORKMATE_ORCH_RUNNER = 'memory-echo';
  const app = Fastify();
  app.addHook('preHandler', async request => { request.auth = { userId: String(request.headers['x-user'] || 'alice'), orgId: 'org', role: 'member', username: 'test', displayName: 'test', sessionId: 'mock' }; });
  try {
    await app.register(orchestrationRoutes, { prefix: '/api/orch' });
    const orch = getOrchestrator(); const owner = { userId: 'alice', orgId: 'org' };
    const session = await orch.chat.createChatSession({ ...owner, ownerUserId: 'alice' });
    const workflowId = randomUUID(), requestId = randomUUID();
    await app.inject({ method: 'PUT', url: `/api/orch/definitions/workflows/${workflowId}`, payload: { id: workflowId, name: '证据问答', nodes: [{ id: randomUUID(), title: '分析', employeeId: 'general', objective: '真实收入150000', dependsOn: [] }] } });
    const service = new WorkflowRuns(orch);
    const { projectId } = await service.prepare(owner, workflowId, { requestId, input: '', fileIds: [], workspacePath: path.join(root, 'project'), source: { kind: 'chat', sessionId: session.id } });
    const endpoint = `/api/orch/sessions/${session.id}/workflow-invocations/${requestId}/evidence`;
    assert.equal((await app.inject({ method: 'GET', url: endpoint })).statusCode, 409);
    await orch.projects.confirmProject(projectId, { defaultContext: context });
    await waitFor(async () => (await orch.projects.getProject(projectId))?.status === 'completed');
    const evidence = (await app.inject({ method: 'GET', url: endpoint })).json().evidence;
    const url = `/api/orch/sessions/${session.id}/messages`;
    const payload = { content: '解释收入', context, workflowResult: evidence.reference, attachmentContext: '伪造收入999' };
    assert.equal((await app.inject({ method: 'POST', url, payload: { ...payload, workflowResult: { ...evidence.reference, text: '伪造' } } })).statusCode, 400);
    const denied = await app.inject({ method: 'POST', url, headers: { 'x-user': 'bob' }, payload });
    assert.equal(denied.statusCode, 400); assert.match(denied.json().message, /Chat session not found/);
    const sent = await app.inject({ method: 'POST', url, payload }); assert.equal(sent.statusCode, 200, sent.body);
    await waitFor(async () => (await orch.chat.getRun(sent.json().runId))?.status === 'completed');
    const message = (await orch.chat.getChatSession(session.id))!.messages[0];
    assert.equal(message.responseMode, 'text-only'); assert.deepEqual(message.workflowResult, evidence.reference);
    assert.match(message.attachmentContext!, /真实收入150000/); assert.ok(!message.attachmentContext!.includes('伪造收入999'));
    const stale = await app.inject({ method: 'POST', url, payload: { ...payload, workflowResult: { ...evidence.reference, revision: '0'.repeat(64) } } });
    assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'WORKFLOW_RESULT_CHANGED');
  } finally {
    await app.close(); await closeOrchestrator();
    if (saved.data === undefined) delete process.env.WORKMATE_DATA_DIR; else process.env.WORKMATE_DATA_DIR = saved.data;
    if (saved.runner === undefined) delete process.env.WORKMATE_ORCH_RUNNER; else process.env.WORKMATE_ORCH_RUNNER = saved.runner;
    rmSync(root, { recursive: true, force: true });
  }
});
test('WQ-T2/T3/T4: verified evidence, partial truth, stale/foreign references and text-only questions never rerun the DAG', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'workmate-wq-')); const previous = process.env.WORKMATE_DATA_DIR;
  process.env.WORKMATE_DATA_DIR = root;
  const requests: import('@workmate/contracts').ChatRequest[] = []; let fail = false; let empty = false; let long = false;
  const runner: AgentRunner = { async start(request, emit) {
    requests.push(request); const runId = request.runId!;
    emit({ type: 'run.started', runId });
    if (!empty) emit({ type: 'message.delta', runId, text: long ? '正文'.repeat(5000) : request.responseMode ? '仅解释：利润为五万元，未读取文件正文。' : '真实输出：收入 150000，利润 50000。' });
    if (!request.responseMode) emit({ type: 'artifact.created', runId, path: 'output/report.pdf' });
    if (fail) emit({ type: 'run.failed', runId, message: 'synthetic partial failure' });
    else emit({ type: 'run.completed', runId });
  } };
  const orch = new Orchestrator({ store: new JsonFileStore(path.join(root, 'domain.json')), runner, chatContextResolver: () => context, contextResolver: () => context });
  const app = Fastify();
  const owner = { userId: 'alice', orgId: 'org', role: 'member' as const, username: 'test', displayName: 'test', sessionId: 'synthetic' };
  app.addHook('preHandler', async request => { request.auth = { ...owner, userId: String(request.headers['x-user'] || owner.userId), orgId: String(request.headers['x-org'] || owner.orgId) }; });
  registerDefinitionRoutes(app, orch.store); registerWorkflowRunRoutes(app, orch);
  try {
    const session = await orch.chat.createChatSession({ orgId: 'org', ownerUserId: 'alice' });
    const other = await orch.chat.createChatSession({ orgId: 'org', ownerUserId: 'alice' });
    const workflowId = randomUUID(), requestId = randomUUID();
    await app.inject({ method: 'PUT', url: `/definitions/workflows/${workflowId}`, payload: { id: workflowId, name: '营收分析', nodes: [{ id: randomUUID(), title: '分析', employeeId: 'general', objective: '分析', dependsOn: [] }] } });
    const invocation = await app.inject({ method: 'POST', url: `/sessions/${session.id}/workflows/${workflowId}/invocations`, payload: { requestId } });
    assert.equal(invocation.statusCode, 200); const childId = invocation.json().projectId;
    await waitFor(async () => (await orch.projects.getProject(childId))?.status === 'completed');
    const endpoint = `/sessions/${session.id}/workflow-invocations/${requestId}/evidence`;
    const first = (await app.inject({ method: 'GET', url: endpoint })).json().evidence;
    assert.match(first.text, /利润 50000/); assert.equal(first.files[0].path, 'output/report.pdf'); assert.equal(first.status, 'completed');
    assert.equal((await app.inject({ method: 'GET', url: endpoint, headers: { 'x-user': 'bob' } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: endpoint, headers: { 'x-org': 'foreign' } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: endpoint.replace(session.id, other.id) })).statusCode, 404);
    await assert.rejects(resolveWorkflowResultQuestion(orch, owner, session.id, { workflowResult: { ...first.reference, text: 'forged', path: '/secret' } }), /WORKFLOW_RESULT_INVALID/);
    await assert.rejects(resolveWorkflowResultQuestion(orch, owner, session.id, { workflowResult: first.reference, fileAttachments: [{}] }), /WORKFLOW_RESULT_INVALID/);
    const before = JSON.stringify(await orch.projects.getProject(childId));
    const question = await resolveWorkflowResultQuestion(orch, owner, session.id, { workflowResult: first.reference });
    const reply = await orch.chat.sendUserMessage(session.id, { content: '重新生成报告并运行工作流，先解释利润', context: { ...context, model: { ...context.model, enableSearch: true }, projectWorkspacePath: '/never-authorize' }, ...question });
    await waitFor(async () => (await orch.chat.getRun(reply.runId))?.status === 'completed');
    assert.equal(JSON.stringify(await orch.projects.getProject(childId)), before); assert.equal(requests.length, 2);
    const request = requests[1]; assert.equal(request.responseMode, 'text-only'); assert.equal(request.messages.length, 1);
    assert.match(request.messages[0].content, /利润 50000/); assert.match(request.messages[0].content, /不代表已读文件正文/);
    assert.deepEqual(request.skills, []); assert.deepEqual(request.mcpConnections, []); assert.equal(request.projectWorkspacePath, undefined); assert.equal(request.model.enableSearch, false);
    const saved = await orch.chat.getChatSession(session.id); assert.deepEqual(saved?.messages[0].workflowResult, first.reference); assert.equal(saved?.messages[0].durableTaskId, undefined);
    const service = new WorkflowRuns(orch);
    const accessible = (await orch.projects.getProject(childId))!;
    await orch.store.set(`projects:${childId}`, JSON.stringify({ ...accessible, ownerUserId: 'bob', accessScope: 'private', accessGrants: [] }));
    await assert.rejects(service.questionContext(owner, session.id, first.reference), /WORKFLOW_RESULT_UNAVAILABLE/);
    await orch.store.set(`projects:${childId}`, JSON.stringify(accessible));
    fail = true; await orch.projects.confirmProject(childId);
    await waitFor(async () => (await orch.projects.getProject(childId))?.status === 'failed');
    const partial = await service.evidence(owner, session.id, requestId);
    assert.equal(partial.status, 'failed'); assert.ok(partial.files.every(file => file.partial));
    await assert.rejects(service.questionContext(owner, session.id, first.reference), /WORKFLOW_RESULT_CHANGED/);
    const failed = (await orch.projects.getProject(childId))!;
    await orch.store.set(`projects:${childId}`, JSON.stringify({ ...failed, status: 'cancelled' }));
    const cancelled = await service.evidence(owner, session.id, requestId);
    assert.equal(cancelled.status, 'cancelled'); assert.ok(cancelled.files.every(file => file.partial));
    await orch.store.set(`projects:${childId}`, JSON.stringify(failed));
    long = true; fail = false; await orch.projects.confirmProject(childId);
    await waitFor(async () => (await orch.projects.getProject(childId))?.status === 'completed');
    const bounded = await service.evidence(owner, session.id, requestId);
    assert.equal(bounded.truncated, true); assert.ok(bounded.text.length <= 24000);
    empty = true; fail = false; await orch.projects.confirmProject(childId);
    await waitFor(async () => (await orch.projects.getProject(childId))?.status === 'completed');
    await assert.rejects(service.evidence(owner, session.id, requestId), /WORKFLOW_RESULT_EMPTY/);
    await orch.projects.removeProject(childId);
    assert.equal((await app.inject({ method: 'GET', url: endpoint })).statusCode, 404);
  } finally { await app.close(); await orch.close(); if (previous === undefined) delete process.env.WORKMATE_DATA_DIR; else process.env.WORKMATE_DATA_DIR = previous; rmSync(root, { recursive: true, force: true }); }
});
test('WP-T2/T3/T5: project invocation is independent, scoped, durable and safely resumes incomplete steps', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'workmate-wp-'));
  const previous = process.env.WORKMATE_DATA_DIR; process.env.WORKMATE_DATA_DIR = root;
  const calls: string[] = []; let fail = true;
  const runner: AgentRunner = { async start(request, emit) {
    const content = String(request.messages[0].content); calls.push(content);
    assert.match(content, /extracted.txt/);
    if (content.includes('产出最终报告') && fail) {
      fail = false; emit({ type: 'artifact.created', runId: request.runId!, path: 'output/partial.md' });
      emit({ type: 'run.failed', runId: request.runId!, message: 'synthetic report failure' }); return;
    }
    emit({ type: 'message.delta', runId: request.runId!, text: '实际结果：收入 150000，利润 50000。' });
    emit({ type: 'artifact.created', runId: request.runId!, path: content.includes('产出最终报告') ? 'output/report.md' : 'output/analysis.md' });
    emit({ type: 'run.completed', runId: request.runId! });
  } };
  const make = () => new Orchestrator({ store: new JsonFileStore(path.join(root, 'domain.json')), runner, contextResolver: () => context });
  let orch = make();
  const setup = () => {
    const app = Fastify();
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    app.addHook('preHandler', async request => { request.auth = { userId: String(request.headers['x-user'] || 'alice'), orgId: String(request.headers['x-org'] || 'org'), role: 'member', username: 'test', displayName: 'test', sessionId: 'mock' }; });
    registerDefinitionRoutes(app, orch.store); registerWorkflowRunRoutes(app, orch); return app;
  };
  let app = setup();
  try {
    const parent = await orch.projects.createDraft({ name: '来源项目', goal: '原项目目标', mode: 'dag', orgId: 'org', ownerUserId: 'alice', workspacePath: path.join(root, 'original'), tasks: [{ id: randomUUID(), employeeId: 'general', title: '来源任务', objective: '绝不能被本次调用调度', skillIds: [], dependsOn: [] }] });
    const other = await orch.projects.createDraft({ name: '其他项目', goal: '隔离', mode: 'dag', orgId: 'org', ownerUserId: 'alice', workspacePath: path.join(root, 'other'), tasks: [] });
    const original = JSON.stringify(await orch.projects.getProject(parent.id));
    const workflowId = randomUUID(), requestId = randomUUID(), a = randomUUID(), b = randomUUID();
    const definition = { id: workflowId, name: '独立报告流', nodes: [{ id: a, title: '分析', employeeId: 'analyst', objective: '分析数据', dependsOn: [] }, { id: b, title: '报告', employeeId: 'writer', objective: '产出最终报告', dependsOn: [a] }] };
    await app.inject({ method: 'PUT', url: `/definitions/workflows/${workflowId}`, payload: definition });
    assert.equal(workflowInvocationSourceSchema.safeParse({ kind: 'project', projectId: parent.id }).success, true);
    assert.equal(workflowInvocationSourceSchema.safeParse({ kind: 'project', projectId: parent.id, sessionId: parent.id }).success, false);
    const upload = await app.inject({ method: 'POST', url: `/definitions/workflows/${workflowId}/uploads/${requestId}`, headers: { 'content-type': 'application/octet-stream', 'x-workmate-file-name': encodeURIComponent('九月.txt') }, payload: Buffer.from('收入 150000，利润 50000') });
    assert.equal(upload.statusCode, 200);
    const payload = { requestId, input: '分析九月', fileIds: [upload.json().attachment.id] };
    const url = `/projects/${parent.id}/workflows/${workflowId}/invocations`, history = `/projects/${parent.id}/workflow-invocations`, resume = `${history}/${requestId}/resume`;
    assert.equal((await app.inject({ method: 'POST', url, headers: { 'x-user': 'bob' }, payload })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url, headers: { 'x-org': 'other' }, payload })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: history, headers: { 'x-user': 'bob' } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url, payload: { ...payload, workspacePath: '/tmp/unsafe' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url, payload: { ...payload, source: { kind: 'project', projectId: other.id } } })).statusCode, 400);
    const responses = await Promise.all(Array.from({ length: 4 }, () => app.inject({ method: 'POST', url, payload })));
    assert.ok(responses.every(r => r.statusCode === 200), responses.map(r => r.body).join('\n'));
    const childId = responses[0].json().projectId;
    assert.ok(responses.every(r => r.json().projectId === childId)); assert.notEqual(childId, parent.id);
    await waitFor(async () => (await orch.projects.getProject(childId))?.status === 'failed');
    assert.equal(calls.length, 2); assert.equal(JSON.stringify(await orch.projects.getProject(parent.id)), original);
    const child = (await orch.projects.getProject(childId))!;
    assert.notEqual(child.workspacePath, parent.workspacePath); assert.equal(child.accessScope, 'private');
    assert.ok(child.tasks.every(task => !parent.tasks.some(p => p.id === task.id)));
    const list = (await app.inject({ method: 'GET', url: history })).json().items;
    assert.equal(list.length, 1); assert.equal(list[0].status, 'failed'); assert.equal(list[0].artifacts.find((item: { path: string }) => item.path.includes('partial')).partial, true);
    assert.match(readFileSync(path.join(child.workspacePath!, list[0].documents[0].path), 'utf8'), /150000/);
    assert.deepEqual((await app.inject({ method: 'GET', url: `/projects/${other.id}/workflow-invocations` })).json().items, []);
    assert.equal((await app.inject({ method: 'POST', url: `/projects/${other.id}/workflows/${workflowId}/invocations`, payload })).statusCode, 409);
    const chat = await orch.chat.createChatSession({ orgId: 'org', ownerUserId: 'alice', employeeId: 'general' });
    assert.equal((await app.inject({ method: 'POST', url: `/sessions/${chat.id}/workflows/${workflowId}/invocations`, payload })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: `/projects/${other.id}/workflow-invocations/${requestId}/resume` })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 200); assert.equal(calls.length, 2, 'failed replay cannot implicitly retry');
    await app.inject({ method: 'PUT', url: `/definitions/workflows/${workflowId}`, payload: { ...definition, name: '变更定义' } });
    const resumes = await Promise.all(Array.from({ length: 3 }, () => app.inject({ method: 'POST', url: resume })));
    assert.ok(resumes.every(r => r.statusCode === 200));
    await waitFor(async () => (await orch.projects.getProject(childId))?.status === 'completed');
    assert.equal(calls.length, 3, 'only failed leaf is resumed once');
    assert.equal((await orch.projects.getProject(childId))!.tasks[0].runId, child.tasks[0].runId);
    assert.equal((await app.inject({ method: 'POST', url: resume })).statusCode, 200); assert.equal(calls.length, 3);
    await orch.projects.updateAccess(parent.id, { accessScope: 'org-shared', accessGrants: [] });
    assert.deepEqual((await app.inject({ method: 'GET', url: history, headers: { 'x-user': 'bob' } })).json().items, []);
    assert.equal((await app.inject({ method: 'POST', url, headers: { 'x-user': 'bob' }, payload })).statusCode, 404);
    await orch.projects.updateAccess(parent.id, { accessScope: 'delegated', accessGrants: [{ subjectType: 'user', subjectId: 'bob', permissions: ['read'], createdAt: Date.now() }] });
    assert.equal((await app.inject({ method: 'POST', url: resume, headers: { 'x-user': 'bob' } })).statusCode, 404);
    await app.close(); await orch.close(); orch = make(); app = setup();
    const restored = (await app.inject({ method: 'GET', url: history })).json().items[0];
    assert.equal(restored.workflowName, '独立报告流'); assert.match(restored.resultText, /利润 50000/); assert.equal(restored.status, 'completed');
    assert.equal((await app.inject({ method: 'POST', url, payload })).json().projectId, childId); assert.equal(calls.length, 3);
    await orch.projects.removeProject(parent.id);
    assert.equal((await app.inject({ method: 'GET', url: history })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: resume })).statusCode, 404);
    assert.equal((await orch.projects.getProject(childId))?.status, 'completed', 'deleting origin must preserve independent execution');
  } finally { await app.close(); await orch.close(); if (previous === undefined) delete process.env.WORKMATE_DATA_DIR; else process.env.WORKMATE_DATA_DIR = previous; rmSync(root, { recursive: true, force: true }); }
});

test('WA-R9/R10/R11: HTTP preparation is scoped, idempotent and preserves evidence across DAG recovery', async () => {
  let failed = false; const calls: string[] = [];
  const runner: AgentRunner = { async start(request, emit) {
    const runId = request.runId!; const content = String(request.messages[0].content); calls.push(content);
    if (content.startsWith('分析数据')) {
      emit({ type: 'message.delta', runId, text: '上游结果：收入增长 10%' });
      emit({ type: 'artifact.created', runId, path: 'output/analysis.md' });
    } else if (!failed) {
      failed = true; emit({ type: 'artifact.created', runId, path: 'output/partial.txt' });
      emit({ type: 'run.failed', runId, message: 'synthetic document error' }); return;
    } else {
      assert.match(content, /收入增长 10%/);
      emit({ type: 'artifact.created', runId, path: 'output/report.pdf' });
    }
    emit({ type: 'run.completed', runId });
  } };
  const orch = Orchestrator.memory({ runner, contextResolver: () => context });
  const app = Fastify();
  app.addHook('preHandler', async request => { request.auth = { userId: String(request.headers['x-user'] || 'alice'), orgId: String(request.headers['x-org'] || 'org'), role: 'member', username: 'test', displayName: 'test', sessionId: 'mock' }; });
  registerDefinitionRoutes(app, orch.store); registerWorkflowRunRoutes(app, orch);
  const workflowId = randomUUID(); const first = randomUUID(); const second = randomUUID();
  const definition = { id: workflowId, name: '报告流程', description: '经营分析', nodes: [
    { id: first, title: '分析', employeeId: 'analyst', objective: '分析数据', dependsOn: [] },
    { id: second, title: '报告', employeeId: 'writer', objective: '撰写报告', dependsOn: [first] },
  ] };
  const url = `/definitions/workflows/${workflowId}/runs`;
  const workspacePath = mkdtempSync(path.join(tmpdir(), 'workmate-wa12-'));
  const input = { requestId: randomUUID(), input: '九月份', workspacePath };
  const list = async () => (await app.inject({ method: 'GET', url })).json().items;
  try {
    await app.inject({ method: 'PUT', url: `/definitions/workflows/${workflowId}`, payload: definition });
    const responses = await Promise.all(Array.from({ length: 3 }, () => app.inject({ method: 'POST', url, payload: input })));
    assert.ok(responses.every(response => response.statusCode === 200));
    const projectId = responses[0].json().projectId;
    assert.equal(workflowInvocationResultSchema.safeParse(responses[0].json()).success, true);
    assert.ok(responses.every(response => response.json().projectId === projectId));
    assert.equal((await orch.projects.listProjects()).length, 1);
    assert.equal((await list())[0].status, 'draft');
    const conflict = await app.inject({ method: 'POST', url, payload: { ...input, input: 'different' } }); assert.equal(conflict.statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url, headers: { 'x-user': 'bob' }, payload: input })).statusCode, 404);
    assert.deepEqual((await app.inject({ method: 'GET', url, headers: { 'x-org': 'other' } })).json().items, []);
    assert.deepEqual((await app.inject({ method: 'GET', url, headers: { 'x-user': 'bob' } })).json().items, []);
    definition.name = '修改后的定义'; definition.nodes[0].objective = '新的分析';
    await app.inject({ method: 'PUT', url: `/definitions/workflows/${workflowId}`, payload: definition });
    assert.equal((await list())[0].workflowName, '报告流程');
    await assert.rejects(orch.projects.confirmProject(projectId, { resumeIncomplete: true }));
    await orch.projects.confirmProject(projectId);
    await waitFor(async () => (await orch.projects.getProject(projectId))?.status === 'failed');
    const originalRun = (await orch.projects.getProject(projectId))!.tasks[0].runId;
    const failure = (await list())[0];
    assert.equal(failure.completedTasks, 1); assert.match(failure.error, /synthetic document error/);
    assert.equal(failure.artifacts.find((item: { path: string }) => item.path.includes('partial')).partial, true);
    await orch.projects.confirmProject(projectId, { resumeIncomplete: true });
    await waitFor(async () => (await orch.projects.getProject(projectId))?.status === 'completed');
    assert.equal(calls.length, 3, 'successful upstream must not re-run');
    assert.equal((await orch.projects.getProject(projectId))!.tasks[0].runId, originalRun);
    const done = (await list())[0];
    assert.equal(done.status, 'completed'); assert.equal(done.attemptCount, 2); assert.equal(done.artifacts.length, 3);
    assert.equal(done.completedTasks, 2); assert.ok(done.elapsedMs >= 0);
    await assert.rejects(orch.projects.confirmProject(projectId, { resumeIncomplete: true }));
    await orch.projects.removeProject(projectId);
    assert.equal((await list())[0].status, 'unavailable');
    assert.equal((await app.inject({ method: 'POST', url, payload: input })).statusCode, 409);
    assert.equal((await orch.projects.listProjects()).length, 0, 'deleted projects must not be resurrected by request replay');
  } finally { await app.close(); await orch.close(); rmdirSync(workspacePath); }
});

test('WA-R13/R14/R15: documents are parsed, scoped and persisted for all workflow steps without overwrites', async () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'workmate-wa13-'));
  const previousDataRoot = process.env.WORKMATE_DATA_DIR; process.env.WORKMATE_DATA_DIR = dataRoot;
  const orch = Orchestrator.memory(); const app = Fastify();
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.addHook('preHandler', async request => { request.auth = { userId: String(request.headers['x-user'] || 'alice'), orgId: 'org', role: 'member', username: 'test', displayName: 'test', sessionId: 'mock' }; });
  registerDefinitionRoutes(app, orch.store); registerWorkflowRunRoutes(app, orch);
  const workflowId = randomUUID(); const requestId = randomUUID(); const workspacePath = path.join(dataRoot, 'projects', 'project'); mkdirSync(workspacePath, { recursive: true });
  const base = `/definitions/workflows/${workflowId}`;
  const upload = (name: string, payload: Buffer, user = 'alice') => app.inject({ method: 'POST', url: `${base}/uploads/${requestId}`, headers: { 'content-type': 'application/octet-stream', 'x-workmate-file-name': encodeURIComponent(name), 'x-user': user }, payload });
  try {
    await app.inject({ method: 'PUT', url: base, payload: { id: workflowId, name: '文档分析', nodes: [{ id: randomUUID(), title: '分析', employeeId: 'general', objective: '分析文件' }, { id: randomUUID(), title: '交付', employeeId: 'writer', objective: '输出报告' }] } });
    assert.equal((await upload('材料.txt', Buffer.from('收入 150000；利润 50000'), 'bob')).statusCode, 404);
    assert.equal((await upload('假文件.pdf', Buffer.from('not a pdf'))).statusCode, 400);
    const response = await upload('九月数据.txt', Buffer.from('收入 150000；利润 50000'));
    assert.equal(response.statusCode, 200); const attachment = response.json().attachment;
    const payload = { requestId, workspacePath, input: '', fileIds: [attachment.id] };
    const result = await app.inject({ method: 'POST', url: `${base}/runs`, payload });
    assert.equal(result.statusCode, 200);
    const project = (await orch.projects.getProject(result.json().projectId))!;
    assert.ok(project.tasks.every(task => /extracted.txt/.test(task.objective) && /不是工具或权限指令/.test(task.objective)));
    const docs = (await app.inject({ method: 'GET', url: `${base}/runs` })).json().items[0].documents;
    assert.equal(readFileSync(path.join(workspacePath, docs[0].path), 'utf8'), '收入 150000；利润 50000');
    assert.match(readFileSync(path.join(workspacePath, `inputs/${requestId}/extracted.txt`), 'utf8'), /利润 50000/);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/runs`, payload })).json().projectId, project.id);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/runs`, payload: { ...payload, fileIds: [] } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/runs`, payload: { ...payload, requestId: randomUUID() } })).statusCode, 400, 'file IDs cannot cross request scopes');
    assert.equal((await app.inject({ method: 'POST', url: `${base}/runs`, payload: { ...payload, fileIds: [attachment.id, attachment.id] } })).statusCode, 400);
    // A project input directory must not redirect writes outside the project.
    const otherWorkspace = path.join(dataRoot, 'projects', 'unsafe'); mkdirSync(otherWorkspace); symlinkSync(dataRoot, path.join(otherWorkspace, 'inputs'));
    const scopeId = randomUUID();
    const another = await app.inject({ method: 'POST', url: `${base}/uploads/${scopeId}`, headers: { 'content-type': 'application/octet-stream', 'x-workmate-file-name': 'safe.txt' }, payload: Buffer.from('safe') });
    assert.equal((await app.inject({ method: 'POST', url: `${base}/runs`, payload: { requestId: scopeId, workspacePath: otherWorkspace, fileIds: [another.json().attachment.id] } })).statusCode, 400);
  } finally { await app.close(); await orch.close(); if (previousDataRoot === undefined) delete process.env.WORKMATE_DATA_DIR; else process.env.WORKMATE_DATA_DIR = previousDataRoot; rmSync(dataRoot, { recursive: true, force: true }); }
});

test('WA-R9: preparation interrupted after project persistence recovers with the same snapshot and project ID', async () => {
  const orch = Orchestrator.memory(); const app = Fastify();
  app.addHook('preHandler', async request => { request.auth = { userId: 'alice', orgId: 'org', role: 'member', username: 'test', displayName: 'test', sessionId: 'mock' }; });
  registerDefinitionRoutes(app, orch.store); registerWorkflowRunRoutes(app, orch);
  const id = randomUUID(); const url = `/definitions/workflows/${id}/runs`;
  const workspacePath = mkdtempSync(path.join(tmpdir(), 'workmate-wa12-'));
  const payload = { requestId: randomUUID(), input: '', workspacePath };
  try {
    await app.inject({ method: 'PUT', url: `/definitions/workflows/${id}`, payload: { id, name: '恢复测试', nodes: [{ id: randomUUID(), title: '任务', objective: '测试', employeeId: 'general' }] } });
    const original = orch.projects.createDraftOnce.bind(orch.projects); let interrupted = true;
    orch.projects.createDraftOnce = async (...args) => { const project = await original(...args); if (interrupted) { interrupted = false; throw new Error('synthetic interruption'); } return project; };
    assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 400);
    const before = (await orch.projects.listProjects())[0];
    const recovered = await app.inject({ method: 'POST', url, payload });
    assert.equal(recovered.statusCode, 200); assert.equal(recovered.json().projectId, before.id);
    assert.equal((await orch.projects.listProjects()).length, 1);
  } finally { await app.close(); await orch.close(); rmdirSync(workspacePath); }
});

test('WC-T2/T3/T4: chat invocation is scoped, immutable, durable and admits concurrent replays only once', async () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'workmate-wc-'));
  const previous = process.env.WORKMATE_DATA_DIR; process.env.WORKMATE_DATA_DIR = dataRoot;
  let calls = 0;
  const runner: AgentRunner = { async start(request, emit) {
    calls++;
    assert.match(String(request.messages[0].content), /extracted.txt/);
    emit({ type: 'message.delta', runId: request.runId!, text: '九月分析：收入 150000，利润 50000。' });
    emit({ type: 'artifact.created', runId: request.runId!, path: 'output/report.pdf' });
    emit({ type: 'run.completed', runId: request.runId! });
  } };
  const make = () => new Orchestrator({ store: new JsonFileStore(path.join(dataRoot, 'domain.json')), runner, contextResolver: () => context });
  let orch = make();
  const setup = () => {
    const app = Fastify();
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    app.addHook('preHandler', async request => { request.auth = { userId: String(request.headers['x-user'] || 'alice'), orgId: String(request.headers['x-org'] || 'org'), role: 'member', username: 'test', displayName: 'test', sessionId: 'mock' }; });
    registerDefinitionRoutes(app, orch.store); registerWorkflowRunRoutes(app, orch); return app;
  };
  let app = setup();
  try {
    assert.equal(workflowInvocationInputSchema.safeParse({ requestId: randomUUID(), workspacePath: '/tmp/unsafe' }).success, false);
    assert.equal(workflowExecutionInputSchema.safeParse({ requestId: randomUUID(), workspacePath: '/tmp/legacy' }).success, true);
    const session = await orch.chat.createChatSession({ orgId: 'org', ownerUserId: 'alice', title: '经营分析', employeeId: 'general' });
    const other = await orch.chat.createChatSession({ orgId: 'org', ownerUserId: 'alice', title: '另一个对话', employeeId: 'general' });
    const workflowId = randomUUID(); const requestId = randomUUID();
    const definition = { id: workflowId, name: '经营报告', nodes: [{ id: randomUUID(), title: '分析', employeeId: 'general', objective: '分析提供的材料' }] };
    await app.inject({ method: 'PUT', url: `/definitions/workflows/${workflowId}`, payload: definition });
    const upload = await app.inject({ method: 'POST', url: `/definitions/workflows/${workflowId}/uploads/${requestId}`, headers: { 'content-type': 'application/octet-stream', 'x-workmate-file-name': encodeURIComponent('九月.txt') }, payload: Buffer.from('收入 150000，利润 50000') });
    assert.equal(upload.statusCode, 200);
    const fileIds = [upload.json().attachment.id];
    const payload = { requestId, input: '分析九月', fileIds };
    const url = `/sessions/${session.id}/workflows/${workflowId}/invocations`;
    const history = `/sessions/${session.id}/workflow-invocations`;
    assert.equal((await app.inject({ method: 'POST', url, headers: { 'x-user': 'bob' }, payload })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url, headers: { 'x-org': 'other' }, payload })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: history, headers: { 'x-user': 'bob' } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url, payload: { ...payload, workspacePath: '/tmp/unsafe' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url, payload: { ...payload, source: { kind: 'chat', sessionId: other.id } } })).statusCode, 400);
    const responses = await Promise.all(Array.from({ length: 4 }, () => app.inject({ method: 'POST', url, payload })));
    assert.ok(responses.every(response => response.statusCode === 200), responses.map(response => response.body).join('\n'));
    const projectId = responses[0].json().projectId;
    assert.ok(responses.every(response => response.json().projectId === projectId));
    await waitFor(async () => (await orch.projects.getProject(projectId))?.status === 'completed');
    assert.equal(calls, 1);
    const project = (await orch.projects.getProject(projectId))!;
    assert.equal(path.dirname(project.workspacePath!), path.join(dataRoot, 'projects'));
    const list = (await app.inject({ method: 'GET', url: history })).json().items;
    assert.equal(list.length, 1); assert.equal(workflowExecutionSummarySchema.safeParse(list[0]).success, true);
    assert.match(list[0].resultText, /利润 50000/); assert.equal(list[0].artifacts[0].path, 'output/report.pdf');
    assert.match(readFileSync(path.join(project.workspacePath!, list[0].documents[0].path), 'utf8'), /150000/);
    assert.deepEqual((await app.inject({ method: 'GET', url: `/sessions/${other.id}/workflow-invocations` })).json().items, []);
    assert.equal((await app.inject({ method: 'POST', url, payload: { ...payload, input: '十月' } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: `/sessions/${other.id}/workflows/${workflowId}/invocations`, payload })).statusCode, 409);
    await app.inject({ method: 'PUT', url: `/definitions/workflows/${workflowId}`, payload: { ...definition, name: '新定义' } });
    assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 200);
    assert.equal(calls, 1, 'completed replay must never full-reschedule');
    const resume = `/sessions/${session.id}/workflow-invocations/${requestId}/resume`;
    assert.equal((await app.inject({ method: 'POST', url: resume, headers: { 'x-user': 'bob' } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `/sessions/${other.id}/workflow-invocations/${requestId}/resume` })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: resume })).statusCode, 200);
    assert.equal(calls, 1, 'stale draft card must not rerun a completed invocation');
    await app.close(); await orch.close(); orch = make(); app = setup();
    assert.equal((await app.inject({ method: 'GET', url: history })).json().items[0].workflowName, '经营报告');
    assert.equal((await app.inject({ method: 'POST', url, payload })).json().projectId, projectId);
    assert.equal(calls, 1);
    await orch.projects.removeProject(projectId);
    assert.equal((await app.inject({ method: 'GET', url: history })).json().items[0].status, 'unavailable');
    assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 409);
    assert.equal((await orch.projects.listProjects()).length, 0);
  } finally { await app.close(); await orch.close(); if (previous === undefined) delete process.env.WORKMATE_DATA_DIR; else process.env.WORKMATE_DATA_DIR = previous; rmSync(dataRoot, { recursive: true, force: true }); }
});

test('WC-T2/T4: interrupted admission, failure recovery and cancellation preserve the same invocation and evidence', async () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'workmate-wc-recovery-')); const previous = process.env.WORKMATE_DATA_DIR; process.env.WORKMATE_DATA_DIR = dataRoot;
  let calls = 0; let block = false;
  const runner: AgentRunner = { async start(request, emit, options) {
    calls++; const runId = request.runId!;
    emit({ type: 'artifact.created', runId, path: 'output/evidence.txt' });
    if (block) { const signal = options!.abortSignal!; await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); }); return; }
    if (calls === 1) { emit({ type: 'run.failed', runId, message: 'synthetic failure' }); return; }
    emit({ type: 'message.delta', runId, text: '恢复后的实际结果' }); emit({ type: 'run.completed', runId });
  } };
  const orch = Orchestrator.memory({ runner, contextResolver: () => context }); const app = Fastify();
  app.addHook('preHandler', async request => { request.auth = { userId: 'alice', orgId: 'org', role: 'member', username: 'test', displayName: 'test', sessionId: 'mock' }; });
  registerDefinitionRoutes(app, orch.store); registerWorkflowRunRoutes(app, orch);
  try {
    const session = await orch.chat.createChatSession({ orgId: 'org', ownerUserId: 'alice', employeeId: 'general' });
    const workflowId = randomUUID(); await app.inject({ method: 'PUT', url: `/definitions/workflows/${workflowId}`, payload: { id: workflowId, name: '恢复', nodes: [{ id: randomUUID(), title: '执行', employeeId: 'general', objective: '处理' }] } });
    const url = `/sessions/${session.id}/workflows/${workflowId}/invocations`; const payload = { requestId: randomUUID(), input: '' };
    const confirm = orch.projects.confirmProject.bind(orch.projects); let interrupt = true;
    orch.projects.confirmProject = async (...args) => { if (interrupt) { interrupt = false; throw new Error('synthetic admission interruption'); } return confirm(...args); };
    assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 400);
    const history = async () => (await app.inject({ method: 'GET', url: `/sessions/${session.id}/workflow-invocations` })).json().items;
    const draft = (await history())[0]; assert.equal(draft.status, 'draft');
    assert.equal((await app.inject({ method: 'POST', url, payload })).json().projectId, draft.projectId);
    await waitFor(async () => (await history())[0].status === 'failed');
    assert.equal((await history())[0].artifacts[0].partial, true);
    assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 200); assert.equal(calls, 1);
    const resume = `/sessions/${session.id}/workflow-invocations/${payload.requestId}/resume`;
    const resumed = await Promise.all(Array.from({ length: 3 }, () => app.inject({ method: 'POST', url: resume })));
    assert.ok(resumed.every(response => response.statusCode === 200));
    await waitFor(async () => (await history())[0].status === 'completed'); assert.equal(calls, 2);
    block = true;
    const next = await app.inject({ method: 'POST', url, payload: { ...payload, requestId: randomUUID() } });
    const nextId = next.json().projectId; await waitFor(async () => calls === 3);
    await orch.projects.cancelActiveRun(nextId);
    await waitFor(async () => (await orch.projects.getProject(nextId))?.status === 'cancelled');
    const cancelled = (await history()).find((item: { projectId: string }) => item.projectId === nextId);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.artifacts.length, 1);
    assert.equal((await history()).length, 2);
  } finally { await app.close(); await orch.close(); if (previous === undefined) delete process.env.WORKMATE_DATA_DIR; else process.env.WORKMATE_DATA_DIR = previous; rmSync(dataRoot, { recursive: true, force: true }); }
});
