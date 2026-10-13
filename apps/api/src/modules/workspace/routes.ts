import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { unzipSync, zipSync } from 'fflate';
import { reconcileProjectOutputDirectory, storeAudioInput } from '@workmate/agent-core';

function dataDir(): string {
  return process.env.WORKMATE_DATA_DIR || path.join(os.homedir(), '.workmate');
}

function projectRoot(folder: string) {
  const root = path.resolve(String(folder || ''));
  if (!root || root === path.parse(root).root) throw new Error('Invalid project workspace.');
  return root;
}

type WorkspaceMetadata = { version: 1; kind: 'static-site' | 'files'; entrypoint: string | null; updatedAt: number };

function workspaceMetadataPath(root: string) {
  return path.join(projectRoot(root), '.workmate', 'project.json');
}

function refreshWorkspaceMetadata(root: string): WorkspaceMetadata {
  const base = projectRoot(root);
  const candidates = ['index.html', 'dist/index.html', 'public/index.html', 'output/index.html'];
  const entrypoint = candidates.find((relative) => {
    const candidate = path.join(base, ...relative.split('/'));
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  }) || null;
  const metadata: WorkspaceMetadata = {
    version: 1,
    kind: entrypoint ? 'static-site' : 'files',
    entrypoint,
    updatedAt: Date.now(),
  };
  const target = workspaceMetadataPath(base);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(metadata, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
  return metadata;
}

function managedProjectsRoot() {
  return path.join(dataDir(), 'projects');
}

function safeWorkspaceName(value: unknown) {
  const name = String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 64);
  return name || 'project';
}

function createManagedWorkspace(name: string) {
  const base = safeWorkspaceName(name);
  const target = path.join(managedProjectsRoot(), `${base}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  return { root: target };
}

function projectPath(root: string, relative: string) {
  const normalized = String(relative || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid project file path.');
  }
  const base = projectRoot(root);
  const target = path.resolve(base, normalized);
  if (!target.startsWith(`${base}${path.sep}`)) throw new Error('Project file is outside its workspace.');
  return target;
}

function listProjectFiles(root: string, directory = projectRoot(root), relative = '', depth = 0, result: Array<{ relative: string; type: 'directory' | 'file' }> = []) {
  if (depth > 8 || !fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === '.DS_Store'
      || entry.name === '.git'
      || entry.name === '.agents'
      || entry.name === '.dsh-sessions'
      || entry.name === '.workmate-dsh.cordis.yml'
      || entry.name === '.workmate'
      || entry.name === 'node_modules'
      || entry.name === '.python-packages'
    ) continue;
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push({ relative: childRelative, type: 'directory' });
      listProjectFiles(root, target, childRelative, depth + 1, result);
    } else if (entry.isFile() && fs.statSync(target).size <= 8 * 1024 * 1024) {
      result.push({ relative: childRelative, type: 'file' });
    }
  }
  return result;
}

function readProjectFile(root: string, relative: string) {
  const file = projectPath(root, relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Project file is unavailable.');
  return { relative, content: fs.readFileSync(file, 'utf8') };
}

/** Binary-safe read for spreadsheet import into the data workbench. */
export function readProjectFileBytes(root: string, relative: string) {
  const file = projectPath(root, relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Project file is unavailable.');
  return { relative, name: path.basename(file), content: fs.readFileSync(file) };
}

function writeProjectFile(root: string, relative: string, content: string) {
  const file = projectPath(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, String(content), { mode: 0o600 });
  refreshWorkspaceMetadata(root);
  return { relative, content: String(content) };
}

const DELIVERABLE_EXT = new Set(['html', 'htm', 'css', 'js', 'mjs', 'md', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'json', 'pdf', 'txt', 'csv', 'ico', 'woff', 'woff2', 'ttf']);
const INTERMEDIATE_DIRS = new Set(['tools', 'scripts', 'tmp', 'deps', '.python-packages', '__pycache__', 'node_modules']);

function isDeliverablePath(from: string) {
  const base = path.basename(from);
  if (INTERMEDIATE_DIRS.has(base)) return false;
  if (['.DS_Store', '.git'].includes(base)) return false;
  const parts = from.split(path.sep);
  if (parts.some((part) => INTERMEDIATE_DIRS.has(part))) return false;
  if (String(base).startsWith('.') && base !== '.gitkeep') return false;
  try {
    if (fs.existsSync(from) && fs.statSync(from).isDirectory()) return true;
  } catch {
    /* treat as file below */
  }
  const ext = path.extname(base).slice(1).toLowerCase();
  if (['py', 'sh', 'cjs', 'mjs', 'ts', 'tsx', 'jsx', 'map'].includes(ext)) return false;
  return DELIVERABLE_EXT.has(ext);
}

function resolveWorkspaceRunIds(runId: string) {
  const ids = new Set([String(runId)]);
  try {
    const domainPath = path.join(dataDir(), 'domain.json');
    if (!fs.existsSync(domainPath)) return [...ids];
    const domain = JSON.parse(fs.readFileSync(domainPath, 'utf8'));
    const raw = domain?.kv?.[`run:${runId}`];
    if (!raw) return [...ids];
    const run = typeof raw === 'string' ? JSON.parse(raw) : raw;
    for (const event of Array.isArray(run?.eventLog) ? run.eventLog : []) {
      if (event && typeof event.runId === 'string' && event.runId.trim()) ids.add(event.runId.trim());
    }
  } catch {
    /* best-effort recovery */
  }
  return [...ids];
}

function syncRunWorkspaceToProject(root: string, runId: string) {
  const target = projectRoot(root);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const id of resolveWorkspaceRunIds(runId)) {
    const source = path.join(dataDir(), 'workspaces', String(id));
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) continue;
    const copyTree = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const from = path.join(directory, entry.name);
        if (!isDeliverablePath(from)) continue;
        if (entry.isDirectory()) {
          copyTree(from);
          continue;
        }
        if (!entry.isFile()) continue;
        const sourceRelative = path.relative(source, from).split(path.sep).join('/');
        // output/ is the conversation/run delivery boundary, never a project
        // directory. Preserve all nested structure below that boundary.
        const projectRelative = sourceRelative.startsWith('output/')
          ? sourceRelative.slice('output/'.length)
          : sourceRelative;
        if (!projectRelative) continue;
        const destination = projectPath(target, projectRelative);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fs.copyFileSync(from, destination);
      }
    };
    copyTree(source);
  }
  refreshWorkspaceMetadata(target);
  return listProjectFiles(target);
}

function materializeProjectAssets(root: string, items: Array<{ assetId?: string; relativePath?: string; name?: string }>) {
  const targetRoot = projectRoot(root);
  for (const item of Array.isArray(items) ? items : []) {
    const rawRelative = String(item?.relativePath || item?.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const relative = rawRelative.startsWith('output/') ? rawRelative.slice('output/'.length) : rawRelative;
    if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) continue;
    const assetId = String(item?.assetId || '').trim();
    const assetFolder = assetId ? path.join(dataDir(), 'assets', assetId) : '';
    const source = assetFolder && fs.existsSync(assetFolder)
      ? fs.readdirSync(assetFolder)
        .map((name) => path.join(assetFolder, name))
        .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
      : null;
    if (!source || !fs.existsSync(source)) continue;
    const dest = projectPath(targetRoot, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, dest, 0);
  }
  refreshWorkspaceMetadata(targetRoot);
  return listProjectFiles(root);
}

function previewBinaryLimit(name: string) {
  if (/\.pdf$/i.test(name)) return 40 * 1024 * 1024;
  return /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(name) ? 12 * 1024 * 1024 : 2 * 1024 * 1024;
}

function safePreviewRelative(relative: string) {
  return String(relative || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function readProjectPreview(root: string, relative: string) {
  const file = projectPath(root, relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Project file is unavailable.');
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  if (size > previewBinaryLimit(name)) throw new Error('File is too large to preview.');
  const textLike = /\.(md|markdown|txt|html?|css|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|xml|svg|csv)$/i.test(name);
  if (textLike) {
    return { kind: 'text' as const, name, relative: safePreviewRelative(relative), content: fs.readFileSync(file, 'utf8'), bytes: size };
  }
  return { kind: 'binary' as const, name, relative: safePreviewRelative(relative), base64: fs.readFileSync(file).toString('base64'), bytes: size };
}

function projectFile(root: string, relative: string) {
  const file = projectPath(root, relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Project file is unavailable.');
  return file;
}

function contentTypeForFile(name: string) {
  const ext = path.extname(name).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.pdf': 'application/pdf',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
  } as Record<string, string>)[ext] || 'application/octet-stream';
}

function importWorkspaceZip(root: string, filename: string, base64: string) {
  const targetRoot = projectRoot(root);
  const zip = unzipSync(Buffer.from(String(base64 || '').trim(), 'base64'));
  const names = Object.keys(zip)
    .map((entry) => String(entry || '').replace(/\\/g, '/').replace(/^\/+/, ''))
    .filter((entry) => entry && !entry.includes('..'));
  let importedFiles = 0;
  for (const relative of names) {
    const bytes = zip[relative];
    if (!bytes || !bytes.length) continue;
    const dest = projectPath(targetRoot, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.writeFileSync(dest, Buffer.from(bytes), { mode: 0o600 });
    importedFiles += 1;
  }
  refreshWorkspaceMetadata(targetRoot);
  return { ok: true as const, source: filename, importedFiles, files: listProjectFiles(targetRoot) };
}

function exportWorkspaceZip(root: string) {
  const targetRoot = projectRoot(root);
  const entries: Record<string, Uint8Array> = {};
  for (const item of listProjectFiles(targetRoot)) {
    if (item.type !== 'file') continue;
    const file = projectPath(targetRoot, item.relative);
    entries[item.relative] = new Uint8Array(fs.readFileSync(file));
  }
  const zip = zipSync(entries, { level: 6 });
  return {
    ok: true as const,
    filename: `${path.basename(targetRoot)}.zip`,
    base64: Buffer.from(zip).toString('base64'),
  };
}

export const workspaceRoutes: FastifyPluginAsync = async (app) => {
  app.post('/workspace/audio-input', { bodyLimit: 36 * 1024 * 1024 }, async (request, reply) => {
    try { return await storeAudioInput(request.body); }
    catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) }); }
  });
  app.post('/workspace/create', async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      return createManagedWorkspace(String(body.name || 'project'));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/workspace/files', async (request, reply) => {
    const query = request.query && typeof request.query === 'object' ? (request.query as Record<string, unknown>) : {};
    try {
      return listProjectFiles(String(query.root || ''));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/workspace/info', async (request, reply) => {
    const query = request.query && typeof request.query === 'object' ? (request.query as Record<string, unknown>) : {};
    try {
      return refreshWorkspaceMetadata(String(query.root || ''));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/workspace/file', async (request, reply) => {
    const query = request.query && typeof request.query === 'object' ? (request.query as Record<string, unknown>) : {};
    try {
      return readProjectFile(String(query.root || ''), String(query.relative || ''));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/workspace/file', async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      return writeProjectFile(String(body.root || ''), String(body.relative || ''), String(body.content || ''));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/workspace/sync-run', async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      const { getOrchestrator } = await import('../orchestration/routes.js');
      const target = projectRoot(String(body.root || ''));
      const managed = (await getOrchestrator().projects.listProjects()).find(project => project.kind === 'conversation' && path.resolve(project.workspacePath) === target);
      if (managed) return reply.code(409).send({ message: '持续对话项目由服务端在成功后更新成果，不允许从历史运行目录回收覆盖' });
      return syncRunWorkspaceToProject(String(body.root || ''), String(body.runId || ''));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/workspace/normalize-layout', async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      const root = projectRoot(String(body.root || ''));
      const result = await reconcileProjectOutputDirectory(root);
      const files = listProjectFiles(root);
      const fileNames = new Set(files.filter((item) => item.type === 'file').map((item) => item.relative));
      const entrypoint = fileNames.has('index.html')
        ? 'index.html'
        : fileNames.has('output/index.html')
          ? 'output/index.html'
          : null;
      const metadata = refreshWorkspaceMetadata(root);
      return { ok: result.conflicts.length === 0, ...result, entrypoint: metadata.entrypoint || entrypoint, metadata, files };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/workspace/materialize-assets', async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      const items = Array.isArray(body.items) ? body.items as Array<{ assetId?: string; relativePath?: string; name?: string }> : [];
      return materializeProjectAssets(String(body.root || ''), items);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/workspace/preview', async (request, reply) => {
    const query = request.query && typeof request.query === 'object' ? (request.query as Record<string, unknown>) : {};
    try {
      return readProjectPreview(String(query.root || ''), String(query.relative || ''));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/workspace/content', async (request, reply) => {
    const query = request.query && typeof request.query === 'object' ? (request.query as Record<string, unknown>) : {};
    try {
      const root = String(query.root || '');
      const relative = String(query.relative || '');
      const file = projectFile(root, relative);
      const name = path.basename(file);
      reply.header('content-type', contentTypeForFile(name));
      reply.header('content-disposition', String(query.download || '') === '1' ? `attachment; filename="${encodeURIComponent(name)}"` : `inline; filename="${encodeURIComponent(name)}"`);
      return reply.send(fs.createReadStream(file));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/workspace/import-zip', async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      return importWorkspaceZip(String(body.root || ''), String(body.filename || 'workspace.zip'), String(body.base64 || ''));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/workspace/export-zip', async (request, reply) => {
    const query = request.query && typeof request.query === 'object' ? (request.query as Record<string, unknown>) : {};
    try {
      return exportWorkspaceZip(String(query.root || ''));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });
};
