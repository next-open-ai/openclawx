import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DataColumn, RemoteDatabaseConnection, StructuredDataQuery } from '@workmate/contracts';
import { compileStructuredQuery, structuredQueryResult, StructuredQueryError, type QueryTable } from './structured-query.js';
import { cell, columnType, remoteIdentifier, session, tables, remoteFactory, RemoteInputError, type RemoteFactory } from './remote-database.js';

export type LiveColumn = { id: string; name: string; primary: boolean; generated: boolean; nullable: boolean; defaulted: boolean; nativeType?: string };
export type LiveTable = { schema: string; name: string; columns: LiveColumn[]; transactional?: boolean };
export class LiveDataError extends Error {
  constructor(message: string, public status = 400, public code = 'DATA_QUERY_FAILED') { super(message); }
}
const key = randomBytes(32);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const writable = (t: LiveTable) => t.transactional === true && t.columns.some(c => c.primary) && !t.columns.some(c => c.primary && c.generated && !c.defaulted);
export const isLiveTableWritable = writable;
const qualified = (c: RemoteDatabaseConnection, t: LiveTable) => `${remoteIdentifier(c.engine, t.schema)}.${remoteIdentifier(c.engine, t.name)}`;
const placeholder = (c: RemoteDatabaseConnection, n: number) => c.engine === 'mysql' ? '?' : `$${n}`;
const valuesOf = (t: LiveTable, row: Record<string, unknown>) => Object.fromEntries(t.columns.map(c => [c.id, cell(row[c.name])]));
function token(scope: string, t: LiveTable, row: Record<string, unknown>) {
  if (!writable(t)) return '';
  const data = Buffer.from(JSON.stringify({ scope, expires: Date.now() + 15 * 60_000, keys: t.columns.filter(c => c.primary).map(c => cell(row[c.name])), hash: hash(valuesOf(t, row)) })).toString('base64url');
  return `${data}.${createHmac('sha256', key).update(data).digest('base64url')}`;
}
function verify(id: string, scope: string, t: LiveTable): { keys: (string | null)[]; hash: string } {
  try {
    const [body, signature, extra] = id.split('.');
    const expected = createHmac('sha256', key).update(body).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const result = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (result.scope !== scope || result.expires < Date.now() || result.keys.length !== t.columns.filter(c => c.primary).length || result.keys.some((v: unknown) => v == null)) throw new Error();
    return result;
  } catch { throw new LiveDataError('记录已失效或不属于当前表，请刷新数据后重试。', 409); }
}

// Discovery reads metadata only. Native bindings live separately from editable annotations.
export async function readBoundTableMetadata(c: RemoteDatabaseConnection, t: LiveTable, factory: RemoteFactory = remoteFactory) {
  return session(c, factory, async s => {
    const rows = c.engine === 'mysql'
      ? await s.query('SELECT COLUMN_NAME AS name, DATA_TYPE AS data_type, IS_NULLABLE AS nullable, COLUMN_COMMENT AS description FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION LIMIT 201', [t.schema, t.name])
      : await s.query("SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS data_type, CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable, COALESCE(col_description(c.oid,a.attnum),'') AS description FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 201", [t.schema, t.name]);
    if (!rows.length || rows.length > 200) throw new LiveDataError('当前表结构已变化或字段过多，请先更新数据对象。', 409, 'DATA_SCHEMA_CHANGED');
    return t.columns.flatMap(col => {
      const row = rows.find(r => r.name === col.name);
      return row ? [{ fieldId: col.id, nativeType: String(row.data_type || '').slice(0, 100), nullable: row.nullable === 'YES', description: String(row.description || '').slice(0, 200) }] : [];
    });
  });
}
export async function discoverLiveTables(c: RemoteDatabaseConnection, selected: { schema: string; name: string }[], factory: RemoteFactory = remoteFactory) {
  return session(c, factory, async s => {
    const available = await tables(s, c);
    const result = [];
    for (const requested of selected) {
      const table = available.find(a => a.schema === requested.schema && a.name === requested.name);
      if (!table) throw new RemoteInputError('所选表不可读取，请重新选择。');
      const cols = c.engine === 'mysql'
        ? await s.query("SELECT COLUMN_NAME AS name, DATA_TYPE AS data_type, IS_NULLABLE AS nullable, COLUMN_COMMENT AS description, COLUMN_KEY AS key_type, EXTRA AS extra, COLUMN_DEFAULT AS default_value, GENERATION_EXPRESSION AS generated_expression FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", [table.schema, table.name])
        : await s.query("SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS data_type, CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable, COALESCE(col_description(c.oid,a.attnum),'') AS description, EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND a.attnum=ANY(i.indkey)) AS is_primary, a.attidentity AS identity_kind, a.attgenerated AS generated_kind, pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", [table.schema, table.name]);
      if (!cols.length || cols.length > 200) throw new RemoteInputError('每张表需包含 1–200 个字段。');
      const native: LiveColumn[] = cols.map((v, i) => ({ id: `c_${i + 1}`, name: String(v.name), nativeType: String(v.data_type), primary: v.key_type === 'PRI' || v.is_primary === true,
        generated: Boolean(v.generated_expression || v.generated_kind || v.identity_kind === 'a') || /auto_increment|GENERATED/i.test(String(v.extra || '')),
        nullable: v.nullable === 'YES', defaulted: v.default_value != null || Boolean(v.identity_kind) || /auto_increment/i.test(String(v.extra || '')) }));
      // Binary/complex primary keys cannot be faithfully addressed with the scalar Gateway.
      if (cols.some((v, i) => /bytea|blob|binary/i.test(String(v.data_type)) || native[i].primary && /json|\[\]/i.test(String(v.data_type)))) native.forEach(v => { v.primary = false; });
      const columns: DataColumn[] = cols.map((v, i) => ({ id: native[i].id, name: native[i].name.slice(0, 100), sourceName: native[i].name, type: columnType(String(v.data_type)), nullable: native[i].nullable, sample: '', description: String(v.description || '').slice(0, 1000) }));
      result.push({ name: table.name, sheetName: `${table.schema}.${table.name}`, description: table.description, columns, rows: [] as unknown[][], binding: { schema: table.schema, name: table.name, columns: native, transactional: table.transactional } });
    }
    return result;
  });
}

export async function queryLiveTable(c: RemoteDatabaseConnection, t: LiveTable, scope: string, input: { search?: string; limit?: number; fields?: string[] }, factory: RemoteFactory = remoteFactory) {
  const limit = Math.min(200, Math.max(1, Math.trunc(input.limit || 100)));
  const fields = input.fields?.length ? input.fields : t.columns.map(c => c.id);
  if (fields.some(id => !t.columns.some(c => c.id === id))) throw new LiveDataError('字段不在当前数据表中。');
  return session(c, factory, async s => {
    await s.query(c.engine === 'mysql' ? 'START TRANSACTION READ ONLY' : 'BEGIN READ ONLY');
    try {
      const params: unknown[] = [];
      const search = (input.search || '').slice(0, 120);
      const where = search ? ' WHERE ' + t.columns.map(col => {
        params.push(`%${search.replace(/[!%_]/g, '!$&')}%`);
        return `CAST(${remoteIdentifier(c.engine, col.name)} AS ${c.engine === 'mysql' ? 'CHAR' : 'TEXT'}) LIKE ${placeholder(c, params.length)} ESCAPE '!'`;
      }).join(' OR ') : '';
      const order = t.columns.filter(c => c.primary).map(col => remoteIdentifier(c.engine, col.name)).join(', ');
      const records = await s.query(`SELECT ${t.columns.map(col => remoteIdentifier(c.engine, col.name)).join(', ')} FROM ${qualified(c, t)}${where}${order ? ' ORDER BY ' + order : ''} LIMIT ${limit + 1}`, params);
      const rows = records.slice(0, limit).map(row => ({ id: token(scope, t, row), values: Object.fromEntries(Object.entries(valuesOf(t, row)).filter(([id]) => fields.includes(id))) }));
      if (Buffer.byteLength(JSON.stringify(rows)) > 4 * 1024 * 1024) throw new LiveDataError('查询结果超过 4 MB，请减少行数或缩小表范围。');
      return { rows, hasMore: records.length > limit, writable: writable(t) };
    } finally { await s.query('ROLLBACK').catch(() => undefined); }
  });
}

export function liveQueryTable(t: LiveTable, columns: DataColumn[]): QueryTable {
  return { name: t.name, schema: t.schema,
    columns: t.columns.map(native => {
      const column = columns.find(v => v.id === native.id);
      if (!column) throw new LiveDataError('字段绑定已失效，请重新检查数据对象。', 409);
      return { id: native.id, name: column.name, type: column.type, nativeName: native.name };
    }), stableOrder: t.columns.filter(v => v.primary).map(v => v.name) };
}
export async function queryLiveStructured(c: RemoteDatabaseConnection, t: LiveTable, columns: DataColumn[], input: StructuredDataQuery, factory: RemoteFactory = remoteFactory, resolved?: QueryTable) {
  const table = resolved ?? liveQueryTable(t, columns);
  const compiled = compileStructuredQuery(input, table, c.engine);
  return session(c, factory, async s => {
    if (input.joins?.length && c.engine === 'mysql') await s.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await s.query(c.engine === 'mysql' ? 'START TRANSACTION READ ONLY' : input.joins?.length ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN READ ONLY');
    try {
      for (const sql of compiled.uniquenessSql) if ((await s.query(sql)).length) throw new StructuredQueryError('关联目标键不唯一，联表会重复累计；请修正关系或数据。', 'JOIN_CARDINALITY_VIOLATION', 409);
      return structuredQueryResult(input, compiled, await s.query(compiled.sql, compiled.params), 'live');
    }
    finally { await s.query('ROLLBACK').catch(() => undefined); }
  });
}

export async function mutateLiveTable(c: RemoteDatabaseConnection, t: LiveTable, scope: string, operation: 'insert' | 'update' | 'delete', fields: Record<string, string | number | boolean | null>, recordId: string, factory: RemoteFactory = remoteFactory) {
  if (!writable(t)) throw new LiveDataError('该表没有可用主键或不支持安全事务，只支持查询。', 403);
  const entries = Object.entries(fields);
  if (operation !== 'delete' && !entries.length) throw new LiveDataError('请至少填写一个字段。');
  for (const [id, value] of entries) {
    const col = t.columns.find(col => col.id === id);
    if (!col || col.generated || (operation === 'update' && col.primary)) throw new LiveDataError('包含未知字段、自动生成字段或不可修改的主键。');
    if (value === null && !col.nullable) throw new LiveDataError(`字段 ${id} 不能为空。`);
  }
  if (operation === 'insert') for (const col of t.columns) {
    if (!col.nullable && !col.defaulted && !col.generated && !(col.id in fields)) throw new LiveDataError(`请填写必填字段 ${col.id}。`);
  }
  const version = operation === 'insert' ? null : verify(recordId, scope, t);
  let attemptedCommit = false;
  try {
    return await session(c, factory, async s => {
      if (!s.execute) throw new LiveDataError('此数据库驱动未提供安全写入能力。', 503);
      await s.query(c.engine === 'mysql' ? 'START TRANSACTION' : 'BEGIN');
      try {
        const params: unknown[] = [];
        let where = '';
        if (version) {
          where = t.columns.filter(col => col.primary).map((col, i) => { params.push(version.keys[i]); return `${remoteIdentifier(c.engine, col.name)}=${placeholder(c, params.length)}`; }).join(' AND ');
          const current = await s.query(`SELECT ${t.columns.map(col => remoteIdentifier(c.engine, col.name)).join(', ')} FROM ${qualified(c, t)} WHERE ${where} FOR UPDATE`, params);
          if (current.length !== 1 || hash(valuesOf(t, current[0])) !== version.hash) throw new LiveDataError('该记录已被修改或删除，请刷新后重新操作。', 409);
        }
        let sql: string;
        if (operation === 'insert') {
          params.push(...entries.map(([, v]) => v));
          sql = `INSERT INTO ${qualified(c, t)} (${entries.map(([id]) => remoteIdentifier(c.engine, t.columns.find(col => col.id === id)!.name)).join(', ')}) VALUES (${entries.map((_, i) => placeholder(c, i + 1)).join(', ')})`;
        } else if (operation === 'delete') sql = `DELETE FROM ${qualified(c, t)} WHERE ${where}`;
        else {
          // MySQL placeholders follow SQL appearance; PostgreSQL uses numbered bindings.
          const updates = entries.map(([id], i) => `${remoteIdentifier(c.engine, t.columns.find(col => col.id === id)!.name)}=${placeholder(c, params.length + i + 1)}`);
          const newValues = entries.map(([, v]) => v);
          if (c.engine === 'mysql') params.unshift(...newValues); else params.push(...newValues);
          sql = `UPDATE ${qualified(c, t)} SET ${updates.join(', ')} WHERE ${where}`;
        }
        const changed = await s.execute(sql, params);
        // MySQL may report 0 for an unchanged UPDATE; it was already locked and checked.
        if (changed !== 1 && !(operation === 'update' && c.engine === 'mysql' && changed === 0)) throw new LiveDataError('写入影响行数异常，已回滚。', 409);
        attemptedCommit = true;
        await s.query('COMMIT');
        return { ok: true, affectedRows: changed };
      } catch (error) { await s.query('ROLLBACK').catch(() => undefined); throw error; }
    });
  } catch (error) {
    if (error instanceof LiveDataError) throw error;
    if (attemptedCommit) throw new LiveDataError('提交时连接中断，结果可能已生效。请先刷新并核对原库，勿直接重复提交。', 502);
    const code = String((error as { code?: unknown })?.code || '');
    if (['ER_DUP_ENTRY', '23505'].includes(code)) throw new LiveDataError('主键或唯一字段重复，请修改后重试。', 409);
    if (['ER_TABLEACCESS_DENIED_ERROR', '42501', 'ER_DBACCESS_DENIED_ERROR'].includes(code)) throw new LiveDataError('数据库账号没有写入权限；对象授权不能代替数据库授权。', 403);
    throw new LiveDataError('数据库写入失败，未确认提交。请检查连接、字段约束和数据库权限，刷新核对后再操作。', 502);
  }
}
