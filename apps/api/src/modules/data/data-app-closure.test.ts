import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { createSkillExecutionTools } from '@openclawx/agent-core';
import { dataAppDeliverySchema } from '@openclawx/contracts';
import { dataRoutes, publicDataAppRoutes } from './routes.js';

test('DAC-R1–R4: real workspace tools bind, export and iterate an isolated data application', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-data-app-closure-'));
  const keys = ['OPENCLAWX_DATA_DIR', 'OPENCLAWX_API_ORIGIN', 'OPENCLAWX_WORKSPACES_DIR', 'OPENCLAWX_ASSET_STAGING_DIR'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.OPENCLAWX_DATA_DIR = root;
  process.env.OPENCLAWX_WORKSPACES_DIR = path.join(root, 'runs');
  process.env.OPENCLAWX_ASSET_STAGING_DIR = path.join(root, 'runs');
  const app = Fastify();
  app.addHook('preHandler', async request => {
    request.auth = { userId: String(request.headers['x-test-user'] || 'acceptance'), orgId: 'test-org', username: 'acceptance', displayName: 'acceptance', role: 'admin', sessionId: 'test' };
  });
  await app.register(dataRoutes, { prefix: '/api' });
  await app.register(publicDataAppRoutes, { prefix: '/api' });
  const origin = await app.listen({ host: '127.0.0.1', port: process.env.OPENCLAWX_DATA_APP_PREVIEW ? 47965 : 0 });
  process.env.OPENCLAWX_API_ORIGIN = origin;
  const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => {
    const response = await app.inject({ method, url: `/api${url}`, payload });
    assert.ok(response.statusCode < 300, `${method} ${url}: ${response.statusCode} ${response.body}`);
    return response.json();
  };
  const tools = createSkillExecutionTools({ skills: [], runId: 'acceptance', workspaceAccess: 'write' });
  const invoke = async (name: string, params: object) => {
    const tool = tools.find(item => item.name === name);
    assert.ok(tool, `${name} must be an actual exposed tool`);
    return (await tool.execute('acceptance-call', params)).details as { ok: boolean; error?: string };
  };
  try {
    const source = await call('POST', '/data/import', { name: 'acceptance-orders.json', contentBase64: Buffer.from(JSON.stringify([{ city: '上海', amount: 120 }, { city: '北京', amount: 80 }])).toString('base64') });
    const table = source.tables[0];
    await call('PATCH', `/data/sources/${source.id}/annotations`, { description: '已支付订单金额，不含退款' });
    table.description = '测试销售记录'; table.columns[1].description = '实付金额'; table.columns[1].unit = '元';
    await call('PATCH', `/data/sources/${source.id}/tables/${table.id}/schema`, table);
    const input = { sourceId: source.id, tableId: table.id, idea: '城市销售查询', name: '数据应用闭环验收' };
    const template = await call('POST', '/data/apps', input);
    assert.equal(template.delivery.status, 'template-ready');
    const draft = await call('POST', '/data/apps/customize', input);
    assert.equal(dataAppDeliverySchema.parse(draft.app.delivery).status, 'awaiting-binding');
    assert.ok(draft.prompt.includes('已支付订单金额，不含退款') && draft.prompt.includes('实付金额'));
    const id = draft.app.id, token = draft.token;
    const site = `/api/data-apps/${id}/site?token=${token}`;
    const readSite = async () => {
      const response = await fetch(`${origin}${site}`);
      const body = await response.text();
      assert.equal(response.status, 200, body.slice(0, 300));
      return body;
    };
    assert.ok((await readSite()).includes('定制应用尚未交付'));
    const retry = await call('POST', `/data/apps/${id}/optimize`, { idea: '继续创建销售查询' });
    assert.ok(!retry.prompt.includes('首先调用 export_data_app_custom_site') && retry.prompt.includes(id));
    // This deterministic HTML exercises delivery and runtime data access, NOT model quality.
    const html = (version: string) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>数据应用闭环验收</title><style>body{font:16px system-ui;background:#f5f7fb;color:#202536;margin:0}main{max-width:720px;margin:7vh auto;padding:32px;background:white;border-radius:20px}input,button{padding:10px;border-radius:8px;border:1px solid #dce1eb}li{padding:15px;border-bottom:1px solid #eee}#status{color:#526079}</style><main><small>OPENCLAWX · ISOLATED ACCEPTANCE</small><h1>销售查询 · ${version}</h1><p>合成测试数据，实际通过本机 API 取数</p><input id="search" aria-label="搜索城市" placeholder="搜索城市"><button id="refresh">查询</button><p id="status" role="status">加载中…</p><ul id="rows"></ul></main><script>async function load(){try{document.querySelector('#status').textContent='加载中…';const token=new URLSearchParams(location.search).get('token');const response=await fetch('/api/data-apps/${id}/data?token='+encodeURIComponent(token)+'&search='+encodeURIComponent(document.querySelector('#search').value));if(!response.ok)throw Error('取数失败，请检查链接权限');const data=await response.json();const list=document.querySelector('#rows');list.replaceChildren();for(const row of data.records){const li=document.createElement('li');li.textContent=Object.values(row.values).join(' · ');list.append(li)}document.querySelector('#status').textContent=data.records.length?'已加载 '+data.records.length+' 条记录':'没有匹配记录'}catch(e){document.querySelector('#status').textContent=e.message}}document.querySelector('#refresh').onclick=load;load();</script></html>`;
    assert.equal((await invoke('write_workspace_file', { path: 'output/index.html', content: html('V1') })).ok, true);
    assert.equal((await invoke('bind_data_app_custom_site', { appId: id, token, path: 'output/index.html' })).ok, true);
    const listed = (await call('GET', `/data/apps?sourceId=${source.id}`)).find((item: { id: string }) => item.id === id);
    assert.equal(listed.delivery.status, 'custom-ready'); assert.equal(listed.customSite.bound, true);
    assert.ok((await readSite()).includes('销售查询 · V1'));
    const data = await call('GET', `/data-apps/${id}/data?token=${token}`);
    const gateway = await call('GET', `/data/gateway/query?sourceId=${source.id}&tableId=${table.id}`);
    assert.equal(data.records.length, 2); assert.equal(gateway.rows.length, 2);
    assert.equal((await call('GET', `/data-apps/${id}/data?token=${token}&search=${encodeURIComponent('上海')}`)).records.length, 1);
    assert.equal((await app.inject({ method: 'GET', url: `/api/data/apps/${id}`, headers: { 'x-test-user': 'other' } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: `/api/data-apps/${id}/data?token=invalid`, remoteAddress: '192.0.2.10' })).statusCode, 404);
    table.columns[1].description = '更新后的金额口径';
    await call('PATCH', `/data/sources/${source.id}/tables/${table.id}/schema`, table);
    const optimized = await call('POST', `/data/apps/${id}/optimize`, { idea: '显示金额单位' });
    assert.equal(optimized.appId, id); assert.ok(optimized.prompt.includes('更新后的金额口径'));
    assert.ok(optimized.prompt.includes('export_data_app_custom_site') && optimized.prompt.includes(token));
    assert.equal((await invoke('export_data_app_custom_site', { appId: id, token, path: 'output/current.html' })).ok, true);
    assert.ok(fs.readFileSync(path.join(root, 'runs/acceptance/output/current.html'), 'utf8').includes('销售查询 · V1'));
    assert.equal((await invoke('bind_data_app_custom_site', { appId: id, token, path: 'output/missing.html' })).ok, false);
    assert.ok((await readSite()).includes('销售查询 · V1'));
    assert.equal((await invoke('write_workspace_file', { path: 'output/index.html', content: html('V2 · 单位：元') })).ok, true);
    assert.equal((await invoke('bind_data_app_custom_site', { appId: id, token, path: 'output/index.html' })).ok, true);
    assert.equal((await call('GET', `/data/apps/${id}/revisions`)).length, 2);
    assert.ok((await readSite()).includes('V2 · 单位：元'));
    if (process.env.OPENCLAWX_DATA_APP_PREVIEW) {
      console.log(`Isolated acceptance page: ${origin}${site}`);
      await new Promise<void>(resolve => process.once('SIGINT', resolve));
    }
  } finally {
    await app.close();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
