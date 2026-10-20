#!/usr/bin/env node
/**
 * Regression: OpenClawX → dsh MCP + Skills bridge.
 *
 * Deterministic (no live dsh binary / LLM). Asserts cordis composition and
 * skill materialization that streamAgentReplyViaDsh depends on.
 *
 * Usage: pnpm dsh:regression
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentCore = path.join(projectRoot, 'packages', 'agent-core');
const testFile = path.join(agentCore, 'dist', 'test', 'dsh-mcp-skills.test.js');

function ensureBuilt() {
  if (fs.existsSync(testFile)) return;
  const build = spawnSync('pnpm', ['--filter', '@openclawx/agent-core', 'build'], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) {
    throw new Error('Failed to build @openclawx/agent-core for dsh MCP/Skills regression.');
  }
  if (!fs.existsSync(testFile)) {
    throw new Error(`Missing compiled test: ${testFile}`);
  }
}

function main() {
  ensureBuilt();
  const result = spawnSync(process.execPath, ['--test', testFile], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: process.env,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  process.stdout.write(`${JSON.stringify({
    mode: 'dsh-mcp-skills-regression',
    ok: true,
    cases: [
      'cordis embeds stdio + http MCP before jsonrpc server',
      'cordis enables skills + customSkillDirs',
      'cordis skips disabled MCP / skills-off default',
      'materialize kebab SKILL.md + skip platform harness',
      'materialize prefers on-disk SKILL.md',
      'writeOpenClawXDshCordis persists MCP + skills bridge',
    ],
    testFile,
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
