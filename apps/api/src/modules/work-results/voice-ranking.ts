import {createWorkResultRanker} from '@workmate/agent-core';
import type {WorkResultRanker} from '@workmate/contracts';
import type {Orchestrator} from '@workmate/orchestrator';
import {resolveEmployeeChatModel} from '../orchestration/context-assembler.js';
import {isPrivateWorkOwner} from './service.js';

/** Resolve the normal text model lazily; a realtime speech endpoint is not a chat model. */
export function createVoiceWorkResultRanker(orch:Orchestrator,owner:{userId:string;orgId:string},conversation?:string|(()=>string|undefined)):WorkResultRanker {
  return async(query,candidates,signal)=>{
    try{
      const conversationId=typeof conversation==='function'?conversation():conversation;
      const source=conversationId?await orch.chat.getChatSession(conversationId):null;
      if(conversationId&&!isPrivateWorkOwner(source,owner))return{status:'unavailable',matches:[]};
      const model=await resolveEmployeeChatModel(orch.store,source?.employeeId||'general',owner.userId);
      return createWorkResultRanker(model??undefined)(query,candidates,signal);
    }catch{return{status:'unavailable',matches:[]};}
  };
}
