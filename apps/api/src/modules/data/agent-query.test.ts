import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import { createServer } from 'node:http';
import { MemoryStore, type AgentRunner } from '@openclawx/orchestrator';
import { dataObjectModelSchema, employeeDataAssociationKey } from '@openclawx/contracts';
import { createAgentDataExecutor, createDataAgentRunner, type AgentDataGateway } from './agent-query.js';
import { createStructuredDataGateway, dataRoutes } from './routes.js';
import { StructuredQueryError } from './structured-query.js';
import { activeDataRunOwner, localUserAuthService } from '../auth/service.js';
import { registerAgentDataAssociations } from './agent-associations.js';

const schema = () => dataObjectModelSchema.parse({ id: 's', name: '经营数据', kind: 'SQLite', annotations: { description: '仅作业务数据', connectionDescription: 'password=must-not-leak' }, storageMode: 'snapshot', api: { url: 'https://secret.example', method: 'GET', itemsPath: '', description: '' }, resources: [{ id: 't', name: '营收', sheetName: 'private-native', columns: [{ id: 'amount', name: '收入', type: '小数', nullable: false, sample: 'secret-sample' }, { id: 'secret', name: '隐私', type: '文本', nullable: true, sample: '', sensitive: true }] }], operations: ['query'] });
async function fixture() {
  const store = new MemoryStore(); let active = true, queries = 0, currentSchema = schema();
  const run = { id: 'r', ownerUserId: 'u', orgId: 'o', status: 'running', kind: 'chat', sessionId: 'c', accessScope: 'private' };
  const resource = { ownerUserId: 'u', orgId: 'o', accessScope: 'private' };
  await store.set('run:r', JSON.stringify(run)); await store.set('sessions:c', JSON.stringify(resource));
  const setIds = async (ids: string[]) => store.set(employeeDataAssociationKey({ userId: 'u', orgId: 'o' }, 'general'), JSON.stringify({ dataSourceIds: ids }));
  await setIds(['s']);
  const gateway: AgentDataGateway = {
    async list(auth) { assert.deepEqual(auth, { userId: 'u', orgId: 'o' }); return [{ id: 's', name: '经营数据', fileType: 'SQLite', accessMode: 'snapshot' }, { id: 'not-associated', name: 'other', fileType: 'SQLite' }]; },
    async schema(id, auth) { if (id !== 's' || auth.userId !== 'u') throw new StructuredQueryError('不可访问', 'DATA_NOT_FOUND', 404); return currentSchema; },
    async query(input) { queries++; assert.deepEqual(input.fields, ['amount']); return { rows: [{ amount: 12 }], queriedAt: '2026-10-12T00:00:00Z', hasMore: false }; },
  };
  const dependencies = { store, gateway, activeOwner: (userId: string, orgId: string) => active && userId === 'u' && orgId === 'o' ? { userId, orgId } : null };
  return { ...dependencies, dependencies, setIds, run, resource, queryCount: () => queries, disable: () => { active = false; }, setSchema: (s: ReturnType<typeof schema>) => { currentSchema = s; } };
}

test('QA-T1: explicit cross-turn saving, live rerun, strict inputs, scope revocation and failed-query receipts',async()=>{
  const f=await fixture(),first=(await createAgentDataExecutor(f.dependencies,'r','general','查询营收'))!;
  assert.ok(!first.tools?.includes('data_save_query_asset'));
  const answer=await first('data_query',{sourceId:'s',tableId:'t'}) as any;
  assert.equal(answer.ok,true);assert.ok(answer.data.queryReceipt.receiptId);
  assert.equal((await first('data_save_query_asset',{name:'营收'}) as any).code,'QUERY_ASSET_EXPLICIT_SAVE_REQUIRED');
  const next=(await createAgentDataExecutor(f.dependencies,'r','general','保存这个查询为“营收”'))!;
  assert.ok(next.tools?.includes('data_save_query_asset'));
  const saved=await next('data_save_query_asset',{name:'营收',receiptId:answer.data.queryReceipt.receiptId}) as any;
  assert.equal(saved.ok,true);assert.equal(saved.data.status,'execution-verified');
  assert.equal((await next('data_save_query_asset',{name:'伪造',sql:'SELECT * FROM secret'}) as any).code,'INVALID_QUERY');
  assert.equal((await next('data_list_query_assets',{search:'营收'}) as any).data.assets.length,1);
  const count=f.queryCount();const rerun=await next('data_run_query_asset',{assetId:saved.data.assetId}) as any;
  assert.equal(rerun.ok,true);assert.equal(f.queryCount(),count+1);
  const before=await f.store.get('query-assets:v1:o:u:receipts:c');
  assert.equal((await next('data_query',{sourceId:'s',tableId:'t',fields:['secret']}) as any).ok,false);
  assert.equal(await f.store.get('query-assets:v1:o:u:receipts:c'),before);
  await f.setIds([]);assert.equal((await next('data_run_query_asset',{assetId:saved.data.assetId}) as any).code,'DATA_NOT_ASSOCIATED');
});

test('ADQ-R2/R5/R6: discovery, safe metadata, projection and sensitive field rejection', async () => {
  const f = await fixture(), exec = (await createAgentDataExecutor(f.dependencies, 'r', 'general'))!;
  const list = await exec('data_list_objects', {}) as any;
  assert.equal(list.data.objects.length, 1); assert.equal(list.data.objects[0].sourceId, 's');
  const metadata = JSON.stringify(await exec('data_get_schema', { sourceId: 's' }));
  for (const secret of ['must-not-leak', 'secret.example', 'private-native', 'secret-sample', '隐私']) assert.ok(!metadata.includes(secret));
  const good = await exec('data_query', { sourceId: 's', tableId: 't' }) as any;
  assert.equal(good.ok, true); assert.match(good.data.notice, /仅覆盖/); assert.equal(good.data.provenance.tableName, '营收');
  for (const patch of [{ fields: ['secret'] }, { filters: { fieldId: 'secret', operator: 'isNull' } }, { metrics: [{ fieldId: 'secret', operation: 'count', alias: 'total' }] }, { orderBy: [{ fieldId: 'secret' }] }, { dimensions: [{ fieldId: 'secret' }] }]) {
    assert.equal((await exec('data_query', { sourceId: 's', tableId: 't', ...patch }) as any).code, 'DATA_FIELD_RESTRICTED');
  }
  assert.equal(f.queryCount(), 1);
  assert.equal((await exec('data_query', { sourceId: 's', tableId: 't', userId: 'admin' }) as any).code, 'INVALID_QUERY');
  assert.equal((await exec('data_get_schema', { sourceId: 'not-associated' }) as any).code, 'DATA_NOT_ASSOCIATED');
});

test('ADQ-R3: no global fallback, revoked bindings, disabled accounts and shared/private lifecycle', async () => {
  const f = await fixture(), exec = (await createAgentDataExecutor(f.dependencies, 'r', 'general'))!;
  await f.setIds([]);
  await f.store.set('workspace.employee-runtime-prefs', JSON.stringify({ general: { dataSourceIds: ['s'] } }));
  assert.equal((await exec('data_list_objects', {}) as any).code, 'DATA_NOT_ASSOCIATED');
  assert.equal(await createAgentDataExecutor(f.dependencies, 'r', 'general'), undefined);
  await f.setIds(['s']);
  await f.store.set('sessions:c', JSON.stringify({ ...f.resource, accessScope: 'org-shared' }));
  assert.equal((await exec('data_list_objects', {}) as any).code, 'DATA_PRIVATE_ONLY');
  await f.store.set('sessions:c', JSON.stringify({ ...f.resource, accessGrants: [{ subjectId: 'other' }] }));
  assert.equal((await exec('data_list_objects', {}) as any).code, 'DATA_PRIVATE_ONLY');
  await f.store.set('sessions:c', JSON.stringify(f.resource));
  f.disable(); assert.equal((await exec('data_list_objects', {}) as any).code, 'DATA_ACCESS_DENIED');
  assert.equal(f.queryCount(), 0);
});

test('SDQ2-R5: model queries reject sensitive metric conditions, joined fields and relation keys', async () => {
  const f = await fixture(), s = schema();
  s.resources.push({ id: 'target', name: '目标', sheetName: 'target', columns: [
    { id: 'key', name: '键', type: '小数', nullable: true },
    { id: 'hidden', name: '敏感', type: '文本', nullable: true, sensitive: true },
  ] });
  s.annotations.relations = [{ id: 'rel', name: '关系', fromTableId: 't', toTableId: 'target', keys: [{ fromFieldId: 'amount', toFieldId: 'key' }] }];
  f.setSchema(s);
  const exec = (await createAgentDataExecutor(f.dependencies, 'r', 'general'))!;
  const joins = [{ relationId: 'rel', type: 'left' }];
  for (const patch of [
    { metrics: [{ operation: 'count', alias: 'n', filters: { fieldId: 'secret', operator: 'isNull' } }] },
    { joins, fields: ['target::hidden'] },
    { joins, metrics: [{ operation: 'count', alias: 'n', filters: { fieldId: 'target::hidden', operator: 'isNull' } }] },
  ]) assert.equal((await exec('data_query', { sourceId: 's', tableId: 't', ...patch }) as any).code, 'DATA_FIELD_RESTRICTED');
  let seen: any;
  f.gateway.query = async input => { seen = input; return { rows: [] }; };
  assert.equal((await exec('data_query', { sourceId: 's', tableId: 't', joins }) as any).ok, true);
  assert.deepEqual(seen.fields, ['amount', 'target::key']);
  const changed = structuredClone(s);
  f.gateway.query = async () => { changed.annotations.relations[0].keys[0].toFieldId = 'hidden'; changed.resources[1].columns[1].sensitive = false; f.setSchema(changed); return { rows: [] }; };
  assert.equal((await exec('data_query', { sourceId: 's', tableId: 't', joins }) as any).code, 'INVALID_RELATION');
  f.setSchema(s);
  s.resources[1].columns[0].sensitive = true;
  assert.equal((await exec('data_query', { sourceId: 's', tableId: 't', joins }) as any).code, 'DATA_FIELD_RESTRICTED');
  const metadata = await exec('data_get_schema', { sourceId: 's' }) as any;
  assert.deepEqual(metadata.data.relations, []);
});

test('ADQ-R3/R6/R7: revoke during query, result bounds, cancellation and driver error sanitization', async () => {
  const f = await fixture(), exec = (await createAgentDataExecutor(f.dependencies, 'r', 'general'))!;
  f.gateway.query = async () => { await f.setIds([]); return { rows: [{ amount: 999 }] }; };
  assert.equal((await exec('data_query', { sourceId: 's', tableId: 't' }) as any).code, 'DATA_NOT_ASSOCIATED');
  await f.setIds(['s']);
  f.gateway.query = async () => ({ rows: [{ amount: 'x'.repeat(256_001) }] });
  assert.equal((await exec('data_query', { sourceId: 's', tableId: 't' }) as any).code, 'DATA_RESULT_TOO_LARGE');
  f.gateway.query = async () => { throw new Error('secret-password driver payload'); };
  assert.ok(!JSON.stringify(await exec('data_query', { sourceId: 's', tableId: 't' })).includes('secret-password'));
  const ctrl = new AbortController(); ctrl.abort();
  assert.equal((await exec('data_query', {}, ctrl.signal) as any).code, 'DATA_CANCELLED');
  f.gateway.query = async () => { const s = schema(); s.resources[0].columns[0].sensitive = true; f.setSchema(s); return { rows: [{ amount: 999 }] }; };
  assert.equal((await exec('data_query', { sourceId: 's', tableId: 't' }) as any).code, 'DATA_FIELD_RESTRICTED');
});

test('ADQ-R3/R4: private project, org mismatch, untrusted request context and text-only runner', async () => {
  const f = await fixture();
  await f.store.set('run:r', JSON.stringify({ ...f.run, kind: 'project-task', sessionId: 'p' }));
  await f.store.set('projects:p', JSON.stringify(f.resource));
  assert.ok(await createAgentDataExecutor(f.dependencies, 'r', 'general'));
  await f.store.set('projects:p', JSON.stringify({ ...f.resource, orgId: 'other' }));
  assert.equal(await createAgentDataExecutor(f.dependencies, 'r', 'general'), undefined);
  await f.store.set('run:r', JSON.stringify(f.run));
  let calls = 0;
  const base: AgentRunner = { async start() { calls++; } };
  const runner = createDataAgentRunner(f.dependencies, base);
  await runner.start({ profile: { id: 'general' }, responseMode: 'text-only', runId: 'fake', dataSourceIds: ['s'], userId: 'u' } as any, () => {});
  assert.equal(calls, 1);
  assert.equal(await createAgentDataExecutor(f.dependencies, 'fake', 'general'), undefined);
});

test('ADQ-R1/R3: scoped binding API supports members, survives reload, rejects foreign IDs and identity injection', async () => {
  const f = await fixture(), app = Fastify();
  f.gateway.list = async auth => auth.userId === 'u' && auth.orgId === 'o' ? [{ id: 's', name: 'data', fileType: 'SQLite' }] : [];
  app.addHook('preHandler', async r => { r.auth = { userId: String(r.headers['x-user'] || 'u'), orgId: String(r.headers['x-org'] || 'o'), role: 'member', username: 'test', displayName: 'test', sessionId: 'test' }; });
  registerAgentDataAssociations(app, () => f.store, f.gateway);
  const call = (method: 'GET' | 'PUT', payload?: object, headers?: Record<string, string>) => app.inject({ method, url: '/data/agent-associations/general', payload, headers });
  try {
    assert.equal((await call('PUT', { dataSourceIds: ['s', 's'] })).statusCode, 200);
    assert.deepEqual((await call('GET')).json(), { dataSourceIds: ['s'] });
    assert.deepEqual((await call('GET', undefined, { 'x-user': 'other' })).json(), { dataSourceIds: [] });
    assert.deepEqual((await call('GET', undefined, { 'x-org': 'other' })).json(), { dataSourceIds: [] });
    assert.equal((await call('PUT', { dataSourceIds: ['s'] }, { 'x-user': 'other' })).statusCode, 404);
    assert.equal((await call('PUT', { dataSourceIds: ['s'], userId: 'other' })).statusCode, 400);
    const exec = (await createAgentDataExecutor(f.dependencies, 'r', 'general'))!;
    assert.equal((await exec('data_list_objects', {}) as any).ok, true);
    assert.equal((await call('PUT', { dataSourceIds: [] })).statusCode, 200);
    assert.equal((await exec('data_list_objects', {}) as any).code, 'DATA_NOT_ASSOCIATED');
  } finally { await app.close(); }
});

test('ADQ-R2/R3: actual local gateway reused by model tools, owner/org checked and aggregate is database-side', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-adq-')), old = process.env.OPENCLAWX_DATA_DIR;
  process.env.OPENCLAWX_DATA_DIR = dir;
  const app = Fastify(); app.addHook('preHandler', async request => { request.auth = { userId: 'u', orgId: 'o', role: 'admin', username: 'u', displayName: 'u', sessionId: 'test' }; });
  try {
    await app.register(dataRoutes);
    const accounts = localUserAuthService(), account = accounts.createUser({ username: 'adq-test', displayName: '测试', password: 'synthetic-test', orgId: 'o' });
    assert.deepEqual(activeDataRunOwner(account.id, 'o'), { userId: account.id, orgId: 'o' });
    assert.equal(activeDataRunOwner(account.id, 'other'), null);
    accounts.updateUser(account.id, { disabled: true }); assert.equal(activeDataRunOwner(account.id, 'o'), null);
    const imported = await app.inject({ method: 'POST', url: '/data/import', payload: { name: '问数数据.json', contentBase64: Buffer.from(JSON.stringify([{ 收入: 10 }, { 收入: 20 }])).toString('base64') } });
    assert.equal(imported.statusCode, 200, imported.body);
    const source = imported.json(), f = await fixture(), gateway = createStructuredDataGateway();
    await f.setIds([source.id]);
    const exec = (await createAgentDataExecutor({ ...f.dependencies, gateway }, 'r', 'general'))!;
    const result = await exec('data_query', { sourceId: source.id, tableId: source.tables[0].id, metrics: [{ fieldId: 'c_1', operation: 'sum', alias: 'total' }] }) as any;
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.result.rows[0].total, 30);
    await assert.rejects(gateway.schema(source.id, { userId: 'other', orgId: 'o' }), /无权/);
    await assert.rejects(gateway.schema(source.id, { userId: 'u', orgId: 'other' }), /无权/);
    // Real Pi loop + synthetic local model: verifies host identity reaches native
    // tools even though the request contains no data grants or credentials.
    let turns = 0, observedTotal: unknown; const exposedTools: string[][] = [];
    const model = createServer(async (request, reply) => {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); turns++;
      exposedTools.push(body.tools.map((t: any) => t.function.name));
      if (turns === 4) {
        const toolMessage = body.messages.find((m: any) => m.tool_call_id === 'data-3');
        observedTotal = JSON.parse(toolMessage.content).data.result.rows[0].total;
      }
      const calls = [
        { name: 'data_list_objects', arguments: '{}' },
        { name: 'data_get_schema', arguments: JSON.stringify({ sourceId: source.id }) },
        { name: 'data_query', arguments: JSON.stringify({ sourceId: source.id, tableId: source.tables[0].id, metrics: [{ fieldId: 'c_1', operation: 'sum', alias: 'total' }] }) },
      ];
      const call = calls[turns - 1];
      const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `data-${turns}`, type: 'function', function: call }] } : { role: 'assistant', content: '已按数据对象查询：收入合计30，仅覆盖已导入记录。' };
      const chunk = (value: unknown, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'adq', object: 'chat.completion.chunk', model: 'deepseek-chat', choices: [{ index: 0, delta: value, finish_reason }] }) + '\n\n';
      reply.writeHead(200, { 'content-type': 'text/event-stream' }); reply.write(chunk(delta, null)); reply.end(chunk({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    });
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
    try {
      const runner = createDataAgentRunner({ ...f.dependencies, gateway });
      const events: any[] = [];
      await runner.start({ runId: 'r', engine: 'pi', projectWorkspacePath: path.join(dir, 'run-workspace'),
        profile: { id: 'general', name: '测试员工', instructions: '查询一次收入', toolIds: [] },
        model: { provider: 'deepseek', chatModel: 'deepseek-chat', baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, apiKey: 'synthetic' },
        messages: [{ role: 'user', content: '查询关联对象的收入合计' }], skills: [], searchProviders: [], mcpConnections: [], knowledgeBases: [],
      }, event => events.push(event));
      assert.equal(turns, 4); assert.equal(events.at(-1).type, 'run.completed', JSON.stringify(events.at(-1)));
      assert.equal(observedTotal, 30); assert.ok(exposedTools.every(tools => tools.includes('data_query')));
      assert.equal(events.filter(e => e.type === 'tool.completed' && e.toolName.startsWith('data_')).length, 3);
    } finally { model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); }
  } finally { await app.close(); if (old === undefined) delete process.env.OPENCLAWX_DATA_DIR; else process.env.OPENCLAWX_DATA_DIR = old; fs.rmSync(dir, { recursive: true, force: true }); }
});
