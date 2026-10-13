import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { structuredDataQuerySchema } from './data-query.js';
import { dataAppOperationSchema, dataAppInvokeSchema, dataAppSqlOperationSchema } from './data-app-query.js';
import { dataSchemaProposalSchema } from './data-schema-change.js';
import { saveQueryAssetSchema, listQueryAssetsSchema, runQueryAssetSchema } from './query-assets.js';

// Internal desktop -> API only; never a renderer or model capability.
export const databaseCredentialBridgeSchema = z.object({
  port: z.number().int().min(1).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const employeeDataSourceIdsSchema = z.array(z.string().min(1).max(128)).max(24).default([]);
export const employeeDataAssociationSchema = z.object({ dataSourceIds: employeeDataSourceIdsSchema }).strict();
export function employeeDataAssociationKey(owner: { userId: string; orgId: string }, employeeId: string) {
  return `data-agent-associations:v1:${encodeURIComponent(owner.orgId)}:${encodeURIComponent(owner.userId)}:${encodeURIComponent(employeeId)}`;
}
export const dataListObjectsInputSchema = z.object({
  search: z.string().max(120).default(''), offset: z.number().int().min(0).max(10000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();
export const dataGetSchemaInputSchema = z.object({
  sourceId: z.string().min(1).max(128), tableId: z.string().min(1).max(128).optional(),
  origin: z.enum(['object', 'database']).default('object'),
  view: z.enum(['tables', 'relations']).optional(),
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(20).default(10),
}).strict().refine(v => !v.tableId || !v.view, 'tableId 与 view 不可同时提供')
  .refine(v => v.origin !== 'database' || Boolean(v.tableId), '数据库补充元数据必须指定当前对象内的 tableId');
export const dataAgentInputSchemas = {
  data_list_objects: dataListObjectsInputSchema,
  data_get_schema: dataGetSchemaInputSchema,
  data_query: structuredDataQuerySchema,
  data_app_register_query: dataAppOperationSchema,
  data_app_register_sql: dataAppSqlOperationSchema,
  data_app_propose_schema: dataSchemaProposalSchema,
  data_app_test_query: dataAppInvokeSchema,
  data_save_query_asset: saveQueryAssetSchema,
  data_list_query_assets: listQueryAssetsSchema,
  data_run_query_asset: runQueryAssetSchema,
};
export type DataAgentToolName = keyof typeof dataAgentInputSchemas;
export const dataAgentToolJsonSchemas = Object.fromEntries(Object.entries(dataAgentInputSchemas)
  .map(([name, schema]) => [name, zodToJsonSchema(schema, { $refStrategy: 'none' })])) as Record<DataAgentToolName, Record<string, unknown>>;
