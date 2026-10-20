import { randomUUID } from 'node:crypto';
import { TemplateTaskInputSchema, TaskTemplateConfigurationSchema, TaskPresentationSchema, TaskDeliverySchema, type TaskTemplateDefinition, type TaskTemplateTrial, type TaskSkillDescriptor, type TaskExportFormat, type TaskPresentation, type TaskTemplate, type TemplateTask, type TemplateTaskDetail, type TemplateTaskRun, type TaskResult } from '@openclawx/contracts';
import { validateParameterUi, parameterUiHtml } from './task-parameter-ui.js';
import {validateReportUi,reportUiHtml} from './task-report-ui.js';
import type { KeyValueStore } from './storage/kv.js';
import {nextTaskSchedule} from './task-schedule.js';
import { withKeyLock } from './lock.js';
import { businessSummarySkill, businessSummaryTemplate } from './task-skills/business-summary/index.js';
import {DirectTaskInputSchema,TaskResultOutputSchema,TaskRunJsonResultSchema,TaskScheduleUpdateSchema,parameterValidationMessage,taskExecutionInputProblem,type TaskTemplateProblem,type TaskRunListItem} from '@openclawx/contracts';

const DIRECT_ID='__direct-agent__';
function directTemplate(task: {name:string;employeeId?:string;prompt?:string}): TaskTemplate {
  return {...structuredClone(businessSummaryTemplate),id:DIRECT_ID,version:'1',name:task.name,
    resultType:'agent-task',resultVersion:'1.0',agent:{employeeId:task.employeeId!,prompt:task.prompt!},defaults:{}};
}
export function taskRunJsonResult(run:TemplateTaskRun) {
  return TaskRunJsonResultSchema.parse({schemaVersion:'1.0',kind:'json-result',taskId:run.taskId,runId:run.id,taskRevision:run.taskRevision,status:run.status,agentStatus:run.agentStatus,
    trigger:run.trigger??'manual',scheduledFor:run.scheduledFor,
    input:{parameters:run.inputSnapshot,prompt:run.executionSnapshot?.prompt??run.template.agent?.prompt??'',employeeId:run.executionSnapshot?.employeeId??run.template.agent?.employeeId},
    output:run.executionSnapshot?.resultOutput??TaskResultOutputSchema.parse({}),data:run.result?.data??null,error:run.error??null,startedAt:run.startedAt,finishedAt:run.finishedAt});
}

export class TemplateTaskError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly problem?:TaskTemplateProblem) { super(message); }
}
type AgentLink=(sessionId:string,runId:string,status?:TemplateTaskRun['agentStatus'])=>Promise<void>;
export type TemplateAgentExecutor = ((owner: TaskOwner, template: TaskTemplate, parameters: Record<string, unknown>, prompt: string, link: AgentLink) => Promise<Record<string, unknown>>)&{resume?:(owner:TaskOwner,run:TemplateTaskRun,link:AgentLink)=>Promise<Record<string,unknown>>};
export interface TaskOwner { orgId: string; userId: string }
export interface TaskSkillRuntime {
  id: string; version: string; inputHtml: string; descriptor?: TaskSkillDescriptor;
  prepare(input: unknown): Record<string, unknown>;
  execute(input: unknown): Record<string, unknown> | Promise<Record<string, unknown>>;
  format(input: unknown): Record<string, unknown>;
  report(input: unknown, options?: TaskPresentation): string;
  exportCsv?(input: unknown): string;
}

/** Server-owned pilot. Only compiled, explicitly registered Skill entries can run. */
export class TemplateTaskService {
  private scheduling=false;
  private recovering=new Set<string>();
  constructor(private readonly store: KeyValueStore,
    private readonly skills: TaskSkillRuntime[] = [businessSummarySkill],
    private readonly templates: TaskTemplate[] = [businessSummaryTemplate],
    private readonly executeAgent?: TemplateAgentExecutor) {}

  async listTemplates(owner?: TaskOwner) {
    const custom = owner ? (await this.definitions(owner)).filter(item => !item.archived && item.published.length).map(item => item.published.at(-1)!) : [];
    return structuredClone([...this.templates, ...custom]);
  }
  descriptors(): TaskSkillDescriptor[] { return this.skills.flatMap(skill => skill.descriptor ? [structuredClone(skill.descriptor)] : []); }
  skillInput(id: string, version: string) { return this.skill({ skillId: id, version, entry: 'prepare' }, 'prepare').inputHtml; }
  private definitionPrefix(owner: TaskOwner) { return `task-template-definitions:${encodeURIComponent(owner.orgId)}:${encodeURIComponent(owner.userId)}:`; }
  private definitionKey(owner: TaskOwner, id: string) { return this.definitionPrefix(owner) + encodeURIComponent(id); }
  async definitions(owner: TaskOwner): Promise<TaskTemplateDefinition[]> {
    const keys = await this.store.keys(this.definitionPrefix(owner));
    const records = await Promise.all(keys.map(async key => JSON.parse((await this.store.get(key))!) as TaskTemplateDefinition));
    return records.filter(item=>!item.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async definition(owner: TaskOwner, id: string): Promise<TaskTemplateDefinition> {
    return this.readDefinition(owner,id);
  }
  private async readDefinition(owner:TaskOwner,id:string,includeDeleted=false):Promise<TaskTemplateDefinition> {
    const raw = await this.store.get(this.definitionKey(owner, id));
    if (!raw) throw new TemplateTaskError('模板不存在', 404);
    const record:TaskTemplateDefinition=JSON.parse(raw);
    if(record.deletedAt&&!includeDeleted)throw new TemplateTaskError('模板已删除',404);
    return record;
  }
  async deleteDefinition(owner:TaskOwner,id:string,revision:number) {
    return withKeyLock(this.definitionKey(owner,id),async()=>{
      const record=await this.definition(owner,id);
      if(record.revision!==revision)throw new TemplateTaskError('模板已更新，请刷新后再删除',409);
      record.deletedAt=Date.now();record.updatedAt=record.deletedAt;record.revision++;
      delete record.verifiedRevision;delete record.verifiedAt;
      await this.store.set(this.definitionKey(owner,id),JSON.stringify(record));await this.store.flush();
    });
  }
  async saveDefinition(owner: TaskOwner, value: unknown, id?: string, revision?: number): Promise<TaskTemplateDefinition> {
    const config = TaskTemplateConfigurationSchema.parse(value);
    if(config.reportUi){try{validateReportUi(config.reportUi);}catch(cause){throw new TemplateTaskError(cause instanceof Error?cause.message:'任务报告无效');}}
    if (config.parameterUi) {try {validateParameterUi(config.parameterUi);}catch(cause){throw new TemplateTaskError(cause instanceof Error?cause.message:'参数 UI 无效');}}
    const templateId = id ?? randomUUID();
    return withKeyLock(this.definitionKey(owner, templateId), async () => {
      const previous = id ? await this.definition(owner, id) : undefined;
      if (previous && previous.revision !== revision) throw new TemplateTaskError('模板已更新，请重新打开后编辑', 409);
      const record: TaskTemplateDefinition = {
        id: templateId, orgId: owner.orgId, ownerUserId: owner.userId,
        revision: (previous?.revision ?? 0) + 1,
        draft: { ...config, id: templateId, version: `1.0.${previous?.published.length ?? 0}` },
        parameterProjectId: previous?.parameterProjectId,
        reportProjectId:previous?.reportProjectId,
        published: previous?.published ?? [], archived: previous?.archived ?? false,
        createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now(),
      };
      await this.store.set(this.definitionKey(owner, templateId), JSON.stringify(record)); await this.store.flush();
      return record;
    });
  }
  async linkParameterProject(owner: TaskOwner, id: string, revision: number, create: (record: TaskTemplateDefinition) => Promise<string>) {
    return this.linkUiProject(owner,id,revision,'parameterProjectId',create);
  }
  async linkReportProject(owner:TaskOwner,id:string,revision:number,create:(record:TaskTemplateDefinition)=>Promise<string>) {
    return this.linkUiProject(owner,id,revision,'reportProjectId',create);
  }
  private async linkUiProject(owner:TaskOwner,id:string,revision:number,key:'parameterProjectId'|'reportProjectId',create:(record:TaskTemplateDefinition)=>Promise<string>) {
    return withKeyLock(this.definitionKey(owner,id), async () => {
      const record = await this.definition(owner,id);
      if (record.revision !== revision) throw new TemplateTaskError("模板已更新，请重新打开",409);
      if (!record[key]) { record[key] = await create(record); await this.store.set(this.definitionKey(owner,id),JSON.stringify(record)); await this.store.flush(); }
      return record[key]!;
    });
  }
  private prepare(template: TaskTemplate, parameters: unknown, purpose: 'defaults' | 'test' = 'defaults'): Record<string, unknown> {
    let checked = parameters;
    if (template.parameterUi) {
      const parsed = validateParameterUi(template.parameterUi).safeParse(parameters);
      if (!parsed.success) throw new TemplateTaskError(parameterValidationMessage(parsed.error, JSON.parse(template.parameterUi.files['input.schema.json']), purpose));
      checked = parsed.data;
    }
    if (template.agent) {
      if (!checked || typeof checked !== 'object' || Array.isArray(checked)) throw new TemplateTaskError('任务参数必须为 JSON 对象');
      return checked as Record<string, unknown>;
    }
    const input=this.skill(template.input,"prepare");
    try {return input.prepare(checked);}
    catch(cause){
      const problem=taskExecutionInputProblem(cause,input.descriptor?.name??input.id,!!template.parameterUi);
      if(problem)throw new TemplateTaskError(problem.message,400,problem);
      throw cause;
    }
  }
  private validateTemplate(template: TaskTemplate) {
    if(template.reportUi)validateReportUi(template.reportUi);
    if (template.parameterUi) validateParameterUi(template.parameterUi);
    if (template.agent) return;
    const input = this.skill(template.input, 'prepare').descriptor;
    const execution = this.skill(template.execution, 'execute').descriptor;
    const output = this.skill(template.output, 'format').descriptor;
    const view = this.skill(template.view, 'report').descriptor;
    if (!input || !execution || !output || !view) throw new TemplateTaskError('能力缺少可配置的输入输出声明');
    if (input.inputType !== execution.inputType || execution.resultType !== output.resultType
      || execution.resultVersion !== output.resultVersion || output.resultType !== view.resultType
      || output.resultVersion !== view.resultVersion || template.resultType !== output.resultType
      || template.resultVersion !== output.resultVersion) throw new TemplateTaskError('输入、执行、输出与展示的数据类型或版本不兼容');
    const delivery = TaskDeliverySchema.parse(template.delivery ?? {});
    if (delivery.exports.some(format => !output.exports.includes(format))) throw new TemplateTaskError('输出 Skill 不支持所选导出格式');
  }
  async previewInput(owner: TaskOwner, id: string): Promise<{ html: string; parameters: Record<string, unknown> }> {
    const record = await this.definition(owner, id);
    return { html: this.templateInputHtml(record.draft), parameters: record.draft.defaults ?? {} };
  }
  async trial(owner: TaskOwner, id: string, revision: number, parameters?: Record<string,unknown>): Promise<TaskTemplateTrial> {
    return withKeyLock(this.definitionKey(owner, id), async () => {
      const record = await this.definition(owner, id);
      if (record.revision !== revision) throw new TemplateTaskError('模板已更新，请重新打开后试运行', 409);
      delete record.verifiedRevision; delete record.verifiedAt;
      await this.store.set(this.definitionKey(owner, id), JSON.stringify(record)); await this.store.flush();
      const template = record.draft;
      this.validateTemplate(template);
      const input = this.prepare(template, parameters ?? template.defaults ?? {}, parameters === undefined ? 'defaults' : 'test');
      if (template.agent) {
        record.verifiedRevision = revision; record.verifiedAt = Date.now();
        await this.store.set(this.definitionKey(owner,id), JSON.stringify(record)); await this.store.flush();
        return {revision, mode:'configuration', data: input, html: '<p>配置验证通过，尚未实际运行智能体。发布后请创建任务并运行，在任务运行记录中查看真实结果。</p>', checks: [...(template.parameterUi?['参数 UI 文件与资源校验通过','测试参数通过 Schema 校验']:['未定制参数界面，使用已有默认参数或空参数']),'智能体执行配置有效（未调用模型或工具）',template.reportUi?'任务报告资源与脚本语法校验通过':'使用默认任务报告界面','结果保存在任务运行记录（含 json-result）']};
      }
      const raw = await this.skill(template.execution, 'execute').execute(input);
      const data = this.skill(template.output, 'format').format(raw);
      const html = template.reportUi?reportUiHtml(template.reportUi,{title:template.name,data,preview:true}):this.skill(template.view, 'report').report(data, TaskPresentationSchema.parse(template.presentation ?? {}));
      for (const format of template.delivery?.exports ?? ['json']) {
        if (format === 'csv') {
          const outputSkill = this.skill(template.output, 'format');
          if (!outputSkill.exportCsv) throw new TemplateTaskError('输出 Skill 没有 CSV 导出入口');
          outputSkill.exportCsv(data);
        }
      }
      record.verifiedRevision = revision; record.verifiedAt = Date.now();
      await this.store.set(this.definitionKey(owner, id), JSON.stringify(record)); await this.store.flush();
      return { revision, mode:'execution', data, html, checks: ['Skill 入口与版本有效', '输入输出契约兼容', '测试参数校验通过', '执行与结果格式化通过', '报告渲染与导出能力通过'] };
    });
  }
  async publish(owner: TaskOwner, id: string, revision: number): Promise<TaskTemplateDefinition> {
    return withKeyLock(this.definitionKey(owner, id), async () => {
      const record = await this.definition(owner, id);
      if (record.revision !== revision) throw new TemplateTaskError('模板已更新，请重新打开后发布', 409);
      if (record.archived) throw new TemplateTaskError('请先恢复已停用的模板');
      if (record.verifiedRevision !== revision) throw new TemplateTaskError(record.draft.agent ? '请先对当前草稿完成配置验证' : '请先对当前草稿完成试运行');
      this.validateTemplate(record.draft);
      if (!record.published.some(item => item.version === record.draft.version)) record.published.push(structuredClone(record.draft));
      record.updatedAt = Date.now();
      await this.store.set(this.definitionKey(owner, id), JSON.stringify(record)); await this.store.flush();
      return record;
    });
  }
  async archive(owner: TaskOwner, id: string, revision: number, archived: boolean) {
    return withKeyLock(this.definitionKey(owner, id), async () => {
      const record = await this.definition(owner, id);
      if (record.revision !== revision) throw new TemplateTaskError('模板已更新，请刷新后重试', 409);
      record.archived = archived; record.revision++; delete record.verifiedRevision; delete record.verifiedAt;
      record.updatedAt = Date.now();
      await this.store.set(this.definitionKey(owner, id), JSON.stringify(record)); await this.store.flush();
      return record;
    });
  }
  /** Restore observation of a persisted Agent turn, never replay its message/Skill. */
  async recoverInterrupted(onError:(error:unknown)=>void=()=>{}) {
    for(const key of await this.store.keys('template-runs:')){
      const run=JSON.parse((await this.store.get(key))!) as TemplateTaskRun;
      if(run.status!=='running'||this.recovering.has(key))continue;
      if(run.template.agent&&run.sessionId&&run.agentRunId&&this.executeAgent?.resume){
        const taskKeys=await this.store.keys('template-tasks:');
        let owner:TaskOwner|undefined;
        for(const taskKey of taskKeys){const task=JSON.parse((await this.store.get(taskKey))!) as TemplateTask;if(task.id===run.taskId&&key.startsWith(this.runPrefix({orgId:task.orgId,userId:task.ownerUserId},task.id))){owner={orgId:task.orgId,userId:task.ownerUserId};break;}}
        if(owner){
          this.recovering.add(key);const captured=owner;
          void withKeyLock(key,()=>withKeyLock(`task-execution:${this.key(captured,run.taskId)}`,async()=>{
            const latest=JSON.parse((await this.store.get(key))!) as TemplateTaskRun;if(latest.status!=='running')return;
            const persist=async()=>{latest.jsonResult=taskRunJsonResult(latest);await this.store.set(key,JSON.stringify(latest));await this.store.flush();};
            try{const output=await this.executeAgent!.resume!(captured,latest,async(sessionId,runId,status)=>{latest.sessionId=sessionId;latest.agentRunId=runId;latest.agentStatus=status;await persist();});this.assignResult(latest,output,latest.taskName??latest.template.name);}
            catch(error){latest.status='failed';latest.error=error instanceof Error?error.message:'恢复跟踪失败';latest.steps.push({stage:'execution',status:'failed',at:Date.now()});}
            delete latest.agentStatus;latest.finishedAt=Date.now();await persist();
          })).catch(onError).finally(()=>this.recovering.delete(key));
          continue;
        }
      }
      run.status='failed';run.finishedAt=Date.now();run.error='服务重启，上次执行中断，请重新运行';delete run.agentStatus;
      run.jsonResult=taskRunJsonResult(run);await this.store.set(key,JSON.stringify(run));
    }
    await this.store.flush();
  }
  private assignResult(run:TemplateTaskRun,output:Record<string,unknown>,title:string){
    const template=run.template;
    const data=template.agent?output:this.skill(template.output,'format').format(output);
    run.result={id:randomUUID(),taskId:run.taskId,runId:run.id,type:template.agent?'agent-task':template.resultType,schemaVersion:template.agent?'1.0':template.resultVersion,title,data,view:structuredClone(template.view),createdAt:Date.now(),presentation:TaskPresentationSchema.parse(template.presentation??{}),reportUi:template.reportUi?structuredClone(template.reportUi):undefined,delivery:template.agent?{storage:'task-results',exports:['json']}:TaskDeliverySchema.parse(template.delivery??{})};
    if(!run.steps.some(step=>step.stage==='execution'&&step.status==='completed'))run.steps.push({stage:'execution',status:'completed',at:Date.now()});
    run.steps=run.steps.filter(step=>step.stage!=='output');run.steps.push({stage:'output',status:'completed',at:Date.now()});run.status='completed';
  }
  async template(id: string, version: string, owner?: TaskOwner) {
    const builtin = this.templates.find(item => item.id === id && item.version === version);
    const template = builtin ?? (owner && !this.templates.some(item => item.id === id) ? (await this.readDefinition(owner, id,true)).published.find(item => item.version === version) : undefined);
    if (!template) throw new TemplateTaskError('任务模板版本不可用', 404);
    return structuredClone(template);
  }
  private skill(ref: TaskTemplate['input'], expected: string) {
    const skill = this.skills.find(item => item.id === ref.skillId && item.version === ref.version);
    if (!skill || ref.entry !== expected) throw new TemplateTaskError('Skill 入口或版本不可用');
    return skill;
  }
  private templateInputHtml(template: TaskTemplate) {
    return template.parameterUi ? parameterUiHtml(template.parameterUi) : template.agent ? '' : this.skill(template.input,'prepare').inputHtml;
  }
  async inputView(id: string, version: string, owner?: TaskOwner) { return this.templateInputHtml(await this.template(id,version,owner)); }
  async validateParameters(owner: TaskOwner, id: string, version: string, parameters: unknown) { return this.prepare(await this.template(id,version,owner), parameters); }
  private prefix(owner: TaskOwner) {
    return `template-tasks:${encodeURIComponent(owner.orgId)}:${encodeURIComponent(owner.userId)}:`;
  }
  private key(owner: TaskOwner, id: string) { return `${this.prefix(owner)}${encodeURIComponent(id)}`; }
  private runPrefix(owner: TaskOwner, id: string) { return `template-runs:${this.key(owner, id)}:`; }
  async list(owner: TaskOwner, includeDeleted = false): Promise<TemplateTask[]> {
    const keys = await this.store.keys(this.prefix(owner));
    const records = await Promise.all(keys.map(async key => JSON.parse((await this.store.get(key))!) as TemplateTask));
    return records.filter(item => includeDeleted || !item.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async get(owner: TaskOwner, id: string): Promise<TemplateTask> {
    const raw = await this.store.get(this.key(owner, id));
    if (!raw) throw new TemplateTaskError('任务不存在', 404);
    return JSON.parse(raw);
  }
  private assertActive(task: TemplateTask) {
    if (task.deletedAt) throw new TemplateTaskError('任务已删除，历史运行记录仍可查看', 404);
  }
  async deleteTask(owner: TaskOwner, id: string, revision: number) {
    return withKeyLock(this.key(owner, id), async () => {
      const task = await this.get(owner, id);
      this.assertActive(task);
      if (task.revision !== revision) throw new TemplateTaskError('任务已更新，请刷新后再删除', 409);
      if ((await this.detail(owner, id)).runs.some(run => run.status === 'running')) {
        throw new TemplateTaskError('任务正在运行，请等待本次运行结束后再删除', 409);
      }
      task.deletedAt = Date.now(); task.updatedAt = task.deletedAt; task.revision++;
      if (task.schedule && task.schedule.kind !== 'manual') task.schedule = { ...task.schedule, enabled: false };
      task.scheduleState = { ...task.scheduleState, nextRunAt: null };
      await this.store.set(this.key(owner, id), JSON.stringify(task)); await this.store.flush();
    });
  }
  async save(owner: TaskOwner, value: unknown, id?: string, revision?: number, creationId?:string): Promise<TemplateTask> {
    const direct=!!value && typeof value==='object' && (value as {mode?:unknown}).mode==='direct';
    const input = direct ? {...DirectTaskInputSchema.parse(value),templateId:DIRECT_ID,templateVersion:'1',parameters:{}} : TemplateTaskInputSchema.parse(value);
    const template = direct ? directTemplate(input) : await this.template(input.templateId, input.templateVersion, owner);
    if (!direct && !id && !this.templates.some(item => item.id === template.id) && (await this.definition(owner, template.id)).archived) {
      throw new TemplateTaskError('模板已停用，不能创建新任务');
    }
    const parameters = this.prepare(template, { ...template.defaults, ...input.parameters });
    const taskId = id ?? creationId ?? randomUUID();
    return withKeyLock(this.key(owner, taskId), async () => {
      if(creationId&&await this.store.get(this.key(owner,taskId))){const created=await this.get(owner,taskId);this.assertActive(created);return created;}
      const existing = id ? await this.get(owner, id) : undefined;
      if (existing) this.assertActive(existing);
      if (existing && existing.revision !== revision) throw new TemplateTaskError('任务已更新，请刷新后重新编辑', 409);
      if (existing && (existing.mode==='direct')!==direct) throw new TemplateTaskError('不能修改任务创建方式，请新建任务');
      if (existing && (existing.templateId !== input.templateId || existing.templateVersion !== input.templateVersion)) {
        throw new TemplateTaskError('试验版不支持修改任务模板版本，请新建任务');
      }
      const schedule=input.schedule??existing?.schedule??{kind:'manual' as const};
      const scheduleChanged=JSON.stringify(schedule)!==JSON.stringify(existing?.schedule??{kind:'manual'});
      if(scheduleChanged&&schedule.kind==='once'&&schedule.enabled&&schedule.at<=Date.now())throw new TemplateTaskError('定时执行时间必须晚于当前时间');
      const task: TemplateTask = {
        ...input, resultOutput:TaskResultOutputSchema.parse(input.resultOutput??existing?.resultOutput??template.resultOutput??{}),parameters, id: taskId, orgId: owner.orgId, ownerUserId: owner.userId,
        schedule,scheduleState:scheduleChanged||!existing?.scheduleState?{nextRunAt:nextTaskSchedule(schedule,Date.now())}:existing.scheduleState,
        revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
      };
      await this.store.set(this.key(owner, taskId), JSON.stringify(task));
      await this.store.flush();
      return task;
    });
  }
  async detail(owner: TaskOwner, id: string): Promise<TemplateTaskDetail> {
    const task = await this.get(owner, id);
    const keys = await this.store.keys(this.runPrefix(owner, id));
    const runs = await Promise.all(keys.map(async key => JSON.parse((await this.store.get(key))!) as TemplateTaskRun));
    return { task, runs: runs.map(run=>({...run,jsonResult:run.jsonResult??taskRunJsonResult(run)})).sort((a, b) => b.startedAt - a.startedAt) };
  }
  async updateSchedule(owner:TaskOwner,id:string,value:unknown):Promise<TemplateTask> {
    const input=TaskScheduleUpdateSchema.parse(value),task=await this.get(owner,id);
    const shared={name:task.name,prompt:task.prompt,resultOutput:task.resultOutput,schedule:input.schedule};
    return this.save(owner,task.mode==='direct'?{...shared,mode:'direct',employeeId:task.employeeId}:{...shared,templateId:task.templateId,templateVersion:task.templateVersion,parameters:task.parameters},id,input.revision);
  }
  async runs(owner:TaskOwner):Promise<TaskRunListItem[]> {
    const tasks=await this.list(owner, true);
    const records=await Promise.all(tasks.map(async task=>(await this.detail(owner,task.id)).runs.map(run=>({taskId:task.id,taskName:run.result?.title??task.name,mode:task.mode??'template',run}))));
    return records.flat().sort((a,b)=>b.run.startedAt-a.run.startedAt);
  }
  /** Single API writer, bounded dispatch; never replays an overdue interval backlog. */
  async tickScheduled(now=Date.now()):Promise<void> {
    if(this.scheduling)return;
    this.scheduling=true;
    const jobs:Array<Promise<unknown>>=[];
    try {
      for(const taskKey of await this.store.keys('template-tasks:')) {
        if(jobs.length>=4)break;
        const claim=await withKeyLock(taskKey,async()=>{
          const raw=await this.store.get(taskKey);if(!raw)return null;
          const task=JSON.parse(raw) as TemplateTask;
          if (task.deletedAt) return null;
          const due=task.scheduleState?.nextRunAt;
          if(!task.schedule||task.schedule.kind==='manual'||!task.schedule.enabled||due==null||due>now)return null;
          const owner={orgId:task.orgId,userId:task.ownerUserId};
          if((await this.detail(owner,task.id)).runs.some(run=>run.status==='running'))return null;
          const next=task.schedule.kind==='once'?null:task.schedule.kind==='interval'?due+(Math.floor((now-due)/(task.schedule.everyMinutes*60_000))+1)*task.schedule.everyMinutes*60_000:nextTaskSchedule(task.schedule,now);
          task.scheduleState={nextRunAt:next,lastScheduledAt:due};
          await this.store.set(taskKey,JSON.stringify(task));await this.store.flush();
          return {task,owner,due};
        });
        if(claim)jobs.push(this.run(claim.owner,claim.task.id,randomUUID(),'scheduled',claim.due).catch(async error=>{
          // Failures before a Run can be created remain visible on the task schedule.
          await withKeyLock(taskKey,async()=>{const raw=await this.store.get(taskKey);if(!raw)return;const task=JSON.parse(raw) as TemplateTask;task.scheduleState={...task.scheduleState,nextRunAt:task.scheduleState?.nextRunAt??null,lastError:error instanceof Error?error.message:'定时执行失败'};await this.store.set(taskKey,JSON.stringify(task));await this.store.flush();});
        }));
      }
    } finally {this.scheduling=false;}
    // Guard claims, not the lifetime of Agent approvals/execution; later ticks can dispatch other tasks.
    await Promise.all(jobs);
  }
  async run(owner: TaskOwner, id: string, requestId: string,trigger:'manual'|'scheduled'='manual',scheduledFor?:number): Promise<TemplateTaskRun> {
    const key = `${this.runPrefix(owner, id)}${encodeURIComponent(requestId)}`;
    return withKeyLock(key, () => withKeyLock(`task-execution:${this.key(owner,id)}`,async () => {
      // Serialize the short run-creation phase with deletion, never hold this lock during model execution.
      const prepared = await withKeyLock(this.key(owner, id), async () => {
      const task = await this.get(owner, id);
      this.assertActive(task);
      const previous = await this.store.get(key);
      if (previous) {
        const record = JSON.parse(previous) as TemplateTaskRun;
        // A running record seen after acquiring this lock belongs to an interrupted process.
        if (record.status === 'running') {
          record.status = 'failed'; record.finishedAt = Date.now(); record.error = '上次执行中断，请重新运行';
          record.jsonResult=taskRunJsonResult(record);
          await this.store.set(key, JSON.stringify(record)); await this.store.flush();
        }
        return { previous: {...record,jsonResult:record.jsonResult??taskRunJsonResult(record)} };
      }
      const template = task.mode==='direct'?directTemplate(task):await this.template(task.templateId, task.templateVersion, owner);
      const run: TemplateTaskRun = {
        id: requestId, taskId: id, taskName:task.name, taskRevision: task.revision, template,
        trigger,scheduledFor,
        inputSnapshot: structuredClone(task.parameters), startedAt: Date.now(), status: 'running', steps: [],
        executionSnapshot:{prompt:task.prompt??template.agent?.prompt??'',employeeId:template.agent?.employeeId,resultOutput:TaskResultOutputSchema.parse(task.resultOutput??template.resultOutput??{})},
      };
      await this.store.set(key, JSON.stringify(run)); await this.store.flush();
      return { task, template, run };
      });
      if (prepared.previous) return prepared.previous;
      const { task, template, run } = prepared;
      const persist = async () => { await this.store.set(key, JSON.stringify(run)); await this.store.flush(); };
      let stage: 'input' | 'execution' | 'output' = 'input';
      try {
        const input = this.prepare(template, run.inputSnapshot);
        run.steps.push({ stage, status: 'completed', at: Date.now() }); await persist();
        stage = 'execution';
        const output = template.agent
          ? await (this.executeAgent ?? (() => { throw new TemplateTaskError('智能体执行器尚未接入'); }))(owner,template,input,(task.prompt ?? template.agent.prompt)+(run.executionSnapshot?.resultOutput.instructions?'\n\n结果输出要求：\n'+run.executionSnapshot.resultOutput.instructions:''),async (sessionId,runId,status) => {run.sessionId=sessionId;run.agentRunId=runId;run.agentStatus=status;run.jsonResult=taskRunJsonResult(run);await persist();})
          : await this.skill(template.execution, 'execute').execute(input);
        run.steps.push({ stage, status: 'completed', at: Date.now() }); await persist();
        stage = 'output';
        this.assignResult(run,output,task.name);
      } catch (error) {
        run.status = 'failed'; run.error = error instanceof Error ? error.message : '执行失败';
        run.steps.push({ stage, status: 'failed', at: Date.now() });
      }
      delete run.agentStatus;run.finishedAt = Date.now();run.jsonResult=taskRunJsonResult(run); await persist();
      return run;
    }));
  }
  async result(owner: TaskOwner, taskId: string, runId: string): Promise<TaskResult> {
    await this.get(owner, taskId);
    const raw = await this.store.get(`${this.runPrefix(owner, taskId)}${encodeURIComponent(runId)}`);
    const result = raw ? (JSON.parse(raw) as TemplateTaskRun).result : undefined;
    if (!result) throw new TemplateTaskError('本次运行没有可用结果', 404);
    return result;
  }
  async exportResult(owner: TaskOwner, taskId: string, runId: string, format: TaskExportFormat) {
    const result = await this.result(owner, taskId, runId);
    if (!(result.delivery?.exports ?? ['json']).includes(format)) throw new TemplateTaskError('此模板未启用该导出格式');
    if (format === 'json') return { content: JSON.stringify(result, null, 2), mime: 'application/json', name: `result-${result.id}.json` };
    if (format === 'html') {
      const rendered = this.render(result);
      if (!rendered.html) throw new TemplateTaskError('报告模板不可用');
      return { content: rendered.html, mime: 'text/html; charset=utf-8', name: `report-${result.id}.html` };
    }
    const detail = await this.detail(owner, taskId);
    const run = detail.runs.find(item => item.id === runId)!;
    const skill = this.skill(run.template.output, 'format');
    if (!skill.exportCsv) throw new TemplateTaskError('CSV 导出入口不可用');
    return { content: skill.exportCsv(result.data), mime: 'text/csv; charset=utf-8', name: `data-${result.id}.csv` };
  }
  render(result: TaskResult): { html: string | null; warning?: string } {
    if(result.reportUi){try{return {html:reportUiHtml(result.reportUi,{title:result.title,data:result.data})};}catch{return {html:reportUiHtml(undefined,{title:result.title,data:result.data}),warning:'自定义报告不可用，已使用默认结果界面'};}}
    if (result.type==='agent-task'||result.data.sessionId && result.data.agentRunId) return {html:reportUiHtml(undefined,{title:result.title,data:result.data})};
    const descriptor = this.skills.find(skill => skill.id === result.view.skillId && skill.version === result.view.version)?.descriptor;
    const compatible = (descriptor?.resultType === result.type && descriptor.resultVersion === result.schemaVersion && descriptor.entries.view === result.view.entry) || this.templates.some(template => template.resultType === result.type && template.resultVersion === result.schemaVersion
      && template.view.skillId === result.view.skillId && template.view.version === result.view.version && template.view.entry === result.view.entry);
    if (!compatible) return { html: null, warning: '展示模板不兼容，请查看结构化数据' };
    try { return { html: this.skill(result.view, 'report').report(result.data, result.presentation) }; }
    catch { return { html: null, warning: '报告模板暂不可用，请查看结构化数据' }; }
  }
}
