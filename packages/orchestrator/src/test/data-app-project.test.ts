import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator, type AgentRunner, type OrcEvent } from '../index.js';
import { runContext, waitFor } from './fake.js';

test('DAP-R2/R4: reserved project creation is idempotent and owner checked; isolated execution carries owner context', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-data-project-'));
  const previous = process.env.OPENCLAWX_WORKSPACES_DIR;
  process.env.OPENCLAWX_WORKSPACES_DIR = path.join(root, 'runs');
  const calls: Array<{ projectWorkspacePath?: string; runId?: string }> = [];
  const owners: Array<string | undefined> = [];
  const runner: AgentRunner = { async start(request, emit) {
    calls.push(request);
    const output = path.join(root, 'runs', request.runId!, 'output');
    fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><h1>synthetic</h1>');
    emit({ type: 'message.delta', runId: request.runId!, text: '确定性测试交付。' });
    emit({ type: 'run.completed', runId: request.runId! });
  } };
  const orch = Orchestrator.memory({ runner, contextResolver: (_task, owner) => { owners.push(owner); return runContext(); } });
  const draft = { name: '应用', goal: '制作应用', orgId: 'org', ownerUserId: 'owner', mode: 'waterfall' as const,
    workspacePath: path.join(root, 'project'), executionWorkspaceMode: 'isolated' as const,
    tasks: [{ title: '制作', objective: '合成', employeeId: 'general', skillIds: [] }] };
  try {
    const created = await Promise.all([orch.projects.createDraftOnce('stable', draft), orch.projects.createDraftOnce('stable', draft)]);
    assert.equal(created[0].id, created[1].id); assert.equal((await orch.projects.listProjects()).length, 1);
    await assert.rejects(orch.projects.createDraftOnce('stable', { ...draft, ownerUserId: 'other' }), /ownership/);
    await orch.projects.confirmProject('stable');
    await waitFor(async () => (await orch.projects.getProject('stable'))?.status === 'completed');
    assert.deepEqual(owners, ['owner']); assert.equal(calls[0].projectWorkspacePath, undefined);
    assert.ok(fs.readFileSync(path.join(root, 'project/index.html'), 'utf8').includes('synthetic'));
    const normal = await orch.projects.createDraft({ ...draft, executionWorkspaceMode: undefined });
    await orch.projects.confirmProject(normal.id);
    await waitFor(async () => (await orch.projects.getProject(normal.id))?.status === 'completed');
    assert.equal(calls[1].projectWorkspacePath, draft.workspacePath);
    // UAT-R2: a real filesystem promotion failure must never announce success first.
    const blockedPath = path.join(root, 'blocked-project'); fs.writeFileSync(blockedPath, 'not a directory');
    const broken = await orch.projects.createDraft({ ...draft, workspacePath: blockedPath });
    const events: OrcEvent[] = []; orch.subscribe(`project:${broken.id}`, event => events.push(event));
    await orch.projects.confirmProject(broken.id);
    await waitFor(async () => (await orch.projects.getProject(broken.id))?.status === 'failed');
    const terminals = events.filter(event => event.type === 'run.settled');
    assert.equal(terminals.length, 1); assert.equal(terminals[0].type === 'run.settled' && terminals[0].status, 'failed');
    const brokenTask = (await orch.projects.getProject(broken.id))!.tasks[0];
    const failedRun = await orch.engine.load(brokenTask.runId!);
    assert.equal(failedRun?.status, 'failed'); assert.match(failedRun?.error || '', /交付目录写入失败/);
  } finally { await orch.close(); if (previous === undefined) delete process.env.OPENCLAWX_WORKSPACES_DIR; else process.env.OPENCLAWX_WORKSPACES_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); }
});
