import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(project, 'apps/desktop');
const root = mkdtempSync(path.join(os.tmpdir(), 'openclawx-packaged-data-'));
const stage = path.join(root, 'stage');
let apiChild;
const run = (command, args, env = process.env, cwd = desktop) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Acceptance command exited ${code}`)));
});
const require = createRequire(path.join(desktop, 'package.json'));
try {
  await run(process.execPath, [path.join(desktop, 'scripts/stage.mjs')], { ...process.env, OPENCLAWX_STAGE_DIR: stage });
  // Prove the safety guard leaves an existing acceptance directory intact.
  const guarded = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(desktop, 'scripts/stage.mjs')], { cwd: desktop, env: { ...process.env, OPENCLAWX_STAGE_DIR: stage }, stdio: 'ignore' });
    child.once('exit', resolve);
  });
  assert.notEqual(guarded, 0);
  assert.ok(existsSync(path.join(stage, 'api/main.cjs')));
  const dependencies = path.join(stage, 'api/node_deps');
  await run(process.execPath, ['-e', "require('mysql2/promise'); require('pg'); require('sql.js/dist/sql-wasm.js'); console.log('Packaged database dependencies load successfully')"], { ...process.env, NODE_PATH: dependencies }, root);

  const clone = path.join(root, 'desktop');
  cpSync(path.join(desktop, 'src'), path.join(clone, 'src'), { recursive: true });
  cpSync(path.join(desktop, 'build'), path.join(clone, 'build'), { recursive: true });
  cpSync(path.join(stage, 'renderer'), path.join(clone, 'stage/renderer'), { recursive: true });
  cpSync(path.join(stage, 'sqljs'), path.join(clone, 'stage/sqljs'), { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  const build = { ...manifest.build, directories: { app: clone, output: path.join(root, 'release'), buildResources: path.join(clone, 'build') },
    electronVersion: JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8')).version,
    npmRebuild: false, extraResources: [{ from: path.join(stage, 'api'), to: 'api' }, { from: path.join(stage, 'agentscope-runtime'), to: 'agentscope-runtime' }] };
  writeFileSync(path.join(clone, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, description: manifest.description, main: manifest.main, author: 'OpenClawX' }));
  const config = path.join(root, 'builder.json');
  writeFileSync(config, JSON.stringify(build));
  await run(process.execPath, [require.resolve('electron-builder/cli.js'), '--dir', '--config', config, '--publish', 'never'], { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  assert.equal(process.platform, 'darwin', 'This unpacked desktop smoke currently targets macOS only.');
  const macDir = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  const appRoot = path.join(root, 'release', macDir, 'OpenClawX.app/Contents');
  const apiRoot = path.join(appRoot, 'Resources/api');
  const binary = path.join(appRoot, 'MacOS/OpenClawX');
  assert.ok(existsSync(binary) && existsSync(path.join(apiRoot, 'main.cjs')));
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}/api`;
  let output = '';
  apiChild = spawn(binary, [path.join(apiRoot, 'main.cjs')], { cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OPENCLAWX_DATA_DIR: path.join(root, 'data'), OPENCLAWX_API_PORT: String(port), OPENCLAWX_API_HOST: '127.0.0.1', OPENCLAWX_AGENT_ENGINE: 'pi', OPENCLAWX_AGENTSCOPE_ENABLED: '0', OPENCLAWX_MOBILE_HTTPS_ENABLED: '0', NODE_PATH: path.join(apiRoot, 'node_deps') }, stdio: ['ignore', 'pipe', 'pipe'] });
  apiChild.stdout.on('data', chunk => { output = (output + chunk).slice(-12000); });
  apiChild.stderr.on('data', chunk => { output = (output + chunk).slice(-12000); });
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    if (attempt > 100 || apiChild.exitCode !== null) throw new Error(`Packaged API failed to start: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  let session = '';
  const json = async (url, method = 'GET', body) => {
    const response = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(session ? { 'x-openclawx-session': session } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    assert.ok(response.ok, `${url}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  };
  const auth = await json('/auth/bootstrap', 'POST', { username: 'package-test', displayName: '验收用户', password: 'temporary-acceptance-only-1009' });
  session = auth.token;
  assert.ok(session);
  const source = await json('/data/import', 'POST', { name: 'orders.json', contentBase64: Buffer.from(JSON.stringify([{ city: '上海', amount: 120 }])).toString('base64') });
  await json(`/data/sources/${source.id}/annotations`, 'PATCH', { description: '打包验收合成订单' });
  const draft = await json('/data/apps/customize', 'POST', { sourceId: source.id, tableId: source.tables[0].id, name: '打包数据应用验收', idea: '查询订单' });
  assert.equal(draft.app.delivery.status, 'awaiting-binding');
  assert.ok(draft.prompt.includes('打包验收合成订单'));
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>打包验收</title><main>已绑定测试页</main></html>';
  await json(`/data/apps/${draft.app.id}/custom-site`, 'PUT', { html });
  assert.equal((await json(`/data/apps?sourceId=${source.id}`))[0].delivery.status, 'custom-ready');
  assert.equal((await json(`/data-apps/${draft.app.id}/data?token=${draft.token}`)).records.length, 1);
  const site = await fetch(`${base}/data-apps/${draft.app.id}/site?token=${draft.token}`);
  assert.ok((await site.text()).includes('已绑定测试页'));
  const optimize = await json(`/data/apps/${draft.app.id}/optimize`, 'POST', { idea: '增加城市筛选' });
  assert.equal(optimize.appId, draft.app.id);
  assert.ok(optimize.prompt.includes('export_data_app_custom_site'));
  console.log('DAC-R5 PASS: unpacked app resources, Electron Node API startup, login, import, annotations, bind, data access and optimize. No model called; no main window launched.');
} finally {
  if (apiChild && apiChild.exitCode === null) {
    const exited = new Promise(resolve => apiChild.once('exit', resolve));
    apiChild.kill('SIGTERM');
    const timer = setTimeout(() => apiChild.kill('SIGKILL'), 5000);
    await exited; clearTimeout(timer);
  }
  rmSync(root, { recursive: true, force: true });
  console.log('Removed only this run’s temporary package, staged resources and synthetic data.');
}
