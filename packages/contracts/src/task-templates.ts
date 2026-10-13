import { z } from 'zod';
import { TaskParameterUiSchema,TaskReportUiSchema,type TaskReportUi } from './task-parameter-ui.js';
import {TaskScheduleSchema,type TaskScheduleState} from './task-schedule.js';

const EntrySchema = z.object({ skillId: z.string().min(1), version: z.string().min(1), entry: z.string().min(1) });
export const TaskPresentationSchema = z.object({
  title: z.string().trim().max(100).default(''),
  accent: z.enum(['blue', 'green', 'violet']).default('blue'),
  showSummary: z.boolean().default(true), showRows: z.boolean().default(true),
  defaultTab: z.enum(['report', 'data']).default('report'),
}).strict();
export type TaskPresentation = z.infer<typeof TaskPresentationSchema>;
export const TaskDeliverySchema = z.object({
  storage: z.literal('task-results').default('task-results'),
  exports: z.array(z.enum(['json', 'html', 'csv'])).max(3).default(['json']),
}).strict();
export type TaskExportFormat = 'json' | 'html' | 'csv';
export const TaskResultOutputSchema = z.object({
  destination: z.literal('task-results').default('task-results'),
  instructions: z.string().trim().max(4000).default(''),
}).strict();
export type TaskResultOutput = z.infer<typeof TaskResultOutputSchema>;
export const TaskTemplateSchema = z.object({
  id: z.string().min(1).max(120), version: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(120), description: z.string().trim().max(1000),
  input: EntrySchema, execution: EntrySchema, output: EntrySchema,
  view: EntrySchema, resultType: z.string(), resultVersion: z.string(),
  defaults: z.record(z.unknown()).optional(),
  parameterUi: TaskParameterUiSchema.optional(),
  reportUi:TaskReportUiSchema.optional(),resultOutput:TaskResultOutputSchema.optional(),
  agent: z.object({ employeeId: z.string().min(1).max(120), prompt: z.string().trim().min(1).max(8000) }).strict().optional(),
  presentation: TaskPresentationSchema.optional(), delivery: TaskDeliverySchema.optional(),
}).strict();
export type TaskTemplate = z.infer<typeof TaskTemplateSchema>;
export const TaskTemplateConfigurationSchema = TaskTemplateSchema.omit({ id: true, version: true });
export type TaskTemplateConfiguration = z.infer<typeof TaskTemplateConfigurationSchema>;
export interface TaskTemplateDefinition {
  id: string; orgId: string; ownerUserId: string; revision: number;
  draft: TaskTemplate; published: TaskTemplate[]; archived: boolean;
  parameterProjectId?: string;
  reportProjectId?:string;
  deletedAt?: number;
  verifiedRevision?: number; verifiedAt?: number; createdAt: number; updatedAt: number;
}
export interface TaskSkillDescriptor {
  id: string; version: string; name: string; description: string;
  inputType: string; resultType: string; resultVersion: string;
  entries: { input: string; execution: string; output: string; view: string };
  exports: TaskExportFormat[];
}
export interface TaskTemplateTrial {
  revision: number; data: Record<string, unknown>; html: string;
  checks: string[];
  mode?: 'configuration' | 'execution';
}
export const TaskTemplateTrialRequestSchema = z.object({revision:z.number().int().positive(),parameters:z.record(z.unknown()).optional()}).strict();
export const TaskTemplateDeleteSchema = z.object({revision:z.number().int().positive()}).strict();
export const TemplateTaskInputSchema = z.object({
  name: z.string().trim().min(1).max(120), templateId: z.string().min(1),
  templateVersion: z.string().min(1), parameters: z.record(z.unknown()),
  prompt: z.string().trim().min(1).max(8000).optional(),
  mode: z.literal('template').optional(),
  schedule:TaskScheduleSchema.optional(),
  resultOutput: TaskResultOutputSchema.optional(),
}).strict();
export type TemplateTaskInput = z.infer<typeof TemplateTaskInputSchema>;
export const DirectTaskInputSchema = z.object({
  mode: z.literal('direct'), name: z.string().trim().min(1).max(120),
  employeeId: z.string().min(1).max(120), prompt: z.string().trim().min(1).max(8000),
  resultOutput: TaskResultOutputSchema.optional(),
  schedule:TaskScheduleSchema.optional(),
}).strict();
export type DirectTaskInput = z.infer<typeof DirectTaskInputSchema>;
export type TaskCreateInput = TemplateTaskInput | DirectTaskInput;
export interface TemplateTask extends Omit<TemplateTaskInput, 'mode'> {
  deletedAt?: number;
  scheduleState?:TaskScheduleState;
  mode?: 'template' | 'direct'; employeeId?: string;
  id: string; orgId: string; ownerUserId: string; revision: number;
  createdAt: number; updatedAt: number;
}
export interface TaskResult {
  reportUi?:TaskReportUi;
  id: string; taskId: string; runId: string; type: string; schemaVersion: string;
  title: string; createdAt: number; data: Record<string, unknown>;
  view: z.infer<typeof EntrySchema>;
  presentation?: TaskPresentation;
  delivery?: z.infer<typeof TaskDeliverySchema>;
}
export interface TemplateTaskRun {
  trigger?:'manual'|'scheduled';scheduledFor?:number;
  id: string; taskId: string; taskRevision: number; template: TaskTemplate;
  inputSnapshot: Record<string, unknown>; startedAt: number; finishedAt?: number;
  status: 'running' | 'completed' | 'failed'; error?: string;
  steps: Array<{ stage: 'input' | 'execution' | 'output'; status: 'completed' | 'failed'; at: number }>;
  result?: TaskResult;
  sessionId?: string; agentRunId?: string;
  executionSnapshot?: { prompt: string; employeeId?: string; resultOutput: TaskResultOutput };
  jsonResult?: TaskRunJsonResult;
}
export const TaskRunJsonResultSchema = z.object({
  trigger:z.enum(['manual','scheduled']).optional(),scheduledFor:z.number().optional(),
  schemaVersion:z.literal('1.0'), kind:z.literal('json-result'),
  taskId:z.string(), runId:z.string(), taskRevision:z.number().int(),
  status:z.enum(['running','completed','failed']),
  input:z.object({parameters:z.record(z.unknown()),prompt:z.string(),employeeId:z.string().optional()}),
  output:TaskResultOutputSchema, data:z.record(z.unknown()).nullable(), error:z.string().nullable(),
  startedAt:z.number(), finishedAt:z.number().optional(),
}).strict();
export type TaskRunJsonResult = z.infer<typeof TaskRunJsonResultSchema>;
export interface TaskRunListItem { taskId:string; taskName:string; mode:'template'|'direct'; run:TemplateTaskRun }
export const TaskRunListQuerySchema=z.object({offset:z.coerce.number().int().min(0).max(100000).default(0),limit:z.coerce.number().int().min(1).max(100).default(30),status:z.enum(['running','completed','failed']).optional(),search:z.string().max(120).optional()}).strict();
export interface TaskRunListPage {records:TaskRunListItem[];total:number;nextOffset:number|null}
export interface TemplateTaskDetail { task: TemplateTask; runs: TemplateTaskRun[] }

const MoneySchema = z.number().finite().min(0).max(1_000_000_000)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.0001, '金额最多两位小数');
export const BusinessSummaryInputSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '请选择有效月份'),
  rows: z.array(z.object({
    name: z.string().trim().min(1).max(100), revenue: MoneySchema, cost: MoneySchema,
  }).strict()).min(1).max(100),
}).strict();
export type BusinessSummaryInput = z.infer<typeof BusinessSummaryInputSchema>;
export const BusinessSummaryResultSchema = z.object({
  period: z.string(), currency: z.literal('CNY'), revenue: z.number().finite(),
  cost: z.number().finite(), profit: z.number().finite(), margin: z.number().finite().nullable(),
  rows: z.array(z.object({ name: z.string(), revenue: z.number(), cost: z.number(), profit: z.number() })),
  summary: z.string(),
});
