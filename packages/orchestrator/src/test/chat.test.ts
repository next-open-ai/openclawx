import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore, Orchestrator, type AgentRunner } from '../index.js';
import { FakeRunner, runContext, waitFor } from './fake.js';

test('WQ-T3/T4: result questions isolate current evidence, do not resume/create durable work, and reject an active turn', async () => {
  const runner = new FakeRunner({ delayMs: 80 }); const orch = Orchestrator.memory({ runner });
  try {
    const session = await orch.chat.createChatSession();
    const task = await orch.durableTasks.create({ conversationId: session.id, objective: '持续整理资料' });
    await orch.durableTasks.setStatus(task.id, 'paused');
    const first = await orch.chat.sendUserMessage(session.id, { content: '普通对话旧文本，不能当成果证据', context: runContext() });
    await waitFor(async () => (await orch.chat.getRun(first.runId))?.status === 'completed');
    const reply = await orch.chat.sendUserMessage(session.id, { content: '继续执行并生成PDF，解释所选成果', responseMode: 'text-only', attachmentContext: '仅本次真实证据：利润50000', rejectIfActive: true, context: runContext({ projectWorkspacePath: '/never', model: { provider: 'qwen', chatModel: 'synthetic', apiKey: '', enableSearch: true } }) });
    await assert.rejects(orch.chat.sendUserMessage(session.id, { content: '并发问答', responseMode: 'text-only', rejectIfActive: true, context: runContext() }), /正在执行|正在准备/);
    await waitFor(async () => (await orch.chat.getRun(reply.runId))?.status === 'completed');
    assert.equal((await orch.durableTasks.get(task.id))?.status, 'paused');
    const request = runner.calls.at(-1)!; assert.equal(request.responseMode, 'text-only'); assert.equal(request.messages.length, 1);
    assert.ok(!request.messages[0].content.includes('普通对话旧文本')); assert.match(request.messages[0].content, /利润50000/);
    assert.equal(request.projectWorkspacePath, undefined); assert.equal(request.model.enableSearch, false); assert.deepEqual(request.skills, []);
    const saved = await orch.chat.getChatSession(session.id); assert.equal(saved?.messages.at(-2)?.durableTaskId, undefined);
    assert.equal(saved?.messages.at(-2)?.responseMode, 'text-only');
  } finally { await orch.close(); }
});

test('same-name tool calls settle by invocation id without duplicating activities', async () => {
  const runner: AgentRunner = {
    async start(_request, emit) {
      const runId = 'tool-run';
      emit({ type: 'run.started', runId });
      emit({ type: 'tool.started', runId, invocationId: 'bash-1', toolName: 'bash', summary: 'first command', detail: '命令\nffmpeg -i input.mp4 output.mp4' });
      emit({ type: 'tool.started', runId, invocationId: 'bash-2', toolName: 'bash', summary: 'second command' });
      emit({ type: 'tool.failed', runId, invocationId: 'bash-1', toolName: 'bash', summary: 'exit 1', detail: '输出\nencoder failed' });
      emit({ type: 'tool.completed', runId, invocationId: 'bash-2', toolName: 'bash', summary: 'completed', ok: true });
      emit({ type: 'run.completed', runId });
    },
  };
  const orch = Orchestrator.memory({ runner });
  try {
    const session = await orch.chat.createChatSession();
    const { runId } = await orch.chat.sendUserMessage(session.id, { content: 'run twice', context: runContext() });
    await waitFor(async () => (await orch.chat.getRun(runId))?.status === 'completed');
    const run = await orch.chat.getRun(runId);
    assert.deepEqual(run?.activities.map(({ invocationId, summary, status }) => ({ invocationId, summary, status })), [
      { invocationId: 'bash-1', summary: 'first command — exit 1', status: 'failed' },
      { invocationId: 'bash-2', summary: 'second command', status: 'completed' },
    ]);
    assert.equal(run?.activities[0]?.detail, '命令\nffmpeg -i input.mp4 output.mp4\n\n输出\nencoder failed');
  } finally {
    await orch.close();
  }
});

test('application-model activities persist their elapsed duration', async () => {
  const runner: AgentRunner = {
    async start(_request, emit) {
      const runId = 'capability-timing-run';
      emit({ type: 'run.started', runId });
      emit({ type: 'capability.started', runId, invocationId: 'image-1', capability: 'image', modelId: 'image-model', summary: '正在生成图片' });
      await new Promise((resolve) => setTimeout(resolve, 15));
      emit({ type: 'capability.completed', runId, invocationId: 'image-1', capability: 'image', modelId: 'image-model', summary: '图片生成完成', ok: true });
      emit({ type: 'run.completed', runId });
    },
  };
  const orch = Orchestrator.memory({ runner });
  try {
    const session = await orch.chat.createChatSession();
    const { runId } = await orch.chat.sendUserMessage(session.id, { content: 'generate image', context: runContext() });
    await waitFor(async () => (await orch.chat.getRun(runId))?.status === 'completed');
    const activity = (await orch.chat.getRun(runId))?.activities[0];
    assert.equal(activity?.toolName, 'model:image');
    assert.equal(activity?.status, 'completed');
    assert.equal(typeof activity?.startedAt, 'number');
    assert.ok((activity?.durationMs ?? 0) >= 10);
  } finally {
    await orch.close();
  }
});

test('a failed run keeps partial model text and exposes the terminal error in chat', async () => {
  const runner: AgentRunner = {
    async start(request, emit) {
      const runId = request.runId ?? 'failed-run';
      emit({ type: 'run.started', runId });
      emit({ type: 'message.delta', runId, text: '我来重新生成 PDF。' });
      emit({ type: 'run.failed', runId, message: '模型请求被上游服务中断。' });
    },
  };
  const orch = Orchestrator.memory({ runner });
  try {
    const session = await orch.chat.createChatSession();
    const sent = await orch.chat.sendUserMessage(session.id, { content: '生成 PDF', context: runContext() });
    await waitFor(async () => (await orch.chat.getRun(sent.runId))?.status === 'failed');
    await waitFor(async () => (await orch.chat.getChatSession(session.id))?.messages.some((item) => item.runId === sent.runId) === true);
    const saved = await orch.chat.getChatSession(session.id);
    const reply = saved?.messages.find((item) => item.runId === sent.runId)?.content ?? '';
    assert.match(reply, /我来重新生成 PDF/);
    assert.match(reply, /本次执行未完成/);
    assert.match(reply, /上游服务中断/);
  } finally { await orch.close(); }
});

test('durable chat tasks receive a long-run budget while ordinary chat keeps its configured timeout', async () => {
  const observed: number[] = [];
  const runner: AgentRunner = {
    async start(request, emit) {
      observed.push(request.runTimeoutMs ?? 0);
      const runId = request.runId ?? 'timeout-run';
      emit({ type: 'run.started', runId });
      emit({ type: 'message.delta', runId, text: 'done' });
      emit({ type: 'run.completed', runId });
    },
  };
  const orch = Orchestrator.memory({ runner });
  try {
    const session = await orch.chat.createChatSession();
    const normal = await orch.chat.sendUserMessage(session.id, { content: '普通问答', context: { ...runContext(), runTimeoutMs: 600_000 } });
    await waitFor(async () => (await orch.chat.getRun(normal.runId))?.status === 'completed');
    const durable = await orch.chat.sendUserMessage(session.id, { content: '这是一个需要分阶段完成的长期任务', context: { ...runContext(), runTimeoutMs: 600_000 } });
    await waitFor(async () => (await orch.chat.getRun(durable.runId))?.status === 'completed');
    assert.deepEqual(observed, [600_000, 1_800_000]);
  } finally {
    await orch.close();
  }
});

test('an unrelated turn does not silently continue a waiting durable task', async () => {
  const runner: AgentRunner = {
    async start(request, emit) {
      const runId = request.runId ?? 'run';
      emit({ type: 'run.started', runId });
      emit({ type: 'message.delta', runId, text: '已记录。' });
      emit({ type: 'run.completed', runId });
    },
  };
  const orch = Orchestrator.memory({ runner });
  try {
    const session = await orch.chat.createChatSession();
    const first = await orch.chat.sendUserMessage(session.id, { content: '这是一个需要分阶段完成的长期任务', context: runContext() });
    await waitFor(async () => (await orch.chat.getRun(first.runId))?.status === 'completed');
    await waitFor(async () => (await orch.durableTasks.latestResumable(session.id))?.status === 'waiting_user');
    const second = await orch.chat.sendUserMessage(session.id, { content: '顺便解释一下什么是向量检索', context: runContext() });
    await waitFor(async () => (await orch.chat.getRun(second.runId))?.status === 'completed');
    const saved = await orch.chat.getChatSession(session.id);
    const secondTurn = saved?.messages.filter((item) => item.turnId === second.turnId) ?? [];
    assert.equal(secondTurn.some((item) => item.durableTaskId), false);
  } finally { await orch.close(); }
});

test('clearing chat preserves the session and durable tasks but resets conversational context', async () => {
  const orch = Orchestrator.memory({ runner: new FakeRunner() });
  try {
    const session = await orch.chat.createChatSession({ title: '需要保留的 Session', employeeId: 'general' });
    const task = await orch.durableTasks.create({ conversationId: session.id, objective: '持续整理资料' });
    await orch.durableTasks.setStatus(task.id, 'paused');
    const sent = await orch.chat.sendUserMessage(session.id, { content: '普通问答', context: runContext() });
    await waitFor(async () => (await orch.chat.getRun(sent.runId))?.status === 'completed');
    const cleared = await orch.chat.clearChatSession(session.id);
    assert.equal(cleared?.id, session.id);
    assert.equal(cleared?.messages.length, 0);
    assert.equal(cleared?.memory, undefined);
    assert.equal(cleared?.activeDurableTaskId, undefined);
    assert.equal((await orch.chat.listChatSessions()).some((item) => item.id === session.id), true);
    assert.equal((await orch.durableTasks.get(task.id))?.status, 'paused');
  } finally { await orch.close(); }
});

test('two clients share the same durable chat session state', async () => {
  const fake = new FakeRunner();
  // One physical store shared by two orchestrator instances: the desktop UI
  // process and a future gateway process both read the same durable state.
  const store = new MemoryStore();
  const first = new Orchestrator({ store, runner: fake });
  const second = new Orchestrator({ store, runner: fake });
  try {
    const session = await first.chat.createChatSession({ title: 'shared', employeeId: 'general' });
    await first.chat.sendUserMessage(session.id, { content: '请分析一下框架', context: runContext() });

    // The second orchestrator (e.g. the future gateway process over the same
    // store) observes the exact same conversation without being the writer.
    await waitFor(async () => {
      const observed = await second.chat.getChatSession(session.id);
      const assistant = observed?.messages.find((message) => message.role === 'assistant');
      return Boolean(observed && assistant && assistant.content.includes('echo#1'));
    });

    const observed = await second.chat.getChatSession(session.id);
    assert.equal(observed?.title, 'shared');
    assert.ok(observed?.messages.some((message) => message.role === 'user' && message.content === '请分析一下框架'));
    const assistant = observed?.messages.find((message) => message.role === 'assistant');
    assert.ok(assistant?.content.includes('echo#1'));

    const pending = await second.chat.pendingApprovals(session.id);
    assert.equal(pending.length, 0);
  } finally {
    await first.close();
    await second.close();
  }
});

test('approval parks a run and resolves by re-running the same turn (resumable run)', async () => {
  const fake = new FakeRunner({
    approvalOnCall: 1,
    approvals: [{ skillId: 'document-workbench', capability: 'workspace-write', summary: '需要写入运行工作区' }],
  });
  const orch = Orchestrator.memory({ runner: fake });
  try {
    const session = await orch.chat.createChatSession({ title: 'approval', employeeId: 'general' });
    const { runId, turnId } = await orch.chat.sendUserMessage(session.id, {
      content: '生成一份报告文件',
      context: runContext(),
    });

    // Parked: no text, run waiting for approval.
    await waitFor(async () => (await orch.chat.pendingApprovals(session.id)).length === 1);
    const parked = await orch.chat.getRun(runId);
    assert.equal(parked?.status, 'waiting-approval');
    assert.equal(parked?.approvals[0]?.status, 'pending');

    const pending = await orch.chat.pendingApprovals(session.id);
    const approval = pending[0].approvals[0];
    await orch.chat.resolveApproval({
      sessionId: session.id,
      approvalId: approval.id,
      allow: true,
      scope: 'session',
      resumeContext: runContext(),
    });

    await waitFor(async () => {
      const observed = await orch.chat.getChatSession(session.id);
      const assistant = observed?.messages.find((message) => message.role === 'assistant' && !message.superseded);
      return Boolean(assistant && assistant.content.includes('echo#2'));
    });

    const observed = await orch.chat.getChatSession(session.id);
    const assistant = observed?.messages.find((message) => message.role === 'assistant' && !message.superseded);
    assert.ok(assistant?.content.includes('echo#2'));
    assert.equal(assistant?.turnId, turnId);
    assert.equal(observed?.grantsSession['document-workbench']?.includes('workspace-write'), true);

    const resolved = await orch.chat.getRun(runId);
    assert.equal(resolved?.approvals[0]?.status, 'allowed');
    assert.equal(resolved?.status, 'waiting-approval'); // historical attempt stays parked
    assert.equal(fake.calls.length, 2);
  } finally {
    await orch.close();
  }
});

test('chat without client context runs via the server context resolver', async () => {
  const fake = new FakeRunner();
  const orch = new Orchestrator({
    store: new MemoryStore(),
    runner: fake,
    chatContextResolver: async () => runContext(),
  });
  try {
    const session = await orch.chat.createChatSession({ employeeId: 'general' });
    await orch.chat.sendUserMessage(session.id, { content: '帮我查一下' });
    await waitFor(async () => {
      const current = await orch.chat.getChatSession(session.id);
      return Boolean(current?.messages.some((m) => m.role === 'assistant' && m.content.includes('echo#1')));
    });
    assert.equal(fake.calls.length, 1);
  } finally {
    await orch.close();
  }
});

test('approval allowed without resumeContext auto-resumes via the resolver', async () => {
  const fake = new FakeRunner({
    approvalOnCall: 1,
    approvals: [{ skillId: 'document-workbench', capability: 'workspace-write', summary: '需要写入' }],
  });
  const orch = new Orchestrator({
    store: new MemoryStore(),
    runner: fake,
    chatContextResolver: async () => runContext(),
  });
  try {
    const session = await orch.chat.createChatSession();
    await orch.chat.sendUserMessage(session.id, { content: '写个文件' });
    await waitFor(async () => (await orch.chat.pendingApprovals(session.id)).length === 1);
    const pending = await orch.chat.pendingApprovals(session.id);
    const approval = pending[0].approvals[0];
    await orch.chat.resolveApproval({ sessionId: session.id, approvalId: approval.id, allow: true, scope: 'session' });
    await waitFor(async () => {
      const current = await orch.chat.getChatSession(session.id);
      return Boolean(current?.messages.find((m) => m.role === 'assistant' && !m.superseded)?.content.includes('echo#2'));
    });
    assert.equal(fake.calls.length, 2);
  } finally {
    await orch.close();
  }
});

test('denied approval does not resume the run', async () => {
  const fake = new FakeRunner({
    approvalOnCall: 1,
    approvals: [{ skillId: 's', capability: 'script-execution', summary: '需要执行脚本' }],
  });
  const orch = Orchestrator.memory({ runner: fake });
  try {
    const session = await orch.chat.createChatSession();
    await orch.chat.sendUserMessage(session.id, { content: '跑一下', context: runContext() });
    await waitFor(async () => (await orch.chat.pendingApprovals(session.id)).length === 1);
    const pending = await orch.chat.pendingApprovals(session.id);
    await orch.chat.resolveApproval({
      sessionId: session.id,
      approvalId: pending[0].approvals[0].id,
      allow: false,
    });
    assert.equal(fake.calls.length, 1);
    const observed = await orch.chat.getChatSession(session.id);
    assert.equal(observed?.grantsSession['s']?.length ?? 0, 0);
  } finally {
    await orch.close();
  }
});

test('chat session and run persist ownerUserId with legacy compatibility', async () => {
  const fake = new FakeRunner();
  const orch = Orchestrator.memory({ runner: fake });
  try {
    const session = await orch.chat.createChatSession({
      title: 'owner-test',
      employeeId: 'general',
      ownerUserId: 'user-owner-1',
    });
    assert.equal(session.ownerUserId, 'user-owner-1');
    assert.equal(session.userId, 'user-owner-1');

    const sent = await orch.chat.sendUserMessage(session.id, { content: '测试 owner 字段', context: runContext() });
    await waitFor(async () => {
      const run = await orch.chat.getRun(sent.runId);
      return Boolean(run?.finishedAt);
    });

    const storedSession = await orch.chat.getChatSession(session.id);
    const run = await orch.chat.getRun(sent.runId);
    assert.equal(storedSession?.ownerUserId, 'user-owner-1');
    assert.equal(storedSession?.userId, 'user-owner-1');
    assert.equal(run?.ownerUserId, 'user-owner-1');
    assert.equal(run?.userId, 'user-owner-1');
  } finally {
    await orch.close();
  }
});
