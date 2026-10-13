import { z } from 'zod';
import { structuredDataQuerySchema } from './data-query.js';

const scalar = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]);
export const dataAppParametersSchema = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), scalar).refine(v => Object.keys(v).length <= 30, '最多 30 个参数');
export const dataAppOperationSchema = z.object({
  operationId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  description: z.string().trim().min(1).max(1000),
  query: structuredDataQuerySchema,
  parameters: z.array(z.object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
    path: z.string().regex(/^(limit|offset|(filters|metrics\.\d+\.filters)(\.conditions\.\d+)*\.(value|values\.\d+))$/),
    type: z.enum(['string', 'number', 'boolean']),
    required: z.boolean().default(true), default: scalar.optional(),
  }).strict()).max(30).default([]),
  testParameters: dataAppParametersSchema.default({}),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.parameters.map(p => p.name)).size !== v.parameters.length || new Set(v.parameters.map(p => p.path)).size !== v.parameters.length) ctx.addIssue({ code: 'custom', message: '参数名称及绑定位置不可重复' });
});
export const dataAppInvokeSchema = z.object({ operationId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/), parameters: dataAppParametersSchema.default({}) }).strict();
export type DataAppOperation = z.infer<typeof dataAppOperationSchema>;

// SQL names refer to object table/column IDs, not connection identifiers.
export const dataAppSqlOperationSchema = z.object({
  kind: z.literal('sql'),
  operationId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  description: z.string().trim().min(1).max(1000),
  sql: z.string().trim().min(1).max(16000),
  parameters: z.array(z.object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
    type: z.enum(['string', 'number', 'boolean']), required: z.boolean().default(true),
    default: scalar.optional(),
  }).strict()).max(30).default([]),
  testParameters: dataAppParametersSchema.default({}),
}).strict().refine(v => new Set(v.parameters.map(p => p.name)).size === v.parameters.length, '参数名不可重复');
export const dataAppStoredOperationSchema = z.union([dataAppOperationSchema, dataAppSqlOperationSchema]);
export const dataAppSqlApprovalSchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const dataAppMutationSchema = dataAppInvokeSchema.extend({
  revision: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true).optional(),
}).strict();
export const dataAppSqlTrialSchema = dataAppInvokeSchema.extend({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  testDatabaseConfirmed: z.literal(true), acknowledgeSideEffects: z.literal(true),
}).strict();
export type DataAppSqlOperation = z.infer<typeof dataAppSqlOperationSchema>;
export interface DataAppOperationSummary {
  operationId: string; description: string; verifiedAt: number; resultFields: Array<{ id: string; name?: string; type?: string }>;
  parameters: Array<{ name: string; type: string; required: boolean; default?: unknown }>;
  kind?: 'sql'; action?: 'select' | 'insert' | 'update' | 'delete'; sql?: string;
  revision?: string; approved?: boolean;
  validation?: { level: 'explain' | 'rollback'; checkedAt: number; revision: string };
}
export interface DataAppAccess {
  writeEnabled: boolean;
  canWrite: boolean;
  operations: DataAppOperationSummary[];
  schemaCreation?: {enabled:boolean;supported:boolean;plans:import('./data-schema-change.js').DataSchemaPlan[]};
}
