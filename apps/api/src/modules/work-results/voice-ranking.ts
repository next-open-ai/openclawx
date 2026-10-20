import {createWorkResultRanker} from '@openclawx/agent-core';
import {randomUUID} from 'node:crypto';
import {WorkResultRankingDiagnosticSchema,type WorkResultRanker,type WorkResultRanking} from '@openclawx/contracts';
import type {Orchestrator} from '@openclawx/orchestrator';
import {resolveEmployeeChatModel} from '../orchestration/context-assembler.js';
import {isPrivateWorkOwner} from './service.js';

/** Resolve the normal text model lazily; a realtime speech endpoint is not a chat model. */
export function createVoiceWorkResultRanker(orch:Orchestrator,owner:{userId:string;orgId:string},conversation?:string|(()=>string|undefined),log:(event:Record<string,unknown>)=>void=()=>undefined):WorkResultRanker {
  return async(query,candidates,signal)=>{
    const started=performance.now(),rankId=randomUUID();
    let conversationId:string|undefined,employeeId='general';
    let result:WorkResultRanking={status:'unavailable',matches:[],diagnostic:{code:'MODEL_RESOLUTION_FAILED',candidateCount:Math.min(candidates.length,60),elapsedMs:0}};
    try{
      conversationId=typeof conversation==='function'?conversation():conversation;
      const source=conversationId?await orch.chat.getChatSession(conversationId):null;
      if(signal?.aborted){result.diagnostic!.code='CANCELLED';return result;}
      if(conversationId&&!isPrivateWorkOwner(source,owner)){result.diagnostic!.code='SOURCE_UNAVAILABLE';return result;}
      employeeId=source?.employeeId||'general';
      const model=await resolveEmployeeChatModel(orch.store,employeeId,owner.userId);
      result=await createWorkResultRanker(model??undefined)(query,candidates,signal);
      return result;
    }catch{return result;}
    finally{
      const diagnostic=WorkResultRankingDiagnosticSchema.parse({...result.diagnostic,elapsedMs:Math.max(0,performance.now()-started)});
      // Do not serialize query, candidates, secrets, URLs or raw provider errors.
      try{log({event:'work_results.semantic',rankId,conversationId,employeeId,modelSource:'employee_text',status:result.status,selectedCount:result.matches.length,...diagnostic});}catch{/* Logging must never change lookup behavior. */}
    }
  };
}
