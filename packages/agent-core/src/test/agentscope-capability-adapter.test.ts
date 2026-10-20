import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeAgentscopeCapabilityCalls } from '../agentscope-capability-adapter.js';

test('AgentScope adapter uses the shared write and explicit commit capabilities', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openclawx-agentscope-'));
  const context = { runId: 'agentscope-test', workspaceRoot: root, workspaceAccess: 'write' as const, workspaceMode: 'conversation' as const };
  const [written] = await executeAgentscopeCapabilityCalls(context, [{
    id: 'write-1', name: 'write', input: { path: 'site/index.html', content: '<main>hello</main>' },
  }]);
  assert.equal(written.state, 'success');

  const [committed] = await executeAgentscopeCapabilityCalls(context, [{
    id: 'commit-1', name: 'commit_artifact', input: { path: 'site/index.html' },
  }]);
  assert.equal(committed.state, 'success');
  assert.equal(committed.artifactPath, 'output/index.html');
  assert.equal(await readFile(path.join(root, 'output', 'index.html'), 'utf8'), '<main>hello</main>');
});

test('AgentScope project mode keeps committed files at the project root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openclawx-agentscope-project-'));
  const context = { runId: 'agentscope-project', workspaceRoot: root, workspaceAccess: 'write' as const, workspaceMode: 'project' as const };
  const [written] = await executeAgentscopeCapabilityCalls(context, [{
    id: 'write-project', name: 'write', input: { path: 'index.html', content: '<main>project</main>' },
  }]);
  assert.equal(written.state, 'success');
  const [committed] = await executeAgentscopeCapabilityCalls(context, [{
    id: 'commit-project', name: 'commit_artifact', input: { path: 'index.html' },
  }]);
  assert.equal(committed.state, 'success');
  assert.equal(committed.artifactPath, 'index.html');
  assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), '<main>project</main>');
});
