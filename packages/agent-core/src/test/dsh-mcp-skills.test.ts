import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentSkillRuntime, McpConnectionRuntime } from '@openclawx/contracts';
import {
  buildOpenClawXDshCordisYaml,
  writeOpenClawXDshCordis,
  materializeOpenClawXSkillsForDsh,
} from '../dsh/index.js';
import type { OpenClawXDshModelRoute } from '../dsh/index.js';

const route: OpenClawXDshModelRoute = {
  provider: 'openclawx',
  model: 'test-model',
  api: 'openai-completions',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  displayName: 'Test',
  contextWindow: 128_000,
  maxTokens: 8_192,
  env: {},
};

function skill(partial: Partial<AgentSkillRuntime> & Pick<AgentSkillRuntime, 'id' | 'name'>): AgentSkillRuntime {
  return {
    description: partial.description || `${partial.name} skill`,
    mode: partial.mode || 'available',
    instructions: partial.instructions ?? `Instructions for ${partial.name}`,
    resources: partial.resources ?? [],
    execution: partial.execution ?? {
      allowWorkspaceWrite: false,
      allowScriptExecution: false,
      allowedNetworkHosts: [],
      allowAllNonDestructive: false,
    },
    ...partial,
    id: partial.id,
    name: partial.name,
  };
}

test('dsh cordis embeds stdio + http MCP clients before sdk-jsonrpc-server', () => {
  const mcpConnections: McpConnectionRuntime[] = [
    {
      id: 'local-fs',
      name: 'Local FS',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { FOO: 'bar' },
      cwd: '/workspace',
      enabled: true,
    },
    {
      id: 'remote-http',
      name: 'Remote HTTP',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      apiKey: 'secret-token',
      enabled: true,
    },
  ];

  const yaml = buildOpenClawXDshCordisYaml({
    route,
    mcpConnections,
    skillsEnabled: false,
  });

  assert.match(yaml, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(yaml, /transport: stdio/);
  assert.match(yaml, /command: "npx"/);
  assert.match(yaml, /FOO: "bar"/);
  assert.match(yaml, /transport: streamable-http/);
  assert.match(yaml, /url: "https:\/\/mcp\.example\.com\/mcp"/);
  assert.match(yaml, /Authorization: "Bearer secret-token"/);
  assert.match(yaml, /failOnStartupError: true/);

  const mcpIdx = yaml.indexOf("name: '@deepseek-ai/dsh-mcp-client'");
  const serverIdx = yaml.indexOf("name: '@deepseek-ai/dsh-sdk-jsonrpc-server'");
  assert.ok(mcpIdx >= 0 && serverIdx > mcpIdx, 'MCP plugins must load before jsonrpc server');
});

test('dsh cordis enables skills + customSkillDirs when requested', () => {
  const yaml = buildOpenClawXDshCordisYaml({
    route,
    skillsEnabled: true,
    customSkillDirs: ['/tmp/openclawx-skills'],
  });
  assert.match(yaml, /skills:\n\s+enabled: true/);
  assert.match(yaml, /customSkillDirs:\n\s+- "\/tmp\/openclawx-skills"/);
});

test('dsh cordis keeps skills disabled by default', () => {
  const yaml = buildOpenClawXDshCordisYaml(route);
  assert.match(yaml, /skills:\n\s+enabled: false/);
  assert.doesNotMatch(yaml, /dsh-mcp-client/);
});

test('dsh cordis skips disabled MCP connections', () => {
  const yaml = buildOpenClawXDshCordisYaml({
    route,
    mcpConnections: [
      {
        id: 'off',
        name: 'Off',
        transport: 'stdio',
        command: 'echo',
        args: [],
        enabled: false,
      },
    ],
  });
  assert.doesNotMatch(yaml, /dsh-mcp-client/);
});

test('materializeOpenClawXSkillsForDsh writes kebab SKILL.md and skips platform harness', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'openclawx-dsh-skills-'));
  try {
    const skills: AgentSkillRuntime[] = [
      skill({
        id: 'openclawx-workspace',
        name: 'Workspace',
        instructions: 'should skip',
      }),
      skill({
        id: 'Doc Writer',
        name: 'Doc Writer',
        instructions: 'Write clear docs.',
        resources: [{ path: 'tips.md', content: 'Be concise.' }],
      }),
    ];

    const root = materializeOpenClawXSkillsForDsh(cwd, skills);
    assert.ok(root);
    assert.equal(root, path.join(cwd, '.agents', 'skills'));

    const skillFile = path.join(root!, 'doc-writer', 'SKILL.md');
    assert.equal(existsSync(skillFile), true);
    const body = readFileSync(skillFile, 'utf8');
    assert.match(body, /^---\nname: doc-writer\n/m);
    assert.match(body, /Write clear docs/);
    assert.match(body, /### Resource: tips\.md/);
    assert.equal(existsSync(path.join(root!, 'openclawx-workspace')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('materializeOpenClawXSkillsForDsh keeps available skills without instructions (pi progressive disclosure)', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'openclawx-dsh-skills-avail-'));
  try {
    const root = materializeOpenClawXSkillsForDsh(cwd, [
      skill({
        id: 'skill-baseline-pdf-report',
        name: 'PDF 报告生成',
        mode: 'available',
        description: '把分析结论做成可交付的中文 PDF 报告。',
        instructions: undefined,
      }),
    ]);
    assert.ok(root, 'available PDF skill must still materialize for dsh skill tool');
    const body = readFileSync(path.join(root!, 'skill-baseline-pdf-report', 'SKILL.md'), 'utf8');
    assert.match(body, /把分析结论做成可交付的中文 PDF 报告/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('materializeOpenClawXSkillsForDsh prefers on-disk SKILL.md from rootPath', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'openclawx-dsh-skills-root-'));
  const skillRoot = mkdtempSync(path.join(os.tmpdir(), 'openclawx-skill-src-'));
  try {
    writeFileSync(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: from-disk\ndescription: "disk"\n---\n\nFrom disk body.\n',
      'utf8',
    );
    const root = materializeOpenClawXSkillsForDsh(cwd, [
      skill({
        id: 'from-disk',
        name: 'From Disk',
        rootPath: skillRoot,
        instructions: 'ignored when disk file exists',
      }),
    ]);
    assert.ok(root);
    const body = readFileSync(path.join(root!, 'from-disk', 'SKILL.md'), 'utf8');
    assert.match(body, /From disk body/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(skillRoot, { recursive: true, force: true });
  }
});

test('writeOpenClawXDshCordis persists MCP + skills bridge for a run workspace', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'openclawx-dsh-cordis-'));
  try {
    const skillsRoot = materializeOpenClawXSkillsForDsh(cwd, [
      skill({ id: 'review-notes', name: 'Review Notes', instructions: 'Review carefully.' }),
    ]);
    assert.ok(skillsRoot);

    const cordisPath = writeOpenClawXDshCordis(cwd, {
      route,
      mcpConnections: [
        {
          id: 'demo-mcp',
          name: 'Demo',
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          enabled: true,
        },
      ],
      skillsEnabled: true,
      customSkillDirs: [skillsRoot!],
    });

    assert.equal(cordisPath, path.join(cwd, '.openclawx-dsh.cordis.yml'));
    const yaml = readFileSync(cordisPath, 'utf8');
    assert.match(yaml, /serverName: "demo-mcp"/);
    assert.match(yaml, /enabled: true/);
    assert.ok(
      yaml.includes(JSON.stringify(skillsRoot!)),
      'custom skill dir must be serialized into cordis yaml',
    );
    assert.equal(existsSync(path.join(skillsRoot!, 'review-notes', 'SKILL.md')), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('materialize returns null when only skipped / empty skills', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'openclawx-dsh-skills-empty-'));
  try {
    mkdirSync(cwd, { recursive: true });
    assert.equal(
      materializeOpenClawXSkillsForDsh(cwd, [
        skill({ id: 'skill-discovery', name: 'Discovery', instructions: 'x' }),
      ]),
      null,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
