import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator, type AgentRunner } from '../index.js';
import type { ChatRequest } from '@workmate/contracts';
import { CreateConversationProjectSchema } from '@workmate/contracts';
import { prepareConversationWorkspace, publishConversationWorkspace } from '../project-workspace.js';
import { FakeRunner, runContext, waitFor } from './fake.js';

test('LP-T1/T2/T3: creation does not run, independent turns retain history and failure cannot overwrite deliverables', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workmate-light-project-'));
  const previous = process.env.WORKMATE_WORKSPACES_DIR;
  process.env.WORKMATE_WORKSPACES_DIR = path.join(root, 'runs');
  const workspace = path.join(root, 'project'); mkdirSync(path.join(workspace, 'inputs'), { recursive: true });
  writeFileSync(path.join(workspace, 'inputs', 'reference.txt'), '真实参考材料');
  const calls: ChatRequest[] = [];
  const runner: AgentRunner = { async start(request, emit, options) {
    calls.push(request);
    const runId = request.runId!;
    const turn = request.messages.at(-1)!.content;
    const stage = path.join(root, 'runs', runId);
    assert.equal(request.projectWorkspacePath, undefined);
    assert.equal(readFileSync(path.join(stage, 'inputs/reference.txt'), 'utf8'), '真实参考材料');
    if (turn === '修改报告') {
      assert.equal(readFileSync(path.join(stage, 'output/report.md'), 'utf8'), '第一版');
      assert.ok(request.messages.some(message => message.role === 'assistant' && message.content.includes('第一轮回答')));
    }
    writeFileSync(path.join(stage, 'output/report.md'), turn === '修改报告' ? '第二版' : '第一版');
    if (turn === '模拟失败') { writeFileSync(path.join(stage, 'output/report.md'), '失败污染'); emit({ type: 'run.failed', runId, message: '测试失败' }); return; }
    if (turn === '模拟取消') {
      writeFileSync(path.join(stage, 'output/report.md'), '取消污染');
      await new Promise<void>(resolve => options?.abortSignal?.aborted ? resolve() : options?.abortSignal?.addEventListener('abort', () => resolve(), { once: true }));
      emit({ type: 'run.cancelled', runId, reason: 'user', message: '测试取消' }); return;
    }
    emit({ type: 'message.delta', runId, text: '第一轮回答：报告已生成' });
    emit({ type: 'run.completed', runId });
  } };
  const file = path.join(root, 'domain.json');
  let orch = Orchestrator.open(file, { runner, contextResolver: () => runContext() });
  const send = async (content: string) => {
    await orch.projects.dispatchInstruction('project', { employeeId: 'general', content });
    await waitFor(async () => (await orch.projects.getProject('project'))?.status !== 'running');
  };
  try {
    assert.equal(CreateConversationProjectSchema.safeParse({ name: '  ' }).success, false);
    assert.equal(CreateConversationProjectSchema.safeParse({ name: '报告', workspacePath: '/' }).success, false);
    const created = await orch.projects.createDraftOnce('project', { kind: 'conversation', defaultEmployeeId: 'general', name: '经营报告', goal: '', mode: 'dag', workspacePath: workspace, tasks: [], ownerUserId: 'alice' });
    assert.deepEqual(created.tasks, []); assert.equal(created.plan, undefined); assert.equal(calls.length, 0);
    assert.deepEqual(await orch.projects.listProjectRuns(created.id), []);
    await assert.rejects(orch.projects.confirmProject(created.id), /发送新消息/);
    await send('制作报告'); assert.equal(calls.length, 1);
    assert.equal(readFileSync(path.join(workspace, 'report.md'), 'utf8'), '第一版');
    await send('修改报告'); assert.equal(calls.length, 2);
    assert.equal(readFileSync(path.join(workspace, 'report.md'), 'utf8'), '第二版');
    await send('模拟失败');
    assert.equal((await orch.projects.getProject('project'))?.status, 'failed');
    assert.equal(readFileSync(path.join(workspace, 'report.md'), 'utf8'), '第二版');
    await send('继续问一个问题');
    assert.equal((await orch.projects.getProject('project'))?.status, 'completed');
    assert.equal(calls.length, 4); // No replay of the earlier failed turn.
    const beforeCancel = readFileSync(path.join(workspace, 'report.md'), 'utf8');
    await orch.projects.dispatchInstruction('project', { employeeId: 'general', content: '模拟取消' });
    await waitFor(async () => calls.length === 5);
    await assert.rejects(orch.projects.dispatchInstruction('project', { employeeId: 'general', content: '不能并发' }), /already running/);
    await orch.projects.cancelActiveRun('project');
    await waitFor(async () => (await orch.engine.listRuns()).every(run => run.status !== 'running'));
    assert.equal(readFileSync(path.join(workspace, 'report.md'), 'utf8'), beforeCancel);
    const project = (await orch.projects.getProject('project'))!;
    assert.equal(project.tasks.length, 5); assert.equal(project.plan, undefined);
    assert.ok(project.tasks.every(task => !task.dependsOn.length));
    assert.ok((await orch.projects.listProjectRuns('project')).every(run => run.taskIds.length === 1 && run.planVersion === undefined));
    await orch.close(); orch = Orchestrator.open(file, { runner, contextResolver: () => runContext() });
    await orch.recoverOnBoot();
    assert.equal((await orch.projects.getProject('project'))?.kind, 'conversation');
    assert.equal(calls.length, 5);
    await send('重启后继续'); assert.equal(calls.length, 6);
    assert.equal((await orch.projects.getProject('project'))?.status, 'completed');
  } finally {
    await orch.close();
    if (previous === undefined) delete process.env.WORKMATE_WORKSPACES_DIR; else process.env.WORKMATE_WORKSPACES_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('LP-T3: unsafe or cancelled promotion preserves the existing project tree', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workmate-light-promotion-'));
  const project = path.join(root, 'project'), run = path.join(root, 'run');
  mkdirSync(project); mkdirSync(path.join(run, 'output'), { recursive: true });
  writeFileSync(path.join(project, 'report.md'), '原版'); writeFileSync(path.join(run, 'output/report.md'), '新版');
  try {
    const abort = new AbortController(); abort.abort();
    await assert.rejects(publishConversationWorkspace(run, project, abort.signal), /取消/);
    assert.equal(readFileSync(path.join(project, 'report.md'), 'utf8'), '原版');
    const revision = await prepareConversationWorkspace(project, path.join(root, 'baseline'));
    writeFileSync(path.join(project, 'report.md'), '用户手动修改');
    await assert.rejects(publishConversationWorkspace(run, project, undefined, revision), /已被修改/);
    assert.equal(readFileSync(path.join(project, 'report.md'), 'utf8'), '用户手动修改');
    writeFileSync(path.join(project, 'report.md'), '原版');
    symlinkSync(path.join(root, 'run'), path.join(project, 'outside'));
    await assert.rejects(prepareConversationWorkspace(project, path.join(root, 'staging')), /符号链接/);
    await assert.rejects(publishConversationWorkspace(run, project), /符号链接/);
    assert.equal(readFileSync(path.join(project, 'report.md'), 'utf8'), '原版');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const allow of [false, true]) test(`LP-T2: approval ${allow ? 'allow resumes' : 'deny cancels'} without closing the conversation`, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workmate-light-approval-'));
  const previous = process.env.WORKMATE_WORKSPACES_DIR; process.env.WORKMATE_WORKSPACES_DIR = path.join(root, 'runs');
  const workspace = path.join(root, 'project'); mkdirSync(workspace);
  const runner = new FakeRunner({ approvalOnCall: 1, approvals: [{ skillId: 'pdf', capability: 'workspace-write', summary: '写报告' }] });
  const orch = Orchestrator.memory({ runner, contextResolver: () => runContext() });
  try {
    const project = await orch.projects.createDraft({ kind: 'conversation', name: '审批', goal: '', mode: 'dag', tasks: [], workspacePath: workspace });
    await orch.projects.dispatchInstruction(project.id, { employeeId: 'general', content: '生成报告' });
    await waitFor(async () => (await orch.engine.listRuns()).some(run => run.status === 'waiting-approval'));
    const parked = (await orch.engine.listRuns()).find(run => run.status === 'waiting-approval')!;
    await orch.projects.resolveProjectApproval({ projectId: project.id, taskId: parked.taskId!, approvalId: parked.approvals[0].id, allow });
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === (allow ? 'completed' : 'cancelled'));
    await orch.projects.dispatchInstruction(project.id, { employeeId: 'general', content: '继续问问题' });
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    assert.equal((await orch.projects.getProject(project.id))?.tasks.length, 2);
    assert.equal((await orch.projects.getProject(project.id))?.plan, undefined);
  } finally {
    await orch.close();
    if (previous === undefined) delete process.env.WORKMATE_WORKSPACES_DIR; else process.env.WORKMATE_WORKSPACES_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
