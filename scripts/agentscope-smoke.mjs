#!/usr/bin/env node
/**
 * Protocol smoke: spawn Python Sidecar → hello/health → stub echo run → collect AgentEvents.
 * Usage: node scripts/agentscope-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(root, 'runtimes/agentscope-runtime');
const srcPath = path.join(runtimeRoot, 'src');
const token = randomBytes(12).toString('hex');
/** Cold import of agentscope+deps on Windows CI can exceed 12s after a fresh venv install. */
const PORT_WAIT_MS = process.platform === 'win32' ? 90_000 : 45_000;

function bundledPython() {
  return process.platform === 'win32'
    ? path.join(runtimeRoot, 'python', 'python.exe')
    : path.join(runtimeRoot, 'python', 'bin', 'python3');
}

function ensureRuntimePrepared() {
  const python = bundledPython();
  if (fs.existsSync(python)) return python;
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'prepare-agentscope-runtime.mjs')], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0 || !fs.existsSync(python)) {
    throw new Error('Failed to prepare AgentScope runtime for smoke test.');
  }
  return python;
}

function resolvePython() {
  const venvPy = ensureRuntimePrepared();
  if (fs.existsSync(venvPy)) return venvPy;
  if (process.env.OPENCLAWX_AGENTSCOPE_PYTHON) return process.env.OPENCLAWX_AGENTSCOPE_PYTHON;
  return process.platform === 'win32' ? 'python' : 'python3';
}

const python = resolvePython();

function matchPortLine(line) {
  const m = String(line).trim().match(/^OPENCLAWX_AGENTSCOPE_PORT=(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

function rpc(ws, method, params) {
  const id = `${method}-${Date.now()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 15_000);
    const onMessage = (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'));
      else resolve(msg.result);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }));
  });
}

async function main() {
  // Fail fast with a clear import error instead of a opaque "no port" timeout.
  // Also warms the Windows CI disk cache after a fresh pip install.
  const warm = spawnSync(
    python,
    ['-c', 'import openclawx_agentscope_runtime; print("agentscope-runtime-import-ok", flush=True)'],
    {
      cwd: runtimeRoot,
      env: {
        ...process.env,
        PYTHONPATH: [srcPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      encoding: 'utf8',
      timeout: PORT_WAIT_MS,
      windowsHide: true,
    },
  );
  if (warm.status !== 0) {
    throw new Error(
      `AgentScope runtime import failed (exit ${warm.status})\n${warm.stdout || ''}\n${warm.stderr || ''}`,
    );
  }
  process.stderr.write(`${(warm.stdout || '').trim() || 'agentscope-runtime-import-ok'}\n`);

  const stdoutLines = [];
  const stderrLines = [];
  const child = spawn(python, ['-m', 'openclawx_agentscope_runtime', '--host', '127.0.0.1', '--port', '0', '--token', token], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      PYTHONPATH: [srcPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const port = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      const tail = [
        stdoutLines.length ? `stdout:\n${stdoutLines.slice(-20).join('\n')}` : 'stdout: (empty)',
        stderrLines.length ? `stderr:\n${stderrLines.slice(-40).join('\n')}` : 'stderr: (empty)',
      ].join('\n');
      finish(reject, new Error(`no port within ${PORT_WAIT_MS}ms\n${tail}`));
    }, PORT_WAIT_MS);

    const onLine = (line, sink) => {
      sink.push(line);
      const found = matchPortLine(line);
      if (found != null) finish(resolve, found);
    };

    createInterface({ input: child.stdout }).on('line', (line) => onLine(line, stdoutLines));
    createInterface({ input: child.stderr }).on('line', (line) => {
      onLine(line, stderrLines);
      process.stderr.write(`${line}\n`);
    });
    child.once('exit', (code) => {
      const tail = stderrLines.slice(-20).join('\n');
      finish(reject, new Error(`exit ${code}${tail ? `\n${tail}` : ''}`));
    });
    child.once('error', (error) => finish(reject, error));
  });

  const url = `ws://127.0.0.1:${port}/v1/agent?token=${token}`;
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const hello = await rpc(ws, 'runtime.hello', { clientVersion: 'smoke', protocolVersion: '1' });
  const health = await rpc(ws, 'runtime.health', {});
  console.log('hello', hello);
  console.log('health', health);

  const events = [];
  let finished = null;
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.method === 'agent.event') events.push(msg.params.event);
    if (msg.method === 'agent.run.finished') finished = msg.params;
  });

  const started = await rpc(ws, 'agent.run.start', {
    runId: 'smoke-run-1',
    messages: [{ role: 'user', content: '你好，OpenClawX' }],
    profile: { id: 'general', name: 'General', instructions: 'hi', toolIds: [] },
    model: { provider: 'openai', chatModel: 'gpt-test', apiKey: 'x' },
  });
  console.log('start', started);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('run timeout')), 15_000);
    const tick = setInterval(() => {
      if (finished) { clearInterval(tick); clearTimeout(timer); resolve(); }
    }, 50);
  });

  const deltas = events.filter((e) => e.type === 'message.delta').map((e) => e.text).join('');
  console.log('events', events.map((e) => e.type).join(' → '));
  console.log('text', deltas);
  console.log('finished', finished);

  if (!deltas.includes('OpenClawX')) throw new Error('unexpected stub text');
  if (finished?.status !== 'completed') throw new Error('run not completed');

  ws.close();
  child.kill();
  console.log('agentscope smoke OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
