import { structuredDataQuerySchema, type StructuredDataQuery, type StructuredDataQueryResult, type DataColumn, type DataQueryFilter, type DataQueryPredicate } from '@workmate/contracts';
import { randomUUID } from 'node:crypto';

export class StructuredQueryError extends Error {
  constructor(message: string, public code = 'INVALID_QUERY', public status = 400) { super(message); }
}
export type QueryDialect = 'sqlite' | 'mysql' | 'postgresql';
export type QueryTable = {
  name: string; schema?: string;
  alias?: string;
  joins?: Array<{ name: string; schema?: string; leftName: string; leftSchema?: string; alias: string; leftAlias: string; type: 'inner' | 'left'; keys: Array<{ left: string; right: string }> }>;
  columns: Array<Pick<DataColumn, 'id' | 'name' | 'type'> & { nativeName: string; tableAlias?: string }>;
  /** Trusted metadata only; rowid is used for registered local tables. */
  stableOrder?: readonly string[];
};
type Output = { id: string; name: string; type: string; expression: string };
export type CompiledQuery = {
  sql: string; params: unknown[]; fields: StructuredDataQueryResult['fields'];
  validationSql?: string;
  uniquenessSql: string[];
};
const numeric = (type: string) => type === '整数' || type === '小数';
const fail = (message: string): never => { throw new StructuredQueryError(message); };
const ident = (name: string, dialect: QueryDialect) => {
  if (!name || name.includes('\0')) return fail('数据表或字段绑定无效。');
  const q = dialect === 'mysql' ? '`' : '"';
  return q + name.replaceAll(q, q + q) + q;
};

// SQLite workbench stores imported cells as text. Validate decimal/scientific
// syntax before casting; SQLite CAST('bad' AS NUMERIC) must never become 0.
function validSqliteNumber(raw: string) {
  const t = `LOWER(TRIM(CAST(${raw} AS TEXT)))`;
  const pos = `INSTR(${t}, 'e')`;
  const mantissa = `(CASE WHEN ${pos}>0 THEN SUBSTR(${t},1,${pos}-1) ELSE ${t} END)`;
  const unsigned = (s: string) => `(CASE WHEN SUBSTR(${s},1,1) IN ('+','-') THEN SUBSTR(${s},2) ELSE ${s} END)`;
  const m = unsigned(mantissa), digits = `REPLACE(${m},'.','')`;
  const exponent = unsigned(`SUBSTR(${t},${pos}+1)`);
  return `(${digits}<>'' AND ${digits} NOT GLOB '*[^0-9]*' AND LENGTH(${m})-LENGTH(${digits})<=1 AND (${pos}=0 OR (${exponent}<>'' AND ${exponent} NOT GLOB '*[^0-9]*')))`;
}

export function compileStructuredQuery(input: StructuredDataQuery, table: QueryTable, dialect: QueryDialect): CompiledQuery {
  const parsed = structuredDataQuerySchema.safeParse(input);
  if (!parsed.success) fail(parsed.error.issues[0]?.message || '查询参数不正确。');
  const q = parsed.data as StructuredDataQuery;
  if (q.joins.length !== (table.joins?.length || 0)) fail('关联关系必须由数据网关登记信息解析。');
  const params: unknown[] = [], validations = new Set<string>();
  const bind = (v: unknown) => { params.push(v); return dialect === 'postgresql' ? `$${params.length}` : '?'; };
  const col = (id: string) => table.columns.find(c => c.id === id) ?? fail(`字段 ${id} 不在当前数据表中。`);
  const rawColumn = (id: string) => { const c = col(id); return (c.tableAlias ? ident(c.tableAlias, dialect) + '.' : '') + ident(c.nativeName, dialect); };
  const expression = (id: string) => {
    const c = col(id), raw = rawColumn(id);
    if (dialect === 'sqlite' && numeric(c.type)) {
      const cleaned = `NULLIF(TRIM(CAST(${raw} AS TEXT)),'')`;
      validations.add(`(${cleaned} IS NOT NULL AND (NOT ${validSqliteNumber(raw)} OR ABS(CAST(${raw} AS REAL))>1.7976931348623157e308))`);
      return `CAST(${cleaned} AS NUMERIC)`;
    }
    if (dialect === 'sqlite' && c.type === '布尔值') {
      const text = `LOWER(NULLIF(TRIM(CAST(${raw} AS TEXT)),''))`;
      validations.add(`(${text} IS NOT NULL AND ${text} NOT IN ('true','false','1','0'))`);
      return `(CASE WHEN ${text} IN ('true','1') THEN 1 WHEN ${text} IN ('false','0') THEN 0 ELSE NULL END)`;
    }
    if (dialect === 'sqlite' && c.type === '日期') {
      const clean = `NULLIF(TRIM(CAST(${raw} AS TEXT)),'')`;
      validations.add(`(${clean} IS NOT NULL AND (STRFTIME('%Y-%m-%d',SUBSTR(${clean},1,10),'+0 days') IS NULL OR STRFTIME('%Y-%m-%d',SUBSTR(${clean},1,10),'+0 days')<>SUBSTR(${clean},1,10)))`);
      return clean;
    }
    return raw;
  };
  const convertValue = (value: string | number | boolean, type: string) => {
    if (numeric(type)) {
      if (typeof value === 'boolean' || typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) fail('数值字段的筛选值必须是有效数字。');
      if (!Number.isFinite(Number(value))) fail('数值超出支持范围。');
      return value;
    }
    if (type === '日期') {
      if (typeof value !== 'string') return fail('日期筛选值请使用 ISO 日期或时间。');
      if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) fail('日期筛选值请使用 ISO 日期或时间。');
      const date = new Date(value.slice(0, 10));
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) fail('日期筛选值不是有效日期。');
    }
    if (type === '布尔值') {
      if (![true, false, 0, 1, 'true', 'false', '0', '1'].includes(value)) fail('布尔字段请使用 true/false。');
      const yes = value === true || value === 1 || value === 'true' || value === '1';
      return dialect === 'postgresql' ? yes : Number(yes);
    }
    if (type === '文本' && typeof value !== 'string') fail('文本字段的筛选值必须是字符串。');
    return value;
  };
  const predicate = (p: DataQueryPredicate, expr: string, type: string): string => {
    const op = p.operator;
    if (type === '布尔值' && !['eq', 'ne', 'in', 'notIn', 'isNull', 'isNotNull'].includes(op)) fail('布尔字段只支持相等、集合或空值筛选。');
    if (op === 'isNull' || op === 'isNotNull') return `${expr} IS ${op === 'isNotNull' ? 'NOT ' : ''}NULL`;
    if (op === 'contains' || op === 'startsWith') {
      if (type !== '文本') fail('模糊搜索仅适用于文本字段。');
      const escaped = p.value.replace(/[!%_]/g, '!$&');
      return `${expr} LIKE ${bind(`${op === 'contains' ? '%' : ''}${escaped}%`)} ESCAPE '!'`;
    }
    // Binding numeric strings to SQLite parameters needs explicit numeric
    // affinity: CAST(column AS NUMERIC) on its own does not cover aggregate HAVING.
    const value = (v: string | number | boolean) => {
      const marker = bind(convertValue(v, type));
      return dialect === 'sqlite' && numeric(type) ? `CAST(${marker} AS NUMERIC)` : marker;
    };
    if ('values' in p) {
      if (op === 'between') return `${expr} BETWEEN ${value(p.values[0])} AND ${value(p.values[1])}`;
      return `${expr} ${op === 'notIn' ? 'NOT IN' : 'IN'} (${p.values.map(value).join(', ')})`;
    }
    if ('value' in p) {
      const symbol = ({ eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as Partial<Record<DataQueryPredicate['operator'], string>>)[op];
      if (!symbol) return fail('不支持的筛选操作符。');
      return `${expr} ${symbol} ${value(p.value)}`;
    }
    return fail('不支持的筛选条件。');
  };
  const filter = (f: DataQueryFilter): string => 'logic' in f
    ? '(' + f.conditions.map(filter).join(f.logic === 'and' ? ' AND ' : ' OR ') + ')'
    : '(' + predicate(f, expression(f.fieldId), col(f.fieldId).type) + ')';
  const aggregate = Boolean(q.dimensions.length || q.metrics.length);
  const outputs: Output[] = [];
  const groups: string[] = [];
  for (const d of q.dimensions) {
    const c = col(d.fieldId);
    let expr = expression(d.fieldId);
    if (d.grain) {
      if (c.type !== '日期') fail('日期分组只适用于日期字段，请先确认字段类型。');
      const format = { year: '%Y', month: '%Y-%m', day: '%Y-%m-%d' }[d.grain];
      if (dialect === 'sqlite') {
        const clean = `NULLIF(TRIM(CAST(${expr} AS TEXT)),'')`;
        validations.add(`(${clean} IS NOT NULL AND (STRFTIME('%Y-%m-%d',SUBSTR(${clean},1,10),'+0 days') IS NULL OR STRFTIME('%Y-%m-%d',SUBSTR(${clean},1,10),'+0 days')<>SUBSTR(${clean},1,10)))`);
        expr = `SUBSTR(${clean},1,${d.grain === 'year' ? 4 : d.grain === 'month' ? 7 : 10})`;
      } else if (dialect === 'mysql') expr = `DATE_FORMAT(${expr}, '${format}')`;
      else expr = `TO_CHAR(${expr}, '${{ year: 'YYYY', month: 'YYYY-MM', day: 'YYYY-MM-DD' }[d.grain]}')`;
    }
    groups.push(expr); outputs.push({ id: d.fieldId, name: c.name, type: d.grain ? '文本' : c.type, expression: expr });
  }
  for (const m of q.metrics) {
    const c = m.fieldId ? col(m.fieldId) : undefined;
    if ((m.operation === 'sum' || m.operation === 'avg') && (!c || !numeric(c.type))) fail('求和和平均值只支持数值字段。');
    if (c?.type === '布尔值' && (m.operation === 'min' || m.operation === 'max')) fail('布尔字段仅支持计数或去重计数。');
    if (m.operation !== 'count' && !c) fail('统计指标缺少字段。');
    let expr = c ? expression(c.id) : '*';
    if (m.filters) expr = `CASE WHEN ${filter(m.filters)} THEN ${c ? expr : '1'} ELSE NULL END`;
    const metric = m.operation === 'countDistinct' ? `COUNT(DISTINCT ${expr})` : `${m.operation.toUpperCase()}(${expr})`;
    outputs.push({ id: m.alias, name: m.alias, type: m.operation === 'min' || m.operation === 'max' ? c!.type : m.operation === 'count' || m.operation === 'countDistinct' ? '整数' : '小数', expression: metric });
  }
  if (!aggregate) for (const id of q.fields || table.columns.map(c => c.id)) {
    const c = col(id); outputs.push({ id, name: c.name, type: c.type, expression: expression(id) });
  }
  if (!outputs.length) fail('没有可返回的字段。');
  const qualified = (t: { name: string; schema?: string }) => (t.schema ? ident(t.schema, dialect) + '.' : '') + ident(t.name, dialect);
  let from = qualified(table) + (table.alias ? ' AS ' + ident(table.alias, dialect) : '');
  const uniquenessSql: string[] = [];
  for (const j of table.joins || []) {
    from += ` ${j.type.toUpperCase()} JOIN ${qualified(j)} AS ${ident(j.alias, dialect)} ON ` + j.keys.map(k => `${ident(j.leftAlias, dialect)}.${ident(k.left, dialect)}=${ident(j.alias, dialect)}.${ident(k.right, dialect)}`).join(' AND ');
    const keys = j.keys.map(k => ident(k.right, dialect));
    uniquenessSql.push(`SELECT 1 FROM ${qualified(j)} WHERE ${keys.map(k => `${k} IS NOT NULL`).join(' AND ')} GROUP BY ${keys.join(', ')} HAVING COUNT(*)>1 LIMIT 1`);
    // Native coercion/collation can match several distinct target keys (e.g.
    // numeric 1 versus text '01'/'1'). Check actual join equality as well.
    const leftKeys = j.keys.map(k => ident(k.left, dialect)), leftAlias = ident('sdq_keys', dialect), rightAlias = ident('sdq_check', dialect);
    uniquenessSql.push(`SELECT 1 FROM (SELECT DISTINCT ${leftKeys.join(', ')} FROM ${qualified({ name: j.leftName, schema: j.leftSchema })} WHERE ${leftKeys.map(k => `${k} IS NOT NULL`).join(' AND ')}) AS ${leftAlias} INNER JOIN ${qualified(j)} AS ${rightAlias} ON ${j.keys.map(k => `${leftAlias}.${ident(k.left, dialect)}=${rightAlias}.${ident(k.right, dialect)}`).join(' AND ')} GROUP BY ${leftKeys.map(k => `${leftAlias}.${k}`).join(', ')} HAVING COUNT(*)>1 LIMIT 1`);
  }
  const where = q.filters ? ' WHERE ' + filter(q.filters) : '';
  const having = q.having.length ? ' WHERE ' + q.having.map(p => {
    const metric = outputs.find(o => o.id === p.fieldId && q.metrics.some(m => m.alias === p.fieldId)) ?? fail('HAVING 必须引用已声明的指标别名。');
    return '(' + predicate(p, ident(metric.id, dialect), metric.type) + ')';
  }).join(' AND ') : '';
  const orders: Array<{ expression: string; direction: 'asc' | 'desc' }> = q.orderBy.map(o => {
    const out = outputs.find(f => f.id === o.fieldId);
    if (!out && aggregate) fail('统计排序必须引用返回的分组字段或指标。');
    return { expression: out ? aggregate ? ident(out.id, dialect) : out.expression : expression(o.fieldId), direction: o.direction };
  });
  // Append deterministic tie-breakers. Global aggregate is a single row.
  const tieBreakers = aggregate ? q.dimensions.map(d => ident(d.fieldId, dialect)) : table.stableOrder?.length ? table.stableOrder.map(n => (table.alias ? ident(table.alias, dialect) + '.' : '') + ident(n, dialect)) : table.columns.map(c => expression(c.id));
  for (const expr of tieBreakers) if (!orders.some(o => o.expression === expr)) orders.push({ expression: expr, direction: 'asc' });
  const order = orders.length ? ' ORDER BY ' + orders.flatMap(o => [`CASE WHEN ${o.expression} IS NULL THEN 1 ELSE 0 END ASC`, `${o.expression} ${o.direction.toUpperCase()}`]).join(', ') : '';
  return {
    sql: (aggregate ? 'SELECT * FROM (' : '') + `SELECT ${outputs.map(o => `${o.expression} AS ${ident(o.id, dialect)}`).join(', ')} FROM ${from}${where}${groups.length ? ' GROUP BY ' + groups.join(', ') : ''}` + (aggregate ? `) AS ${ident('sdq_result', dialect)}${having}` : '') + `${order} LIMIT ${q.limit + 1} OFFSET ${q.offset}`,
    params, fields: outputs.map(({ expression: _expression, ...f }) => f),
    uniquenessSql,
    // Validate referenced local numeric/date columns across the authorized table
    // before applying filters, so bad casts cannot silently exclude rows.
    validationSql: validations.size ? `SELECT 1 FROM ${from} WHERE ${[...validations].join(' OR ')} LIMIT 1` : undefined,
  };
}

export function structuredQueryResult(q: StructuredDataQuery, compiled: CompiledQuery, records: Record<string, unknown>[], storageMode: StructuredDataQueryResult['storageMode']): StructuredDataQueryResult {
  const rows = records.slice(0, q.limit).map(row => Object.fromEntries(compiled.fields.map(f => {
    const v = row[f.id];
    if (typeof v === 'number' && !Number.isFinite(v)) throw new StructuredQueryError('计算结果超出数值范围，请调整查询。', 'NUMERIC_OVERFLOW');
    return [f.id, v == null ? null : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ? v : String(v)];
  })));
  if (Buffer.byteLength(JSON.stringify(rows)) > 4 * 1024 * 1024) throw new StructuredQueryError('查询结果超过 4 MB，请减少字段或行数。', 'RESULT_TOO_LARGE', 413);
  const hasMore = records.length > q.limit;
  return { queryId: randomUUID(), sourceId: q.sourceId, tableId: q.tableId, storageMode, queriedAt: new Date().toISOString(), fields: compiled.fields, rows, limit: q.limit, offset: q.offset, hasMore, nextOffset: hasMore && q.offset + q.limit <= 10000 ? q.offset + q.limit : null };
}

export function executeLocalStructuredQuery(db: { exec(sql: string, params?: unknown[]): Array<{ columns?: string[]; values?: unknown[][] }> }, q: StructuredDataQuery, table: QueryTable, mode: 'snapshot' | 'local') {
  const compiled = compileStructuredQuery(q, table, 'sqlite');
  for (const sql of compiled.uniquenessSql) if (db.exec(sql)[0]?.values?.length) throw new StructuredQueryError('关联目标键不唯一，联表会重复累计；请修正关系或数据。', 'JOIN_CARDINALITY_VIOLATION', 409);
  if (compiled.validationSql && db.exec(compiled.validationSql)[0]?.values?.length) throw new StructuredQueryError('数值、日期或布尔字段包含无效数据，请修正数据或字段类型后重试。', 'INVALID_STORED_VALUE');
  const result = db.exec(compiled.sql, compiled.params)[0];
  const records = (result?.values || []).map(values => Object.fromEntries((result?.columns || []).map((name, i) => [name, values[i]])));
  return structuredQueryResult(q, compiled, records, mode);
}
