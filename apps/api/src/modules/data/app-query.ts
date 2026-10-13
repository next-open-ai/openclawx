import { dataAppOperationSchema, dataAppInvokeSchema, dataAppSqlOperationSchema, dataAppStoredOperationSchema, dataAppSqlApprovalSchema, dataAppMutationSchema, structuredDataQuerySchema, type QueryAssetDefinition, type DataAppOperationSummary, type DataAppOperation, type StructuredDataQuery, type DataObjectModelSchema } from '@workmate/contracts';
import { createHash } from 'node:crypto';
import type { AgentDataGateway } from './agent-query.js';
import { guardSensitive, safeSchema, readAgentSchema } from './agent-query.js';
import { StructuredQueryError } from './structured-query.js';
import { dataAppSqlTrialSchema } from '@workmate/contracts';
import { withKeyLock } from '@workmate/orchestrator';

type Owner = { userId: string; orgId: string };
type DB = { run(sql: string, params?: unknown[]): void; exec(sql: string, params?: unknown[]): Array<{ values?: unknown[][] }> };
export type AppScope = { appId: string; sourceId: string; tableIds: string[] };
function deny(message: string, code = 'APP_QUERY_INVALID'): never { throw new StructuredQueryError(message, code, 400); }

/** Only bind values already present in a parsed AST. Never substitute identifiers or SQL text. */
export function bindAppQuery(operation: DataAppOperation, raw: unknown): StructuredDataQuery {
  const parameters = dataAppInvokeSchema.shape.parameters.parse(raw);
  const query = JSON.parse(JSON.stringify(operation.query));
  for (const name of Object.keys(parameters)) if (!operation.parameters.some(p => p.name === name)) deny(`未知参数：${name}`);
  for (const p of operation.parameters) {
    const value = Object.hasOwn(parameters, p.name) ? parameters[p.name] : p.default;
    if (value === undefined) { if (p.required) deny(`请填写参数：${p.name}`); continue; }
    if (typeof value !== p.type) deny(`参数 ${p.name} 应为 ${p.type}`);
    const keys = p.path.split('.'); let target = query;
    for (const key of keys.slice(0, -1)) {
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) deny(`参数 ${p.name} 的绑定位置不存在`);
      target = target[key];
    }
    const key = keys.at(-1)!;
    if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) deny(`参数 ${p.name} 的绑定位置不存在`);
    target[key] = value;
  }
  return structuredDataQuerySchema.parse(query);
}

export class ManagedAppQueries {
  constructor(private db: DB, private flush: () => void, private gateway: AgentDataGateway) {}
  static migrate(db: DB) {
    db.run('CREATE TABLE IF NOT EXISTS data_app_query_scopes (app_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, table_ids_json TEXT NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS data_app_queries (app_id TEXT NOT NULL, operation_id TEXT NOT NULL, definition_json TEXT NOT NULL, verified_at INTEGER NOT NULL, PRIMARY KEY(app_id, operation_id))');
    if (!(db.exec('PRAGMA table_info(data_app_queries)')[0]?.values || []).some(row => row[1] === 'result_fields_json')) db.run("ALTER TABLE data_app_queries ADD COLUMN result_fields_json TEXT NOT NULL DEFAULT '[]'");
    db.run('CREATE TABLE IF NOT EXISTS data_app_sql_states (app_id TEXT NOT NULL, operation_id TEXT NOT NULL, action TEXT NOT NULL, revision TEXT NOT NULL, approved_at INTEGER, PRIMARY KEY(app_id,operation_id))');
    db.run('CREATE TABLE IF NOT EXISTS data_app_sql_validations (app_id TEXT NOT NULL, operation_id TEXT NOT NULL, revision TEXT NOT NULL, level TEXT NOT NULL, checked_at INTEGER NOT NULL, PRIMARY KEY(app_id,operation_id))');
  }
  scope(appId: string): AppScope | undefined {
    const row = this.db.exec('SELECT source_id, table_ids_json FROM data_app_query_scopes WHERE app_id = ?', [appId])[0]?.values?.[0];
    return row ? { appId, sourceId: String(row[0]), tableIds: JSON.parse(String(row[1])) } : undefined;
  }
  createScope(appId: string, sourceId: string, tableIds: string[]) {
    this.db.run('INSERT OR IGNORE INTO data_app_query_scopes VALUES (?, ?, ?)', [appId, sourceId, JSON.stringify(tableIds)]); this.flush();
  }
  authorize(appId: string, owner: Owner): AppScope {
    const row = this.db.exec('SELECT id FROM data_apps WHERE id = ? AND org_id = ? AND owner_user_id = ?', [appId, owner.orgId, owner.userId])[0]?.values?.[0];
    const scope = this.scope(appId);
    if (!row || !scope) throw new StructuredQueryError('应用不存在或无权访问。', 'APP_ACCESS_DENIED', 404);
    return scope;
  }
  list(appId: string): DataAppOperationSummary[] {
    return (this.db.exec('SELECT operation_id, definition_json, verified_at, result_fields_json FROM data_app_queries WHERE app_id = ? ORDER BY operation_id', [appId])[0]?.values || []).map(r => {
      const definition = dataAppStoredOperationSchema.parse(JSON.parse(String(r[1])));
      const state = this.db.exec('SELECT action, revision, approved_at FROM data_app_sql_states WHERE app_id=? AND operation_id=?', [appId, String(r[0])])[0]?.values?.[0];
      const validation = this.db.exec('SELECT revision,level,checked_at FROM data_app_sql_validations WHERE app_id=? AND operation_id=?', [appId,String(r[0])])[0]?.values?.[0];
      return { operationId: String(r[0]), description: definition.description, parameters: definition.parameters, verifiedAt: Number(r[2]), resultFields: JSON.parse(String(r[3])),
        ...(validation && validation[0] === state?.[1] ? { validation: { revision: String(validation[0]), level: validation[1] as 'explain' | 'rollback', checkedAt: Number(validation[2]) } } : {}),
        ...('kind' in definition ? { kind: definition.kind, sql: definition.sql, action: state?.[0] as DataAppOperationSummary['action'], revision: String(state?.[1] || ''), approved: Boolean(state?.[2]) } : {}) };
    });
  }
  async context(appId: string, owner: Owner, page?: unknown) {
    const scope = this.authorize(appId, owner), schema = await this.gateway.schema(scope.sourceId, owner);
    this.authorize(appId, owner);
    const scoped = this.scopedSchema(scope, schema);
    const tableId = (page as { tableId?: string } | undefined)?.tableId;
    const output = { schema: page ? await readAgentSchema(this.gateway, scoped, owner, page) : safeSchema(scoped), operations: this.list(appId).map(({ operationId, action, approved }) => ({ operationId, action, approved })),
      sqlCapabilities: await this.gateway.sqlCapabilities?.(scope.sourceId, tableId && scope.tableIds.includes(tableId) ? [tableId] : [], owner), readOnly: true,
      scopeNotice: '仅限创建时对象的表集合。缺少表/关系时说明缺口，请用户调整数据对象并重新创建应用；不得扫描整个连接、猜测关系或绕过网关。' };
    this.authorize(appId, owner);
    if (Buffer.byteLength(JSON.stringify(output)) > 128_000) deny('对象 Schema 过大，请缩小对象表集合后重新创建应用。');
    return output;
  }
  private scopedSchema(scope: AppScope, schema: DataObjectModelSchema): DataObjectModelSchema {
    return { ...schema, resources: schema.resources.filter(t => scope.tableIds.includes(t.id)), annotations: { ...schema.annotations, relations: schema.annotations.relations.filter(r => scope.tableIds.includes(r.fromTableId) && scope.tableIds.includes(r.toTableId)) } };
  }
  async query(appId: string, owner: Owner, query: StructuredDataQuery, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const scope = this.authorize(appId, owner);
    if (query.sourceId !== scope.sourceId || !scope.tableIds.includes(query.tableId)) deny('查询超出应用表集合，请先调整数据对象后重新创建应用。', 'APP_SCOPE_EXCEEDED');
    const schema = this.scopedSchema(scope, await this.gateway.schema(scope.sourceId, owner));
    const safe = guardSensitive(query, schema);
    const result = await this.gateway.query(safe, owner);
    signal?.throwIfAborted();
    this.authorize(appId, owner);
    const latest = this.scopedSchema(scope, await this.gateway.schema(scope.sourceId, owner));
    guardSensitive(safe, latest);
    for (const j of query.joins) if (JSON.stringify(schema.annotations.relations.find(r => r.id === j.relationId)) !== JSON.stringify(latest.annotations.relations.find(r => r.id === j.relationId))) deny('关系发生变化，请重新验证。');
    if (Buffer.byteLength(JSON.stringify(result)) > 256_000) deny('结果过大，请减少字段或使用分组统计。');
    return result;
  }
  async register(appId: string, owner: Owner, raw: unknown, signal?: AbortSignal) {
    const operation = dataAppOperationSchema.parse(raw);
    return withKeyLock(`app-query:${appId}`, async () => {
      this.authorize(appId, owner);
      if (!this.list(appId).some(q => q.operationId === operation.operationId) && this.list(appId).length >= 30) deny('每个应用最多 30 个操作。');
      const result = await this.query(appId, owner, bindAppQuery(operation, operation.testParameters), signal);
      signal?.throwIfAborted();
      this.authorize(appId, owner);
      // Samples remain transient. Only the definition and verification fact are durable.
      const stored = { ...operation, testParameters: {} };
      const verifiedAt = Date.now();
      this.db.run('INSERT OR REPLACE INTO data_app_queries (app_id, operation_id, definition_json, verified_at, result_fields_json) VALUES (?, ?, ?, ?, ?)', [appId, operation.operationId, JSON.stringify(stored), verifiedAt, JSON.stringify((result as { fields?: unknown }).fields || [])]); this.flush();
      this.db.run('DELETE FROM data_app_sql_states WHERE app_id=? AND operation_id=?', [appId, operation.operationId]); this.flush();
      return { operationId: operation.operationId, verifiedAt, result, notice: '查询已验证并登记；不代表页面已绑定或业务口径已验收。' };
    });
  }
  async invoke(appId: string, owner: Owner, raw: unknown, signal?: AbortSignal) {
    const input = dataAppInvokeSchema.parse(raw); this.authorize(appId, owner);
    const row = this.db.exec('SELECT definition_json FROM data_app_queries WHERE app_id = ? AND operation_id = ?', [appId, input.operationId])[0]?.values?.[0];
    if (!row) deny('操作尚未登记并验证。');
    const operation = dataAppStoredOperationSchema.parse(JSON.parse(String(row[0])));
    if ('kind' in operation) {
      const scope = this.authorize(appId, owner);
      if (!this.gateway.sqlOperation) deny('SQL 能力尚不可用。');
      const result = await this.gateway.sqlOperation(scope.sourceId, scope.tableIds, operation, input.parameters, owner, 'read', signal);
      this.authorize(appId, owner); signal?.throwIfAborted(); return result;
    }
    return this.query(appId, owner, bindAppQuery(operation, input.parameters), signal);
  }
  queryAssetDefinition(appId:string,owner:Owner,operationId:string,parameters:unknown):{definition:QueryAssetDefinition;tableIds:string[]}{
    const scope=this.authorize(appId,owner),summary=this.list(appId).find(o=>o.operationId===operationId);
    if(!summary?.verifiedAt||summary.kind==='sql'&&summary.action!=='select')deny('只有成功执行过的只读查询可以收藏。');
    const row=this.db.exec('SELECT definition_json FROM data_app_queries WHERE app_id=? AND operation_id=?',[appId,operationId])[0]?.values?.[0];
    const operation=dataAppStoredOperationSchema.parse(JSON.parse(String(row?.[0])));
    return {definition:'kind' in operation?{kind:'sql',operation}:{kind:'structured',query:bindAppQuery(operation,parameters)},tableIds:scope.tableIds};
  }
  async registerSql(appId: string, owner: Owner, raw: unknown, signal?: AbortSignal) {
    const operation = dataAppSqlOperationSchema.parse(raw);
    return withKeyLock(`app-query:${appId}`, async () => {
      const scope = this.authorize(appId, owner);
      if (!this.gateway.sqlOperation) deny('SQL 能力尚不可用。');
      if (!this.list(appId).some(q => q.operationId === operation.operationId) && this.list(appId).length >= 30) deny('每个应用最多30个操作。');
      const plan = await this.gateway.sqlOperation(scope.sourceId, scope.tableIds, operation, operation.testParameters, owner, 'validate', signal) as { action: string; validationLevel?: string };
      const result = plan.action === 'select' ? await this.gateway.sqlOperation(scope.sourceId, scope.tableIds, operation, operation.testParameters, owner, 'read', signal) : undefined;
      signal?.throwIfAborted(); this.authorize(appId, owner);
      const stored = { ...operation, testParameters: {} }, revision = createHash('sha256').update(JSON.stringify(stored)).digest('hex');
      const previous = this.list(appId).find(o => o.operationId === operation.operationId);
      const approved = previous?.revision === revision && previous.approved;
      const verifiedAt = result ? Date.now() : 0;
      this.db.run('INSERT OR REPLACE INTO data_app_queries (app_id,operation_id,definition_json,verified_at,result_fields_json) VALUES (?,?,?,?,?)', [appId, operation.operationId, JSON.stringify(stored), verifiedAt, JSON.stringify((result as { fields?: unknown })?.fields || [])]);
      this.db.run('INSERT OR REPLACE INTO data_app_sql_states VALUES (?,?,?,?,?)', [appId, operation.operationId, plan.action, revision, approved ? Date.now() : null]); this.flush();
      if (plan.validationLevel === 'explain') { this.db.run('INSERT OR REPLACE INTO data_app_sql_validations VALUES (?,?,?,?,?)',[appId,operation.operationId,revision,'explain',Date.now()]); this.flush(); }
      return { operationId: operation.operationId, action: plan.action, revision, verifiedAt, result, pendingApproval: plan.action !== 'select' && !approved,
        validationLevel: plan.validationLevel,
        notice: result ? 'SQL 查询已真实验证并登记。' : plan.validationLevel === 'explain' ? '写操作已完成静态检查和数据库预检查（未试写），请用户审核启用。事务试写仅在可信界面显式发起。' : '写操作仅静态检查通过，尚未进行数据库预检查或试写。' };
    });
  }
  async proposeSchema(appId:string,owner:Owner,raw:unknown){
    const scope=this.authorize(appId,owner);if(!this.gateway.schemaProposal)deny('结构创建暂不可用。');
    const plan=await this.gateway.schemaProposal(scope.sourceId,owner,raw) as import('@workmate/contracts').DataSchemaPlan;
    this.authorize(appId,owner);
    return {id:plan.id,revision:plan.revision,tables:plan.tables,state:plan.state,notice:'仅保存建表草稿，未执行。请用户在项目预览与发布中开启结构创建并审核；批准前不能使用新表。'};
  }
  async approveSql(appId: string, operationId: string, owner: Owner & { role?: string }, raw: unknown) {
    const { revision } = dataAppSqlApprovalSchema.parse(raw);
    return withKeyLock(`app-query:${appId}`, async () => {
      this.authorize(appId, owner);
      if (owner.role !== 'admin') throw new StructuredQueryError('只有应用所有者管理员可批准写操作。', 'APP_ACCESS_DENIED', 403);
      const operation = this.list(appId).find(o => o.operationId === operationId);
      if (!operation || operation.kind !== 'sql' || operation.action === 'select' || operation.revision !== revision) deny('操作定义已变化，请刷新后重新确认。', 'APP_OPERATION_CHANGED');
      this.db.run('UPDATE data_app_sql_states SET approved_at=? WHERE app_id=? AND operation_id=? AND revision=?', [Date.now(), appId, operationId, revision]); this.flush();
      return { approved: true, revision };
    });
  }
  async trialSql(appId: string, owner: Owner & { role?: string }, raw: unknown) {
    const input = dataAppSqlTrialSchema.parse(raw);
    return withKeyLock(`app-query:${appId}`, async () => {
      const scope = this.authorize(appId,owner), op = this.list(appId).find(o => o.operationId === input.operationId);
      if (owner.role !== 'admin' || !op?.approved || op.revision !== input.revision || op.kind !== 'sql' || op.action === 'select') throw new StructuredQueryError('仅管理员可对当前已审核写操作发起事务试写。', 'APP_SQL_TRIAL_DENIED', 403);
      const row = this.db.exec('SELECT definition_json FROM data_app_queries WHERE app_id=? AND operation_id=?',[appId,input.operationId])[0]?.values?.[0];
      const operation = dataAppSqlOperationSchema.parse(JSON.parse(String(row?.[0])));
      if (!this.gateway.sqlOperation) deny('SQL 能力不可用。');
      const result = await this.gateway.sqlOperation(scope.sourceId,scope.tableIds,operation,input.parameters,owner,'rollback') as { rolledBack?: boolean };
      if (result.rolledBack !== true) deny('未确认回滚完成，不记录验证成功。','APP_SQL_TRIAL_UNCONFIRMED');
      this.authorize(appId,owner);
      this.db.run('INSERT OR REPLACE INTO data_app_sql_validations VALUES (?,?,?,?,?)',[appId,input.operationId,input.revision,'rollback',Date.now()]); this.flush();
      return result;
    });
  }
  async mutate(appId: string, owner: Owner & { role?: string }, raw: unknown, signal?: AbortSignal) {
    const input = dataAppMutationSchema.parse(raw);
    return withKeyLock(`app-query:${appId}`, async () => {
      const scope = this.authorize(appId, owner);
      const summary = this.list(appId).find(o => o.operationId === input.operationId);
      if (!summary?.approved || summary.revision !== input.revision || summary.action === 'select') throw new StructuredQueryError('写操作未批准或定义已变化，请重新确认。', 'APP_WRITE_CONFIRMATION_REQUIRED', 403);
      const row = this.db.exec('SELECT definition_json FROM data_app_queries WHERE app_id=? AND operation_id=?', [appId, input.operationId])[0]?.values?.[0];
      const operation = dataAppSqlOperationSchema.parse(JSON.parse(String(row?.[0])));
      if (!this.gateway.sqlOperation) deny('SQL 能力不可用。');
      return this.gateway.sqlOperation(scope.sourceId, scope.tableIds, operation, input.parameters, owner, 'write', signal);
    });
  }
  projectApp(projectId: string, owner: Owner) {
    const row = this.db.exec('SELECT app_id FROM data_app_project_links WHERE project_id = ?', [projectId])[0]?.values?.[0];
    if (!row || !this.scope(String(row[0]))) return undefined;
    this.authorize(String(row[0]), owner); return String(row[0]);
  }
}
