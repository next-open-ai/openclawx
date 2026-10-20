import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Orchestrator,MemoryStore,createScriptedRunner} from '@workmate/orchestrator';
import {createWorkResultService} from './service.js';
import {storeUploadedDataAsset,listWorkAssets,readWorkAsset,assertWorkAssetOwner} from '../assets/routes.js';
import {VoiceWorkBridge} from '../voice/work-bridge.js';
import {createWorkResultRunner} from './runner.js';
import {createWorkResultTools} from '@workmate/agent-core';
import {matchesWorkResult} from './matching.js';
import {workResultSearchPlan} from './search-plan.js';
import {workResultInputs} from '@workmate/contracts';
import type {WorkResultRanker} from '@workmate/contracts';
import {createServer} from 'node:http';
import {createVoiceWorkResultRanker} from './voice-ranking.js';
import {applyParentSecrets,getSecrets} from '../orchestration/secrets.js';
import {extractToolDetails,workspacesRootDir} from '@workmate/agent-core';
import {readChatFile} from '../orchestration/chat-attachments.js';
import {saveChatFile,resolveChatFiles} from '../orchestration/chat-attachments.js';
import {zipSync,strToU8} from 'fflate';
const owner={userId:'work-user',orgId:'work-org'};
const context={profile:{id:'general',name:'General',instructions:'',toolIds:[]},model:{provider:'ollama' as const,chatModel:'test',apiKey:'test'},skills:[],searchProviders:[],mcpConnections:[],knowledgeBases:[]};
const root=await fs.mkdtemp(path.join(os.tmpdir(),'workmate-work-results-'));
process.env.WORKMATE_DATA_DIR=root;
test.after(async()=>{await fs.rm(root,{recursive:true,force:true});});
const makeOrch=()=>new Orchestrator({store:new MemoryStore(),runner:createScriptedRunner(),chatContextResolver:async()=>context});

test('WR-T10: Shanghai date boundaries, metadata intent and topic preservation',()=>{
  const now=Date.parse('2026-10-15T16:01:00Z'); // Shanghai Oct 16 00:01
  const input=workResultInputs.search_work_results.parse({query:'帮我找一下今天写的文件'});
  const plan=workResultSearchPlan(input,now);
  assert.equal(plan.topic,'');assert.equal(plan.created,'today');assert.equal(plan.fileType,'file');assert.equal(plan.scope,'history');
  assert.equal(workResultSearchPlan({...input,query:'查一下今天我写的文件'},now).topic,'');
  const asset={kind:'asset' as const,id:crypto.randomUUID(),name:'report.pdf',createdAt:Date.parse('2026-10-15T16:00:00Z')};
  assert.equal(plan.accepts(asset),true);
  assert.equal(plan.accepts({...asset,createdAt:asset.createdAt-1}),false);
  assert.equal(plan.accepts({...asset,createdAt:asset.createdAt+86_400_000}),false);
  assert.equal(plan.accepts({...asset,kind:'run'}),false);
  const yesterday=workResultSearchPlan({...input,created:'yesterday'},now);
  assert.equal(yesterday.accepts({...asset,createdAt:asset.createdAt-1}),true);assert.equal(yesterday.accepts(asset),false);
  const recent=workResultSearchPlan({...input,query:'最近写的pdf文件'},now);
  assert.equal(recent.topic,'');assert.equal(recent.fileType,'pdf');assert.equal(recent.accepts({...asset,name:'no-extension',mimeType:'application/pdf; charset=binary'}),true);
  assert.equal(recent.accepts({...asset,name:'report.txt',mimeType:'text/plain'}),false);
  const themed=workResultSearchPlan({...input,query:'帮我找一下今天生成的三亚攻略PDF文件'},now);
  assert.equal(themed.topic,'三亚攻略');
  assert.equal(workResultSearchPlan({...input,query:'当前对话今天写的文件'},now).scope,'current');
  assert.equal(workResultSearchPlan({...input,query:'海边攻略'},now).topic,'海边攻略');
  assert.equal(workResultInputs.search_work_results.safeParse({created:'tomorrow'}).success,false);
  assert.equal(workResultInputs.search_work_results.safeParse({query:'',fileType:'pdf',created:'recent'}).success,true);
});

test('WR-T10: direct metadata lookup skips LLM, sorts, filters, handles history/current and safe fallback',async()=>{
  const orch=makeOrch(),user={...owner,userId:'metadata-search'};
  try{
    const stored=await storeUploadedDataAsset({name:'seed.pdf',content:pdfBytes(),auth:user});
    const row=(await listWorkAssets(user,'',undefined,20)).find(item=>item.id===stored.id)!;
    const now=Date.now(),start=Math.floor((now+28_800_000)/86_400_000)*86_400_000-28_800_000;
    const newer={...row,id:crypto.randomUUID(),name:'new.PDF',createdAt:start,mimeType:'application/octet-stream'};
    const older={...row,id:crypto.randomUUID(),name:'old',createdAt:start-1,mimeType:'application/pdf'};
    const text={...row,id:crypto.randomUUID(),name:'report.txt',createdAt:now,mimeType:'text/plain'};
    let calls=0,lastScope:string|undefined;
    const deps={read:readWorkAsset,verify:async()=>{},list:async(_owner:unknown,_query:unknown,scope?:string)=>{lastScope=scope;return[older,text,newer];}};
    const service=createWorkResultService(orch,user,undefined,()=>true,deps,async()=>{calls++;throw Error('provider failed');});
    const today=await service('search_work_results',{query:'帮我找一下今天写的文件'});
    assert.equal(today.scope,'history');assert.equal(lastScope,undefined);assert.equal(today.status,'found');
    assert.deepEqual(today.items?.map(item=>item.id),[text.id,newer.id]);assert.equal(calls,0);
    const pdf=await service('search_work_results',{query:'最近写的pdf文件',limit:1});
    assert.equal(pdf.items?.[0].id,newer.id);assert.equal(pdf.truncated,true);assert.equal(calls,0);
    const yesterday=await service('search_work_results',{query:'',created:'yesterday',fileType:'pdf'});
    assert.deepEqual(yesterday.items?.map(item=>item.id),[older.id]);assert.equal(calls,0);
    const fallback=await service('search_work_results',{query:'今天的海边攻略PDF',scope:'history'});
    assert.equal(calls,1);assert.equal(fallback.status,'partial');assert.equal(fallback.items?.[0].id,newer.id);
    assert.equal(fallback.items?.some(item=>item.id===older.id||item.id===text.id),false);
    assert.match(fallback.spokenSummary,/不保证符合主题/);
    const noPdf=createWorkResultService(orch,user,undefined,()=>true,{...deps,list:async()=>[text]},async()=>{throw Error('must not call');});
    assert.equal((await noPdf('search_work_results',{created:'today',fileType:'pdf'})).status,'empty');
    const session=await orch.chat.createChatSession({...user,ownerUserId:user.userId,employeeId:'general',title:'scope'});
    const current=createWorkResultService(orch,user,session.id,()=>true,deps,async()=>{throw Error('must not call');});
    assert.equal((await current('search_work_results',{query:'当前对话今天写的文件'})).scope,'current');assert.equal(lastScope,session.id);
    const revoked=createWorkResultService(orch,user,undefined,()=>false,deps);
    assert.equal((await revoked('search_work_results',{created:'today',fileType:'file'})).code,'WORK_NOT_AVAILABLE');
    assert.equal((await service('search_work_results',{created:'today'},AbortSignal.abort())).code,'WORK_CANCELLED');
  }finally{await orch.close();}
});

test('UD-T2: assets and chat attachments share Word, slide and HTML extraction',async()=>{
  const orch=makeOrch(),user={...owner,userId:'unified-document-entries'};
  try{
    const fixtures:[string,Buffer,string][]=[
      ['word.docx',Buffer.from(zipSync({'word/document.xml':strToU8('<w:document><w:p><w:r><w:t>统一Word正文</w:t></w:r></w:p></w:document>')})),'统一Word正文'],
      ['slide.pptx',Buffer.from(zipSync({'ppt/slides/slide1.xml':strToU8('<a:p><a:t>统一幻灯片内容</a:t></a:p>')})),'统一幻灯片内容'],
      ['report.html',Buffer.from('<script>notSourceText()</script><main>统一HTML内容</main>'),'统一HTML内容'],
    ];
    const session=await orch.chat.createChatSession({...user,ownerUserId:user.userId,employeeId:'general',title:'统一文档入口'});
    for(const [name,bytes,expected] of fixtures){
      const asset=await storeUploadedDataAsset({name,content:bytes,auth:user});const read=await createWorkResultService(orch,user,session.id)('read_work_result',{assetId:asset.id});
      assert.equal(read.ok,true);assert.ok(read.text?.includes(expected));assert.equal(read.documentInfo?.parser,'builtin');assert.doesNotMatch(read.text||'',/notSourceText/);
      const saved=await saveChatFile(session.id,{name,bytes});const attachment=await readChatFile(session.id,saved.attachment.id);
      assert.deepEqual(attachment.bytes,bytes);assert.ok((await resolveChatFiles(session.id,[saved.attachment],expected)).context.includes(expected));
    }
  }finally{await orch.close();}
});

test('UD-T3: failed read does not dispatch; explicit work delegation copies source and preserves busy/cancel guards',async()=>{
  const user={...owner,userId:'pdf-handoff'};
  const base=createScriptedRunner(false,{delayMs:500});
  const orch=new Orchestrator({store:new MemoryStore(),runner:base,chatContextResolver:async()=>context,durableTaskSourceResolver:async(sessionId,attachments)=>Promise.all(attachments.map(async attachment=>{
    const file=await readChatFile(sessionId,attachment.id);return{attachmentId:attachment.id,name:attachment.name,mimeType:attachment.mimeType,bytes:file.bytes};
  }))});
  try{
    const session=await orch.chat.createChatSession({...user,ownerUserId:user.userId,employeeId:'general',title:'PDF读取'});
    const bytes=pdfBytes(''),asset=await storeUploadedDataAsset({name:'empty.pdf',content:bytes,auth:user});
    const bridge=new VoiceWorkBridge(orch,user,()=>true,session.id);
    const failedRead=await bridge.call('read-first','read_work_result',{assetId:asset.id}) as any;
    assert.equal(failedRead.code,'WORK_TEXT_EMPTY');assert.equal(failedRead.documentInfo.nextAction,'delegate');assert.equal(failedRead.taskId,undefined);
    assert.equal((await orch.chat.getChatSession(session.id))?.messages.length,0);
    const results=await Promise.all(['delegate-once','delegate-once'].map(id=>bridge.call(id,'start_work',{objective:'读取并逐页提取PDF正文',assetIds:[asset.id]}))) as any[];
    assert.equal(results[0].status,'accepted');assert.equal(results[0].taskId,results[1].taskId);assert.match(results[0].spokenSummary,/员工已接受/);
    assert.equal((await orch.chat.getChatSession(session.id))?.messages.filter(m=>m.role==='user').length,1);
    assert.deepEqual(await fs.readFile(path.join(workspacesRootDir(),results[0].taskId,'.task','source','empty.pdf')),bytes);
    assert.deepEqual((await readWorkAsset(asset.id,user)).content,bytes);
    const originalMessage=(await orch.chat.getChatSession(session.id))!.messages.find(m=>m.role==='user')!;
    assert.match(originalMessage.attachmentContext||'',/不得自动安装或授权/);
    const second=await storeUploadedDataAsset({name:'another.pdf',content:bytes,auth:user});
    await assert.rejects(bridge.call('delegate-busy','start_work',{objective:'处理另一文档',assetIds:[second.id]}),/已有工作/);
    assert.ok(['queued','running'].includes((await orch.chat.getRun(results[0].taskId))!.status));
    const cancel=await bridge.call('cancel-pdf','cancel_work',{taskId:results[0].taskId}) as any;assert.ok(['cancellation_requested','cancelled'].includes(cancel.status));
    const foreign=await storeUploadedDataAsset({name:'foreign.pdf',content:bytes,auth:{...user,userId:'foreign'}});
    const denied=await bridge.call('foreign-read','read_work_result',{assetId:foreign.id}) as any;assert.equal(denied.code,'WORK_NOT_AVAILABLE');assert.equal(denied.taskId,undefined);
    const raw=JSON.parse((await orch.store.get(`sessions:${session.id}`))!);raw.accessScope='org-shared';await orch.store.set(`sessions:${session.id}`,JSON.stringify(raw));
    assert.equal((await bridge.call('shared-read','read_work_result',{assetId:asset.id}) as any).code,'WORK_NOT_AVAILABLE');
  }finally{await orch.close();}
});

test('UD-T2: corrupted PDF is a unified parsing failure rather than an OCR diagnosis',async()=>{
  const orch=makeOrch();try{
    const asset=await storeUploadedDataAsset({name:'corrupt.pdf',content:Buffer.from('%PDF-1.4\nbroken'),auth:owner});
    const result=await createWorkResultService(orch,owner)('read_work_result',{assetId:asset.id});
    assert.equal(result.code,'WORK_DOCUMENT_PARSE_FAILED');assert.doesNotMatch(result.spokenSummary,/扫描PDF/);assert.equal(result.items?.[0].id,asset.id);assert.equal(result.documentInfo?.nextAction,'delegate');
  }finally{await orch.close();}
});

test('UD-T3: explicit delegated completion can be read; unavailable model does not fake acceptance',async()=>{
  const user={...owner,userId:'pdf-finish'};
  const orch=new Orchestrator({store:new MemoryStore(),runner:createScriptedRunner(),chatContextResolver:async()=>context,durableTaskSourceResolver:async(sessionId,attachments)=>Promise.all(attachments.map(async attachment=>{
    const file=await readChatFile(sessionId,attachment.id);return{attachmentId:attachment.id,name:attachment.name,mimeType:attachment.mimeType,bytes:file.bytes};
  }))});
  try{
    const asset=await storeUploadedDataAsset({name:'finish.pdf',content:pdfBytes(''),auth:user});
    const bridge=new VoiceWorkBridge(orch,user,()=>true);
    const accepted=await bridge.call('finish-work','start_work',{objective:'读取并逐页提取附件内容',assetIds:[asset.id]}) as any;assert.equal(accepted.status,'accepted');
    for(let i=0;i<100&&(await orch.chat.getRun(accepted.taskId))?.status!=='completed';i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal((await bridge.status(accepted.taskId)).status,'completed');
    const read=await bridge.call('employee-result','read_work_result',{runId:accepted.taskId}) as any;
    assert.equal(read.status,'read');assert.match(read.text,/读取并逐页提取/);assert.equal(read.items[0].conversationId,accepted.conversationId);
    const foreign=await storeUploadedDataAsset({name:'secret.txt',content:Buffer.from('private'),auth:{...user,userId:'another-owner'}});
    const before=(await orch.chat.getChatSession(accepted.conversationId))!.messages.length;
    await assert.rejects(bridge.call('foreign-delegate','start_work',{objective:'处理文档',assetIds:[foreign.id]}),/任务未启动|无访问权限/);
    assert.equal((await orch.chat.getChatSession(accepted.conversationId))!.messages.length,before);
    const invalid=await bridge.call('invalid-delegate','start_work',{objective:'处理文档',assetIds:['not-a-uuid']}) as any;assert.equal(invalid.status,'invalid');assert.equal(invalid.taskId,undefined);
    const withoutModel=new Orchestrator({store:new MemoryStore(),runner:createScriptedRunner(),chatContextResolver:async()=>null});
    try{
      await assert.rejects(new VoiceWorkBridge(withoutModel,user,()=>true).call('no-model','start_work',{objective:'读取文档',assetIds:[asset.id]}),/缺少模型/);
    }finally{await withoutModel.close();}
  }finally{await orch.close();}
});

test('WR-T7/T9: ordinary runner and voice text-model resolver use actual SDK with safe diagnostics',async()=>{
  const orch=makeOrch(),user={...owner,userId:'semantic-sdk'},previousSecrets=getSecrets();
  const asset=await storeUploadedDataAsset({name:'三亚旅行.pdf',content:pdfBytes(),auth:user});
  const models:string[]=[];
  const server=createServer(async(request,response)=>{
    let body='';for await(const chunk of request)body+=chunk;
    const input=JSON.parse(body);models.push(input.model);assert.equal(input.tools,undefined);
    response.setHeader('content-type','text/event-stream');
    response.end(`data: ${JSON.stringify({id:'work-rank',object:'chat.completion.chunk',created:1,model:input.model,choices:[{index:0,delta:{role:'assistant',content:JSON.stringify({matches:[{kind:'asset',id:asset.id,confidence:0.95}]})},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();assert.ok(address&&typeof address==='object');
    const baseUrl=`http://127.0.0.1:${address.port}/v1`;
    const session=await orch.chat.createChatSession({...user,ownerUserId:user.userId,employeeId:'general',title:'查找成果'});
    const created=await orch.chat.sendUserMessage(session.id,{content:'海边度假攻略'});
    for(let i=0;i<100&&(await orch.chat.getRun(created.runId))?.status!=='completed';i++)await new Promise(resolve=>setTimeout(resolve,10));
    let tools:ReturnType<typeof createWorkResultTools>=[];
    const runner=createWorkResultRunner(orch.store,()=>orch,()=>true,{async start(){tools=createWorkResultTools();}});
    await runner.start({...context,runId:created.runId,messages:[],model:{provider:'openai-compatible',chatModel:'run-selected-model',baseUrl,apiKey:'test'}},()=>{});
    const result=extractToolDetails(await tools[0].execute('sdk-search',{query:'海边度假攻略',scope:'history'})) as any;
    assert.equal(result.searchMode,'semantic');assert.equal(result.items[0].id,asset.id);
    applyParentSecrets({model:{providerInstances:[{id:'test',type:'openai-compatible',baseUrl,apiKey:'test'}],models:[
      {id:'voice-chat',modelId:'employee-text-model',capability:'chat',providerInstanceId:'test'},
      {id:'default-chat',modelId:'default-text-model',capability:'chat',providerInstanceId:'test'},
    ],activeChatModelId:'default-chat'}});
    await orch.store.set(`user:${user.userId}:workspace.employee-runtime-prefs`,JSON.stringify({general:{defaultModelId:'voice-chat'}}));
    const diagnostics:Record<string,unknown>[]=[];
    const voice:VoiceWorkBridge=new VoiceWorkBridge(orch,user,()=>true,session.id,()=>true,createVoiceWorkResultRanker(orch,user,()=>voice.currentConversationId,event=>diagnostics.push(event)));
    const found=await voice.call('voice-sdk-search','search_work_results',{query:'海边度假攻略',scope:'history'}) as any;
    assert.equal(found.searchMode,'semantic');assert.equal(found.items[0].id,asset.id);
    assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].event,'work_results.semantic');
    assert.equal(diagnostics[0].code,'RANKED');assert.equal(diagnostics[0].model,'employee-text-model');
    assert.equal(diagnostics[0].modelSource,'employee_text');assert.equal(diagnostics[0].conversationId,session.id);
    assert.equal(diagnostics[0].selectedCount,1);assert.ok(Number(diagnostics[0].elapsedMs)>=0);
    assert.match(String(diagnostics[0].rankId),/^[a-f0-9-]{36}$/);
    assert.doesNotMatch(JSON.stringify(diagnostics),/海边|apiKey|baseUrl|summary|private-provider-body-secret/);
    assert.equal(found.diagnostic,undefined);
    const denied=await createVoiceWorkResultRanker(orch,{...user,userId:'not-owner'},session.id,event=>diagnostics.push(event))('secret query',[found.items[0]]);
    assert.equal(denied.diagnostic?.code,'SOURCE_UNAVAILABLE');assert.equal(diagnostics.length,2);
    assert.notEqual(diagnostics[0].rankId,diagnostics[1].rankId);
    const broken={chat:{async getChatSession(){throw Error('private-config-secret');}}} as unknown as Orchestrator;
    const unavailable=await createVoiceWorkResultRanker(broken,user,session.id,event=>diagnostics.push(event))('secret query',[]);
    assert.equal(unavailable.diagnostic?.code,'MODEL_RESOLUTION_FAILED');
    assert.doesNotMatch(JSON.stringify(diagnostics),/secret query|private-config-secret/);
    const despiteLogger=await createVoiceWorkResultRanker(orch,user,session.id,()=>{throw Error('logger failed');})('海边',[found.items[0]]);
    assert.equal(despiteLogger.status,'ranked');
    await orch.store.delete(`user:${user.userId}:workspace.employee-runtime-prefs`);
    await orch.store.set('user:other:workspace.employee-runtime-prefs',JSON.stringify({general:{defaultModelId:'voice-chat'}}));
    await createVoiceWorkResultRanker(orch,user,session.id)('海边',[found.items[0]]);
    assert.deepEqual(models,['run-selected-model','employee-text-model','employee-text-model','default-text-model']);
  }finally{applyParentSecrets(previousSecrets);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await orch.close();}
});

test('WR-T7: semantic recall without keyword overlap, trusted IDs, fallback and voice integration',async()=>{
  const orch=makeOrch(),user={...owner,userId:'semantic-user'};try{
    const asset=await storeUploadedDataAsset({name:'三亚五日行程.pdf',content:pdfBytes(),auth:user});
    const alien=await storeUploadedDataAsset({name:'其他用户成果.pdf',content:pdfBytes(),auth:{...user,userId:'semantic-other'}});
    const rank:WorkResultRanker=async(query,candidates)=>{
      assert.equal(query,'海边度假攻略');assert.ok(candidates.some(item=>item.id===asset.id));assert.ok(!candidates.some(item=>item.id===alien.id));
      return{status:'ranked',matches:[{kind:'asset',id:asset.id,confidence:0.9},{kind:'asset',id:alien.id,confidence:0.99},{kind:'run',id:asset.id,confidence:0.95},{kind:'asset',id:asset.id,confidence:0.8}]};
    };
    const service=createWorkResultService(orch,user,undefined,()=>true,undefined,rank);
    const result=await service('search_work_results',{query:'海边度假攻略',scope:'history'});
    assert.equal(result.searchMode,'semantic');assert.equal(result.scope,'history');assert.deepEqual(result.items?.map(item=>item.id),[asset.id]);assert.equal(result.items?.[0].name,'三亚五日行程.pdf');
    const bridge=new VoiceWorkBridge(orch,user,()=>true,undefined,()=>true,rank);
    assert.equal((await bridge.call('semantic-voice','search_work_results',{query:'海边度假攻略',scope:'history'}) as any).items[0].id,asset.id);
    const unavailable=createWorkResultService(orch,user,undefined,()=>true,undefined,async()=>{throw Error('secret upstream response');});
    const fallback=await unavailable('search_work_results',{query:'三亚',scope:'history'});
    assert.equal(fallback.status,'partial');assert.equal(fallback.searchMode,'fallback');assert.equal(fallback.items?.[0].id,asset.id);assert.doesNotMatch(JSON.stringify(fallback),/secret upstream/);
    const noKeywords=await unavailable('search_work_results',{query:'海边度假攻略',scope:'history'});
    assert.equal(noKeywords.status,'partial');assert.equal(noKeywords.items?.[0].id,asset.id);assert.match(noKeywords.spokenSummary,/未完成语义匹配/);assert.match(noKeywords.spokenSummary,/不能据此/);assert.equal(noKeywords.code,'WORK_SEMANTIC_UNAVAILABLE');
    const forged=createWorkResultService(orch,user,undefined,()=>true,undefined,async()=>({status:'ranked',matches:[{kind:'asset',id:alien.id,confidence:0.9}]}));
    assert.equal((await forged('search_work_results',{query:'三亚',scope:'history'})).searchMode,'fallback');
    const empty=createWorkResultService(orch,user,undefined,()=>true,undefined,async()=>({status:'ranked',matches:[]}));
    const noMatch=await empty('search_work_results',{query:'北极科考',scope:'history'});assert.equal(noMatch.status,'empty');assert.equal(noMatch.searchMode,'semantic');
  }finally{await orch.close();}
});

test('WR-T7: candidate summaries, cap and source revocation during semantic ranking',async()=>{
  const orch=makeOrch(),user={...owner,userId:'semantic-private'};try{
    const asset=await storeUploadedDataAsset({name:'已归档行程.pdf',content:pdfBytes(),auth:user});
    const row=(await listWorkAssets(user,'',undefined,20))[0];
    const session=await orch.chat.createChatSession({...user,ownerUserId:user.userId,employeeId:'general',title:'旅行计划'});
    const raw=JSON.parse((await orch.store.get(`sessions:${session.id}`))!);
    raw.messages=[{id:crypto.randomUUID(),role:'user',content:'去海边休闲五天，预算5000元',runId:row.runId,createdAt:Date.now()}];
    await orch.store.set(`sessions:${session.id}`,JSON.stringify(raw));
    const abort=new AbortController();
    let revoke=false;
    const rank:WorkResultRanker=async(_query,candidates)=>{
      assert.equal(candidates.length,60);assert.ok(candidates.every(item=>(item.summary?.length||0)<=600));assert.match(candidates[0].summary||'',/预算5000/);
      if(revoke){raw.accessScope='org-shared';await orch.store.set(`sessions:${session.id}`,JSON.stringify(raw));abort.abort();}
      return{status:'ranked',matches:[{kind:'asset',id:asset.id,confidence:0.9}]};
    };
    const service=createWorkResultService(orch,user,session.id,()=>true,{read:readWorkAsset,verify:async()=>{},list:async()=>Array.from({length:70},(_,i)=>({...row,id:i?crypto.randomUUID():asset.id,name:`行程${i}.pdf`,createdAt:100-i}))},rank);
    const capped=await service('search_work_results',{query:'海滨休闲'});assert.equal(capped.searchMode,'semantic');assert.equal(capped.truncated,true);assert.equal(capped.items?.[0].id,asset.id);
    revoke=true;
    const cancelled=await service('search_work_results',{query:'海滨休闲'},abort.signal);
    assert.equal(cancelled.code,'WORK_CANCELLED');assert.equal(cancelled.items,undefined);
    raw.accessScope='private';await orch.store.set(`sessions:${session.id}`,JSON.stringify(raw));
    const revoked=createWorkResultService(orch,user,session.id,()=>true,undefined,async()=>{
      raw.accessScope='org-shared';await orch.store.set(`sessions:${session.id}`,JSON.stringify(raw));return{status:'ranked',matches:[]};
    });
    assert.equal((await revoked('search_work_results',{query:'休闲旅行'})).code,'WORK_NOT_AVAILABLE');
  }finally{await orch.close();}
});

test('WR-T6: natural filename variants and multiple keywords without unrelated matches',()=>{
  const name='上海至三亚5天旅游行程.pdf';
  for(const query of ['上海到三亚5天旅游行程','上海到三亚的五天旅游行程PDF','三亚 行程 PDF','帮我找一下之前生成的这个PDF','三亚'])assert.equal(matchesWorkResult(query,name),true,query);
  for(const query of ['北京 行程 PDF','三亚 excel','杭州西湖旅游行程','找一下'])assert.equal(matchesWorkResult(query,name),false,query);
});

test('WR-T6: legacy run-linked asset in current conversation and message-only run matches',async()=>{
  const orch=makeOrch(),user={...owner,userId:'legacy-user'};try{
    const asset=await storeUploadedDataAsset({name:'上海至三亚5天旅游行程.pdf',content:pdfBytes(),auth:user});
    const row=(await listWorkAssets(user,'',undefined,20))[0];
    const session=await orch.chat.createChatSession({...user,ownerUserId:user.userId,employeeId:'general',title:'新对话'});
    const raw=JSON.parse((await orch.store.get(`sessions:${session.id}`))!);
    raw.messages=[{id:crypto.randomUUID(),role:'assistant',content:'已经生成上海至三亚5天旅游行程.pdf',runId:row.runId,createdAt:Date.now()}];
    await orch.store.set(`sessions:${session.id}`,JSON.stringify(raw));
    const service=createWorkResultService(orch,user,session.id);
    assert.equal((await service('search_work_results',{query:'上海到三亚的五天旅游行程PDF'})).items?.[0].id,asset.id);
    assert.equal((await service('search_work_results',{query:'这个PDF'})).items?.[0].id,asset.id);
    const voice=new VoiceWorkBridge(orch,user,()=>true,session.id);
    const voiceFound=await voice.call('lookup-visible-pdf','search_work_results',{query:'三亚 行程 PDF',scope:'current'}) as {items?:Array<{id:string}>};
    assert.equal(voiceFound.items?.[0].id,asset.id);
    const unrelated=await orch.chat.createChatSession({...user,ownerUserId:user.userId,employeeId:'general',title:'其他对话'});
    assert.equal((await createWorkResultService(orch,user,unrelated.id)('search_work_results',{query:'三亚'})).items?.length,0);
    assert.equal((await listWorkAssets({...user,userId:'other'},'',session.id,501,[row.runId])).length,0);
    const created=await orch.chat.sendUserMessage(unrelated.id,{content:'我的成都游玩计划'});
    for(let i=0;i<100&&(await orch.chat.getRun(created.runId))?.status!=='completed';i++)await new Promise(resolve=>setTimeout(resolve,10));
    const found=await createWorkResultService(orch,user,unrelated.id)('search_work_results',{query:'成都'});
    assert.ok(found.items?.some(item=>item.id===created.runId));
    const empty=await service('search_work_results',{query:'不存在的北京资料'});
    assert.match(empty.spokenSummary,/当前对话/);assert.match(empty.spokenSummary,/history/);
  }finally{await orch.close();}
});

test('WR-T1/T2: owner metadata, escaped search, text read, truncation and cross-owner denial',async()=>{
  const orch=makeOrch();try{
    const asset=await storeUploadedDataAsset({name:'三亚100%_行程.md',content:Buffer.from('三亚行程'.repeat(6000)),auth:owner});
    await storeUploadedDataAsset({name:'别人的三亚.md',content:Buffer.from('private'),auth:{...owner,userId:'other'}});
    const service=createWorkResultService(orch,owner);
    const found=await service('search_work_results',{query:'100%_',scope:'history'});
    assert.equal(found.items?.length,1);assert.equal(found.items?.[0].id,asset.id);assert.equal('relativePath' in found.items![0],false);
    const read=await service('read_work_result',{assetId:asset.id});assert.equal(read.ok,true);assert.equal(read.text?.length,16000);assert.equal(read.truncated,true);
    const other=createWorkResultService(orch,{...owner,userId:'other'});
    assert.equal((await other('read_work_result',{assetId:asset.id})).code,'WORK_NOT_AVAILABLE');
    assert.equal((await createWorkResultService(orch,owner,undefined,()=>false)('search_work_results',{scope:'history'})).code,'WORK_NOT_AVAILABLE');
    assert.equal((await service('read_work_result',{assetId:'../escape'})).code,'WORK_INVALID_INPUT');
    assert.equal((await service('search_work_results',{scope:'current'})).code,'WORK_CURRENT_REQUIRED');
    assert.equal((await service('search_work_results',{scope:'history'},AbortSignal.abort())).code,'WORK_CANCELLED');
  }finally{await orch.close();}
});

test('WR-T2: real archive missing file, symlink and size protection',async()=>{
  const missing=await storeUploadedDataAsset({name:'missing.txt',content:Buffer.from('gone'),auth:owner});
  await fs.unlink(path.join(root,'assets',missing.id,missing.name));
  await assert.rejects(readWorkAsset(missing.id,owner),/WORK_FILE_MISSING/);
  const link=await storeUploadedDataAsset({name:'linked.txt',content:Buffer.from('safe'),auth:owner});
  const target=path.join(root,'assets',link.id,link.name),outside=path.join(root,'outside.txt');
  await fs.writeFile(outside,'never read');await fs.unlink(target);await fs.symlink(outside,target);
  await assert.rejects(readWorkAsset(link.id,owner),/WORK_FILE_UNSAFE/);
  const big=await storeUploadedDataAsset({name:'big.txt',content:Buffer.alloc(10*1024*1024+1,65),auth:owner});
  await assert.rejects(readWorkAsset(big.id,owner),/WORK_FILE_TOO_LARGE/);
  assert.equal((await listWorkAssets({...owner,orgId:'wrong'},'',undefined,20)).length,0);
});

test('WR-T1/T3: current conversation normal run status without UUID guessing, run read and private history',async()=>{
  const orch=makeOrch();try{
    const session=await orch.chat.createChatSession({...owner,ownerUserId:owner.userId,employeeId:'general',title:'三亚行程报告'});
    const created=await orch.chat.sendUserMessage(session.id,{content:'已有工作结果'});
    for(let i=0;i<100&&(await orch.chat.getRun(created.runId))?.status!=='completed';i++)await new Promise(resolve=>setTimeout(resolve,10));
    const bridge=new VoiceWorkBridge(orch,owner,()=>true,session.id);
    assert.equal((await bridge.call('bad','get_work_status',{taskId:'三亚旅游报告'}) as any).code,'WORK_INVALID_TASK_ID');
    assert.equal((await bridge.call('current','get_work_status',{}) as any).taskId,created.runId);
    assert.equal((await bridge.call('normal','get_work_status',{taskId:created.runId}) as any).status,'completed');
    const service=createWorkResultService(orch,owner,session.id);
    const found=await service('search_work_results',{});assert.ok(found.items?.some(item=>item.runId===created.runId));
    assert.match((await service('read_work_result',{runId:created.runId})).text||'',/已有工作结果/);
    const raw=JSON.parse((await orch.store.get(`sessions:${session.id}`))!);raw.accessScope='org-shared';await orch.store.set(`sessions:${session.id}`,JSON.stringify(raw));
    assert.equal((await service('search_work_results',{scope:'history'})).code,'WORK_NOT_AVAILABLE');
    assert.equal((await createWorkResultService(orch,{...owner,userId:'other'})('read_work_result',{runId:created.runId})).code,'WORK_NOT_AVAILABLE');
  }finally{await orch.close();}
});

function pdfBytes(message='Sanya itinerary day one'){
  const body=`BT /F1 12 Tf 40 700 Td (${message}) Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${body.length} >>\nstream\n${body}\nendstream`];
  let text='%PDF-1.4\n';const offsets=[0];objects.forEach((obj,i)=>{offsets.push(text.length);text+=`${i+1} 0 obj\n${obj}\nendobj\n`;});
  const start=text.length;text+=`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(text);
}
test('WR-T2: actual PDF extraction and unsupported format distinct from not-found',async()=>{
  const orch=makeOrch();try{
    const pdf=await storeUploadedDataAsset({name:'Sanya.pdf',content:pdfBytes(),auth:owner});
    const service=createWorkResultService(orch,owner);
    const read=await service('read_work_result',{assetId:pdf.id});assert.equal(read.ok,true);assert.match(read.text||'',/Sanya itinerary/);
    const binary=await storeUploadedDataAsset({name:'drawing.bin',content:Buffer.from('binary'),auth:owner});
    const unsupported=await service('read_work_result',{assetId:binary.id});assert.equal(unsupported.code,'WORK_UNSUPPORTED');assert.equal(unsupported.items?.[0].id,binary.id);
    const empty=await storeUploadedDataAsset({name:'empty.pdf',content:pdfBytes(''),auth:owner});
    assert.equal((await service('read_work_result',{assetId:empty.id})).code,'WORK_TEXT_EMPTY');
  }finally{await orch.close();}
});

test('WR-T1/T4: bounded search and permissions revoked during selected file read',async()=>{
  const orch=makeOrch(),user={...owner,userId:'bounded-user'};try{
    for(let i=0;i<5;i++)await storeUploadedDataAsset({name:`bounded-${i}.txt`,content:Buffer.from('text'),auth:user});
    const search=createWorkResultService(orch,user);
    const result=await search('search_work_results',{query:'bounded',scope:'history',limit:3});
    assert.equal(result.items?.length,3);assert.equal(result.truncated,true);
    assert.ok(result.items!.every((item,index)=>!index||item.createdAt<=result.items![index-1].createdAt));
    assert.equal((await search('search_work_results',{scope:'history',limit:21})).code,'WORK_INVALID_INPUT');
    const session=await orch.chat.createChatSession({...user,ownerUserId:user.userId,employeeId:'general',title:'private read'});
    const service=createWorkResultService(orch,user,session.id,()=>true,{list:listWorkAssets,verify:assertWorkAssetOwner,read:async(...args)=>{
      const loaded=await readWorkAsset(...args);
      const row=JSON.parse((await orch.store.get(`sessions:${session.id}`))!);row.accessScope='org-shared';await orch.store.set(`sessions:${session.id}`,JSON.stringify(row));return loaded;
    }});
    const denied=await service('read_work_result',{assetId:result.items![0].id});assert.equal(denied.code,'WORK_NOT_AVAILABLE');assert.equal(denied.text,undefined);
  }finally{await orch.close();}
});

test('WR-T4: production runner takes identity from persisted private run, revocation and missing-run shadow access',async()=>{
  const orch=makeOrch();try{
    const session=await orch.chat.createChatSession({...owner,ownerUserId:owner.userId,employeeId:'general',title:'runner lookup'});
    const created=await orch.chat.sendUserMessage(session.id,{content:'test'});
    for(let i=0;i<100&&(await orch.chat.getRun(created.runId))?.status!=='completed';i++)await new Promise(resolve=>setTimeout(resolve,10));
    let tools:ReturnType<typeof createWorkResultTools>=[];
    const runner=createWorkResultRunner(orch.store,()=>orch,()=>true,{async start(){tools=createWorkResultTools();}});
    const request={...context,messages:[{role:'user' as const,content:'test'}],runId:created.runId};
    await runner.start(request,()=>{});assert.equal(tools.length,2);
    const source=JSON.parse((await orch.store.get(`sessions:${session.id}`))!);source.accessScope='org-shared';await orch.store.set(`sessions:${session.id}`,JSON.stringify(source));
    const denied=await tools[0].execute('revoked',{}) as any;assert.equal(denied.details.code,'WORK_NOT_AVAILABLE');
    await runner.start(request,()=>{});assert.equal(tools.length,0);
    source.accessScope='private';await orch.store.set(`sessions:${session.id}`,JSON.stringify(source));
    await runner.start({...request,runId:crypto.randomUUID()},()=>{});assert.equal(tools.length,0);
  }finally{await orch.close();}
});
