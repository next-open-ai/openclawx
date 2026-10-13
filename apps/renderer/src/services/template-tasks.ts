import { getStoredSessionToken } from './auth';
import type {TaskSchedule} from '@workmate/contracts';
import {TaskParameterProjectInfoSchema,TaskParameterProjectPreviewSchema,TaskTemplateProblemSchema,TaskReportProjectPreviewSchema} from '@workmate/contracts';
import type { TaskTemplate, TemplateTask, TaskCreateInput, TemplateTaskDetail, TemplateTaskRun, TaskResult, TaskTemplateConfiguration, TaskTemplateDefinition, TaskSkillDescriptor, TaskTemplateTrial, TaskExportFormat,TaskRunListPage } from '@workmate/contracts';
export type { TaskTemplate, TemplateTask, TemplateTaskDetail, TemplateTaskRun, TaskResult };
export type { TaskTemplateConfiguration, TaskTemplateDefinition, TaskSkillDescriptor, TaskTemplateTrial, TaskExportFormat };
const base = () => window.location.protocol === 'file:' ? 'http://127.0.0.1:47832/api' : '/api';
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base()}${path}`, {
    method, headers: { ...(getStoredSessionToken() ? {authorization:`Bearer ${getStoredSessionToken()}`} : {}), ...(body === undefined ? {} : {'content-type':'application/json'}) },
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
  previewReport:(definition:TaskTemplateDefinition)=>request<{html:string}>(`/task-template-definitions/${encodeURIComponent(definition.id)}/report`),
  reportProject:(definition:TaskTemplateDefinition,employeeId:string)=>request<{projectId:string}>(`/task-template-definitions/${encodeURIComponent(definition.id)}/report-project`,'POST',{revision:definition.revision,employeeId}),
  importReportUi:(definition:TaskTemplateDefinition)=>request<{definition:TaskTemplateDefinition}>(`/task-template-definitions/${encodeURIComponent(definition.id)}/import-report-ui`,'POST',{revision:definition.revision}),
  previewReportProject:async(id:string)=>TaskReportProjectPreviewSchema.parse(await request(`/task-report-projects/${encodeURIComponent(id)}/preview`)),
  parameterProjectInfo:async(id:string)=>TaskParameterProjectInfoSchema.parse(await request(`/task-parameter-projects/${encodeURIComponent(id)}`)),
  previewParameterProject:async(id:string)=>TaskParameterProjectPreviewSchema.parse(await request(`/task-parameter-projects/${encodeURIComponent(id)}/preview`)),
  schedule:(task:TemplateTask,schedule:TaskSchedule)=>request<{task:TemplateTask}>(`/template-tasks/${encodeURIComponent(task.id)}/schedule`,'PUT',{revision:task.revision,schedule}),
  templates: () => request<{ templates: TaskTemplate[] }>('/task-templates'),
  template: (id: string, version: string) => request<{ template: TaskTemplate }>(`/task-templates/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`),
  skills: () => request<{ skills: TaskSkillDescriptor[] }>('/task-template-skills'),
  skillInput: (id: string, version: string) => request<{ html: string }>(`/task-template-skills/${encodeURIComponent(id)}/input?version=${encodeURIComponent(version)}`),
  definitions: () => request<{ definitions: TaskTemplateDefinition[] }>('/task-template-definitions'),
  saveDefinition: (configuration: TaskTemplateConfiguration, definition?: TaskTemplateDefinition) => definition
    ? request<{ definition: TaskTemplateDefinition }>(`/task-template-definitions/${encodeURIComponent(definition.id)}`, 'PUT', { revision: definition.revision, configuration })
    : request<{ definition: TaskTemplateDefinition }>('/task-template-definitions', 'POST', configuration),
  trial: (definition: TaskTemplateDefinition,parameters?:Record<string,unknown>) => request<TaskTemplateTrial>(`/task-template-definitions/${encodeURIComponent(definition.id)}/trial`, 'POST', { revision: definition.revision, ...(parameters === undefined ? {} : {parameters}) }),
  publish: (definition: TaskTemplateDefinition) => request<{ definition: TaskTemplateDefinition }>(`/task-template-definitions/${encodeURIComponent(definition.id)}/publish`, 'POST', { revision: definition.revision }),
  archive: (definition: TaskTemplateDefinition, archived: boolean) => request<{ definition: TaskTemplateDefinition }>(`/task-template-definitions/${encodeURIComponent(definition.id)}/archive`, 'POST', { revision: definition.revision, archived }),
  deleteDefinition:(definition:TaskTemplateDefinition)=>request<{deleted:boolean}>(`/task-template-definitions/${encodeURIComponent(definition.id)}`,'DELETE',{revision:definition.revision}),
  definition: (id:string) => request<{definition:TaskTemplateDefinition}>(`/task-template-definitions/${encodeURIComponent(id)}`),
  parameterProject: (definition:TaskTemplateDefinition,employeeId:string) => request<{projectId:string}>(`/task-template-definitions/${encodeURIComponent(definition.id)}/parameter-project`,'POST',{revision:definition.revision,employeeId}),
  importParameterUi: (definition:TaskTemplateDefinition) => request<{definition:TaskTemplateDefinition}>(`/task-template-definitions/${encodeURIComponent(definition.id)}/import-parameter-ui`,'POST',{revision:definition.revision}),
  validateParameters: (template:TaskTemplate,parameters:unknown) => request<{parameters:Record<string,unknown>}>(`/task-templates/${encodeURIComponent(template.id)}/validate-parameters`,'POST',{version:template.version,parameters}),
  previewInput: (definition:TaskTemplateDefinition) => request<{html:string;parameters:Record<string,unknown>}>(`/task-template-definitions/${encodeURIComponent(definition.id)}/input`),
  input: (template: TaskTemplate) => request<{ html: string }>(`/task-templates/${encodeURIComponent(template.id)}/input?version=${encodeURIComponent(template.version)}`),
  list: () => request<{ tasks: TemplateTask[] }>('/template-tasks'),
  deleteTask: (task: TemplateTask) => request<{ deleted: boolean }>(`/template-tasks/${encodeURIComponent(task.id)}`, 'DELETE', { revision: task.revision }),
  runs:(query:Record<string,string>={})=>request<TaskRunListPage>(`/task-runs?${new URLSearchParams(query)}`),
  detail: (id: string) => request<TemplateTaskDetail>(`/template-tasks/${encodeURIComponent(id)}`),
  save: (input: TaskCreateInput, task?: TemplateTask) => task
    ? request<{ task: TemplateTask }>(`/template-tasks/${encodeURIComponent(task.id)}`, 'PUT', { revision: task.revision, input })
    : request<{ task: TemplateTask }>('/template-tasks', 'POST', input),
  run: (id: string, requestId: string) => request<{ run: TemplateTaskRun }>(`/template-tasks/${encodeURIComponent(id)}/runs`, 'POST', { requestId }),
  result: (id: string, runId: string) => request<{ result: TaskResult; html: string | null; warning?: string }>(`/template-tasks/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/result`),
  async download(id: string, runId: string, format: TaskExportFormat) {
    const response = await fetch(`${base()}/template-tasks/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/export?format=${format}`);
    if (!response.ok) throw new Error((await response.json()).message || '导出失败');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = url; link.download = `task-result-${runId}.${format}`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
