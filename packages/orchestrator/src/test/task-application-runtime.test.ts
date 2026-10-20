import test from 'node:test';
import assert from 'node:assert/strict';
import {Orchestrator} from '../orchestrator.js';
import {createScriptedRunner} from '../echo-runner.js';
import {TemplateTaskService,taskRunJsonResult} from '../template-tasks.js';
import {templateAgentExecutor} from '../template-agent.js';
import {businessSummaryTemplate} from '../task-skills/business-summary/index.js';
import {runContext} from './fake.js';
import type {TemplateTaskRun} from '@openclawx/contracts';
const owner={orgId:'app-org',userId:'app-user'};
async function setup(orch:Orchestrator){const service=new TemplateTaskService(orch.store,undefined,undefined,templateAgentExecutor(orch));const {id:_id,version:_v,...base}=businessSummaryTemplate;let definition=await service.saveDefinition(owner,{...base,application:true,agent:{employeeId:'general',prompt:'执行任务'}});await service.trial(owner,definition.id,definition.revision,{});definition=await service.publish(owner,definition.id,definition.revision);const task=await service.save(owner,{name:'任务应用测试',templateId:definition.id,templateVersion:definition.draft.version,parameters:{}});return{service,task,definition};}
async function until(fn:()=>Promise<boolean>){for(let n=0;n<150;n++){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('test condition timed out');}
test('TA-T3: queued Agent is observed without failure or duplicate submission',async()=>{
 let polls=0,sends=0;const session={id:'stub-session',...owner,ownerUserId:owner.userId,messages:[]};
 const orch={chat:{async createChatSession(){return session;},async sendUserMessage(){sends++;return{runId:'stub-run'};},async getChatSession(){return session;},async getRun(){return{status:++polls<3?'queued':'completed',transcript:'done',artifacts:[]};}}} as unknown as Orchestrator;
 const phases:string[]=[];const result=await templateAgentExecutor(orch)(owner,{...businessSummaryTemplate,agent:{employeeId:'general',prompt:'test'}},{},'test',async(_s,_r,status)=>{if(status)phases.push(status);});
 assert.equal(result.text,'done');assert.equal(sends,1);assert.ok(phases.includes('queued'));
});
test('TA-T3: approval continuation writes back to the original task run',async()=>{
 const runner=createScriptedRunner(true),orch=Orchestrator.memory({runner,chatContextResolver:async()=>runContext()});
 try{const {service,task}=await setup(orch);const pending=service.run(owner,task.id,'app-run');
 await until(async()=> (await service.detail(owner,task.id)).runs[0]?.agentStatus==='waiting-approval');
 const waiting=(await service.detail(owner,task.id)).runs[0];assert.equal(waiting.status,'running');assert.equal(waiting.jsonResult?.agentStatus,'waiting-approval');
 const approvals=await orch.chat.pendingApprovals(waiting.sessionId!);await orch.chat.resolveApproval({sessionId:waiting.sessionId!,approvalId:approvals[0].approvals[0].id,allow:true,scope:'session',resumeContext:runContext()});
 const done=await pending;assert.equal(done.id,'app-run');assert.equal(done.status,'completed');assert.notEqual(done.agentRunId,waiting.agentRunId);assert.ok(done.result);assert.equal(done.agentStatus,undefined);
 }finally{await orch.close();}
});
test('TA-T3: restart observation collects an already completed linked turn without resubmission',async()=>{
 const runner=createScriptedRunner(),orch=Orchestrator.memory({runner,chatContextResolver:async()=>runContext()});
 try{const {service,task,definition}=await setup(orch);const session=await orch.chat.createChatSession({...owner,ownerUserId:owner.userId,employeeId:'general',title:'persisted'});const {runId}=await orch.chat.sendUserMessage(session.id,{content:'existing task'});
 await until(async()=> (await orch.chat.getRun(runId))?.status==='completed');const calls=runner.calls.length;
 const run:TemplateTaskRun={id:'recovered',taskId:task.id,taskName:task.name,taskRevision:task.revision,template:definition.draft,inputSnapshot:{},startedAt:Date.now()-1000,status:'running',steps:[],sessionId:session.id,agentRunId:runId};run.jsonResult=taskRunJsonResult(run);
 const taskKey=(await orch.store.keys('template-tasks:'))[0];await orch.store.set(`template-runs:${taskKey}:recovered`,JSON.stringify(run));
 const restarted=new TemplateTaskService(orch.store,undefined,undefined,templateAgentExecutor(orch));await restarted.recoverInterrupted();await until(async()=> (await restarted.detail(owner,task.id)).runs[0]?.status==='completed');
 assert.equal(runner.calls.length,calls);const restored=(await restarted.detail(owner,task.id)).runs[0];assert.equal(restored.result?.title,task.name);assert.equal(restored.jsonResult?.status,'completed');
 }finally{await orch.close();}
});
test('TA-T3: long running batch does not block later schedule claims',async()=>{
 const orch=Orchestrator.memory();let calls=0;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const service=new TemplateTaskService(orch.store,undefined,undefined,async()=>{calls++;await gate;return{text:'done'};});
 try{for(let i=0;i<5;i++)await service.save(owner,{mode:'direct',name:`scheduled-${i}`,employeeId:'general',prompt:'execute',schedule:{kind:'once',enabled:true,at:Date.now()+60_000}});
 const first=service.tickScheduled(Date.now()+120_000);await until(async()=>calls===4);
 const second=service.tickScheduled(Date.now()+120_000);await until(async()=>calls===5);release();await Promise.all([first,second]);assert.equal(calls,5);
 }finally{release();await orch.close();}
});
