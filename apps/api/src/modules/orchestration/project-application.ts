import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withKeyLock, type Orchestrator, type Project } from '@workmate/orchestrator';
import type { ProjectApplicationSnapshot, ProjectApplicationStatus, ProjectApplicationView, PublishProjectApplication } from '@workmate/contracts';
import { ProjectApplicationSnapshotSchema } from '@workmate/contracts';
import { canReadOwnedResource, canWriteOwnedResource } from '../auth/ownership.js';
import type { AuthPrincipal } from '../auth/service.js';

export class ApplicationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}
function reject(code: string, message: string, status = 400): never { throw new ApplicationError(code, message, status); }
const excluded = new Set(['inputs', 'tmp', 'scripts', 'tools', 'node_modules', '__pycache__']);
export const webTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.avif': 'image/avif',
};
interface Bundle { revision: string; entrypoint: 'index.html' | 'output/index.html'; files: Map<string, Buffer>; bytes: number }
interface Ticket { projectId: string; version: string; principal: AuthPrincipal; expiresAt: number; resources: Set<string> }

async function regularFile(root: string, relative: string): Promise<Buffer> {
  if ((await lstat(root)).isSymbolicLink()) reject('APPLICATION_SYMLINK', '页面资源目录不能是符号链接。');
  if (!relative || relative.length > 2048 || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(segment => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) reject('APPLICATION_PATH_INVALID', '页面资源路径不合法。');
  let target = root;
  for (const part of relative.split('/')) {
    target = path.join(target, part);
    if ((await lstat(target)).isSymbolicLink()) reject('APPLICATION_SYMLINK', '页面资源不能引用符号链接，请改用项目内的实际文件。');
  }
  const canonicalRoot = await realpath(root);
  if (!(await realpath(target)).startsWith(canonicalRoot + path.sep)) reject('APPLICATION_PATH_INVALID', '页面资源超出项目范围。');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) reject('APPLICATION_FILE_LIMIT', '页面资源必须是普通文件，单个文件不能超过8MB。');
    const bytes = await handle.readFile();
    if (bytes.length > 8 * 1024 * 1024) reject('APPLICATION_FILE_LIMIT', '页面资源超过8MB。');
    return bytes;
  } finally { await handle.close(); }
}

export class ProjectApplications {
  private readonly tickets = new Map<string, Ticket>();
  constructor(private readonly orch: Orchestrator, private readonly dataRoot: string, private readonly now = Date.now) {}
  private key(id: string) { return `project-application:v1:${id}`; }
  private directory(id: string, version: string) {
    return path.join(this.dataRoot, 'project-sites', createHash('sha256').update(id).digest('hex'), version);
  }
  private async project(principal: AuthPrincipal, id: string, write = false): Promise<Project> {
    const project = await this.orch.projects.getProject(id);
    if (!project || !(write ? canWriteOwnedResource(project, principal) : canReadOwnedResource(project, principal))) reject('APPLICATION_FORBIDDEN', '无权访问此项目应用。', 403);
    if (project.kind !== 'conversation' || !project.workspacePath) reject('APPLICATION_UNSUPPORTED', '此入口仅支持持续对话项目；原数据应用请使用数据工作台。');
    return project;
  }
  private async entrypoint(project: Project): Promise<'index.html' | 'output/index.html' | null> {
    const root = project.workspacePath!;
    try { if ((await lstat(root)).isSymbolicLink()) reject('APPLICATION_SYMLINK', '项目目录不能是符号链接。'); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null; throw cause; }
    for (const entrypoint of ['index.html', 'output/index.html'] as const) {
      try { await regularFile(root, entrypoint); return entrypoint; }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
    }
    return null;
  }
  private async capture(project: Project): Promise<Bundle> {
    const entrypoint = await this.entrypoint(project);
    if (!entrypoint) reject('APPLICATION_ENTRY_MISSING', '尚未找到 index.html，请先让员工生成或导入网站文件。');
    const root = path.join(project.workspacePath!, path.dirname(entrypoint));
    const files = new Map<string, Buffer>(); let bytes = 0, entries = 0;
    async function walk(relative: string) {
      for (const name of (await readdir(path.join(root, relative))).sort()) {
        if (++entries > 2000) reject('APPLICATION_BUNDLE_LIMIT', '页面资源过多，请整理项目后重试。');
        if (name.startsWith('.') || excluded.has(name)) continue;
        const child = relative ? `${relative}/${name}` : name;
        const info = await lstat(path.join(root, child));
        if (info.isSymbolicLink()) reject('APPLICATION_SYMLINK', '页面资源不能引用符号链接，请改用项目内的实际文件。');
        if (info.isDirectory()) { await walk(child); continue; }
        if (!info.isFile()) reject('APPLICATION_FILE_INVALID', '项目包含特殊文件，无法发布。');
        if (!webTypes[path.extname(name).toLowerCase()]) continue;
        const content = await regularFile(root, child);
        bytes += content.length;
        if (files.size >= 500 || bytes > 32 * 1024 * 1024) reject('APPLICATION_BUNDLE_LIMIT', '静态应用最多500个资源、合计32MB，请整理后重试。');
        files.set(child, content);
      }
    }
    await walk('');
    if (!files.get('index.html')?.length) reject('APPLICATION_ENTRY_MISSING', 'index.html 为空，无法预览或发布。');
    const hash = createHash('sha256').update(entrypoint);
    for (const [name, content] of files) hash.update(JSON.stringify([name, content.length])).update(content);
    return { revision: hash.digest('hex'), entrypoint, files, bytes };
  }
  private async published(id: string): Promise<ProjectApplicationSnapshot | null> {
    const raw = await this.orch.store.get(this.key(id));
    if (!raw) return null;
    try { return ProjectApplicationSnapshotSchema.parse(JSON.parse(raw)); }
    catch { reject('APPLICATION_RECORD_INVALID', '应用发布记录不完整，请联系管理员检查；不会自动覆盖已有文件。', 500); }
  }
  async status(principal: AuthPrincipal, id: string): Promise<ProjectApplicationStatus> {
    const project = await this.project(principal, id);
    return { entrypoint: await this.entrypoint(project), published: await this.published(id) };
  }
  private async persist(id: string, bundle: Bundle) {
    const directory = this.directory(id, bundle.revision);
    try { if ((await lstat(directory)).isDirectory()) return; }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    const stage = path.join(path.dirname(directory), `.stage-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    try {
      for (const [relative, content] of bundle.files) {
        const file = path.join(stage, relative);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, content, { mode: 0o600, flag: 'wx' });
      }
      await rename(stage, directory);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  private view(principal: AuthPrincipal, id: string, snapshot: Omit<ProjectApplicationSnapshot, 'publishedAt'>): ProjectApplicationView {
    for (const [token, ticket] of this.tickets) if (ticket.expiresAt <= this.now()) this.tickets.delete(token);
    if (this.tickets.size >= 1000) this.tickets.delete(this.tickets.keys().next().value!);
    const token = randomBytes(32).toString('hex'), expiresAt = this.now() + 30 * 60 * 1000;
    const resources = snapshot.resources ?? ['index.html'];
    this.tickets.set(token, { projectId: id, version: snapshot.version, principal: { ...principal }, expiresAt, resources: new Set(resources) });
    return { revision: snapshot.version, entrypoint: snapshot.entrypoint, fileCount: snapshot.fileCount, bytes: snapshot.bytes,
      viewPath: `/api/project-sites/${token}/index.html`, expiresAt, resources };
  }
  async preview(principal: AuthPrincipal, id: string): Promise<ProjectApplicationView> {
    return withKeyLock(`project-application:${id}`, async () => {
      const project = await this.project(principal, id);
      if (project.status === 'running') reject('APPLICATION_BUSY', '项目正在执行，请等待完成后再预览最新成果。', 409);
      const bundle = await this.capture(project);
      await this.persist(id, bundle);
      return this.view(principal, id, { version: bundle.revision, entrypoint: bundle.entrypoint, fileCount: bundle.files.size, bytes: bundle.bytes, resources: [...bundle.files.keys()] });
    });
  }
  async publish(principal: AuthPrincipal, id: string, input: PublishProjectApplication): Promise<ProjectApplicationSnapshot> {
    return withKeyLock(`project-application:${id}`, async () => {
      const project = await this.project(principal, id, true);
      if (project.status === 'running') reject('APPLICATION_BUSY', '项目正在执行，完成后再确认发布。', 409);
      const previous = await this.published(id);
      const bundle = await this.capture(project);
      if (bundle.revision !== input.revision) reject('APPLICATION_DRAFT_CHANGED', '成果已发生变化，请重新预览后再发布。', 409);
      if (previous?.version === bundle.revision) return previous;
      if ((previous?.version ?? null) !== input.expectedVersion) reject('APPLICATION_VERSION_CONFLICT', '已发布版本已更新，请刷新并重新预览。', 409);
      // The preview hash is an optimistic concurrency token, not authority to read a path.
      try { await regularFile(this.directory(id, bundle.revision), 'index.html'); }
      catch { reject('APPLICATION_PREVIEW_REQUIRED', '请先预览当前成果，再确认发布。', 409); }
      await this.persist(id, bundle);
      // Share turn admission's lock: no new Run may start between final check and commit.
      return withKeyLock(`project-turn:${id}`, async () => {
        const latest = await this.project(principal, id, true);
        if (latest.status === 'running' || (await this.capture(latest)).revision !== bundle.revision) reject('APPLICATION_DRAFT_CHANGED', '成果正在更新，请完成后重新预览。', 409);
        const snapshot = { version: bundle.revision, entrypoint: bundle.entrypoint, fileCount: bundle.files.size, bytes: bundle.bytes, resources: [...bundle.files.keys()], publishedAt: this.now() };
        try {
          await this.orch.store.set(this.key(id), JSON.stringify(snapshot));
          await this.orch.store.flush();
        } catch (cause) {
          if (previous) await this.orch.store.set(this.key(id), JSON.stringify(previous));
          else await this.orch.store.delete(this.key(id));
          await this.orch.store.flush().catch(() => undefined);
          throw cause;
        }
        return snapshot;
      });
    });
  }
  async publishedView(principal: AuthPrincipal, id: string): Promise<ProjectApplicationView> {
    await this.project(principal, id);
    const snapshot = await this.published(id);
    if (!snapshot) reject('APPLICATION_NOT_PUBLISHED', '此项目尚未发布应用。', 404);
    return this.view(principal, id, snapshot);
  }
  async content(token: string, relative: string) {
    const ticket = this.tickets.get(token);
    if (!ticket || ticket.expiresAt <= this.now()) { this.tickets.delete(token); reject('APPLICATION_VIEW_EXPIRED', '查看链接已过期，请回到项目重新打开。', 401); }
    await this.project(ticket.principal, ticket.projectId);
    if (relative.includes('\\') || relative.includes('\0') || relative.split('/').some(part => !part || part === '.' || part === '..')) reject('APPLICATION_PATH_INVALID', '页面资源路径不合法。');
    if (!ticket.resources.has(relative)) reject('APPLICATION_RESOURCE_NOT_FOUND', '页面资源不存在。', 404);
    const type = webTypes[path.extname(relative).toLowerCase()];
    if (!type) reject('APPLICATION_RESOURCE_NOT_FOUND', '页面资源不存在。', 404);
    try { return { bytes: await regularFile(this.directory(ticket.projectId, ticket.version), relative), type, projectId: ticket.projectId, principal: ticket.principal }; }
    catch (cause) { if (cause instanceof ApplicationError) throw cause; reject('APPLICATION_RESOURCE_NOT_FOUND', '页面资源不存在。', 404); }
  }
}

const services = new WeakMap<Orchestrator, ProjectApplications>();
export function projectApplications(orch: Orchestrator) {
  let service = services.get(orch);
  if (!service) {
    service = new ProjectApplications(orch, process.env.WORKMATE_DATA_DIR || path.join(os.homedir(), '.workmate'));
    services.set(orch, service);
  }
  return service;
}
