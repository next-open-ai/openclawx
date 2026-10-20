import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createPreviewServerTools,
  findFreePort,
  listPreviewServers,
  setConversationSiteBundleResolver,
  startPreviewServer,
  stopAllPreviewServers,
  stopPreviewServer,
  suggestPreviewRoot,
} from '../preview-server.js';

test('findFreePort returns a port from the hint range', async () => {
  const port = await findFreePort(8000, 8099);
  assert.ok(port >= 8000 && port <= 8099);
});

test('startPreviewServer serves index.html and reuses same root', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'openclawx-preview-'));
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>ok</title><h1>hello-preview</h1>', 'utf8');
  mkdirSync(path.join(root, 'bundle'), { recursive: true });
  writeFileSync(path.join(root, 'bundle', 'index.html'), '<!doctype html><h1>bundle</h1>', 'utf8');

  try {
    const started = await startPreviewServer({ workspaceRoot: root, root: '.', portHint: 8000 });
    assert.equal(started.ok, true);
    assert.ok(started.url.startsWith('http://127.0.0.1:'));
    assert.ok(started.port >= 8000);

    const page = await fetch(started.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /hello-preview/);

    const reused = await startPreviewServer({ workspaceRoot: root, root: '.', portHint: 8000 });
    assert.equal(reused.reused, true);
    assert.equal(reused.port, started.port);

    const bundle = await startPreviewServer({ workspaceRoot: root, root: 'bundle', portHint: 8000 });
    assert.equal(bundle.ok, true);
    assert.notEqual(bundle.port, started.port);
    const bundlePage = await fetch(bundle.url);
    assert.match(await bundlePage.text(), /bundle/);

    const status = listPreviewServers();
    assert.ok(status.length >= 2);

    await stopPreviewServer({ id: started.id });
    await stopPreviewServer({ port: bundle.port });
    assert.equal(listPreviewServers().length, 0);
  } finally {
    await stopAllPreviewServers();
  }
});

test('preview root cannot escape workspace', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'openclawx-preview-esc-'));
  await assert.rejects(
    () => startPreviewServer({ workspaceRoot: root, root: '../outside' }),
    /safe relative path|outside/i,
  );
});

test('suggestPreviewRoot prefers directories with index.html', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'openclawx-preview-suggest-'));
  mkdirSync(path.join(root, 'output'), { recursive: true });
  writeFileSync(path.join(root, 'output', 'index.html'), '<h1>out</h1>', 'utf8');
  assert.equal(await suggestPreviewRoot(root), 'output');
});

test('createPreviewServerTools auto-detects root and serves', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'openclawx-preview-tools-'));
  writeFileSync(path.join(root, 'index.html'), '<h1>tools</h1>', 'utf8');
  const tools = createPreviewServerTools({ workspaceRoot: root, workspaceAccess: 'write' });
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['preview_server_start', 'preview_server_status', 'preview_server_stop'],
  );
  const start = tools.find((tool) => tool.name === 'preview_server_start')!;
  const result = await start.execute('t1', {}, undefined);
  const details = (result as { details?: { ok?: boolean; url?: string; id?: string } }).details
    || JSON.parse((result as { content?: Array<{ text?: string }> }).content?.[0]?.text || '{}');
  assert.equal(details.ok, true);
  assert.ok(details.url);
  try {
    const page = await fetch(String(details.url));
    assert.match(await page.text(), /tools/);
  } finally {
    await stopAllPreviewServers();
  }
});

test('conversation preview maps SITE asset bundle without touching empty workspace', async () => {
  const emptyWs = mkdtempSync(path.join(os.tmpdir(), 'openclawx-preview-empty-'));
  const bundleRoot = mkdtempSync(path.join(os.tmpdir(), 'openclawx-preview-bundle-'));
  writeFileSync(path.join(bundleRoot, 'index.html'), '<h1>from-asset-bundle</h1>', 'utf8');
  setConversationSiteBundleResolver(async (conversationId) => (
    conversationId === 'sess-preview'
      ? { assetId: 'asset-1', root: bundleRoot, entryPath: 'index.html' }
      : null
  ));
  try {
    const tools = createPreviewServerTools({
      workspaceRoot: emptyWs,
      workspaceAccess: 'write',
      conversationId: 'sess-preview',
      workspaceMode: 'conversation',
    });
    const start = tools.find((tool) => tool.name === 'preview_server_start')!;
    const result = await start.execute('t2', {}, undefined);
    const details = (result as { details?: { ok?: boolean; url?: string; source?: string; assetId?: string } }).details
      || JSON.parse((result as { content?: Array<{ text?: string }> }).content?.[0]?.text || '{}');
    assert.equal(details.ok, true);
    assert.equal(details.source, 'asset-bundle');
    assert.equal(details.assetId, 'asset-1');
    const page = await fetch(String(details.url));
    assert.match(await page.text(), /from-asset-bundle/);
  } finally {
    setConversationSiteBundleResolver(null);
    await stopAllPreviewServers();
  }
});

test('lan access binds 0.0.0.0 and returns localUrl', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'openclawx-preview-lan-'));
  writeFileSync(path.join(root, 'index.html'), '<h1>lan-site</h1>', 'utf8');
  try {
    const started = await startPreviewServer({ workspaceRoot: root, root: '.', access: 'lan', portHint: 8000 });
    assert.equal(started.ok, true);
    assert.equal(started.access, 'lan');
    assert.equal(started.bindHost, '0.0.0.0');
    assert.ok(started.localUrl.startsWith('http://127.0.0.1:'));
    assert.ok(started.url.startsWith('http://'));
    const page = await fetch(started.localUrl);
    assert.match(await page.text(), /lan-site/);

    // Same root + lan reuses; local is a different access mode (separate server).
    const reused = await startPreviewServer({ workspaceRoot: root, root: '.', access: 'lan', portHint: 8000 });
    assert.equal(reused.reused, true);
    assert.equal(reused.id, started.id);
    const local = await startPreviewServer({ workspaceRoot: root, root: '.', access: 'local', portHint: 8000 });
    assert.equal(local.access, 'local');
    assert.equal(local.bindHost, '127.0.0.1');
    assert.notEqual(local.id, started.id);
    const localPage = await fetch(local.localUrl || local.url);
    assert.match(await localPage.text(), /lan-site/);
  } finally {
    await stopAllPreviewServers();
  }
});

test('preview_server_stop without id/port stops all site servers', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'openclawx-preview-stop-all-'));
  writeFileSync(path.join(root, 'index.html'), '<h1>stop-all</h1>', 'utf8');
  try {
    await startPreviewServer({ workspaceRoot: root, root: '.', access: 'local', portHint: 8000 });
    await startPreviewServer({ workspaceRoot: root, root: '.', access: 'lan', portHint: 8000 });
    assert.ok(listPreviewServers().length >= 2);
    const tools = createPreviewServerTools({ workspaceRoot: root, workspaceAccess: 'write' });
    const stop = tools.find((tool) => tool.name === 'preview_server_stop')!;
    const result = await stop.execute('stop-all', {}, undefined);
    const details = (result as { details?: { ok?: boolean; stopped?: number } }).details
      || JSON.parse((result as { content?: Array<{ text?: string }> }).content?.[0]?.text || '{}');
    assert.equal(details.ok, true);
    assert.ok(Number(details.stopped) >= 2);
    assert.equal(listPreviewServers().length, 0);
  } finally {
    await stopAllPreviewServers();
  }
});

test('project preview maps project workspace root', async () => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'openclawx-preview-project-'));
  writeFileSync(path.join(project, 'index.html'), '<h1>project-root</h1>', 'utf8');
  mkdirSync(path.join(project, 'dist'), { recursive: true });
  writeFileSync(path.join(project, 'dist', 'index.html'), '<h1>project-dist</h1>', 'utf8');
  try {
    const tools = createPreviewServerTools({
      workspaceRoot: project,
      workspaceAccess: 'write',
      projectId: project,
      workspaceMode: 'project',
    });
    const start = tools.find((tool) => tool.name === 'preview_server_start')!;
    const result = await start.execute('t3', {}, undefined);
    const details = (result as { details?: { ok?: boolean; url?: string; source?: string; rootRelative?: string } }).details
      || JSON.parse((result as { content?: Array<{ text?: string }> }).content?.[0]?.text || '{}');
    assert.equal(details.ok, true);
    assert.equal(details.source, 'project');
    assert.equal(details.rootRelative, '.');
    const page = await fetch(String(details.url));
    assert.match(await page.text(), /project-root/);
  } finally {
    await stopAllPreviewServers();
  }
});
