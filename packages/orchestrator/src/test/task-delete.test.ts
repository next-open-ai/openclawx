import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TemplateTaskService } from '../template-tasks.js';
import { MemoryStore } from '../storage/memory.js';
import { businessSummaryTemplate } from '../task-skills/business-summary/index.js';

const owner = { orgId: 'org', userId: 'alice' };
const direct = { mode: 'direct', name: '可删除任务', employeeId: 'general', prompt: '输出结果' };

test('TP-T20: direct/template deletion preserves history and rejects mutation/scheduling with owner/revision guards', async () => {
  for (const mode of ['direct', 'template']) {
    const store = new MemoryStore(); let calls = 0;
    const service = new TemplateTaskService(store, undefined, undefined, async () => { calls++; return { text: 'done' }; });
    const input = mode === 'direct' ? direct : { name: '模板任务', templateId: businessSummaryTemplate.id, templateVersion: businessSummaryTemplate.version, parameters: { period: '2026-09', rows: [{ name: '业务', revenue: 100, cost: 60 }] } };
    const task = await service.save(owner, { ...input, schedule: { kind: 'interval', everyMinutes: 10 } });
    const run = await service.run(owner, task.id, randomUUID());
    const history = structuredClone((await service.detail(owner, task.id)).runs);
    await assert.rejects(service.deleteTask({ ...owner, userId: 'other' }, task.id, task.revision), /不存在/);
    await assert.rejects(service.deleteTask(owner, task.id, task.revision + 1), error => (error as { statusCode: number }).statusCode === 409);
    assert.equal((await service.list(owner)).length, 1);
    await service.deleteTask(owner, task.id, task.revision);
    assert.equal((await service.list(owner)).length, 0);
    const deleted = await service.get(owner, task.id);
    assert.ok(deleted.deletedAt); assert.equal(deleted.scheduleState!.nextRunAt, null);
    assert.ok(deleted.schedule?.kind !== 'manual' && deleted.schedule?.enabled === false);
    await assert.rejects(service.deleteTask(owner, task.id, deleted.revision), /已删除/);
    await assert.rejects(service.save(owner, input, task.id, deleted.revision), /已删除/);
    await assert.rejects(service.updateSchedule(owner, task.id, { revision: deleted.revision, schedule: { kind: 'manual' } }), /已删除/);
    await assert.rejects(service.run(owner, task.id, randomUUID()), /已删除/);
    await service.tickScheduled(Date.now() + 86_400_000);
    const restarted = new TemplateTaskService(store);
    assert.equal((await restarted.list(owner)).length, 0);
    assert.deepEqual((await restarted.detail(owner, task.id)).runs, history);
    assert.equal((await restarted.result(owner, task.id, run.id)).id, run.result!.id);
    assert.match((await restarted.exportResult(owner, task.id, run.id, 'json')).content, /done|period/);
    assert.equal((await restarted.runs(owner))[0].run.jsonResult!.kind, 'json-result');
    assert.equal((await restarted.runs({ ...owner, userId: 'other' })).length, 0);
    assert.equal(calls, mode === 'direct' ? 1 : 0);
  }
});

test('TP-T20: run creation serializes with deletion; active run refuses deletion without blocking for completion', async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const service = new TemplateTaskService(new MemoryStore(), undefined, undefined, async () => {
    entered(); await new Promise<void>(resolve => { release = resolve; }); return { text: 'done' };
  });
  const task = await service.save(owner, direct);
  const pending = service.run(owner, task.id, randomUUID()); await started;
  try {
    await assert.rejects(service.deleteTask(owner, task.id, task.revision), /正在运行/);
    assert.equal((await service.list(owner)).length, 1);
  } finally { release(); }
  assert.equal((await pending).status, 'completed');
  await service.deleteTask(owner, task.id, task.revision);
  assert.equal((await service.runs(owner)).length, 1);
  const next = await service.save(owner, direct);
  const deletion = service.deleteTask(owner, next.id, next.revision);
  const attempt = service.run(owner, next.id, randomUUID());
  await deletion; await assert.rejects(attempt, /已删除/);
  assert.equal((await service.detail(owner, next.id)).runs.length, 0);
});
