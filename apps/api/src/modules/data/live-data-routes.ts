import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { savedDatabaseConnectionSchema, liveDataObjectCreateSchema, liveDataAccessSchema, liveDataRecordSchema, liveDataQuerySchema, type DataAppSqlOperation, type StructuredDataQuery, type LiveDataObjectInfo, type SavedDatabaseConnection, type DataColumn } from '@openclawx/contracts';
import { compileAppSql, appSqlResult } from './app-sql.js';
import { createSchemaChangeService, migrateSchemaChanges } from './schema-change-service.js';
import { session, remoteFactory, cell } from './remote-database.js';
import { StructuredQueryError } from './structured-query.js';
import type { DataObjectAnnotations } from '@openclawx/contracts';
import { resolveQueryRelations } from './query-relations.js';
import { liveQueryTable, readBoundTableMetadata } from './live-database.js';
import { requireAuth } from '../auth/service.js';
import { withKeyLock } from '@openclawx/orchestrator';
import { databaseCredentialPersistence, databaseSecret } from './database-secrets.js';
import { inspectRemoteDatabase, remoteError, RemoteBusyError, RemoteInputError, type RemoteFactory } from './remote-database.js';
import { discoverLiveTables, queryLiveTable, queryLiveStructured, mutateLiveTable, isLiveTableWritable, LiveDataError, type LiveTable } from './live-database.js';

type Db = { exec(sql: string, values?: unknown[]): { values?: unknown[][] }[]; run(sql: string, values?: unknown[]): void };
type Auth = { userId: string; orgId: string };
type Binding = { connectionId: string; database: string; writeEnabled: boolean; schemaCreationEnabled?: boolean; tables: Record<string, LiveTable> };
type Discovered = { name: string; sheetName: string; description?: string; columns: DataColumn[]; rows: unknown[][] };
type Dependencies = {
  database(): Promise<Db>; flush(db: Db): void;
  source(db: Db, id: string, auth: Auth): { annotations?: DataObjectAnnotations; tables: Array<{ id: string; columns: DataColumn[] }> } | null;
  persist(db: Db, input: { name: string; fileType: string; assetId: string; auth: Auth; discovered: Discovered[] }): string;
  factory?: RemoteFactory;
  include?(db: Db, sourceId: string, tables: Awaited<ReturnType<typeof discoverLiveTables>>, auth: Auth, appId: string): Record<string,LiveTable>;
};
export function migrateLiveData(db: Db) {
  db.run('CREATE TABLE IF NOT EXISTS data_saved_connections (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, org_id TEXT NOT NULL, metadata_json TEXT NOT NULL)');
  db.run('CREATE TABLE IF NOT EXISTS data_live_objects (source_id TEXT PRIMARY KEY, binding_json TEXT NOT NULL)');
  migrateSchemaChanges(db);
}
export function liveBinding(db: Db, id: string): Binding | undefined {
  const row = db.exec('SELECT binding_json FROM data_live_objects WHERE source_id=?', [id])[0]?.values?.[0];
  return row ? JSON.parse(String(row[0])) : undefined;
}
export function liveObjectInfo(db: Db, id: string): LiveDataObjectInfo | undefined {
  const b = liveBinding(db, id);
  return b && { connectionId: b.connectionId, database: b.database, writeEnabled: b.writeEnabled, tables: Object.entries(b.tables).map(([tableId, t]) => ({ tableId, writable: isLiveTableWritable(t), columns: t.columns.map(({ name: _name, ...column }) => column) })) };
}
const ownedConnection = (db: Db, id: string, auth: Auth): SavedDatabaseConnection | undefined => {
  const row = db.exec('SELECT metadata_json FROM data_saved_connections WHERE id=? AND owner_user_id=? AND org_id=?', [id, auth.userId, auth.orgId])[0]?.values?.[0];
  return row ? JSON.parse(String(row[0])) : undefined;
};
export function createLiveDataService(d: Dependencies) {
  async function connection(db: Db, id: string, auth: Auth, database?: string) {
    const saved = ownedConnection(db, id, auth);
    if (!saved) throw new LiveDataError('连接不存在或无权使用。', 404);
    let password: string | undefined;
    try { password = await databaseSecret(saved.id); }
    catch { throw new LiveDataError('无法访问桌面安全凭据存储。请确认桌面应用已启动并解锁系统钥匙串；如持续失败，请完整重启桌面开发服务。', 503, 'DATABASE_CREDENTIAL_UNAVAILABLE'); }
    if (password === undefined) throw new LiveDataError(databaseCredentialPersistence() === 'desktop'
      ? '当前连接尚无已保存的密码。请打开“数据库连接”补填并测试保存；密码将加密保存，之后重启可自动读取。此前仅在内存中的密码若已丢失，需要补填一次。'
      : '连接密码未就绪。请打开“数据库连接”补填并测试保存。当前未连接桌面安全存储，纯 API 会话模式重启后需要重新输入。', 409, 'DATABASE_CREDENTIAL_REQUIRED');
    return { ...saved, password, database: database ?? saved.database };
  }
  async function query(sourceId: string, tableId: string, auth: Auth, input: { fields?: string[]; search?: string; limit?: number } = {}) {
    const db = await d.database();
    if (!d.source(db, sourceId, auth)) throw new LiveDataError('数据对象不存在或无权访问。', 404);
    const b = liveBinding(db, sourceId), table = b?.tables[tableId];
    if (!b || !table) throw new LiveDataError('实时数据表不存在。', 404);
    const c = await connection(db, b.connectionId, auth, b.database);
    return queryLiveTable(c, table, `${sourceId}:${tableId}`, input, d.factory);
  }
  const schemaChanges=createSchemaChangeService({database:d.database,flush:d.flush,source:d.source,binding:liveBinding,connection,include:(...args)=>{if(!d.include)throw new LiveDataError('结构登记服务不可用，已创建表需人工核对。');return d.include(...args);},factory:d.factory});
  async function structuredQuery(input: StructuredDataQuery, auth: Auth) {
    const db = await d.database(), source = d.source(db, input.sourceId, auth);
    if (!source) throw new LiveDataError('数据对象不存在或无权访问。', 404);
    const b = liveBinding(db, input.sourceId), table = b?.tables[input.tableId];
    const metadata = source.tables.find(t => t.id === input.tableId);
    if (!b || !table || !metadata) throw new LiveDataError('实时数据表不存在。', 404);
    const c = await connection(db, b.connectionId, auth, b.database);
    if (!input.joins?.length) return queryLiveStructured(c, table, metadata.columns, input, d.factory);
    const tables = new Map(source.tables.map(t => {
      const binding = b.tables[t.id];
      if (!binding) throw new LiveDataError('实时表绑定已失效，请检查数据对象。', 409);
      return [t.id, liveQueryTable(binding, t.columns)] as const;
    }));
    return queryLiveStructured(c, table, metadata.columns, input, d.factory, resolveQueryRelations(input, source.annotations?.relations || [], tables));
  }
  function errorResult(error: unknown) {
    return { status: error instanceof LiveDataError || error instanceof StructuredQueryError ? error.status : error instanceof RemoteBusyError ? 429 : error instanceof RemoteInputError ? 400 : 502,
      message: error instanceof LiveDataError || error instanceof StructuredQueryError || error instanceof RemoteBusyError || error instanceof RemoteInputError ? error.message : remoteError(error).replace('原有快照未修改。', '未返回缓存数据，请检查连接后重新查询。') };
  }
  async function register(app: FastifyInstance) {
    app.get('/data/connections', async request => {
      const auth = requireAuth(request), db = await d.database();
      return { connections: (db.exec('SELECT metadata_json FROM data_saved_connections WHERE owner_user_id=? AND org_id=?', [auth.userId, auth.orgId])[0]?.values || []).map(row => ({ ...JSON.parse(String(row[0])), credentialPersistence: databaseCredentialPersistence() })) };
    });
    app.post('/data/connections', async (request, reply) => {
      const auth = requireAuth(request);
      if (auth.role !== 'admin') return reply.code(403).send({ message: '请由管理员配置数据库连接。' });
      const parsed = savedDatabaseConnectionSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: parsed.error.issues[0]?.message });
      try {
        await inspectRemoteDatabase(parsed.data.connection, d.factory);
        const id = randomUUID(), { password, ...metadata } = parsed.data.connection;
        await databaseSecret(id, password).catch(() => { throw new LiveDataError('安全凭据保存失败，请解锁系统钥匙串后重试。', 503); });
        const saved: SavedDatabaseConnection = { ...metadata, id, name: parsed.data.name, credentialPersistence: databaseCredentialPersistence() };
        const db = await d.database();
        db.run('INSERT INTO data_saved_connections VALUES (?, ?, ?, ?)', [id, auth.userId, auth.orgId, JSON.stringify(saved)]); d.flush(db);
        return reply.code(201).send(saved);
      } catch (error) { const e = errorResult(error); return reply.code(e.status).send({ message: e.message }); }
    });
    app.post('/data/connections/:id/credential', async (request, reply) => {
      const auth = requireAuth(request), { id } = request.params as { id: string }, db = await d.database();
      if (!ownedConnection(db, id, auth)) return reply.code(404).send({ message: '连接不存在或无权访问。' });
      if (auth.role !== 'admin') return reply.code(403).send({ message: '请由管理员更新连接密码。' });
      const password = (request.body as { password?: unknown })?.password;
      if (typeof password !== 'string' || password.length > 4096) return reply.code(400).send({ message: '请输入有效密码。' });
      try {
        await inspectRemoteDatabase({ ...ownedConnection(db, id, auth)!, password }, d.factory);
        await databaseSecret(id, password);
        if (await databaseSecret(id) !== password) throw new LiveDataError('密码保存后无法读取，请保持桌面应用开启并解锁系统钥匙串后重试。', 503, 'DATABASE_CREDENTIAL_UNAVAILABLE');
        return { ok: true };
      } catch (error) { const e = errorResult(error); return reply.code(e.status).send({ message: e.message }); }
    });
    app.get('/data/connections/:id/inspect', async (request, reply) => {
      const auth = requireAuth(request), { id } = request.params as { id: string };
      const database = String((request.query as { database?: string }).database || '');
      if (database.length > 128) return reply.code(400).send({ message: '数据库名称过长。' });
      try { return await inspectRemoteDatabase(await connection(await d.database(), id, auth, database), d.factory); }
      catch (error) { const e = errorResult(error); return reply.code(e.status).send({ message: e.message }); }
    });
    app.post('/data/sources/live', async (request, reply) => {
      const auth = requireAuth(request);
      if (auth.role !== 'admin') return reply.code(403).send({ message: '请由管理员创建实时数据对象。' });
      const parsed = liveDataObjectCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: parsed.error.issues[0]?.message });
      try {
        const db = await d.database(), input = parsed.data, c = await connection(db, input.connectionId, auth, input.database);
        if (c.engine === 'mysql' && input.tables.some(t => t.schema !== input.database)) throw new LiveDataError('只能选择当前数据库中的表。');
        const discovered = await discoverLiveTables(c, input.tables, d.factory);
        const sourceId = d.persist(db, { name: input.name, assetId: '', fileType: c.engine === 'mysql' ? 'MySQL' : 'PostgreSQL', auth, discovered });
        const registered = db.exec('SELECT id FROM data_tables WHERE source_id=? ORDER BY rowid', [sourceId])[0]?.values || [];
        const binding: Binding = { connectionId: c.id, database: input.database, writeEnabled: false, tables: Object.fromEntries(registered.map((row, i) => [String(row[0]), discovered[i].binding])) };
        db.run('INSERT INTO data_live_objects VALUES (?, ?)', [sourceId, JSON.stringify(binding)]);
        db.run('UPDATE data_sources SET summary=? WHERE id=?', ['实时数据库 · 默认只读；数据通过 Gateway 从原库读取，不保存业务副本。', sourceId]); d.flush(db);
        return reply.code(201).send(d.source(db, sourceId, auth));
      } catch (error) { const e = errorResult(error); return reply.code(e.status).send({ message: e.message }); }
    });
    app.patch('/data/sources/:sourceId/access', async (request, reply) => {
      const auth = requireAuth(request), { sourceId } = request.params as { sourceId: string };
      if (auth.role !== 'admin') return reply.code(403).send({ message: '只有对象所有者中的管理员可以启用原库写入。' });
      const parsed = liveDataAccessSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: parsed.error.issues[0]?.message });
      return withKeyLock(`live-object:${sourceId}`, async () => {
        const db = await d.database();
        if (!d.source(db, sourceId, auth)) return reply.code(404).send({ message: '对象不存在或无权访问。' });
        const b = liveBinding(db, sourceId);
        if (!b) return reply.code(400).send({ message: '本地副本不支持原库写入。' });
        b.writeEnabled = parsed.data.writeEnabled;
        db.run('UPDATE data_live_objects SET binding_json=? WHERE source_id=?', [JSON.stringify(b), sourceId]); d.flush(db);
        return d.source(db, sourceId, auth);
      });
    });
    app.get('/data/gateway/records', async (request, reply) => {
      const auth = requireAuth(request), parsed = liveDataQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ message: '请提供有效数据对象、数据表和查询条数（1–200）。' });
      const input = parsed.data;
      try { return await query(input.sourceId, input.tableId, auth, { search: input.search, limit: input.limit }); }
      catch (error) { const e = errorResult(error); return reply.code(e.status).send({ message: e.message }); }
    });
    for (const [method, operation] of [['POST', 'insert'], ['PATCH', 'update'], ['DELETE', 'delete']] as const) app.route({
      method, url: '/data/gateway/records', handler: async (request: FastifyRequest, reply) => {
        const auth = requireAuth(request), parsed = liveDataRecordSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ message: parsed.error.issues[0]?.message });
        if (auth.role !== 'admin') return reply.code(403).send({ message: '当前账号无原库写入权限。' });
        const input = parsed.data;
        try { return await withKeyLock(`live-object:${input.sourceId}`, async () => {
          const db = await d.database();
          if (!d.source(db, input.sourceId, auth)) throw new LiveDataError('对象不存在或无权访问。', 404);
          const b = liveBinding(db, input.sourceId), t = b?.tables[input.tableId];
          if (!b || !t) throw new LiveDataError('实时数据表不存在。', 404);
          if (!b.writeEnabled) throw new LiveDataError('此对象为只读；请先在对象设置中明确开启原库写入。', 403);
          const c = await connection(db, b.connectionId, auth, b.database);
          return mutateLiveTable(c, t, `${input.sourceId}:${input.tableId}`, operation, input.fields || {}, input.recordId || '', d.factory);
        }); } catch (error) { const e = errorResult(error); return reply.code(e.status).send({ message: e.message }); }
      },
    });
  }
  async function assertReady(sourceId: string, auth: Auth) {
    const db = await d.database();
    if (!d.source(db, sourceId, auth)) throw new LiveDataError('数据对象不存在或无权访问。', 404);
    const binding = liveBinding(db, sourceId);
    if (binding) await connection(db, binding.connectionId, auth, binding.database);
  }
  async function sqlOperation(sourceId: string, tableIds: string[], operation: DataAppSqlOperation, parameters: unknown, auth: Auth & { role?: string }, mode: 'validate' | 'read' | 'write' | 'rollback', signal?: AbortSignal) {
    return withKeyLock(`live-object:${sourceId}`, async () => {
      const db = await d.database(), source = d.source(db, sourceId, auth), binding = liveBinding(db, sourceId);
      if (!source || !binding) throw new LiveDataError('实时对象不存在或无权访问。', 404);
      const tableSet = tableIds.flatMap(id => {
        const t = binding.tables[id], metadata = source.tables.find(t => t.id === id);
        return t && metadata ? [{ id, ...t, columns: t.columns.map(c => { const m = metadata.columns.find(m => m.id === c.id); return { ...c, sensitive: m ? Boolean(m.sensitive) : true }; }) }] : [];
      });
      const c = await connection(db, binding.connectionId, auth, binding.database);
      let plan = compileAppSql(operation, mode === 'validate' || mode === 'rollback' ? tableSet.map(t => ({...t,columns:t.columns.map(col=>({...col,nativeType:undefined}))})) : tableSet, c.engine, parameters);
      if (mode === 'validate' && plan.action === 'select') return { action: plan.action, tableIds: plan.tableIds };
      if (mode === 'validate' || mode === 'rollback') {
        for (const table of tableSet.filter(t => plan.tableIds.includes(t.id))) {
          const current = await readBoundTableMetadata(c, table, d.factory);
          for (const col of table.columns) {
            const field = current.find(f => f.fieldId === col.id);
            if (!field) throw new LiveDataError('目标表字段已变化，请更新对象 Schema。', 409, 'APP_SQL_SCHEMA_CHANGED');
            col.nativeType = field.nativeType;
          }
        }
        plan = compileAppSql(operation, tableSet, c.engine, parameters);
      }
      if (mode === 'read' && plan.action !== 'select') throw new LiveDataError('写操作不能通过查询或模型测试执行，请等待用户确认。', 403, 'APP_WRITE_CONFIRMATION_REQUIRED');
      if ((mode === 'write' || mode === 'rollback') && (plan.action === 'select' || auth.role !== 'admin' || !binding.writeEnabled)) throw new LiveDataError('需要所有者管理员权限，并在对象设置中开启原库写入。', 403, 'APP_WRITE_DISABLED');
      signal?.throwIfAborted();
      try { return await session(c, d.factory || remoteFactory, async s => {
        const abort = () => s.destroy(); signal?.addEventListener('abort', abort, { once: true });
        let committed = false;
        try {
          if (mode === 'validate') {
            await s.query(`EXPLAIN ${plan.sql}`, plan.values); signal?.throwIfAborted();
            return { action: plan.action, tableIds: plan.tableIds, validationLevel: 'explain', checkedAt: Date.now(), pendingApproval: true };
          }
          if (mode === 'rollback') {
            for (const table of tableSet.filter(t => plan.tableIds.includes(t.id))) {
              const triggers = await s.query(c.engine === 'mysql'
                ? 'SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=?'
                : 'SELECT COUNT(*) AS n FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid JOIN pg_namespace s ON s.oid=t.relnamespace WHERE s.nspname=$1 AND t.relname=$2 AND NOT g.tgisinternal', [table.schema,table.name]);
              if (!triggers.length || Number(triggers[0].n) !== 0) throw new LiveDataError('无法确认目标表无触发器，不执行事务试写。请使用无触发器测试库。', 409, 'APP_SQL_TRIAL_UNSAFE');
            }
          }
          await s.query(mode === 'read' ? c.engine === 'mysql' ? 'START TRANSACTION READ ONLY' : 'BEGIN READ ONLY' : 'BEGIN');
          if (mode === 'read') {
            const rows = await s.query(plan.sql, plan.values); signal?.throwIfAborted();
            const latest = d.source(db, sourceId, auth), latestBinding = liveBinding(db, sourceId);
            if (!latest || JSON.stringify(latestBinding) !== JSON.stringify(binding)) throw new LiveDataError('对象权限或绑定已变化，请重新查询。', 403);
            compileAppSql(operation, tableSet.map(t => ({ ...t, columns: t.columns.map(c => ({ ...c, sensitive: !latest.tables.find(m => m.id === t.id)?.columns.some(m => m.id === c.id && !m.sensitive) })) })), c.engine, parameters);
            return appSqlResult(rows.map(row => Object.fromEntries(Object.entries(row).map(([k,v]) => [k, typeof v === 'number' || typeof v === 'boolean' ? v : cell(v)]))));
          }
          if (!s.execute) throw new LiveDataError('驱动不支持安全写入。');
          const affectedRows = await s.execute(plan.sql, plan.values);
          if (affectedRows > 1) throw new LiveDataError('影响超过1行，已回滚。', 409, 'APP_WRITE_ROW_LIMIT');
          signal?.throwIfAborted();
          // Recheck mutable authorization immediately before committing.
          if (!d.source(db, sourceId, auth) || !liveBinding(db, sourceId)?.writeEnabled) throw new LiveDataError('权限已撤销，已回滚。', 403);
          const latest = d.source(db, sourceId, auth)!;
          if (JSON.stringify(liveBinding(db, sourceId)) !== JSON.stringify(binding)) throw new LiveDataError('对象绑定已变化，已回滚。', 409);
          compileAppSql(operation, tableSet.map(t => ({ ...t, columns: t.columns.map(c => ({ ...c, sensitive: !latest.tables.find(m => m.id === t.id)?.columns.some(m => m.id === c.id && !m.sensitive) })) })), c.engine, parameters);
          if (mode === 'rollback') {
            await s.query('ROLLBACK'); committed = true;
            return { affectedRows, action: plan.action, rolledBack: true, validationLevel: 'rollback', checkedAt: Date.now(), notice: '事务已回滚。自增号/序列及外部副作用不保证恢复。' };
          }
          await s.query('COMMIT'); committed = true;
          return { affectedRows, action: plan.action, executedAt: new Date().toISOString() };
        } finally {
          signal?.removeEventListener('abort', abort);
          if (!committed) await s.query('ROLLBACK').catch(() => undefined);
        }
      }); } catch (error) {
        if (error instanceof LiveDataError || error instanceof StructuredQueryError || signal?.aborted) throw error;
        const code = String((error as { code?: unknown })?.code || '');
        const rejected: Record<string, string> = {
          ER_DUP_ENTRY: '记录违反唯一约束，可能已有相同编号或唯一字段；请先查询核对。',
          '23505': '记录违反唯一约束，可能已有相同编号或唯一字段；请先查询核对。',
          ER_NO_REFERENCED_ROW_2: '关联记录不存在，写入违反外键约束；请检查关联编号。',
          ER_ROW_IS_REFERENCED_2: '记录仍被其他数据引用，数据库拒绝删除或修改。',
          '23503': '写入违反外键约束；请检查关联记录。',
          ER_BAD_NULL_ERROR: '必填字段不能为 NULL，请检查 SQL 参数。',
          '23502': '必填字段不能为 NULL，请检查 SQL 参数。',
          ER_NO_DEFAULT_FOR_FIELD: 'SQL 缺少无默认值的必填字段，请检查对象 Schema 和新增字段。',
          ER_DATA_TOO_LONG: '字段值超过数据库长度或位宽限制，请检查文本长度及 BIT/布尔字段的值与类型。',
          '22001': '字段值超过数据库长度限制，请缩短输入。',
          ER_TRUNCATED_WRONG_VALUE_FOR_FIELD: '字段类型不匹配，请检查整数、日期及 BIT/布尔参数。',
          ER_WARN_DATA_OUT_OF_RANGE: '数值超出数据库字段范围，请检查参数类型和值。',
          '22003': '数值超出数据库字段范围，请检查参数类型和值。',
          ER_CHECK_CONSTRAINT_VIOLATED: '写入违反数据库 CHECK 约束，请检查字段取值。',
          '23514': '写入违反数据库 CHECK 约束，请检查字段取值。',
          ER_TABLEACCESS_DENIED_ERROR: '数据库连接账号没有此表的写入权限；对象开关不能替代数据库授权。',
          ER_COLUMNACCESS_DENIED_ERROR: '数据库连接账号没有所写字段的权限。',
          '42501': '数据库连接账号没有此表或字段的写入权限。',
          ER_OPTION_PREVENTS_STATEMENT: '数据库当前处于只读或受限模式，拒绝写入。',
          ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION: '数据库事务为只读，拒绝写入。',
          '25006': '数据库事务为只读，拒绝写入。',
        };
        if (rejected[code]) {
          const nativeColumn = String((error as { message?: unknown })?.message || '').match(/(?:column|field) ['"]([^'"]{1,128})['"]/i)?.[1];
          const field = nativeColumn && tableSet.flatMap(t => t.columns).find(c => c.name === nativeColumn);
          throw new LiveDataError(`${rejected[code]}${field ? ` 字段：${field.name}。` : ''}（${code}）`, 400, 'APP_SQL_DATABASE_REJECTED');
        }
        const message = ['ER_BAD_FIELD_ERROR','42703','ER_NO_SUCH_TABLE','42P01'].includes(code) ? 'SQL 字段或表已变化，请更新对象 Schema 并重新验证。'
          : ['ER_PARSE_ERROR','42601','ER_SP_DOES_NOT_EXIST','42883'].includes(code) ? `SQL 语法或函数不适用于当前 ${c.engine} 数据库，请调整 SQL 后重新验证。`
          : ['22P02','22007','ER_TRUNCATED_WRONG_VALUE'].includes(code) ? 'SQL 参数或字段类型不匹配，请检查输入参数与对象字段类型。' : '';
        if (message) throw new LiveDataError(message, 400, 'APP_SQL_EXECUTION_FAILED');
        if (mode === 'write') throw new LiveDataError('数据库写入未确认，可能超时或连接中断。请刷新数据核对结果，不要自动重试。', 502, 'APP_WRITE_UNCONFIRMED');
        if (mode === 'rollback') throw new LiveDataError('试写未确认回滚完成，请检查测试库数据，不要自动重试。', 502, 'APP_SQL_TRIAL_UNCONFIRMED');
        throw error;
      }
    });
  }
  async function schemaSupplement(sourceId: string, tableId: string, auth: Auth) {
    const db = await d.database(), source = d.source(db, sourceId, auth);
    if (!source) throw new LiveDataError('数据对象不存在或无权访问。', 404);
    const b = liveBinding(db, sourceId), table = b?.tables[tableId];
    if (!b) throw new LiveDataError('本地对象／副本没有实时元数据补查能力，请更新数据对象。', 409, 'DATA_SCHEMA_SUPPLEMENT_UNAVAILABLE');
    if (!table || !source.tables.some(t => t.id === tableId)) throw new LiveDataError('表不在当前数据对象中，请先调整数据对象。', 403, 'APP_SCOPE_EXCEEDED');
    const c = await connection(db, b.connectionId, auth, b.database);
    return readBoundTableMetadata(c, table, d.factory);
  }
  return { register, query, structuredQuery, errorResult, assertReady, schemaSupplement, sqlOperation, schemaChanges };
}
