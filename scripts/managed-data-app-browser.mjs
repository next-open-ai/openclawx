// Deterministic browser acceptance for the trusted credential host + opaque-origin page SDK.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createServer } from 'node:http';
const require = createRequire(new URL('../apps/renderer/package.json', import.meta.url));
const ts = require('typescript');
const exports = {};
const deliveryExports = {};
const transpile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(transpile('../apps/api/src/modules/data/app-delivery-prompt.ts'), {exports:deliveryExports});
vm.runInNewContext(transpile('../apps/api/src/modules/data/app-query-page.ts'), {exports,require:specifier=>{assert.equal(specifier,'./app-delivery-prompt.js');return deliveryExports;}});
const { chromium } = createRequire(import.meta.url)(process.env.WORKMATE_PLAYWRIGHT_MODULE || 'playwright');
let queries = 0;
const pageHtml = exports.managedAppPage('synthetic-app', `<main style="max-width:700px;margin:40px auto;font:16px system-ui"><h1>经营分析</h1><p>数据由受控查询加载</p><strong id="total">加载中</strong><button id="retry">刷新</button><script>async function load(){try{const r=await workmateData.query('total',{});document.querySelector('#total').textContent='收入合计 '+r.rows[0].total}catch(e){document.querySelector('#total').textContent=e.message}}document.querySelector('#retry').onclick=load;load();</script></main>`);
const server = createServer(async (request, response) => {
  let raw = ''; for await (const part of request) raw += part;
  const json = (code, value) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (request.url === '/api/auth/login') return json(200, { token: JSON.parse(raw).username === 'owner' ? 'synthetic-private-session' : 'wrong-session' });
  if (request.url?.startsWith('/api/data/apps/')) {
    if (request.headers['x-workmate-session'] !== 'synthetic-private-session') return json(404, { message: '无权访问' });
    if (request.url.endsWith('/operations')) return json(200, { operations: [{ operationId: 'total' }] });
    queries++; assert.deepEqual(JSON.parse(raw), { operationId: 'total', parameters: {} });
    return queries === 2 ? json(502, { message: '数据库连接不可用，请重试' }) : json(200, { rows: [{ total: 30 }], hasMore: false });
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(pageHtml);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: process.env.WORKMATE_BROWSER_CHANNEL || 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByLabel('账号').fill('other'); await page.getByLabel('密码').fill('synthetic'); await page.getByRole('button', { name: '登录并打开' }).click();
  await page.getByRole('alert').filter({ hasText: '无权访问' }).waitFor(); assert.equal(queries, 0);
  await page.getByLabel('账号').fill('owner'); await page.getByRole('button', { name: '登录并打开' }).click();
  const frame = page.frameLocator('#app'); await frame.getByText('收入合计 30').waitFor();
  assert.equal(await page.locator('#password').inputValue(), '');
  const inner = page.frames().find(f => f !== page.mainFrame());
  assert.equal(await inner.evaluate(() => { try { return parent.document.body.textContent; } catch { return 'denied'; } }), 'denied');
  assert.equal(await inner.evaluate(() => { try { return localStorage.length; } catch { return 'denied'; } }), 'denied');
  assert.equal(await inner.evaluate(() => fetch('/api/auth/login').then(() => 'bad', () => 'blocked')), 'blocked');
  await frame.getByRole('button', { name: '刷新' }).click(); await frame.getByText('数据库连接不可用，请重试').waitFor();
  await frame.getByRole('button', { name: '刷新' }).click(); await frame.getByText('收入合计 30').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: '退出数据应用' }).click(); await page.getByRole('button', { name: '登录并打开' }).waitFor();
  assert.deepEqual(errors, []); assert.equal(queries, 3);
  console.log('MDA browser: owner login, unauthorized account, sandbox credential isolation, query/error/retry, mobile layout and logout passed.');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
