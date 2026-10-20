import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TemplateTaskService } from '../template-tasks.js';
import { MemoryStore } from '../storage/memory.js';
import { JsonFileStore } from '../storage/json-file.js';
import { businessSummarySkill, businessSummaryTemplate } from '../task-skills/business-summary/index.js';
import {TaskRunJsonResultSchema} from '@openclawx/contracts';

test('TP-T9: direct task runs with employee/prompt/output snapshot, no template, stable JSON and idempotency',async()=>{
  const store=new MemoryStore();let calls=0;
  const service=new TemplateTaskService(store,undefined,undefined,async(_owner,template,params,prompt,link)=>{
    calls++;assert.equal(template.agent?.employeeId,'research');assert.deepEqual(params,{});assert.match(prompt,/关键指标/);await link('session','agent-run');return {text:'分析完成',metrics:{total:7}};
  });
  const input={mode:'direct',name:'直接分析',employeeId:'research',prompt:'分析业务',resultOutput:{destination:'task-results',instructions:'输出关键指标'}};
  const task=await service.save(owner,input);assert.equal(task.mode,'direct');assert.equal((await service.definitions(owner)).length,0);
  const [first,retry]=await Promise.all([service.run(owner,task.id,'direct-run'),service.run(owner,task.id,'direct-run')]);
  assert.equal(calls,1);assert.equal(first.result?.id,retry.result?.id);
  const json=TaskRunJsonResultSchema.parse(first.jsonResult);assert.equal(json.kind,'json-result');assert.equal(json.status,'completed');assert.deepEqual(json.data?.metrics,{total:7});assert.equal(json.input.employeeId,'research');assert.equal(json.input.prompt,'分析业务');
  await service.save(owner,{...input,prompt:'新一轮提示词'},task.id,1);
  const reopened=new TemplateTaskService(store);assert.equal((await reopened.detail(owner,task.id)).runs[0].jsonResult?.input.prompt,'分析业务');
  assert.equal((await reopened.runs(owner))[0].mode,'direct');assert.deepEqual(await reopened.runs({...owner,userId:'stranger'}),[]);
  await assert.rejects(service.save(owner,{...input,employeeId:''}));await assert.rejects(service.save(owner,{...input,prompt:''}));
  await assert.rejects(service.save(owner,{...input,resultOutput:{destination:'/tmp/arbitrary'}}));
  await assert.rejects(service.save(owner,{name:'switch',templateId:'business-summary',templateVersion:'1.0.0',parameters:{period:'2026-09',rows:[{name:'A',revenue:1,cost:0}]}},task.id,2),/创建方式/);
});
test('TP-T9: failed, restarted and legacy runs expose structured JSON without inventing successful output',async()=>{
  const store=new MemoryStore();const service=new TemplateTaskService(store,undefined,undefined,async()=>{throw Error('余额不足');});
  const task=await service.save(owner,{mode:'direct',name:'失败任务',employeeId:'general',prompt:'执行'});
  const run=await service.run(owner,task.id,'failure');assert.equal(run.jsonResult?.data,null);assert.equal(run.jsonResult?.error,'余额不足');assert.equal(run.jsonResult?.status,'failed');
  const key=(await store.keys('template-runs:'))[0];
  const old={...run,jsonResult:undefined,status:'running',finishedAt:undefined};await store.set(key,JSON.stringify(old));
  await service.recoverInterrupted();const recovered=(await service.detail(owner,task.id)).runs[0];assert.equal(recovered.jsonResult?.status,'failed');assert.match(recovered.jsonResult!.error!,/服务重启/);
  await store.set(key,JSON.stringify({...run,jsonResult:undefined,executionSnapshot:undefined}));
  const before=await store.get(key);assert.equal((await service.runs(owner))[0].run.jsonResult?.kind,'json-result');assert.equal(await store.get(key),before,'legacy projection does not mutate persisted history');
});

const owner = { orgId: 'org1', userId: 'user1' };
const input = () => ({ name: '月度试验', templateId: 'business-summary', templateVersion: '1.0.0', parameters: {
  period: '2026-08', rows: [{ name: '华东', revenue: 120000, cost: 80000 }, { name: '华南', revenue: 90000, cost: 65000 }],
} });

test('create, execute, query, edit and reopen durable results with immutable input snapshots', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openclawx-template-test-'));
  let store = new JsonFileStore(path.join(dir, 'domain.json'));
  try {
    let service = new TemplateTaskService(store);
    const task = await service.save(owner, input());
    const run = await service.run(owner, task.id, 'first');
    assert.equal(run.status, 'completed'); assert.equal(run.steps.length, 3);
    assert.equal(run.result?.data.revenue, 210000); assert.equal(run.result?.data.profit, 65000);
    const updated = input(); updated.parameters.rows[0].revenue = 150000;
    await service.save(owner, updated, task.id, 1);
    const second = await service.run(owner, task.id, 'second');
    assert.equal(second.result?.data.revenue, 240000);
    await store.close(); store = new JsonFileStore(path.join(dir, 'domain.json')); service = new TemplateTaskService(store);
    const history = await service.detail(owner, task.id);
    assert.equal(history.runs.length, 2); assert.equal(history.task.revision, 2);
    assert.equal((await service.result(owner, task.id, 'first')).data.revenue, 210000);
    assert.equal((history.runs.find(item => item.id === 'first')!.inputSnapshot.rows as Array<{ revenue: number }>)[0].revenue, 120000);
    assert.match(service.render(run.result!).html!, /210,000.00/);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('owner isolation applies to task lists, edits, execution and result queries', async () => {
  const service = new TemplateTaskService(new MemoryStore());
  const task = await service.save(owner, input()); await service.run(owner, task.id, 'r1');
  for (const stranger of [{ ...owner, userId: 'other' }, { ...owner, orgId: 'other' }]) {
    assert.deepEqual(await service.list(stranger), []);
    await assert.rejects(service.detail(stranger, task.id), /任务不存在/);
    await assert.rejects(service.save(stranger, input(), task.id, 1), /任务不存在/);
    await assert.rejects(service.run(stranger, task.id, 'r2'), /任务不存在/);
    await assert.rejects(service.result(stranger, task.id, 'r1'), /任务不存在/);
  }
});

test('invalid inputs and stale revisions cannot overwrite saved parameters', async () => {
  const service = new TemplateTaskService(new MemoryStore());
  await assert.rejects(service.save(owner, { ...input(), parameters: { period: '2026-13', rows: [] } }));
  const invalid = input(); invalid.parameters.rows[0].cost = -1;
  await assert.rejects(service.save(owner, invalid));
  invalid.parameters.rows[0].cost = 0.001; await assert.rejects(service.save(owner, invalid));
  await assert.rejects(service.save(owner, { ...input(), templateVersion: 'future' }), /版本不可用/);
  const task = await service.save(owner, input()); await service.save(owner, input(), task.id, 1);
  await assert.rejects(service.save(owner, input(), task.id, 1), /已更新/);
  assert.equal((await service.get(owner, task.id)).revision, 2);
});

test('request retries return one run and execute the Skill once', async () => {
  let executions = 0;
  const skill = { ...businessSummarySkill, execute: (value: unknown) => { executions++; return businessSummarySkill.execute(value); } };
  const service = new TemplateTaskService(new MemoryStore(), [skill]); const task = await service.save(owner, input());
  const [a, b] = await Promise.all([service.run(owner, task.id, 'same'), service.run(owner, task.id, 'same')]);
  assert.equal(a.result?.id, b.result?.id); assert.equal(executions, 1); assert.equal((await service.detail(owner, task.id)).runs.length, 1);
});

test('calculation uses cents, zero revenue has no margin, HTML escapes business labels', async () => {
  const service = new TemplateTaskService(new MemoryStore());
  const task = await service.save(owner, { ...input(), parameters: { period: '2026-08', rows: [
    { name: '<script>alert(1)</script>', revenue: 0.3, cost: 0.1 }, { name: 'B', revenue: 0, cost: 0.2 },
  ] } });
  const result = (await service.run(owner, task.id, 'r')).result!;
  assert.equal(result.data.profit, 0); assert.ok(!service.render(result).html!.includes('<script>'));
  assert.match(service.render(result).html!, /&lt;script&gt;/);
  assert.equal(businessSummarySkill.execute({ period: '2026-08', rows: [{ name: 'Z', revenue: 0, cost: 1 }] }).margin, null);
  assert.equal(service.render({ ...result, schemaVersion: '2.0.0' }).html, null);
});

test('failed execution records stage and snapshots; older successful results remain available', async () => {
  const store = new MemoryStore(); const service = new TemplateTaskService(store);
  const task = await service.save(owner, input()); await service.run(owner, task.id, 'success');
  const broken = new TemplateTaskService(store, [{ ...businessSummarySkill, format() { throw new Error('输出格式无效'); } }]);
  const failed = await broken.run(owner, task.id, 'failure');
  assert.equal(failed.status, 'failed'); assert.equal(failed.steps.at(-1)?.stage, 'output');
  assert.equal(failed.error, '输出格式无效'); assert.equal(failed.result, undefined);
  assert.equal((await broken.result(owner, task.id, 'success')).data.profit, 65000);
});

test('restart marks interrupted runs failed without replaying execution', async () => {
  const store = new MemoryStore(); const service = new TemplateTaskService(store);
  const task = await service.save(owner, input()); const run = await service.run(owner, task.id, 'r');
  const key = (await store.keys('template-runs:'))[0];
  await store.set(key, JSON.stringify({ ...run, status: 'running', result: undefined }));
  await service.recoverInterrupted();
  assert.equal((await service.detail(owner, task.id)).runs[0].status, 'failed');
  assert.equal((await service.listTemplates())[0].id, businessSummaryTemplate.id);
});

function configuration() {
  const { id: _id, version: _version, ...config } = businessSummaryTemplate;
  return { ...structuredClone(config), name: '自定义经营分析', defaults: input().parameters,
    presentation: { title: '区域月报', accent: 'green' as const, showSummary: false, showRows: false, defaultTab: 'data' as const },
    delivery: { storage: 'task-results' as const, exports: ['json', 'html', 'csv'] as Array<'json' | 'html' | 'csv'> },
  };
}

test('draft -> trial -> publish -> task defaults -> configured report and exports', async () => {
  const service = new TemplateTaskService(new MemoryStore());
  let draft = await service.saveDefinition(owner, configuration());
  assert.equal((await service.listTemplates(owner)).length, 1);
  await assert.rejects(service.publish(owner, draft.id, draft.revision), /试运行/);
  await assert.rejects(service.save(owner, { ...input(), templateId: draft.id }), /版本不可用/);
  const trial = await service.trial(owner, draft.id, draft.revision);
  assert.equal(trial.data.profit, 65000); assert.match(trial.html, /区域月报/); assert.ok(!trial.html.includes('<h2>业务明细'));
  draft = await service.publish(owner, draft.id, draft.revision);
  assert.equal(draft.published.length, 1);
  assert.equal((await service.listTemplates(owner)).length, 2);
  const task = await service.save(owner, { ...input(), templateId: draft.id, parameters: {} });
  const run = await service.run(owner, task.id, 'configured');
  assert.equal(run.status, 'completed'); assert.equal(run.result!.presentation?.defaultTab, 'data');
  assert.equal(run.result!.data.profit, 65000);
  assert.match((await service.exportResult(owner, task.id, run.id, 'html')).content, /区域月报/);
  assert.match((await service.exportResult(owner, task.id, run.id, 'csv')).content, /华东/);
  assert.equal(JSON.parse((await service.exportResult(owner, task.id, run.id, 'json')).content).taskId, task.id);
});

test('publishing a new version never changes existing tasks, results or editing old task parameters', async () => {
  const service = new TemplateTaskService(new MemoryStore());
  let draft = await service.saveDefinition(owner, configuration());
  await service.trial(owner, draft.id, draft.revision); draft = await service.publish(owner, draft.id, draft.revision);
  const task = await service.save(owner, { ...input(), templateId: draft.id, parameters: {} });
  const old = await service.run(owner, task.id, 'old');
  const changed = configuration(); changed.presentation.title = '新版本月报'; changed.defaults.rows[0].revenue = 150000;
  draft = await service.saveDefinition(owner, changed, draft.id, draft.revision);
  assert.equal(draft.draft.version, '1.0.1'); assert.equal(draft.verifiedRevision, undefined);
  await assert.rejects(service.publish(owner, draft.id, draft.revision), /试运行/);
  await service.trial(owner, draft.id, draft.revision); draft = await service.publish(owner, draft.id, draft.revision);
  assert.equal(draft.published.length, 2); assert.equal((await service.publish(owner, draft.id, draft.revision)).published.length, 2);
  const rerun = await service.run(owner, task.id, 'again');
  assert.equal(rerun.result?.data.revenue, 210000); assert.match(service.render(old.result!).html!, /区域月报/);
  await service.save(owner, { ...input(), templateId: draft.id }, task.id, 1);
  const newTask = await service.save(owner, { ...input(), templateId: draft.id, templateVersion: '1.0.1', parameters: {} });
  const newRun = await service.run(owner, newTask.id, 'new');
  assert.equal(newRun.result?.data.revenue, 240000); assert.match(service.render(newRun.result!).html!, /新版本月报/);
});

test('template ownership, draft conflicts and incompatible contracts are enforced', async () => {
  const service = new TemplateTaskService(new MemoryStore());
  const draft = await service.saveDefinition(owner, configuration());
  const stranger = { ...owner, userId: 'other' };
  assert.deepEqual(await service.definitions(stranger), []);
  await assert.rejects(service.definition(stranger, draft.id), /不存在/);
  await assert.rejects(service.previewInput(stranger, draft.id), /不存在/);
  await assert.rejects(service.trial(stranger, draft.id, 1), /不存在/);
  await assert.rejects(service.publish(stranger, draft.id, 1), /不存在/);
  await assert.rejects(service.archive(stranger, draft.id, 1, true), /不存在/);
  const changed = { ...configuration(), resultVersion: '2.0.0' };
  const updated = await service.saveDefinition(owner, changed, draft.id, draft.revision);
  await assert.rejects(service.saveDefinition(owner, configuration(), draft.id, draft.revision), /已更新/);
  await assert.rejects(service.trial(owner, draft.id, draft.revision), /已更新/);
  await assert.rejects(service.trial(owner, draft.id, updated.revision), /不兼容/);
  assert.equal((await service.definition(owner, draft.id)).verifiedRevision, undefined);
});

test('archiving removes template from creation but preserves existing task execution and history', async () => {
  const service = new TemplateTaskService(new MemoryStore());
  let draft = await service.saveDefinition(owner, configuration());
  await service.trial(owner, draft.id, 1); await service.publish(owner, draft.id, 1);
  const task = await service.save(owner, { ...input(), templateId: draft.id });
  draft = await service.archive(owner, draft.id, 1, true);
  assert.equal((await service.listTemplates(owner)).length, 1);
  await assert.rejects(service.save(owner, { ...input(), templateId: draft.id }), /停用/);
  assert.equal((await service.run(owner, task.id, 'archived')).status, 'completed');
  await service.archive(owner, draft.id, draft.revision, false);
  assert.equal((await service.listTemplates(owner)).length, 2);
});

test('export policy, escaping and zero-income calculations hold for configured templates', async () => {
  const service = new TemplateTaskService(new MemoryStore());
  const config = configuration(); config.delivery.exports = ['csv']; config.presentation.title = '<script>alert(1)</script>';
  config.defaults.rows[0].name = '=HYPERLINK("https://example.invalid")';
  const draft = await service.saveDefinition(owner, config);
  const trial = await service.trial(owner, draft.id, 1);
  assert.ok(!trial.html.includes('<script>')); assert.match(trial.html, /&lt;script&gt;/);
  await service.publish(owner, draft.id, 1);
  const task = await service.save(owner, { ...input(), templateId: draft.id, parameters: {} });
  await service.run(owner, task.id, 'r');
  await assert.rejects(service.exportResult(owner, task.id, 'r', 'html'), /未启用/);
  assert.match((await service.exportResult(owner, task.id, 'r', 'csv')).content, /'=HYPERLINK/);
});
test('TP-T13: Skill trial executes explicit test parameters while leaving defaults empty',async()=>{
 const service=new TemplateTaskService(new MemoryStore());
 const config=configuration(),parameters=structuredClone(config.defaults);
 const record=await service.saveDefinition(owner,{...config,defaults:{}});
 const result=await service.trial(owner,record.id,record.revision,parameters);
 assert.equal(result.mode,'execution');assert.match(result.html,/报告|汇总/);
 assert.deepEqual((await service.definition(owner,record.id)).draft.defaults,{});
 assert.equal((await service.publish(owner,record.id,record.revision)).published.length,1);
});
