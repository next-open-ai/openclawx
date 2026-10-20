import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Fastify from 'fastify';
import { structuredDataQuerySchema, remoteDatabaseConnectionSchema, type StructuredDataQuery } from '@openclawx/contracts';
import { compileStructuredQuery, executeLocalStructuredQuery, structuredQueryResult, type QueryTable } from './structured-query.js';
import { queryLiveStructured, type LiveTable } from './live-database.js';
import { dataRoutes } from './routes.js';

const table: QueryTable = { name: 'orders', stableOrder: ['rowid'], columns: [
  { id: 'customer', nativeName: 'customer', name: '客户', type: '文本' },
  { id: 'amount', nativeName: 'amount', name: '金额', type: '小数' },
  { id: 'day', nativeName: 'day', name: '日期', type: '日期' },
] };
const query = (patch: object = {}) => structuredDataQuerySchema.parse({ sourceId: 'source', tableId: 'table', ...patch }) as StructuredDataQuery;
async function sqlite() {
  const require = createRequire(import.meta.url), root = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
  const SQL = await require(path.join(root, 'sql-wasm.js'))({ wasmBinary: fs.readFileSync(path.join(root, 'sql-wasm.wasm')) });
  return new SQL.Database();
}

test('SDQ-R1/R3/R5: strict bounded contracts, no SQL/identity, metric aliases and aggregate shape', () => {
  for (const patch of [{ sql: 'SELECT 1' }, { userId: 'admin' }, { limit: 201 }, { offset: -1 }, { offset: 10001 }, { metrics: [{ operation: 'sum', alias: 'total' }] }, { metrics: [{ operation: 'count', alias: 'sdq_private' }] }, { fields: ['customer'], metrics: [{ operation: 'count', alias: 'n' }] }, { filters: { fieldId: 'customer', operator: 'eq', value: null } }, { filters: { fieldId: 'customer', operator: 'in', values: [] } }]) {
    assert.equal(structuredDataQuerySchema.safeParse({ sourceId: 's', tableId: 't', ...patch }).success, false, JSON.stringify(patch));
  }
  let f: object = { fieldId: 'customer', operator: 'eq', value: 'a' };
  for (let i = 0; i < 4; i++) f = { logic: 'and', conditions: [f] };
  assert.equal(structuredDataQuerySchema.safeParse({ sourceId: 's', tableId: 't', filters: f }).success, false);
  const many = { logic: 'or', conditions: Array.from({ length: 2 }, () => ({ logic: 'and', conditions: Array.from({ length: 30 }, () => ({ fieldId: 'amount', operator: 'gt', value: 1 })) })) };
  assert.equal(structuredDataQuerySchema.safeParse({ sourceId: 's', tableId: 't', filters: many }).success, false);
});

test('SDQ-R3/R4/R6: compiler allowlists identifiers, types, aggregates and parameterizes every value', () => {
  const injection = "a%' OR 1=1 --";
  for (const dialect of ['sqlite', 'mysql', 'postgresql'] as const) {
    const compiled = compileStructuredQuery(query({ fields: ['customer'], filters: { fieldId: 'customer', operator: 'contains', value: injection } }), table, dialect);
    assert.ok(!compiled.sql.includes(injection)); assert.deepEqual(compiled.params, ["%a!%' OR 1=1 --%"]);
    assert.ok(compiled.sql.includes(dialect === 'postgresql' ? '$1' : '?'));
  }
  for (const patch of [
    { fields: ['customer;DROP TABLE orders'] },
    { filters: { fieldId: 'missing', operator: 'eq', value: 'x' } },
    { filters: { fieldId: 'amount', operator: 'gt', value: 'bad' } },
    { filters: { fieldId: 'amount', operator: 'contains', value: '1' } },
    { filters: { fieldId: 'day', operator: 'eq', value: '2026-02-30' } },
    { filters: { fieldId: 'day', operator: 'eq', value: 2026 } },
    { metrics: [{ fieldId: 'customer', operation: 'sum', alias: 'sum' }] },
    { dimensions: [{ fieldId: 'customer', grain: 'month' }] },
    { metrics: [{ operation: 'count', alias: 'n' }], having: [{ fieldId: 'amount', operator: 'gt', value: 1 }] },
    { metrics: [{ operation: 'count', alias: 'n' }], orderBy: [{ fieldId: 'amount' }] },
  ]) assert.throws(() => compileStructuredQuery(query(patch), table, 'sqlite'));
  const unusual = { ...table, name: 'orders"name', columns: [{ id: 'customer', name: '客户', type: '文本' as const, nativeName: 'customer"name' }], stableOrder: undefined };
  assert.ok(compileStructuredQuery(query(), unusual, 'sqlite').sql.includes('"orders""name"'));
});

test('SDQ-R3/R4/R5/R6: actual SQLite filtering, numerical comparison, all-row aggregation, dates, HAVING, NULL and paging', async () => {
  const db = await sqlite();
  try {
    db.run('CREATE TABLE orders (customer TEXT, amount TEXT, day TEXT)');
    for (let i = 0; i < 250; i++) db.run('INSERT INTO orders VALUES (?, ?, ?)', [i % 2 ? 'B' : 'A', i % 2 ? '10' : '2', '2026-09-01']);
    db.run('INSERT INTO orders VALUES (?, ?, ?)', ['C', null, null]);
    const run = (patch: object) => executeLocalStructuredQuery(db, query(patch), table, 'local');
    const all = run({ metrics: [{ fieldId: 'amount', operation: 'sum', alias: 'total' }, { operation: 'count', alias: 'n' }, { fieldId: 'amount', operation: 'count', alias: 'withAmount' }, { fieldId: 'customer', operation: 'countDistinct', alias: 'clients' }, { fieldId: 'amount', operation: 'avg', alias: 'mean' }, { fieldId: 'amount', operation: 'min', alias: 'min' }, { fieldId: 'amount', operation: 'max', alias: 'max' }] });
    assert.deepEqual(all.rows, [{ total: 1500, n: 251, withAmount: 250, clients: 3, mean: 6, min: 2, max: 10 }]);
    const grouped = run({ dimensions: [{ fieldId: 'customer' }], metrics: [{ fieldId: 'amount', operation: 'sum', alias: 'total' }], having: [{ fieldId: 'total', operator: 'gt', value: '300' }], orderBy: [{ fieldId: 'total', direction: 'desc' }] });
    assert.deepEqual(grouped.rows, [{ customer: 'B', total: 1250 }]);
    for (const [operator, value, expected] of [['eq', 2, 125], ['ne', 2, 125], ['gt', 2, 125], ['gte', 2, 250], ['lt', 10, 125], ['lte', 10, 250]] as const) {
      assert.equal(run({ filters: { fieldId: 'amount', operator, value }, metrics: [{ operation: 'count', alias: 'n' }] }).rows[0].n, expected);
    }
    for (const [operator, values, expected] of [['in', [2], 125], ['notIn', [2], 125], ['between', [3, 11], 125]] as const) {
      assert.equal(run({ filters: { fieldId: 'amount', operator, values }, metrics: [{ operation: 'count', alias: 'n' }] }).rows[0].n, expected);
    }
    assert.equal(run({ filters: { logic: 'and', conditions: [{ logic: 'or', conditions: [{ fieldId: 'customer', operator: 'eq', value: 'A' }, { fieldId: 'customer', operator: 'eq', value: 'B' }] }, { fieldId: 'amount', operator: 'gt', value: 2 }] }, metrics: [{ operation: 'count', alias: 'n' }] }).rows[0].n, 125);
    assert.equal(run({ filters: { fieldId: 'day', operator: 'isNull' } }).rows.length, 1);
    assert.equal(run({ filters: { fieldId: 'amount', operator: 'isNotNull' }, metrics: [{ operation: 'count', alias: 'n' }] }).rows[0].n, 250);
    assert.equal(run({ filters: { fieldId: 'day', operator: 'between', values: ['2026-09-01', '2026-09-30'] }, metrics: [{ operation: 'count', alias: 'n' }] }).rows[0].n, 250);
    for (const [grain, bucket] of [['year', '2026'], ['month', '2026-09'], ['day', '2026-09-01']] as const) {
      assert.deepEqual(run({ dimensions: [{ fieldId: 'day', grain }], metrics: [{ operation: 'count', alias: 'n' }] }).rows, [{ day: bucket, n: 250 }, { day: null, n: 1 }]);
    }
    const page1 = run({ fields: ['amount'], orderBy: [{ fieldId: 'amount', direction: 'desc' }], limit: 2 });
    assert.deepEqual(page1.rows, [{ amount: 10 }, { amount: 10 }]); assert.equal(page1.nextOffset, 2); assert.equal(page1.hasMore, true);
    assert.equal(run({ limit: 200, offset: 200 }).rows.length, 51); assert.equal(run({ limit: 200, offset: 200 }).hasMore, false);
    assert.deepEqual(run({ filters: { fieldId: 'customer', operator: 'eq', value: 'missing' }, metrics: [{ fieldId: 'amount', operation: 'sum', alias: 'total' }, { operation: 'count', alias: 'n' }] }).rows, [{ total: null, n: 0 }]);
    db.run('INSERT INTO orders VALUES (?, ?, ?)', ['literal%_!', '1e2', '2026-10-01']);
    assert.equal(run({ fields: ['customer'], filters: { fieldId: 'customer', operator: 'contains', value: '%_!' } }).rows.length, 1);
    assert.equal(run({ fields: ['customer'], filters: { fieldId: 'customer', operator: 'startsWith', value: 'literal' } }).rows.length, 1);
    assert.equal(run({ metrics: [{ fieldId: 'amount', operation: 'max', alias: 'max' }] }).rows[0].max, 100);
    db.run("INSERT INTO orders VALUES ('bad','oops','2026-02-30')");
    assert.throws(() => run({ metrics: [{ fieldId: 'amount', operation: 'sum', alias: 'total' }] }), /无效数据/);
    assert.throws(() => run({ dimensions: [{ fieldId: 'day', grain: 'day' }] }), /无效数据/);
  } finally { db.close(); }
});

for (const engine of ['mysql', 'postgresql'] as const) test(`SDQ-R4/R6/R7: ${engine} read-only driver, placeholders, dates, precision and rollback`, async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let broken = false;
  const c = remoteDatabaseConnectionSchema.parse({ engine, host: 'localhost', user: 'readonly', database: 'db' });
  const t: LiveTable = { schema: 'db', name: 'orders', columns: table.columns.map(c => ({ id: c.id, name: c.nativeName, primary: c.id === 'customer', generated: false, nullable: true, defaulted: false })) };
  const metadata = table.columns.map(c => ({ id: c.id, name: c.name, type: c.type, sample: '', nullable: true }));
  const q = query({ dimensions: [{ fieldId: 'day', grain: 'month' }], metrics: [{ fieldId: 'amount', operation: 'sum', alias: 'total' }], filters: { fieldId: 'customer', operator: 'eq', value: "x' OR 1=1" }, having: [{ fieldId: 'total', operator: 'gte', value: '1.23' }] });
  const factory = async () => ({ async query(sql: string, values: unknown[] = []) {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT')) { if (broken) throw new Error('secret-password'); return [{ day: '2026-09', total: '9007199254740993.12' }]; }
    return [];
  }, async close() {}, destroy() {} });
  const r = await queryLiveStructured(c, t, metadata, q, factory);
  assert.equal(r.rows[0].total, '9007199254740993.12'); assert.equal(r.storageMode, 'live');
  const sql = calls.find(c => c.sql.startsWith('SELECT'))!;
  assert.deepEqual(sql.values, ["x' OR 1=1", '1.23']); assert.ok(!sql.sql.includes("x' OR 1=1"));
  assert.ok(sql.sql.includes(engine === 'mysql' ? 'DATE_FORMAT' : 'TO_CHAR'));
  assert.ok(sql.sql.includes(engine === 'mysql' ? '?' : '$2'));
  assert.ok(calls[0].sql.endsWith('READ ONLY')); assert.equal(calls.at(-1)?.sql, 'ROLLBACK');
  broken = true;
  await assert.rejects(queryLiveStructured(c, t, metadata, q, factory)); assert.equal(calls.at(-1)?.sql, 'ROLLBACK');
});

test('SDQ-R7: bounded results and numerical overflow never silently serialized', () => {
  const q = query(), compiled = compileStructuredQuery(q, table, 'sqlite');
  assert.throws(() => structuredQueryResult(q, compiled, [{ amount: Infinity }], 'local'), /超出/);
  assert.throws(() => structuredQueryResult(q, compiled, [{ customer: 'x'.repeat(4 * 1024 * 1024) }], 'local'), /4 MB/);
});

test('SDQ-R3/R6: local booleans, NULL, decimal/scientific syntax and invalid stored values', async () => {
  const db = await sqlite();
  const boolTable: QueryTable = { name: 'flags', stableOrder: ['rowid'], columns: [{ id: 'flag', name: '标识', nativeName: 'flag', type: '布尔值' }, { id: 'n', name: '数值', nativeName: 'n', type: '小数' }] };
  try {
    db.run('CREATE TABLE flags(flag TEXT,n TEXT)');
    for (const [flag, n] of [['true', '.5'], ['1', '-.5'], ['false', '+1.25'], ['0', '1.2e+2'], [null, ''], ['', null]]) db.run('INSERT INTO flags VALUES (?, ?)', [flag, n]);
    const run = (patch: object) => executeLocalStructuredQuery(db, query(patch), boolTable, 'local');
    assert.equal(run({ filters: { fieldId: 'flag', operator: 'eq', value: true }, metrics: [{ operation: 'count', alias: 'nrows' }] }).rows[0].nrows, 2);
    assert.equal(run({ filters: { fieldId: 'flag', operator: 'in', values: [false] }, metrics: [{ operation: 'count', alias: 'nrows' }] }).rows[0].nrows, 2);
    assert.equal(run({ filters: { fieldId: 'flag', operator: 'isNull' }, metrics: [{ operation: 'count', alias: 'nrows' }] }).rows[0].nrows, 2);
    assert.equal(run({ metrics: [{ fieldId: 'n', operation: 'sum', alias: 'total' }] }).rows[0].total, 121.25);
    assert.throws(() => run({ filters: { fieldId: 'flag', operator: 'between', values: [0, 1] } }), /布尔字段/);
    for (const invalid of ['1.2.3', '--1', '.', '1e', '1ee2', '1e309', 'NaN']) {
      db.run('INSERT INTO flags VALUES (?, ?)', ['true', invalid]);
      assert.throws(() => run({ metrics: [{ fieldId: 'n', operation: 'sum', alias: 'total' }] }), /无效数据/);
      db.run('DELETE FROM flags WHERE rowid=(SELECT MAX(rowid) FROM flags)');
    }
    db.run("INSERT INTO flags VALUES ('unknown','1')");
    assert.throws(() => run({ fields: ['flag'] }), /无效数据/);
  } finally { db.close(); }
});

test('SDQ-R1/R2/R7: authenticated API ownership, local/live aggregation, errors and old GET compatibility', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-sdq-')), previous = process.env.OPENCLAWX_DATA_DIR;
  process.env.OPENCLAWX_DATA_DIR = dir;
  const app = Fastify();
  let remoteBroken = false;
  const remoteCalls: string[] = [];
  app.addHook('preHandler', async r => { r.auth = { userId: String(r.headers['x-user'] || 'u'), orgId: String(r.headers['x-org'] || 'o'), username: 'test', displayName: 'test', role: 'admin', sessionId: 'test' }; });
  await app.register(dataRoutes, { remoteFactory: async () => ({ async query(sql) {
    remoteCalls.push(sql);
    if (sql.includes('SCHEMATA')) return [{ name: 'business' }];
    if (sql.includes('TABLE_TYPE')) return [{ schema_name: 'business', table_name: 'orders', table_engine: 'InnoDB' }];
    if (sql.includes('COLUMNS')) return [{ name: 'amount', data_type: 'decimal', nullable: 'YES' }];
    if (sql.startsWith('SELECT')) { if (remoteBroken) throw new Error('secret-password'); return [{ total: '123.45' }]; }
    return [];
  }, async close() {}, destroy() {} }) });
  try {
    const imported = await app.inject({ method: 'POST', url: '/data/import', payload: { name: 'rows.json', contentBase64: Buffer.from(JSON.stringify([{ customer: 'A', amount: 2 }, { customer: 'B', amount: 10 }])).toString('base64') } });
    assert.equal(imported.statusCode, 200, imported.body);
    const source = imported.json(), t = source.tables[0];
    const payload = { sourceId: source.id, tableId: t.id, metrics: [{ fieldId: 'c_2', operation: 'sum', alias: 'total' }] };
    const call = (body: object, headers?: Record<string, string>) => app.inject({ method: 'POST', url: '/data/gateway/query', payload: body, headers });
    const r = await call(payload); assert.equal(r.statusCode, 200, r.body); assert.deepEqual(r.json().rows, [{ total: 12 }]); assert.ok(r.json().queryId); assert.ok(!('sql' in r.json()));
    for (const headers of [{ 'x-user': 'other' }, { 'x-org': 'other' }] as Record<string, string>[]) assert.equal((await call(payload, headers)).statusCode, 404);
    assert.equal((await call({ ...payload, tableId: 'other' })).statusCode, 404);
    assert.equal((await call({ ...payload, sql: 'DROP TABLE x' })).statusCode, 400);
    assert.equal((await call({ ...payload, fields: ['unknown'], metrics: [] })).statusCode, 400);
    const old = await app.inject({ method: 'GET', url: `/data/gateway/query?sourceId=${source.id}&tableId=${t.id}` });
    assert.equal(old.statusCode, 200); assert.equal(old.json().rows.length, 2);
    const saved = await app.inject({ method: 'POST', url: '/data/connections', payload: { name: 'test', connection: { engine: 'mysql', host: 'localhost', user: 'reader', password: 'secret-password', database: 'business' } } });
    assert.equal(saved.statusCode, 201, saved.body);
    const made = await app.inject({ method: 'POST', url: '/data/sources/live', payload: { connectionId: saved.json().id, database: 'business', name: 'live', tables: [{ schema: 'business', name: 'orders' }] } });
    assert.equal(made.statusCode, 201, made.body);
    const live = made.json(), livePayload = { sourceId: live.id, tableId: live.tables[0].id, metrics: [{ fieldId: 'c_1', operation: 'sum', alias: 'total' }] };
    const before = remoteCalls.length;
    assert.equal((await call(livePayload, { 'x-user': 'other' })).statusCode, 404); assert.equal(remoteCalls.length, before);
    const liveResult = await call(livePayload); assert.equal(liveResult.statusCode, 200, liveResult.body); assert.equal(liveResult.json().rows[0].total, '123.45');
    remoteBroken = true;
    const error = await call(livePayload); assert.equal(error.statusCode, 502); assert.ok(!error.body.includes('secret-password'));
  } finally { await app.close(); if (previous === undefined) delete process.env.OPENCLAWX_DATA_DIR; else process.env.OPENCLAWX_DATA_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); }
});
