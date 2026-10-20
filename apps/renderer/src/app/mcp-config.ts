import { ref } from 'vue';
import { readStored, writeStored } from './storage';
import {
  BASELINE_MCPS,
  MCP_SEED_KEY,
  shouldProbeBaseline,
  type BaselineMcpSeed,
} from './baseline-mcps.js';
import { getServerMcpConnections, saveServerMcpConnections, testMcpConnection } from '../services/api.js';

export type McpKind = 'remote' | 'local';
export type McpTransport = 'http' | 'sse' | 'stdio';
export type McpLocalRunner = 'npx' | 'uvx' | 'custom';
export type McpTestStatus = 'never' | 'passed' | 'failed';

export interface McpConnection {
  id: string;
  name: string;
  kind: McpKind;
  transport: McpTransport;
  /** Remote HTTP/SSE endpoint */
  url?: string;
  /** Optional Bearer token for remote */
  apiKey?: string;
  /** Local stdio command (npx / uvx / custom binary) */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** UI hint for local launcher */
  runner?: McpLocalRunner;
  enabled: boolean;
  description?: string;
  /** Last connectivity probe result. */
  lastTestStatus?: McpTestStatus;
  lastTestAt?: number;
  lastTestMessage?: string;
  lastTestToolCount?: number;
  /** Tool catalog from the last successful probe. */
  lastTestTools?: Array<{ name: string; description?: string }>;
  updatedAt: number;
}

export type McpUpsertInput = Omit<
  McpConnection,
  'id' | 'updatedAt' | 'lastTestStatus' | 'lastTestAt' | 'lastTestMessage' | 'lastTestToolCount' | 'lastTestTools'
> & { id?: string };

const key = 'capabilities.mcp';
const connections = ref<McpConnection[]>([]);
const loaded = ref(false);

export function parseArgLines(text: string): string[] {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (k) env[k] = v;
  }
  return env;
}

export function formatEnvLines(env?: Record<string, string>) {
  return Object.entries(env || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export function resolveLocalCommand(runner: McpLocalRunner, customCommand?: string) {
  if (runner === 'npx') return 'npx';
  if (runner === 'uvx') return 'uvx';
  return String(customCommand || '').trim();
}

/** Portable MCP server JSON (Claude Desktop / Cursor style). */
export function toMcpServerJson(item: Pick<McpConnection, 'name' | 'kind' | 'transport' | 'url' | 'apiKey' | 'command' | 'args' | 'env' | 'cwd'>, options?: { maskSecrets?: boolean }) {
  const mask = options?.maskSecrets !== false;
  const keyName = item.name.trim() || 'mcp-server';
  if (item.kind === 'local' || item.transport === 'stdio') {
    const entry: Record<string, unknown> = {
      command: item.command || 'npx',
      args: item.args?.length ? item.args : [],
    };
    if (item.env && Object.keys(item.env).length) entry.env = item.env;
    if (item.cwd?.trim()) entry.cwd = item.cwd.trim();
    return { mcpServers: { [keyName]: entry } };
  }
  const entry: Record<string, unknown> = {
    type: item.transport === 'sse' ? 'sse' : 'http',
    url: item.url || '',
  };
  if (item.apiKey?.trim()) {
    entry.headers = {
      Authorization: mask ? 'Bearer ••••••••' : `Bearer ${item.apiKey.trim()}`,
    };
  }
  return { mcpServers: { [keyName]: entry } };
}

export function mcpSummaryLine(item: McpConnection) {
  if (item.kind === 'local' || item.transport === 'stdio') {
    const args = (item.args || []).join(' ');
    return [item.command || 'npx', args].filter(Boolean).join(' ').trim();
  }
  return item.url || '';
}

export function mcpTestPassed(item: McpConnection) {
  return item.lastTestStatus === 'passed';
}

function isRunnable(item: McpConnection) {
  if (!item.enabled) return false;
  if (item.kind === 'local' || item.transport === 'stdio') {
    return Boolean(item.command?.trim());
  }
  return Boolean(item.url?.trim());
}

/** Enabled + connectivity-tested connectors eligible for employee association. */
export function isAssociableMcp(item: McpConnection) {
  return isRunnable(item) && mcpTestPassed(item);
}

function normalizeTestStatus(value: unknown): McpTestStatus {
  return value === 'passed' || value === 'failed' ? value : 'never';
}

function normalizeOne(value: unknown): McpConnection | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<McpConnection> & { kind?: string };
  const id = String(raw.id || '').trim() || crypto.randomUUID();
  const name = String(raw.name || '').trim();
  if (!name) return null;

  const transportRaw = String(raw.transport || '');
  const kind: McpKind =
    raw.kind === 'local' || transportRaw === 'stdio'
      ? 'local'
      : raw.kind === 'remote'
        ? 'remote'
        : raw.url
          ? 'remote'
          : raw.command
            ? 'local'
            : 'remote';

  const testFields = {
    lastTestStatus: normalizeTestStatus(raw.lastTestStatus),
    lastTestAt: Number(raw.lastTestAt) || undefined,
    lastTestMessage: raw.lastTestMessage ? String(raw.lastTestMessage).slice(0, 500) : undefined,
    lastTestToolCount: Number.isFinite(Number(raw.lastTestToolCount)) ? Number(raw.lastTestToolCount) : undefined,
    lastTestTools: Array.isArray(raw.lastTestTools)
      ? raw.lastTestTools
          .map((entry) => {
            if (!entry || typeof entry !== 'object') return null;
            const name = String((entry as { name?: unknown }).name || '').trim();
            if (!name) return null;
            const description = (entry as { description?: unknown }).description
              ? String((entry as { description?: unknown }).description).slice(0, 400)
              : undefined;
            return { name, ...(description ? { description } : {}) };
          })
          .filter((entry): entry is { name: string; description?: string } => Boolean(entry))
          .slice(0, 80)
      : undefined,
  };

  if (kind === 'local') {
    const runner: McpLocalRunner =
      raw.runner === 'uvx' || raw.runner === 'custom' || raw.runner === 'npx'
        ? raw.runner
        : String(raw.command || '') === 'uvx'
          ? 'uvx'
          : String(raw.command || '') === 'npx'
            ? 'npx'
            : 'custom';
    const command = resolveLocalCommand(runner, raw.command);
    if (!command) return null;
    const args = Array.isArray(raw.args) ? raw.args.map((a) => String(a)).filter(Boolean).slice(0, 64) : [];
    const env =
      raw.env && typeof raw.env === 'object'
        ? Object.fromEntries(
            Object.entries(raw.env as Record<string, unknown>)
              .filter(([k, v]) => k && v != null)
              .map(([k, v]) => [String(k), String(v)])
              .slice(0, 64),
          )
        : {};
    return {
      id,
      name,
      kind: 'local',
      transport: 'stdio',
      command,
      args,
      env,
      cwd: raw.cwd ? String(raw.cwd) : '',
      runner,
      enabled: raw.enabled !== false,
      description: raw.description ? String(raw.description) : '',
      ...testFields,
      updatedAt: Number(raw.updatedAt) || Date.now(),
    };
  }

  const url = String(raw.url || '').trim();
  if (!url) return null;
  const transport: McpTransport = raw.transport === 'sse' ? 'sse' : 'http';
  return {
    id,
    name,
    kind: 'remote',
    transport,
    url,
    apiKey: raw.apiKey ? String(raw.apiKey) : '',
    enabled: raw.enabled !== false,
    description: raw.description ? String(raw.description) : '',
    ...testFields,
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function normalizeAll(value: unknown): McpConnection[] {
  if (Array.isArray(value)) return value.map(normalizeOne).filter((item): item is McpConnection => Boolean(item));
  if (!value || typeof value !== 'object') return [];
  const envelope = value as { meta?: unknown; secrets?: unknown };
  if (!Array.isArray(envelope.meta)) return [];
  const connections = (envelope.secrets && typeof envelope.secrets === 'object'
    ? (envelope.secrets as { connections?: unknown }).connections
    : undefined) as Record<string, { apiKey?: string; env?: Record<string, string> }> | undefined;
  return envelope.meta.map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const row = entry as Record<string, unknown>;
    const secret = connections?.[String(row.id || '')];
    return normalizeOne({ ...row, apiKey: secret?.apiKey || row.apiKey, env: secret?.env || row.env });
  }).filter((item): item is McpConnection => Boolean(item));
}

function configFingerprint(item: Pick<McpConnection, 'kind' | 'transport' | 'url' | 'apiKey' | 'command' | 'args' | 'env' | 'cwd'>) {
  return JSON.stringify({
    kind: item.kind,
    transport: item.transport,
    url: item.url || '',
    apiKey: item.apiKey || '',
    command: item.command || '',
    args: item.args || [],
    env: item.env || {},
    cwd: item.cwd || '',
  });
}

function toRuntime(item: McpConnection) {
  if (item.kind === 'local' || item.transport === 'stdio') {
    return {
      id: item.id,
      name: item.name,
      transport: 'stdio' as const,
      command: item.command || 'npx',
      args: item.args || [],
      env: item.env && Object.keys(item.env).length ? item.env : undefined,
      cwd: item.cwd?.trim() || undefined,
      enabled: true as const,
      description: item.description || undefined,
    };
  }
  return {
    id: item.id,
    name: item.name,
    url: item.url || '',
    transport: (item.transport === 'sse' ? 'sse' : 'http') as 'http' | 'sse',
    enabled: true as const,
    apiKey: item.apiKey?.trim() || undefined,
    description: item.description || undefined,
  };
}

export function useMcpConfig() {
  const load = async (options?: { force?: boolean }) => {
    if (loaded.value && !options?.force && connections.value.length > 0) return;
    const desktop = Boolean(window.openclawxDesktop);
    try {
      const stored = desktop
        ? JSON.parse((await readStored(key)) || '[]')
        : await getServerMcpConnections();
      connections.value = normalizeAll(stored);
    } catch {
      if (!loaded.value) connections.value = [];
    }
    loaded.value = true;
    if (desktop) await ensureBaselineMcps();
  };

  const persist = async () => {
    if (window.openclawxDesktop) await writeStored(key, JSON.stringify(connections.value));
    else await saveServerMcpConnections(connections.value);
  };

  /** Idempotent merge of built-in MCP connectors (does not overwrite user edits). */
  const ensureBaselineMcps = async () => {
    const seeded = await readStored(MCP_SEED_KEY);
    let changed = false;
    for (const seed of BASELINE_MCPS) {
      const existing = connections.value.find((item) => item.id === seed.id);
      if (existing) continue;
      const {
        requiresCredentials: _requiresCredentials,
        credentialEnvKeys: _credentialEnvKeys,
        credentialArgPlaceholders: _credentialArgPlaceholders,
        ...input
      } = seed;
      try {
        await upsert(input);
        changed = true;
      } catch {
        /* skip invalid seed */
      }
    }
    if (!seeded) await writeStored(MCP_SEED_KEY, 'true');
    return changed;
  };

  /**
   * Probe baseline / never-tested enabled MCPs and persist tools metadata.
   * Bounded concurrency so first launch does not stampede npx downloads.
   */
  const probeStartupMcps = async (options?: { concurrency?: number; timeoutMs?: number }) => {
    await load();
    const concurrency = Math.max(1, Math.min(3, options?.concurrency ?? 2));
    const timeoutMs = options?.timeoutMs ?? 60_000;
    const seedById = new Map(BASELINE_MCPS.map((item) => [item.id, item] as const));
    const queue = connections.value.filter((item) => {
      const seed = seedById.get(item.id);
      if (seed) return shouldProbeBaseline(seed, item);
      // Also probe other enabled never-tested connectors once.
      return item.enabled && item.lastTestStatus !== 'passed';
    });

    let index = 0;
    let passed = 0;
    let failed = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (index < queue.length) {
        const current = queue[index++];
        if (!current) break;
        try {
          const result = await testMcpConnection(toRuntime({ ...current, enabled: true }), timeoutMs);
          await recordTestResult(current.id, result);
          if (result.ok) passed += 1;
          else failed += 1;
        } catch (error) {
          await recordTestResult(current.id, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
          failed += 1;
        }
      }
    });
    await Promise.all(workers);
    return {
      total: queue.length,
      passed,
      failed,
    };
  };

  const list = () => connections.value;
  const enabled = () => connections.value.filter(isRunnable);
  const associable = () => connections.value.filter(isAssociableMcp);

  const upsert = async (input: McpUpsertInput) => {
    const id = input.id || crypto.randomUUID();
    const kind: McpKind = input.kind === 'local' || input.transport === 'stdio' ? 'local' : 'remote';
    const existing = connections.value.find((item) => item.id === id);
    let next: McpConnection;

    if (kind === 'local') {
      const runner: McpLocalRunner =
        input.runner === 'uvx' || input.runner === 'custom' || input.runner === 'npx' ? input.runner : 'npx';
      const command = resolveLocalCommand(runner, input.command);
      const args = Array.isArray(input.args) ? input.args.map((a) => String(a)).filter(Boolean).slice(0, 64) : [];
      const env =
        input.env && typeof input.env === 'object'
          ? Object.fromEntries(
              Object.entries(input.env)
                .filter(([k, v]) => k && v != null)
                .map(([k, v]) => [String(k), String(v)])
                .slice(0, 64),
            )
          : {};
      if (!String(input.name || '').trim()) throw new Error('MCP name is required.');
      if (!command) throw new Error('Local MCP command is required.');
      next = {
        id,
        name: String(input.name || '').trim(),
        kind: 'local',
        transport: 'stdio',
        command,
        args,
        env,
        cwd: input.cwd ? String(input.cwd).trim() : '',
        runner,
        enabled: input.enabled !== false,
        description: input.description ? String(input.description) : '',
        updatedAt: Date.now(),
      };
    } else {
      const url = String(input.url || '').trim();
      if (!String(input.name || '').trim() || !url) throw new Error('MCP name and URL are required.');
      try {
        new URL(url);
      } catch {
        throw new Error('MCP URL is invalid.');
      }
      next = {
        id,
        name: String(input.name || '').trim(),
        kind: 'remote',
        transport: input.transport === 'sse' ? 'sse' : 'http',
        url,
        apiKey: input.apiKey ? String(input.apiKey) : '',
        enabled: input.enabled !== false,
        description: input.description ? String(input.description) : '',
        updatedAt: Date.now(),
      };
    }

    const configChanged = !existing || configFingerprint(existing) !== configFingerprint(next);
    if (!configChanged && existing) {
      next.lastTestStatus = existing.lastTestStatus;
      next.lastTestAt = existing.lastTestAt;
      next.lastTestMessage = existing.lastTestMessage;
      next.lastTestToolCount = existing.lastTestToolCount;
      next.lastTestTools = existing.lastTestTools;
    } else {
      next.lastTestStatus = 'never';
      next.lastTestAt = undefined;
      next.lastTestMessage = undefined;
      next.lastTestToolCount = undefined;
      next.lastTestTools = undefined;
    }

    const index = connections.value.findIndex((item) => item.id === id);
    if (index >= 0) connections.value[index] = next;
    else connections.value = [next, ...connections.value];
    connections.value = [...connections.value];
    await persist();
    return next;
  };

  const remove = async (id: string) => {
    connections.value = connections.value.filter((item) => item.id !== id);
    await persist();
  };

  const setEnabled = async (id: string, enabledFlag: boolean) => {
    const item = connections.value.find((entry) => entry.id === id);
    if (!item) return;
    item.enabled = enabledFlag;
    item.updatedAt = Date.now();
    connections.value = [...connections.value];
    await persist();
  };

  const recordTestResult = async (
    id: string,
    result: {
      ok: boolean;
      toolCount?: number;
      toolNames?: string[];
      tools?: Array<{ name: string; description?: string }>;
      error?: string;
      durationMs?: number;
    },
  ) => {
    const item = connections.value.find((entry) => entry.id === id);
    if (!item) return;
    item.lastTestStatus = result.ok ? 'passed' : 'failed';
    item.lastTestAt = Date.now();
    item.lastTestToolCount = result.ok ? Number(result.toolCount) || 0 : undefined;
    item.lastTestTools = result.ok
      ? (Array.isArray(result.tools) && result.tools.length
          ? result.tools
          : (result.toolNames || []).map((name) => ({ name }))
        ).slice(0, 80)
      : undefined;
    item.lastTestMessage = result.ok
      ? `OK · ${item.lastTestToolCount ?? 0} tools · ${result.durationMs ?? 0}ms`
      : String(result.error || 'Probe failed.').slice(0, 500);
    item.updatedAt = Date.now();
    connections.value = [...connections.value];
    await persist();
    return item;
  };

  const byIds = (ids: string[]) => {
    const wanted = new Set(ids);
    return connections.value.filter((item) => wanted.has(item.id) && isAssociableMcp(item));
  };

  const runtimePayload = (ids?: string[]) => {
    // Auto-default: useful stdio MCPs, skip heavy browser automation unless explicitly selected.
    const AUTO_SKIP = new Set(['mcp-baseline-playwright', 'mcp-baseline-chrome-devtools']);
    const rows = ids?.length
      ? byIds(ids)
      : associable().filter((item) => !AUTO_SKIP.has(item.id));
    const rank = (id: string) => {
      if (id.includes('stock') || id.includes('akshare')) return 0;
      if (id.includes('fetch') || id.includes('memory')) return 1;
      return 2;
    };
    return [...rows].sort((a, b) => rank(a.id) - rank(b.id)).slice(0, 8).map(toRuntime);
  };

  return {
    connections,
    load,
    list,
    enabled,
    associable,
    upsert,
    remove,
    setEnabled,
    recordTestResult,
    byIds,
    runtimePayload,
    toRuntime,
    ensureBaselineMcps,
    probeStartupMcps,
  };
}

export type { BaselineMcpSeed };
