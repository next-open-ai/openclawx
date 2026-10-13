import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '@workmate/orchestrator';
import {dataObjectModelSchema,structuredDataQuerySchema,dataAppSqlOperationSchema} from '@workmate/contracts';
import {createQueryAssets,explicitQuerySave} from './query-assets.js';
import type {AgentDataGateway} from './agent-query.js';
const owner={userId:'u',orgId:'o'},allow=async()=>{};
test('QA-T1: explicit save is conservative, no questions, negation, quotations or conditional examples',()=>{
  for(const text of ['保存这个查询为“月度营收”','请把刚才的查询收藏为月报','帮我保存这个SQL','好的，保存这个查询','请帮我保存这条查询','把刚才这个查询保存为月报'])assert.equal(explicitQuerySave(text),true,text);
  for(const text of ['统计月营收','查询成功了','不要保存这个查询','如何保存这个查询','如果成功就保存查询','“保存这个查询”','下面是示例：保存这个查询','保存这个查询可以吗？','保存这个查询吗','保存这个查询是什么意思','保存这个查询有意义','查询结果说：保存这个查询','保存这个查询，但是不要真的保存'])assert.equal(explicitQuerySave(text),false,text);
});
test('QA-T1: owner/session isolation, no automatic assets, durable definitions, idempotence and schema invalidation',async()=>{
  const store=new MemoryStore();
  let schema=dataObjectModelSchema.parse({id:'s',name:'营收',kind:'SQLite',storageMode:'snapshot',annotations:{},operations:['query'],resources:[{id:'t',name:'收入',sheetName:'收入',columns:[{id:'amount',name:'金额',type:'小数',nullable:false}]}]});
  const gateway:AgentDataGateway={list:async()=>[],schema:async()=>schema,query:async()=>({rows:[]})};
  const service=createQueryAssets(store,gateway),definition={kind:'structured' as const,query:structuredDataQuerySchema.parse({sourceId:'s',tableId:'t',fields:['amount']})};
  const receipt=await service.remember(owner,'session',{sourceId:'s',tableIds:['t'],question:'营收多少',definition});
  assert.deepEqual((await service.list(owner,{})).assets,[]);
  await assert.rejects(service.save(owner,'session','自动保存', {name:'月报'},allow),/明确/);
  await assert.rejects(service.save(owner,'other','保存这个查询',{name:'月报',receiptId:receipt.receiptId},allow),/回执/);
  const saved=await service.save(owner,'session','保存这个查询为月报',{name:'月报'},allow);
  assert.equal(saved.status,'execution-verified');assert.equal(saved.version,1);
  assert.equal((await service.save(owner,'session','保存这个查询',{name:'月报'},allow)).id,saved.id);
  const reopened=createQueryAssets(store,gateway);assert.equal((await reopened.list(owner,{search:'月报'})).assets.length,1);
  for(const auth of [{...owner,userId:'v'},{...owner,orgId:'x'}]){
    assert.equal((await reopened.list(auth,{})).assets.length,0);
    await assert.rejects(reopened.prepare(auth,{assetId:saved.id},allow),/无权/);
    await assert.rejects(reopened.remove(auth,saved.id),/无权/);
  }
  await assert.rejects(reopened.prepare(owner,{assetId:saved.id,parameters:{month:'2026-10'}},allow),/不支持参数/);
  assert.equal((await reopened.prepare(owner,{assetId:saved.id},allow)).asset.id,saved.id);
  schema.resources[0].columns[0].sensitive=true;
  await assert.rejects(reopened.prepare(owner,{assetId:saved.id},allow),/Schema/);
  await assert.rejects(reopened.save(owner,'session','保存这个查询',{name:'新月报'},allow),/结构/);
  assert.equal((await reopened.list(owner,{},async()=>{throw Error('revoked');})).assets.length,0);
  await reopened.remove(owner,saved.id);assert.equal((await reopened.list(owner,{})).assets.length,0);
});
test('QA-T1: SQL assets remove test/default values, no result cache, receipts bounded and expired refused',async()=>{
  const store=new MemoryStore(),schema=dataObjectModelSchema.parse({id:'s',name:'数据',kind:'SQLite',annotations:{},operations:['query'],resources:[{id:'t',name:'数据',sheetName:'数据',columns:[{id:'id',name:'ID',type:'整数',nullable:false}]}]});
  const service=createQueryAssets(store,{schema:async()=>schema,list:async()=>[],query:async()=>({})});
  const operation=dataAppSqlOperationSchema.parse({kind:'sql',operationId:'one',description:'查询',sql:'SELECT id FROM t WHERE id=:id',parameters:[{name:'id',type:'number',required:false,default:999}],testParameters:{id:888}});
  for(let i=0;i<8;i++)await service.remember(owner,'c',{sourceId:'s',tableIds:['t'],question:'查一条',definition:{kind:'sql',operation}});
  const receiptKey='query-assets:v1:o:u:receipts:c',receipts=JSON.parse((await store.get(receiptKey))!);assert.equal(receipts.length,5);
  const asset=await service.save(owner,'c','保存这个SQL',{name:'单条'},allow),json=JSON.stringify(asset.definition);
  assert.ok(!json.includes('999'));assert.ok(!json.includes('888'));assert.ok(!json.includes('rows'));assert.deepEqual(asset.definition.kind==='sql'&&asset.definition.operation.testParameters,{});
  assert.equal(asset.definition.kind==='sql'&&asset.definition.operation.parameters[0].required,true);
  receipts[0].createdAt=1;await store.set(receiptKey,JSON.stringify(receipts));
  await assert.rejects(service.save(owner,'c','保存这个SQL',{name:'过期'},allow),/回执/);
});
