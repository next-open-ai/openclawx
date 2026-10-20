// Real Vue/Fastify + durable ProjectService/RunEngine turns. Synthetic runner, temporary files only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
const apiRequire = createRequire(path.resolve('apps/api/package.json'));
const vueRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vue/package.json'));
const viteRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vite/package.json'));
const { build } = viteRequire('esbuild');
const { parse, compileScript } = vueRequire('@vue/compiler-sfc');
const { Orchestrator } = apiRequire('@openclawx/orchestrator');
const Fastify = apiRequire('fastify');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-application-browser-'));
const savedData = process.env.OPENCLAWX_DATA_DIR, savedRuns = process.env.OPENCLAWX_WORKSPACES_DIR;
process.env.OPENCLAWX_DATA_DIR = root; process.env.OPENCLAWX_WORKSPACES_DIR = path.join(root, 'runs');
const compiled = await build({ entryPoints: ['apps/api/src/modules/orchestration/project-application-routes.ts'], bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false });
const bridge = new Module(path.resolve('apps/api/application-fixture.cjs'));
bridge.filename = path.resolve('apps/api/application-fixture.cjs'); bridge.paths = apiRequire.resolve.paths('fastify');
bridge._compile(compiled.outputFiles[0].text, bridge.filename);
const { registerProjectApplicationRoutes, projectSiteRoutes } = bridge.exports;
const { descriptor } = parse(fs.readFileSync('apps/renderer/src/features/projects/ProjectApplicationButton.vue', 'utf8'));
const component = compileScript(descriptor, { id: 'application-fixture', inlineTemplate: true });
const browserBundle = await build({ bundle: true, write: false, platform: 'browser', format: 'esm',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  stdin: { loader: 'ts', resolveDir: path.resolve('apps/renderer/src/features/projects'), contents: component.content.replace('export default', 'const Component =') + `;import {createApp} from 'vue';const mode=new URLSearchParams(location.search);createApp(Component,{projectId:'fixture',projectName:'经营分析应用',running:mode.has('running'),canWrite:!mode.has('readonly')}).mount('#app');` },
  plugins: [{ name: 'fixture', setup(builder) { builder.onResolve({ filter: /^vue$/ }, () => ({ path: vueRequire.resolve('vue/dist/vue.esm-bundler.js') })); } }],
});
const cssDirectory = 'apps/renderer/dist/assets';
const css = fs.readFileSync(path.join(cssDirectory, fs.readdirSync(cssDirectory).find(name => name.startsWith('index-') && name.endsWith('.css'))), 'utf8');
const workspace = path.join(root, 'project'); fs.mkdirSync(path.join(workspace, 'assets'), { recursive: true });
const writeSite = (directory, version) => {
  fs.mkdirSync(path.join(directory, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'index.html'), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="assets/site.css"><script type="module" src="assets/site.js"></script><h1>经营分析 · ${version}</h1><button id="counter">已处理 0 项</button><p id="isolation"></p><p id="network"></p>`);
  fs.writeFileSync(path.join(directory, 'assets/site.css'), 'body{background:#f7f9fc;padding:32px;font-family:system-ui;color:#1e293b}h1{color:rgb(30, 64, 175)}button{border:0;background:#4665df;color:white;border-radius:8px;padding:12px 20px}');
  fs.writeFileSync(path.join(directory, 'assets/site.js'), `let n=0;document.querySelector('#counter').onclick=()=>document.querySelector('#counter').textContent='已处理 '+(++n)+' 项';try{localStorage.getItem('auth.session.token');document.querySelector('#isolation').textContent='UNSAFE'}catch{document.querySelector('#isolation').textContent='隔离预览已启用'};fetch('/api/orch/projects/fixture/application').then(()=>document.querySelector('#network').textContent='UNSAFE NETWORK').catch(()=>document.querySelector('#network').textContent='网络隔离已启用');`);
};
fs.mkdirSync(path.join(workspace, 'inputs'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'inputs/reference.txt'), '经营分析参考材料（不得发布）');
const requests = [];
const versions = ['第一版', '第二版', '第三版'];
const context = { profile: { id: 'general', name: 'fixture', instructions: 'fixture', toolIds: [] }, model: { provider: 'ollama', chatModel: 'fixture', apiKey: 'fixture' }, skills: [], searchProviders: [], mcpConnections: [], knowledgeBases: [] };
const runner = { async start(request, emit) {
  const directory = path.join(root, 'runs', request.runId, 'output');
  assert.equal(request.projectWorkspacePath, undefined, 'runner cannot write directly into the fixed project directory');
  assert.equal(fs.readFileSync(path.join(root, 'runs', request.runId, 'inputs/reference.txt'), 'utf8'), '经营分析参考材料（不得发布）');
  if (requests.length) {
    assert.match(fs.readFileSync(path.join(directory, 'index.html'), 'utf8'), new RegExp(versions[requests.length - 1]));
    assert.ok(request.messages.some(message => message.role === 'assistant' && message.content.includes(versions[requests.length - 1])), 'previous real assistant reply supplied');
  }
  requests.push(request);
  const version = versions[requests.length - 1];
  writeSite(directory, version);
  emit({ type: 'message.delta', runId: request.runId, text: `已完成${version}经营分析应用。` });
  emit({ type: 'run.completed', runId: request.runId });
} };
const orch = Orchestrator.open(path.join(root, 'domain.json'), { runner, contextResolver: () => context }); const app = Fastify();
await orch.projects.createDraftOnce('fixture', { kind: 'conversation', name: '经营分析', goal: '', mode: 'dag', tasks: [], workspacePath: workspace, orgId: 'fixture', ownerUserId: 'alice', accessScope: 'org-shared' });
assert.equal(requests.length, 0, 'creation does not invoke runner');
const sendTurn = async content => {
  const before = requests.length;
  await orch.projects.dispatchInstruction('fixture', { employeeId: 'general', content });
  for (let i = 0; i < 300; i++) {
    const project = await orch.projects.getProject('fixture');
    if (project.status !== 'running') {
      assert.equal(project.status, 'completed', JSON.stringify(project.tasks));
      assert.equal(requests.length, before + 1, 'exactly one independent Run per message');
      assert.equal(project.plan, undefined);
      assert.ok(project.tasks.every(task => !task.dependsOn.length));
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Project turn did not settle within fixture deadline');
};
await sendTurn('根据材料创建经营分析网站');
let publishRequests = 0, failPublish = false, unsafeRequests = 0;
await app.register(async secured => {
  secured.addHook('preHandler', async (request, reply) => {
    if (request.headers.origin === 'null') unsafeRequests++;
    request.auth = { userId: request.headers['x-fixture-user'] || 'alice', orgId: 'fixture', role: 'member', username: 'fixture', displayName: 'fixture', sessionId: 'fixture' };
    if (request.url.endsWith('/publish')) {
      publishRequests++;
      if (failPublish) return reply.code(503).send({ message: '模拟发布失败，已发布版本保持不变。' });
    }
  });
  registerProjectApplicationRoutes(secured, orch);
}, { prefix: '/api/orch' });
await app.register(projectSiteRoutes, { prefix: '/api', orchestrator: () => orch });
app.get('/api/data/projects/:projectId/application', () => ({ appId: null, operations: [], canApprove: false }));
app.get('/bundle.js', (_, reply) => reply.type('text/javascript').send(browserBundle.outputFiles[0].text));
app.get('/style.css', (_, reply) => reply.type('text/css').send(css));
app.get('/', (_, reply) => reply.type('text/html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>:root{--background:#f7f8fc;--surface:#fff;--surface-muted:#f1f3f8;--text:#202637;--muted:#65708a;--border:#dce2ee;--accent:#4665df;--accent-soft:#eef1ff}body{margin:0;padding:32px;background:var(--background);color:var(--text);font-family:system-ui}</style><div id="app"></div><script type="module" src="/bundle.js"></script>'));
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const { chromium } = createRequire(import.meta.url)(process.env.OPENCLAWX_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.OPENCLAWX_BROWSER_CHANNEL ? { channel: process.env.OPENCLAWX_BROWSER_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.getByRole('button', { name: '预览与发布' }).click();
  const iframe = page.frameLocator('iframe');
  await iframe.getByRole('heading', { name: '经营分析 · 第一版' }).waitFor();
  await iframe.getByText('隔离预览已启用').waitFor();
  await iframe.getByText('网络隔离已启用').waitFor();
  await page.getByText('发布范围与资源清单', { exact: true }).click();
  await page.locator('li', { hasText: 'assets/site.js' }).waitFor();
  await page.getByText('发布范围与资源清单', { exact: true }).click();
  assert.equal(await iframe.locator('h1').evaluate(node => getComputedStyle(node).color), 'rgb(30, 64, 175)', 'relative CSS loaded');
  await iframe.getByRole('button', { name: '已处理 0 项' }).click(); await iframe.getByRole('button', { name: '已处理 1 项' }).waitFor();
  assert.equal(publishRequests, 0, 'preview never publishes');
  await page.getByRole('button', { name: '发布应用', exact: true }).click();
  assert.equal(publishRequests, 0, 'explicit second confirmation required');
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await page.getByText('本地发布成功。后续修改不会自动更新此版本。').waitFor();
  await iframe.getByRole('heading', { name: '经营分析 · 第一版' }).waitFor();
  await page.screenshot({ path: '/tmp/openclawx-project-application-desktop.png' });
  await sendTurn('保留内容，改进第二版');
  await page.getByRole('button', { name: '打开已发布版本', exact: true }).click();
  await iframe.getByRole('heading', { name: '经营分析 · 第一版' }).waitFor();
  await page.getByRole('button', { name: '预览最新成果', exact: true }).click();
  await iframe.getByRole('heading', { name: '经营分析 · 第二版' }).waitFor();
  failPublish = true;
  await page.getByRole('button', { name: '更新发布', exact: true }).click(); await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await page.getByRole('button', { name: '打开已发布版本', exact: true }).click();
  await iframe.getByRole('heading', { name: '经营分析 · 第一版' }).waitFor();
  failPublish = false;
  await page.getByRole('button', { name: '预览最新成果', exact: true }).click();
  await iframe.getByRole('heading', { name: '经营分析 · 第二版' }).waitFor();
  await page.getByRole('button', { name: '更新发布', exact: true }).click();
  await sendTurn('继续优化第三版');
  await page.getByRole('button', { name: '确认发布', exact: true }).click(); await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /重新预览/);
  await page.getByRole('button', { name: '预览最新成果', exact: true }).click(); await iframe.getByRole('heading', { name: '经营分析 · 第三版' }).waitFor();
  await page.getByRole('button', { name: '更新发布', exact: true }).click(); await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await page.getByText('本地发布成功。后续修改不会自动更新此版本。').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/openclawx-project-application-mobile.png' });
  await page.getByRole('button', { name: '关闭项目应用' }).click();
  await page.goto(origin + '/?readonly');
  await page.setExtraHTTPHeaders({ 'x-fixture-user': 'bob' });
  await page.getByRole('button', { name: '预览与发布' }).click(); await iframe.getByRole('heading', { name: '经营分析 · 第三版' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '更新发布', exact: true }).count(), 0);
  await page.getByRole('button', { name: '关闭项目应用' }).click();
  await page.setExtraHTTPHeaders({});
  await page.goto(origin + '/?running'); await page.getByRole('button', { name: '预览与发布' }).click();
  assert.equal(await page.getByRole('button', { name: '预览最新成果', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '打开已发布版本', exact: true }).click(); await iframe.getByRole('heading', { name: '经营分析 · 第三版' }).waitFor();
  await page.getByRole('button', { name: '关闭项目应用' }).click();
  fs.rmSync(path.join(workspace, 'index.html'));
  await page.goto(origin); await page.getByRole('button', { name: '预览与发布' }).click(); await page.getByRole('heading', { name: '还没有网站入口' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '更新发布', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '打开已发布版本', exact: true }).click(); await iframe.getByRole('heading', { name: '经营分析 · 第三版' }).waitFor();
  assert.deepEqual(errors, []);
  assert.equal(unsafeRequests, 0, 'sandboxed generated pages cannot call OpenClawX management APIs');
  assert.equal(requests.length, 3, 'creation and two modifications ran through ProjectService');
  console.log('PA-T4/T6 PASS: durable ProjectService/RunEngine creation + two modifications, real history/material seeding, actual Vue/Fastify, relative CSS/module JS, isolation, explicit confirmation, no auto-publish, failure/stale retention, update, narrow layout, read-only/running/missing-entry states. Synthetic runner; no supplier calls.');
} finally {
  await browser.close(); await app.close(); await orch.close();
  if (savedData === undefined) delete process.env.OPENCLAWX_DATA_DIR; else process.env.OPENCLAWX_DATA_DIR = savedData;
  if (savedRuns === undefined) delete process.env.OPENCLAWX_WORKSPACES_DIR; else process.env.OPENCLAWX_WORKSPACES_DIR = savedRuns;
  fs.rmSync(root, { recursive: true, force: true });
}
