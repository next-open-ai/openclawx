/**
 * Local static site preview / LAN deploy — long-lived HTTP servers.
 * - local (default): bind 127.0.0.1 (this machine only)
 * - lan: bind 0.0.0.0 so other devices on the same network can open the site
 * Runs inside the OpenClawX host (API) process so servers survive agent turns
 * and work when agent-core is bundled into a single main.cjs (no fork worker).
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { Type, defineAgentTool, type AgentTool } from './pi-tools.js';

const DEFAULT_PORT_HINT = 8000;
const MAX_PORT = 8099;
const LOOPBACK_HOST = '127.0.0.1';
const LAN_BIND_HOST = '0.0.0.0';

export type PreviewAccess = 'local' | 'lan';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

export type PreviewServerRecord = {
  id: string;
  /** Primary URL to open (loopback for local; first LAN IP for lan). */
  url: string;
  /** Always present: this-machine loopback URL. */
  localUrl: string;
  /** LAN URLs when access=lan (may be empty if no IPv4 NIC found). */
  lanUrls: string[];
  access: PreviewAccess;
  bindHost: string;
  port: number;
  root: string;
  rootRelative: string;
  pid: number;
  projectId?: string;
  startedAt: number;
  /** Where the served files come from. */
  source?: 'project' | 'asset-bundle' | 'workspace';
  assetId?: string;
};

type LivePreview = PreviewServerRecord & {
  server: http.Server;
};

const live = new Map<string, LivePreview>();

/**
 * Host-provided lookup for conversation SITE asset bundles
 * (`~/.openclawx/assets/<id>/files`). Registered by the API process.
 */
export type ConversationSiteBundleResolver = (conversationId: string) => Promise<{
  assetId: string;
  root: string;
  entryPath?: string;
} | null>;

let conversationSiteBundleResolver: ConversationSiteBundleResolver | null = null;

export function setConversationSiteBundleResolver(resolver: ConversationSiteBundleResolver | null): void {
  conversationSiteBundleResolver = resolver;
}

export function getConversationSiteBundleResolver(): ConversationSiteBundleResolver | null {
  return conversationSiteBundleResolver;
}

function normalizeRelative(value: string): string {
  const normalized = String(value || '.').replace(/\\/g, '/').replace(/^\/+/, '') || '.';
  if (normalized === '.') return '.';
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Preview root must be a safe relative path inside the workspace.');
  }
  return normalized;
}

async function resolvePreviewRoot(workspaceRoot: string, rootRelative: string): Promise<{ abs: string; relative: string }> {
  const root = path.resolve(workspaceRoot);
  const relative = normalizeRelative(rootRelative);
  const candidate = relative === '.' ? root : path.resolve(root, relative);
  let abs: string;
  try {
    abs = await realpath(candidate);
  } catch {
    throw new Error(`Preview root does not exist: ${relative}`);
  }
  const workspaceReal = await realpath(root).catch(() => root);
  const rel = path.relative(workspaceReal, abs).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Preview root is outside the authorized workspace.');
  }
  const info = await stat(abs);
  if (!info.isDirectory()) throw new Error(`Preview root is not a directory: ${relative}`);
  return { abs, relative: rel || '.' };
}

export async function listLanIPv4Addresses(): Promise<string[]> {
  const out: string[] = [];
  const nics = os.networkInterfaces();
  for (const entries of Object.values(nics)) {
    if (!entries) continue;
    for (const entry of entries) {
      const family = String(entry.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (entry.internal) continue;
      if (entry.address) out.push(entry.address);
    }
  }
  return [...new Set(out)];
}

function normalizeAccess(raw: unknown): PreviewAccess {
  return raw === 'lan' ? 'lan' : 'local';
}

function bindHostForAccess(access: PreviewAccess): string {
  return access === 'lan' ? LAN_BIND_HOST : LOOPBACK_HOST;
}

function urlsForAccess(access: PreviewAccess, port: number, lanIps: string[]): {
  url: string;
  localUrl: string;
  lanUrls: string[];
} {
  const localUrl = `http://${LOOPBACK_HOST}:${port}/`;
  const lanUrls = access === 'lan' ? lanIps.map((ip) => `http://${ip}:${port}/`) : [];
  return {
    localUrl,
    lanUrls,
    url: lanUrls[0] || localUrl,
  };
}

export async function findFreePort(hint = DEFAULT_PORT_HINT, max = MAX_PORT, bindHost = LOOPBACK_HOST): Promise<number> {
  const start = Math.min(max, Math.max(1, Math.round(Number(hint) || DEFAULT_PORT_HINT)));
  const livePorts = new Set([...live.values()].filter((row) => row.server.listening).map((row) => row.port));
  const probe = (port: number, host: string) => new Promise<boolean>((resolve) => {
    const server = createNetServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
  for (let port = start; port <= max; port += 1) {
    if (livePorts.has(port)) continue;
    // On macOS a loopback-only listener can be missed by an all-interface
    // probe. A LAN preview must own both the advertised local URL and the LAN
    // socket, otherwise 127.0.0.1 may display an unrelated existing site.
    const loopbackFree = bindHost === LAN_BIND_HOST ? await probe(port, LOOPBACK_HOST) : true;
    const free = loopbackFree && await probe(port, bindHost);
    if (free) return port;
  }
  throw new Error(`No free preview port between ${start} and ${max}.`);
}

function publicRecord(row: LivePreview): PreviewServerRecord {
  return {
    id: row.id,
    url: row.url,
    localUrl: row.localUrl,
    lanUrls: [...row.lanUrls],
    access: row.access,
    bindHost: row.bindHost,
    port: row.port,
    root: row.root,
    rootRelative: row.rootRelative,
    pid: row.pid,
    projectId: row.projectId,
    startedAt: row.startedAt,
    source: row.source,
    assetId: row.assetId,
  };
}

function findReusable(absRoot: string, access: PreviewAccess, projectId?: string): LivePreview | undefined {
  for (const row of live.values()) {
    if (row.root !== absRoot) continue;
    if (row.access !== access) continue;
    if (projectId && row.projectId && row.projectId !== projectId) continue;
    if (!row.server.listening) continue;
    return row;
  }
  return undefined;
}

function safeJoin(base: string, requestPath: string): string | null {
  const decoded = decodeURIComponent((requestPath || '/').split('?')[0] || '/');
  const rel = decoded.replace(/^\/+/, '');
  const candidate = path.resolve(base, rel || '.');
  const relative = path.relative(base, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return candidate;
}

function createStaticServer(rootAbs: string): http.Server {
  return http.createServer((req, res) => {
    try {
      const urlPath = req.url || '/';
      let target = safeJoin(rootAbs, urlPath);
      if (!target) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        target = path.join(target, 'index.html');
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      const ext = path.extname(target).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      const body = fs.readFileSync(target);
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error instanceof Error ? error.message : 'Server error');
    }
  });
}

function listen(server: http.Server, port: number, bindHost: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      resolve(address && typeof address === 'object' ? address.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, bindHost);
  });
}

export type StartPreviewServerInput = {
  workspaceRoot: string;
  root?: string;
  portHint?: number;
  projectId?: string;
  source?: PreviewServerRecord['source'];
  assetId?: string;
  /** local = this machine only; lan = same Wi‑Fi/LAN can open the site. */
  access?: PreviewAccess;
};

export async function startPreviewServer(input: StartPreviewServerInput): Promise<PreviewServerRecord & { ok: true; reused?: boolean }> {
  const access = normalizeAccess(input.access);
  const bindHost = bindHostForAccess(access);
  const { abs, relative } = await resolvePreviewRoot(input.workspaceRoot, input.root ?? '.');
  const existing = findReusable(abs, access, input.projectId);
  if (existing) {
    return { ok: true, reused: true, ...publicRecord(existing) };
  }

  const port = await findFreePort(input.portHint ?? DEFAULT_PORT_HINT, MAX_PORT, bindHost);
  const id = randomUUID();
  const server = createStaticServer(abs);
  try {
    const bound = await listen(server, port, bindHost);
    const lanIps = access === 'lan' ? await listLanIPv4Addresses() : [];
    const urls = urlsForAccess(access, bound, lanIps);
    const record: LivePreview = {
      id,
      ...urls,
      access,
      bindHost,
      port: bound,
      root: abs,
      rootRelative: relative,
      pid: process.pid,
      projectId: input.projectId,
      startedAt: Date.now(),
      source: input.source,
      assetId: input.assetId,
      server,
    };
    live.set(id, record);
    server.on('close', () => {
      if (live.get(id)?.server === server) live.delete(id);
    });
    return { ok: true, reused: false, ...publicRecord(record) };
  } catch (error) {
    server.close();
    throw error;
  }
}

export async function stopPreviewServer(input: {
  id?: string;
  port?: number;
  /** When no id/port: stop all listening servers (optionally limited to projectId / assetId). */
  all?: boolean;
  projectId?: string;
  assetId?: string;
}): Promise<{ ok: true; stopped: number }> {
  const targets: LivePreview[] = [];
  if (input.id) {
    const row = live.get(input.id);
    if (row) targets.push(row);
  } else if (typeof input.port === 'number') {
    for (const row of live.values()) {
      if (row.port === input.port) targets.push(row);
    }
  } else if (input.assetId) {
    const assetId = String(input.assetId);
    for (const row of live.values()) {
      if (!row.server.listening) continue;
      if (row.assetId !== assetId) continue;
      targets.push(row);
    }
  } else if (input.projectId) {
    const projectId = String(input.projectId);
    for (const row of live.values()) {
      if (!row.server.listening) continue;
      if (row.projectId !== projectId) continue;
      targets.push(row);
    }
  } else if (input.all !== false) {
    // Default: stop every matching live server (close preview / close local deploy).
    for (const row of live.values()) {
      if (!row.server.listening) continue;
      if (input.projectId && row.projectId && row.projectId !== input.projectId) continue;
      targets.push(row);
    }
  } else {
    throw new Error('Provide id or port to stop a preview server.');
  }

  let stopped = 0;
  await Promise.all(targets.map(async (row) => {
    live.delete(row.id);
    await new Promise<void>((resolve) => {
      row.server.close(() => resolve());
      // Force-close lingering keep-alive sockets after a beat.
      setTimeout(() => resolve(), 500).unref?.();
    });
    stopped += 1;
  }));
  return { ok: true, stopped };
}

export function listPreviewServers(filter?: { projectId?: string; assetId?: string }): PreviewServerRecord[] {
  const rows = [...live.values()]
    .filter((row) => row.server.listening)
    .filter((row) => !filter?.projectId || row.projectId === filter.projectId)
    .filter((row) => !filter?.assetId || row.assetId === filter.assetId)
    .map(publicRecord);
  return rows.sort((a, b) => a.port - b.port);
}

/** Test helper — stop every live preview. */
export async function stopAllPreviewServers(): Promise<void> {
  const ids = [...live.keys()];
  for (const id of ids) {
    await stopPreviewServer({ id }).catch(() => undefined);
  }
}

/**
 * Prefer an existing site directory that already has index.html.
 * Avoids agents inventing empty output/ when the site lives at project root.
 */
export async function suggestPreviewRoot(workspaceRoot: string): Promise<string> {
  const candidates = ['dist', 'bundle', 'out', 'build', 'output', '.'];
  for (const rel of candidates) {
    try {
      const { abs } = await resolvePreviewRoot(workspaceRoot, rel);
      if (fs.existsSync(path.join(abs, 'index.html'))) return rel;
    } catch {
      // try next
    }
  }
  return '.';
}

function hasIndexHtml(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, 'index.html')) && fs.statSync(path.join(dir, 'index.html')).isFile();
  } catch {
    return false;
  }
}

export function createPreviewServerTools(input: {
  workspaceRoot: string;
  workspaceAccess?: 'read' | 'write' | 'full';
  /** Project mode: serve from the project directory. */
  projectId?: string;
  /** Conversation mode: map to the session SITE asset bundle. */
  conversationId?: string;
  workspaceMode?: 'conversation' | 'project';
}): AgentTool[] {
  const canRun = input.workspaceAccess === 'write' || input.workspaceAccess === 'full' || !input.workspaceAccess;
  const denied = () => ({ ok: false as const, error: 'Preview server is not permitted for this run.' });
  const isProject = input.workspaceMode === 'project' || Boolean(input.projectId);

  const resolveAndStart = async (params: { root?: string; portHint?: number; access?: PreviewAccess }) => {
    const access = normalizeAccess(params.access);
    if (isProject) {
      const root = params.root?.trim() || '.';
      const abs = root === '.'
        ? input.workspaceRoot
        : path.resolve(input.workspaceRoot, root);
      if (!hasIndexHtml(abs)) {
        return {
          ok: false as const,
          error:
            'No index.html found at the project workspace root. '
            + 'Do NOT rebuild for a preview-only request — tell the user the project has no previewable site yet.',
        };
      }
      return await startPreviewServer({
        workspaceRoot: input.workspaceRoot,
        root,
        portHint: params.portHint,
        projectId: input.projectId,
        source: 'project',
        access,
      });
    }

    const conversationId = String(input.conversationId || '').trim();
    const resolver = getConversationSiteBundleResolver();
    if (conversationId && resolver) {
      const bundle = await resolver(conversationId);
      if (bundle?.root && hasIndexHtml(bundle.root)) {
        return await startPreviewServer({
          workspaceRoot: bundle.root,
          root: '.',
          portHint: params.portHint,
          source: 'asset-bundle',
          assetId: bundle.assetId,
          access,
        });
      }
    }

    const root = params.root?.trim() || await suggestPreviewRoot(input.workspaceRoot);
    const abs = root === '.'
      ? input.workspaceRoot
      : path.resolve(input.workspaceRoot, root);
    if (!hasIndexHtml(abs)) {
      return {
        ok: false as const,
        error:
          'No SITE asset bundle found for this conversation, and the current run workspace has no index.html. '
          + 'Do NOT rebuild for a preview-only request. Tell the user there is no archived website bundle to preview yet.',
      };
    }
    return await startPreviewServer({
      workspaceRoot: input.workspaceRoot,
      root,
      portHint: params.portHint,
      source: 'workspace',
      access,
    });
  };

  return [
    defineAgentTool({
      name: 'preview_server_start',
      label: 'preview_server_start',
      description:
        'Start a static website server (ports from 8000). '
        + 'access=local (default): bind 127.0.0.1 for this-machine preview only. '
        + 'access=lan: local/LAN deploy — bind 0.0.0.0 so other devices on the same network can open the site; returns url + lanUrls + localUrl. '
        + 'Use access=lan when the user says 本地部署 / 局域网部署 / share on Wi‑Fi. '
        + 'Conversation mode maps the session SITE asset-bundle directory; project mode maps the project workspace root. '
        + 'For preview/deploy requests: ONLY call this tool — do NOT rebuild or use bash http.server.',
      parameters: Type.Object({
        root: Type.Optional(Type.String({
          minLength: 1,
          maxLength: 240,
          description: 'Optional relative subdirectory under the mapped root. Project mode defaults to the project root (".").',
        })),
        access: Type.Optional(Type.Union([
          Type.Literal('local'),
          Type.Literal('lan'),
        ], {
          description: 'local = preview on this machine (127.0.0.1). lan = 本地部署 / LAN multi-device (0.0.0.0).',
        })),
        portHint: Type.Optional(Type.Number({ minimum: 8000, maximum: 8099 })),
      }),
      execute: async (params) => {
        if (!canRun) return denied();
        try {
          return await resolveAndStart({
            root: params.root,
            portHint: params.portHint,
            access: params.access,
          });
        } catch (error) {
          return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
        }
      },
    }),
    defineAgentTool({
      name: 'preview_server_stop',
      label: 'preview_server_stop',
      description:
        'Stop local website preview / 本地部署 / LAN deploy servers. '
        + 'Use for 关闭本地部署、关闭预览、关闭本地网站、停止部署. '
        + 'Pass id or port to stop one; omit both to stop all current site servers.',
      parameters: Type.Object({
        id: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
        port: Type.Optional(Type.Number({ minimum: 1, maximum: 65535 })),
      }),
      execute: async (params) => {
        if (!canRun) return denied();
        try {
          return await stopPreviewServer({
            id: params.id,
            port: params.port,
            all: true,
            projectId: input.projectId,
          });
        } catch (error) {
          return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
        }
      },
    }),
    defineAgentTool({
      name: 'preview_server_status',
      label: 'preview_server_status',
      description: 'List running preview / LAN deploy servers (url, access, port, root, source).',
      parameters: Type.Object({}),
      execute: async () => {
        if (!canRun) return denied();
        const servers = listPreviewServers({ projectId: input.projectId });
        return { ok: true as const, servers };
      },
    }),
  ];
}
