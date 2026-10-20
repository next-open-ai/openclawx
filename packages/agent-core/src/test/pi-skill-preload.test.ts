import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentSkillRuntime } from '@openclawx/contracts';
import { createSkillExecutionTools } from '../skill-runtime.js';

function skill(partial: Partial<AgentSkillRuntime> & Pick<AgentSkillRuntime, 'id' | 'name'>): AgentSkillRuntime {
  return {
    id: partial.id,
    name: partial.name,
    description: partial.description || `${partial.name} skill`,
    mode: partial.mode || 'available',
    ...(partial.instructions ? { instructions: partial.instructions } : {}),
    resources: partial.resources ?? [],
    execution: partial.execution ?? {
      allowWorkspaceWrite: true,
      allowScriptExecution: true,
      allowedNetworkHosts: [],
      allowAllNonDestructive: false,
    },
  };
}

test('workspace writes are platform capabilities and do not require a loaded Skill', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'openclawx-pi-preload-'));
  const oldRoot = process.env.OPENCLAWX_WORKSPACES_DIR;
  process.env.OPENCLAWX_WORKSPACES_DIR = root;
  try {
    const tools = createSkillExecutionTools({
      runId: '11111111-1111-1111-1111-111111111111',
      skills: [skill({
          id: 'skill-baseline-pdf-report',
          name: 'PDF 报告生成',
          mode: 'available',
          instructions: 'Generate a PDF under output/.',
        })],
    });
    const write = tools.find((tool) => tool.name === 'write_workspace_file');
    assert.ok(write, 'write_workspace_file tool should exist');
    const written = await write!.execute(
      'tool-call-1',
      {
        skillId: 'skill-baseline-pdf-report',
        path: 'scripts/generate.py',
        content: 'print("ok")',
        mode: 'replace',
      },
      undefined,
    );
    const details = (written as { details?: { ok?: boolean } }).details;
    assert.equal(details?.ok, true);
  } finally {
    if (oldRoot === undefined) delete process.env.OPENCLAWX_WORKSPACES_DIR;
    else process.env.OPENCLAWX_WORKSPACES_DIR = oldRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('run_workspace_script prepares output scaffold for all skills', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'openclawx-pi-output-'));
  const oldRoot = process.env.OPENCLAWX_WORKSPACES_DIR;
  process.env.OPENCLAWX_WORKSPACES_DIR = root;
  try {
    const runId = '22222222-2222-2222-2222-222222222222';
    const tools = createSkillExecutionTools({
      runId,
      skills: [
        skill({
          id: 'openclawx-workspace',
          name: 'OpenClawX Workspace',
          mode: 'default',
          instructions: 'Platform harness for workspace writes and scripts.',
        }),
        skill({
          id: 'skill-generic-doc',
          name: '通用文档',
          mode: 'available',
          instructions: 'Write the final artifact into output/.',
        }),
      ],
    });
    const write = tools.find((tool) => tool.name === 'write_workspace_file');
    const run = tools.find((tool) => tool.name === 'run_workspace_script');
    assert.ok(write && run, 'workspace tools should exist');

    await write!.execute(
      'tool-call-2',
      {
        skillId: 'openclawx-workspace',
        path: 'scripts/gen.py',
        content: 'from pathlib import Path\nPath("output/report.txt").write_text("ok", encoding="utf-8")\nprint("done")\n',
        mode: 'replace',
      },
      undefined,
    );
    const result = await run!.execute(
      'tool-call-3',
      {
        skillId: 'openclawx-workspace',
        path: 'scripts/gen.py',
      },
      undefined,
    );
    const details = (result as { details?: { ok?: boolean; artifacts?: string[] } }).details;
    assert.equal(details?.ok, true);
    assert.ok(details?.artifacts?.includes('output/report.txt'));
    const artifact = path.join(root, runId, 'output', 'report.txt');
    assert.ok(existsSync(artifact));
    assert.equal(readFileSync(artifact, 'utf8'), 'ok');
  } finally {
    if (oldRoot === undefined) delete process.env.OPENCLAWX_WORKSPACES_DIR;
    else process.env.OPENCLAWX_WORKSPACES_DIR = oldRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('install_python_dependency short-circuits when module already exists globally', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'openclawx-pi-dep-probe-'));
  const oldRoot = process.env.OPENCLAWX_WORKSPACES_DIR;
  process.env.OPENCLAWX_WORKSPACES_DIR = root;
  try {
    const tools = createSkillExecutionTools({
      runId: '33333333-3333-3333-3333-333333333333',
      skills: [],
    });
    const install = tools.find((tool) => tool.name === 'install_python_dependency');
    assert.ok(install, 'install_python_dependency tool should exist');

    const result = await install!.execute(
      'tool-call-4',
      {
        package: 'json',
      },
      undefined,
    );
    const details = (result as { details?: { ok?: boolean; alreadyAvailable?: boolean; package?: string } }).details;
    assert.equal(details?.ok, true);
    assert.equal(details?.alreadyAvailable, true);
    assert.equal(details?.package, 'json');
  } finally {
    if (oldRoot === undefined) delete process.env.OPENCLAWX_WORKSPACES_DIR;
    else process.env.OPENCLAWX_WORKSPACES_DIR = oldRoot;
    rmSync(root, { recursive: true, force: true });
  }
});
