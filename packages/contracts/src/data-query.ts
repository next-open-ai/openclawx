import { z } from 'zod';

const id = z.string().min(1).max(128);
const scalar = z.union([z.string().max(8192), z.number().finite(), z.boolean()]);
export const dataQueryPredicateSchema = z.union([
  z.object({ fieldId: id, operator: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']), value: scalar }).strict(),
  z.object({ fieldId: id, operator: z.enum(['contains', 'startsWith']), value: z.string().max(120) }).strict(),
  z.object({ fieldId: id, operator: z.enum(['in', 'notIn']), values: z.array(scalar).min(1).max(100) }).strict(),
  z.object({ fieldId: id, operator: z.literal('between'), values: z.tuple([scalar, scalar]) }).strict(),
  z.object({ fieldId: id, operator: z.enum(['isNull', 'isNotNull']) }).strict(),
]);

// Fixed-depth construction rejects deeply nested input before recursive compilation.
const group = <T extends z.ZodTypeAny>(child: T) => z.object({ logic: z.enum(['and', 'or']), conditions: z.array(child).min(1).max(50) }).strict();
const level1 = z.union([dataQueryPredicateSchema, group(dataQueryPredicateSchema)]);
const level2 = z.union([dataQueryPredicateSchema, group(level1)]);
export const dataQueryFilterSchema = z.union([dataQueryPredicateSchema, group(level2)]);
export type DataQueryPredicate = z.infer<typeof dataQueryPredicateSchema>;
export type DataQueryFilter = DataQueryPredicate | { logic: 'and' | 'or'; conditions: DataQueryFilter[] };

export const structuredDataQuerySchema = z.object({
  sourceId: id, tableId: id,
  joins: z.array(z.object({ relationId: id, type: z.enum(['inner', 'left']).default('left') }).strict()).max(3).default([]),
  fields: z.array(id).min(1).max(200).optional(),
  filters: dataQueryFilterSchema.optional(),
  dimensions: z.array(z.object({ fieldId: id, grain: z.enum(['year', 'month', 'day']).optional() }).strict()).max(10).default([]),
  metrics: z.array(z.object({
    fieldId: id.optional(), operation: z.enum(['sum', 'count', 'avg', 'min', 'max', 'countDistinct']),
    alias: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
    filters: dataQueryFilterSchema.optional(),
  }).strict()).max(20).default([]),
  having: z.array(dataQueryPredicateSchema).max(20).default([]),
  orderBy: z.array(z.object({ fieldId: id, direction: z.enum(['asc', 'desc']).default('asc') }).strict()).max(10).default([]),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(10000).default(0),
}).strict().superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const aggregate = v.dimensions.length > 0 || v.metrics.length > 0;
  if (aggregate && v.fields) issue('分组统计时请使用 dimensions/metrics，不同时指定 fields。');
  if (!v.metrics.length && v.having.length) issue('HAVING 只支持已声明的统计指标。');
  if (v.metrics.some(m => !m.fieldId && m.operation !== 'count')) issue('除 count 外，统计指标必须指定字段。');
  const keys = [...v.dimensions.map(d => d.fieldId), ...v.metrics.map(m => m.alias)];
  if (new Set(keys.map(k => k.toLowerCase())).size !== keys.length || v.metrics.some(m => m.alias.toLowerCase().startsWith('sdq_'))) issue('分组字段与指标别名不能重复，sdq_ 为保留前缀。');
  if (v.fields && new Set(v.fields).size !== v.fields.length) issue('返回字段不能重复。');
  if (new Set(v.orderBy.map(o => o.fieldId)).size !== v.orderBy.length) issue('排序字段不能重复。');
  let count = 0;
  const visit = (node: DataQueryFilter) => { if ('logic' in node) node.conditions.forEach(visit); else count++; };
  if (v.filters) visit(v.filters as DataQueryFilter);
  v.metrics.forEach(m => { if (m.filters) visit(m.filters as DataQueryFilter); });
  if (new Set(v.joins.map(j => j.relationId)).size !== v.joins.length) issue('关联关系不能重复。');
  if (count > 50) issue('筛选条件不能超过 50 个。');
});
export type StructuredDataQuery = Omit<z.infer<typeof structuredDataQuerySchema>, 'filters' | 'having'> & { filters?: DataQueryFilter; having: DataQueryPredicate[] };
export type StructuredDataQueryResult = {
  queryId: string; sourceId: string; tableId: string; storageMode: 'live' | 'snapshot' | 'local'; queriedAt: string;
  fields: Array<{ id: string; name: string; type: string }>;
  rows: Array<Record<string, string | number | boolean | null>>;
  limit: number; offset: number; hasMore: boolean; nextOffset: number | null;
};
