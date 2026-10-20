import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DshCapabilityAdapter } from '../dsh-capability-adapter.js';

test('DSH adapter commits completed output only after a successful run boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openclawx-dsh-capability-'));
  await mkdir(path.join(root, 'output'), { recursive: true });
  await writeFile(path.join(root, 'output', 'site.html'), '<main>dsh</main>');
  const adapter = new DshCapabilityAdapter({
    runId: 'dsh-test', workspaceRoot: root, workspaceAccess: 'write', workspaceMode: 'conversation',
  });
  const committed = await adapter.commitCompletedArtifacts(Date.now() - 1_000);
  assert.deepEqual(committed, ['output/site.html']);
  assert.equal(await readFile(path.join(root, 'output', 'site.html'), 'utf8'), '<main>dsh</main>');
  assert.match(adapter.systemPromptContract(), /atomically committed/i);
});

test('DSH project mode requires the real project root and never conversation output', () => {
  const adapter = new DshCapabilityAdapter({
    runId: 'dsh-project', workspaceRoot: '/tmp/openclawx-dsh-project', workspaceAccess: 'write', workspaceMode: 'project',
  });
  assert.match(adapter.systemPromptContract(), /PROJECT MODE/);
  assert.match(adapter.systemPromptContract(), /Never create or use output\//);
  assert.doesNotMatch(adapter.systemPromptContract(), /conversation deliverable/);
});
