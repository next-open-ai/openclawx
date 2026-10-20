import type {FastifyInstance} from 'fastify';
import {TemplateTaskError,type TemplateTaskService} from '@openclawx/orchestrator';
import {requireAuth} from '../auth/service.js';

/** New tasks come from an application launch or a direct description, never a legacy template picker. */
export function registerTaskCreationRoutes(app:FastifyInstance,service:TemplateTaskService){
  app.post('/task-template-definitions',async request=>{
    requireAuth(request);
    throw new TemplateTaskError('模板创建已停用，请创建任务应用',410);
  });
  app.post('/template-tasks',async(request,reply)=>{
    const owner=requireAuth(request);
    if(!request.body||typeof request.body!=='object'||(request.body as {mode?:unknown}).mode!=='direct')
      throw new TemplateTaskError('从模板创建任务已停用，请通过任务应用创建任务',410);
    return reply.code(201).send({task:await service.save(owner,request.body)});
  });
}
