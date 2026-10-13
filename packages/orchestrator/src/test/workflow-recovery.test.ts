import assert from 'node:assert/strict';
import test from 'node:test';
import { Orchestrator } from '../index.js';
import { FakeRunner, runContext, waitFor } from './fake.js';

test('WA-R11: cancelled DAG recovery keeps completed evidence and rejects overlapping recovery', async () => {
  const fake = new FakeRunner({ delayMs: 80 });
  const orch = Orchestrator.memory({ runner: fake, contextResolver: () => runContext() });
  try {
    const project = await orch.projects.createDraft({ goal: '测试取消恢复', mode: 'dag', workspacePath: '/synthetic/workflow', tasks: [
      { id: 'a', title: '分析', employeeId: 'general', objective: '分析', skillIds: [], dependsOn: [] },
      { id: 'b', title: '报告', employeeId: 'general', objective: '报告', skillIds: [], dependsOn: ['a'] },
    ] });
    await assert.rejects(orch.projects.confirmProject(project.id, { resumeIncomplete: true }));
    await orch.projects.confirmProject(project.id);
    await waitFor(async () => (await orch.projects.getProject(project.id))?.tasks[1].status === 'running');
    const successful = (await orch.projects.getProject(project.id))!.tasks[0];
    await orch.projects.cancelActiveRun(project.id);
    await waitFor(async () => (await orch.projects.taskTranscript((await orch.projects.getProject(project.id))!.tasks[1]))?.status === 'cancelled');
    const recovered = await orch.projects.confirmProject(project.id, { resumeIncomplete: true });
    assert.ok(recovered);
    await assert.rejects(orch.projects.confirmProject(project.id, { resumeIncomplete: true }));
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    const done = (await orch.projects.getProject(project.id))!;
    assert.equal(done.tasks[0].runId, successful.runId); assert.equal(done.tasks[0].attempts, successful.attempts);
    assert.equal(fake.calls.length, 3);
    await assert.rejects(orch.projects.confirmProject(project.id, { resumeIncomplete: true }));
  } finally { await orch.close(); }
});
