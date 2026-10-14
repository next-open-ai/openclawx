import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {DocumentInfoSchema} from './documents.js';

export const workResultInputs={
  search_work_results:z.object({query:z.string().trim().max(120).default(''),scope:z.enum(['current','history']).default('current'),limit:z.number().int().min(1).max(20).default(10)}).strict(),
  read_work_result:z.object({assetId:z.string().uuid().optional(),runId:z.string().uuid().optional()}).strict().refine(value=>Boolean(value.assetId)!==Boolean(value.runId),'请选择一个成果ID'),
};
export type WorkResultToolName=keyof typeof workResultInputs;
export const workResultJsonSchemas=Object.fromEntries(Object.entries(workResultInputs).map(([name,schema])=>[name,zodToJsonSchema(schema,{$refStrategy:'none'})])) as Record<WorkResultToolName,Record<string,unknown>>;
export const WorkResultItemSchema=z.object({
  kind:z.enum(['asset','run']),id:z.string().uuid(),name:z.string().max(240),createdAt:z.number(),
  conversationId:z.string().uuid().optional(),projectId:z.string().optional(),runId:z.string().uuid().optional(),
  mimeType:z.string().optional(),sizeBytes:z.number().optional(),status:z.string().optional(),summary:z.string().max(600).optional(),
}).strict();
export type WorkResultItem=z.infer<typeof WorkResultItemSchema>;
export const WorkResultMatchesSchema=z.object({matches:z.array(z.object({kind:z.enum(['asset','run']),id:z.string().uuid(),confidence:z.number().min(0).max(1)}).strict()).max(60)}).strict();
export type WorkResultRanking={status:'ranked'|'unavailable';matches:z.infer<typeof WorkResultMatchesSchema>['matches']};
export type WorkResultRanker=(query:string,candidates:WorkResultItem[],signal?:AbortSignal)=>Promise<WorkResultRanking>;
export const WorkLookupResultSchema=z.object({ok:z.boolean(),status:z.string(),code:z.string().optional(),spokenSummary:z.string().max(240),items:z.array(WorkResultItemSchema).max(20).optional(),text:z.string().max(16000).optional(),truncated:z.boolean().optional(),searchMode:z.enum(['keyword','semantic','fallback']).optional(),scope:z.enum(['current','history']).optional(),taskId:z.string().uuid().optional(),conversationId:z.string().uuid().optional(),documentInfo:DocumentInfoSchema.optional()}).strict();
export type WorkLookupResult=z.infer<typeof WorkLookupResultSchema>;
