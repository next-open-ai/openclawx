import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyPluginAsync } from 'fastify';
import { unzipSync, strFromU8 } from 'fflate';
import { authenticateRequest, requireAdmin, requireAuth, sendAuthError } from '../auth/service.js';

const execFileAsync = promisify(execFile);

function dataDir(): string {
  return process.env.OPENCLAWX_DATA_DIR || path.join(os.homedir(), '.openclawx');
}

function skillsRoot(): string {
  return path.join(dataDir(), 'skills');
}

function withoutAnsi(value: unknown) {
  return String(value || '')
    .replace(/\x1B(?:\][^\x07]*(?:\x07|\x1B\\)|\[[0-?]*[ -\/]*[@-~])/g, '')
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function skillsSearchError(value: string) {
  const clean = withoutAnsi(value).replace(/[^\p{L}\p{N}\s:.,/@_\-()[\]]/gu, '').slice(-500);
  return clean ? `Skills.sh 搜索暂不可用：${clean}` : 'Skills.sh 搜索暂不可用。请稍后重试，或直接在 skills.sh 浏览技能。';
}

function safeSkillName(value: unknown) {
  const name = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('Invalid skill name.');
  return name;
}

function normalizeSkillSource(value: unknown) {
  const source = String(value || '').trim();
  if (!source) throw new Error('Missing skill reference.');
  if (source.startsWith('https://')) return source;
  return source.replace(/^npm:/, '');
}

function readSkillManifest(file: string) {
  return { path: file, content: fs.readFileSync(file, 'utf8') };
}

function skillsPath(file: string) {
  const root = path.resolve(skillsRoot());
  const target = path.resolve(file);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Skill file is unavailable.');
  return target;
}

function skillDirectoryForName(name: string) {
  return path.join(skillsRoot(), safeSkillName(name));
}

function listSkillFiles(rootFile: string) {
  const manifest = skillsPath(rootFile);
  const root = path.dirname(manifest);
  const visit = (folder: string, depth = 0, items: Array<{ path: string; relative: string; type: 'directory' | 'file' }> = []) => {
    if (depth > 8 || !fs.existsSync(folder)) return items;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const target = path.join(folder, entry.name);
      const relative = path.relative(root, target).split(path.sep).join('/');
      if (!relative) continue;
      if (entry.isDirectory()) {
        items.push({ path: target, relative, type: 'directory' });
        visit(target, depth + 1, items);
      } else if (entry.isFile()) {
        items.push({ path: target, relative, type: 'file' });
      }
    }
    return items;
  };
  return visit(root);
}

function readSkillFile(file: string) {
  const target = skillsPath(file);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('Skill file is unavailable.');
  return { path: target, content: fs.readFileSync(target, 'utf8') };
}

function writeSkillFile(file: string, content: string) {
  const target = skillsPath(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, content, { mode: 0o600 });
  return { path: target, content };
}

function writeSkillDraft(value: { name?: unknown; content?: unknown }) {
  const name = safeSkillName(value.name);
  const content = String(value.content || '').trim();
  if (!content) throw new Error('SKILL.md content is required.');
  const root = skillDirectoryForName(name);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'SKILL.md');
  fs.writeFileSync(file, content, { mode: 0o600 });
  return { path: file, content };
}

function deleteManagedSkill(file: string) {
  const manifest = skillsPath(file);
  const root = path.dirname(manifest);
  if (!fs.existsSync(root)) return false;
  fs.rmSync(root, { recursive: true, force: true });
  return true;
}

function normalizeZipEntry(entry: string) {
  const normalized = String(entry || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..')) throw new Error(`Illegal zip path: ${entry}`);
  return normalized;
}

function importSkillZipArchive(input: { filename?: unknown; base64?: unknown }) {
  const filename = String(input.filename || 'skill.zip').trim() || 'skill.zip';
  const base64 = String(input.base64 || '').trim();
  if (!base64) throw new Error('Missing zip file content.');
  const zip = unzipSync(Buffer.from(base64, 'base64'));
  const names = Object.keys(zip).map(normalizeZipEntry).filter(Boolean);
  const manifestEntry = names.find((name) => path.posix.basename(name) === 'SKILL.md');
  if (!manifestEntry) throw new Error('Zip archive must contain SKILL.md.');
  const manifestDir = path.posix.dirname(manifestEntry);
  const manifestContent = strFromU8(zip[manifestEntry]);
  const name = manifestName(manifestContent);
  if (!name) throw new Error('SKILL.md must include name and description frontmatter.');
  const targetRoot = skillDirectoryForName(name);
  const targetManifest = path.join(targetRoot, 'SKILL.md');
  if (fs.existsSync(targetManifest)) throw new Error(`A local skill with this name already exists: ${name}`);
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  let copiedFiles = 0;
  for (const nameInZip of names) {
    if (manifestDir !== '.' && !nameInZip.startsWith(`${manifestDir}/`) && nameInZip !== manifestEntry) continue;
    const relative = manifestDir === '.' ? nameInZip : nameInZip.slice(manifestDir.length + 1);
    if (!relative) continue;
    const target = path.join(targetRoot, relative.split('/').join(path.sep));
    const bytes = zip[nameInZip];
    if (!bytes || !bytes.length) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, Buffer.from(bytes), { mode: 0o600 });
    copiedFiles += 1;
  }
  return {
    manifest: readSkillManifest(targetManifest),
    importedFiles: copiedFiles,
    source: filename,
  };
}

function manifestName(content: string): string | null {
  const match = String(content || '').match(/^name:\s*(.+)$/mi);
  return match ? safeSkillName(match[1].replace(/^['"]|['"]$/g, '').trim()) : null;
}

function findSkillManifests(directory: string, depth = 0, matches: Array<{ path: string; content: string }> = []) {
  if (depth > 5) return matches;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) findSkillManifests(target, depth + 1, matches);
    else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') matches.push(readSkillManifest(target));
  }
  return matches;
}

async function enrichRegistryItem(item: { reference: string; source: string; slug: string; name: string; description: string; installs: string; url: string }) {
  try {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return item;
    const html = await response.text();
    const encoded = html.match(/"description":"((?:\\.|[^"\\])+)"/)?.[1];
    const description = encoded ? JSON.parse(`"${encoded}"`) : '';
    return { ...item, description: String(description).trim().slice(0, 420) };
  } catch {
    return item;
  }
}

function findManifest(directory: string, skillName: string | null) {
  const visit = (folder: string, depth: number): { path: string; content: string } | null => {
    if (depth > 5) return null;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        const found = visit(target, depth + 1);
        if (found) return found;
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        const manifest = readSkillManifest(target);
        if (!skillName || new RegExp(`^name:\\s*${skillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi').test(manifest.content)) {
          return manifest;
        }
      }
    }
    return null;
  };
  return visit(directory, 0);
}

async function runSkillsCli(reference: string) {
  const source = normalizeSkillSource(reference);
  const directory = skillsRoot();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  try {
    const { stdout, stderr } = await execFileAsync(command, ['skills', 'add', source, '--yes'], {
      cwd: directory,
      timeout: 120_000,
      windowsHide: true,
    });
    const manifest = findManifest(directory, source.includes('@') ? source.split('@').pop() || null : null);
    return { manifest, output: withoutAnsi(stdout || stderr).slice(-1000) };
  } catch (error) {
    const row = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(withoutAnsi(row.stderr || row.stdout || row.message || error).slice(-2000));
  }
}

async function importGitSkillRepository(value: string) {
  const source = normalizeSkillSource(value);
  if (!source.startsWith('https://')) throw new Error('Use an HTTPS Git repository URL.');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-skill-'));
  const checkout = path.join(temporaryRoot, 'repository');
  try {
    await execFileAsync('git', ['clone', '--depth', '1', source, checkout], { timeout: 120_000, windowsHide: true });
    const imported: Array<{ path: string; content: string }> = [];
    const skipped: string[] = [];
    for (const manifest of findSkillManifests(checkout)) {
      const name = manifestName(manifest.content);
      if (!name) {
        skipped.push(path.dirname(manifest.path));
        continue;
      }
      const targetFolder = path.join(skillsRoot(), name);
      const target = path.join(targetFolder, 'SKILL.md');
      if (fs.existsSync(target)) {
        skipped.push(name);
        continue;
      }
      fs.mkdirSync(targetFolder, { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, manifest.content, { mode: 0o600 });
      for (const resource of ['scripts', 'references', 'assets', 'agents']) {
        const sourceFolder = path.join(path.dirname(manifest.path), resource);
        if (fs.existsSync(sourceFolder)) fs.cpSync(sourceFolder, path.join(targetFolder, resource), { recursive: true, force: false });
      }
      imported.push(readSkillManifest(target));
    }
    if (!imported.length) throw new Error('No new valid SKILL.md file was found in this repository.');
    return { manifests: imported, skipped };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function findSkills(query: string) {
  const value = String(query || '').trim();
  if (!value || value.length > 120) throw new Error('Enter a short skill search query.');
  let response: Response;
  try {
    response = await fetch(`https://skills.sh/api/search?${new URLSearchParams({ q: value, limit: '20' })}`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new Error(skillsSearchError(cause instanceof Error ? cause.message : String(cause)));
  }
  if (!response.ok) throw new Error(`Skills.sh 搜索暂不可用（HTTP ${response.status}）。请稍后重试或在 skills.sh 浏览。`);
  const data = await response.json();
  const rawSkills = Array.isArray((data as { skills?: unknown[] }).skills) ? (data as { skills?: unknown[] }).skills! : [];
  const items = await Promise.all(rawSkills.map(async (skill) => {
    const row = skill && typeof skill === 'object' ? (skill as Record<string, unknown>) : {};
    const source = String(row.source || '');
    const name = String(row.name || '');
    const slug = String(row.id || '');
    const installs = Number(row.installs || 0);
    const formattedInstalls = installs >= 1_000_000
      ? `${(installs / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
      : installs >= 1_000
        ? `${(installs / 1_000).toFixed(1).replace(/\.0$/, '')}K`
        : installs ? String(installs) : '';
    return enrichRegistryItem({
      reference: source && name ? `${source}@${name}` : slug,
      source,
      slug,
      name: name || slug.split('/').pop() || 'Skill',
      description: '',
      installs: formattedInstalls,
      url: `https://skills.sh/${slug}`,
    });
  }));
  return { items, hasMore: false };
}

export const skillRoutes: FastifyPluginAsync = async (app) => {
  const ensureAuth = (request: Parameters<typeof requireAuth>[0]) => {
    request.auth = authenticateRequest(request);
  };

  app.get('/skills/files', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAuth(request);
      const root = request.query && typeof request.query === 'object' ? String((request.query as Record<string, unknown>).root || '') : '';
      return { items: listSkillFiles(root) };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get('/skills/file', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAuth(request);
      const file = request.query && typeof request.query === 'object' ? String((request.query as Record<string, unknown>).path || '') : '';
      return readSkillFile(file);
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post('/skills/draft', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAdmin(request);
      const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
      return writeSkillDraft({ name: body.name, content: body.content });
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.put('/skills/file', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAdmin(request);
      const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
      return writeSkillFile(String(body.path || ''), String(body.content || ''));
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.delete('/skills', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAdmin(request);
      const file = request.query && typeof request.query === 'object' ? String((request.query as Record<string, unknown>).path || '') : '';
      return { ok: deleteManagedSkill(file) };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get('/skills/discover', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAuth(request);
      const query = request.query && typeof request.query === 'object' ? String((request.query as Record<string, unknown>).q || '') : '';
      return await findSkills(query);
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post('/skills/install', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAdmin(request);
      const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
      return await runSkillsCli(String(body.reference || ''));
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post('/skills/import-git', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAdmin(request);
      const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
      return await importGitSkillRepository(String(body.url || ''));
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post('/skills/import-zip', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAdmin(request);
      const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
      return importSkillZipArchive({ filename: body.filename, base64: body.base64 });
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });
};
