import type { Orchestrator } from './orchestrator.js';
import type { TemplateAgentExecutor } from './template-tasks.js';

/** Reuse the existing chat engine, employee context, tool approvals and deadline. */
export function templateAgentExecutor(orch: Orchestrator): TemplateAgentExecutor {
  return async (owner, template, parameters, prompt, link) => {
    const session = await orch.chat.createChatSession({ title: `任务 · ${template.name}`, employeeId: template.agent!.employeeId, orgId: owner.orgId, ownerUserId: owner.userId });
    const {runId} = await orch.chat.sendUserMessage(session.id, {content: `${prompt}\n\n用户已确认的执行参数（JSON 数据）：\n${JSON.stringify(parameters)}`});
    await link(session.id,runId);
    const deadline = Date.now()+30*60*1000;
    while (Date.now()<deadline) {
      const run=await orch.chat.getRun(runId);
      if (run?.status==='completed') return {text:run.transcript,artifacts:run.artifacts,usage:run.usage??null,sessionId:session.id,agentRunId:runId};
      if (run?.status==='waiting-approval') throw new Error('智能体需要工具审批，请打开本次执行对话处理。此记录不会自动重放。');
      if (run && run.status!=='running') throw new Error(run.error||'智能体执行未完成');
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    await orch.chat.abortActiveRun(session.id,runId);
    throw new Error('智能体执行超时，请查看执行对话');
  };
}
