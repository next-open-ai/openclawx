import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promoteWorkspaceDeliverablesToProject } from '../skill-runtime.js';

test('UAT-R2: strict promotion surfaces actual copy failures without breaking legacy best-effort callers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-promotion-'));
  try {
    const source = path.join(root, 'run'); fs.mkdirSync(path.join(source, 'output'), { recursive: true });
    fs.writeFileSync(path.join(source, 'output/index.html'), '<h1>synthetic</h1>');
    fs.mkdirSync(path.join(source, 'output/tmp')); fs.writeFileSync(path.join(source, 'output/tmp/generator.py'), '# process-only');
    const blocked = path.join(root, 'blocked'); fs.writeFileSync(blocked, 'not a directory');
    await assert.rejects(promoteWorkspaceDeliverablesToProject(source, blocked, { strict: true }));
    assert.deepEqual(await promoteWorkspaceDeliverablesToProject(source, blocked), []);
    const dest = path.join(root, 'project');
    const published = await promoteWorkspaceDeliverablesToProject(source, dest, { strict: true });
    assert.equal(published.length, 1); assert.equal(fs.readFileSync(path.join(dest, 'index.html'), 'utf8'), '<h1>synthetic</h1>');
    assert.equal(fs.existsSync(path.join(dest, 'tmp/generator.py')), false);
    assert.deepEqual(await promoteWorkspaceDeliverablesToProject(path.join(root, 'absent'), dest, { strict: true }), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
