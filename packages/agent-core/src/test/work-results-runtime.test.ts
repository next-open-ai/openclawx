import test from 'node:test';
import assert from 'node:assert/strict';
import {withWorkResultAccess,createWorkResultTools} from '../work-results-runtime.js';
import {extractToolDetails} from '../pi-tools.js';
import {prepareAgentscopeHostTools} from '../agentscope/host-tools.js';
test('WR-T4: shared tools validate ID and isolate captured run executor',async()=>{
  assert.equal(createWorkResultTools().length,0);
  const a=withWorkResultAccess(async()=>({owner:'a'}),()=>createWorkResultTools());
  const b=withWorkResultAccess(async()=>({owner:'b'}),()=>createWorkResultTools());
  const result=await Promise.all([a[0].execute('a',{}),b[0].execute('b',{})]);
  assert.deepEqual(result.map(extractToolDetails),[{owner:'a'},{owner:'b'}]);
  assert.equal((extractToolDetails(await a[1].execute('invalid',{assetId:'../../file'})) as any).code,'WORK_INVALID_INPUT');
  assert.equal(withWorkResultAccess(undefined,()=>createWorkResultTools()).length,0);
  assert.equal((extractToolDetails(await a[0].execute('abort',{},AbortSignal.abort())) as any).code,'WORK_CANCELLED');
  const host=await withWorkResultAccess(async()=>({ok:true}),()=>prepareAgentscopeHostTools({runId:'work-lookup',mcpConnections:[]}));
  try{assert.ok(host.runtimePatch.mcpTools?.some(item=>item.name==='search_work_results'));assert.ok(host.runtimePatch.mcpTools?.some(item=>item.name==='read_work_result'));}finally{await host.close();}
});
