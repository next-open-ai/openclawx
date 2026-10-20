import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  appendArtifactSourceWrite,
  finishArtifactSourceWrite,
  startArtifactSourceWrite,
} from '../artifact-source-writer.js';

test('large artifact writer assembles ordered pieces and atomically exposes the final file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openclawx-artifact-writer-'));
  try {
    const session = startArtifactSourceWrite({ workspaceRoot: root, path: 'output/index.html', totalParts: 2 });
    appendArtifactSourceWrite({ writeId: session.id, seq: 1, content: '<h1>' });
    appendArtifactSourceWrite({ writeId: session.id, seq: 2, content: 'Hello</h1>' });
    const completed = await finishArtifactSourceWrite(session.id);
    assert.equal(completed.path, 'output/index.html');
    assert.equal(await readFile(path.join(root, 'output/index.html'), 'utf8'), '<h1>Hello</h1>');
    assert.match(completed.sha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('large artifact writer rejects out-of-order pieces without writing a partial output', () => {
  const session = startArtifactSourceWrite({ workspaceRoot: '/tmp', path: 'output/index.html', totalParts: 2 });
  assert.throws(
    () => appendArtifactSourceWrite({ writeId: session.id, seq: 2, content: 'bad order' }),
    /expected seq=1/,
  );
});

test('large artifact writer supports project-root paths when explicitly enabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openclawx-artifact-project-'));
  try {
    const session = startArtifactSourceWrite({ workspaceRoot: root, path: 'index.html', totalParts: 1, requireOutput: false });
    appendArtifactSourceWrite({ writeId: session.id, seq: 1, content: '<main>project</main>' });
    const completed = await finishArtifactSourceWrite(session.id);
    assert.equal(completed.path, 'index.html');
    assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), '<main>project</main>');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
