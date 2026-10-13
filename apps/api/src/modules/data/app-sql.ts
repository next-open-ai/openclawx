import sqlParser from 'node-sql-parser';
import { dataAppParametersSchema, type DataAppSqlOperation } from '@workmate/contracts';
import { StructuredQueryError } from './structured-query.js';

export type SqlTable = {
  id: string; name: string; schema?: string; transactional?: boolean;
  columns: Array<{ id: string; name: string; sensitive?: boolean; primary?: boolean; generated?: boolean; nativeType?: string; nullable?: boolean; defaulted?: boolean }>;
};
export type SqlAction = 'select' | 'insert' | 'update' | 'delete';
export type SqlPlan = { sql: string; values: unknown[]; action: SqlAction; tableIds: string[] };
const parser = new sqlParser.Parser();
const functions = new Set(['COUNT','SUM','AVG','MIN','MAX','ROUND','ABS','COALESCE','NULLIF','LOWER','UPPER','LENGTH','TRIM','SUBSTR','SUBSTRING','CONCAT','YEAR','MONTH','DAY','DATE_FORMAT','STRFTIME','TO_CHAR','DATE_TRUNC']);
const nodeTypes = new Set(['select','update','insert','delete','column_ref','binary_expr','unary_expr','param','number','string','single_quote_string','double_quote_string','bool','null','star','aggr_func','function','expr_list','case','when','cast','values','dataType','origin','ASC','DESC','DISTINCT']);
function reject(message: string, code = 'APP_SQL_INVALID'): never { throw new StructuredQueryError(message, code, 400); }

/** Parser boundary. Only the re-serialized, checked AST is executable, never raw SQL. */
export function compileAppSql(operation: DataAppSqlOperation, tables: SqlTable[], dialect: 'mysql' | 'postgresql' | 'sqlite', raw: unknown): SqlPlan {
  const parameters = dataAppParametersSchema.parse(raw);
  const declared = new Map(operation.parameters.map(p => [p.name, p]));
  for (const name of Object.keys(parameters)) if (!declared.has(name)) reject(`未知参数：${name}`);
  for (const p of operation.parameters) {
    const value = Object.hasOwn(parameters, p.name) ? parameters[p.name] : p.default;
    if (value === undefined && p.required) reject(`请填写参数：${p.name}`);
    if (value !== undefined && typeof value !== p.type) reject(`参数 ${p.name} 应为 ${p.type}`);
  }
  // Use one canonical grammar; physical dialect is applied only after authorization.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ast: any;
  try { ast = parser.astify(operation.sql, { database: 'MySQL' }); } catch { reject('SQL 语法不支持，请使用单条 SELECT/INSERT/UPDATE/DELETE 与 :name 参数。'); }
  if (Array.isArray(ast)) { if (ast.length !== 1) reject('只允许一条 SQL。'); ast = ast[0]; }
  if (!['select','insert','update','delete'].includes(ast?.type)) reject('不支持 DDL、管理命令或其他 SQL。');
  const action = ast.type as SqlAction;
  // sqlify does not escape embedded identifier quotes. Reject unusual bindings
  // rather than let database metadata or a quoted alias become SQL syntax.
  const safeIdentifier = (name: string) => { if (!/^[\p{L}\p{N}_$ -]{1,128}$/u.test(name)) reject('表/字段名称含不支持的特殊字符，请使用结构化查询。'); return name; };
  for (const key of ['with','_next','set_op','options','locking_read','window','collate','partition','on_duplicate_update','returning']) if (ast[key]) reject(`当前不支持 SQL ${key}。`);
  if (ast.into?.position) reject('不允许 SELECT INTO 或文件输出。');
  const refs = action === 'select' || action === 'delete' ? ast.from : ast.table;
  if (!Array.isArray(refs) || !refs.length || refs.length > 4 || (action !== 'select' && refs.length !== 1)) reject('需要当前对象内的表；写入仅支持单表。');
  const bindings = refs.map(ref => {
    if (!ref.table || ref.db || ref.expr || ref.suffix || ref.hint || ref.tablesample) reject('禁止跨库名称、子查询、表函数或提示。');
    const t = tables.find(t => t.id === ref.table);
    if (!t) reject('表不在当前应用范围内，请使用对象表 ID。', 'APP_SCOPE_EXCEEDED');
    if (ref.join && !['INNER JOIN','LEFT JOIN','JOIN'].includes(ref.join)) reject('只支持 INNER/LEFT JOIN。');
    safeIdentifier(t.name); if (t.schema) safeIdentifier(t.schema);
    return { ref, table: t, alias: safeIdentifier(ref.as || ref.table) };
  });
  if (new Set(bindings.map(b => b.alias)).size !== bindings.length) reject('表别名不可重复。');
  const outputs = new Set<string>();
  if (action === 'select') {
    if (!Array.isArray(ast.columns) || ast.columns.length > 100) reject('请明确列出返回字段，不能 SELECT *。');
    for (const c of ast.columns) {
      if (!c.as && c.expr?.type === 'column_ref' && c.expr.column !== '*') c.as = c.expr.column;
      if (!c.as || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(c.as) || outputs.has(c.as)) reject('返回字段须使用不重复的字母/数字别名。');
      outputs.add(c.as);
    }
  }
  const column = (id: string, qualifier?: string) => {
    const candidates = bindings.filter(b => (!qualifier || b.alias === qualifier) && b.table.columns.some(c => c.id === id));
    if (candidates.length !== 1) reject(`字段 ${id} 不存在或有歧义，请使用表别名限定。`);
    const b = candidates[0], c = b.table.columns.find(c => c.id === id)!;
    if (c.sensitive) reject('敏感字段不可用于应用操作。', 'DATA_FIELD_RESTRICTED');
    safeIdentifier(c.name);
    return { b, c };
  };
  const target = bindings[0].table;
  const checkValue = (c: SqlTable['columns'][number], node: any) => {
    if (!/^bit(?:\(|$)/i.test(c.nativeType || '')) return;
    const value = node?.type === 'param' ? (Object.hasOwn(parameters, node.value) ? parameters[node.value] : declared.get(node.value)?.default)
      : node?.type === 'number' ? Number(node.value) : node?.type === 'bool' ? node.value : undefined;
    if (value === null && c.nullable) return;
    if (typeof value !== 'boolean' && !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) reject(`字段 ${c.id} 为 ${c.nativeType}，请使用数值/布尔参数，不能写字符串 '0'/'1'。`, 'APP_SQL_FIELD_TYPE');
    if (/^bit(?:\(1\))?$/i.test(c.nativeType || '') && typeof value === 'number' && value > 1) reject(`字段 ${c.id} 仅接受 0/1。`, 'APP_SQL_FIELD_TYPE');
  };
  if (action !== 'select') {
    if (!target.transactional) reject('写入仅支持具有安全事务的实时表。');
    if (ast.orderby || ast.limit) reject('写入不支持排序或 LIMIT，请使用主键定位。');
    if (action === 'insert') {
      if (!Array.isArray(ast.columns) || ast.values?.type !== 'values' || ast.values.values?.length !== 1 || ast.values.values[0].value.length !== ast.columns.length) reject('仅支持显式字段的单行 INSERT VALUES。');
      const assigned = new Set(ast.columns);
      if (target.columns.some(c => c.nullable === false && c.defaulted === false && !c.generated && !assigned.has(c.id))) reject('新增 SQL 缺少无默认值的必填字段。', 'APP_SQL_REQUIRED_FIELD');
      ast.columns = ast.columns.map((id: string, index: number) => { const { c } = column(id); if (c.generated) reject('不能设置生成列。'); checkValue(c,ast.values.values[0].value[index]); return dialect === 'mysql' ? '`' + c.name + '`' : '"' + c.name + '"'; });
    } else {
      const keys = new Set(target.columns.filter(c => c.primary).map(c => c.id));
      if (!keys.size) reject('更新和删除需要完整主键。');
      // Full primary-key equality eliminates mass writes; no OR, expression or literals.
      const match = (n: any): void => {
        if (n?.type === 'binary_expr' && n.operator === 'AND') { match(n.left); match(n.right); return; }
        if (n?.type !== 'binary_expr' || n.operator !== '=' || n.left?.type !== 'column_ref' || n.right?.type !== 'param' || !keys.delete(n.left.column)) reject('WHERE 必须且只能使用完整主键 = :参数，并以 AND 连接。');
        const p = n.right.value;
        if ((Object.hasOwn(parameters, p) ? parameters[p] : declared.get(p)?.default) == null) reject('主键参数不能为空。');
      };
      match(ast.where); if (keys.size) reject('WHERE 缺少组合主键字段。');
      if (action === 'update') for (const assignment of ast.set || []) {
        const { c } = column(assignment.column, assignment.table);
        if (c.primary || c.generated) reject('不能修改主键或生成列。'); checkValue(c,assignment.value); assignment.column = c.name;
      }
    }
  }
  const values: unknown[] = [], used = new Set<string>();
  const bind = (node: any, value: unknown) => {
    values.push(dialect === 'sqlite' && typeof value === 'boolean' ? Number(value) : value);
    node.type = 'origin'; node.value = dialect === 'postgresql' ? `$${values.length}` : '?';
  };
  const visit = (node: any, parentKey = '', root = false): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) visit(n, parentKey); return; }
    if (node.type && !nodeTypes.has(node.type)) reject(`不支持的 SQL 表达式：${node.type}`);
    if (!root && ['select','update','insert','delete','origin'].includes(node.type)) reject('不支持嵌套 SQL 或原始表达式。');
    if (node.over || node.collate || node.db || node.schema) reject('不支持窗口、跨库或排序规则表达式。');
    if (node.type === 'function' || node.type === 'aggr_func') {
      const name = typeof node.name === 'string' ? node.name : node.name?.name?.map((n: any) => n.value).join('.');
      if (!functions.has(String(name).toUpperCase())) reject('函数不在安全计算函数列表中。');
    }
    if (node.type === 'column_ref') {
      if (node.column === '*') reject('请显式列出字段，不能使用 *。');
      if (!node.table && ['orderby','having'].includes(parentKey) && outputs.has(node.column)) return;
      const { b, c } = column(node.column, node.table);
      node.column = c.name; node.table = b.alias; return;
    }
    if (node.type === 'param') {
      const p = declared.get(node.value); if (!p) reject(`参数 ${node.value} 未声明。`);
      used.add(node.value);
      bind(node, Object.hasOwn(parameters, node.value) ? parameters[node.value] : p.default ?? null); return;
    }
    // Never emit MySQL-escaped string literals into another dialect. Bind them
    // too, so quote/backslash semantics cannot turn a checked AST into new SQL.
    if (['string','single_quote_string','double_quote_string'].includes(node.type)) {
      const text = String(node.value).replace(/''/g, "'").replace(/\\([0bnrtZ'"\\%_])/g, (_: string, c: string) => ({ '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a' }[c] ?? c));
      bind(node, text); return;
    }
    if (node.type === 'number') {
      const value = Number(node.value); if (!Number.isFinite(value)) reject('SQL 数值超出范围。'); bind(node, value); return;
    }
    if (node.type === 'bool') {
      bind(node, node.value === true || String(node.value).toLowerCase() === 'true'); return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'name' && ['function','aggr_func'].includes(node.type)) continue;
      if (['from','table'].includes(key) && root) { for (const b of bindings) if (b.ref.on) visit(b.ref.on); continue; }
      visit(value, parentKey || key);
    }
  };
  visit(ast, '', true);
  for (const p of declared.keys()) if (!used.has(p)) reject(`声明的参数 ${p} 未用于 SQL。`);
  for (const b of bindings) { b.ref.table = b.table.name; b.ref.db = b.table.schema || null; if (action === 'select' || action === 'update') b.ref.as = b.alias; }
  if (action === 'delete') { ast.table = null; bindings[0].ref.as = null;
    // DELETE has no alias in the portable single-table form.
    const strip = (n: any): void => { if (n && typeof n === 'object') { if (n.type === 'column_ref') n.table = null; Object.values(n).forEach(strip); } }; strip(ast.where);
  }
  let sql: string;
  try { sql = parser.sqlify(ast, { database: dialect === 'postgresql' ? 'Postgresql' : dialect === 'sqlite' ? 'SQLite' : 'MySQL' }); }
  catch { reject('当前数据库不支持此 SQL 形式，请简化语句。'); }
  if (action === 'select') sql = `SELECT * FROM (${sql}) AS ${dialect === 'mysql' ? '`wm_result`' : '"wm_result"'} LIMIT 201`;
  return { sql, values, action, tableIds: [...new Set(bindings.map(b => b.table.id))] };
}

export function appSqlResult(records: Record<string, unknown>[]) {
  const rows = records.slice(0, 200), fields = Object.keys(rows[0] || {}).map(id => ({ id, name: id, type: typeof rows[0][id] === 'number' ? '小数' : '文本' }));
  const result = { fields, rows, hasMore: records.length > 200, nextOffset: null, queriedAt: new Date().toISOString() };
  if (Buffer.byteLength(JSON.stringify(result)) > 256000) reject('结果超过 256KB，请减少字段或缩小范围。');
  return result;
}
