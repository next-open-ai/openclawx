import {withWorkResultAccess,createWorkResultRanker} from '@workmate/agent-core';
import type {AgentRunner,KeyValueStore,Orchestrator,RunRecord} from '@workmate/orchestrator';
import {createWorkResultService,isPrivateWorkOwner} from './service.js';

export function createWorkResultRunner(store:KeyValueStore,orch:()=>Orchestrator,active:(u:string,o:string)=>unknown,base:AgentRunner):AgentRunner{
  return{async start(request,emit,options){
    const raw=request.runId?await store.get(`run:${request.runId}`):null,run:RunRecord|undefined=raw?JSON.parse(raw):undefined;
    let executor;
    if(run?.ownerUserId&&run.orgId&&active(run.ownerUserId,run.orgId)){
      const owner={userId:run.ownerUserId,orgId:run.orgId};
      const source=await store.get(`${run.kind==='chat'?'sessions':'projects'}:${run.sessionId}`);
      if(isPrivateWorkOwner(run,owner)&&source&&isPrivateWorkOwner(JSON.parse(source),owner)){
        const service=createWorkResultService(orch(),owner,run.kind==='chat'?run.sessionId:undefined,active,undefined,createWorkResultRanker(request.model));
        executor=async(...args:Parameters<typeof service>)=>{
          const current=await store.get(`${run.kind==='chat'?'sessions':'projects'}:${run.sessionId}`);
          if(!current||!isPrivateWorkOwner(JSON.parse(current),owner))return{ok:false,status:'failed',code:'WORK_NOT_AVAILABLE',spokenSummary:'来源会话权限已变化，不能检索私人历史。'};
          const result=await service(...args);
          const latest=await store.get(`${run.kind==='chat'?'sessions':'projects'}:${run.sessionId}`);
          return latest&&isPrivateWorkOwner(JSON.parse(latest),owner)?result:{ok:false,status:'failed',code:'WORK_NOT_AVAILABLE',spokenSummary:'来源会话权限已变化，结果未返回。'};
        };
      }
    }
    return withWorkResultAccess(executor,()=>base.start(request,emit,options));
  }};
}
