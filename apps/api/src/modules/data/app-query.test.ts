import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { MemoryStore } from '@workmate/orchestrator';
import { dataObjectModelSchema, dataAppOperationSchema, structuredDataQuerySchema } from '@workmate/contracts';
import { ManagedAppQueries, bindAppQuery } from './app-query.js';
import { createAgentDataExecutor, safeSchema, schemaPage, readAgentSchema } from './agent-query.js';
import { readBoundTableMetadata } from './live-database.js';
import { dataGetSchemaInputSchema } from '@workmate/contracts';
import { createLiveDataService, migrateLiveData } from './live-data-routes.js';
import { databaseSecret } from './database-secrets.js';
import { dataRoutes, publicDataAppRoutes, createManagedAppQueries, createStructuredDataGateway } from './routes.js';
import { getOrchestrator } from '../orchestration/routes.js';
import { applyParentSecrets } from '../orchestration/secrets.js';
import { managedAppPage } from './app-query-page.js';
import { executeLocalStructuredQuery } from './structured-query.js';
import type { RemoteFactory } from './remote-database.js';

async function sqlite() {
  const require = createRequire(import.meta.url), root = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
  const SQL = await require(path.join(root, 'sql-wasm.js'))({ wasmBinary: fs.readFileSync(path.join(root, 'sql-wasm.wasm')) });
  return new SQL.Database();
}
const owner = { userId: 'u', orgId: 'o' };
const definition = () => dataAppOperationSchema.parse({ operationId: 'total', description: '收入合计', query: { sourceId: 's', tableId: 't', filters: { fieldId: 'amount', operator: 'gte', value: 1 }, metrics: [{ fieldId: 'amount', operation: 'sum', alias: 'total' }] }, parameters: [{ name: 'minimum', path: 'filters.value', type: 'number' }], testParameters: { minimum: 1 } });

test('MDA-R8/R9: object schema first; database supplement is explicit, scoped and cannot overwrite business annotations', async () => {
  const schema = dataObjectModelSchema.parse({ id: 's', name: '对象', kind: 'MySQL', storageMode: 'live', annotations: {}, operations: ['query'], resources: [{ id: 't', name: '学生', sheetName: 'native', columns: [{ id: 'c1', name: '姓名', type: '文本', nullable: false, description: '用户标注' }, { id: 'hidden', name: '私密', type: '文本', nullable: false, sensitive: true }] }] });
  let calls = 0;
  const gateway = { list: async () => [], schema: async () => schema, query: async () => ({}), schemaSupplement: async () => {
    calls++; return [{ fieldId: 'c1', nativeType: 'varchar(50)', nullable: false, description: '数据库注释' }, { fieldId: 'hidden', nativeType: 'text', nullable: true, description: '不得泄漏' }, { fieldId: 'unbound', nativeType: 'text', nullable: true, description: '新列不得自动纳入' }];
  } };
  const local = await readAgentSchema(gateway, schema, owner, { sourceId: 's', view: 'tables' });
  assert.equal(local.metadataOrigin, 'object'); assert.equal(calls, 0);
  const remote = await readAgentSchema(gateway, schema, owner, { sourceId: 's', tableId: 't', origin: 'database' }) as any;
  assert.equal(calls, 1); assert.equal(remote.metadataOrigin, 'database');
  assert.equal(remote.resources[0].columns[0].description, '用户标注');
  assert.equal(remote.resources[0].columns[0].databaseMetadata.description, '数据库注释');
  assert.doesNotMatch(JSON.stringify(remote), /不得泄漏|新列不得自动纳入/);
  await assert.rejects(readAgentSchema(gateway, schema, owner, { sourceId: 's', tableId: 'outside', origin: 'database' }), /授权集合/);
  assert.equal(calls, 1);
  assert.equal(dataGetSchemaInputSchema.safeParse({ sourceId: 's', origin: 'database' }).success, false);
  assert.equal(dataGetSchemaInputSchema.safeParse({ sourceId: 's', origin: 'database', tableId: 't', view: 'tables' }).success, false);
  assert.equal(schema.resources[0].columns[0].description, '用户标注');
  gateway.schemaSupplement = async () => {
    schema.resources[0].columns[0].sensitive = true;
    return [{ fieldId: 'c1', nativeType: 'varchar(50)', nullable: false, description: '运行中变为敏感的注释' }];
  };
  const revoked = await readAgentSchema(gateway, schema, owner, { sourceId: 's', tableId: 't', origin: 'database' });
  assert.doesNotMatch(JSON.stringify(revoked), /运行中变为敏感的注释|用户标注/);
});

test('MDA-R9: MySQL/PostgreSQL supplement queries only a bound table, parameterized metadata, never catalog/records', async () => {
  for (const engine of ['mysql', 'postgresql'] as const) {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const result = await readBoundTableMetadata({ engine, host: 'synthetic', port: 1234, user: 'synthetic', password: '', database: 'd', tls: false, ca: '' }, { schema: 'schema-name', name: 'students', columns: [{ id: 'c1', name: 'student_name', primary: false, generated: false, nullable: false, defaulted: false }] }, async () => ({ query: async (sql, values) => {
      calls.push({ sql, values }); return [{ name: 'student_name', data_type: 'varchar', nullable: 'NO', description: '学生姓名' }, { name: 'not-bound', data_type: 'text', nullable: 'YES' }];
    }, close: async () => {}, destroy: () => {} }));
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].values, ['schema-name', 'students']);
    assert.match(calls[0].sql, /LIMIT 201/); assert.doesNotMatch(calls[0].sql, /TABLE_TYPE|SELECT \*|FROM.*students/);
    assert.deepEqual(result.map(c => c.fieldId), ['c1']);
  }
});

test('MDA-R6: preflight rejects missing credentials, accepts configured empty password; no remote query or secret persistence', async () => {
  const db = await sqlite(), id = randomUUID(); migrateLiveData(db);
  db.run('INSERT INTO data_saved_connections VALUES (?,?,?,?)', [id, 'u', 'o', JSON.stringify({ id, name: 'synthetic', engine: 'mysql', host: 'localhost', user: 'reader', port: 3306, database: 'synthetic', tls: false })]);
  db.run('INSERT INTO data_live_objects VALUES (?,?)', ['s', JSON.stringify({ connectionId: id, database: 'synthetic', writeEnabled: false, tables: {} })]);
  let calls = 0;
  const service = createLiveDataService({ database: async () => db, flush: () => {}, source: (_, sourceId, auth) => sourceId === 's' && auth.userId === 'u' ? { tables: [] } : null, persist: () => '', factory: async () => { calls++; throw new Error('must not connect'); } });
  await assert.rejects(service.assertReady('s', owner), (error: any) => error.status === 409 && error.code === 'DATABASE_CREDENTIAL_REQUIRED');
  await databaseSecret(id, ''); await service.assertReady('s', owner);
  await assert.rejects(service.assertReady('s', { ...owner, userId: 'other' }), /无权/);
  assert.equal(calls, 0);
  assert.ok(!String(db.exec('SELECT metadata_json FROM data_saved_connections')[0].values[0][0]).includes('password'));
  db.close();
});

test('MDA-R7: large schemas expose all tables, columns and relations as bounded complete JSON pages, not repeated prefixes', () => {
  const schema = dataObjectModelSchema.parse({ id: 's', name: '大对象', kind: 'MySQL', storageMode: 'live', annotations: {}, operations: ['query'], resources: Array.from({ length: 20 }, (_, t) => ({ id: `t${t}`, name: `表${t}`, sheetName: `native${t}`, columns: Array.from({ length: 75 }, (_, c) => ({ id: `c${c}`, name: `字段${c}`, type: '文本', nullable: true, sensitive: c === 74, description: '字段说明'.repeat(40) })) })) });
  const safe = safeSchema(schema);
  safe.relations = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, name: `关系${i}`, fromTableId: 't0', toTableId: 't1', keys: [{ fromFieldId: 'c0', toFieldId: 'c0' }] }));
  const ids: string[] = [];
  for (let offset: number | null = 0; offset !== null;) {
    const page = schemaPage(safe, { sourceId: 's', offset }) as any;
    assert.ok(JSON.stringify(page).length <= 12000); ids.push(...page.resources.map((t: any) => t.id));
    offset = page.pagination.nextOffset;
  }
  assert.equal(new Set(ids).size, 20);
  const columns: string[] = [];
  for (let offset: number | null = 0; offset !== null;) {
    const page = schemaPage(safe, { sourceId: 's', tableId: 't19', offset }) as any;
    assert.ok(JSON.stringify(page).length <= 12000); columns.push(...page.resources[0].columns.map((c: any) => c.id));
    offset = page.pagination.nextOffset;
  }
  assert.equal(new Set(columns).size, 74); assert.ok(!columns.includes('c74'));
  assert.throws(() => schemaPage(safe, { sourceId: 's', tableId: 'outside' }), /无权/);
  const relations: string[] = [];
  for (let offset: number | null = 0; offset !== null;) {
    const page = schemaPage(safe, { sourceId: 's', view: 'relations', offset }) as any;
    relations.push(...page.relations.map((r: any) => r.id)); offset = page.pagination.nextOffset;
  }
  assert.equal(new Set(relations).size, 25);
});

test('MDA-R2: parameters bind values only, reject SQL/identifiers/unknown params/invalid paths/types', () => {
  const operation = definition();
  assert.equal((bindAppQuery(operation, { minimum: 5 }).filters as any).value, 5);
  for (const params of [{}, { minimum: '1 OR 1=1' }, { minimum: 1, tableId: 'outside' }, { __proto__: null, minimum: true }]) assert.throws(() => bindAppQuery(operation, params));
  for (const path of ['tableId', 'fields.0', '__proto__.polluted', 'joins.0.relationId', 'filters.fieldId']) assert.equal(dataAppOperationSchema.safeParse({ ...operation, parameters: [{ ...operation.parameters[0], path }] }).success, false);
  assert.throws(() => bindAppQuery({ ...operation, parameters: [{ ...operation.parameters[0], path: 'filters.conditions.0.value' }] }, { minimum: 5 }));
  assert.equal(dataAppOperationSchema.safeParse({ ...operation, sql: 'SELECT *' }).success, false);
});

test('MDA-R1/R2/R3/R5: real SQLite compilation, scope/sensitivity/revocation, failed replacement and durable definitions', async () => {
  const db = await sqlite();
  db.run('CREATE TABLE data_apps (id TEXT, org_id TEXT, owner_user_id TEXT)'); db.run("INSERT INTO data_apps VALUES ('a','o','u')");
  db.run('CREATE TABLE data_app_project_links (app_id TEXT, project_id TEXT)'); db.run("INSERT INTO data_app_project_links VALUES ('a','p')");
  db.run('CREATE TABLE amounts (amount REAL, secret TEXT)'); db.run("INSERT INTO amounts VALUES (10,'hidden'),(20,'hidden')");
  ManagedAppQueries.migrate(db);
  const schema = dataObjectModelSchema.parse({ id: 's', name: '收入', kind: 'SQLite', storageMode: 'local', annotations: {}, operations: ['query'], resources: [
    { id: 't', name: '收入', sheetName: 'amounts', columns: [{ id: 'amount', name: '金额', type: '小数', nullable: false }, { id: 'secret', name: '隐藏', type: '文本', nullable: true, sensitive: true }] },
    { id: 'outside', name: '未授权表', sheetName: 'outside', columns: [] },
  ] });
  let revoke = false;
  const gateway = { async list() { return []; }, async schema() { return schema; }, async query(q: any) {
    if (revoke) db.run("UPDATE data_apps SET owner_user_id = 'other' WHERE id = 'a'");
    return executeLocalStructuredQuery(db, q, { name: 'amounts', columns: [{ id: 'amount', name: '金额', type: '小数', nativeName: 'amount' }, { id: 'secret', name: '隐藏', type: '文本', nativeName: 'secret' }] }, 'local');
  } };
  const service = new ManagedAppQueries(db, () => {}, gateway); service.createScope('a', 's', ['t']);
  const result = await service.register('a', owner, definition()); assert.equal((result.result as { rows: Array<{ total: number }> }).rows[0].total, 30);
  assert.equal(service.list('a').length, 1);
  assert.ok(service.list('a')[0].resultFields.some((f: { id: string }) => f.id === 'total'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.register('a', owner, { ...definition(), operationId: 'cancelled' }, controller.signal));
  assert.equal(service.list('a').length, 1);
  assert.equal((await service.invoke('a', owner, { operationId: 'total', parameters: { minimum: 15 } }) as any).rows[0].total, 20);
  await assert.rejects(service.register('a', owner, { ...definition(), query: { ...definition().query, tableId: 'outside' } }), /超出/);
  await assert.rejects(service.query('a', owner, structuredDataQuerySchema.parse({ sourceId: 's', tableId: 't', fields: ['secret'] })), /敏感/);
  await assert.rejects(service.register('a', owner, { ...definition(), query: { ...definition().query, metrics: [{ operation: 'sum', alias: 'total', fieldId: 'missing' }] } }), /字段/);
  assert.equal((await new ManagedAppQueries(db, () => {}, gateway).invoke('a', owner, { operationId: 'total', parameters: { minimum: 1 } }) as any).rows[0].total, 30);
  await assert.rejects(service.context('a', { ...owner, orgId: 'other' }), /无权/);
  assert.ok(!JSON.stringify(await service.context('a', owner)).includes('未授权表'));
  const store = new MemoryStore();
  await store.set('run:r', JSON.stringify({ id: 'r', kind: 'project-task', status: 'running', sessionId: 'p', ownerUserId: 'u', orgId: 'o' }));
  await store.set('projects:p', JSON.stringify({ ownerUserId: 'u', orgId: 'o', accessScope: 'private' }));
  const exec = (await createAgentDataExecutor({ store, gateway, activeOwner: () => owner, appQueries: async () => service }, 'r', 'general'))!;
  assert.ok(exec.tools?.includes('data_app_register_query'));
  assert.equal((await exec('data_get_schema', { sourceId: 's' }) as any).ok, true);
  assert.equal((await exec('data_query', { sourceId: 's', tableId: 'outside' }) as any).code, 'APP_SCOPE_EXCEEDED');
  await store.set('projects:p', JSON.stringify({ ownerUserId: 'u', orgId: 'o', accessScope: 'org-shared' }));
  assert.equal((await exec('data_app_test_query', { operationId: 'total', parameters: { minimum: 1 } }) as any).code, 'DATA_PRIVATE_ONLY');
  revoke = true;
  await assert.rejects(service.invoke('a', owner, { operationId: 'total', parameters: { minimum: 1 } }), /无权/);
  db.run("DELETE FROM data_apps WHERE id = 'a'");
  await assert.rejects(createAgentDataExecutor({ store, gateway, activeOwner: () => owner, appQueries: async () => service }, 'r', 'general'), /无权/);
  db.close();
});

test('MDA-R1/R3/R4/R5: API conversation project, token cannot query/CRUD, registration before binding, private authenticated execution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-mda-'));
  const keys = ['WORKMATE_DATA_DIR', 'WORKMATE_ORCH_RUNNER', 'WORKMATE_WORKSPACES_DIR'] as const;
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  process.env.WORKMATE_DATA_DIR = root; process.env.WORKMATE_WORKSPACES_DIR = path.join(root, 'runs'); process.env.WORKMATE_ORCH_RUNNER = 'memory-echo';
  applyParentSecrets({ model: { activeProvider: 'ollama', providers: [{ provider: 'ollama', chatModel: 'synthetic', apiKey: 'synthetic' }] } });
  const app = Fastify();
  const liveCalls: string[] = [];
  const newTables = new Set<string>();
  const remoteFactory: RemoteFactory = async connection => ({ async query(sql, values = []) {
    liveCalls.push(sql);
    if (sql.includes('COUNT(*) AS n')) return [{ n: newTables.has(String(values[1])) ? 1 : 0 }];
    if (sql.startsWith('CREATE TABLE')) { newTables.add('business_notes'); return []; }
    if (sql.includes('TABLE_TYPE') || sql.includes('obj_description')) return [{ schema_name: connection.engine === 'mysql' ? 'business' : 'public', table_name: 'orders', table_engine: 'InnoDB' }, ...(connection.engine === 'mysql' ? [...newTables].map(name => ({ schema_name: 'business', table_name: name, table_engine: 'InnoDB' })) : [])];
    if (sql.includes('COLUMNS') && values[1] === 'business_notes') return [{ name: 'id', data_type: 'bigint', nullable: 'NO', key_type: 'PRI', extra: 'auto_increment' }, { name: 'title', data_type: 'varchar', nullable: 'NO' }];
    if (sql.includes('COLUMNS') || sql.includes('col_description')) return [{ name: 'amount', data_type: 'decimal', nullable: 'YES' }];
    if (sql.includes('AS `total`') || sql.includes('AS "total"')) return [{ total: 42 }];
    return [];
  }, async execute() { throw new Error('read-only app must never execute mutations'); }, async close() {}, destroy() {} });
  await app.register(publicDataAppRoutes, { prefix: '/api' });
  await app.register(async secured => {
    secured.addHook('preHandler', async (r, reply) => { if (r.headers['x-user'] === 'none') return reply.code(401).send({ message: '请登录' }); r.auth = { ...owner, userId: String(r.headers['x-user'] || 'u'), role: 'admin', username: 'u', displayName: 'u', sessionId: 'test' }; });
    await secured.register(dataRoutes, { remoteFactory });
  }, { prefix: '/api' });
  try {
    assert.equal((await app.inject({ method: 'PUT', url: '/api/data/credential-bridge', payload: { port: 1234, token: 'a'.repeat(64) } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/data/credential-bridge', headers: { 'x-user': 'none' }, payload: { port: 1234, token: 'a'.repeat(64) } })).statusCode, 401);
    const source = (await app.inject({ method: 'POST', url: '/api/data/import', payload: { name: 'amounts.json', contentBase64: Buffer.from('[{"收入":10},{"收入":20}]').toString('base64') } })).json();
    const request = { requestId: randomUUID(), sourceId: source.id, tableId: source.tables[0].id, employeeId: 'general', queryMode: 'managed-readonly', idea: '统计收入' };
    const createdResponse = await app.inject({ method: 'POST', url: '/api/data/apps/project-create', payload: request });
    assert.equal(createdResponse.statusCode, 200, createdResponse.body); const created = createdResponse.json();
    const project = await getOrchestrator().projects.getProject(created.projectId); assert.equal(project?.kind, 'conversation'); assert.equal(project?.tasks.length, 1);
    for (let i = 0; i < 200 && (await getOrchestrator().projects.getProject(created.projectId))?.status === 'running'; i++) await new Promise(r => setTimeout(r, 20));
    assert.notEqual((await getOrchestrator().projects.getProject(created.projectId))?.status, 'running', 'synthetic run must settle before temporary workspace cleanup');
    const replay = await app.inject({ method: 'POST', url: '/api/data/apps/project-create', payload: request }); assert.equal(replay.json().projectId, created.projectId); assert.equal(replay.json().started, false);
    const listed = (await app.inject({ method: 'GET', url: '/api/data/apps' })).json()[0];
    const token = new URL(listed.publishUrl).searchParams.get('token')!, id = created.appId;
    const html = '<!doctype html><html><body><h1>收入</h1><script>workmateData.query("total",{}).then(r=>document.body.append(JSON.stringify(r)))</script></body></html>';
    const bind = () => app.inject({ method: 'PUT', url: `/api/data-apps/${id}/custom-site?token=${token}`, payload: { html } });
    assert.equal((await bind()).statusCode, 400);
    const service = await createManagedAppQueries();
    const sqlOperation = { kind: 'sql', operationId: 'sqlTotal', description: 'SQL 合计', sql: `SELECT SUM(c_1) AS total FROM \`${source.tables[0].id}\``, parameters: [], testParameters: {} };
    await service.registerSql(id, owner, sqlOperation);
    const sqlResult = await app.inject({ method: 'POST', url: `/api/data/apps/${id}/query`, payload: { operationId: 'sqlTotal' } });
    assert.equal(sqlResult.statusCode, 200, sqlResult.body); assert.equal(sqlResult.json().rows[0].total, 30);
    const assetStore=getOrchestrator().store;
    await assetStore.set('run:query-asset-fixture',JSON.stringify({id:'query-asset-fixture',kind:'project-task',status:'running',sessionId:created.projectId,ownerUserId:owner.userId,orgId:owner.orgId}));
    const assetDeps={store:assetStore,gateway:createStructuredDataGateway(remoteFactory),activeOwner:()=>owner,appQueries:async()=>service};
    const queryExec=(await createAgentDataExecutor(assetDeps,'query-asset-fixture','general','统计收入'))!;
    const sqlAnswer=await queryExec('data_app_test_query',{operationId:'sqlTotal'}) as any;
    assert.equal(sqlAnswer.ok,true);assert.ok(sqlAnswer.data.queryReceipt.receiptId);
    const saveExec=(await createAgentDataExecutor(assetDeps,'query-asset-fixture','general','保存这个查询为收入合计'))!;
    const savedAsset=await saveExec('data_save_query_asset',{name:'收入合计',receiptId:sqlAnswer.data.queryReceipt.receiptId}) as any;
    assert.equal(savedAsset.ok,true);const assetId=savedAsset.data.assetId;
    const reused=await saveExec('data_run_query_asset',{assetId}) as any;
    assert.equal(reused.ok,true);assert.equal(reused.data.result.rows[0].total,30);
    const assetList=await app.inject({url:'/api/data/query-assets'});assert.equal(assetList.statusCode,200);assert.equal(assetList.json().assets[0].id,assetId);
    assert.equal((await app.inject({url:'/api/data/query-assets',headers:{'x-user':'other'}})).json().assets.length,0);
    assert.equal((await app.inject({method:'DELETE',url:`/api/data/query-assets/${assetId}`,headers:{'x-user':'other'}})).statusCode,404);
    assert.equal((await app.inject({method:'DELETE',url:`/api/data/query-assets/${assetId}`})).statusCode,200);
    assert.equal((await saveExec('data_run_query_asset',{assetId}) as any).code,'QUERY_ASSET_NOT_FOUND');
    const sqlBefore = service.list(id).find(o => o.operationId === 'sqlTotal')!.revision;
    await assert.rejects(service.registerSql(id, owner, { ...sqlOperation, sql: 'SELECT c_1 FROM unknown' }));
    assert.equal(service.list(id).find(o => o.operationId === 'sqlTotal')!.revision, sqlBefore);
    assert.equal((await app.inject({ url: `/api/data/projects/${created.projectId}/application` })).json().appId, id);
    const access = await app.inject({ url: `/api/data/apps/${id}/operations` });
    assert.equal(access.statusCode,200); assert.equal(access.json().canWrite,false); assert.equal(access.json().writeEnabled,false);
    assert.equal((await app.inject({ url: `/api/data/apps/${id}/operations`, headers: { 'x-user': 'other' } })).statusCode,404);
    assert.equal((await app.inject({ url: `/api/data/projects/${created.projectId}/application`, headers: { 'x-user': 'other' } })).statusCode, 404);
    await service.register(id, owner, { operationId: 'total', description: '合计', query: { sourceId: source.id, tableId: source.tables[0].id, metrics: [{ fieldId: 'c_1', operation: 'sum', alias: 'total' }] } });
    assert.equal((await bind()).statusCode, 200);
    const invoke = (user = 'u', payload: object = { operationId: 'total', parameters: {} }) => app.inject({ method: 'POST', url: `/api/data/apps/${id}/query`, headers: { 'x-user': user }, payload });
    assert.equal((await invoke()).json().rows[0].total, 30);
    for (const engine of ['mysql', 'postgresql'] as const) {
      const connection = (await app.inject({ method: 'POST', url: '/api/data/connections', payload: { name: engine, connection: { engine, host: 'localhost', database: 'business', user: 'reader', password: 'synthetic', tls: false } } })).json();
      const liveResponse = await app.inject({ method: 'POST', url: '/api/data/sources/live', payload: { connectionId: connection.id, database: 'business', name: engine, tables: [{ schema: engine === 'mysql' ? 'business' : 'public', name: 'orders' }] } });
      assert.equal(liveResponse.statusCode, 201, liveResponse.body); const live = liveResponse.json();
      const liveCreated = await app.inject({ method: 'POST', url: '/api/data/apps/project-create', payload: { ...request, requestId: randomUUID(), sourceId: live.id, tableId: live.tables[0].id } });
      assert.equal(liveCreated.statusCode, 200, liveCreated.body); const next = liveCreated.json();
      for (let i = 0; i < 200 && (await getOrchestrator().projects.getProject(next.projectId))?.status === 'running'; i++) await new Promise(r => setTimeout(r, 20));
      const managed = await createManagedAppQueries(remoteFactory);
      const before = liveCalls.length;
      const objectContext = await managed.context(next.appId, owner, { sourceId: live.id, view: 'tables' });
      assert.equal((objectContext.schema as any).metadataOrigin, 'object'); assert.equal(liveCalls.length, before);
      const supplemented = await managed.context(next.appId, owner, { sourceId: live.id, tableId: live.tables[0].id, origin: 'database' });
      assert.equal((supplemented.schema as any).resources[0].columns[0].databaseMetadata.nativeType, 'decimal');
      assert.equal(liveCalls.length, before + 1); assert.match(liveCalls.at(-1)!, /LIMIT 201/);
      await assert.rejects(managed.context(next.appId, owner, { sourceId: live.id, tableId: 'outside', origin: 'database' }), /授权集合/);
      assert.equal(liveCalls.length, before + 1);
      await managed.register(next.appId, owner, { operationId: 'total', description: '实时合计', query: { sourceId: live.id, tableId: live.tables[0].id, metrics: [{ fieldId: 'c_1', operation: 'sum', alias: 'total' }] } });
      const liveResult = await app.inject({ method: 'POST', url: `/api/data/apps/${next.appId}/query`, payload: { operationId: 'total' } });
      assert.equal(liveResult.statusCode, 200, liveResult.body); assert.equal(liveResult.json().rows[0].total, 42); assert.equal(liveResult.json().storageMode, 'live');
      if (engine === 'mysql') {
        // A sibling application must not inherit the explicitly approved new table.
        const siblingResponse = await app.inject({ method: 'POST', url: '/api/data/apps/project-create', payload: { ...request, requestId: randomUUID(), sourceId: live.id, tableId: live.tables[0].id } });
        assert.equal(siblingResponse.statusCode, 200, siblingResponse.body); const sibling = siblingResponse.json();
        for (let i = 0; i < 200 && (await getOrchestrator().projects.getProject(sibling.projectId))?.status === 'running'; i++) await new Promise(r => setTimeout(r, 20));
        const proposal = await managed.proposeSchema(next.appId, owner, { description: '新业务记录', sql: ['CREATE TABLE business_notes (id BIGINT PRIMARY KEY AUTO_INCREMENT, title VARCHAR(80) NOT NULL)'] });
        assert.equal(newTables.size, 0);
        const metadata = (await app.inject({ url: `/api/data/projects/${next.projectId}/application` })).json();
        assert.equal(metadata.schemaCreation.supported, true); assert.equal(metadata.schemaCreation.enabled, false);
        const plan = metadata.schemaCreation.plans.find((p: any) => p.id === proposal.id);
        const enable = await app.inject({ method: 'PATCH', url: `/api/data/apps/${next.appId}/schema-access`, payload: { enabled: true, confirmed: true } });
        assert.equal(enable.statusCode, 200, enable.body);
        const executePayload = { revision: plan.revision, confirmed: true, includeInObject: true };
        const endpoint = `/api/data/apps/${next.appId}/schema-plans/${plan.id}/execute`;
        assert.equal((await app.inject({ method: 'POST', url: endpoint, headers: { 'x-user': 'other' }, payload: executePayload })).statusCode, 404);
        const execution = await app.inject({ method: 'POST', url: endpoint, payload: executePayload });
        assert.equal(execution.statusCode, 200, execution.body); assert.equal(execution.json().state, 'applied', execution.body);
        const expanded = managed.authorize(next.appId, owner), unchanged = managed.authorize(sibling.appId, owner);
        assert.equal(expanded.tableIds.length, 2); assert.deepEqual(unchanged.tableIds, [live.tables[0].id]);
        const latest = await managed.context(next.appId, owner, { sourceId: live.id, view: 'tables' });
        assert.ok(JSON.stringify(latest).includes('business_notes'));
        assert.equal((await app.inject({ method: 'POST', url: endpoint, payload: executePayload })).statusCode, 409);
        const finalMetadata = (await app.inject({ url: `/api/data/projects/${next.projectId}/application` })).json();
        assert.equal(finalMetadata.schemaCreation.plans[0].state, 'applied'); assert.equal(finalMetadata.writeEnabled, false);
      }
    }
    assert.ok(liveCalls.some(sql => sql.endsWith('READ ONLY')));
    assert.equal((await invoke('other')).statusCode, 404); assert.equal((await invoke('none')).statusCode, 401);
    assert.equal((await invoke('u', { operationId: 'total', sql: 'SELECT *' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: `/api/data-apps/${id}/data?token=${token}` })).statusCode, 404);
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const suffix = method === 'POST' ? '' : '/1';
      assert.equal((await app.inject({ method, url: `/api/data-apps/${id}/records${suffix}?token=${token}`, payload: method === 'DELETE' ? undefined : { fields: { c_1: '999' } } })).statusCode, 404);
      assert.equal((await app.inject({ method, url: `/api/data/apps/${id}/records${suffix}`, payload: method === 'DELETE' ? undefined : { fields: { c_1: '999' } } })).statusCode, 404);
    }
    const page = await app.inject({ method: 'GET', url: `/api/data-apps/${id}/site?token=${token}` });
    assert.equal(page.statusCode, 200); assert.match(page.body, /sandbox="allow-scripts allow-forms"/); assert.doesNotMatch(page.body, /allow-same-origin/);
    assert.match(page.body, /x-workmate-session/); assert.doesNotMatch(page.body, new RegExp(token)); assert.doesNotMatch(page.body, /localStorage/);
    assert.equal((await invoke()).json().rows[0].total, 30);
  } finally {
    await app.close(); applyParentSecrets({}); for (const k of keys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MDA-R4: wrapper safely embeds hostile markup without ending host script', () => {
  const page = managedAppPage('a', '</script><script>parent.evil=true</script>');
  assert.ok(page.includes('\\u003c/script>')); assert.doesNotMatch(page, /<script>parent.evil/);
  assert.match(page, /connect-src 'none'/); assert.match(page, /e.source!==frame.contentWindow/);
});
