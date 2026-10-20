import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {MemoryStore,TemplateTaskService,TemplateTaskError} from '@workmate/orchestrator';
import {registerTaskCreationRoutes} from './creation-routes.js';

test('TA-T7: retired template creation returns 410; direct tasks remain reusable, editable and deletable',async()=>{
 const app=Fastify(),store=new MemoryStore();
 const service=new TemplateTaskService(store,undefined,undefined,async()=>({text:'done'}));
 const owner={orgId:'task-org',userId:'alice'};
 app.addHook('preHandler',async request=>{request.auth={...owner,role:'member',username:'alice',displayName:'Alice',sessionId:'test'};});
 app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof TemplateTaskError?error.statusCode:400).send({message:error instanceof Error?error.message:'请求失败'}));
 registerTaskCreationRoutes(app,service);
 try{
  for(const url of ['/template-tasks','/task-template-definitions']){
   const response=await app.inject({method:'POST',url,payload:{name:'旧模板',templateId:'business-summary',templateVersion:'1.0.0',parameters:{}}});
   assert.equal(response.statusCode,410);assert.match(response.json().message,/停用/);
  }
  assert.equal((await service.list(owner)).length,0);
  const created=await app.inject({method:'POST',url:'/template-tasks',payload:{mode:'direct',name:'日常任务',employeeId:'general',prompt:'输出摘要'}});
  assert.equal(created.statusCode,201);const task=created.json().task;
  const first=await service.run(owner,task.id,crypto.randomUUID());
  assert.equal(first.status,'completed');assert.equal((await service.list(owner)).length,1);
  const updated=await service.save(owner,{mode:'direct',name:'修改任务',employeeId:'general',prompt:'输出详细报告',schedule:{kind:'manual'}},task.id,task.revision);
  assert.equal(updated.id,task.id);
  const second=await service.run(owner,task.id,crypto.randomUUID());
  assert.equal(second.status,'completed');assert.notEqual(first.id,second.id);
  assert.equal((await service.detail(owner,task.id)).runs.length,2);
  assert.equal((await service.detail(owner,task.id)).runs.find(run=>run.id===first.id)?.executionSnapshot?.prompt,'输出摘要');
  await service.deleteTask(owner,task.id,updated.revision);
  assert.equal((await service.list(owner)).length,0);assert.equal((await service.detail(owner,task.id)).runs.length,2);
  await assert.rejects(service.run(owner,task.id,crypto.randomUUID()),/已删除/);
 }finally{await app.close();await store.close();}
});
