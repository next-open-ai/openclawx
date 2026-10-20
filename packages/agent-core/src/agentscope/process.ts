import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { AgentscopeRpcClient } from './client.js';

export type AgentscopeSupervisorOptions = {
  pythonPath?: string;
  runtimeRoot?: string;
  host?: string;
  token?: string;
  /** Extra env for the child. */
  env?: NodeJS.ProcessEnv;
};

export type AgentscopeHandle = {
  port: number;
  token: string;
  url: string;
  process: ChildProcessByStdio<null, Readable, Readable>;
  client: AgentscopeRpcClient;
  activeRuns: () => number;
  stop: () => Promise<void>;
};

export interface SharedAgentscopeRunState {
  runId: string;
  sessionId?: string;
  userId?: string;
  state: 'queued' | 'running';
  waitReason?: 'capacity';
  queuedAt: number;
  startedAt?: number;
}

export interface SharedAgentscopeRuntimeStats {
  status: 'stopped' | 'running';
  limits: {
    poolSize: number;
    maxRuns: number;
    queueWaitMs: number;
    restartCooldownMs: number;
  };
  counts: {
    queued: number;
    activeRuns: number;
    sidecars: number;
    unhealthySidecars: number;
    coolingSidecars: number;
  };
  endpoints: Array<{
    id: string;
    port: number;
    url: string;
    activeRuns: number;
    status: 'running' | 'cooldown' | 'unhealthy' | 'stopped';
    lastError?: string;
    cooldownRemainingMs?: number;
  }>;
  runs: SharedAgentscopeRunState[];
}

function defaultRuntimeRoot(): string {
  // packages/agent-core/src/agentscope → ../../../../runtimes/agentscope-runtime
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../runtimes/agentscope-runtime');
}

function resolvePython(runtimeRoot: string, override?: string): string {
  if (override) return override;
  if (process.env.OPENCLAWX_AGENTSCOPE_PYTHON) return process.env.OPENCLAWX_AGENTSCOPE_PYTHON;
  const candidates = [
    path.join(runtimeRoot, '.venv', 'Scripts', 'python.exe'),
    path.join(runtimeRoot, '.venv', 'bin', 'python3'),
    path.join(runtimeRoot, '.venv', 'bin', 'python'),
    '/opt/homebrew/bin/python3.13',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

const PORT_WAIT_MS = process.platform === 'win32' ? 90_000 : 45_000;

function matchPortLine(line: string): number | null {
  const match = line.trim().match(/^OPENCLAWX_AGENTSCOPE_PORT=(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

/**
 * Spawn the Python Sidecar, wait for OPENCLAWX_AGENTSCOPE_PORT=, connect WS client, hello().
 */
export async function startAgentscopeRuntime(options: AgentscopeSupervisorOptions = {}): Promise<AgentscopeHandle> {
  const host = options.host ?? '127.0.0.1';
  const token = options.token ?? process.env.OPENCLAWX_AGENTSCOPE_TOKEN ?? randomBytes(16).toString('hex');
  const runtimeRoot = options.runtimeRoot ?? process.env.OPENCLAWX_AGENTSCOPE_ROOT ?? defaultRuntimeRoot();
  const python = resolvePython(runtimeRoot, options.pythonPath);
  const srcPath = path.join(runtimeRoot, 'src');

  const child = spawn(python, ['-m', 'openclawx_agentscope_runtime', '--host', host, '--port', '0', '--token', token], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      ...options.env,
      PYTHONPATH: [srcPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      OPENCLAWX_AGENTSCOPE_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let port = 0;
  const stderrTail: string[] = [];
  const portReady = new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (fn: (value: any) => void, value: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      const hint = stderrTail.length ? `\nstderr:\n${stderrTail.slice(-40).join('\n')}` : '';
      finish(reject, new Error(`AgentScope runtime did not publish port within ${PORT_WAIT_MS}ms${hint}`));
    }, PORT_WAIT_MS);
    const onLine = (line: string) => {
      const found = matchPortLine(line);
      if (found != null) finish(resolve, found);
    };
    createInterface({ input: child.stdout }).on('line', onLine);
    createInterface({ input: child.stderr }).on('line', (line) => {
      stderrTail.push(line);
      onLine(line);
      if (process.env.OPENCLAWX_AGENTSCOPE_DEBUG === '1') process.stderr.write(`[agentscope] ${line}\n`);
    });
    child.once('exit', (code) => {
      finish(reject, new Error(`AgentScope runtime exited early (code ${code ?? '?'})`));
    });
    child.once('error', (error) => {
      finish(reject, error);
    });
  });

  try {
    port = await portReady;
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }

  const url = `ws://${host}:${port}/v1/agent?token=${encodeURIComponent(token)}`;
  const client = new AgentscopeRpcClient(url);
  await client.connect();
  const hello = await client.hello();
  if (hello.protocolVersion !== '1') {
    client.close();
    child.kill('SIGTERM');
    throw new Error(`Unsupported AgentScope protocol ${hello.protocolVersion}`);
  }

  return {
    port,
    token,
    url,
    process: child,
    client,
    activeRuns: () => 0,
    stop: async () => {
      client.close();
      if (!child.killed) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 2_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}

type PooledHandle = {
  id: string;
  handle: AgentscopeHandle;
  activeRuns: number;
  status: 'running' | 'unhealthy' | 'stopped';
  lastError?: string;
  cooldownUntil?: number;
};

let shared: AgentscopeHandle | null = null;
const sharedPool: PooledHandle[] = [];
const sharedRunStates = new Map<string, SharedAgentscopeRunState>();

function runtimeSettingsFile(): string {
  const dataDir = process.env.OPENCLAWX_DATA_DIR || path.join(process.env.HOME || '/tmp', '.openclawx');
  return path.join(dataDir, 'runtime-settings.json');
}

function readRuntimeSettingNumber(key: 'sidecarSharedMaxRuns' | 'sidecarPoolSize' | 'sidecarQueueWaitMs'): number | null {
  try {
    const file = runtimeSettingsFile();
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { meta?: Record<string, unknown> };
      const stored = Number(parsed?.meta?.[key]);
      if (Number.isFinite(stored) && stored > 0) return Math.round(stored);
    }
  } catch {
    // Fall back to env/default on malformed settings files.
  }
  return null;
}

function sharedMaxRuns(): number {
  const stored = readRuntimeSettingNumber('sidecarSharedMaxRuns');
  if (stored) return stored;
  const raw = Number(process.env.OPENCLAWX_AGENTSCOPE_SHARED_MAX_RUNS || '');
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 8;
}

function sidecarPoolSize(): number {
  const stored = readRuntimeSettingNumber('sidecarPoolSize');
  if (stored) return stored;
  const raw = Number(process.env.OPENCLAWX_AGENTSCOPE_POOL_SIZE || '');
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 1;
}

function sidecarQueueWaitMs(): number {
  const stored = readRuntimeSettingNumber('sidecarQueueWaitMs');
  if (stored) return Math.max(5_000, stored);
  const raw = Number(process.env.OPENCLAWX_AGENTSCOPE_QUEUE_WAIT_MS || '');
  return Number.isFinite(raw) && raw > 0 ? Math.max(5_000, Math.round(raw)) : 120_000;
}

function sidecarRestartCooldownMs(): number {
  const raw = Number(process.env.OPENCLAWX_AGENTSCOPE_RESTART_COOLDOWN_MS || '');
  return Number.isFinite(raw) && raw > 0 ? Math.max(1_000, Math.round(raw)) : 15_000;
}

function runningPoolSize() {
  return sharedPool.filter((entry) => entry.status === 'running' && !entry.handle.process.killed).length;
}

function createPoolEntry(handle: AgentscopeHandle): PooledHandle {
  const entry: PooledHandle = {
    id: `sidecar-${sharedPool.length + 1}`,
    handle,
    activeRuns: 0,
    status: 'running',
  };
  handle.activeRuns = () => entry.activeRuns;
  handle.process.once('exit', (code) => {
    entry.status = 'stopped';
    entry.lastError = `process exited (${code ?? '?'})`;
    entry.cooldownUntil = Date.now() + sidecarRestartCooldownMs();
  });
  handle.process.once('error', (error) => {
    entry.status = 'unhealthy';
    entry.lastError = error.message;
    entry.cooldownUntil = Date.now() + sidecarRestartCooldownMs();
  });
  return entry;
}

async function recyclePoolIfNeeded() {
  const now = Date.now();
  for (let index = sharedPool.length - 1; index >= 0; index -= 1) {
    const entry = sharedPool[index];
    if (entry.activeRuns > 0) continue;
    const isHealthy = entry.status === 'running' && !entry.handle.process.killed;
    if (isHealthy) continue;
    if ((entry.cooldownUntil ?? 0) > now) continue;
    sharedPool.splice(index, 1);
    try {
      await entry.handle.stop();
    } catch {
      // Best-effort cleanup for retired sidecars.
    }
  }
}

async function ensureSharedAgentscopePool(options?: AgentscopeSupervisorOptions): Promise<PooledHandle[]> {
  await recyclePoolIfNeeded();
  const target = sidecarPoolSize();
  const idleRunningEntries = sharedPool.filter((entry) => entry.status === 'running' && !entry.handle.process.killed && entry.activeRuns === 0);
  while (runningPoolSize() > target && idleRunningEntries.length > 0) {
    const entry = idleRunningEntries.pop();
    if (!entry) break;
    entry.status = 'stopped';
    entry.lastError = 'scaled down to match target pool size';
    const index = sharedPool.indexOf(entry);
    if (index >= 0) sharedPool.splice(index, 1);
    try {
      await entry.handle.stop();
    } catch {
      // Best-effort cleanup while shrinking.
    }
  }
  while (runningPoolSize() < target) {
    const handle = await startAgentscopeRuntime(options);
    const entry = createPoolEntry(handle);
    sharedPool.push(entry);
  }
  shared = sharedPool[0]?.handle ?? null;
  return sharedPool;
}

function selectPoolEntry(): PooledHandle | null {
  const maxRuns = sharedMaxRuns();
  const candidates = sharedPool
    .filter((entry) => entry.status === 'running' && !entry.handle.process.killed && entry.activeRuns < maxRuns)
    .sort((left, right) => left.activeRuns - right.activeRuns);
  return candidates[0] ?? null;
}

export async function acquireSharedAgentscopeRunSlot(input: {
  runId: string;
  sessionId?: string;
  userId?: string;
  signal?: AbortSignal;
}): Promise<{ handle: AgentscopeHandle; release: () => void }> {
  const { runId, sessionId, userId, signal } = input;
  const state: SharedAgentscopeRunState = {
    runId,
    sessionId,
    userId,
    state: 'queued',
    waitReason: 'capacity',
    queuedAt: Date.now(),
  };
  sharedRunStates.set(runId, state);
  for (;;) {
    if (signal?.aborted) {
      sharedRunStates.delete(runId);
      const reason = signal.reason instanceof Error ? signal.reason.message : typeof signal.reason === 'string' ? signal.reason : 'AgentScope run aborted before dispatch.';
      throw new Error(reason);
    }
    if (Date.now() - state.queuedAt >= sidecarQueueWaitMs()) {
      sharedRunStates.delete(runId);
      throw new Error(`Run queued too long in sidecar pool (${sidecarQueueWaitMs()}ms).`);
    }
    await ensureSharedAgentscopePool();
    const entry = selectPoolEntry();
    if (entry) {
      entry.activeRuns += 1;
      state.state = 'running';
      state.waitReason = undefined;
      state.startedAt = state.startedAt ?? Date.now();
      return {
        handle: entry.handle,
        release: () => {
          entry.activeRuns = Math.max(0, entry.activeRuns - 1);
          sharedRunStates.delete(runId);
        },
      };
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 200);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        sharedRunStates.delete(runId);
        reject(signal.reason instanceof Error ? signal.reason : new Error(typeof signal.reason === 'string' ? signal.reason : 'AgentScope run aborted before dispatch.'));
      }, { once: true });
    });
  }
}

export function getSharedAgentscopeRuntimeStats(): SharedAgentscopeRuntimeStats {
  const runs = Array.from(sharedRunStates.values()).sort((left, right) => left.queuedAt - right.queuedAt);
  const maxRuns = sharedMaxRuns();
  const poolSize = sidecarPoolSize();
  const queueWaitMs = sidecarQueueWaitMs();
  const restartCooldownMs = sidecarRestartCooldownMs();
  const activeRuns = sharedPool.reduce((sum, entry) => sum + entry.activeRuns, 0);
  const runningSidecars = runningPoolSize();
  const now = Date.now();
  return {
    status: runningSidecars > 0 ? 'running' : 'stopped',
    limits: { poolSize, maxRuns, queueWaitMs, restartCooldownMs },
    counts: {
      queued: runs.filter((item) => item.state === 'queued').length,
      activeRuns,
      sidecars: runningSidecars,
      unhealthySidecars: sharedPool.filter((entry) => entry.status !== 'running' || entry.handle.process.killed).length,
      coolingSidecars: sharedPool.filter((entry) => (entry.cooldownUntil ?? 0) > now).length,
    },
    endpoints: sharedPool
      .map((entry) => ({
        id: entry.id,
        port: entry.handle.port,
        url: entry.handle.url,
        activeRuns: entry.activeRuns,
        status: entry.status === 'running' && !entry.handle.process.killed
          ? 'running'
          : (entry.cooldownUntil ?? 0) > now
            ? 'cooldown'
            : entry.status === 'unhealthy'
              ? 'unhealthy'
              : 'stopped',
        ...(entry.lastError ? { lastError: entry.lastError } : {}),
        ...((entry.cooldownUntil ?? 0) > now ? { cooldownRemainingMs: Math.max(0, entry.cooldownUntil! - now) } : {}),
      })),
    runs,
  };
}

export function markSharedAgentscopeHandleUnhealthy(handle: AgentscopeHandle, error: unknown) {
  const entry = sharedPool.find((item) => item.handle === handle);
  if (!entry) return;
  entry.status = 'unhealthy';
  entry.lastError = error instanceof Error ? error.message : String(error);
  entry.cooldownUntil = Date.now() + sidecarRestartCooldownMs();
}

/** Lazily start the first pooled Sidecar for compatibility callers. */
export async function ensureSharedAgentscopeRuntime(options?: AgentscopeSupervisorOptions): Promise<AgentscopeHandle> {
  const pool = await ensureSharedAgentscopePool(options);
  const first = pool[0]?.handle ?? null;
  if (!first) throw new Error('AgentScope sidecar pool failed to start.');
  shared = first;
  return first;
}

export async function stopSharedAgentscopeRuntime(): Promise<void> {
  if (!sharedPool.length) return;
  const handles = sharedPool.splice(0, sharedPool.length);
  shared = null;
  await Promise.all(handles.map((entry) => entry.handle.stop()));
}
