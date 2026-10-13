import assert from 'node:assert/strict';
import test from 'node:test';
import { Orchestrator } from '../orchestrator.js';
import { templateAgentExecutor } from '../template-agent.js';
import { businessSummaryTemplate } from '../task-skills/business-summary/index.js';
import { runContext } from './fake.js';

test('TP-T1: template execution uses employee chat context and existing engine rather than model SDK',async()=>{
 let ownerSeen:string|undefined;let employeeSeen='';
 const orch=Orchestrator.memory({chatContextResolver:(employee,owner)=>{employeeSeen=employee;ownerSeen=owner??undefined;return runContext();},runner:{async start(request,emit){assert.match(request.messages.at(-1)!.content,/"product":"real"/);emit({type:'message.delta',runId:request.runId!,text:'完成结果'});emit({type:'run.completed',runId:request.runId!});}}});
 let sessionId='';let runId='';
 const output=await templateAgentExecutor(orch)({orgId:'org',userId:'alice'},{...businessSummaryTemplate,agent:{employeeId:'research',prompt:'研究'}},{product:'real'},'执行本轮研究',async(s,r)=>{sessionId=s;runId=r;});
 assert.equal(employeeSeen,'research');assert.equal(ownerSeen,'alice');assert.equal(output.text,'完成结果');assert.equal(output.agentRunId,runId);
 const session=await orch.chat.getChatSession(sessionId);assert.equal(session?.orgId,'org');assert.equal(session?.ownerUserId,'alice');assert.equal(session?.employeeId,'research');
 assert.equal((await orch.chat.getRun(runId))?.status,'completed');await orch.close();
});
