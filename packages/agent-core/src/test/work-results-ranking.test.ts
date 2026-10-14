import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createWorkResultRanker} from '../work-results-ranking.js';
import {WorkLookupResultSchema,type ModelConfig,type WorkResultItem} from '@workmate/contracts';

const asset:WorkResultItem={kind:'asset',id:crypto.randomUUID(),name:'三亚五日行程.pdf',createdAt:1,summary:'从上海出发，海滨休闲旅行'};
test('WR-T7: actual SDK semantic ranking, candidate ID filtering and invalid/unavailable fallback',async()=>{
  let output=JSON.stringify({matches:[{kind:'asset',id:asset.id,confidence:0.93},{kind:'asset',id:crypto.randomUUID(),confidence:0.99},{kind:'run',id:asset.id,confidence:0.9},{kind:'asset',id:asset.id,confidence:0.8}]});
  let payload:Record<string,unknown>={};
  const server=createServer(async(request,response)=>{
    let body='';for await(const chunk of request)body+=chunk;
    payload=JSON.parse(body);response.setHeader('content-type','text/event-stream');
    response.end(`data: ${JSON.stringify({id:'rank',object:'chat.completion.chunk',created:1,model:'test',choices:[{index:0,delta:{role:'assistant',content:output},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();assert.ok(address&&typeof address==='object');
    const model:ModelConfig={provider:'openai-compatible',chatModel:'test',baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'test',enableSearch:true};
    const rank=createWorkResultRanker(model);
    const result=await rank('找海边度假攻略',[asset]);assert.equal(result.status,'ranked');assert.deepEqual(result.matches.map(item=>item.id),[asset.id]);
    assert.equal(payload.enable_search,undefined);assert.equal(payload.tools,undefined);
    assert.match(JSON.stringify(payload.messages),/海边度假攻略/);assert.match(JSON.stringify(payload.messages),/三亚五日行程/);
    output='not-json';assert.equal((await rank('度假',[asset])).status,'unavailable');
    output=JSON.stringify({matches:[{kind:'asset',id:crypto.randomUUID(),confidence:0.95}]});assert.equal((await rank('度假',[asset])).status,'unavailable');
    output=JSON.stringify({matches:[{kind:'asset',id:asset.id,confidence:0.2}]});assert.deepEqual((await rank('度假',[asset])).matches,[]);
    output='{"matches":[]}';assert.equal((await rank('无关',[asset])).status,'ranked');
    assert.equal((await rank('度假',[asset],AbortSignal.abort())).status,'unavailable');
    assert.equal((await createWorkResultRanker(undefined)('度假',[asset])).status,'unavailable');
    assert.equal(WorkLookupResultSchema.safeParse({ok:true,status:'partial',spokenSummary:'语义不可用',searchMode:'fallback',scope:'current',items:[asset]}).success,true);
    assert.equal(WorkLookupResultSchema.safeParse({ok:true,status:'found',spokenSummary:'旧结果',items:[{...asset,summary:undefined}]}).success,true);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('WR-T7: in-flight cancellation exits without returning a semantic match',async()=>{
  let received!:()=>void;const ready=new Promise<void>(resolve=>{received=resolve;});
  const server=createServer((_request,_response)=>received());
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();assert.ok(address&&typeof address==='object');
    const rank=createWorkResultRanker({provider:'openai-compatible',chatModel:'test',baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'test'});
    const abort=new AbortController();const pending=rank('度假',[asset],abort.signal);
    await ready;abort.abort();assert.equal((await pending).status,'unavailable');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('WR-T7: stalled provider has a bounded deadline, not an empty semantic result',{timeout:20_000},async()=>{
  const server=createServer(()=>{});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();assert.ok(address&&typeof address==='object');
    const rank=createWorkResultRanker({provider:'openai-compatible',chatModel:'test',baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'test'});
    const start=Date.now(),result=await rank('度假',[asset]);
    assert.equal(result.status,'unavailable');assert.ok(Date.now()-start<16_000);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
