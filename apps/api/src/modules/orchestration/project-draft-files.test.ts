import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { Orchestrator } from '@openclawx/orchestrator';
import { registerProjectDraftFileRoutes } from './project-draft-files.js';

test('MDA-T10: authorized isolated output drafts are read-only, bounded and never replace deliverables', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'openclawx-draft-files-'));
  const previous = process.env.OPENCLAWX_WORKSPACES_DIR; process.env.OPENCLAWX_WORKSPACES_DIR = parent;
  const owner = { orgId: 'org', ownerUserId: 'alice', accessScope: 'private' };
  const projects = { project: { ...owner, id: 'project', kind: 'conversation', tasks: [{ id: 'task', runId: 'run-1' }, { id: 'empty', runId: 'run-2' }] }, other: { ...owner, id: 'other', kind: 'conversation', tasks: [] } };
  const runs = { 'run-1': { ...owner, id: 'run-1', sessionId: 'project', taskId: 'task', status: 'failed' }, 'run-2': { ...owner, id: 'run-2', sessionId: 'project', taskId: 'empty', status: 'running' } };
  const orch = { projects: { getProject: async (id: keyof typeof projects) => projects[id] }, chat: { getRun: async (id: keyof typeof runs) => runs[id] } } as unknown as Orchestrator;
  const output = path.join(parent, 'run-1/output'); mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'index.html'), '<h1>unfinished draft</h1>');
  mkdirSync(path.join(output, 'styles')); writeFileSync(path.join(output, 'styles/main.css'), 'body{color:red}');
  writeFileSync(path.join(parent, 'official.html'), 'previous successful result');
  mkdirSync(path.join(parent, 'run-1/inputs')); writeFileSync(path.join(parent, 'run-1/inputs/private.txt'), 'private material');
  mkdirSync(path.join(output, '.private')); writeFileSync(path.join(output, '.private/private.txt'), 'hidden');
  writeFileSync(path.join(output, 'huge.txt'), Buffer.alloc(2 * 1024 * 1024 + 1));
  symlinkSync(path.join(parent, 'official.html'), path.join(output, 'escape.html'));
  symlinkSync(path.join(parent, 'run-1/inputs'), path.join(output, 'linked'));
  const app = Fastify();
  app.addHook('preHandler', async request => { request.auth = { userId: String(request.headers['x-user'] || 'alice'), orgId: String(request.headers['x-org'] || 'org'), role: 'member', sessionId: 'test', username: 'test', displayName: 'test' }; });
  registerProjectDraftFileRoutes(app, orch);
  const base = '/projects/project/runs/run-1';
  try {
    const list = await app.inject(`${base}/draft-files`);
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(list.json().files.map((f: { relative: string }) => f.relative), ['index.html', 'styles/main.css']);
    assert.equal(list.json().truncated, false);
    assert.equal((await app.inject(`${base}/draft-file?relative=index.html`)).json().content, '<h1>unfinished draft</h1>');
    for (const relative of ['../inputs/private.txt', '/index.html', 'styles/../../official.html', '.private/private.txt', 'linked/private.txt', 'escape.html', 'huge.txt']) {
      const response = await app.inject(`${base}/draft-file?relative=${encodeURIComponent(relative)}`);
      assert.ok(response.statusCode >= 400, relative);
      assert.ok(!response.body.includes('previous successful result'));
    }
    for (const headers of [{ 'x-user': 'bob' }, { 'x-org': 'other-org' }]) assert.equal((await app.inject({ url: `${base}/draft-files`, headers })).statusCode, 404);
    assert.equal((await app.inject('/projects/other/runs/run-1/draft-files')).statusCode, 404);
    assert.equal((await app.inject('/projects/project/runs/missing/draft-files')).statusCode, 404);
    assert.deepEqual((await app.inject('/projects/project/runs/run-2/draft-files')).json().files, []);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/draft-file`, payload: { relative: 'index.html', content: 'override' } })).statusCode, 404);
    assert.equal(readFileSync(path.join(parent, 'official.html'), 'utf8'), 'previous successful result');
    for (let i = 0; i < 510; i++) writeFileSync(path.join(output, `file-${String(i).padStart(3, '0')}.txt`), 'draft');
    const bounded = (await app.inject(`${base}/draft-files`)).json();
    assert.equal(bounded.files.length, 500); assert.equal(bounded.truncated, true);
  } finally { await app.close(); if (previous === undefined) delete process.env.OPENCLAWX_WORKSPACES_DIR; else process.env.OPENCLAWX_WORKSPACES_DIR = previous; }
});
