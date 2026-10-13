import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatRequest } from '@workmate/contracts';
import { Orchestrator, type AgentRunner } from '../index.js';
import { runContext, waitFor } from './fake.js';

test('PC-T5: material → real file → follow-up → edit → failure/cancel → durable reopen', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'workmate-project-continuation-'));
  const workspace = path.join(root, 'project'); mkdirSync(path.join(workspace, 'inputs'), { recursive: true }); mkdirSync(path.join(workspace, 'output'));
  writeFileSync(path.join(workspace, 'inputs', 'revenue.txt'), '九月收入150000，成本100000，利润50000');
  const report = path.join(workspace, 'output', 'report.md');
  const calls: ChatRequest[] = []; let mode: 'normal' | 'edit' | 'fail' | 'cancel' = 'normal';
  const runner: AgentRunner = { async start(request, emit, options) {
    calls.push(request); const runId = request.runId!;
    if (mode === 'cancel') { await new Promise<void>(resolve => { if (options?.abortSignal?.aborted) resolve(); else options?.abortSignal?.addEventListener('abort', () => resolve(), { once: true }); }); emit({ type: 'run.cancelled', runId, reason: 'user', message: '用户停止' }); return; }
    if (mode === 'fail') { emit({ type: 'run.failed', runId, message: '模拟上游中断，未修改文件' }); return; }
    const objective = request.messages[0].content;
    if (objective.includes('读取收入材料')) {
      assert.match(readFileSync(path.join(request.projectWorkspacePath!, 'inputs', 'revenue.txt'), 'utf8'), /150000/);
      emit({ type: 'message.delta', runId, text: '材料确认：利润50000元。' });
    } else {
      const question = request.messages.at(-1)?.content ?? '';
      emit({ type: 'tool.started', runId, invocationId: runId + ':file', toolName: 'report', summary: '处理报告' });
      if (mode === 'edit') {
        assert.match(readFileSync(report, 'utf8'), /利润50000/);
        writeFileSync(report, '# 九月报告\n收入150000，利润50000\n补充：控制成本、跟进回款。');
      } else if (!question.includes('文件在哪里') && !existsSync(report)) writeFileSync(report, '# 九月报告\n收入150000，利润50000');
      emit({ type: 'tool.completed', runId, invocationId: runId + ':file', toolName: 'report', summary: '报告可读取', ok: true });
      emit({ type: 'artifact.created', runId, path: 'output/report.md' });
      emit({ type: 'message.delta', runId, text: `报告在 output/report.md；${readFileSync(report, 'utf8')}` });
    }
    emit({ type: 'run.completed', runId });
  } };
  const dataFile = path.join(root, 'domain.json');
  let orch = Orchestrator.open(dataFile, { runner, contextResolver: () => runContext() });
  try {
    const project = await orch.projects.createDraft({ goal: '九月经营报告', mode: 'dag', workspacePath: workspace, tasks: [
      { id: 'analyze', title: '分析', employeeId: 'analyst', objective: '读取收入材料 inputs/revenue.txt', skillIds: [] },
      { id: 'report', title: '交付', employeeId: 'writer', objective: '根据分析生成报告', skillIds: [], dependsOn: ['analyze'] },
    ] });
    let sawProgressWhileRunning = false;
    const off = orch.subscribe(`project:${project.id}`, event => { if (event.type === 'run.activity' && event.activity.status === 'running') sawProgressWhileRunning = true; });
    await orch.projects.confirmProject(project.id);
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    off(); assert.ok(sawProgressWhileRunning); assert.equal(calls.length, 2);
    const original = (await orch.projects.getProject(project.id))!; const upstreamRunId = original.tasks[0].runId;
    const originalFile = readFileSync(report, 'utf8');
    await orch.projects.dispatchInstruction(project.id, { employeeId: 'writer', content: '文件在哪里？' });
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    assert.equal(calls.length, 3); assert.equal(readFileSync(report, 'utf8'), originalFile);
    mode = 'edit'; await orch.projects.dispatchInstruction(project.id, { employeeId: 'writer', content: '读取原报告，补充建议，不重新生成分析' });
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    assert.match(readFileSync(report, 'utf8'), /控制成本/);
    const revisedFile = readFileSync(report, 'utf8');
    mode = 'fail'; await orch.projects.dispatchInstruction(project.id, { employeeId: 'writer', content: '验证失败保留成果' });
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'failed');
    assert.equal(readFileSync(report, 'utf8'), revisedFile);
    mode = 'normal'; await orch.projects.confirmProject(project.id, { resumeIncomplete: true });
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    mode = 'cancel'; await orch.projects.dispatchInstruction(project.id, { employeeId: 'writer', content: '验证停止' });
    await waitFor(async () => (await orch.projects.getProject(project.id))?.tasks[1].status === 'running');
    await orch.projects.cancelActiveRun(project.id);
    await waitFor(async () => (await orch.projects.taskTranscript((await orch.projects.getProject(project.id))!.tasks[1]))?.status === 'cancelled');
    const beforeReopen = (await orch.projects.getProject(project.id))!;
    assert.equal(readFileSync(report, 'utf8'), revisedFile);
    await orch.close();
    mode = 'normal'; orch = Orchestrator.open(dataFile, { runner, contextResolver: () => runContext() });
    await orch.recoverOnBoot();
    const reopened = (await orch.projects.getProject(project.id))!;
    assert.equal(reopened.tasks[0].runId, upstreamRunId); assert.equal(reopened.workspacePath, workspace);
    assert.deepEqual(reopened.messages, beforeReopen.messages);
    assert.equal(readFileSync(report, 'utf8'), revisedFile);
    await orch.projects.dispatchInstruction(project.id, { employeeId: 'writer', content: '重启后，文件在哪里？' });
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    const final = (await orch.projects.getProject(project.id))!;
    assert.equal(final.tasks[0].runId, upstreamRunId);
    for (const message of original.messages.filter(message => message.role === 'assistant')) assert.equal(final.messages.find(item => item.id === message.id)?.content, message.content);
    assert.ok(final.messages.some(message => /output\/report.md/.test(message.content)));
    // Explicit full scheduling remains distinct from follow-up and failure recovery.
    await orch.projects.confirmProject(project.id);
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    const restarted = (await orch.projects.getProject(project.id))!;
    assert.notEqual(restarted.tasks[0].runId, upstreamRunId);
    assert.ok(!restarted.messages.some(message => message.id === original.messages.find(item => item.role === 'assistant')?.id));
    assert.ok((await orch.projects.listProjectRuns(project.id)).some(run => run.messages?.some(message => message.id === original.messages.find(item => item.role === 'assistant')?.id)), 'full re-schedule archives rather than deletes the prior conversation');
    assert.equal(readFileSync(report, 'utf8'), revisedFile);
  } finally { await orch.close(); rmSync(root, { recursive: true, force: true }); }
});
