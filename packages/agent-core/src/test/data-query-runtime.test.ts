import assert from 'node:assert/strict';
import test from 'node:test';
import { dataAgentToolJsonSchemas } from '@workmate/contracts';
import { createDataQueryTools, withDataQueryAccess, dataQueryInstructions } from '../data-query-runtime.js';
import type { DataQueryExecutor } from '../data-query-runtime.js';
import { prepareAgentscopeHostTools } from '../agentscope/host-tools.js';
import { extractToolDetails } from '../pi-tools.js';

test('ADQ-R2/R3: data tools opt-in, strict generated schema, cancellation and concurrent run isolation', async () => {
  assert.deepEqual(createDataQueryTools(), []);
  assert.equal(dataAgentToolJsonSchemas.data_query.additionalProperties, false);
  const invoke = async (id: string) => withDataQueryAccess(async (_name, input) => {
    await new Promise(r => setTimeout(r, id === 'a' ? 15 : 1)); return { ok: true, id, input };
  }, async () => {
    const tools = createDataQueryTools();
    assert.equal(tools.length, 3);
    assert.deepEqual(withDataQueryAccess(undefined, createDataQueryTools), []);
    const query = tools.find(t => t.name === 'data_query')!;
    const denied = extractToolDetails(await query.execute('bad', { sourceId: 's', tableId: 't', sql: 'SELECT *' })) as { code: string };
    assert.equal(denied.code, 'INVALID_QUERY');
    const controller = new AbortController(); controller.abort();
    assert.equal((extractToolDetails(await query.execute('cancel', {}, controller.signal)) as { code: string }).code, 'DATA_CANCELLED');
    return extractToolDetails(await query.execute('ok', { sourceId: 's', tableId: 't' }));
  });
  const results = await Promise.all([invoke('a'), invoke('b')]) as Array<{ id: string }>;
  assert.deepEqual(results.map(r => r.id), ['a', 'b']);
  assert.deepEqual(createDataQueryTools(), []);
});

test('ADQ-R4: AgentScope hosts the same tools without serializing identity or executor', async () => {
  const session = await withDataQueryAccess(async () => ({ ok: true, data: { objects: [] } }), () => prepareAgentscopeHostTools({ runId: 'adq-host', mcpConnections: [] }));
  const descriptors = session.runtimePatch.mcpTools ?? [];
  assert.equal(descriptors.filter(d => d.name.startsWith('data_')).length, 3);
  assert.match(session.runtimePatch.mcpInstructions ?? '', /data_get_schema/);
  const results = await session.executeHostToolCalls('adq-host', [{ id: 'call', name: 'data_list_objects', input: {} }]);
  // HostToolResult ABI uses success/error, not the Run activity completed state.
  assert.equal(results[0]?.state, 'success');
  assert.ok(!JSON.stringify(session.runtimePatch).includes('userId'));
});

test('MDA-R2/R3: application tools are host-selected and do not leak into ordinary runs', async () => {
  const executor: DataQueryExecutor = async (tool, input) => ({ ok: true, tool, input });
  executor.tools = ['data_get_schema', 'data_app_register_query', 'data_app_register_sql', 'data_app_test_query','data_app_propose_schema'];
  await withDataQueryAccess(executor, async () => {
    const tools = createDataQueryTools(); assert.equal(tools.length, 5);
    const schema=tools.find(t=>t.name==='data_app_propose_schema')!;assert.ok(schema);assert.ok(!tools.some(t=>/execute_schema/.test(t.name)));
    const sql = tools.find(t => t.name === 'data_app_register_sql')!;
    const registered = extractToolDetails(await sql.execute('sql', { kind: 'sql', operationId: 'students', description: '学生', sql: 'SELECT c_1 FROM t' })) as {ok:boolean;tool:string};
    assert.equal(registered.ok,true); assert.equal(registered.tool,'data_app_register_sql');
    assert.ok(!tools.some(t => /approve|mutate/.test(t.name)), 'model cannot approve or execute writes');
    assert.match(dataQueryInstructions(tools),/当前工具协议优先/);
    const register = tools.find(t => t.name === 'data_app_register_query')!;
    const bad = extractToolDetails(await register.execute('bad', { operationId: 'x', sql: 'SELECT *' })) as { code: string };
    assert.equal(bad.code, 'INVALID_QUERY');
    const good = extractToolDetails(await register.execute('good', { operationId: 'summary', description: '合计', query: { sourceId: 's', tableId: 't', metrics: [{ operation: 'count', alias: 'n' }] } })) as { ok: boolean; tool: string };
    assert.equal(good.ok, true); assert.equal(good.tool, 'data_app_register_query');
    const host = await prepareAgentscopeHostTools({ runId: 'managed-app-host', mcpConnections: [] });
    assert.ok(host.runtimePatch.mcpTools?.some(t => t.name === 'data_app_register_query'));
    await host.close();
  });
  assert.deepEqual(createDataQueryTools(), []);
  assert.equal(withDataQueryAccess(async () => ({}), createDataQueryTools).some(t => t.name.startsWith('data_app_')), false);
  assert.ok(!dataQueryInstructions([{name:'data_query'}]).includes('data_app_register_sql'));
});

test('MDA-T23: prompts are capability-scoped, delivery-neutral and isolated between runs', async () => {
  assert.equal(dataQueryInstructions([]), '');
  assert.equal(dataQueryInstructions([{name:'bash'},{name:'toString'}]), '');
  const ordinary = dataQueryInstructions([{name:'data_get_schema'},{name:'data_query'}]);
  assert.match(ordinary,/只读问数/);
  assert.doesNotMatch(ordinary,/data_app_|workmateData|output\/index|npm|CDN|fetch/);
  const sqlOnly = dataQueryInstructions([{name:'data_app_register_sql'}]);
  assert.match(sqlOnly,/参数化SQL/); assert.doesNotMatch(sqlOnly,/data_app_propose_schema|只读问数|InnoDB|UNION|VARCHAR|npm|CDN/);
  const schemaOnly = dataQueryInstructions([{name:'data_app_propose_schema'}]);
  assert.match(schemaOnly,/新业务表/); assert.doesNotMatch(schemaOnly,/data_app_register_sql/);
  const appExecutor: DataQueryExecutor = async () => ({}); appExecutor.tools = ['data_app_register_sql'];
  const [application, plain] = await Promise.all([
    withDataQueryAccess(appExecutor, async () => { await new Promise(r => setTimeout(r, 5)); return prepareAgentscopeHostTools({runId:'app-prompt',mcpConnections:[]}); }),
    withDataQueryAccess(undefined, () => prepareAgentscopeHostTools({runId:'plain-prompt',mcpConnections:[]})),
  ]);
  try {
    assert.match(application.runtimePatch.mcpInstructions ?? '',/data_app_register_sql/);
    assert.doesNotMatch(application.runtimePatch.mcpInstructions ?? '',/npm|output\/index|CDN/);
    assert.doesNotMatch(plain.runtimePatch.mcpInstructions ?? '',/数据访问能力|data_app_register_sql/);
    assert.ok(!plain.runtimePatch.mcpTools?.some(t => t.name.startsWith('data_')));
  } finally { await application.close(); await plain.close(); }
});

test('QA-T1: query asset tools are host-selected, save accepts receipts not SQL or authorization',async()=>{
  const executor:DataQueryExecutor=async(tool,input)=>({ok:true,tool,input});
  executor.tools=['data_list_query_assets','data_run_query_asset','data_save_query_asset'];
  await withDataQueryAccess(executor,async()=>{
    const tools=createDataQueryTools(),save=tools.find(t=>t.name==='data_save_query_asset')!;
    assert.equal(tools.length,3);
    const bad=extractToolDetails(await save.execute('bad',{name:'test',sql:'SELECT 1',confirmed:true})) as {code:string};
    assert.equal(bad.code,'INVALID_QUERY');
    assert.equal((extractToolDetails(await save.execute('good',{name:'test'})) as {ok:boolean}).ok,true);
    assert.match(dataQueryInstructions(tools),/用户明确要求/);
  });
  assert.ok(!createDataQueryTools().length);
});
