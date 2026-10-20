import type { DataRelation, StructuredDataQuery } from '@openclawx/contracts';
import { StructuredQueryError, type QueryTable } from './structured-query.js';

type Resource = { id: string; columns: Array<{ id: string; type: string }> };
export function validateRelations(relations: DataRelation[], resources: Resource[]) {
  for (const r of relations) {
    const from = resources.find(t => t.id === r.fromTableId), to = resources.find(t => t.id === r.toTableId);
    if (!from || !to || from.id === to.id) throw new StructuredQueryError('关系必须连接当前对象中的两张不同表。', 'INVALID_RELATION');
    const left = new Set<string>(), right = new Set<string>();
    for (const k of r.keys) {
      const a = from.columns.find(c => c.id === k.fromFieldId), b = to.columns.find(c => c.id === k.toFieldId);
      if (!a || !b || a.type !== b.type || left.has(a.id) || right.has(b.id)) throw new StructuredQueryError('关联键必须存在、类型一致且不重复。', 'INVALID_RELATION');
      left.add(a.id); right.add(b.id);
    }
  }
}

/** Called only after resolving every resource from the same owner-scoped object. */
export function resolveQueryRelations(q: StructuredDataQuery, relations: DataRelation[], tables: Map<string, QueryTable>): QueryTable {
  const base = tables.get(q.tableId);
  if (!base) throw new StructuredQueryError('数据表不存在或无权访问。', 'DATA_NOT_FOUND', 404);
  if (!q.joins?.length) return base;
  validateRelations(relations, [...tables].map(([id, table]) => ({ id, columns: table.columns })));
  const aliases = new Map([[q.tableId, 'sdq_t0']]);
  const columns = base.columns.map(c => ({ ...c, tableAlias: 'sdq_t0' }));
  const joins: NonNullable<QueryTable['joins']> = [];
  for (const j of q.joins) {
    const r = relations.find(r => r.id === j.relationId);
    if (!r || !aliases.has(r.fromTableId) || aliases.has(r.toTableId)) throw new StructuredQueryError('关联关系未登记、顺序无效或包含重复表，请从基础表沿登记方向选择。', 'INVALID_RELATION');
    const from = tables.get(r.fromTableId)!, to = tables.get(r.toTableId)!;
    const alias = `sdq_t${aliases.size}`, leftAlias = aliases.get(r.fromTableId)!;
    joins.push({ name: to.name, schema: to.schema, leftName: from.name, leftSchema: from.schema, alias, leftAlias, type: j.type,
      keys: r.keys.map(k => ({ left: from.columns.find(c => c.id === k.fromFieldId)!.nativeName, right: to.columns.find(c => c.id === k.toFieldId)!.nativeName })) });
    aliases.set(r.toTableId, alias);
    columns.push(...to.columns.map(c => ({ ...c, id: `${r.toTableId}::${c.id}`, tableAlias: alias })));
  }
  return { ...base, alias: 'sdq_t0', columns, joins };
}
