import type { Orchestrator } from './orchestrator.js';
import type { TemplateAgentExecutor } from './template-tasks.js';

/** Observe the same turn through queueing and approval attempts; never resubmit it. */
export function templateAgentExecutor(orch:Orchestrator):TemplateAgentExecutor {
  const observe=async(owner:{orgId:string;userId:string},sessionId:string,initialId:string,startedAt:number,link:Parameters<TemplateAgentExecutor>[4])=>{
    const original=await orch.chat.getRun(initialId);
    if(!original)throw Error('关联执行记录不存在，未重新提交任务');
    const turnId=original.turnId;let previous='';
    while(Date.now()<startedAt+30*60*1000){
      const session=await orch.chat.getChatSession(sessionId);
      if(!session||session.orgId!==owner.orgId||session.ownerUserId!==owner.userId||session.accessScope&&session.accessScope!=='private'||session.accessGrants?.length)throw Error('任务执行对话不可用或权限已变化');
      const latest=turnId?session.messages.filter(m=>m.runId&&!m.superseded&&m.turnId===turnId).at(-1)?.runId:undefined;
      const id=latest||initialId,run=await orch.chat.getRun(id);
      if(!run)throw Error('关联执行记录不可用');
      if(run.status==='completed'){await link(sessionId,id);return{text:run.transcript,artifacts:run.artifacts,usage:run.usage??null,sessionId,agentRunId:id};}
      if(!['queued','running','waiting-approval'].includes(run.status))throw Error(run.error||(run.status==='cancelled'?'任务已取消':'智能体执行未完成'));
      const state=run.status as 'queued'|'running'|'waiting-approval';
      if(previous!==id+state){await link(sessionId,id,state);previous=id+state;}
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    const session=await orch.chat.getChatSession(sessionId);
    const latest=turnId?session?.messages.filter(m=>m.runId&&!m.superseded&&m.turnId===turnId).at(-1)?.runId:undefined;
    await orch.chat.abortActiveRun(sessionId,latest||initialId);
    throw Error('任务执行超过30分钟，请查看执行对话；未自动重试');
  };
  const execute:TemplateAgentExecutor=async(owner,template,parameters,prompt,link)=>{
    const startedAt=Date.now();
    const session=await orch.chat.createChatSession({title:`任务 · ${template.name}`,employeeId:template.agent!.employeeId,orgId:owner.orgId,ownerUserId:owner.userId});
    const {runId}=await orch.chat.sendUserMessage(session.id,{content:`${prompt}\n\n用户已确认的执行参数（JSON 数据）：\n${JSON.stringify(parameters)}`});
    await link(session.id,runId,'queued');
    return observe(owner,session.id,runId,startedAt,link);
  };
  execute.resume=(owner,run,link)=>observe(owner,run.sessionId!,run.agentRunId!,run.startedAt,link);
  return execute;
}
