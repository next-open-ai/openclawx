import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteDatabaseConnectionSchema, remoteDatabaseImportSchema } from '@openclawx/contracts';
import { inspectRemoteDatabase, importRemoteDatabase, remoteIdentifier, remoteError, remoteFactory, type RemoteFactory } from './remote-database.js';

test('RDB-R1/R2: defaults, selection validation, safe identifiers and error redaction', () => {
  const base = { host: 'localhost', user: 'reader' };
  assert.equal(remoteDatabaseConnectionSchema.parse({ ...base, engine: 'mysql' }).port, 3306);
  assert.equal(remoteDatabaseConnectionSchema.parse({ ...base, engine: 'postgresql' }).port, 5432);
  assert.equal(remoteDatabaseConnectionSchema.parse({ ...base, engine: 'mysql' }).tls, true);
  for (const host of ['http://localhost', 'user:password@server', '../unix.sock']) assert.equal(remoteDatabaseConnectionSchema.safeParse({ ...base, host, engine: 'mysql' }).success, false);
  assert.equal(remoteDatabaseImportSchema.safeParse({ connection: { ...base, engine: 'mysql' }, name: 'db', tables: [{ schema: 'db', name: 't' }] }).success, false);
  assert.equal(remoteIdentifier('mysql', 't`; DELETE FROM orders; --'), '`t``; DELETE FROM orders; --`');
  assert.equal(remoteIdentifier('postgresql', 'a"b'), '"a""b"');
  assert.ok(!remoteError(new Error('password=private')).includes('private'));
  assert.ok(remoteError({ code: '28P01' }).includes('密码'));
});

test('RDB-R1/R2/R3: both adapters read metadata/comments and bounded rows, close on failure', async () => {
  for (const engine of ['mysql', 'postgresql'] as const) {
    const statements: string[] = [];
    let destroyed = 0;
    const factory: RemoteFactory = async () => ({
      async query(sql, params) {
        statements.push(sql);
        if (sql.includes('SCHEMATA') || sql.includes('FROM pg_database')) return [{ name: 'business' }];
        if (sql.includes('TABLE_TYPE') || sql.includes('obj_description')) return [{ schema_name: engine === 'mysql' ? 'business' : 'public', table_name: 'orders', description: 'order table' }];
        if (sql.includes('COLUMNS') || sql.includes('col_description')) {
          assert.deepEqual(params, [engine === 'mysql' ? 'business' : 'public', 'orders']);
          return [{ name: 'id', data_type: 'bigint', nullable: 'NO', description: 'identifier' }, { name: 'amount', data_type: 'decimal', nullable: 'YES', description: 'paid amount' }];
        }
        if (sql.startsWith('SELECT ')) return [{ id: '9007199254740993', amount: '12.34' }];
        return [];
      }, async close() {}, destroy() { destroyed++; },
    });
    const connection = remoteDatabaseConnectionSchema.parse({ engine, host: 'localhost', user: 'reader', database: 'business', password: 'private' });
    const inspected = await inspectRemoteDatabase(connection, factory);
    assert.deepEqual(inspected.databases, ['business']); assert.equal(inspected.tables.length, 1);
    const result = await importRemoteDatabase({ connection, name: 'object', tables: inspected.tables }, factory);
    assert.equal(result.discovered[0].columns[0].description, 'identifier');
    assert.equal(result.discovered[0].columns[1].type, '小数');
    assert.equal(result.discovered[0].rows[0][0], '9007199254740993');
    assert.ok(statements.includes(engine === 'mysql' ? 'START TRANSACTION READ ONLY' : 'BEGIN READ ONLY'));
    assert.ok(statements.at(-2)?.endsWith('LIMIT 20001')); assert.equal(statements.at(-1), 'ROLLBACK');
    assert.equal(destroyed, 2);
    await assert.rejects(importRemoteDatabase({ connection, name: 'invalid', tables: [{ schema: 'other', name: 'not-authorized' }] }, factory));
    assert.equal(destroyed, 3);
  }
});

test('RDB-R2: oversized tables are explicitly marked as truncated', async () => {
  const connection = remoteDatabaseConnectionSchema.parse({ engine: 'mysql', host: 'localhost', user: 'reader', database: 'business' });
  const result = await importRemoteDatabase({ connection, name: 'object', tables: [{ schema: 'business', name: 'orders' }] }, async () => ({
    async query(sql) {
      if (sql.includes('TABLE_TYPE')) return [{ schema_name: 'business', table_name: 'orders' }];
      if (sql.includes('COLUMNS')) return [{ name: 'id', data_type: 'int', nullable: 'NO' }];
      if (sql.startsWith('SELECT ')) return Array.from({ length: 20001 }, (_, id) => ({ id }));
      return [];
    }, async close() {}, destroy() {},
  }));
  assert.equal(result.discovered[0].rows.length, 20000);
  assert.deepEqual(result.truncatedTables, ['business.orders']);
});

test('RDB-R2/R5: capacity and deadline release connections', async t => {
  const c = remoteDatabaseConnectionSchema.parse({ engine: 'mysql', host: 'localhost', user: 'reader' });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const factory: RemoteFactory = async () => ({ async query() { await gate; return []; }, async close() {}, destroy() {} });
  const first = inspectRemoteDatabase(c, factory), second = inspectRemoteDatabase(c, factory);
  await assert.rejects(inspectRemoteDatabase(c, factory), /任务较多/);
  release(); await Promise.all([first, second]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let destroyed = 0;
  const timeout = inspectRemoteDatabase(c, async () => ({ async query() { return new Promise(() => {}); }, async close() {}, destroy() { destroyed++; } }));
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(90_001);
  await assert.rejects(timeout, /超时/);
  assert.ok(destroyed > 0);
  t.mock.timers.reset();
  assert.deepEqual((await inspectRemoteDatabase(c, factory)).databases, []);
});

for (const engine of ['mysql', 'postgresql'] as const) {
  const port = process.env[engine === 'mysql' ? 'OPENCLAWX_TEST_MYSQL_PORT' : 'OPENCLAWX_TEST_POSTGRES_PORT'];
  test(`RDB real acceptance: ${engine} inspect, comments, empty table, precision and READ ONLY`, { skip: !port }, async () => {
    const connection = remoteDatabaseConnectionSchema.parse({ engine, host: '127.0.0.1', port: Number(port), user: 'openclawx_reader', password: 'openclawx-test-only', database: 'business', tls: false });
    const inspected = await inspectRemoteDatabase(connection);
    assert.ok(inspected.databases.includes('business'));
    const selected = inspected.tables.filter(t => ['orders', 'empty_table'].includes(t.name));
    assert.equal(selected.length, 2);
    const result = await importRemoteDatabase({ connection, name: 'real isolated DB', tables: selected });
    const orders = result.discovered.find(t => t.name === 'orders')!;
    assert.equal(orders.rows.length, 2);
    const idIndex = orders.columns.findIndex(c => c.name === 'id');
    assert.ok(orders.rows.some(row => row[idIndex] === '9007199254740993'));
    assert.equal(orders.columns.find(c => c.name === 'amount')?.description, 'paid amount');
    assert.equal(result.discovered.find(t => t.name === 'empty_table')?.rows.length, 0);
    const client = await remoteFactory(connection);
    try {
      await client.query(engine === 'mysql' ? 'START TRANSACTION READ ONLY' : 'BEGIN READ ONLY');
      await assert.rejects(client.query('UPDATE orders SET amount=0'));
      await client.query('ROLLBACK');
    } finally { client.destroy(); }
  });
}
