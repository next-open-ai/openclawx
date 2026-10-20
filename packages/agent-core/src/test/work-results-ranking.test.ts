import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createWorkResultRanker} from '../work-results-ranking.js';
import {WorkLookupResultSchema,WorkResultRankingDiagnosticSchema,type ModelConfig,type WorkResultItem} from '@openclawx/contracts';

const asset:WorkResultItem={kind:'asset',id:crypto.randomUUID(),name:'三亚五日行程.pdf',createdAt:1,mimeType:'application/pdf',summary:'从上海出发，海滨休闲旅行'};
test('WR-T7/T9: actual SDK semantic ranking, safe diagnostics and invalid/unavailable fallback',async()=>{
  let output=JSON.stringify({matches:[{kind:'asset',id:asset.id,confidence:0.93},{kind:'asset',id:crypto.randomUUID(),confidence:0.99},{kind:'run',id:asset.id,confidence:0.9},{kind:'asset',id:asset.id,confidence:0.8}]});
  let payload:Record<string,unknown>={};
  let httpStatus=200,finishReason='stop';
  const server=createServer(async(request,response)=>{
    let body='';for await(const chunk of request)body+=chunk;
    payload=JSON.parse(body);
    if(httpStatus!==200){response.writeHead(httpStatus,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'private-provider-body-secret'}}));return;}
    response.setHeader('content-type','text/event-stream');
    response.end(`data: ${JSON.stringify({id:'rank',object:'chat.completion.chunk',created:1,model:'test',choices:[{index:0,delta:{role:'assistant',content:output},finish_reason:finishReason}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();assert.ok(address&&typeof address==='object');
    const model:ModelConfig={provider:'openai-compatible',chatModel:'test',baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'test',enableSearch:true};
    const rank=createWorkResultRanker(model);
    const result=await rank('找海边度假攻略',[asset]);assert.equal(result.status,'ranked');assert.deepEqual(result.matches.map(item=>item.id),[asset.id]);
    assert.equal(result.diagnostic?.code,'RANKED');assert.equal(result.diagnostic?.candidateCount,1);
    assert.equal(result.diagnostic?.model,'test');assert.equal(result.diagnostic?.provider,'openai-compatible');
    assert.equal(WorkResultRankingDiagnosticSchema.safeParse(result.diagnostic).success,true);
    assert.doesNotMatch(JSON.stringify(result.diagnostic),/三亚|海边|apiKey|summary|baseUrl/);
    assert.equal(payload.enable_search,undefined);assert.equal(payload.tools,undefined);
    assert.match(JSON.stringify(payload.messages),/海边度假攻略/);assert.match(JSON.stringify(payload.messages),/三亚五日行程/);
    assert.match(JSON.stringify(payload.messages),/Asia\/Shanghai/);assert.match(JSON.stringify(payload.messages),/application\/pdf/);
    assert.match(JSON.stringify(payload.messages),/1970-01-01T00:00:00.001Z/);
    output='not-json';assert.equal((await rank('度假',[asset])).diagnostic?.code,'INVALID_JSON');
    output='{"matches":"invalid"}';assert.equal((await rank('度假',[asset])).diagnostic?.code,'INVALID_RESPONSE');
    output=JSON.stringify({matches:[{kind:'asset',id:crypto.randomUUID(),confidence:0.95}]});assert.equal((await rank('度假',[asset])).diagnostic?.code,'INVALID_CANDIDATE');
    output=JSON.stringify({matches:[{kind:'asset',id:asset.id,confidence:0.2}]});assert.deepEqual((await rank('度假',[asset])).matches,[]);
    output='{"matches":[]}';assert.equal((await rank('无关',[asset])).diagnostic?.code,'RANKED');
    finishReason='length';assert.equal((await rank('度假',[asset])).diagnostic?.code,'OUTPUT_TRUNCATED');finishReason='stop';
    httpStatus=401;const failed=await rank('度假',[asset]);assert.equal(failed.diagnostic?.code,'PROVIDER_ERROR');
    assert.doesNotMatch(JSON.stringify(failed),/private-provider-body-secret/);httpStatus=200;
    assert.equal((await rank('度假',[asset],AbortSignal.abort())).diagnostic?.code,'CANCELLED');
    assert.equal((await createWorkResultRanker(undefined)('度假',[asset])).diagnostic?.code,'MODEL_MISSING');
    assert.equal((await createWorkResultRanker({...model,apiKey:''})('度假',[asset])).diagnostic?.code,'API_KEY_MISSING');
    assert.equal(WorkLookupResultSchema.safeParse({ok:true,status:'partial',spokenSummary:'语义不可用',searchMode:'fallback',scope:'current',items:[asset]}).success,true);
    assert.equal(WorkLookupResultSchema.safeParse({ok:true,status:'found',spokenSummary:'旧结果',items:[{...asset,summary:undefined}]}).success,true);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('WR-T7/T9: in-flight cancellation exits with CANCELLED diagnostics',async()=>{
  let received!:()=>void;const ready=new Promise<void>(resolve=>{received=resolve;});
  const server=createServer((_request,_response)=>received());
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();assert.ok(address&&typeof address==='object');
    const rank=createWorkResultRanker({provider:'openai-compatible',chatModel:'test',baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'test'});
    const abort=new AbortController();const pending=rank('度假',[asset],abort.signal);
    await ready;abort.abort();assert.equal((await pending).diagnostic?.code,'CANCELLED');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('WR-T7/T9/T10: stalled provider has a 30s TIMEOUT, not an empty semantic result',{timeout:40_000},async()=>{
  const server=createServer(()=>{});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();assert.ok(address&&typeof address==='object');
    const rank=createWorkResultRanker({provider:'openai-compatible',chatModel:'test',baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'test'});
    const start=Date.now(),result=await rank('度假',[asset]);
    assert.equal(result.status,'unavailable');assert.equal(result.diagnostic?.code,'TIMEOUT');assert.ok(Date.now()-start>=29_000);assert.ok(Date.now()-start<36_000);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
