import { getStoredSessionToken } from './auth';
import type {TaskSchedule} from '@workmate/contracts';
import type {TaskApplicationCreate,TaskApplicationLaunch} from '@workmate/contracts';
import {TaskParameterProjectInfoSchema,TaskParameterProjectPreviewSchema,TaskTemplateProblemSchema,TaskReportProjectPreviewSchema} from '@workmate/contracts';
import type { TaskTemplate, TemplateTask, TaskCreateInput, TemplateTaskDetail, TemplateTaskRun, TaskResult, TaskTemplateConfiguration, TaskTemplateDefinition, TaskSkillDescriptor, TaskTemplateTrial, TaskExportFormat,TaskRunListPage } from '@workmate/contracts';
export type { TaskTemplate, TemplateTask, TemplateTaskDetail, TemplateTaskRun, TaskResult };
export type { TaskTemplateConfiguration, TaskTemplateDefinition, TaskSkillDescriptor, TaskTemplateTrial, TaskExportFormat };
const base = () => window.location.protocol === 'file:' ? 'http://127.0.0.1:47832/api' : '/api';
async function request<T>(path: string, method = 'GET', body?: unknown,signal?:AbortSignal): Promise<T> {
  const response = await fetch(`${base()}${path}`, {
    method, signal,headers: { ...(getStoredSessionToken() ? {authorization:`Bearer ${getStoredSessionToken()}`} : {}), ...(body === undefined ? {} : {'content-type':'application/json'}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    const problem=TaskTemplateProblemSchema.safeParse(result);
    throw Object.assign(new Error(result.message || '任务请求失败'),problem.success?problem.data:{});
  }
  return result;
}
export const templateTasksApi = {
  applications:()=>request<{applications:TaskTemplateDefinition[]}>('/task-applications'),
  createApplication:(input:TaskApplicationCreate)=>request<{definition:TaskTemplateDefinition;projectId:string}>('/task-applications','POST',input),
  launchApplication:(id:string,input:TaskApplicationLaunch)=>request<{task:TemplateTask;runId?:string;status:string}>(`/task-applications/${encodeURIComponent(id)}/launch`,'POST',input),
  previewReportProject:async(id:string)=>TaskReportProjectPreviewSchema.parse(await request(`/task-report-projects/${encodeURIComponent(id)}/preview`)),
  parameterProjectInfo:async(id:string)=>TaskParameterProjectInfoSchema.parse(await request(`/task-parameter-projects/${encodeURIComponent(id)}`)),
  previewParameterProject:async(id:string)=>TaskParameterProjectPreviewSchema.parse(await request(`/task-parameter-projects/${encodeURIComponent(id)}/preview`)),
  schedule:(task:TemplateTask,schedule:TaskSchedule)=>request<{task:TemplateTask}>(`/template-tasks/${encodeURIComponent(task.id)}/schedule`,'PUT',{revision:task.revision,schedule}),
  template: (id: string, version: string) => request<{ template: TaskTemplate }>(`/task-templates/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`),
  trial: (definition: TaskTemplateDefinition,parameters?:Record<string,unknown>) => request<TaskTemplateTrial>(`/task-template-definitions/${encodeURIComponent(definition.id)}/trial`, 'POST', { revision: definition.revision, ...(parameters === undefined ? {} : {parameters}) }),
  publish: (definition: TaskTemplateDefinition) => request<{ definition: TaskTemplateDefinition }>(`/task-template-definitions/${encodeURIComponent(definition.id)}/publish`, 'POST', { revision: definition.revision }),
  definition: (id:string) => request<{definition:TaskTemplateDefinition}>(`/task-template-definitions/${encodeURIComponent(id)}`),
  parameterProject: (definition:TaskTemplateDefinition,employeeId:string) => request<{projectId:string}>(`/task-template-definitions/${encodeURIComponent(definition.id)}/parameter-project`,'POST',{revision:definition.revision,employeeId}),
  importParameterUi: (definition:TaskTemplateDefinition) => request<{definition:TaskTemplateDefinition}>(`/task-template-definitions/${encodeURIComponent(definition.id)}/import-parameter-ui`,'POST',{revision:definition.revision}),
  validateParameters: (template:TaskTemplate,parameters:unknown) => request<{parameters:Record<string,unknown>}>(`/task-templates/${encodeURIComponent(template.id)}/validate-parameters`,'POST',{version:template.version,parameters}),
  previewInput: (definition:TaskTemplateDefinition) => request<{html:string;parameters:Record<string,unknown>}>(`/task-template-definitions/${encodeURIComponent(definition.id)}/input`),
  input: (template: TaskTemplate) => request<{ html: string }>(`/task-templates/${encodeURIComponent(template.id)}/input?version=${encodeURIComponent(template.version)}`),
  list: () => request<{ tasks: TemplateTask[] }>('/template-tasks'),
  deleteTask: (task: TemplateTask) => request<{ deleted: boolean }>(`/template-tasks/${encodeURIComponent(task.id)}`, 'DELETE', { revision: task.revision }),
  runs:(query:Record<string,string>={})=>request<TaskRunListPage>(`/task-runs?${new URLSearchParams(query)}`),
  detail: (id: string,signal?:AbortSignal) => request<TemplateTaskDetail>(`/template-tasks/${encodeURIComponent(id)}`,'GET',undefined,signal),
  save: (input: TaskCreateInput, task?: TemplateTask) => task
    ? request<{ task: TemplateTask }>(`/template-tasks/${encodeURIComponent(task.id)}`, 'PUT', { revision: task.revision, input })
    : request<{ task: TemplateTask }>('/template-tasks', 'POST', input),
  run: (id: string, requestId: string) => request<{ run: TemplateTaskRun }>(`/template-tasks/${encodeURIComponent(id)}/runs`, 'POST', { requestId }),
  result: (id: string, runId: string,signal?:AbortSignal) => request<{ result: TaskResult; html: string | null; warning?: string }>(`/template-tasks/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/result`,'GET',undefined,signal),
  async download(id: string, runId: string, format: TaskExportFormat) {
    const response = await fetch(`${base()}/template-tasks/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/export?format=${format}`);
    if (!response.ok) throw new Error((await response.json()).message || '导出失败');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = url; link.download = `task-result-${runId}.${format}`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
