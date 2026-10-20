import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceCapabilityKernel } from '../capability-kernel.js';

async function kernelForTest() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openclawx-capability-'));
  return {
    root,
    kernel: new WorkspaceCapabilityKernel({
      runId: 'test-run',
      workspaceRoot: root,
      workspaceAccess: 'write',
      workspaceMode: 'conversation',
    }),
  };
}

test('commitArtifact publishes only after a non-empty source file exists', async () => {
  const { root, kernel } = await kernelForTest();
  await mkdir(path.join(root, 'drafts'), { recursive: true });
  await writeFile(path.join(root, 'drafts', 'index.html'), '<main>ready</main>');

  const committed = await kernel.commitArtifact('drafts/index.html');
  assert.equal(committed.ok, true);
  assert.equal(committed.path, 'output/index.html');
  assert.equal(await readFile(path.join(root, 'output', 'index.html'), 'utf8'), '<main>ready</main>');
});

test('commitArtifact refuses process files and paths outside the workspace', async () => {
  const { root, kernel } = await kernelForTest();
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'scripts', 'build.mjs'), 'console.log(1)');
  const processFile = await kernel.commitArtifact('scripts/build.mjs');
  assert.equal(processFile.ok, false);

  const outside = await kernel.commitArtifact('../outside.html');
  assert.equal(outside.ok, false);
});

test('Pi shared capability kernel commits project files without an output wrapper', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openclawx-capability-project-'));
  await writeFile(path.join(root, 'index.html'), '<main>pi project</main>');
  const kernel = new WorkspaceCapabilityKernel({
    runId: 'pi-project', workspaceRoot: root, workspaceAccess: 'write', workspaceMode: 'project',
  });
  const committed = await kernel.commitArtifact('index.html');
  assert.equal(committed.ok, true);
  assert.equal(committed.path, 'index.html');
  assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), '<main>pi project</main>');
});

test('kernel blocks destructive and network shell commands before Pi executes them', () => {
  const context = {
    runId: 'test-run', workspaceRoot: process.cwd(), workspaceAccess: 'write' as const, workspaceMode: 'conversation' as const,
  };
  const kernel = new WorkspaceCapabilityKernel(context);
  assert.throws(() => kernel.assertCommand('rm -rf dist'));
  assert.throws(() => kernel.assertCommand('curl https://example.com'));
  assert.equal(kernel.assertCommand('node --version'), 'node --version');
});
