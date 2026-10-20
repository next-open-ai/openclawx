import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ResourceAccessPolicy, assertResourcePath } from '../resource-access.js';
import { createPiCapabilityTools } from '../pi-capability-adapter.js';
import { executeAgentscopeCapabilityCalls } from '../agentscope-capability-adapter.js';
import { createSkillExecutionTools } from '../skill-runtime.js';
import { extractToolDetails } from '../pi-tools.js';
import { WorkspaceCapabilityKernel } from '../capability-kernel.js';
import { startArtifactSourceWrite, appendArtifactSourceWrite, finishArtifactSourceWrite } from '../artifact-source-writer.js';

test('WA-R21: conversation and project native tools enforce the same boundary without material markers', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'openclawx-universal-'));
  const outside = path.join(parent, 'outside.txt'); await writeFile(outside, 'private');
  try {
    for (const mode of ['conversation', 'project'] as const) {
      const root = path.join(parent, mode); await mkdir(root);
      const context = { runId: mode, workspaceRoot: root, workspaceMode: mode, workspaceAccess: 'write' as const };
      const tools = createPiCapabilityTools(context);
      const write = tools.find((tool) => tool.name === 'write')!;
      const read = tools.find((tool) => tool.name === 'read')!;
      const bash = tools.find((tool) => tool.name === 'bash')!;
      await write.execute('w', { path: 'local.txt', content: 'local' });
      assert.match(JSON.stringify(await read.execute('r', { path: 'local.txt' })), /local/);
      await assert.rejects(read.execute('outside', { path: outside }), /授权工作区/);
      await assert.rejects(read.execute('alias', { path: `@${outside}` }), /授权工作区/);
      await assert.rejects(read.execute('home', { path: '~/outside.txt' }), /授权工作区/);
      await assert.rejects(write.execute('escape', { path: '../outside.txt', content: 'overwrite' }));
      await assert.rejects(bash.execute('shell', { command: 'cd /Users; ls' }), /不允许/);
      const [bridged] = await executeAgentscopeCapabilityCalls(context, [{ id: 'bridge', name: 'read', input: { path: outside } }]);
      assert.equal(bridged.state, 'error');
      const readonly = createPiCapabilityTools({ ...context, workspaceAccess: 'read' });
      assert.equal(readonly.some((tool) => tool.name === 'write' || tool.name === 'bash'), false);
      await assert.rejects(readonly.find((tool) => tool.name === 'ls')!.execute('list', { path: parent }));
    }
    assert.equal(await readFile(outside, 'utf8'), 'private');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('WA-R21: trusted exact-file grants are read-only and never authorize parent directories or siblings', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'openclawx-grants-'));
  const root = path.join(parent, 'workspace'); await mkdir(root);
  const selected = path.join(parent, 'selected.txt'); await writeFile(selected, 'selected');
  const other = path.join(parent, 'other.txt'); await writeFile(other, 'other');
  const context = { runId: 'grant', workspaceRoot: root, workspaceMode: 'conversation' as const, workspaceAccess: 'write' as const, readOnlyFiles: [selected] };
  const tools = createPiCapabilityTools(context);
  try {
    assert.match(JSON.stringify(await tools.find((tool) => tool.name === 'read')!.execute('read', { path: selected })), /selected/);
    const policy = new ResourceAccessPolicy(root, [selected]);
    await assert.rejects(policy.authorizeFile(parent, 'read'));
    await assert.rejects(policy.authorizeFile(other, 'read'));
    await assert.rejects(policy.authorizeFile(selected, 'write'));
    await assert.rejects(new ResourceAccessPolicy(root, [parent]).authorizeFile(parent, 'read'), /具体文件/);
    await assert.rejects(tools.find((tool) => tool.name === 'write')!.execute('write', { path: selected, content: 'bad' }));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('WA-R22: canonical checks reject symlink escapes and dangling links, but permit a fresh workspace', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'openclawx-realpaths-'));
  const root = path.join(parent, 'workspace'); await mkdir(root);
  const external = path.join(parent, 'external'); await mkdir(external);
  await writeFile(path.join(external, 'secret.txt'), 'secret');
  await symlink(external, path.join(root, 'escape'));
  await symlink(path.join(external, 'missing.txt'), path.join(root, 'dangling'));
  await symlink(path.join(root, 'escape'), path.join(root, 'nested'));
  try {
    for (const candidate of ['escape/secret.txt', 'escape/new.txt', 'nested/secret.txt', 'dangling']) {
      await assert.rejects(assertResourcePath(root, candidate), /符号链接/);
    }
    const fresh = path.join(parent, 'new-workspace');
    const write = createPiCapabilityTools({ runId: 'fresh', workspaceRoot: fresh, workspaceMode: 'conversation', workspaceAccess: 'write' }).find((tool) => tool.name === 'write')!;
    await write.execute('fresh', { path: 'nested/file.txt', content: 'new' });
    assert.equal(await readFile(path.join(fresh, 'nested/file.txt'), 'utf8'), 'new');
    const kernel = new WorkspaceCapabilityKernel({ runId: 'links', workspaceRoot: root, workspaceMode: 'project', workspaceAccess: 'write' });
    assert.equal((await kernel.commitArtifact('escape/secret.txt')).ok, false);
    const staged = startArtifactSourceWrite({ workspaceRoot: root, path: 'escape/new.txt', totalParts: 1, requireOutput: false });
    appendArtifactSourceWrite({ writeId: staged.id, seq: 1, content: 'bad' });
    await assert.rejects(finishArtifactSourceWrite(staged.id), /符号链接/);
    const legacy = createSkillExecutionTools({ runId: 'legacy-paths', projectRoot: root, skills: [] }).find((tool) => tool.name === 'read_workspace_file')!;
    const result = extractToolDetails(await legacy.execute('legacy', { path: 'escape/secret.txt' })) as { ok?: boolean; error?: string };
    assert.equal(result.ok, false); assert.match(result.error!, /符号链接/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
