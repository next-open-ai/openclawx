import assert from 'node:assert/strict';
import test from 'node:test';
import { Orchestrator, type AgentRunner, type OrcEvent } from '../index.js';
import { runContext } from './fake.js';

test('UAT-R1: chat and project runner receive the exact bounded engine deadline and run ID', async () => {
  for (const kind of ['chat', 'project-task'] as const) {
    for (const [requested, override, expected] of [[undefined, undefined, 1800000], [11000, undefined, 11000], [11000, 22000, 22000], [1, undefined, 5000], [9000000, undefined, 7200000]]) {
      const runner: AgentRunner = { async start(request, emit) {
        assert.equal(request.runTimeoutMs, expected); assert.equal(request.runId, 'test-run');
        emit({ type: 'run.completed', runId: request.runId! });
      } };
      const orch = Orchestrator.memory({ runner });
      try {
        const run = await orch.engine.execute({ runId: 'test-run', sessionId: 'scope', kind, request: { ...runContext(), messages: [], runTimeoutMs: requested }, timeoutMs: override });
        assert.equal(run.status, 'completed');
      } finally { await orch.close(); }
    }
  }
});

test('UAT-R2: delivery completes before a single consistent terminal event on every topic', async () => {
  for (const failure of [false, true]) {
    const runner: AgentRunner = { async start(request, emit) { emit({ type: 'run.completed', runId: request.runId! }); } };
    const orch = Orchestrator.memory({ runner });
    const events = new Map<string, OrcEvent[]>();
    for (const topic of ['run:r', 'session:p', 'project:p']) {
      events.set(topic, []); orch.subscribe(topic, event => events.get(topic)!.push(event));
    }
    let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = orch.engine.execute({ runId: 'r', sessionId: 'p', kind: 'project-task', request: { ...runContext(), messages: [] }, extraTopics: ['project:p', 'project:p'],
      finalizeCompleted: async (run, emit) => {
        entered(); await gate;
        if (failure) throw new Error('synthetic delivery failure');
        emit({ type: 'project.file.published', runId: run.id, path: 'output/index.html', projectPath: '/synthetic/project/index.html' });
      },
    });
    try {
      await ready;
      assert.equal((await orch.engine.load('r'))?.status, 'running');
      for (const list of events.values()) assert.equal(list.some(event => event.type === 'run.settled'), false);
      release(); const run = await pending;
      assert.equal(run.status, failure ? 'failed' : 'completed');
      assert.equal((await orch.engine.load('r'))?.status, run.status);
      for (const list of events.values()) {
        const terminal = list.filter(event => event.type === 'run.settled'); assert.equal(terminal.length, 1);
        assert.equal(terminal[0].type === 'run.settled' && terminal[0].status, run.status);
        if (!failure) assert.ok(list.findIndex(event => event.type === 'project.file.published') < list.findIndex(event => event.type === 'run.settled'));
      }
      if (!failure) assert.equal(run.artifacts[0].path, '/synthetic/project/index.html');
    } finally { release(); await pending; await orch.close(); }
  }
});

test('UAT-R3: error, cancellation and approval cannot finalize a false success', async () => {
  for (const kind of ['chat', 'project-task'] as const) {
    for (const scenario of ['throw', 'cancel', 'approval'] as const) {
      let finalized = 0; const controller = new AbortController();
      const runner: AgentRunner = { async start(request, emit) {
        emit({ type: 'message.delta', runId: request.runId!, text: '部分结果保留' });
        emit({ type: 'artifact.created', runId: request.runId!, path: '/synthetic/partial.txt' });
        if (scenario === 'approval') emit({ type: 'tool.approval_required', runId: request.runId!, skillId: 'skill', capability: 'workspace-write', summary: '授权写入' });
        if (scenario === 'cancel') controller.abort(new Error('synthetic cancellation'));
        emit({ type: 'run.completed', runId: request.runId! });
        if (scenario === 'throw') throw new Error('synthetic upstream failure');
      } };
      const orch = Orchestrator.memory({ runner });
      try {
        const run = await orch.engine.execute({ sessionId: 'scope', kind, request: { ...runContext(), messages: [] }, signal: controller.signal, finalizeCompleted: async () => { finalized++; } });
        assert.equal(run.status, scenario === 'throw' ? 'failed' : scenario === 'cancel' ? 'cancelled' : 'waiting-approval');
        assert.equal(finalized, 0); assert.equal(run.transcript, '部分结果保留'); assert.equal(run.artifacts.length, 1);
      } finally { await orch.close(); }
    }
  }
});

test('UAT-R3: cancelling during local finalization retains files but publishes cancelled, not completed', async () => {
  const controller = new AbortController();
  const orch = Orchestrator.memory({ runner: { async start(request, emit) { emit({ type: 'run.completed', runId: request.runId! }); } } });
  try {
    const run = await orch.engine.execute({ sessionId: 'scope', kind: 'project-task', request: { ...runContext(), messages: [] }, signal: controller.signal,
      finalizeCompleted: async (record, emit) => {
        emit({ type: 'artifact.created', runId: record.id, path: '/synthetic/retained.txt' });
        controller.abort(new Error('synthetic delivery cancellation'));
      },
    });
    assert.equal(run.status, 'cancelled'); assert.equal(run.cancelReason, 'user'); assert.equal(run.artifacts.length, 1);
  } finally { await orch.close(); }
});
