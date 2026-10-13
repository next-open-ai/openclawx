// Isolated browser fixture: real Vue components, in-memory synthetic data only.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
const vueRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vue/package.json'));
const viteRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vite/package.json'));
const { parse, compileScript, compileStyle } = vueRequire('@vue/compiler-sfc');
const { build } = viteRequire('esbuild');
const employeePreview = process.env.WORKMATE_DATA_PREVIEW_EMPLOYEE === '1';
const bundle = await build({
  bundle: true, write: false, platform: 'browser', format: 'esm',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  stdin: { loader: 'js', resolveDir: process.cwd(), contents: employeePreview ? `
    import {createApp,ref} from 'vue'; import Picker from './apps/renderer/src/features/employees/EmployeeDataObjects.vue';
    const mode = value => fetch('/api/data/fixture-mode',{method:'POST',body:JSON.stringify({mode:value})});
    createApp({components:{Picker},setup:()=>({engine:ref('pi'),setError:()=>mode('error'),setEmpty:()=>mode('empty'),setNormal:()=>mode('normal')}),template:'<main style="max-width:850px;margin:32px auto;padding:20px"><h1 style="margin-bottom:20px">员工问数配置 · 隔离界面验收</h1><label>引擎 <select v-model="engine"><option value="pi">Pi</option><option value="dsh">DSH</option></select></label><Picker employee-id="general" :engine="engine" /><p role="status">本页仅使用内存模拟接口，不保存实际员工</p><button @click="setError">模拟读取失败</button><button @click="setEmpty">模拟空列表</button><button @click="setNormal">恢复列表</button></main>'}).mount('#app');
  ` : `import {createApp} from 'vue'; import Page from './apps/renderer/src/features/data/DataWorkbenchPage.vue'; createApp(Page,{employeeId:'general',onOpenProject:()=>console.info('FIXTURE: received project navigation event; no model called')}).mount('#app');` },
  plugins: [{ name: 'data-object-fixture', setup(builder) {
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: vueRequire.resolve('vue/dist/vue.esm-bundler.js') }));
    builder.onResolve({ filter: /^@workmate\/contracts$/ }, () => ({ path: path.resolve('packages/contracts/dist/index.js') }));
    builder.onLoad({ filter: /\.vue$/ }, args => {
      const { descriptor } = parse(fs.readFileSync(args.path, 'utf8'), { filename: args.path });
      const id = createHash('sha256').update(args.path).digest('hex').slice(0, 8);
      const scoped = descriptor.styles.some(block => block.scoped);
      const style = descriptor.styles.map(block => compileStyle({ source: block.content, filename: args.path, id: `data-v-${id}`, scoped: block.scoped }).code).join('\n');
      const styleScript = style ? `\n{ const style = document.createElement('style'); style.textContent = ${JSON.stringify(style)}; document.head.appendChild(style); }` : '';
      const script = compileScript(descriptor, { id, inlineTemplate: true, genDefaultAs: '__fixtureComponent', templateOptions: { scoped } }).content;
      return { contents: script + (scoped ? `\n__fixtureComponent.__scopeId = 'data-v-${id}';` : '') + '\nexport default __fixtureComponent;' + styleScript, loader: 'ts', resolveDir: path.dirname(args.path) };
    });
  } }],
});
const source = {
  id: 'demo-orders', name: '订单业务接口（模拟数据）', fileType: 'API', assetId: '',
  tableCount: 1, rowCount: 2, createdAt: Date.now(), summary: '仅供界面验收，不访问外部接口。',
  annotations: { description: '用于分析已支付订单的销售额，不含退款金额。', connectionDescription: '电商业务系统；每天显式同步一次。此处为模拟数据。', apiUrlDescription: '订单列表查询接口，支持按日期分页。', apiFields: [{ path: 'page', location: 'query', type: 'integer', required: false, description: '页码，从 1 开始' }, { path: 'data.items[].amount', location: 'response', type: 'number', required: true, description: '实付金额，人民币元' }] },
  tables: [{ id: 'demo-table', name: '订单明细', sheetName: 'records', rowCount: 2, description: '每行代表一个已支付订单。', columns: [{ id: 'c_1', sourceName: 'id', name: '订单编号', type: '文本', nullable: false, sample: 'DEMO-001', description: '唯一订单标识' }, { id: 'c_2', sourceName: 'amount', name: '实付金额', type: '小数', nullable: false, sample: '128.50', description: '优惠后的实付金额，不含退款', unit: '元' }] }],
  api: { baseUrl: 'https://example.invalid', path: '/orders', method: 'GET', authType: 'none', authHeaderName: '', hasToken: false, headers: {}, itemsPath: 'data.items', description: '订单业务接口', requestBody: '', responseBody: '', lastSyncedAt: Date.now(), lastStatus: 'ok', lastError: '' },
};
const cssDir = 'apps/renderer/dist/assets';
const cssFile = fs.readdirSync(cssDir).find(name => name.endsWith('.css') && name.startsWith('index-'));
const css = fs.readFileSync(path.join(cssDir, cssFile), 'utf8');
const apps = [
  { id: 'pending-demo', name: '订单查询应用（待交付示例）', appType: '查询网站', delivery: { mode: 'custom', status: 'awaiting-binding' }, customSite: { bound: false }, publishUrl: 'http://127.0.0.1:47849/pending-demo' },
  { id: 'ready-demo', name: '销售看板（可用示例）', appType: '数据看板', delivery: { mode: 'custom', status: 'custom-ready' }, customSite: { bound: true }, publishUrl: 'http://127.0.0.1:47849/ready-demo' },
];
let failCreate = process.env.WORKMATE_DATA_PREVIEW_FAILURE === 'create-and-refresh';
let failRefresh = false;
let creations = 0;
let employeeListMode = 'normal';
let employeeBindings = [];
// Second table makes table choice observable without touching business data.
source.tables.push({ ...source.tables[0], id: 'demo-customers', name: '客户信息', rowCount: 1 });
source.tableCount = 2;
const livePreview = process.env.WORKMATE_DATA_PREVIEW_LIVE === '1';
const fixtureConnections = [{ id: 'synthetic-connection', name: '演示连接（仅模拟）', engine: 'mysql', host: 'example.invalid', port: 3306, user: 'reader', tls: true, ca: '', database: '', credentialPersistence: 'session' }];
let liveRows = [{ id: 'synthetic-row', values: { c_1: 'DEMO-001', c_2: '128.50' } }];
const server = createServer(async (request, reply) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const json = value => { reply.setHeader('content-type', 'application/json'); reply.end(JSON.stringify(value)); };
  if (url.pathname.startsWith('/api/')) {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = body ? JSON.parse(body) : {};
    if (employeePreview && url.pathname === '/api/data/fixture-mode') { employeeListMode = payload.mode; return json({ ok: true }); }
    if (employeePreview && url.pathname === '/api/data/agent-associations/general') {
      if (request.method === 'PUT') {
        if (employeeListMode === 'error') { reply.statusCode = 503; return json({ message: '模拟保存失败，请重试。' }); }
        employeeBindings = payload.dataSourceIds;
      }
      return json({ dataSourceIds: employeeBindings });
    }
    if (employeePreview && url.pathname === '/api/data/sources') {
      if (employeeListMode === 'error') { reply.statusCode = 503; return json({ message: 'synthetic unavailable' }); }
      return json(employeeListMode === 'empty' ? [] : [source, { ...source, id: 'demo-live', name: '经营分析 · 实时数据库（模拟）', fileType: 'MySQL', accessMode: 'live' }]);
    }
    if (url.pathname === '/api/data/gateway/query' && request.method === 'POST') {
      // UI-only synthetic response; database compiler correctness lives in API tests.
      if ((JSON.stringify(payload.filters) || '').includes('模拟失败')) { reply.statusCode = 400; return json({ message: '模拟查询失败：请调整筛选条件后重试。' }); }
      const table = source.tables.find(t => t.id === payload.tableId) || source.tables[0];
      const data = [{ c_1: 'DEMO-001', c_2: 128.50 }, { c_1: 'DEMO-002', c_2: 86.00 }];
      const matches = (row, node) => !node ? true : node.logic ? node.logic === 'and' ? node.conditions.every(n => matches(row, n)) : node.conditions.some(n => matches(row, n)) : node.operator === 'eq' ? String(row[node.fieldId]) === String(node.value) : node.operator === 'gt' ? Number(row[node.fieldId]) > Number(node.value) : node.operator === 'contains' ? String(row[node.fieldId]).includes(node.value) : true;
      let rows = data.filter(r => matches(r, payload.filters));
      let fields = (payload.fields || table.columns.map(c => c.id)).map(id => ({ ...table.columns.find(c => c.id === id) }));
      if (payload.metrics?.length) {
        fields = [...(payload.dimensions || []).map(d => ({ ...table.columns.find(c => c.id === d.fieldId) })), ...payload.metrics.map(m => ({ id: m.alias, name: m.alias, type: '小数' }))];
        const aggregate = entries => Object.fromEntries(payload.metrics.map(m => {
          const values = entries.map(r => r[m.fieldId]);
          const sum = values.reduce((n, v) => n + Number(v || 0), 0);
          return [m.alias, m.operation === 'count' ? entries.length : m.operation === 'sum' ? sum : m.operation === 'avg' ? sum / entries.length : m.operation === 'countDistinct' ? new Set(values).size : m.operation === 'min' ? Math.min(...values) : Math.max(...values)];
        }));
        rows = payload.dimensions?.length ? rows.map(r => ({ [payload.dimensions[0].fieldId]: r[payload.dimensions[0].fieldId], ...aggregate([r]) })) : [aggregate(rows)];
      }
      if (payload.orderBy?.length) { const o = payload.orderBy[0]; rows.sort((a, b) => (a[o.fieldId] > b[o.fieldId] ? 1 : a[o.fieldId] < b[o.fieldId] ? -1 : 0) * (o.direction === 'desc' ? -1 : 1)); }
      const limit = payload.limit || 50, offset = payload.offset || 0, hasMore = rows.length > offset + limit;
      return json({ queryId: 'synthetic-query', sourceId: source.id, tableId: table.id, storageMode: source.accessMode === 'live' ? 'live' : 'snapshot', queriedAt: new Date().toISOString(), fields, rows: rows.slice(offset, offset + limit), limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null });
    }
    if (livePreview) {
      if (url.pathname === '/api/data/connections') {
        if (request.method === 'POST') { const { password: _password, ...connection } = payload.connection; fixtureConnections.push({ ...connection, id: 'synthetic-new', name: payload.name, credentialPersistence: 'session' }); return json(fixtureConnections.at(-1)); }
        return json({ connections: fixtureConnections });
      }
      if (/\/connections\/[^/]+\/inspect$/.test(url.pathname)) return json({ databases: ['business_demo'], tables: url.searchParams.get('database') ? [{ schema: 'business_demo', name: 'orders', description: '演示订单 · 无真实数据库' }] : [] });
      if (url.pathname === '/api/data/sources/live') {
        apps.length = 0;
        source.name = payload.name; source.fileType = 'MySQL'; source.accessMode = 'live'; delete source.api;
        source.annotations.apiFields = []; source.annotations.apiUrlDescription = '';
        source.liveConnection = { connectionId: payload.connectionId, database: payload.database, writeEnabled: false, tables: source.tables.map(t => ({ tableId: t.id, writable: true, columns: t.columns.map((c, i) => ({ id: c.id, primary: i === 0, generated: false, nullable: c.nullable, defaulted: false })) })) };
        return json(source);
      }
      if (url.pathname.endsWith('/access')) { source.liveConnection.writeEnabled = payload.writeEnabled; return json(source); }
      if (url.pathname === '/api/data/gateway/records') {
        if (request.method === 'GET') return json({ rows: liveRows, hasMore: false });
        if (request.method === 'POST') liveRows.push({ id: 'synthetic-row-2', values: payload.fields });
        if (request.method === 'PATCH') liveRows = liveRows.map(r => r.id === payload.recordId ? { ...r, values: { ...r.values, ...payload.fields } } : r);
        if (request.method === 'DELETE') liveRows = liveRows.filter(r => r.id !== payload.recordId);
        return json({ ok: true });
      }
    }
    if (url.pathname === '/api/data/databases/inspect') return json({ databases: ['business_demo'], tables: payload.database ? [{ schema: payload.engine === 'mysql' ? 'business_demo' : 'public', name: 'orders', description: '已支付订单，用于统计销售金额（模拟）' }, { schema: payload.engine === 'mysql' ? 'business_demo' : 'public', name: 'customers', description: '客户基础信息（模拟）' }] : [] });
    if (url.pathname === '/api/data/sources/database') {
      source.fileType = payload.connection.engine === 'mysql' ? 'MySQL' : 'PostgreSQL'; source.name = payload.name;
      const { password: _password, ...connection } = payload.connection;
      source.databaseConnection = { ...connection, tables: payload.tables, lastSyncedAt: Date.now(), truncatedTables: [] };
      delete source.api; source.annotations.apiFields = []; source.annotations.apiUrlDescription = '';
      return json(source);
    }
    if (request.method === 'PATCH' && url.pathname.endsWith('/annotations')) { source.annotations = payload; return json(source); }
    if (request.method === 'PATCH' && url.pathname.endsWith('/schema')) { source.tables[0] = { ...source.tables[0], ...payload }; return json(source); }
    if (url.pathname === '/api/data/sources') return json([source]);
    if (url.pathname === '/api/data/gateway/schema') return json({ id: source.id, name: source.name, kind: source.fileType, annotations: source.annotations, resources: source.tables.map(({ rowCount: _count, ...table }) => ({ ...table, columns: table.columns.map(({ sample: _sample, ...column }) => column) })), operations: ['query', 'options'] });
    if (url.pathname.endsWith('/rows')) return json({ columns: source.tables[0].columns.map(column => column.name), rows: [['DEMO-001', '128.50'], ['DEMO-002', '86.00']] });
    if (url.pathname === '/api/data/apps/project-create') {
      if (failCreate) { failCreate = false; reply.statusCode = 503; return json({ message: '模拟创建失败，请重试；输入内容应保留。' }); }
      const app = { ...apps[0], id: `created-demo-${++creations}`, name: payload.name, appType: '自定义应用', projectId: 'synthetic-project' };
      apps.push(app); failRefresh = process.env.WORKMATE_DATA_PREVIEW_FAILURE === 'create-and-refresh';
      console.log(`FIXTURE: creation ${creations}, table ${payload.tableId}`);
      return json({ app, appId: app.id, projectId: app.projectId, started: true });
    }
    if (url.pathname === '/api/data/apps') {
      if (failRefresh) { failRefresh = false; reply.statusCode = 503; return json({ message: '模拟列表刷新失败' }); }
      return json(apps);
    }
    if (url.pathname === `/api/data/sources/${source.id}`) return json(source);
    reply.statusCode = 400; return json({ message: '模拟页面不执行此操作；请在真实应用中使用。' });
  }
  if (url.pathname === '/bundle.js') { reply.setHeader('content-type', 'text/javascript'); reply.end(bundle.outputFiles[0].text); }
  else if (url.pathname === '/style.css') { reply.setHeader('content-type', 'text/css'); reply.end(css); }
  else { reply.setHeader('content-type', 'text/html'); reply.end('<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workmate 数据对象界面验收（模拟）</title><link rel="stylesheet" href="/style.css"><style>html,body,#app{height:100dvh;margin:0}</style><body><div id="app"></div><script type="module" src="/bundle.js"></script></body></html>'); }
});
server.listen(47849, '127.0.0.1', () => console.log('Isolated data fixture: http://127.0.0.1:47849'));
process.on('SIGINT', () => server.close(() => process.exit(0)));
