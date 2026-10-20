import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  conversationModeContract,
  projectModeContract,
  reconcileProjectOutputDirectory,
  resolveAgentWorkspaceRoot,
  resolveWorkspaceMode,
  snapshotWorkspaceFiles,
} from '../workspace-mode.js';

test('resolveWorkspaceMode distinguishes conversation vs project', () => {
  assert.equal(resolveWorkspaceMode(undefined), 'conversation');
  assert.equal(resolveWorkspaceMode(''), 'conversation');
  assert.equal(resolveWorkspaceMode('/tmp/my-project'), 'project');
});

test('resolveAgentWorkspaceRoot uses project path in project mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-ws-mode-'));
  try {
    const root = resolveAgentWorkspaceRoot({ runId: 'run-1', projectWorkspacePath: dir });
    assert.equal(root, path.resolve(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAgentWorkspaceRoot isolates conversation runs under workspaces/', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-ws-base-'));
  const prev = process.env.OPENCLAWX_WORKSPACES_DIR;
  process.env.OPENCLAWX_WORKSPACES_DIR = base;
  try {
    const root = resolveAgentWorkspaceRoot({ runId: 'abc-123', projectWorkspacePath: undefined });
    assert.equal(root, path.join(base, 'abc-123'));
    assert.ok(fs.existsSync(root));
  } finally {
    if (prev === undefined) delete process.env.OPENCLAWX_WORKSPACES_DIR;
    else process.env.OPENCLAWX_WORKSPACES_DIR = prev;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('mode contracts mention the correct deliverable location', () => {
  assert.match(conversationModeContract(), /output\//);
  assert.match(conversationModeContract(), /preview_server_start/);
  assert.match(projectModeContract(), /Do not wrap the product in an output\//);
  assert.doesNotMatch(projectModeContract(), /MUST be written under output\//);
});

test('snapshotWorkspaceFiles skips internal dirs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-snap-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), '1');
    fs.mkdirSync(path.join(dir, '.python-packages'));
    fs.writeFileSync(path.join(dir, '.python-packages', 'y.py'), '1');
    const snap = await snapshotWorkspaceFiles(dir);
    assert.equal(snap.has('index.html'), true);
    assert.equal(snap.has('node_modules/x.js'), false);
    assert.equal(snap.has('.python-packages/y.py'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('project output reconciliation moves files to root and removes the wrapper', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-project-output-'));
  try {
    fs.mkdirSync(path.join(dir, 'output', 'assets', 'css'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'output', 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(dir, 'output', 'assets', 'css', 'site.css'), 'body{}');
    const result = await reconcileProjectOutputDirectory(dir);
    assert.deepEqual(result.conflicts, []);
    assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<html></html>');
    assert.equal(fs.readFileSync(path.join(dir, 'assets', 'css', 'site.css'), 'utf8'), 'body{}');
    assert.equal(fs.existsSync(path.join(dir, 'output')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('project output reconciliation never overwrites root conflicts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-project-conflict-'));
  try {
    fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), 'root');
    fs.writeFileSync(path.join(dir, 'output', 'index.html'), 'output');
    const result = await reconcileProjectOutputDirectory(dir);
    assert.deepEqual(result.conflicts, [{ from: 'output/index.html', to: 'index.html' }]);
    assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), 'root');
    assert.equal(fs.readFileSync(path.join(dir, 'output', 'index.html'), 'utf8'), 'output');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
