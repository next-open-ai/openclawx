import {readDocument} from '@openclawx/agent-core';
import type {DocumentInfo} from '@openclawx/contracts';
import {WorkResultItemSchema,WorkResultMatchesSchema,workResultInputs,type WorkResultItem,type WorkResultToolName,type WorkLookupResult,type WorkResultRanker} from '@openclawx/contracts';
import type {Orchestrator} from '@openclawx/orchestrator';
import {listWorkAssets,readWorkAsset,assertWorkAssetOwner} from '../assets/routes.js';
import {matchesWorkResult} from './matching.js';
import {workResultSearchPlan} from './search-plan.js';

type Owner={userId:string;orgId:string};
type OwnedWorkSource={ownerUserId?:string|null;userId?:string|null;orgId?:string;accessScope?:string;accessGrants?:unknown[]};
const privateOwner=(row:OwnedWorkSource|null|undefined,owner:Owner)=>Boolean(row&&(row.ownerUserId??row.userId)===owner.userId&&row.orgId===owner.orgId&&(!row.accessScope||row.accessScope==='private')&&!row.accessGrants?.length);
const error=(code:string,spokenSummary:string):WorkLookupResult=>({ok:false,status:'failed',code,spokenSummary});
export const isPrivateWorkOwner=privateOwner;
export function createWorkResultService(orch:Orchestrator,owner:Owner,conversationId?:string,active:(u:string,o:string)=>unknown=()=>true,deps:{list:typeof listWorkAssets;read:typeof readWorkAsset;verify:typeof assertWorkAssetOwner}={list:listWorkAssets,read:readWorkAsset,verify:assertWorkAssetOwner},ranker?:WorkResultRanker){
  async function check(signal?:AbortSignal){
    if(signal?.aborted)throw Error('WORK_CANCELLED');
    if(!active(owner.userId,owner.orgId))throw Error('WORK_NOT_AVAILABLE');
    if(conversationId&&!privateOwner(await orch.chat.getChatSession(conversationId),owner))throw Error('WORK_NOT_AVAILABLE');
  }
  function assetItem(row:Awaited<ReturnType<typeof listWorkAssets>>[number]):WorkResultItem{
    return WorkResultItemSchema.parse({kind:'asset',id:row.id,name:row.name.slice(0,240),createdAt:row.createdAt,conversationId:row.conversationId||undefined,projectId:row.projectId||undefined,runId:/^[a-f0-9-]{36}$/i.test(row.runId)?row.runId:undefined,mimeType:row.mimeType,sizeBytes:row.sizeBytes,status:'archived'});
  }
  return async(name:WorkResultToolName,input:unknown,signal?:AbortSignal):Promise<WorkLookupResult>=>{
    const parsed=workResultInputs[name].safeParse(input);
    if(!parsed.success)return error('WORK_INVALID_INPUT','参数不正确，请先搜索，再使用真实成果ID。');
    try{
      await check(signal);
      if(name==='search_work_results'){
        const search=workResultInputs.search_work_results.parse(parsed.data);
        const plan=workResultSearchPlan(search);
        const {scope}=plan,{limit}=search,query=plan.topic;
        if(scope==='current'&&!conversationId)return error('WORK_CURRENT_REQUIRED','当前没有关联对话，请使用history范围查找历史成果。');
        const current=scope==='current'?await orch.chat.getChatSession(conversationId!):undefined;
        const currentRuns=current?[...new Set(current.messages.filter(m=>m.runId&&!m.superseded).map(m=>m.runId!))].reverse().slice(0,100):[];
        const rows=await deps.list(owner,'',scope==='current'?conversationId:undefined,501,currentRuns);
        const assets=rows.slice(0,500).map(assetItem);
        let truncated=rows.length>500;
        const sessionKeys=scope==='history'?await orch.store.keys('sessions:'):[];
        const sessions=scope==='current'?[current]:await Promise.all(sessionKeys.slice(-200).map(key=>orch.chat.getChatSession(key.slice('sessions:'.length))));
        const owned=sessions.filter(row=>privateOwner(row,owner)).sort((a,b)=>b!.updatedAt-a!.updatedAt);
        truncated ||= sessionKeys.length>200;
        const summaries=new Map<string,string>();
        const summarySources=new Map<string,string>();
        for(const session of owned){
          if(!session)continue;
          for(const message of session.messages.slice(-100)){
            if(!message.runId||message.superseded||typeof message.content!=='string')continue;
            const before=summaries.get(message.runId)||`${session.title.slice(0,120)}\n`;
            if(before.length<600){summaries.set(message.runId,(before+`${message.role}: ${message.content.slice(0,480)}\n`).slice(0,600));summarySources.set(message.runId,session.id);}
          }
        }
        for(const item of assets)if(item.runId)item.summary=summaries.get(item.runId);
        const runs:WorkResultItem[]=[];
        for(const session of owned.slice(0,200)){
          if(!session)continue;
          const ids=[...new Set(session.messages.filter(m=>m.runId&&!m.superseded).map(m=>m.runId!))].reverse().slice(0,3);
          for(const id of ids){
            if(runs.length>=60){truncated=true;break;}
            if(assets.some(item=>item.runId===id))continue;
            const run=await orch.chat.getRun(id);if(!privateOwner(run,owner))continue;
            runs.push({kind:'run',id,name:session.title.slice(0,240),conversationId:session.id,runId:id,createdAt:run!.startedAt,status:run!.status,summary:summaries.get(id)});
          }
        }
        const pool=[...assets,...runs].filter(plan.accepts).sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));
        const keyword=(item:WorkResultItem)=>matchesWorkResult(query,item.name)||Boolean(item.summary&&matchesWorkResult(query,item.summary));
        const matched=pool.filter(keyword);
        let items=matched.slice(0,limit),searchMode:'keyword'|'semantic'|'fallback'='keyword';
        async function verify(items:WorkResultItem[]){for(const item of items){
          if(item.kind==='asset')await deps.verify(item.id,owner);
          const sourceId=item.kind==='run'?item.conversationId:item.summary&&item.runId?summarySources.get(item.runId):undefined;
          if(sourceId&&!privateOwner(await orch.chat.getChatSession(sourceId),owner))throw Error('WORK_NOT_AVAILABLE');
          if(item.kind==='run'&&!privateOwner(await orch.chat.getRun(item.id),owner))throw Error('WORK_NOT_AVAILABLE');
        }}
        if(ranker&&query&&pool.length){
          // Keyword hits first, then recent authorized metadata even with no lexical overlap.
          const candidates=[...matched,...pool.filter(item=>!keyword(item))].slice(0,60);
          truncated ||= pool.length>candidates.length;
          await verify(candidates);await check(signal);
          try{
            const ranked=await ranker(query,candidates,signal);
            const valid=WorkResultMatchesSchema.safeParse({matches:ranked.matches});
            if(ranked.status!=='ranked'||!valid.success)throw Error('WORK_RANK_UNAVAILABLE');
            const allowed=new Map(candidates.map(item=>[`${item.kind}:${item.id}`,item])),seen=new Set<string>();
            const selected:WorkResultItem[]=[];
            for(const match of valid.data.matches){
              const key=`${match.kind}:${match.id}`,item=allowed.get(key);
              if(item&&match.confidence>=0.65&&!seen.has(key)){seen.add(key);selected.push(item);}
            }
            if(valid.data.matches.some(match=>match.confidence>=0.65)&&!selected.length)throw Error('WORK_RANK_UNAVAILABLE');
            items=selected.slice(0,limit);truncated ||= selected.length>limit;searchMode='semantic';
          }catch{
            searchMode='fallback';
            items=[...matched,...pool.filter(item=>!keyword(item))].slice(0,limit);
            truncated ||= pool.length>limit;
          }
          // Revalidate everything sent to the model, even when it selects no results.
          await check(signal);await verify(candidates);
        }
        truncated ||= searchMode!=='semantic'&&matched.length>limit;
        await verify(items);await check(signal);
        const scopeLabel=scope==='current'?'当前对话':'历史成果';
        const spokenSummary=searchMode==='fallback'?`未完成语义匹配，先列出${scopeLabel}的${items.length}项最近候选供您选择；候选不保证符合主题，不能据此判断成果不存在。`:
          items.length?`在${scopeLabel}${searchMode==='semantic'?'按语义':''}找到${items.length}项候选成果，请查看列表；有多个候选时请选择。${truncated?'候选有截断，可缩小关键词或打开原对话。':''}`:
          `在${scopeLabel}本次候选中未找到匹配成果。${truncated?'候选有截断，不代表全部历史不存在。':''}${scope==='current'?'请继续使用history范围检索，不能据此判定历史没有成果。':'可换关键词或打开原对话核对。'}不会自动重新生成。`;
        return{ok:true,status:searchMode==='fallback'?'partial':items.length?'found':'empty',code:searchMode==='fallback'?'WORK_SEMANTIC_UNAVAILABLE':undefined,spokenSummary,items,truncated,searchMode,scope};
      }
      const {assetId,runId}=workResultInputs.read_work_result.parse(parsed.data);
      let text='',truncated=false,item:WorkResultItem,documentInfo:DocumentInfo|undefined;
      if(runId){
        const run=await orch.chat.getRun(runId);if(!privateOwner(run,owner)||run?.kind!=='chat')throw Error('WORK_NOT_AVAILABLE');
        const session=await orch.chat.getChatSession(run!.sessionId);if(!privateOwner(session,owner))throw Error('WORK_NOT_AVAILABLE');
        text=run!.transcript||'';item={kind:'run',id:runId,runId,conversationId:session!.id,name:session!.title.slice(0,240),createdAt:run!.startedAt,status:run!.status};
      }else{
        const loaded=await deps.read(assetId!,owner);item=assetItem(loaded.row);
        const document=await readDocument({fileName:item.name,bytes:loaded.content,mimeType:item.mimeType,maxBytes:10*1024*1024,maxPages:20,maxChars:16000,allowEnhanced:false,signal});
        await check(signal);await deps.verify(assetId!,owner);
        if(!document.ok){
          const codes:Record<string,string>={DOCUMENT_EMPTY:'WORK_TEXT_EMPTY',DOCUMENT_UNSUPPORTED:'WORK_UNSUPPORTED',DOCUMENT_CANCELLED:'WORK_CANCELLED',DOCUMENT_TOO_LARGE:'WORK_FILE_TOO_LARGE'};
          return{...error(codes[document.code]||'WORK_DOCUMENT_PARSE_FAILED',document.message),items:[item],documentInfo:document.info};
        }
        text=document.text;truncated=document.info.truncated;documentInfo=document.info;
        await deps.verify(assetId!,owner);
      }
      await check(signal);truncated ||= text.length>16000;
      if(runId&&!privateOwner(await orch.chat.getChatSession(item.conversationId!),owner))throw Error('WORK_NOT_AVAILABLE');
      const useful=text.replace(/\[第\d+页\]/g,'').trim();
      if(!useful)return{...error('WORK_TEXT_EMPTY','已找到记录，但没有可读取的正文，请查看来源或交给员工进一步处理。'),items:[item]};
      return{ok:true,status:'read',spokenSummary:truncated?'已读取部分正文，内容有截断，请按需打开原文件核对。':'已读取成果正文，可基于实际内容回答。',items:[item],text:text.slice(0,16000),truncated,documentInfo};
    }catch(cause){
      const code=cause instanceof Error?cause.message:'';
      const messages:Record<string,string>={WORK_CANCELLED:'检索已取消。',WORK_NOT_AVAILABLE:'成果不存在或当前账号无访问权限。',WORK_FILE_MISSING:'成果已登记，但文件已不可用或被移除。',WORK_FILE_UNSAFE:'成果文件路径不安全，无法读取。',WORK_FILE_TOO_LARGE:'文件超过10MB，请打开原文件或提供较小版本。'};
      return error(messages[code]?code:'WORK_READ_FAILED',messages[code]||'成果读取失败，可能是文件格式或解析问题；这不代表没有成果。');
    }
  };
}
