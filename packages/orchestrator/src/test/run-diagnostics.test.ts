import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diagnoseModelFailure } from '@workmate/agent-core';
import { Orchestrator, type AgentRunner, type OrcEvent } from '../index.js';
import { runContext, waitFor } from './fake.js';

// Demonstrate real service entry points with a deterministic runner: no keys,
// model charges, network, or access to the user's domain store.
for (const route of ['chat', 'project'] as const) {
  for (const outcome of ['completed', 'failed', 'balance'] as const) {
    test(`RD-R4 demo: ${route} streams progress before ${outcome} and preserves Run truth`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-routes-demo-'));
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const diagnosis = diagnoseModelFailure(outcome === 'balance' ? '402 Insufficient Balance' : 'Model stream idle after 180s', { phase: 'after-tool', elapsedMs: 180000 });
      const terminal = outcome === 'completed' ? 'completed' : 'failed';
      const runner: AgentRunner = { async start(request, emit) {
        const runId = request.runId!;
        emit({ type: 'message.delta', runId, text: '正在创建合成示例应用。' });
        emit({ type: 'tool.started', runId, toolName: 'write', summary: '写入示例页面' });
        emit({ type: 'tool.completed', runId, toolName: 'write', summary: '示例步骤已完成', ok: true });
        await gate;
        if (outcome !== 'completed') emit({ type: 'run.failed', runId, ...diagnosis });
        else { emit({ type: 'message.delta', runId, text: '合成示例完成。' }); emit({ type: 'run.completed', runId }); }
      } };
      const orch = Orchestrator.memory({ runner, contextResolver: () => runContext() });
      const events: OrcEvent[] = [];
      try {
        let runId: string;
        let scopeId: string;
        if (route === 'chat') {
          const session = await orch.chat.createChatSession(); scopeId = session.id;
          orch.subscribe(`session:${scopeId}`, event => events.push(event));
          runId = (await orch.chat.sendUserMessage(scopeId, { content: '创建合成示例应用', context: runContext() })).runId;
        } else {
          const project = await orch.projects.createDraft({ name: '隔离演示', goal: '创建合成示例应用', orgId: 'demo', mode: 'waterfall', workspacePath: root, tasks: [{ title: '创建页面', objective: '合成示例', employeeId: 'general', skillIds: [] }] });
          scopeId = project.id; orch.subscribe(`project:${scopeId}`, event => events.push(event));
          await orch.projects.confirmProject(scopeId);
          await waitFor(async () => Boolean((await orch.projects.getProject(scopeId))?.tasks[0].runId));
          runId = (await orch.projects.getProject(scopeId))!.tasks[0].runId!;
        }
        await waitFor(() => events.some(event => event.type === 'run.activity' && event.activity.status === 'completed'));
        assert.equal((await orch.engine.load(runId))?.status, 'running');
        assert.equal(events.some(event => event.type === 'run.settled'), false);
        release(); await waitFor(async () => (await orch.engine.load(runId))?.status === terminal);
        await waitFor(() => events.some(event => event.type === 'run.settled'));
        const saved = (await orch.engine.load(runId))!;
        assert.match(saved.transcript, /正在创建/); assert.equal(saved.activities.length, 1);
        const settled = events.find(event => event.type === 'run.settled');
        assert.equal(settled?.type === 'run.settled' && settled.status, terminal);
        if (outcome !== 'completed') {
          assert.deepEqual(saved.failure, diagnosis.failure);
          assert.deepEqual(settled?.type === 'run.settled' && settled.failure, diagnosis.failure);
          assert.doesNotMatch(saved.error!, /检查网络|VPN/);
          if (outcome === 'balance') { assert.equal(saved.failure?.code, 'UPSTREAM_BALANCE'); assert.match(saved.error!, /余额不足/); }
        }
        if (route === 'project') {
          await waitFor(async () => (await orch.projects.getProject(scopeId))?.status === terminal);
          if (outcome === 'balance') assert.ok((await orch.projects.getProject(scopeId))?.messages.some(message => /余额不足/.test(message.content)));
        } else {
          await waitFor(async () => (await orch.chat.getChatSession(scopeId))?.messages.some(message => message.runId === runId) === true);
          const reply = (await orch.chat.getChatSession(scopeId))!.messages.find(message => message.runId === runId)!;
          assert.match(reply.content, outcome !== 'completed' ? /本次执行未完成/ : /合成示例完成/);
          if (outcome === 'balance') assert.match(reply.content, /余额不足.*充值/);
        }
      } finally { release(); await orch.close(); fs.rmSync(root, { recursive: true, force: true }); }
    });
  }
}
