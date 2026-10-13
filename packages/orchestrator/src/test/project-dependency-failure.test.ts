import assert from 'node:assert/strict';
import test from 'node:test';
import { Orchestrator, type AgentRunner } from '../index.js';
import { runContext, waitFor } from './fake.js';

test('WA-R20: failed dependencies block descendants with the real dependency reason, not a cycle error', async () => {
  let calls = 0;
  const runner: AgentRunner = { async start(_request, emit) {
    calls++; emit({ type: 'run.failed', runId: 'upstream', message: '工具预算已耗尽' });
  } };
  const orch = Orchestrator.memory({ runner });
  try {
    const p = await orch.projects.createDraft({ goal: '依赖失败', workspacePath: '/synthetic/dependency-failure', mode: 'dag', tasks: [
      { id: 'a', title: '分析', objective: '分析', employeeId: 'general', skillIds: [] },
      { id: 'b', title: '报告', objective: '报告', employeeId: 'general', skillIds: [], dependsOn: ['a'] },
      { id: 'c', title: '交付', objective: '交付', employeeId: 'general', skillIds: [], dependsOn: ['b'] },
    ] });
    await orch.projects.confirmProject(p.id, { defaultContext: runContext() });
    await waitFor(async () => (await orch.projects.getProject(p.id))?.status === 'failed');
    const result = (await orch.projects.getProject(p.id))!;
    assert.equal(calls, 1);
    assert.match(result.tasks[0].error!, /预算/);
    for (const task of result.tasks.slice(1)) {
      assert.equal(task.status, 'failed'); assert.match(task.error!, /前置任务失败/); assert.equal(task.runId, undefined);
    }
  } finally { await orch.close(); }
});
