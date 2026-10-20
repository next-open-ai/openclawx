import assert from 'node:assert/strict';
import test from 'node:test';
import { RunTextDeltaPositionSchema } from '@openclawx/contracts';
import { Orchestrator, type AgentRunner, type OrcEvent } from '../index.js';
import { runContext, waitFor } from './fake.js';

test('PC-T6: text offsets match durable UTF-16 transcript and reasoning positions', async () => {
  assert.ok(RunTextDeltaPositionSchema.safeParse({}).success);
  assert.ok(!RunTextDeltaPositionSchema.safeParse({ textOffset: -1 }).success);
  assert.ok(!RunTextDeltaPositionSchema.safeParse({ textOffset: 0.5 }).success);
  const runner: AgentRunner = { async start(request, emit) {
    const runId = request.runId!;
    emit({ type: 'reasoning.delta', runId, text: '思考' });
    emit({ type: 'message.delta', runId, text: '<think>继续</think>报告' });
    emit({ type: 'message.delta', runId, text: '📄已完成' });
    emit({ type: 'run.completed', runId });
  } };
  const orch = Orchestrator.memory({ runner }); const events: OrcEvent[] = [];
  try {
    const session = await orch.chat.createChatSession({ employeeId: 'general' });
    const off = orch.subscribe(`session:${session.id}`, event => events.push(event));
    const sent = await orch.chat.sendUserMessage(session.id, { content: '生成报告', context: runContext() });
    await waitFor(async () => (await orch.engine.load(sent.runId))?.status === 'completed');
    off();
    for (const type of ['run.delta', 'run.reasoning.delta'] as const) {
      let length = 0;
      for (const event of events) if (event.type === type) { assert.equal(event.textOffset, length); length += event.text.length; }
      const run = (await orch.engine.load(sent.runId))!;
      assert.equal(length, type === 'run.delta' ? run.transcript.length : run.reasoning?.length);
    }
  } finally { await orch.close(); }
});
