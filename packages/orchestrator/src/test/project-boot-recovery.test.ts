import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStore, Orchestrator } from '../index.js';
import { FakeRunner, runContext, waitFor } from './fake.js';

test('WA-R16: boot recovery cannot interrupt live DAG context preparation or erase messages', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let preparing = false;
  const fake = new FakeRunner();
  const orch = Orchestrator.memory({ runner: fake, contextResolver: async (task) => {
    if (task.id === 'b') { preparing = true; await gate; }
    return runContext();
  } });
  try {
    const p = await orch.projects.createDraft({ goal: '恢复不能抢占正常工作流', mode: 'dag', workspacePath: '/synthetic/boot-live', tasks: [
      { id: 'a', title: '分析', objective: '分析', employeeId: 'general', skillIds: [] },
      { id: 'b', title: '交付', objective: '交付', employeeId: 'general', skillIds: [], dependsOn: ['a'] },
    ] });
    await orch.projects.confirmProject(p.id);
    await waitFor(() => preparing);
    const before = (await orch.projects.getProject(p.id))!;
    assert.equal(before.tasks[0].status, 'completed');
    assert.equal(before.tasks[1].status, 'queued');
    const results = await Promise.all([orch.recoverOnBoot(), orch.recoverOnBoot()]);
    assert.ok(results.every((r) => r.projects === 0 && r.tasks === 0));
    const after = (await orch.projects.getProject(p.id))!;
    assert.deepEqual(after.messages, before.messages);
    assert.equal(after.status, 'running');
    assert.equal(after.tasks[1].status, 'queued');
    release();
    await waitFor(async () => (await orch.projects.getProject(p.id))?.status === 'completed');
    assert.equal(fake.calls.length, 2);
  } finally { release(); await orch.close(); }
});

test('WA-R16: real orphan recovery keeps evidence, fails incomplete work, and can resume only that work', async () => {
  const store = new MemoryStore();
  const fake = new FakeRunner();
  const orch = new Orchestrator({ store, runner: fake });
  try {
    const p = await orch.projects.createDraft({ goal: '重启恢复', mode: 'dag', workspacePath: '/synthetic/boot-orphan', tasks: [
      { id: 'a', title: '分析', objective: '分析', employeeId: 'general', skillIds: [] },
      { id: 'b', title: '交付', objective: '交付', employeeId: 'general', skillIds: [], dependsOn: ['a'] },
    ] });
    await orch.projects.confirmProject(p.id, { defaultContext: runContext() });
    await waitFor(async () => (await orch.projects.getProject(p.id))?.status === 'completed');
    const done = (await orch.projects.getProject(p.id))!;
    const prior = (await orch.projects.listProjectRuns(p.id))[0];
    const run = (await orch.projects.taskTranscript(done.tasks[1]))!;
    // Persist the state that a process exit leaves behind, without a live scheduler.
    done.status = 'running'; done.activeRunId = prior.id; done.tasks[1].status = 'running';
    prior.status = 'running'; run.status = 'running';
    await store.set(`projects:${p.id}`, JSON.stringify(done));
    await store.set(`project-run:${prior.id}`, JSON.stringify(prior));
    await orch.engine.save(run);
    const rebooted = new Orchestrator({ store, runner: fake });
    const recovered = await rebooted.recoverOnBoot();
    assert.equal(recovered.tasks, 1);
    const failed = (await rebooted.projects.getProject(p.id))!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.tasks[0].runId, done.tasks[0].runId);
    assert.equal(failed.tasks[1].status, 'failed');
    assert.match(failed.tasks[1].error!, /中断/);
    assert.equal((await rebooted.projects.taskTranscript(failed.tasks[1]))?.transcript, run.transcript);
    await rebooted.projects.confirmProject(p.id, { resumeIncomplete: true, defaultContext: runContext() });
    await waitFor(async () => (await rebooted.projects.getProject(p.id))?.status === 'completed');
    assert.equal(fake.calls.length, 3);
  } finally { await orch.close(); }
});

test('WA-R16: boot recovery preserves durable approval waits and their queued dependants', async () => {
  const store = new MemoryStore();
  const orch = new Orchestrator({ store, runner: new FakeRunner() });
  const p = await orch.projects.createDraft({ goal: '审批恢复', mode: 'dag', workspacePath: '/synthetic/boot-approval', tasks: [
    { id: 'a', title: '分析', objective: '分析', employeeId: 'general', skillIds: [] },
    { id: 'b', title: '交付', objective: '交付', employeeId: 'general', skillIds: [], dependsOn: ['a'] },
  ] });
  try {
    await orch.projects.confirmProject(p.id, { defaultContext: runContext() });
    await waitFor(async () => (await orch.projects.getProject(p.id))?.status === 'completed');
    const state = (await orch.projects.getProject(p.id))!;
    const prior = (await orch.projects.listProjectRuns(p.id))[0];
    const run = (await orch.projects.taskTranscript(state.tasks[0]))!;
    state.status = 'running'; state.activeRunId = prior.id;
    state.tasks[0].status = 'running'; state.tasks[1].status = 'queued'; state.tasks[1].runId = undefined;
    run.status = 'waiting-approval';
    await store.set(`projects:${p.id}`, JSON.stringify(state));
    await orch.engine.save(run);
    const rebooted = new Orchestrator({ store, runner: new FakeRunner() });
    assert.equal((await rebooted.recoverOnBoot()).tasks, 0);
    const pending = (await rebooted.projects.getProject(p.id))!;
    assert.equal(pending.status, 'running');
    assert.equal(pending.tasks[0].status, 'running');
    assert.equal(pending.tasks[1].status, 'queued');
  } finally { await orch.close(); }
});
