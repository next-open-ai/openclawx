import {createHash} from 'node:crypto';
import {TaskApplicationCreateSchema,TaskApplicationLaunchSchema} from '@openclawx/contracts';
import type {TaskTemplateDefinition} from '@openclawx/contracts';
import {TemplateTaskError,withKeyLock,type Orchestrator,type TemplateTaskService,type TaskOwner} from '@openclawx/orchestrator';
import type {ParameterProjects} from './parameter-project.js';
import {listWorkEmployees} from '../work-results/delegation.js';

function canonical(value:unknown):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';return JSON.stringify(value);}
/** Applications are versioned task definitions, not a second execution runtime. */
export class TaskApplications {
  constructor(private orch:Orchestrator,private tasks:TemplateTaskService,private projects:ParameterProjects,private log:(error:unknown)=>void=()=>{}){}
  async list(owner:TaskOwner){return(await this.tasks.definitions(owner)).filter(record=>record.draft.application);}
  async definition(owner:TaskOwner,id:string){const record=await this.tasks.definition(owner,id);if(!record.draft.application)throw new TemplateTaskError('任务应用不存在',404);return record;}
  async create(owner:TaskOwner,raw:unknown,catalog:unknown={units:[]}){
    const input=TaskApplicationCreateSchema.parse(raw);
    if(!(await listWorkEmployees(this.orch,owner)).some(row=>row.id===input.employeeId))throw new TemplateTaskError('执行智能体不可用');
    const seed=(await this.tasks.listTemplates()).find(row=>row.id==='business-summary');if(!seed)throw new TemplateTaskError('任务基础定义不可用',503);
    const {id:_id,version:_version,...base}=seed;
    const definition=await this.tasks.saveDefinition(owner,{...base,application:true,name:input.name,description:input.description,defaults:{},agent:{employeeId:input.employeeId,prompt:input.prompt},resultType:'agent-task',resultVersion:'1.0'});
    const project=await this.projects.open(owner,definition.id,definition.revision,input.employeeId,catalog);
    return{...project,definition:await this.definition(owner,definition.id)};
  }
  async launch(owner:TaskOwner,id:string,raw:unknown){
    const input=TaskApplicationLaunchSchema.parse(raw),definition=await this.definition(owner,id);
    if(definition.archived)throw new TemplateTaskError('应用已停用');
    const template=definition.published.find(row=>row.version===input.version);if(!template)throw new TemplateTaskError('请先验证并发布应用，或重新打开已发布版本',409);
    const key=`task-app-launch:${encodeURIComponent(owner.orgId)}:${encodeURIComponent(owner.userId)}:${id}:${input.requestId}`;
    const hash=createHash('sha256').update(canonical(input)).digest('hex');
    return withKeyLock(key,async()=>{
      const previous=await this.orch.store.get(key);
      if(previous&&JSON.parse(previous).hash!==hash)throw new TemplateTaskError('同一提交编号不能用于不同参数，请重新发起',409);
      // Persist the intent before task creation; stable taskId closes the crash/retry window.
      if(!previous){await this.orch.store.set(key,JSON.stringify({hash}));await this.orch.store.flush();}
      const hex=createHash('sha256').update(id+':'+input.requestId).digest('hex');
      const taskId=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
      const task=await this.tasks.save(owner,{name:input.name,templateId:id,templateVersion:template.version,parameters:input.parameters,schedule:input.schedule},undefined,undefined,taskId);
      if(input.executeNow){
        let startError:unknown;
        void this.tasks.run(owner,task.id,input.requestId).catch(error=>{startError=error;this.log(error);});
        let recorded=false;
        for(let n=0;n<50;n++){
          if((await this.tasks.detail(owner,task.id)).runs.some(run=>run.id===input.requestId)){recorded=true;break;}
          if(startError)throw new TemplateTaskError('任务启动失败，请查看任务记录并使用原提交重试',503);
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        if(!recorded)throw new TemplateTaskError('任务已保存，但执行启动尚未确认。请使用原提交重试，不要重复新建',503);
      }
      return{task,runId:input.executeNow?input.requestId:undefined,status:input.executeNow?'accepted':'scheduled'};
    });
  }
}

export const taskApplicationApiReference={version:1,purpose:'任务应用编程参考，不授予接口权限',pageSDK:'await platform.ready; platform.getParameters(); await platform.submit(parameters)',hostOnly:true,
  rules:['页面仅收集参数；宿主显示立即执行/定时执行并调用下列接口，页面不得fetch或保存凭据','参数以input.schema.json为契约；业务数据读取使用API-REFERENCE.json中列出的platform.request接口','验证不执行智能体；发布固定版本；创建任务时固定参数/版本；定时器由服务端管理','预览中的提交不创建真实任务；只有任务中心宿主的明确执行按钮才创建任务'],
  endpoints:[{method:'POST',path:'/api/task-applications/:id/launch',input:{requestId:'客户端UUID，同一提交重试复用',version:'已发布版本',name:'任务名称',parameters:'表单JSON',schedule:'manual/once/interval/daily/weekly/monthly，结构见TaskScheduleSchema',executeNow:'立即执行true且manual；定时false'},response:'{task:{id,revision,...},runId?,status:accepted|scheduled}'},{method:'GET',path:'/api/template-tasks/:id',response:'{task,runs:[{id,status,agentStatus?,sessionId?,result?,error?}]}'},{method:'GET',path:'/api/template-tasks/:id/runs/:runId/result',response:'{result,html,warning?}'},{method:'PUT',path:'/api/template-tasks/:id/schedule',input:{revision:'当前任务版本',schedule:'现有TaskScheduleSchema'},response:'{task}'}]};
