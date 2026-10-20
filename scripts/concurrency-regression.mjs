#!/usr/bin/env node

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { choosePort } from './lib/web-launcher.mjs';
import { ensureAgentscopeRuntime } from './lib/agentscope-runtime.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function runDshMcpSkillsCase() {
  const entry = path.join(projectRoot, 'scripts', 'dsh-mcp-skills-regression.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        const jsonLine = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .reverse()
          .find((line) => line.startsWith('{'));
        try {
          resolve(jsonLine ? JSON.parse(jsonLine) : { mode: 'dsh-mcp-skills-regression', ok: true });
        } catch {
          resolve({ mode: 'dsh-mcp-skills-regression', ok: true, raw: stdout.slice(-500) });
        }
        return;
      }
      reject(new Error(stderr || stdout || `dsh MCP/Skills regression exited with code ${code}.`));
    });
  });
}

async function waitForServer(baseUrl, options = {}) {
  const timeoutMs = Number(options.timeoutMs || process.env.OPENCLAWX_CONCURRENCY_REGRESSION_READY_TIMEOUT_MS || '120000');
  const output = typeof options.output === 'function' ? options.output : () => '';
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/auth/bootstrap`);
      if (response.ok) return;
    } catch {
      // Retry until the API is ready.
    }
    await sleep(250);
  }
  const recent = output().trim();
  const detail = recent ? `\n--- recent api output ---\n${recent.slice(-4000)}` : '';
  throw new Error(`Timed out waiting for API readiness at ${baseUrl} after ${timeoutMs}ms.${detail}`);
}

async function main() {
  const dshMcpSkills = await runDshMcpSkillsCase();

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'openclawx-concurrency-regression-'));
  const runtime = ensureAgentscopeRuntime(projectRoot, { dataDir: tempRoot });
  const port = await choosePort(Number(process.env.OPENCLAWX_API_PORT || '4333'));
  const baseUrl = `http://127.0.0.1:${port}/api`;
  const apiEntry = path.join(projectRoot, 'apps', 'api', 'dist', 'main.cjs');
  const loadtestEntry = path.join(projectRoot, 'scripts', 'concurrency-loadtest.mjs');

  const api = spawn(process.execPath, [apiEntry], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENCLAWX_DATA_DIR: runtime.dataDir,
      OPENCLAWX_API_HOST: '127.0.0.1',
      OPENCLAWX_API_PORT: String(port),
      OPENCLAWX_AGENT_ENGINE: 'agentscope',
      OPENCLAWX_AGENTSCOPE_ENABLED: '1',
      OPENCLAWX_AGENTSCOPE_ROOT: runtime.runtimeRoot,
      OPENCLAWX_AGENTSCOPE_PYTHON: runtime.python,
      OPENCLAWX_MAX_CONCURRENT_RUNS_GLOBAL: process.env.OPENCLAWX_MAX_CONCURRENT_RUNS_GLOBAL || '2',
      OPENCLAWX_MAX_CONCURRENT_RUNS_PER_USER: process.env.OPENCLAWX_MAX_CONCURRENT_RUNS_PER_USER || '1',
      OPENCLAWX_MAX_QUEUE_WAIT_MS: process.env.OPENCLAWX_MAX_QUEUE_WAIT_MS || '120000',
      OPENCLAWX_AGENTSCOPE_POOL_SIZE: process.env.OPENCLAWX_AGENTSCOPE_POOL_SIZE || '2',
      OPENCLAWX_AGENTSCOPE_SHARED_MAX_RUNS: process.env.OPENCLAWX_AGENTSCOPE_SHARED_MAX_RUNS || '1',
      OPENCLAWX_AGENTSCOPE_QUEUE_WAIT_MS: process.env.OPENCLAWX_AGENTSCOPE_QUEUE_WAIT_MS || '120000',
      OPENCLAWX_AGENTSCOPE_RESTART_COOLDOWN_MS: process.env.OPENCLAWX_AGENTSCOPE_RESTART_COOLDOWN_MS || '15000',
    },
  });

  let output = '';
  api.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  api.stderr.on('data', (chunk) => {
    output += String(chunk);
  });

  try {
    await waitForServer(baseUrl, { output: () => output });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [loadtestEntry], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          OPENCLAWX_LOADTEST_BASE_URL: baseUrl,
        },
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) {
          try {
            resolve(JSON.parse(stdout));
          } catch (error) {
            reject(new Error(`Failed to parse load test output: ${error instanceof Error ? error.message : String(error)}\n${stdout}`));
          }
        } else {
          reject(new Error(stderr || stdout || `Load test exited with code ${code}.`));
        }
      });
    });

    process.stdout.write(JSON.stringify({
      mode: 'openclawx-regression',
      cases: {
        dshMcpSkills,
        agentscopeSidecar: {
          mode: 'agentscope-sidecar-regression',
          baseUrl,
          dataDir: runtime.dataDir,
          env: {
            global: Number(process.env.OPENCLAWX_MAX_CONCURRENT_RUNS_GLOBAL || '2'),
            perUser: Number(process.env.OPENCLAWX_MAX_CONCURRENT_RUNS_PER_USER || '1'),
            dispatcherQueueWaitMs: Number(process.env.OPENCLAWX_MAX_QUEUE_WAIT_MS || '120000'),
            sidecarPoolSize: Number(process.env.OPENCLAWX_AGENTSCOPE_POOL_SIZE || '2'),
            sidecarMaxRuns: Number(process.env.OPENCLAWX_AGENTSCOPE_SHARED_MAX_RUNS || '1'),
            sidecarQueueWaitMs: Number(process.env.OPENCLAWX_AGENTSCOPE_QUEUE_WAIT_MS || '120000'),
            sidecarRestartCooldownMs: Number(process.env.OPENCLAWX_AGENTSCOPE_RESTART_COOLDOWN_MS || '15000'),
          },
          result,
        },
      },
    }, null, 2));
    process.stdout.write('\n');
  } finally {
    api.kill('SIGTERM');
    await sleep(500);
    if (!api.killed) api.kill('SIGKILL');
    rmSync(tempRoot, { recursive: true, force: true });
    if (output && process.env.OPENCLAWX_CONCURRENCY_REGRESSION_DEBUG === '1') {
      process.stderr.write(output);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
