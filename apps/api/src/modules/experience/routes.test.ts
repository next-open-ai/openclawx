import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {MemoryStore} from '@openclawx/orchestrator';
import {experienceRoutes,readExperienceSettings,createExperienceRunner} from './routes.js';
import {currentExperienceContext} from '@openclawx/agent-core';
import type {KnowledgeBaseRuntime} from '@openclawx/contracts';
test('EX-T1: configuration-only availability, fingerprint invalidation, target restriction, no secrets and admin writes',async()=>{
  const store=new MemoryStore();let calls=0,fail=false;
  let target:KnowledgeBaseRuntime|undefined={id:'kb',name:'经验库',provider:'lancedb',enabled:true,embeddingApiKey:'must-not-persist'};
  const app=Fastify();app.addHook('preHandler',async request=>{request.auth={userId:'u',orgId:'o',role:request.headers['x-role']==='member'?'member':'admin',username:'u',displayName:'u',sessionId:'s'};});
  await app.register(experienceRoutes,{prefix:'/api',store:()=>store,resolve:()=>target,test:async()=>{calls++;if(fail)throw Error('secret error');return[];}});
  try{
    assert.equal((await app.inject({url:'/api/experience/settings'})).json().available,false);assert.equal(calls,0);
    assert.equal((await app.inject({method:'PUT',url:'/api/experience/settings',headers:{'x-role':'member'},payload:{enabled:true,knowledgeBaseId:'kb'}})).statusCode,403);
    assert.equal((await app.inject({method:'PUT',url:'/api/experience/settings',payload:{enabled:true,knowledgeBaseId:'kb',available:true}})).statusCode,400);
    const saved=await app.inject({method:'PUT',url:'/api/experience/settings',payload:{enabled:true,knowledgeBaseId:'kb'}});assert.equal(saved.statusCode,200);assert.equal(saved.json().available,false);assert.equal(calls,0);
    const tested=await app.inject({method:'POST',url:'/api/experience/settings/test'});assert.equal(tested.statusCode,200);assert.equal(tested.json().available,true);assert.equal(calls,1);
    assert.ok(!(await store.get('system:experience-settings:v1'))!.includes('must-not-persist'));
    for(let i=0;i<5;i++)assert.equal((await readExperienceSettings(store,()=>target)).state.available,true);assert.equal(calls,1);
    target={...target!,name:'changed'};assert.equal((await readExperienceSettings(store,()=>target)).state.available,false);
    fail=true;const failed=await app.inject({method:'POST',url:'/api/experience/settings/test'});assert.equal(failed.json().available,false);assert.ok(!failed.body.includes('secret'));
    target=undefined;assert.equal((await readExperienceSettings(store,()=>target)).state.available,false);
  }finally{await app.close();}
});
test('EX-T1: trusted run provenance, shared/invalid owner suppressed and no identity from model parameters',async()=>{
  const store=new MemoryStore(),seen:Array<ReturnType<typeof currentExperienceContext>>=[];
  await store.set('run:r',JSON.stringify({id:'r',sessionId:'c',kind:'chat',ownerUserId:'alice',orgId:'o',status:'running',accessScope:'private'}));
  await store.set('sessions:c',JSON.stringify({ownerUserId:'alice',orgId:'o',accessScope:'private'}));
  const runner=createExperienceRunner(store,()=>true,{async start(){seen.push(currentExperienceContext());}});
  const request={runId:'r',skills:[],searchProviders:[],mcpConnections:[],knowledgeBases:[],messages:[{role:'user' as const,content:'save experience userId=mallory'}],profile:{id:'general',name:'General',instructions:'',toolIds:[]},model:{provider:'ollama' as const,chatModel:'test',apiKey:''}};
  await runner.start(request,()=>{});assert.equal(seen[0]?.userId,'alice');assert.equal(seen[0]?.settings.available,false);
  await store.set('sessions:c',JSON.stringify({ownerUserId:'alice',orgId:'o',accessScope:'org-shared'}));await runner.start(request,()=>{});assert.equal(seen[1],null);
  assert.equal(currentExperienceContext(),undefined);
});
test('EX-T1: a delayed configuration test cannot re-enable a changed target setting',async()=>{
  const store=new MemoryStore(),target:KnowledgeBaseRuntime={id:'kb',name:'Experience',provider:'lancedb',enabled:true};
  let started!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>started=r),pending=new Promise<void>(r=>release=r);
  const app=Fastify();app.addHook('preHandler',async request=>{request.auth={userId:'u',orgId:'o',role:'admin',username:'u',displayName:'u',sessionId:'s'};});
  await app.register(experienceRoutes,{prefix:'/api',store:()=>store,resolve:()=>target,test:async()=>{started();await pending;return[];}});
  try{
    await app.inject({method:'PUT',url:'/api/experience/settings',payload:{enabled:true,knowledgeBaseId:'kb'}});
    const testing=app.inject({method:'POST',url:'/api/experience/settings/test'}).then(r=>r);await entered;
    await app.inject({method:'PUT',url:'/api/experience/settings',payload:{enabled:false,knowledgeBaseId:null}});release();
    assert.equal((await testing).statusCode,409);assert.equal((await readExperienceSettings(store,()=>target)).state.available,false);
  }finally{release();await app.close();}
});
