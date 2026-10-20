import assert from 'node:assert/strict';
import test from 'node:test';
import { Orchestrator, MemoryStore, createScriptedRunner, type ChatRunContext } from '@openclawx/orchestrator';
import { completionNotice, VoiceWorkBridge } from './work-bridge.js';
import { VoiceSessionCreateSchema, type VoiceWorkResult } from '@openclawx/contracts';

const context: ChatRunContext = { profile: { id: 'general', name: 'General', instructions: '', toolIds: [] }, model: { provider: 'ollama', chatModel: 'test', apiKey: 'test' }, skills: [], searchProviders: [], mcpConnections: [], knowledgeBases: [] };
const owner = { orgId: 'org-test', userId: 'user-test' };
test('VWB-R8: completion notice is concise and terminal-only', () => {
  const base = { ok: true, taskId: crypto.randomUUID(), conversationId: crypto.randomUUID(), title: '测试', artifactCount: 1, spokenSummary: '详情' };
  const notice = completionNotice({ ...base, status: 'completed' });
  assert.ok(notice?.text.includes('测试')); assert.ok((notice?.text.length || 0) <= 50);
  assert.equal(completionNotice({ ...base, status: 'completed' })?.text, notice?.text);
  assert.equal(completionNotice({ ...base, status: 'running' }), null);
  assert.equal(completionNotice({ ...base, ok: false, status: 'completed' }), null);
  const noArtifact = completionNotice({ ...base, status: 'completed', artifactCount: 0 });
  assert.equal(noArtifact?.text, '测试已完成，请查看关联对话。');
  assert.ok(!noArtifact?.text.includes('成果'));
});
async function waitStatus(bridge: VoiceWorkBridge, id: string, expected: string) {
  for (let i = 0; i < 100; i++) { const result = await bridge.status(id); if (result.status === expected) return result; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(`Did not reach ${expected}`);
}

test('VWB-R1/R2/R4: switch, idempotency, owner isolation and bounded feedback', async () => {
  const orch = new Orchestrator({ store: new MemoryStore(), runner: createScriptedRunner(), chatContextResolver: async () => context });
  let enabled = true; const bridge = new VoiceWorkBridge(orch, owner, () => enabled);
  try {
    const [a, b] = await Promise.all([bridge.call('same-call', 'start_work', { objective: '详细内容'.repeat(600) }), bridge.call('same-call', 'start_work', { objective: '重复任务' })]) as VoiceWorkResult[];
    assert.equal(a.taskId, b.taskId); assert.equal((await orch.chat.listChatSessions()).length, 1);
    const done = await waitStatus(bridge, a.taskId!, 'completed');
    assert.ok(done.spokenSummary.length <= 240); assert.equal('transcript' in done, false); assert.equal('reasoning' in done, false);
    assert.ok((await orch.chat.getRun(a.taskId!))!.transcript.length > 1000);
    const other = new VoiceWorkBridge(orch, { ...owner, userId: 'other' }, () => true);
    await assert.rejects(other.call('other-call', 'get_work_status', { taskId: a.taskId }), /无访问权限/);
    enabled = false;
    await assert.rejects(bridge.call('disabled', 'start_work', { objective: '不能启动' }), /已关闭/);
    assert.equal((await orch.chat.listChatSessions()).length, 1);
  } finally { await orch.close(); }
});

test('VWB-R3: approval continuation is tracked and jobs survive bridge replacement', async () => {
  const orch = new Orchestrator({ store: new MemoryStore(), runner: createScriptedRunner(true), chatContextResolver: async () => context });
  const session = await orch.chat.createChatSession({ orgId: owner.orgId, ownerUserId: owner.userId, employeeId: 'general', title: '审批前台对话' });
  const bridge = new VoiceWorkBridge(orch, owner, () => true, session.id);
  try {
    const accepted = await bridge.call('approval', 'start_work', { objective: '生成报告' }) as VoiceWorkResult;
    await waitStatus(bridge, accepted.taskId!, 'waiting-approval');
    const pending = await orch.chat.pendingApprovals(accepted.conversationId!);
    await orch.chat.resolveApproval({ sessionId: accepted.conversationId!, approvalId: pending[0].approvals[0].id, allow: true, scope: 'session', resumeContext: context });
    const reconnected = new VoiceWorkBridge(orch, owner, () => true);
    await waitStatus(reconnected, accepted.taskId!, 'completed');
    const binding = JSON.parse((await orch.store.get(`voice-work:${accepted.taskId}`))!);
    delete binding.turnId;
    await orch.store.set(`voice-work:${accepted.taskId}`, JSON.stringify(binding));
    assert.equal((await reconnected.status(accepted.taskId!)).status, 'completed', 'legacy binding derives the original turn');
    const result = await reconnected.call('cancel-ended', 'cancel_work', { taskId: accepted.taskId }) as VoiceWorkResult;
    assert.equal(result.status, 'completed');
  } finally { await orch.close(); }
});

test('VWB-R3: explicit cancel targets its dedicated work session', async () => {
  const orch = new Orchestrator({ store: new MemoryStore(), runner: createScriptedRunner(false, { delayMs: 200 }), chatContextResolver: async () => context });
  const bridge = new VoiceWorkBridge(orch, owner, () => true);
  try {
    const accepted = await bridge.call('start', 'start_work', { objective: '后台工作' }) as VoiceWorkResult;
    const result = await bridge.call('cancel', 'cancel_work', { taskId: accepted.taskId }) as VoiceWorkResult;
    assert.equal(result.status, 'cancellation_requested');
    await waitStatus(bridge, accepted.taskId!, 'cancelled');
  } finally { await orch.close(); }
});

test('VWB-R5/R6: current conversation, default employee, history and per-turn status', async () => {
  const runner = createScriptedRunner(false, { delayMs: 80 });
  const orch = new Orchestrator({ store: new MemoryStore(), runner, chatContextResolver: async () => context });
  try {
    const session = await orch.chat.createChatSession({ ...owner, ownerUserId: owner.userId, employeeId: 'research', title: '前台当前对话' });
    const bridge = new VoiceWorkBridge(orch, owner, () => true, session.id);
    assert.equal(VoiceSessionCreateSchema.parse({ conversationId: session.id }).conversationId, session.id);
    assert.equal(VoiceSessionCreateSchema.safeParse({ conversationId: '../bad' }).success, false);
    const bad = new VoiceWorkBridge(orch, { ...owner, userId: 'other' }, () => true, session.id);
    await assert.rejects(bad.validateConversation(), /无访问权限/);
    await assert.rejects(bad.call('bad', 'start_work', { objective: '越权' }), /无访问权限/);
    const accepted = await bridge.call('voice', 'start_work', { objective: '第一份报告' }) as VoiceWorkResult;
    assert.equal(accepted.conversationId, session.id);
    assert.equal((await orch.chat.getChatSession(session.id))!.employeeId, 'research');
    await waitStatus(bridge, accepted.taskId!, 'completed');
    const later = await orch.chat.sendUserMessage(session.id, { content: '后续文字任务' });
    assert.equal((await bridge.status(accepted.taskId!)).status, 'completed');
    const cancel = await bridge.call('old-cancel', 'cancel_work', { taskId: accepted.taskId }) as VoiceWorkResult;
    assert.equal(cancel.status, 'completed');
    assert.equal(await orch.chat.abortActiveRun(session.id, accepted.taskId), false);
    for (let i = 0; i < 100 && (await orch.chat.getRun(later.runId))?.status !== 'completed'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await orch.chat.getRun(later.runId))!.status, 'completed');
    const again = await bridge.call('voice-next', 'start_work', { objective: '第三份报告' }) as VoiceWorkResult;
    await waitStatus(bridge, again.taskId!, 'completed');
    // Model history includes attachment/delivery context alongside user text.
    assert.ok(runner.calls.at(-1)!.messages.some(x => x.role === 'user' && x.content.includes('第一份报告')));
    assert.equal((await orch.chat.listChatSessions()).length, 1);
    assert.deepEqual((await orch.chat.getChatSession(session.id))!.messages.filter(x => x.role === 'user').map(x => x.content), ['第一份报告', '后续文字任务', '第三份报告']);
  } finally { await orch.close(); }
});

test('VWB-R7: voice rejects a busy or preparing conversation without cancelling it', async () => {
  const orch = new Orchestrator({ store: new MemoryStore(), runner: createScriptedRunner(false, { delayMs: 100 }), chatContextResolver: async () => context });
  try {
    const session = await orch.chat.createChatSession({ ...owner, ownerUserId: owner.userId, employeeId: 'general' });
    const bridge = new VoiceWorkBridge(orch, owner, () => true, session.id);
    const preparing = orch.chat.sendUserMessage(session.id, { content: '文字任务' });
    await assert.rejects(bridge.call('busy', 'start_work', { objective: '不要替换' }), /已有工作/);
    const text = await preparing;
    await assert.rejects(bridge.call('busy-again', 'start_work', { objective: '不要替换' }), /已有工作/);
    for (let i = 0; i < 100 && (await orch.chat.getRun(text.runId))?.status !== 'completed'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await orch.chat.getRun(text.runId))!.status, 'completed');
    assert.equal((await orch.chat.getChatSession(session.id))!.messages.length, 2);
    const results = await Promise.allSettled([
      bridge.call('concurrent-a', 'start_work', { objective: '同时请求 A' }),
      bridge.call('concurrent-b', 'start_work', { objective: '同时请求 B' }),
    ]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  } finally { await orch.close(); }
});
