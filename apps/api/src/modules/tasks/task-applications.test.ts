import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {Orchestrator,TemplateTaskService,templateAgentExecutor,createScriptedRunner} from '@workmate/orchestrator';
import {TaskApplications} from './task-applications.js';
import {ParameterProjects} from './parameter-project.js';
const owner={orgId:'task-app-org',userId:'task-app-owner'};
test('TA-T1/T2: editor references, explicit publish, isolated idempotent launch, schedules and pinned snapshots',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'workmate-task-app-'));const runner=createScriptedRunner();
 const orch=Orchestrator.open(path.join(root,'domain.json'),{runner,chatContextResolver:async()=>({profile:{id:'general',name:'General',instructions:'',toolIds:[]},model:{provider:'ollama',chatModel:'test',apiKey:'test'},skills:[],searchProviders:[],mcpConnections:[],knowledgeBases:[]})});
 const tasks=new TemplateTaskService(orch.store,undefined,undefined,templateAgentExecutor(orch)),projects=new ParameterProjects(orch,tasks,root),apps=new TaskApplications(orch,tasks,projects);
 try{
  const catalog={units:[{id:'unit-students',fields:[{id:'name',type:'string'}]}]};
const created=await apps.create(owner,{name:'研究应用',description:'按参数研究',employeeId:'general',prompt:'执行研究'},catalog);let definition=created.definition;
  assert.equal(runner.calls.length,0);assert.equal(definition.draft.application,true);const project=(await orch.projects.getProject(created.projectId))!;
  const ref=JSON.parse(await readFile(path.join(project.workspacePath,'TASK-API-REFERENCE.json'),'utf8'));assert.equal(ref.hostOnly,true);assert.match(ref.endpoints[0].path,/task-applications/);
  assert.match(await readFile(path.join(project.workspacePath,'index.html'),'utf8'),/platform.submit/);
  assert.deepEqual(JSON.parse(await readFile(path.join(project.workspacePath,'DATA-CATALOG.json'),'utf8')),catalog);
  await assert.rejects(apps.definition({...owner,userId:'other'},definition.id),/不存在/);
  const requestId=crypto.randomUUID(),input={requestId,version:definition.draft.version,name:'研究实例',parameters:{request:'本月'},schedule:{kind:'manual'},executeNow:true};
  await assert.rejects(apps.launch(owner,definition.id,input),/发布/);
  definition=await projects.import(owner,definition.id,definition.revision);await tasks.trial(owner,definition.id,definition.revision,input.parameters);definition=await tasks.publish(owner,definition.id,definition.revision);assert.equal(runner.calls.length,0);
  const [a,b]=await Promise.all([apps.launch(owner,definition.id,input),apps.launch(owner,definition.id,input)]);assert.equal(a.task.id,b.task.id);assert.equal((await tasks.list(owner)).length,1);
  for(let n=0;n<150&&(await tasks.detail(owner,a.task.id)).runs[0]?.status!=='completed';n++)await new Promise(resolve=>setTimeout(resolve,20));
  const done=(await tasks.detail(owner,a.task.id)).runs[0];assert.equal(done.status,'completed');assert.equal(runner.calls.length,1);assert.equal(done.template.version,input.version);assert.deepEqual(done.inputSnapshot,input.parameters);
  await assert.rejects(apps.launch(owner,definition.id,{...input,parameters:{request:'changed'}}),/同一提交编号/);
  await assert.rejects(apps.launch({...owner,userId:'other'},definition.id,input),/不存在/);
  await assert.rejects(apps.launch(owner,definition.id,{...input,requestId:crypto.randomUUID(),parameters:{unknown:'bad'}}),/参数/);
  const scheduled=await apps.launch(owner,definition.id,{...input,requestId:crypto.randomUUID(),executeNow:false,schedule:{kind:'once',enabled:true,at:Date.now()+60_000}});assert.equal(scheduled.status,'scheduled');assert.equal((await tasks.detail(owner,scheduled.task.id)).runs.length,0);assert.ok(scheduled.task.scheduleState?.nextRunAt);
  assert.equal((await apps.list(owner)).length,1);
  // A launch creates a durable task, not a disposable one-shot execution.
  const updated=await tasks.save(owner,{name:'修改后的研究任务',templateId:definition.id,templateVersion:input.version,parameters:{request:'下月'},schedule:{kind:'manual'}},a.task.id,a.task.revision);
  assert.equal(updated.id,a.task.id);
  const again=await tasks.run(owner,updated.id,crypto.randomUUID());
  assert.equal(again.status,'completed');assert.notEqual(again.id,done.id);assert.deepEqual(again.inputSnapshot,{request:'下月'});
  assert.deepEqual((await tasks.detail(owner,updated.id)).runs.find(run=>run.id===done.id)?.inputSnapshot,input.parameters);
  await tasks.tickScheduled(Date.now()+120_000);
  const once=await tasks.get(owner,scheduled.task.id);assert.equal(once.scheduleState?.nextRunAt,null);
  assert.equal((await tasks.run(owner,once.id,crypto.randomUUID())).status,'completed','one-time schedule still permits manual rerun');
  await tasks.save(owner,{name:'已执行计划仍可编辑',templateId:definition.id,templateVersion:input.version,parameters:{request:'更新'},schedule:once.schedule},once.id,once.revision);
  await tasks.deleteTask(owner,updated.id,updated.revision);
  assert.equal((await tasks.list(owner)).some(task=>task.id===updated.id),false);
  assert.equal((await tasks.detail(owner,updated.id)).runs.length,2);
 }finally{await orch.close();await rm(root,{recursive:true,force:true});}
});
