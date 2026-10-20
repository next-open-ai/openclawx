import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore, Orchestrator, type AgentRunner, type Project } from '../index.js';
import { FakeRunner, runContext, waitFor } from './fake.js';

async function createDraft(orch: Orchestrator, goal: string, mode: Project['mode'], tasks: Array<{ title: string; objective: string; dependsOn?: string[] }>) {
  const project = await orch.projects.createDraft({
    goal,
    mode,
    workspacePath: '/tmp/openclawx-workspace',
    coordinator: { provider: 'ollama', model: 'fake-model' },
    tasks: tasks.map((task) => ({ ...task, employeeId: 'general', skillIds: [] })),
  });
  return project;
}

test('parallel project: all tasks run and the project completes', async () => {
  const fake = new FakeRunner();
  const orch = Orchestrator.memory({ runner: fake });
  try {
    const project = await createDraft(orch, '产出一份分析报告', 'parallel', [
      { title: '调研', objective: '调研行业现状' },
      { title: '写作', objective: '撰写报告正文' },
      { title: '质检', objective: '检查报告质量' },
    ]);
    await orch.projects.confirmProject(project.id, {
      defaultContext: runContext(),
    });

    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    const done = await orch.projects.getProject(project.id);
    assert.ok(done?.tasks.every((task) => task.status === 'completed'));
    assert.ok(done?.tasks.every((task) => task.runId));
    assert.equal(fake.calls.length, 3);

    // Task transcripts are durable and carry the assistant output.
    for (const task of done?.tasks ?? []) {
      const transcript = await orch.projects.taskTranscript(task);
      assert.ok(transcript?.transcript.includes('echo#1') || transcript?.transcript.includes('echo#2') || transcript?.transcript.includes('echo#3'));
    }
    const runs = await orch.projects.listProjectRuns(project.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'completed');
  } finally {
    await orch.close();
  }
});

test('project scheduler does not mark dispatcher-waiting tasks as running', async () => {
  const fake = new FakeRunner({ delayMs: 160 });
  const orch = Orchestrator.memory({
    runner: fake,
    maxConcurrentRunsGlobal: 4,
    maxConcurrentRunsPerUser: 1,
  });
  try {
    const project = await createDraft(orch, '容量对齐', 'parallel', [
      { title: '一', objective: 'A' },
      { title: '二', objective: 'B' },
      { title: '三', objective: 'C' },
    ]);
    await orch.projects.confirmProject(project.id, { defaultContext: runContext() });
    await waitFor(async () => (await orch.projects.getProject(project.id))?.tasks.some((task) => task.status === 'running') === true);
    const active = await orch.projects.getProject(project.id);
    assert.equal(active?.tasks.filter((task) => task.status === 'running').length, 1);
    assert.equal(active?.tasks.filter((task) => task.status === 'queued').length, 2);
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed', 8_000);
  } finally {
    await orch.close();
  }
});

test('failed task remains failed even when it emitted a partial artifact', async () => {
  const runner: AgentRunner = {
    async start(_request, emit) {
      emit({ type: 'artifact.created', runId: 'partial-run', path: 'output/partial.md' });
      emit({ type: 'run.failed', runId: 'partial-run', message: 'generation stopped before acceptance' });
    },
  };
  const orch = Orchestrator.memory({ runner });
  try {
    const project = await createDraft(orch, '不能把部分文件当成功', 'parallel', [
      { title: '生成', objective: '形成完整交付物' },
    ]);
    await orch.projects.confirmProject(project.id, { defaultContext: runContext() });
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'failed');
    const failed = await orch.projects.getProject(project.id);
    assert.equal(failed?.tasks[0]?.status, 'failed');
    assert.match(failed?.tasks[0]?.error ?? '', /stopped before acceptance/);
  } finally {
    await orch.close();
  }
});

test('dag respects dependsOn ordering regardless of declaration order', async () => {
  const fake = new FakeRunner({ texts: (request) => request.messages.at(-1)?.content ?? '' });
  // Two clients share one physical store (like desktop UI + a gateway).
  const store = new MemoryStore();
  const first = new Orchestrator({ store, runner: fake });
  const second = new Orchestrator({ store, runner: fake });
  try {
    const project = await first.projects.createDraft({
      goal: '先建地基再盖楼',
      mode: 'dag',
      workspacePath: '/tmp/openclawx-workspace',
      coordinator: { provider: 'ollama', model: 'fake-model' },
      tasks: [
        { id: 'b', title: '后置', objective: 'B-盖楼', employeeId: 'general', skillIds: [], dependsOn: ['a'] },
        { id: 'a', title: '前置', objective: 'A-打地基', employeeId: 'general', skillIds: [] },
      ],
    });

    // The gateway client confirms a draft the desktop client created.
    await second.projects.confirmProject(project.id, { defaultContext: runContext() });
    await waitFor(async () => (await second.projects.getProject(project.id))?.status === 'completed');

    const done = await second.projects.getProject(project.id);
    assert.deepEqual(
      done?.tasks.map((task) => task.status),
      ['completed', 'completed'],
    );
    const order = fake.calls.map((call) => call.messages.at(-1)?.content ?? '');
    assert.equal(order[0], 'A-打地基');
    assert.match(order[1] ?? '', /^B-盖楼/);
  } finally {
    await first.close();
    await second.close();
  }
});

test('waterfall runs strictly one task after another', async () => {
  const fake = new FakeRunner();
  const orch = Orchestrator.memory({ runner: fake });
  try {
    const project = await createDraft(orch, '顺序执行', 'waterfall', [
      { title: '一', objective: '第一步' },
      { title: '二', objective: '第二步' },
      { title: '三', objective: '第三步' },
    ]);
    await orch.projects.confirmProject(project.id, { defaultContext: runContext() });
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    const done = await orch.projects.getProject(project.id);
    assert.ok(done?.tasks.every((task) => task.status === 'completed'));
    const order = fake.calls.map((call) => call.messages.at(-1)?.content ?? '');
    assert.equal(order[0], '第一步');
    assert.match(order[1] ?? '', /^第二步/);
    assert.match(order[2] ?? '', /^第三步/);
  } finally {
    await orch.close();
  }
});

test('task approval parks the task and resume finishes the project', async () => {
  const fake = new FakeRunner({
    approvalOnCall: 1,
    approvals: [{ skillId: 'document-workbench', capability: 'workspace-write', summary: '需要写入工作区' }],
  });
  const orch = Orchestrator.memory({ runner: fake });
  try {
    const project = await createDraft(orch, '需要审批的项目', 'waterfall', [
      { title: '任务A', objective: '写入文件' },
      { title: '任务B', objective: '校验结果' },
    ]);
    await orch.projects.confirmProject(project.id, { defaultContext: runContext() });

    // Task A parks waiting approval; scheduler must not mark the project done.
    await waitFor(async () => {
      const current = await orch.projects.getProject(project.id);
      return Boolean(current && current.status === 'running' && current.tasks[0].status === 'running');
    });
    const waiting = await orch.projects.getProject(project.id);
    const taskA = waiting?.tasks[0];
    assert.ok(taskA?.runId);
    const parked = await orch.projects.taskTranscript(taskA);
    assert.equal(parked?.status, 'waiting-approval');

    // Meanwhile task B may already be queued but not running (waterfall).
    await orch.projects.resolveProjectApproval({
      projectId: project.id,
      taskId: taskA!.id,
      approvalId: parked!.approvals[0].id,
      allow: true,
      scope: 'session',
      resumeContext: runContext(),
    });

    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    const done = await orch.projects.getProject(project.id);
    assert.ok(done?.tasks.every((task) => task.status === 'completed'));
    assert.equal(fake.calls.length, 3); // A (approval), A retry, B
  } finally {
    await orch.close();
  }
});

test('server-side context resolver runs tasks when confirm carries no context', async () => {
  const fake = new FakeRunner({ texts: (request) => `resolved:${request.messages.at(-1)?.content ?? ''}` });
  const orch = new Orchestrator({
    store: new MemoryStore(),
    runner: fake,
    contextResolver: async () => runContext(),
  });
  try {
    const project = await createDraft(orch, '无上下文项目', 'parallel', [
      { title: '任务1', objective: '第一步' },
      { title: '任务2', objective: '第二步' },
    ]);
    // Remote gateway confirms WITHOUT any runContextByTask/defaultContext —
    // the orchestrator's fallback resolver supplies each task's context.
    await orch.projects.confirmProject(project.id, {});
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    const done = await orch.projects.getProject(project.id);
    assert.ok(done?.tasks.every((task) => task.status === 'completed'));
    const contents = fake.calls.map((call) => call.messages.at(-1)?.content ?? '');
    assert.deepEqual(contents, ['第一步', '第二步']);
  } finally {
    await orch.close();
  }
});

test('cancel aborts queued work and finishes as cancelled', async () => {
  const fake = new FakeRunner({ texts: () => 'slow', delayMs: 300 });
  const orch = Orchestrator.memory({ runner: fake });
  try {
    const project = await createDraft(orch, '取消测试', 'parallel', [
      { title: '任务1', objective: '长任务一' },
      { title: '任务2', objective: '长任务二' },
    ]);
    await orch.projects.confirmProject(project.id, { defaultContext: runContext() });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await orch.projects.cancelActiveRun(project.id);
    await waitFor(async () => {
      const current = await orch.projects.getProject(project.id);
      return Boolean(current && current.status === 'cancelled' && current.tasks.every((task) => task.status === 'cancelled' || task.status === 'failed'));
    }, 8_000);
    const done = await orch.projects.getProject(project.id);
    assert.equal(done?.status, 'cancelled');
  } finally {
    await orch.close();
  }
});

test('createDraft materializes waterfall edges and stores Plan v1', async () => {
  const orch = Orchestrator.memory({ runner: new FakeRunner() });
  try {
    const project = await createDraft(orch, '计划版本', 'waterfall', [
      { title: '一', objective: 'A' },
      { title: '二', objective: 'B' },
    ]);
    assert.equal(project.plan?.version, 1);
    assert.equal(project.tasks[1].dependsOn[0], project.tasks[0].id);
  } finally {
    await orch.close();
  }
});

test('dispatchInstruction invalidates target+downstream as ChangeSet without wiping upstream', async () => {
  const fake = new FakeRunner();
  const orch = Orchestrator.memory({ runner: fake });
  try {
    const project = await orch.projects.createDraft({
      goal: '增量指令',
      mode: 'dag',
      workspacePath: '/tmp/openclawx-workspace',
      coordinator: { provider: 'ollama', model: 'fake-model' },
      tasks: [
        { id: 'a', title: '上游', objective: 'A', employeeId: 'research', skillIds: [] },
        { id: 'b', title: '中游', objective: 'B', employeeId: 'general', skillIds: [], dependsOn: ['a'] },
        { id: 'c', title: '下游', objective: 'C', employeeId: 'code', skillIds: [], dependsOn: ['b'] },
      ],
    });
    await orch.projects.confirmProject(project.id, { defaultContext: runContext() });
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');

    const before = await orch.projects.getProject(project.id);
    assert.ok(before?.tasks.every((task) => task.status === 'completed'));
    const callsBefore = fake.calls.length;
    const upstreamRunId = before?.tasks.find(task => task.id === 'a')?.runId;
    const previousReply = (await orch.engine.load(before!.tasks.find(task => task.id === 'b')!.runId!))!.transcript;
    const previousMessageIds = before!.messages.map(message => message.id);
    const originalReplies = before!.messages.filter(message => message.role === 'assistant');
    assert.equal(originalReplies.length, 3, 'PC-T2: each settled task reply is durable');

    await orch.projects.dispatchInstruction(
      project.id,
      { employeeId: 'general', content: '补充修订中游', employeeLabel: '通用助理' },
      { defaultContext: runContext() },
    );
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');

    const after = await orch.projects.getProject(project.id);
    assert.equal(after?.plan?.version, 1);
    assert.ok((after?.changeSets?.length ?? 0) >= 1);
    assert.equal(after?.changeSets?.at(-1)?.kind, 'instruction');
    const upstream = after?.tasks.find((task) => task.id === 'a');
    assert.equal(upstream?.status, 'completed');
    assert.equal(upstream?.runId, upstreamRunId, 'PC-T2: completed upstream is not restarted');
    assert.ok(previousMessageIds.every(id => after?.messages.some(message => message.id === id)), 'PC-T2: project conversation stays visible');
    const nextRequest = fake.calls.slice(callsBefore).find(call => call.messages.at(-1)?.content.includes('补充修订中游'));
    assert.equal(nextRequest?.projectWorkspacePath, project.workspacePath);
    assert.ok(nextRequest?.messages.some(message => message.role === 'assistant' && message.content === previousReply.slice(-6000)));
    assert.ok(fake.calls.length > callsBefore);
    // Mid + downstream re-executed; upstream kept.
    assert.equal(fake.calls.length - callsBefore, 2);
    const secondPreviousRun = after!.tasks.find(task => task.id === 'c')!.runId!;
    const secondReply = (await orch.engine.load(secondPreviousRun))!.transcript;
    const secondCallsBefore = fake.calls.length;
    await orch.projects.dispatchInstruction(project.id, { employeeId: 'code', content: '只解释当前交付文件的位置' }, { defaultContext: runContext() });
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    assert.equal(fake.calls.length - secondCallsBefore, 1, 'PC-T2: repeated follow-up to a leaf runs only that leaf');
    assert.equal((await orch.projects.getProject(project.id))?.tasks.find(task => task.id === 'a')?.runId, upstreamRunId);
    assert.ok(fake.calls.at(-1)?.messages.some(message => message.role === 'assistant' && message.content === secondReply.slice(-6000)));
    const final = (await orch.projects.getProject(project.id))!;
    for (const reply of originalReplies) {
      assert.equal(final.messages.find(message => message.id === reply.id)?.content, reply.content, 'PC-T2: follow-up never replaces an old task reply');
    }
    assert.equal(final.messages.filter(message => message.id === secondPreviousRun).length, 1);
    assert.equal(final.messages.find(message => message.id === secondPreviousRun)?.content, secondReply);
  } finally {
    await orch.close();
  }
});

test('inferCollaborationMode classifies common graphs', async () => {
  const { inferCollaborationMode, analyzeModeFit, buildAttemptKey } = await import('../project-plan.js');
  assert.equal(inferCollaborationMode([{ dependsOn: [] }, { dependsOn: [] }]), 'parallel');
  assert.equal(
    inferCollaborationMode([{ dependsOn: [] }, { dependsOn: [0] }, { dependsOn: [1] }]),
    'waterfall',
  );
  assert.equal(
    inferCollaborationMode([{ dependsOn: [] }, { dependsOn: [] }, { dependsOn: [0, 1] }]),
    'discussion',
  );
  assert.equal(
    inferCollaborationMode([{ dependsOn: [] }, { dependsOn: [] }, { dependsOn: [0] }, { dependsOn: [1, 2] }]),
    'dag',
  );
  const fit = analyzeModeFit('parallel', [{ dependsOn: [] }, { dependsOn: [0] }]);
  assert.equal(fit.modeFitsPreferred, false);
  assert.equal(fit.suggestedMode, 'waterfall');
  const emptyDag = analyzeModeFit('dag', [{ dependsOn: [] }, { dependsOn: [] }]);
  assert.equal(emptyDag.modeFitsPreferred, false);
  assert.equal(emptyDag.suggestedMode, 'parallel');
  assert.equal(buildAttemptKey('t1', 2, 3), 't1:plan2:attempt3');
});

test('replan bumps Plan version and can keep completed nodes', async () => {
  const fake = new FakeRunner();
  const orch = Orchestrator.memory({ runner: fake });
  try {
    const project = await orch.projects.createDraft({
      goal: '成员变更',
      mode: 'parallel',
      workspacePath: '/tmp/openclawx-workspace',
      coordinator: { provider: 'ollama', model: 'fake-model' },
      tasks: [
        { id: 't1', title: '调研', objective: '调研', employeeId: 'research', skillIds: [] },
        { id: 't2', title: '写作', objective: '写作', employeeId: 'general', skillIds: [] },
      ],
    });
    await orch.projects.confirmProject(project.id, { defaultContext: runContext() });
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');

    await orch.projects.replanProject(project.id, {
      note: '加入编程助理',
      tasks: [
        { id: 't1', title: '调研', objective: '调研', employeeId: 'research', skillIds: [] },
        { id: 't2', title: '写作', objective: '写作', employeeId: 'general', skillIds: [] },
        { id: 't3', title: '实现', objective: '实现', employeeId: 'code', skillIds: [] },
      ],
    });
    const replanned = await orch.projects.getProject(project.id);
    assert.equal(replanned?.plan?.version, 2);
    assert.equal(replanned?.tasks.find((task) => task.id === 't1')?.status, 'completed');
    assert.equal(replanned?.tasks.find((task) => task.id === 't3')?.status, 'draft');

    await orch.projects.confirmProject(project.id, { defaultContext: runContext() });
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    const done = await orch.projects.getProject(project.id);
    assert.equal(done?.tasks.find((task) => task.id === 't3')?.status, 'completed');
  } finally {
    await orch.close();
  }
});

test('project and project runs persist ownerUserId with legacy compatibility', async () => {
  const fake = new FakeRunner();
  const orch = Orchestrator.memory({ runner: fake });
  try {
    const project = await orch.projects.createDraft({
      goal: 'owner project',
      mode: 'parallel',
      workspacePath: '/tmp/openclawx-workspace',
      ownerUserId: 'user-owner-2',
      coordinator: { provider: 'ollama', model: 'fake-model' },
      tasks: [{ title: '任务1', objective: '检查 owner 字段', employeeId: 'general', skillIds: [] }],
    });
    assert.equal(project.ownerUserId, 'user-owner-2');
    assert.equal(project.userId, 'user-owner-2');

    await orch.projects.confirmProject(project.id, { defaultContext: runContext() });
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');

    const storedProject = await orch.projects.getProject(project.id);
    const runs = await orch.projects.listProjectRuns(project.id);
    const taskRun = storedProject?.tasks[0]?.runId ? await orch.chat.getRun(storedProject.tasks[0].runId!) : null;

    assert.equal(storedProject?.ownerUserId, 'user-owner-2');
    assert.equal(storedProject?.userId, 'user-owner-2');
    assert.equal(runs[0]?.ownerUserId, 'user-owner-2');
    assert.equal(runs[0]?.userId, 'user-owner-2');
    assert.equal(taskRun?.ownerUserId, 'user-owner-2');
    assert.equal(taskRun?.userId, 'user-owner-2');
  } finally {
    await orch.close();
  }
});
