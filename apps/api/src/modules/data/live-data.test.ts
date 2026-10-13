import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { remoteDatabaseConnectionSchema, liveDataAccessSchema, liveDataObjectCreateSchema } from '@workmate/contracts';
import { dataRoutes } from './routes.js';
import { discoverLiveTables, queryLiveTable, mutateLiveTable } from './live-database.js';
import { databaseSecret } from './database-secrets.js';
import type { RemoteFactory } from './remote-database.js';

function fixture(engine: 'mysql' | 'postgresql') {
  let data = [{ id: '9007199254740993', tenant: 'A', amount: '12.34' }];
  const calls: { sql: string; values: unknown[] }[] = [];
  let failCommit = false, failExecute = '';
  const schema = engine === 'mysql' ? 'business' : 'public';
  const factory: RemoteFactory = async () => ({
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql === 'COMMIT' && failCommit) throw new Error('private-secret');
      if (sql.includes('SCHEMATA') || sql.includes('FROM pg_database')) return [{ name: 'business' }];
      if (sql.includes('TABLE_TYPE') || sql.includes('obj_description')) return [{ schema_name: schema, table_name: 'orders', description: '订单', table_engine: 'InnoDB' }, { schema_name: schema, table_name: 'logs', table_engine: 'MyISAM' }];
      if (sql.includes('COLUMNS') || sql.includes('col_description')) return [
        { name: 'id', data_type: 'bigint', nullable: 'NO', key_type: values[1] === 'logs' ? '' : 'PRI', is_primary: values[1] !== 'logs' },
        { name: 'tenant', data_type: 'text', nullable: 'NO', key_type: values[1] === 'logs' ? '' : 'PRI', is_primary: values[1] !== 'logs' },
        { name: 'amount', data_type: 'decimal', nullable: 'YES', description: '金额' },
      ];
      if (sql.endsWith('FOR UPDATE')) return data.filter(r => r.id === values[0] && r.tenant === values[1]).map(r => ({ ...r }));
      if (sql.startsWith('SELECT ')) return data.map(r => ({ ...r }));
      return [];
    },
    async execute(sql, values = []) {
      calls.push({ sql, values });
      if (failExecute) throw Object.assign(new Error('private-secret'), { code: failExecute });
      if (sql.startsWith('UPDATE')) data[0].amount = String(engine === 'mysql' ? values[0] : values.at(-1));
      if (sql.startsWith('DELETE')) data = data.filter(r => r.id !== values[0] || r.tenant !== values[1]);
      if (sql.startsWith('INSERT')) data.push({ id: String(values[0]), tenant: String(values[1]), amount: String(values[2]) });
      return 1;
    }, async close() {}, destroy() {},
  });
  return { factory, schema, calls, set amount(v: string) { data[0].amount = v; }, set failCommit(v: boolean) { failCommit = v; }, set failExecute(v: string) { failExecute = v; } };
}
test('LDO-R1/R2/R5: unconfirmed writes and duplicate selections rejected', () => {
  assert.equal(liveDataAccessSchema.safeParse({ writeEnabled: true }).success, false);
  assert.equal(liveDataAccessSchema.safeParse({ writeEnabled: false }).success, true);
  assert.equal(liveDataObjectCreateSchema.safeParse({ connectionId: '6c1a3985-2817-403f-b3ce-a6b2c72f0b14', database: 'db', name: 'obj', tables: [{ schema: 'db', name: 'a' }, { schema: 'db', name: 'a' }] }).success, false);
});
for (const engine of ['mysql', 'postgresql'] as const) test(`LDO-R2/R4/R5/R7: ${engine} metadata, bindings, composite PK, conflict, uncertain commit`, async context => {
  const f = fixture(engine), c = remoteDatabaseConnectionSchema.parse({ engine, host: 'localhost', user: 'test', database: 'business' });
  const discovered = await discoverLiveTables(c, [{ schema: f.schema, name: 'orders' }], f.factory);
  assert.deepEqual(discovered[0].rows, []);
  assert.ok(!f.calls.some(v => v.sql.includes(' FROM `business`.`orders`') || v.sql.includes(' FROM "public"."orders"')));
  const t = discovered[0].binding;
  assert.equal(t.columns.filter(c => c.primary).length, 2);
  const injection = "x%' OR 1=1 --";
  const result = await queryLiveTable(c, t, 'scope', { search: injection, limit: 1 }, f.factory);
  const sql = f.calls.find(v => v.sql.includes('LIMIT 2'))!;
  assert.ok(!sql.sql.includes(injection)); assert.ok(String(sql.values[0]).includes("x!%'"));
  assert.equal(result.rows[0].values.c_1, '9007199254740993');
  assert.ok(f.calls.some(v => v.sql.endsWith('READ ONLY')));
  await assert.rejects(mutateLiveTable(c, t, 'other', 'update', { c_3: '99' }, result.rows[0].id, f.factory), /失效/);
  await assert.rejects(mutateLiveTable(c, t, 'scope', 'update', { c_1: '2' }, result.rows[0].id, f.factory), /主键/);
  await assert.rejects(mutateLiveTable(c, t, 'scope', 'insert', { c_3: '2' }, '', f.factory), /必填/);
  f.amount = 'changed';
  await assert.rejects(mutateLiveTable(c, t, 'scope', 'update', { c_3: '99' }, result.rows[0].id, f.factory), /已被修改/);
  assert.ok(!f.calls.some(v => v.sql.startsWith('UPDATE')));
  const latest = (await queryLiveTable(c, t, 'scope', {}, f.factory)).rows[0];
  await mutateLiveTable(c, t, 'scope', 'update', { c_3: '99' }, latest.id, f.factory);
  const update = f.calls.find(v => v.sql.startsWith('UPDATE'))!;
  assert.deepEqual(update.values, engine === 'mysql' ? ['99', '9007199254740993', 'A'] : ['9007199254740993', 'A', '99']);
  assert.ok(update.sql.includes('AND')); assert.equal(f.calls.at(-1)?.sql, 'COMMIT');
  await mutateLiveTable(c, t, 'scope', 'insert', { c_1: 'new', c_2: 'A', c_3: '5' }, '', f.factory);
  const afterInsert = await queryLiveTable(c, t, 'scope', {}, f.factory);
  assert.equal(afterInsert.rows.length, 2);
  const newRow = afterInsert.rows.find(r => r.values.c_1 === 'new')!;
  await mutateLiveTable(c, t, 'scope', 'delete', {}, newRow.id, f.factory);
  assert.equal((await queryLiveTable(c, t, 'scope', {}, f.factory)).rows.length, 1);
  const live = (await queryLiveTable(c, t, 'scope', {}, f.factory)).rows[0];
  const now = Date.now(); const time = context.mock.method(Date, 'now', () => now + 16 * 60_000);
  await assert.rejects(mutateLiveTable(c, t, 'scope', 'delete', {}, live.id, f.factory), /失效/);
  time.mock.restore();
  await assert.rejects(mutateLiveTable(c, t, 'scope', 'delete', {}, live.id + 'tampered', f.factory), /失效/);
  f.failCommit = true;
  await assert.rejects(mutateLiveTable(c, t, 'scope', 'delete', {}, live.id, f.factory), /可能已生效/);
  f.failCommit = false; f.failExecute = '23505';
  await assert.rejects(mutateLiveTable(c, t, 'scope', 'insert', { c_1: '2', c_2: 'A' }, '', f.factory), /重复/);
  await assert.rejects(mutateLiveTable(c, { ...t, columns: t.columns.map(c => ({ ...c, primary: false })) }, 'scope', 'insert', { c_1: '2' }, '', f.factory), /主键/);
});
test('LDO-R1–R7: owner API, explicit writes, annotation binding, snapshots and no credential persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-live-data-'));
  const previous = process.env.WORKMATE_DATA_DIR; process.env.WORKMATE_DATA_DIR = dir;
  const f = fixture('mysql'), app = Fastify();
  app.addHook('preHandler', async r => { r.auth = { userId: String(r.headers['x-test-user'] || 'user'), orgId: String(r.headers['x-test-org'] || 'org'), username: 'test', displayName: 'test', role: r.headers['x-member'] ? 'member' : 'admin', sessionId: 'test' }; });
  await app.register(dataRoutes, { remoteFactory: f.factory });
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, headers?: Record<string, string>) => app.inject({ method, url, payload, headers });
  try {
    const connection = { engine: 'mysql', host: 'localhost', user: 'reader', database: 'business', password: 'secret-password', tls: false };
    assert.equal((await call('POST', '/data/connections', { name: 'db', connection }, { 'x-member': '1' })).statusCode, 403);
    const saved = await call('POST', '/data/connections', { name: 'db', connection });
    assert.equal(saved.statusCode, 201, saved.body); assert.ok(!saved.body.includes('secret-password'));
    const connectionId = saved.json().id;
    assert.equal((await call('POST', `/data/connections/${connectionId}/credential`, { password: 'new-synthetic-password' }, { 'x-test-user': 'other' })).statusCode, 404);
    assert.equal((await call('POST', `/data/connections/${connectionId}/credential`, { password: 'new-synthetic-password' }, { 'x-member': '1' })).statusCode, 403);
    const repaired = await call('POST', `/data/connections/${connectionId}/credential`, { password: 'new-synthetic-password' });
    assert.equal(repaired.statusCode, 200, repaired.body);
    assert.equal(await databaseSecret(connectionId), 'new-synthetic-password');
    assert.ok(!repaired.body.includes('new-synthetic-password'));
    assert.equal((await call('GET', `/data/connections/${connectionId}/inspect`)).statusCode, 200);
    const connections = (await call('GET', '/data/connections')).json().connections;
    assert.equal(connections.length, 1); assert.equal(connections[0].id, connectionId);
    assert.equal((await call('GET', '/data/connections', undefined, { 'x-test-org': 'other' })).json().connections.length, 0);
    assert.equal((await call('GET', `/data/connections/${connectionId}/inspect`, undefined, { 'x-test-user': 'other' })).statusCode, 404);
    const made = await call('POST', '/data/sources/live', { connectionId, database: 'business', name: '实时经营数据', tables: [{ schema: 'business', name: 'orders' }, { schema: 'business', name: 'logs' }] });
    assert.equal(made.statusCode, 201, made.body);
    const source = made.json(), table = source.tables[0], sourceId = source.id, tableId = table.id;
    assert.equal(source.liveConnection.writeEnabled, false); assert.equal(source.accessMode, 'live'); assert.equal(source.rowCount, 0);
    assert.equal(source.liveConnection.tables[1].writable, false);
    const q = `/data/gateway/records?sourceId=${sourceId}&tableId=${tableId}`;
    assert.equal((await call('GET', q + '&limit=NaN')).statusCode, 400);
    assert.equal((await call('GET', '/data/gateway/records')).statusCode, 400);
    let record = (await call('GET', q)).json().rows[0];
    const mutation = { sourceId, tableId, fields: { c_3: '20' }, recordId: record.id };
    assert.equal((await call('PATCH', '/data/gateway/records', mutation)).statusCode, 403);
    assert.equal((await call('PATCH', `/data/sources/${sourceId}/access`, { writeEnabled: true })).statusCode, 400);
    assert.equal((await call('PATCH', `/data/sources/${sourceId}/access`, { writeEnabled: true, confirm: true }, { 'x-test-user': 'other' })).statusCode, 404);
    assert.equal((await call('PATCH', `/data/sources/${sourceId}/access`, { writeEnabled: true, confirm: true })).statusCode, 200);
    assert.equal((await call('PATCH', '/data/gateway/records', mutation, { 'x-member': '1' })).statusCode, 403);
    assert.equal((await call('PATCH', '/data/gateway/records', mutation)).statusCode, 200);
    record = (await call('GET', q)).json().rows[0]; assert.equal(record.values.c_3, '20');
    const schema = { ...table, columns: table.columns.map((c: object) => ({ ...c, name: '展示名', description: '业务说明', sourceName: 'attacker' })) };
    assert.equal((await call('PATCH', `/data/sources/${sourceId}/tables/${tableId}/schema`, schema)).statusCode, 200);
    const data = await call('GET', `/data/gateway/query?sourceId=${sourceId}&tableId=${tableId}&fields=c_3&limit=20`);
    assert.equal(data.json().rows[0].c_3, '20'); assert.ok(!f.calls.at(-2)?.sql.includes('attacker'));
    assert.equal((await call('GET', q, undefined, { 'x-test-org': 'other' })).statusCode, 404);
    const model = (await call('GET', `/data/gateway/schema?sourceId=${sourceId}`)).json();
    assert.equal(model.storageMode, 'live'); assert.ok(!JSON.stringify(model).includes('reader'));
    for (const route of ['/data/apps', '/data/apps/customize', '/data/apps/project-create']) assert.equal((await call('POST', route, { sourceId, tableId, idea: 'test', employeeId: 'assistant', requestId: '6c1a3985-2817-403f-b3ce-a6b2c72f0b14' })).statusCode, 409, route);
    const old = await call('POST', '/data/sources/database', { name: 'copy', connection, tables: [{ schema: 'business', name: 'orders' }] });
    assert.equal(old.statusCode, 201, old.body); assert.equal(old.json().accessMode, 'snapshot'); assert.equal(old.json().rowCount, 1);
    const options = await call('GET', `/data/gateway/options?sourceId=${sourceId}&tableId=${tableId}&labelField=c_2&valueField=c_1`);
    assert.equal(options.json().items[0].value, '9007199254740993');
    assert.equal((await call('PATCH', `/data/sources/${sourceId}/access`, { writeEnabled: false })).statusCode, 200);
    assert.equal((await call('DELETE', '/data/gateway/records', { sourceId, tableId, recordId: record.id })).statusCode, 403);
    const before = f.calls.length;
    assert.equal((await call('DELETE', `/data/sources/${sourceId}`)).statusCode, 200);
    assert.equal(f.calls.length, before);
    assert.ok(!fs.readFileSync(path.join(dir, 'data-workbench/data.sqlite')).includes(Buffer.from('secret-password')));
    assert.ok(!fs.readFileSync(path.join(dir, 'data-workbench/data.sqlite')).includes(Buffer.from('new-synthetic-password')));
  } finally { await app.close(); if (previous === undefined) delete process.env.WORKMATE_DATA_DIR; else process.env.WORKMATE_DATA_DIR = previous; }
});
