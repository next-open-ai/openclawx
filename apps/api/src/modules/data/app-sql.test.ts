import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { dataAppSqlOperationSchema } from '@openclawx/contracts';
import { compileAppSql, appSqlResult, type SqlTable } from './app-sql.js';
import { ManagedAppQueries } from './app-query.js';
import { createLiveDataService, migrateLiveData } from './live-data-routes.js';
import { databaseSecret } from './database-secrets.js';
import { managedAppDocument, managedAppPrompt } from './app-query-page.js';
import { managedStaticDeliveryInstructions } from './app-delivery-prompt.js';
import { managedAppPage } from './app-query-page.js';
import vm from 'node:vm';
import { columnType } from './remote-database.js';
const tables: SqlTable[] = [{ id: 't', name: 'students', schema: 'business', transactional: true, columns: [
  { id: 'c_1', name: 'id', primary: true }, { id: 'c_2', name: 'full_name' }, { id: 'c_3', name: 'secret', sensitive: true },
] }];
const op = (sql: string, parameters: Record<string, string | number> = {}) => dataAppSqlOperationSchema.parse({
  kind: 'sql', operationId: 'students', description: '学生操作', sql,
  parameters: Object.entries(parameters).map(([name, value]) => ({ name, type: typeof value })), testParameters: parameters,
});
async function sqlite() {
  const require = createRequire(import.meta.url), root = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
  const SQL = await require(path.join(root, 'sql-wasm.js'))({ wasmBinary: fs.readFileSync(path.join(root, 'sql-wasm.wasm')) });
  return new SQL.Database();
}
test('SQL-R1: real SQL AST mapping, bound values, dialects and joins/aggregation', async () => {
  for (const dialect of ['mysql','postgresql','sqlite'] as const) {
    const plan = compileAppSql(op('SELECT c_1 AS id, c_2 AS name FROM t WHERE c_2=:name', { name: "x' OR 1=1 --" }), tables.map(t => ({ ...t, schema: undefined })), dialect, { name: "x' OR 1=1 --" });
    assert.deepEqual(plan.values, ["x' OR 1=1 --"]); assert.ok(!plan.sql.includes('OR 1=1')); assert.match(plan.sql, /full_name/);
    assert.ok(plan.sql.includes(dialect === 'postgresql' ? '$1' : '?'));
  }
  const db = await sqlite(); db.run('CREATE TABLE students (id INTEGER,full_name TEXT); INSERT INTO students VALUES(1,\'小花\'),(2,\'小明\')');
  const plan = compileAppSql(op('SELECT c_2 AS name, COUNT(*) AS n FROM t GROUP BY c_2 HAVING COUNT(*) > 0 ORDER BY n DESC'), tables.map(t => ({ ...t, schema: undefined })), 'sqlite', {});
  assert.equal(db.exec(plan.sql, plan.values)[0].values.length, 2);
  const join = compileAppSql(op('SELECT a.c_2 AS name, b.c_1 AS other FROM t a LEFT JOIN t b ON a.c_1=b.c_1'), tables.map(t => ({ ...t, schema: undefined })), 'sqlite', {});
  assert.equal(db.exec(join.sql)[0].values.length, 2); db.close();
  assert.match(compileAppSql(op('SELECT LOWER(c_2) AS name FROM t'), tables, 'mysql', {}).sql, /LOWER/);
  assert.match(compileAppSql(op('SELECT DISTINCT c_2 AS name FROM t'), tables, 'mysql', {}).sql, /DISTINCT/);
});
test('SQL-R1: fail closed on scopes, sensitive fields, DDL, multi statements, functions and subqueries', () => {
  for (const sql of [
    'SELECT c_3 FROM t','SELECT * FROM t','SELECT c_1 FROM other', 'SELECT c_1 FROM business.t',
    'SELECT c_1 FROM t; DELETE FROM t', 'DROP TABLE t','SELECT SLEEP(20) AS x FROM t',
    'SELECT LOAD_FILE(c_2) AS x FROM t', 'SELECT c_1 FROM t INTO OUTFILE \'x\'',
    'SELECT c_1 FROM t FOR UPDATE', 'SELECT c_1 FROM t UNION SELECT c_1 FROM t',
    'SELECT c_1 FROM t WHERE c_1 IN (SELECT c_1 FROM t)', 'SELECT @x AS x FROM t',
  ]) assert.throws(() => compileAppSql(op(sql), tables, 'mysql', {}), sql);
  assert.throws(() => compileAppSql(op('SELECT c_1 FROM t WHERE c_1=:id', { id: 1 }), tables, 'mysql', { id: '1' }), /number/);
  assert.throws(() => compileAppSql(op('SELECT c_1 FROM t'), tables, 'mysql', { extra: 1 }), /未知/);
  assert.throws(() => compileAppSql(op('SELECT c_1 FROM t'), tables.map(t => ({ ...t, name: 'table` WHERE 1=1 --' })), 'mysql', {}), /特殊字符/);
  assert.throws(() => compileAppSql(op('SELECT c_1 FROM t AS `alias`'), tables.map(t => ({ ...t, columns: t.columns.map(c => ({...c,name:'x`y'})) })), 'mysql', {}), /特殊字符/);
  const escaped = compileAppSql(op("SELECT c_1 FROM t WHERE c_2='x\\' OR 1=1 --'"), tables, 'postgresql', {});
  assert.ok(!escaped.sql.includes('OR 1=1')); assert.equal(escaped.values[0], "x' OR 1=1 --");
});
test('SQL-R3: only one-row values or complete bound PK WHERE, no PK/generated updates', () => {
  for (const sql of ['UPDATE t SET c_2=:name', 'DELETE FROM t WHERE c_2=:name', 'DELETE FROM t WHERE c_1=1', 'UPDATE t SET c_1=:id WHERE c_1=:id', 'INSERT INTO t(c_2) VALUES(:name),(:name)']) {
    assert.throws(() => compileAppSql(op(sql, sql.includes(':name') ? { name: '花' } : { id: 1 }), tables, 'mysql', sql.includes(':name') ? { name: '花' } : { id: 1 }));
  }
  for (const sql of ['UPDATE t SET c_2=:name WHERE c_1=:id', 'DELETE FROM t WHERE c_1=:id', 'INSERT INTO t(c_2) VALUES(:name)']) {
    const p: Record<string, string | number> = sql.startsWith('UPDATE') ? { name: '花', id: 1 } : sql.startsWith('DELETE') ? { id: 1 } : { name: '花' };
    const plan = compileAppSql(op(sql, p), tables, 'mysql', p); assert.notEqual(plan.action, 'select');
  }
});
test('SQL-R2/R3: operation persistence, drafts never execute, explicit revision approval, stale/replaced approvals', async () => {
  const db = await sqlite();
  db.run('CREATE TABLE data_apps(id TEXT,org_id TEXT,owner_user_id TEXT); INSERT INTO data_apps VALUES(\'app\',\'o\',\'u\')');
  ManagedAppQueries.migrate(db);
  const calls: string[] = [], owner = { userId: 'u', orgId: 'o', role: 'admin' };
  const service = new ManagedAppQueries(db, () => {}, { list: async () => [], schema: async () => { throw new Error(); }, query: async () => {}, sqlOperation: async (_s,_t,operation,_p,_a,mode) => {
    const plan = compileAppSql(operation,tables,'mysql',operation.testParameters.id !== undefined ? operation.testParameters : { name: '花', id: 1 }); calls.push(mode);
    return mode === 'validate' ? { action: plan.action, validationLevel: 'explain' } : mode === 'rollback' ? {rolledBack:true,affectedRows:1} : mode === 'write' ? { affectedRows: 1 } : { fields: [], rows: [] };
  } });
  service.createScope('app','s',['t']);
  const result = await service.registerSql('app',owner,op('UPDATE t SET c_2=:name WHERE c_1=:id', { name: '花', id: 1 }));
  assert.deepEqual(calls, ['validate']); assert.equal(result.pendingApproval, true); assert.equal(result.verifiedAt, 0);
  await assert.rejects(service.mutate('app',owner,{ operationId: 'students', parameters: { name: '花', id: 1 }, revision: result.revision, confirmed: true }), /未批准/);
  await assert.rejects(service.approveSql('app','students',{ ...owner, role: 'member' }, { revision: result.revision }), /管理员/);
  await assert.rejects(service.approveSql('app','students',owner, { revision: '0'.repeat(64) }), /变化/);
  await service.approveSql('app','students',owner, { revision: result.revision }); assert.equal(service.list('app')[0].approved,true);
  await service.mutate('app',owner,{ operationId: 'students', parameters: { name: '花', id: 1 }, revision: result.revision }); assert.deepEqual(calls, ['validate','write']);
  await service.mutate('app',owner,{ operationId: 'students', parameters: { name: '花', id: 1 }, revision: result.revision, confirmed: true }); assert.deepEqual(calls, ['validate','write','write']);
  const trial={ operationId:'students',revision:result.revision,parameters:{name:'花',id:1},testDatabaseConfirmed:true,acknowledgeSideEffects:true };
  await assert.rejects(service.trialSql('app',owner,{...trial,testDatabaseConfirmed:false}));
  await assert.rejects(service.trialSql('app',{...owner,role:'member'},trial),/管理员/);
  await service.trialSql('app',owner,trial); assert.equal(calls.at(-1),'rollback'); assert.equal(service.list('app')[0].validation?.level,'rollback');
  assert.ok(!JSON.stringify(db.exec('SELECT * FROM data_app_sql_validations')).includes('花'));
  await service.registerSql('app',owner,{ ...op('UPDATE t SET c_2=:name WHERE c_1=:id', { name: '花', id: 1 }), description: 'changed' });
  assert.equal(service.list('app')[0].approved,false);
  assert.equal(service.list('app')[0].validation?.level,'explain'); await assert.rejects(service.trialSql('app',owner,trial));
  assert.ok(!db.exec('SELECT definition_json FROM data_app_queries')[0].values[0][0].includes('花')); db.close();
});
test('SQL-R3: gateway write switch/admin, transaction rollback and read test cannot mutate', async () => {
  const db = await sqlite(); migrateLiveData(db); const id = 'sql-synthetic-credential'; await databaseSecret(id, 'synthetic');
  db.run('INSERT INTO data_saved_connections VALUES(?,?,?,?)',[id,'u','o',JSON.stringify({ id, engine: 'mysql', host: 'localhost', port: 3306, user: 'test', database: 'business', tls: false })]);
  const binding = { connectionId: id, database: 'business', writeEnabled: false, tables: { t: tables[0] } };
  db.run('INSERT INTO data_live_objects VALUES(?,?)',['s',JSON.stringify(binding)]);
  let affected = 1; let abort: (() => void) | undefined; let failCommit = false; let executeError: Error | undefined; const executed: string[] = [];
  let triggers = 0, failRollback = false;
  const service = createLiveDataService({ database: async () => db, flush: () => {}, source: (_db,_s,auth) => auth.userId === 'u' ? { tables: [{ id: 't', columns: tables[0].columns.map(c => ({ id: c.id, name: c.name, type: '文本' as const, nullable: false, sample: '', sensitive: c.sensitive })) }] } : null, persist: () => '', factory: async () => ({ query: async sql => { executed.push(sql); if (failCommit && sql === 'COMMIT') throw new Error('synthetic lost commit response'); if (failRollback && sql === 'ROLLBACK') throw new Error('synthetic rollback failure'); if(sql.includes('information_schema.COLUMNS')) return tables[0].columns.map(c=>({name:c.name,data_type:c.primary?'int':'varchar',nullable:'YES'})); if(sql.includes('information_schema.TRIGGERS'))return[{n:triggers}]; return []; }, execute: async sql => {executed.push(sql); if (executeError) throw executeError; abort?.(); return affected;}, close: async () => {}, destroy: () => {} }) });
  const definition = op('UPDATE t SET c_2=:name WHERE c_1=:id',{ name: '花', id: 1 }), owner = { userId: 'u', orgId: 'o', role: 'admin' };
  const preflight = await service.sqlOperation('s',['t'],definition,definition.testParameters,owner,'validate'); assert.equal((preflight as any).validationLevel,'explain'); assert.ok(executed.some(sql=>sql.startsWith('EXPLAIN UPDATE'))); assert.ok(!executed.some(sql=>sql.startsWith('UPDATE')));
  await assert.rejects(service.sqlOperation('s',['t'],definition,definition.testParameters,owner,'read'), /不能通过查询/);
  await assert.rejects(service.sqlOperation('s',['t'],definition,definition.testParameters,owner,'write'), /开启/);
  binding.writeEnabled=true; db.run('UPDATE data_live_objects SET binding_json=?',[JSON.stringify(binding)]);
  await assert.rejects(service.sqlOperation('s',['t'],definition,definition.testParameters,{...owner,role:'member'},'write'), /管理员/);
  affected=2; await assert.rejects(service.sqlOperation('s',['t'],definition,definition.testParameters,owner,'write'), /回滚/); assert.equal(executed.at(-1),'ROLLBACK'); assert.ok(!executed.includes('COMMIT'));
  affected=1;
  const controller = new AbortController(); abort = () => controller.abort();
  await assert.rejects(service.sqlOperation('s',['t'],definition,definition.testParameters,owner,'write',controller.signal)); assert.equal(executed.at(-1),'ROLLBACK');
  abort = undefined; await service.sqlOperation('s',['t'],definition,definition.testParameters,owner,'write'); assert.equal(executed.at(-1),'COMMIT');
  failCommit = true;
  await assert.rejects(service.sqlOperation('s',['t'],definition,definition.testParameters,owner,'write'), (error: any) => error.code === 'APP_WRITE_UNCONFIRMED' && !error.message.includes('synthetic') && error.message.includes('不要自动重试'));
  failCommit = false; executeError = Object.assign(new Error('private SQL details'), { code: 'ER_BAD_FIELD_ERROR' });
  await assert.rejects(service.sqlOperation('s',['t'],definition,definition.testParameters,owner,'write'), (error: any) => error.code === 'APP_SQL_EXECUTION_FAILED' && !error.message.includes('private'));
  for (const code of ['ER_DATA_TOO_LONG','ER_NO_DEFAULT_FOR_FIELD','ER_TABLEACCESS_DENIED_ERROR','ER_DUP_ENTRY','23503','23502','22003','25006']) {
    executeError = Object.assign(new Error('private SQL and student values'), { code });
    await assert.rejects(service.sqlOperation('s',['t'],definition,definition.testParameters,owner,'write'), (error: any) => error.code === 'APP_SQL_DATABASE_REJECTED' && error.message.includes(code) && !error.message.includes('private') && !error.message.includes('连接中断'));
    assert.equal(executed.at(-1),'ROLLBACK');
  }
  executeError = Object.assign(new Error("Data too long for column 'full_name' at row 1; private value"), {code:'ER_DATA_TOO_LONG'});
  await assert.rejects(service.sqlOperation('s',['t'],definition,definition.testParameters,owner,'write'), (error: any) => error.message.includes('full_name') && !error.message.includes('private'));
  executeError=undefined; executed.length=0;
  const trial=await service.sqlOperation('s',['t'],definition,definition.testParameters,owner,'rollback'); assert.equal((trial as any).rolledBack,true); assert.equal(executed.at(-1),'ROLLBACK'); assert.ok(!executed.includes('COMMIT'));
  triggers=1; executed.length=0; await assert.rejects(service.sqlOperation('s',['t'],definition,definition.testParameters,owner,'rollback'),/触发器/); assert.ok(!executed.some(sql=>sql.startsWith('UPDATE')));
  triggers=0; failRollback=true; await assert.rejects(service.sqlOperation('s',['t'],definition,definition.testParameters,owner,'rollback')); assert.ok(!executed.includes('COMMIT'));
  db.close();
});
test('SQL-R10: BIT native typing rejects string flags before execution, supports numeric zero', () => {
  assert.equal(columnType('bit'),'整数'); assert.equal(columnType('bit(1)'),'整数'); assert.equal(columnType('boolean'),'布尔值');
  const bitTable: SqlTable[]=[{id:'t',name:'students',transactional:true,columns:[{id:'c_1',name:'deleted',nativeType:'bit(1)'}]}];
  assert.throws(()=>compileAppSql(op("INSERT INTO t(c_1) VALUES('0')"),bitTable,'mysql',{}),/不能写字符串/);
  const plan=compileAppSql(op('INSERT INTO t(c_1) VALUES(0)'),bitTable,'mysql',{}); assert.deepEqual(plan.values,[0]);
  assert.throws(()=>compileAppSql(op('INSERT INTO t(c_1) VALUES(:flag)',{flag:'0'}),bitTable,'mysql',{flag:'0'}),/不能写字符串/);
});
test('SQL-R4: SDK available before generated scripts, no bearer in page, bounded results and updated prompt', () => {
  const html = managedAppDocument('<script>openclawxData.query("students")</script>');
  assert.ok(html.indexOf('window.openclawxData=') < html.indexOf('openclawxData.query("students")'));
  assert.match(html,/openclawx.app.mutate/); assert.ok(!html.includes('x-openclawx-session'));
  assert.equal(appSqlResult(Array.from({length:201},()=>({id:1}))).rows.length,200);
  assert.equal(appSqlResult(Array.from({length:201},()=>({id:1}))).hasMore,true);
  assert.match(managedAppPrompt({appId:'a',sourceId:'s',name:'test',idea:'test',token:'x',publishUrl:'/app'}),/不必先发布/);
});
test('MDA-T23: persistent project brief delegates data protocol; static delivery owns SDK and host constraints', () => {
  const input={appId:'test-app',sourceId:'test-source',name:'业务应用',idea:'统计业务收入',token:'synthetic-binding-token',publishUrl:'/synthetic-app'};
  const delivery=managedStaticDeliveryInstructions(input), prompt=managedAppPrompt(input);
  assert.ok(prompt.includes(delivery)); assert.ok(prompt.includes(input.idea)); assert.ok(prompt.includes(input.sourceId));
  assert.match(prompt,/本轮可用工具说明/);
  assert.doesNotMatch(prompt,/EXPLAIN|UNION|CURRENT_TIMESTAMP|MySQL 基础语法|parameters:\[/);
  assert.doesNotMatch(delivery,/data_app_register_sql|data_app_propose_schema|InnoDB|UNION/);
  assert.match(delivery,/仅约束本应用/);assert.match(delivery,/openclawxData/);assert.match(delivery,/不必先发布/);
  assert.match(delivery,/bind_data_app_custom_site/);assert.match(delivery,/token仅用于绑定/);
  assert.ok(prompt.length < 1600, 'project context should not repeat the full SQL/tool protocol');
});
test('SQL-R5: shared preview/published SDK queues six queries, bounds waiting and releases on errors/timeouts', async () => {
  function setup() {
    const source = managedAppDocument('').match(/<script>([\s\S]*?)<\/script>/)![1];
    const sent: any[] = [], timers = new Map<number, () => void>(); let timerId = 0;
    let receive: (event: any) => void = () => {};
    const events: string[] = [], parent = { postMessage: (message: any) => sent.push(message) }, window: any = {dispatchEvent:(event: Event)=>events.push(event.type)};
    vm.runInNewContext(source, { parent, window, Event, addEventListener: (_: string, fn: typeof receive) => { receive = fn; }, setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id: number) => timers.delete(id) });
    const reply = (id: number, ok = true) => receive({source:parent,data:{type:'openclawx.app.result',id,ok,data:{rows:[]},error:'synthetic query failed',code:'TEST_FAILURE'}});
    return { sent, timers, reply, receive, parent, events, sdk: window.openclawxData };
  }
  const a = setup();
  const results = Array.from({length:6}, (_,i) => a.sdk.query(`op${i}`).catch((e: any) => e));
  assert.equal(a.sent.length,4);
  a.receive({source:{},data:{type:'openclawx.app.result',id:1,ok:true}}); assert.equal(a.sent.length,4);
  a.reply(1); assert.equal(a.sent.length,5);
  a.reply(2,false); assert.equal(a.sent.length,6);
  for (const id of [3,4,5,6]) a.reply(id);
  assert.equal((await results[1]).code,'TEST_FAILURE'); await Promise.all(results); assert.equal(a.timers.size,0);
  const access = a.sdk.getAccess(); assert.equal(a.sent.at(-1).type,'openclawx.app.access'); a.reply(7); await access;
  a.receive({source:a.parent,data:{type:'openclawx.app.access-changed'}}); assert.deepEqual(a.events,['openclawx:data-access-changed']);
  const b = setup();
  const pending = Array.from({length:32}, (_,i) => b.sdk.query(`op${i}`).catch((e: any) => e));
  assert.equal((await b.sdk.query('overflow').catch((e: any) => e)).code,'APP_BRIDGE_QUEUE_FULL');
  b.timers.get(5)!(); assert.equal((await pending[4]).code,'APP_BRIDGE_TIMEOUT');
  b.reply(1); assert.equal(b.sent.at(-1).id,6); // Timed-out queued request never sent.
  b.timers.get(2)!(); assert.equal(b.sent.at(-1).id,7); // Active timeout frees its slot.
  for (let i=0; i<b.sent.length; i++) b.reply(b.sent[i].id);
  await Promise.all(pending); assert.equal(b.timers.size,0); assert.equal(b.sent.length,31);
});
test('SQL-R8: approved CRUD without runtime confirmation and dynamic access', async () => {
  const html = managedAppPage('app', '<h1>synthetic</h1>');
  const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1];
  let receive: (e: unknown) => Promise<void> = async () => {};
  const nodes = new Map<string, any>(), calls: Array<{ path: string; body?: any }> = [], messages: any[] = [];
  const frame = { contentWindow: { postMessage: (v: unknown) => messages.push(v) }, srcdoc: '' };
  nodes.set('#app', frame);
  const document = { querySelector: (key: string) => { if (!nodes.has(key)) nodes.set(key, {value:'owner',hidden:false,textContent:'',disabled:false,addEventListener: (_: string, fn: unknown) => nodes.get(key).submit = fn }); return nodes.get(key); } };
  let confirm = false, approved = false, canWrite = true, action = 'update', confirms = 0; let holdRead: Promise<void> | undefined;
  const context = { document, AbortSignal, confirm: () => { confirms++; return confirm; }, addEventListener: (_: string, fn: typeof receive) => { receive = fn; }, fetch: async (path: string, init?: {body?:string;headers?:Record<string,string>}) => {
    calls.push({path, body:init?.body?JSON.parse(init.body):undefined});
    if (path.endsWith('/query') && holdRead) await holdRead;
    const data = path.includes('/auth/login') ? {token:'host-private'} : path.endsWith('/operations') ? { canApprove:true,canWrite,writeEnabled:canWrite,operations:[{kind:'sql',action,operationId:'edit',description:'edit',sql:'UPDATE t SET c_2=:name WHERE c_1=:id',revision:'a'.repeat(64),approved}] } : {affectedRows:1};
    if(path.endsWith('/approve'))approved=true;
    return {ok:true,json:async()=>data};
  } };
  vm.runInNewContext(source, context);
  await nodes.get('#login').submit({preventDefault:()=>{}});
  await receive({ source: {}, data: { type:'openclawx.app.mutate',id:1,operationId:'edit' } }); assert.equal(messages.length,0);
  await receive({ source: frame.contentWindow, data: { type:'openclawx.app.query',id:'bad',operationId:'edit' } }); assert.equal(messages.at(-1).code,'APP_BRIDGE_INVALID_REQUEST');
  await receive({ source: frame.contentWindow, data: { type:'openclawx.app.query',id:10,operationId:'edit',parameters:{large:'x'.repeat(20001)} } }); assert.equal(messages.at(-1).code,'APP_BRIDGE_PAYLOAD_TOO_LARGE');
  await receive({ source: frame.contentWindow, data: { type:'openclawx.app.mutate',id:2,operationId:'edit',parameters:{id:1,name:'花'} } });
  assert.equal(calls.filter(c=>c.path.endsWith('/mutate')).length,0); assert.equal(messages.at(-1).ok,false);
  approved=true;
  await receive({ source: frame.contentWindow, data: { type:'openclawx.app.mutate',id:3,operationId:'edit',parameters:{id:1,name:'花'} } });
  assert.equal(calls.filter(c=>c.path.endsWith('/approve')).length,0);
  const write = calls.find(c=>c.path.endsWith('/mutate'))!; assert.equal(write.body.confirmed,undefined); assert.equal(write.body.revision,'a'.repeat(64)); assert.equal(messages.at(-1).ok,true);
  const submit = (id: number) => receive({source:frame.contentWindow,data:{type:'openclawx.app.mutate',id,operationId:'edit',parameters:{id:1,name:'花'}}});
  confirm=false; const previousConfirms=confirms;
  await submit(30); action='insert'; await submit(31);
  assert.equal(confirms,previousConfirms); assert.equal(calls.filter(c=>c.path.endsWith('/mutate')).length,3);
  action='delete'; await submit(32); assert.equal(messages.at(-1).ok,true); assert.equal(confirms,previousConfirms);
  canWrite=false; action='update'; await submit(33); assert.equal(messages.at(-1).ok,false);
  await receive({source:frame.contentWindow,data:{type:'openclawx.app.access',id:34,operationId:''}}); assert.equal(messages.at(-1).data.canWrite,false);
  assert.equal(calls.filter(c=>c.path.endsWith('/mutate')).length,4);
  let release!: () => void; holdRead = new Promise<void>(resolve => { release = resolve; });
  const reads = Array.from({length:4}, (_,i) => receive({source:frame.contentWindow,data:{type:'openclawx.app.query',id:20+i,operationId:'edit'}}));
  await receive({source:frame.contentWindow,data:{type:'openclawx.app.query',id:24,operationId:'edit'}});
  assert.equal(messages.at(-1).code,'APP_BRIDGE_BUSY'); release(); await Promise.all(reads);
  nodes.get('#logout').onclick();
  const count=calls.length; await receive({source:frame.contentWindow,data:{type:'openclawx.app.query',id:4,operationId:'edit'}});assert.equal(calls.length,count);
});
