import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import Fastify from 'fastify';
import { dataObjectAnnotationsSchema } from '@openclawx/contracts';
import { jsonDataRows, readAnnotations, modelReadableSchema } from './data-object.js';
import { dataRoutes } from './routes.js';
import './remote-database.test.js';

test('DO-R2/R3: latest annotations validate nested paths and reject duplicates', () => {
  assert.equal(readAnnotations().description, '');
  const field = { path: 'data.items[].amount', location: 'response', type: 'number', required: true, description: '元' };
  assert.ok(dataObjectAnnotationsSchema.safeParse({ apiFields: [field] }).success);
  assert.equal(dataObjectAnnotationsSchema.safeParse({ apiFields: [field, field] }).success, false);
  assert.equal(dataObjectAnnotationsSchema.safeParse({ description: 'a'.repeat(4001) }).success, false);
  assert.throws(() => readAnnotations('invalid'));
});

test('DO-R1/R4: JSON rows and model schema contain no samples or credentials', () => {
  assert.deepEqual(jsonDataRows({ id: 1 }), [{ id: 1 }]);
  for (const input of [null, 1, [], ['bad'], [null]]) assert.throws(() => jsonDataRows(input));
  const schema = modelReadableSchema({
    id: 'one', name: 'orders', fileType: 'API', annotations: readAnnotations(),
    tables: [{ id: 't', name: 'orders', sheetName: 'orders', rowCount: 1, columns: [{ id: 'c', name: 'phone', type: '文本', nullable: true, sample: 'private', sensitive: true }] }],
    api: { method: 'GET', baseUrl: 'https://user:secret@example.com', path: '/orders?key=secret', itemsPath: 'data', description: '订单' },
  });
  const serialized = JSON.stringify(schema);
  assert.ok(!serialized.includes('secret') && !serialized.includes('private') && !serialized.includes('schemaVersion'));
  assert.deepEqual(schema.operations, ['query', 'options']);
});

test('DO-R1–R5: old storage migration, save/read, ownership, app context and API sync', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-data-objects-'));
  const previousDir = process.env.OPENCLAWX_DATA_DIR;
  process.env.OPENCLAWX_DATA_DIR = temp;
  const require = createRequire(import.meta.url);
  const sqlRoot = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
  const SQL = await require(path.join(sqlRoot, 'sql-wasm.js'))({ wasmBinary: fs.readFileSync(path.join(sqlRoot, 'sql-wasm.wasm')) });
  // Start with the actual pre-refactor schema, not an empty upgraded database.
  const old = new SQL.Database();
  old.run('CREATE TABLE data_sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, asset_id TEXT NOT NULL, file_type TEXT NOT NULL, table_count INTEGER NOT NULL, row_count INTEGER NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL, org_id TEXT NOT NULL, owner_user_id TEXT NOT NULL)');
  old.run('CREATE TABLE data_tables (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, name TEXT NOT NULL, sheet_name TEXT NOT NULL, physical_name TEXT NOT NULL, row_count INTEGER NOT NULL, columns_json TEXT NOT NULL)');
  old.run('CREATE TABLE legacy_rows (c_1 TEXT)');
  old.run('INSERT INTO legacy_rows VALUES (?)', ['preserved']);
  old.run('INSERT INTO data_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['legacy', 'old.csv', '', 'CSV', 1, 1, 'old source', 1, 'org', 'user']);
  old.run('INSERT INTO data_tables VALUES (?, ?, ?, ?, ?, ?, ?)', ['legacy-table', 'legacy', 'old table', 'Sheet1', 'legacy_rows', 1, JSON.stringify([{ id: 'c_1', name: 'old column', type: '文本', nullable: false, sample: 'preserved', description: 'existing annotation' }])]);
  fs.mkdirSync(path.join(temp, 'data-workbench'));
  fs.writeFileSync(path.join(temp, 'data-workbench/data.sqlite'), old.export()); old.close();
  const app = Fastify();
  app.addHook('preHandler', async request => {
    request.auth = { userId: String(request.headers['x-test-user'] || 'user'), orgId: String(request.headers['x-test-org'] || 'org'), username: 'test', displayName: 'test', role: request.headers['x-test-admin'] ? 'admin' : 'member', sessionId: 'test' };
  });
  let remoteFail = false;
  await app.register(dataRoutes, { remoteFactory: async () => ({
    async query(sql) {
      if (remoteFail) throw new Error('private-password upstream failure');
      if (sql.includes('SCHEMATA') || sql.includes('pg_database')) return [{ name: 'business' }];
      if (sql.includes('TABLE_TYPE') || sql.includes('obj_description')) return [{ schema_name: 'business', table_name: 'orders', description: '订单业务表' }];
      if (sql.includes('COLUMNS') || sql.includes('col_description')) return [{ name: 'id', data_type: 'int', nullable: 'NO', description: '订单号' }];
      return sql.startsWith('SELECT ') ? [{ id: 42 }] : [];
    }, async close() {}, destroy() {},
  }) });
  let items = [{ id: 1, amount: 8 }];
  const remote = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(items)); });
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
  const address = remote.address();
  assert.ok(address && typeof address === 'object');
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: Record<string, unknown>, headers?: Record<string, string>) => app.inject({ method, url, payload, headers });
  try {
    const legacy = (await call('GET', '/data/sources/legacy')).json();
    assert.equal(legacy.tables[0].id, 'legacy-table');
    assert.equal(legacy.tables[0].columns[0].description, 'existing annotation');
    assert.equal(legacy.annotations.description, '');
    assert.equal((await call('GET', '/data/sources/legacy/tables/legacy-table/rows')).json().rows[0][0], 'preserved');
    const imported = await call('POST', '/data/import', { name: 'orders.json', contentBase64: Buffer.from(JSON.stringify([{ id: 1, amount: 8, metadata: { channel: 'web' } }])).toString('base64') });
    assert.equal(imported.statusCode, 200, imported.body);
    const source = imported.json(), table = source.tables[0];
    assert.equal(source.fileType, 'JSON');
    assert.equal(source.annotations.description, '');
    const annotations = { description: 'paid orders', connectionDescription: 'updated daily' };
    assert.equal((await call('PATCH', `/data/sources/${source.id}/annotations`, annotations)).statusCode, 200);
    assert.equal((await call('PATCH', `/data/sources/${source.id}/annotations`, annotations, { 'x-test-user': 'other' })).statusCode, 404);
    assert.equal((await call('GET', `/data/gateway/schema?sourceId=${source.id}`, undefined, { 'x-test-org': 'other' })).statusCode, 404);
    table.description = 'order detail'; table.columns[1].description = 'paid amount'; table.columns[1].unit = '元';
    assert.equal((await call('PATCH', `/data/sources/${source.id}/tables/${table.id}/schema`, table)).statusCode, 200);
    const schema = (await call('GET', `/data/gateway/schema?sourceId=${source.id}`)).json();
    assert.equal(schema.annotations.description, 'paid orders'); assert.equal(schema.resources[0].description, 'order detail');
    assert.equal(schema.resources[0].columns[1].unit, '元');
    const rows = (await call('GET', `/data/sources/${source.id}/tables/${table.id}/rows`)).json();
    assert.equal(rows.rows[0][2], '{"channel":"web"}');
    const customized = await call('POST', '/data/apps/customize', { sourceId: source.id, tableId: table.id, idea: 'order dashboard' });
    assert.equal(customized.statusCode, 200, customized.body);
    assert.ok(customized.json().prompt.includes('paid orders') && customized.json().prompt.includes('order detail'));
    const invalidLimit = await call('GET', `/data/gateway/query?sourceId=${source.id}&tableId=${table.id}&limit=NaN`);
    assert.equal(invalidLimit.statusCode, 400);
    assert.equal((await call('GET', `/data/gateway/query?sourceId=${source.id}&tableId=${table.id}&fields=c_1,not-a-field`)).statusCode, 400);
    assert.equal((await call('POST', '/data/import', { name: 'bad.json', contentBase64: Buffer.from('bad').toString('base64') })).statusCode, 400);
    const api = await call('POST', '/data/sources/api', { name: 'remote', baseUrl: `http://127.0.0.1:${address.port}`, path: '/', authType: 'bearer', authToken: 'secret-key', syncNow: true });
    assert.ok(api.statusCode < 300, api.body);
    const apiSource = api.json(), apiTable = apiSource.tables[0];
    apiTable.name = '订单'; apiTable.description = 'remote order table';
    apiTable.columns[1].name = '金额'; apiTable.columns[1].description = 'paid amount'; apiTable.columns[1].sensitive = true;
    assert.equal((await call('PATCH', `/data/sources/${apiSource.id}/tables/${apiTable.id}/schema`, apiTable)).statusCode, 200);
    const apiApp = (await call('POST', '/data/apps/customize', { sourceId: apiSource.id, tableId: apiTable.id, idea: 'show orders' })).json();
    assert.ok(!apiApp.prompt.includes('secret-key'));
    assert.ok(apiApp.prompt.includes('[敏感字段已隐藏]'));
    items = [{ amount: 9, id: 2 }]; // order changes, identity must follow source field.
    const synced = await call('POST', `/data/sources/${apiSource.id}/sync`);
    assert.equal(synced.statusCode, 200, synced.body);
    const after = synced.json().tables[0];
    assert.equal(after.id, apiTable.id); assert.equal(after.name, '订单'); assert.equal(after.description, 'remote order table');
    const amount = after.columns.find((column: { sourceName: string }) => column.sourceName === 'amount');
    assert.equal(amount.description, 'paid amount'); assert.equal(amount.id, apiTable.columns[1].id);
    assert.equal((await call('GET', `/data/apps/${apiApp.app.id}`)).statusCode, 200);
    const reread = (await call('GET', `/data/sources/${source.id}`)).json();
    assert.equal(reread.annotations.description, 'paid orders');
    const connection = { engine: 'mysql', host: 'localhost', user: 'reader', password: 'private-password', database: 'business', tls: false };
    const input = { connection, name: '业务数据库', tables: [{ schema: 'business', name: 'orders' }] };
    assert.equal((await call('POST', '/data/databases/inspect', connection)).statusCode, 403);
    assert.equal((await call('POST', '/data/sources/database', input)).statusCode, 403);
    assert.equal((await call('POST', '/data/databases/inspect', connection, { 'x-test-admin': '1' })).json().tables[0].name, 'orders');
    const dbResponse = await call('POST', '/data/sources/database', input, { 'x-test-admin': '1' });
    assert.equal(dbResponse.statusCode, 201, dbResponse.body);
    assert.ok(!dbResponse.body.includes('private-password'));
    const dbSource = dbResponse.json(), dbTable = dbSource.tables[0];
    assert.equal(dbTable.description, '订单业务表'); assert.equal(dbTable.columns[0].description, '订单号');
    dbTable.columns[0].description = '手工订单标注';
    await call('PATCH', `/data/sources/${dbSource.id}/tables/${dbTable.id}/schema`, dbTable);
    const refreshUrl = `/data/sources/${dbSource.id}/database-refresh`;
    assert.equal((await call('POST', refreshUrl, { password: 'private-password' }, { 'x-test-user': 'other' })).statusCode, 404);
    const refreshed = await call('POST', refreshUrl, { password: 'private-password', host: 'unapproved-target' });
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    assert.equal(refreshed.json().databaseConnection.host, 'localhost');
    assert.equal(refreshed.json().tables[0].id, dbTable.id);
    assert.equal(refreshed.json().tables[0].columns[0].description, '手工订单标注');
    remoteFail = true;
    const failedRefresh = await call('POST', refreshUrl, { password: 'private-password' });
    assert.equal(failedRefresh.statusCode, 502); assert.ok(!failedRefresh.body.includes('private-password'));
    assert.equal((await call('GET', `/data/sources/${dbSource.id}/tables/${dbTable.id}/rows`)).json().rows[0][0], '42');
    const disk = new SQL.Database(fs.readFileSync(path.join(temp, 'data-workbench/data.sqlite')));
    assert.ok(!String(disk.exec('SELECT metadata_json FROM data_database_connections')[0].values[0][0]).includes('private-password'));
    assert.equal(JSON.parse(disk.exec('SELECT annotations_json FROM data_sources WHERE id = ?', [source.id])[0].values[0][0]).description, 'paid orders'); disk.close();
  } finally {
    await app.close(); await new Promise<void>(resolve => remote.close(() => resolve()));
    if (previousDir === undefined) delete process.env.OPENCLAWX_DATA_DIR; else process.env.OPENCLAWX_DATA_DIR = previousDir;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
