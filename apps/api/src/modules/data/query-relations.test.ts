import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Fastify from 'fastify';
import { structuredDataQuerySchema, dataObjectAnnotationsSchema, remoteDatabaseConnectionSchema, type StructuredDataQuery, type DataRelation } from '@openclawx/contracts';
import { resolveQueryRelations, validateRelations } from './query-relations.js';
import { compileStructuredQuery, executeLocalStructuredQuery, type QueryTable } from './structured-query.js';
import { queryLiveStructured, type LiveTable } from './live-database.js';
import { dataRoutes } from './routes.js';

const query = (patch: object = {}) => structuredDataQuerySchema.parse({ sourceId: 's', tableId: 'orders', ...patch }) as StructuredDataQuery;
const column = (id: string, type: '文本' | '小数' = '文本') => ({ id, name: id, nativeName: id, type });
const tables = new Map<string, QueryTable>([
  ['orders', { name: 'orders', stableOrder: ['rowid'], columns: [column('customer'), column('amount', '小数'), column('status')] }],
  ['customers', { name: 'customers', columns: [column('id'), column('region')] }],
  ['regions', { name: 'regions', columns: [column('id'), column('label')] }],
]);
const relations: DataRelation[] = [
  { id: 'customer', name: '订单客户', fromTableId: 'orders', toTableId: 'customers', keys: [{ fromFieldId: 'customer', toFieldId: 'id' }] },
  { id: 'region', name: '客户区域', fromTableId: 'customers', toTableId: 'regions', keys: [{ fromFieldId: 'region', toFieldId: 'id' }] },
];
async function database() {
  const require = createRequire(import.meta.url), root = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
  const SQL = await require(path.join(root, 'sql-wasm.js'))({ wasmBinary: fs.readFileSync(path.join(root, 'sql-wasm.wasm')) });
  return new SQL.Database();
}

test('SDQ2-R1/R2/R3: bounded strict contract and trusted relation planning', () => {
  assert.deepEqual(dataObjectAnnotationsSchema.parse({}).relations, []);
  for (const patch of [{ joins: [{ relationId: 'customer', on: '1=1' }] }, { joins: [{ relationId: 'customer', type: 'cross' }] }, { joins: Array(4).fill({ relationId: 'customer' }) }, { metrics: [{ operation: 'count', alias: 'n', sql: '1' }] }]) assert.equal(structuredDataQuerySchema.safeParse({ sourceId: 's', tableId: 'orders', ...patch }).success, false);
  const condition = { logic: 'and', conditions: Array(30).fill({ fieldId: 'status', operator: 'eq', value: 'paid' }) };
  assert.throws(() => query({ metrics: [{ operation: 'count', alias: 'a', filters: condition }, { operation: 'count', alias: 'b', filters: condition }] }));
  for (const joins of [[{ relationId: 'missing' }], [{ relationId: 'region' }], [{ relationId: 'customer' }, { relationId: 'customer' }]]) assert.throws(() => resolveQueryRelations(query({ joins }), relations, tables));
  assert.throws(() => validateRelations([{ ...relations[0], toTableId: 'foreign' }], [...tables].map(([id, t]) => ({ id, columns: t.columns }))));
  assert.throws(() => compileStructuredQuery(query({ joins: [{ relationId: 'customer' }] }), tables.get('orders')!, 'sqlite'));
});

test('SDQ2-R1/R3/R4: actual SQLite chained joins, LEFT/INNER, conditional metrics, HAVING, Top N and duplicate refusal', async () => {
  const db = await database();
  try {
    db.run('CREATE TABLE orders(customer TEXT,amount TEXT,status TEXT); CREATE TABLE customers(id TEXT,region TEXT); CREATE TABLE regions(id TEXT,label TEXT)');
    for (const row of [['a', '10', 'paid'], ['a', '20', 'unpaid'], ['b', '30', 'paid'], ['missing', '40', 'unpaid'], [null, '50', null]]) db.run('INSERT INTO orders VALUES (?,?,?)', row);
    db.run("INSERT INTO customers VALUES ('a','east'),('b','west'); INSERT INTO regions VALUES ('east','华东'),('west','华西')");
    const run = (patch: object) => { const q = query(patch); return executeLocalStructuredQuery(db, q, resolveQueryRelations(q, relations, tables), 'local'); };
    const paid = { fieldId: 'status', operator: 'eq', value: 'paid' };
    const metrics = [{ fieldId: 'amount', operation: 'sum', alias: 'paid', filters: paid }, { fieldId: 'amount', operation: 'avg', alias: 'mean', filters: paid }, { operation: 'count', alias: 'n', filters: paid }, { fieldId: 'customer', operation: 'countDistinct', alias: 'clients', filters: paid }];
    assert.deepEqual(run({ metrics, having: [{ fieldId: 'paid', operator: 'gt', value: 20 }], orderBy: [{ fieldId: 'paid', direction: 'desc' }] }).rows, [{ paid: 40, mean: 20, n: 2, clients: 2 }]);
    const joins = [{ relationId: 'customer', type: 'left' }, { relationId: 'region', type: 'left' }];
    assert.deepEqual(run({ joins, metrics: [{ fieldId: 'amount', operation: 'sum', alias: 'total' }, { operation: 'count', alias: 'n' }] }).rows, [{ total: 150, n: 5 }]);
    assert.deepEqual(run({ joins: joins.map(j => ({ ...j, type: 'inner' })), metrics: [{ fieldId: 'amount', operation: 'sum', alias: 'total' }] }).rows, [{ total: 60 }]);
    assert.deepEqual(run({ joins, dimensions: [{ fieldId: 'regions::label' }], metrics: [{ fieldId: 'amount', operation: 'sum', alias: 'total' }], orderBy: [{ fieldId: 'total', direction: 'desc' }], limit: 1 }).rows, [{ 'regions::label': null, total: 90 }]);
    assert.deepEqual(run({ joins, metrics: [{ operation: 'count', alias: 'east', filters: { fieldId: 'regions::label', operator: 'eq', value: '华东' } }] }).rows, [{ east: 2 }]);
    assert.equal(run({ joins, fields: ['customer', 'customers::id', 'regions::label'] }).rows.length, 5);
    assert.deepEqual(run({ metrics: [{ operation: 'count', alias: 'n', filters: { fieldId: 'status', operator: 'eq', value: 'absent' } }, { fieldId: 'amount', operation: 'sum', alias: 'total', filters: { fieldId: 'status', operator: 'eq', value: 'absent' } }] }).rows, [{ n: 0, total: null }]);
    db.run("INSERT INTO customers VALUES ('a','other')");
    assert.throws(() => run({ joins, metrics }), (e: any) => e.code === 'JOIN_CARDINALITY_VIOLATION');
  } finally { db.close(); }
});

test('SDQ2-R4: composite target keys are checked as a whole, NULL keys do not match', async () => {
  const db = await database();
  try {
    db.run("CREATE TABLE a(x TEXT,y TEXT); CREATE TABLE b(x TEXT,y TEXT); INSERT INTO a VALUES ('1','2'),(NULL,'2'); INSERT INTO b VALUES ('1','2'),('1','3'),(NULL,'2'),(NULL,'2')");
    const ts = new Map(['a', 'b'].map(id => [id, { name: id, columns: [column('x'), column('y')] }]));
    const r = [{ id: 'ab', name: 'ab', fromTableId: 'a', toTableId: 'b', keys: [{ fromFieldId: 'x', toFieldId: 'x' }, { fromFieldId: 'y', toFieldId: 'y' }] }];
    const q = query({ tableId: 'a', joins: [{ relationId: 'ab' }], metrics: [{ operation: 'count', alias: 'n' }] });
    const t = resolveQueryRelations(q, r, ts);
    assert.deepEqual(executeLocalStructuredQuery(db, q, t, 'local').rows, [{ n: 2 }]);
    db.run("INSERT INTO b VALUES ('1','2')");
    assert.throws(() => executeLocalStructuredQuery(db, q, t, 'local'), (e: any) => e.code === 'JOIN_CARDINALITY_VIOLATION');
  } finally { db.close(); }
});

test('SDQ2-R4: native type coercion cannot multiply a numerically equal join key', async () => {
  const db = await database();
  try {
    db.run("CREATE TABLE a(x INTEGER); CREATE TABLE b(x TEXT); INSERT INTO a VALUES(1); INSERT INTO b VALUES('01'),('1')");
    const ts = new Map(['a', 'b'].map(id => [id, { name: id, columns: [column('x')] }]));
    const r = [{ id: 'ab', name: 'ab', fromTableId: 'a', toTableId: 'b', keys: [{ fromFieldId: 'x', toFieldId: 'x' }] }];
    const q = query({ tableId: 'a', joins: [{ relationId: 'ab' }], metrics: [{ operation: 'count', alias: 'n' }] });
    assert.throws(() => executeLocalStructuredQuery(db, q, resolveQueryRelations(q, r, ts), 'local'), (e: any) => e.code === 'JOIN_CARDINALITY_VIOLATION');
  } finally { db.close(); }
});

for (const engine of ['mysql', 'postgresql'] as const) test(`SDQ2-R1/R3/R4: ${engine} parameter order, repeatable read, cardinality and rollback`, async () => {
  const c = remoteDatabaseConnectionSchema.parse({ engine, host: 'localhost', user: 'test', database: 'db' });
  const q = query({ joins: [{ relationId: 'customer' }], metrics: [{ fieldId: 'amount', operation: 'sum', alias: 'paid', filters: { fieldId: 'status', operator: 'eq', value: "paid' OR 1=1" } }], filters: { fieldId: 'customer', operator: 'eq', value: 'a' }, having: [{ fieldId: 'paid', operator: 'gt', value: 5 }], orderBy: [{ fieldId: 'paid', direction: 'desc' }] });
  const t = resolveQueryRelations(q, relations, tables), compiled = compileStructuredQuery(q, t, engine);
  assert.deepEqual(compiled.params, ["paid' OR 1=1", 'a', 5]); assert.ok(!compiled.sql.includes("paid' OR"));
  if (engine === 'mysql') assert.equal((compiled.sql.match(/\?/g) || []).length, 3);
  else assert.ok(compiled.sql.includes('$3'));
  const calls: string[] = []; let duplicate = false;
  const factory = async () => ({ async query(sql: string) { calls.push(sql); return sql.startsWith('SELECT 1') ? duplicate ? [{ x: 1 }] : [] : sql.startsWith('SELECT') ? [{ paid: '10.00' }] : []; }, async close() {}, destroy() {} });
  const native: LiveTable = { name: 'orders', schema: 'db', columns: [] };
  assert.deepEqual((await queryLiveStructured(c, native, [], q, factory, t)).rows, [{ paid: '10.00' }]);
  assert.ok(calls.some(sql => sql.includes('REPEATABLE READ'))); assert.equal(calls.at(-1), 'ROLLBACK');
  duplicate = true; await assert.rejects(queryLiveStructured(c, native, [], q, factory, t), (e: any) => e.code === 'JOIN_CARDINALITY_VIOLATION'); assert.equal(calls.at(-1), 'ROLLBACK');
});

test('SDQ2-R2/R3/R5: authenticated relation registration, persistence and joined HTTP query', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-join-')), previous = process.env.OPENCLAWX_DATA_DIR;
  process.env.OPENCLAWX_DATA_DIR = dir;
  const app = Fastify();
  app.addHook('preHandler', async r => { r.auth = { userId: String(r.headers['x-user'] || 'u'), orgId: String(r.headers['x-org'] || 'o'), username: 'test', displayName: 'test', role: 'admin', sessionId: 'test' }; });
  const remoteCalls: string[] = [];
  await app.register(dataRoutes, { remoteFactory: async () => ({ async query(sql, values = []) {
    remoteCalls.push(sql);
    if (sql.includes('SCHEMATA')) return [{ name: 'business' }];
    if (sql.includes('TABLE_TYPE')) return ['orders', 'customers'].map(name => ({ schema_name: 'business', table_name: name, table_engine: 'InnoDB' }));
    if (sql.includes('COLUMNS')) return [{ name: 'customer', data_type: 'varchar', nullable: 'YES' }, { name: values[1] === 'orders' ? 'amount' : 'region', data_type: values[1] === 'orders' ? 'decimal' : 'varchar', nullable: 'YES' }];
    if (sql.startsWith('SELECT 1')) return [];
    if (sql.startsWith('SELECT')) return [{ total: '30.00' }];
    return [];
  }, async close() {}, destroy() {} }) });
  try {
    const require = createRequire(import.meta.url), XLSX = require('xlsx'), book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet([{ customer: 'a', amount: 10 }, { customer: 'b', amount: 20 }]), 'orders');
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet([{ customer: 'a', region: '华东' }, { customer: 'b', region: '华西' }]), 'customers');
    const imported = await app.inject({ method: 'POST', url: '/data/import', payload: { name: 'join.xlsx', contentBase64: XLSX.write(book, { type: 'base64', bookType: 'xlsx' }) } });
    assert.equal(imported.statusCode, 200, imported.body);
    const s = imported.json(), [a, b] = s.tables;
    const rel = { id: 'customer', name: '客户关联', fromTableId: a.id, toTableId: b.id, keys: [{ fromFieldId: 'c_1', toFieldId: 'c_1' }] };
    const save = (payload: object, headers?: Record<string, string>) => app.inject({ method: 'PATCH', url: `/data/sources/${s.id}/annotations`, payload, headers });
    assert.equal((await save({ relations: [rel] })).statusCode, 200);
    const legacy = await save({ description: 'legacy' }); assert.equal(legacy.json().annotations.relations.length, 1);
    assert.equal((await save({ relations: [{ ...rel, toTableId: 'foreign' }] })).statusCode, 400);
    const payload = { sourceId: s.id, tableId: a.id, joins: [{ relationId: 'customer' }], dimensions: [{ fieldId: `${b.id}::c_2` }], metrics: [{ fieldId: 'c_2', operation: 'sum', alias: 'total' }] };
    const run = (headers?: Record<string, string>) => app.inject({ method: 'POST', url: '/data/gateway/query', payload, headers });
    const result = await run(); assert.equal(result.statusCode, 200, result.body); assert.deepEqual(result.json().rows.map((r: any) => r.total).sort(), [10, 20]);
    for (const headers of [{ 'x-user': 'other' }, { 'x-org': 'other' }] as Record<string, string>[]) {
      assert.equal((await run(headers)).statusCode, 404); assert.equal((await save({ relations: [rel] }, headers)).statusCode, 404);
    }
    const saved = await app.inject({ method: 'POST', url: '/data/connections', payload: { name: 'synthetic', connection: { engine: 'mysql', host: 'localhost', user: 'reader', password: 'synthetic', database: 'business' } } });
    assert.equal(saved.statusCode, 201, saved.body);
    const live = await app.inject({ method: 'POST', url: '/data/sources/live', payload: { connectionId: saved.json().id, database: 'business', name: 'live', tables: [{ schema: 'business', name: 'orders' }, { schema: 'business', name: 'customers' }] } });
    assert.equal(live.statusCode, 201, live.body);
    const ls = live.json(), [la, lb] = ls.tables;
    assert.equal((await app.inject({ method: 'PATCH', url: `/data/sources/${ls.id}/annotations`, payload: { relations: [{ ...rel, fromTableId: la.id, toTableId: lb.id }] } })).statusCode, 200);
    const joined = await app.inject({ method: 'POST', url: '/data/gateway/query', payload: { sourceId: ls.id, tableId: la.id, joins: [{ relationId: 'customer' }], metrics: [{ fieldId: 'c_2', operation: 'sum', alias: 'total' }] } });
    assert.equal(joined.statusCode, 200, joined.body); assert.deepEqual(joined.json().rows, [{ total: '30.00' }]);
    assert.ok(remoteCalls.some(sql => sql.includes('LEFT JOIN `business`.`customers`')));
  } finally { await app.close(); if (previous === undefined) delete process.env.OPENCLAWX_DATA_DIR; else process.env.OPENCLAWX_DATA_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); }
});
