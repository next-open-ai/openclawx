import mysql from 'mysql2/promise';
import pg from 'pg';
import type { DataColumn, RemoteDatabaseConnection, RemoteDatabaseImport } from '@workmate/contracts';

export type RemoteSession = {
  query(sql: string, values?: unknown[]): Promise<Record<string, unknown>[]>;
  execute?(sql: string, values?: unknown[]): Promise<number>;
  close(): Promise<void>; destroy(): void;
};
export type RemoteFactory = (connection: RemoteDatabaseConnection) => Promise<RemoteSession>;
export const remoteFactory: RemoteFactory = async c => {
  const ssl = c.tls ? { rejectUnauthorized: true, ...(c.ca ? { ca: c.ca } : {}) } : undefined;
  if (c.engine === 'mysql') {
    const client = await mysql.createConnection({ host: c.host, port: c.port, user: c.user, password: c.password,
      ...(c.database ? { database: c.database } : {}), ssl, connectTimeout: 10_000,
      multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
    return {
      async query(sql, values = []) {
        const [rows] = await client.query({ sql, timeout: 10_000 }, values);
        return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
      },
      async execute(sql, values = []) {
        const [result] = await client.query({ sql, timeout: 10_000 }, values);
        return Number((result as { affectedRows?: number }).affectedRows || 0);
      },
      close: () => client.end(), destroy: () => client.destroy(),
    };
  }
  const client = new pg.Client({ host: c.host, port: c.port, user: c.user, password: c.password,
    database: c.database || 'postgres', ssl: ssl || false, connectionTimeoutMillis: 10_000,
    query_timeout: 10_000, statement_timeout: 10_000,
    // Preserve microseconds and timezone representation for primary keys and conflict checks.
    types: { getTypeParser: (oid: number, format?: 'text' | 'binary') => [1082, 1114, 1184].includes(oid) && format !== 'binary' ? (value: string) => value : pg.types.getTypeParser(oid, format) },
  });
  // Client-level errors must not become uncaught exceptions when an idle socket closes.
  client.on('error', () => undefined);
  try { await client.connect(); } catch (error) { await client.end().catch(() => undefined); throw error; }
  return {
    async query(sql, values = []) { return (await client.query(sql, values)).rows; },
    async execute(sql, values = []) { return Number((await client.query(sql, values)).rowCount || 0); },
    close: () => client.end(), destroy: () => { void client.end().catch(() => undefined); },
  };
};

export function remoteError(error: unknown): string {
  if (error instanceof RemoteInputError) return error.message;
  const code = String((error as { code?: unknown })?.code || '');
  if (['ER_ACCESS_DENIED_ERROR', '28P01', '28000'].includes(code)) return '账号或密码不正确，或账号无权连接。';
  if (['ER_BAD_DB_ERROR', '3D000'].includes(code)) return '数据库不存在或当前账号无权访问。';
  if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNRESET'].includes(code)) return '无法连接数据库，请检查地址、端口、网络与防火墙。';
  if (['ER_TABLEACCESS_DENIED_ERROR', '42501'].includes(code)) return '账号没有读取该表的权限，请使用只读账号并授予所选表的查询权限。';
  if (code.includes('CERT') || code.includes('TLS') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') return 'TLS 证书校验失败，请填写可信 CA，或联系数据库管理员。';
  return '数据库读取失败或超时，请检查连接、读取权限和 TLS 设置。原有快照未修改。';
}

export function remoteIdentifier(engine: RemoteDatabaseConnection['engine'], name: string) {
  if (!name || name.includes('\0') || name.length > 128) throw new Error('标识符无效');
  return engine === 'mysql' ? '`' + name.replace(/`/g, '``') + '`' : '"' + name.replace(/"/g, '""') + '"';
}

let activeOperations = 0;
export class RemoteBusyError extends Error {}
export class RemoteInputError extends Error {}
export async function session<T>(c: RemoteDatabaseConnection, factory: RemoteFactory, action: (s: RemoteSession) => Promise<T>): Promise<T> {
  if (activeOperations >= 2) throw new RemoteBusyError('数据库连接任务较多，请稍后重试。');
  activeOperations++;
  let s: RemoteSession | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    return await Promise.race([
      (async () => {
        s = await factory(c);
        if (expired) { s.destroy(); throw new Error('连接已超时'); }
        const actual = s;
        return action({
          query: (sql, values) => { if (expired) throw new Error('连接已超时'); return actual.query(sql, values); },
          execute: actual.execute ? (sql, values) => { if (expired) throw new Error('连接已超时'); return actual.execute!(sql, values); } : undefined,
          close: () => actual.close(), destroy: () => actual.destroy(),
        });
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; s?.destroy(); reject(new Error('数据库操作超时')); }, 90_000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    s?.destroy();
    activeOperations--;
  }
}

export async function tables(s: RemoteSession, c: RemoteDatabaseConnection) {
  const rows = c.engine === 'mysql'
    ? await s.query("SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, TABLE_COMMENT AS description, ENGINE AS table_engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME LIMIT 1001", [c.database])
    : await s.query("SELECT n.nspname AS schema_name, c.relname AS table_name, COALESCE(obj_description(c.oid), '') AS description FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND has_table_privilege(c.oid,'SELECT') ORDER BY n.nspname, c.relname LIMIT 1001");
  if (rows.length > 1000) throw new RemoteInputError('数据库超过 1,000 张业务表，请接入较小的数据库。');
  return rows.map(r => ({ schema: String(r.schema_name), name: String(r.table_name), description: String(r.description || '').slice(0, 4000), transactional: c.engine === 'postgresql' || String(r.table_engine).toUpperCase() === 'INNODB' }));
}

export async function inspectRemoteDatabase(c: RemoteDatabaseConnection, factory = remoteFactory) {
  return session(c, factory, async s => {
    const rows = c.engine === 'mysql'
      ? await s.query("SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY SCHEMA_NAME LIMIT 1000")
      : await s.query('SELECT datname AS name FROM pg_database WHERE datallowconn AND NOT datistemplate AND has_database_privilege(datname, \'CONNECT\') ORDER BY datname LIMIT 1000');
    return { databases: rows.map(r => String(r.name)), tables: c.database ? await tables(s, c) : [] };
  });
}

export function columnType(type: string): DataColumn['type'] {
  if (/bool/i.test(type)) return '布尔值';
  if (/^bit(?:\(|$)/i.test(type)) return '整数';
  if (/int|serial/i.test(type)) return '整数';
  if (/numeric|decimal|float|double|real|money/i.test(type)) return '小数';
  if (/date|time/i.test(type)) return '日期';
  return '文本';
}
export function cell(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return '[二进制数据]';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export async function importRemoteDatabase(input: RemoteDatabaseImport, factory = remoteFactory) {
  const c = input.connection;
  return session(c, factory, async s => {
    const available = await tables(s, c);
    const selected = input.tables.map(t => {
      const found = available.find(a => a.schema === t.schema && a.name === t.name);
      if (!found) throw new RemoteInputError('所选数据表不存在或不可读取，请重新读取表列表。');
      return found;
    });
    await s.query(c.engine === 'mysql' ? 'START TRANSACTION READ ONLY' : 'BEGIN READ ONLY');
    let bytes = 0;
    const truncatedTables: string[] = [];
    const discovered = [];
    for (const table of selected) {
      const cols = c.engine === 'mysql'
        ? await s.query('SELECT COLUMN_NAME AS name, DATA_TYPE AS data_type, IS_NULLABLE AS nullable, COLUMN_COMMENT AS description FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [table.schema, table.name])
        : await s.query("SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS data_type, CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable, COALESCE(col_description(c.oid,a.attnum),'') AS description FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", [table.schema, table.name]);
      if (!cols.length || cols.length > 200) throw new RemoteInputError('每张表需包含 1–200 个可读取字段。');
      const names = cols.map(col => String(col.name));
      const qualified = remoteIdentifier(c.engine, table.schema) + '.' + remoteIdentifier(c.engine, table.name);
      const records = await s.query(`SELECT ${names.map(n => remoteIdentifier(c.engine, n)).join(', ')} FROM ${qualified} LIMIT 20001`);
      const sheetName = `${table.schema}.${table.name}`;
      if (records.length > 20_000) truncatedTables.push(sheetName);
      const rows = records.slice(0, 20_000).map(r => names.map(n => cell(r[n])));
      bytes += Buffer.byteLength(JSON.stringify(rows));
      if (bytes > 20 * 1024 * 1024) throw new RemoteInputError('所选数据合计超过 20 MB，请减少选表或先在源库整理数据。');
      const columns = cols.map((col, i): DataColumn => ({
        id: `c_${i + 1}`, name: names[i].slice(0, 100), sourceName: names[i], type: columnType(String(col.data_type)),
        nullable: col.nullable === 'YES', sample: rows.find(row => row[i] !== null)?.[i] || '', description: String(col.description || '').slice(0, 1000),
      }));
      discovered.push({ name: table.name, sheetName: qualified, description: table.description, rows, columns });
    }
    await s.query('ROLLBACK');
    return { discovered, truncatedTables };
  });
}
