import type { FastifyPluginAsync,FastifyRequest } from 'fastify';
import { TemplateTaskService, TemplateTaskError, templateAgentExecutor,reportUiHtml,reportPreviewResult } from '@workmate/orchestrator';
import { requireAuth } from '../auth/service.js';
import { getOrchestrator } from '../orchestration/routes.js';
import { ParameterProjects } from './parameter-project.js';
import {parameterSkillOptions} from './parameter-skill-options.js';
import path from 'node:path';
import os from 'node:os';
import { TaskParameterProjectOperationSchema,TaskRunListQuerySchema,TaskParameterProjectInfoSchema,TaskTemplateTrialRequestSchema,TaskTemplateDeleteSchema } from '@workmate/contracts';
import type { TaskExportFormat } from '@workmate/contracts';
import {TaskApplications} from './task-applications.js';
import {registerTaskCreationRoutes} from './creation-routes.js';

export const templateTaskRoutes: FastifyPluginAsync = async app => {
  const orch = getOrchestrator();
  const service = new TemplateTaskService(orch.store,undefined,undefined,templateAgentExecutor(orch));
  const projects = new ParameterProjects(orch, service,process.env.WORKMATE_DATA_DIR || path.join(os.homedir(),'.workmate'));
  const operation = TaskParameterProjectOperationSchema;
  const reports=new ParameterProjects(orch,service,process.env.WORKMATE_DATA_DIR||path.join(os.homedir(),'.workmate'),'report');
  const applications=new TaskApplications(orch,service,projects,error=>app.log.error(error,'任务应用执行启动失败'));
  const dataCatalog=async(request:FastifyRequest)=>{
    const response=await app.inject({method:'GET',url:'/api/data/gateway/units',headers:{...(request.headers.authorization?{authorization:request.headers.authorization}:{}),...(request.headers.cookie?{cookie:request.headers.cookie}:{})}});
    const catalog=response.statusCode===200?response.json():{units:[],notice:'目录读取失败，运行时使用 units 接口重试'};
    if(JSON.stringify(catalog).length>128000)throw new TemplateTaskError('数据目录超过128KB，请先整理数据单元');
    return catalog;
  };
  app.get('/task-applications',async request=>({applications:await applications.list(requireAuth(request))}));
  app.post('/task-applications',async(request,reply)=>{const owner=requireAuth(request);return reply.code(201).send(await applications.create(owner,request.body,await dataCatalog(request)));});
  app.post<{Params:{id:string}}>('/task-applications/:id/launch',async(request,reply)=>reply.code(202).send(await applications.launch(requireAuth(request),request.params.id,request.body)));
  app.get<{Params:{id:string}}>('/task-report-projects/:id',async request=>reports.info(requireAuth(request),request.params.id));
  app.get<{Params:{id:string}}>('/task-report-projects/:id/preview',async request=>reports.previewReport(requireAuth(request),request.params.id));
  app.post<{Params:{id:string}}>('/task-template-definitions/:id/report-project',async request=>{const input=operation.parse(request.body);return reports.open(requireAuth(request),request.params.id,input.revision,input.employeeId);});
  app.post<{Params:{id:string}}>('/task-template-definitions/:id/import-report-ui',async request=>{const input=operation.parse(request.body);return {definition:await reports.import(requireAuth(request),request.params.id,input.revision)};});
  app.get<{Params:{id:string}}>('/task-parameter-projects/:id',async request=>{const owner=requireAuth(request),info=await projects.info(owner,request.params.id);if(info.definitionId)return info;const report=await reports.info(owner,request.params.id);return TaskParameterProjectInfoSchema.parse(report.definitionId?{...report,kind:'report'}:info);});
  app.get<{Params:{id:string}}>('/task-parameter-projects/:id/preview',async request=>projects.preview(requireAuth(request),request.params.id));
  app.post<{Params:{id:string}}>('/task-template-definitions/:id/parameter-project',async request=>{const input=operation.parse(request.body),owner=requireAuth(request);return projects.open(owner,request.params.id,input.revision,input.employeeId,await dataCatalog(request));});
  app.post<{Params:{id:string}}>('/task-template-definitions/:id/import-parameter-ui',async request => {const input=operation.parse(request.body);return {definition:await projects.import(requireAuth(request),request.params.id,input.revision)}});
  app.post<{Params:{id:string};Body:{version:string;parameters:unknown}}>('/task-templates/:id/validate-parameters',async request => ({parameters:await service.validateParameters(requireAuth(request),request.params.id,request.body?.version,request.body?.parameters)}));
  await service.recoverInterrupted(error=>app.log.error(error,'恢复任务观察失败'));
  let scheduler:ReturnType<typeof setInterval>|undefined;
  const tick=()=>void service.tickScheduled().catch(error=>app.log.error(error,'任务定时调度失败'));
  app.addHook('onReady',async()=>{scheduler=setInterval(tick,15_000);scheduler.unref();tick();});
  app.addHook('onClose',async()=>{if(scheduler)clearInterval(scheduler);});
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof TemplateTaskError ? error.statusCode : error instanceof Error && error.name === 'ZodError' ? 400 : 500;
    if (status === 500) app.log.error(error);
    reply.code(status).send({ ...(error instanceof TemplateTaskError ? error.problem : undefined),message: status === 500 ? '任务服务暂时不可用，请重试' : (error as Error).message });
  });
  app.get('/task-templates', async request => ({ templates: await service.listTemplates(requireAuth(request)) }));
  app.get('/skills/list',async request=>parameterSkillOptions(orch.store,requireAuth(request)));
  app.get('/task-template-skills', async () => ({ skills: service.descriptors() }));
  app.get<{ Params: { id: string }; Querystring: { version: string } }>('/task-template-skills/:id/input', async request => ({ html: service.skillInput(request.params.id, request.query.version) }));
  app.get('/task-template-definitions', async request => ({ definitions: await service.definitions(requireAuth(request)) }));
  app.delete<{Params:{id:string}}>('/task-template-definitions/:id',async request=>{
    const owner=requireAuth(request),input=TaskTemplateDeleteSchema.parse(request.body);
    await service.deleteDefinition(owner,request.params.id,input.revision);return {deleted:true};
  });
  registerTaskCreationRoutes(app,service);
  app.get<{ Params: { id: string } }>('/task-template-definitions/:id', async request => ({ definition: await service.definition(requireAuth(request), request.params.id) }));
  app.put<{ Params: { id: string }; Body: { revision: number; configuration: unknown } }>('/task-template-definitions/:id', async request => ({
    definition: await service.saveDefinition(requireAuth(request), request.body?.configuration, request.params.id, request.body?.revision),
  }));
  app.get<{ Params: { id: string } }>('/task-template-definitions/:id/input', async request => service.previewInput(requireAuth(request), request.params.id));
  app.get<{Params:{id:string}}>('/task-template-definitions/:id/report',async request=>{const record=await service.definition(requireAuth(request),request.params.id);return {html:reportUiHtml(record.draft.reportUi,reportPreviewResult)};});
  app.post<{ Params: { id: string } }>('/task-template-definitions/:id/trial', async request => {const input=TaskTemplateTrialRequestSchema.parse(request.body);return service.trial(requireAuth(request),request.params.id,input.revision,input.parameters);});
  app.post<{ Params: { id: string }; Body: { revision: number } }>('/task-template-definitions/:id/publish', async request => ({ definition: await service.publish(requireAuth(request), request.params.id, request.body?.revision) }));
  app.post<{ Params: { id: string }; Body: { revision: number; archived: boolean } }>('/task-template-definitions/:id/archive', async request => {
    if (typeof request.body?.archived !== 'boolean') throw new TemplateTaskError('停用状态必须为布尔值');
    return { definition: await service.archive(requireAuth(request), request.params.id, request.body.revision, request.body.archived) };
  });
  app.get<{ Params: { id: string }; Querystring: { version: string } }>('/task-templates/:id', async request => ({ template: await service.template(request.params.id, request.query.version, requireAuth(request)) }));
  app.get<{ Params: { id: string }; Querystring: { version: string } }>('/task-templates/:id/input', async request => {
    return { html: await service.inputView(request.params.id, request.query.version, requireAuth(request)) };
  });
  app.get('/template-tasks', async request => ({ tasks: await service.list(requireAuth(request)) }));
  app.delete<{ Params: { id: string } }>('/template-tasks/:id', async request => {
    const owner = requireAuth(request), input = TaskTemplateDeleteSchema.parse(request.body);
    await service.deleteTask(owner, request.params.id, input.revision);
    return { deleted: true };
  });
  app.get('/task-runs',async request=>{
    const query=TaskRunListQuerySchema.parse(request.query);
    const records=(await service.runs(requireAuth(request))).filter(item=>(!query.status||item.run.status===query.status)&&(!query.search||item.taskName.toLowerCase().includes(query.search.toLowerCase())));
    const end=query.offset+query.limit;
    return {records:records.slice(query.offset,end),total:records.length,nextOffset:end<records.length?end:null};
  });
  app.get<{Params:{taskId:string;runId:string}}>('/task-runs/:taskId/:runId/json-result',async(request,reply)=>{
    const {runs}=await service.detail(requireAuth(request),request.params.taskId);
    const run=runs.find(item=>item.id===request.params.runId);
    if(!run)throw new TemplateTaskError('运行记录不存在',404);
    return reply.type('application/json').header('Content-Disposition',`attachment; filename="json-result.json"`).send(JSON.stringify(run.jsonResult,null,2));
  });
  app.get<{ Params: { id: string } }>('/template-tasks/:id', async request => service.detail(requireAuth(request), request.params.id));
  app.put<{Params:{id:string}}>('/template-tasks/:id/schedule',async request=>({task:await service.updateSchedule(requireAuth(request),request.params.id,request.body)}));
  app.put<{ Params: { id: string }; Body: { revision: number; input: unknown } }>('/template-tasks/:id', async request => {
    return { task: await service.save(requireAuth(request), request.body?.input, request.params.id, request.body?.revision) };
  });
  app.post<{ Params: { id: string }; Body: { requestId: string } }>('/template-tasks/:id/runs', async request => {
    const requestId = request.body?.requestId;
    if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(requestId)) throw new TemplateTaskError('需要有效的运行请求 ID');
    return { run: await service.run(requireAuth(request), request.params.id, requestId) };
  });
  app.get<{ Params: { id: string; runId: string } }>('/template-tasks/:id/runs/:runId/result', async request => {
    const result = await service.result(requireAuth(request), request.params.id, request.params.runId);
    return { result, ...service.render(result) };
  });
  app.get<{ Params: { id: string; runId: string }; Querystring: { format: string } }>('/template-tasks/:id/runs/:runId/export', async (request, reply) => {
    const format = request.query.format;
    if (!['json', 'html', 'csv'].includes(format)) throw new TemplateTaskError('不支持的导出格式');
    const exported = await service.exportResult(requireAuth(request), request.params.id, request.params.runId, format as TaskExportFormat);
    return reply.type(exported.mime).header('Content-Disposition', `attachment; filename="${exported.name}"`).send(exported.content);
  });
};
