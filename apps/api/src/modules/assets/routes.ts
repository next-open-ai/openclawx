import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { FastifyPluginAsync } from 'fastify';
import { listPreviewServers, startPreviewServer, stopPreviewServer } from '@openclawx/agent-core';
import { requireAuth } from '../auth/service.js';
import type { AuthPrincipal } from '../auth/service.js';
import { canReadOwnedResource, canWriteOwnedResource } from '../auth/ownership.js';
import { getOrchestrator } from '../orchestration/routes.js';
import { readChatFile } from '../orchestration/chat-attachments.js';

const require = createRequire(import.meta.url);

type SqlDatabase = {
  exec: (sql: string, params?: unknown[]) => Array<{ values?: unknown[][] }>;
  run: (sql: string, params?: unknown[]) => void;
  export: () => Uint8Array;
};

type AssetAccessGrant = {
  subjectType: 'user';
  subjectId: string;
  permissions: Array<'read' | 'write'>;
  createdAt: number;
  expiresAt?: number;
};

let databasePromise: Promise<SqlDatabase> | null = null;

function dataDir(): string {
  return process.env.OPENCLAWX_DATA_DIR || path.join(os.homedir(), '.openclawx');
}

function conversationStagingRoot(runId: string) {
  const configured = process.env.OPENCLAWX_ASSET_STAGING_DIR?.trim() || process.env.OPENCLAWX_WORKSPACES_DIR?.trim();
  return path.resolve(configured || path.join(dataDir(), 'assets', '.staging'), runId);
}

function legacyConversationWorkspaceRoot(runId: string) {
  return path.resolve(dataDir(), 'workspaces', runId);
}

function databaseFile() {
  return path.join(dataDir(), 'openclawx.sqlite');
}

async function database(): Promise<SqlDatabase> {
  if (!databasePromise) {
    databasePromise = (async () => {
      fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
      const sqlJsRoot = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
      const initSqlJs = require(path.join(sqlJsRoot, 'sql-wasm.js'));
      const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(path.join(sqlJsRoot, 'sql-wasm.wasm')) });
      const db = new SQL.Database(fs.existsSync(databaseFile()) ? fs.readFileSync(databaseFile()) : undefined) as SqlDatabase;
      db.run('CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, relative_path TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, conversation_id TEXT, employee_id TEXT, run_id TEXT NOT NULL, sha256 TEXT NOT NULL)');
      db.run('CREATE INDEX IF NOT EXISTS assets_created_at ON assets(created_at DESC)');
      const cols = new Set((db.exec('PRAGMA table_info(assets)')[0]?.values || []).map((row) => String(row[1])));
      if (!cols.has('project_id')) db.run('ALTER TABLE assets ADD COLUMN project_id TEXT');
      if (!cols.has('workspace_relative')) db.run('ALTER TABLE assets ADD COLUMN workspace_relative TEXT');
      if (!cols.has('org_id')) db.run('ALTER TABLE assets ADD COLUMN org_id TEXT');
      if (!cols.has('user_id')) db.run('ALTER TABLE assets ADD COLUMN user_id TEXT');
      if (!cols.has('owner_user_id')) db.run('ALTER TABLE assets ADD COLUMN owner_user_id TEXT');
      if (!cols.has('access_scope')) db.run(`ALTER TABLE assets ADD COLUMN access_scope TEXT DEFAULT 'private'`);
      if (!cols.has('access_grants')) db.run('ALTER TABLE assets ADD COLUMN access_grants TEXT');
      if (!cols.has('kind')) db.run(`ALTER TABLE assets ADD COLUMN kind TEXT DEFAULT 'file'`);
      if (!cols.has('entry_path')) db.run('ALTER TABLE assets ADD COLUMN entry_path TEXT');
      if (!cols.has('manifest_json')) db.run('ALTER TABLE assets ADD COLUMN manifest_json TEXT');
      db.run('CREATE INDEX IF NOT EXISTS assets_project_id ON assets(project_id)');
      // `output/` is a runtime-only delivery boundary.  Never expose it as a
      // user workspace folder, and keep linked project files at their natural
      // relative location instead of under an implementation directory.
      db.run(`UPDATE assets SET workspace_relative = name WHERE workspace_relative IS NULL OR workspace_relative = ''`);
      db.run(`UPDATE assets SET workspace_relative = substr(workspace_relative, 8) WHERE workspace_relative LIKE 'output/%'`);
      db.run(`UPDATE assets SET owner_user_id = user_id WHERE (owner_user_id IS NULL OR owner_user_id = '') AND user_id IS NOT NULL AND user_id != ''`);
      db.run(`UPDATE assets SET access_scope = 'private' WHERE access_scope IS NULL OR access_scope = ''`);
      db.run(`UPDATE assets SET access_grants = '[]' WHERE access_grants IS NULL OR access_grants = ''`);
      fs.writeFileSync(databaseFile(), Buffer.from(db.export()), { mode: 0o600 });
      return db;
    })();
  }
  return databasePromise;
}

function flushDatabase(db: SqlDatabase) {
  fs.writeFileSync(databaseFile(), Buffer.from(db.export()), { mode: 0o600 });
}

function assetMimeType(name: string) {
  const extension = path.extname(name).toLowerCase();
  return ({
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.ppsx': 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.zip': 'application/zip',
  } as Record<string, string>)[extension] || 'application/octet-stream';
}

function parseAccessGrants(raw: unknown): AssetAccessGrant[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        subjectType: 'user' as const,
        subjectId: String(item?.subjectId || '').trim(),
        permissions: Array.isArray(item?.permissions)
          ? item.permissions.filter((value: unknown): value is 'read' | 'write' => value === 'read' || value === 'write')
          : [],
        createdAt: Number(item?.createdAt || 0) || Date.now(),
        expiresAt: item?.expiresAt ? Number(item.expiresAt) : undefined,
      }))
      .filter((item) => item.subjectId && item.permissions.length > 0);
  } catch {
    return [];
  }
}

function mapAssetRow(row: unknown[]) {
  const [id, name, relativePath, mimeType, sizeBytes, createdAt, conversationId, employeeId, runId, sha256, projectId, workspaceRelative, orgId, ownerUserId, userId, accessScope, accessGrants, kind, entryPath, manifestJson] = row;
  return {
    id: String(id),
    name: String(name),
    relativePath: String(relativePath),
    mimeType: String(mimeType),
    sizeBytes: Number(sizeBytes),
    createdAt: Number(createdAt),
    conversationId: conversationId ? String(conversationId) : null,
    employeeId: employeeId ? String(employeeId) : null,
    runId: String(runId),
    sha256: String(sha256),
    projectId: projectId ? String(projectId) : null,
    workspaceRelative: workspaceRelative ? String(workspaceRelative) : String(name),
    orgId: orgId ? String(orgId) : null,
    ownerUserId: ownerUserId ? String(ownerUserId) : (userId ? String(userId) : null),
    userId: userId ? String(userId) : (ownerUserId ? String(ownerUserId) : null),
    accessScope: (accessScope === 'org-shared' || accessScope === 'delegated' ? accessScope : 'private') as 'private' | 'org-shared' | 'delegated',
    accessGrants: parseAccessGrants(accessGrants),
    kind: kind === 'bundle' ? 'bundle' : 'file',
    entryPath: entryPath ? String(entryPath) : null,
    manifest: (() => { try { return manifestJson ? JSON.parse(String(manifestJson)) : null; } catch { return null; } })(),
  };
}

function assetRows(result: Array<{ values?: unknown[][] }>) {
  return (result[0]?.values || []).map((row) => mapAssetRow(row));
}

const ASSET_SELECT = 'SELECT id, name, relative_path, mime_type, size_bytes, created_at, conversation_id, employee_id, run_id, sha256, project_id, workspace_relative, org_id, owner_user_id, user_id, access_scope, access_grants, kind, entry_path, manifest_json FROM assets';

async function listAssets(auth?: { orgId: string; userId: string }) {
  const db = await database();
  if (!auth) return assetRows(db.exec(`${ASSET_SELECT} ORDER BY created_at DESC`));
  return assetRows(db.exec(`${ASSET_SELECT} WHERE COALESCE(owner_user_id, user_id) = ? AND (org_id IS NULL OR org_id = ?) ORDER BY created_at DESC`, [auth.userId, auth.orgId]));
}

/** Model-facing directory: owner-only, bounded metadata, never filesystem paths. */
export async function listWorkAssets(owner:{userId:string;orgId:string},query:string,conversationId:string|undefined,limit:number,runIds:string[]=[]){
  const db=await database();
  const args:unknown[]=[owner.userId,owner.orgId];
  let where='COALESCE(owner_user_id,user_id)=? AND (org_id IS NULL OR org_id=?)';
  if(conversationId){
    const ids=runIds.slice(0,100);
    where+=ids.length?` AND (conversation_id=? OR ((conversation_id IS NULL OR conversation_id='') AND run_id IN (${ids.map(()=>'?').join(',')})))`:' AND conversation_id=?';
    args.push(conversationId,...ids);
  }
  if(query){where+=" AND name LIKE ? ESCAPE '\\'";args.push('%'+query.replace(/[\\%_]/g,'\\$&')+'%');}
  args.push(Math.min(501,Math.max(1,limit)));
  return assetRows(db.exec(`${ASSET_SELECT} WHERE ${where} ORDER BY created_at DESC,id LIMIT ?`,args));
}

export async function readWorkAsset(assetId:string,owner:{userId:string;orgId:string}){
  const db=await database(),row=assetRows(db.exec(`${ASSET_SELECT} WHERE id=?`,[assetId]))[0];
  if(!row||row.ownerUserId!==owner.userId||(row.orgId&&row.orgId!==owner.orgId))throw Error('WORK_NOT_AVAILABLE');
  const target=path.resolve(dataDir(),row.relativePath),root=await fs.promises.realpath(path.join(dataDir(),'assets'));
  let real:string;
  try{real=await fs.promises.realpath(target);}catch{throw Error('WORK_FILE_MISSING');}
  if(!real.startsWith(root+path.sep)||(await fs.promises.lstat(target)).isSymbolicLink())throw Error('WORK_FILE_UNSAFE');
  const file=await fs.promises.open(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{
    const stat=await file.stat();if(!stat.isFile())throw Error('WORK_FILE_UNSAFE');
    const max=10*1024*1024;if(stat.size>max)throw Error('WORK_FILE_TOO_LARGE');
    const buffer=Buffer.alloc(max+1);let length=0;
    while(length<buffer.length){const read=await file.read(buffer,length,buffer.length-length,null);if(!read.bytesRead)break;length+=read.bytesRead;}
    if(length>max)throw Error('WORK_FILE_TOO_LARGE');
    return{row,content:buffer.subarray(0,length)};
  }finally{await file.close();}
}

export async function assertWorkAssetOwner(assetId:string,owner:{userId:string;orgId:string}){
  const db=await database(),row=assetRows(db.exec(`${ASSET_SELECT} WHERE id=?`,[assetId]))[0];
  if(!row||row.ownerUserId!==owner.userId||(row.orgId&&row.orgId!==owner.orgId))throw Error('WORK_NOT_AVAILABLE');
}

/** Storage-maintenance view used by Settings. It intentionally returns metadata only. */
export async function listLargeAssetsForOwner(auth: Pick<AuthPrincipal, 'orgId' | 'userId'>, minimumBytes = 20 * 1024 * 1024) {
  const rows = await listAssets(auth);
  return rows
    .filter((row) => row.sizeBytes >= minimumBytes)
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .map((row) => ({
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt,
      conversationId: row.conversationId,
      projectId: row.projectId,
    }));
}

export async function listAssetIds(): Promise<Set<string>> {
  return new Set((await listAssets()).map((row) => row.id));
}

async function assetFile(assetId: string) {
  const db = await database();
  const row = assetRows(db.exec(`${ASSET_SELECT} WHERE id = ?`, [String(assetId)]))[0];
  if (!row) throw new Error('Asset not found.');
  const target = path.resolve(dataDir(), row.relativePath);
  if (!target.startsWith(`${path.resolve(dataDir(), 'assets')}${path.sep}`) || !fs.existsSync(target)) {
    throw new Error('Asset file is unavailable.');
  }
  return { row, target, db };
}

/** Read an owned asset's bytes for data-workbench import and similar flows. */
export async function readOwnedAssetBytes(assetId: string, auth: Pick<AuthPrincipal, 'userId' | 'orgId'>) {
  const { row, target } = await assetFile(assetId);
  if (!canReadOwnedResource(row, { ...auth, role: 'member' }, { allowLegacyUnowned: true })) throw new Error('Asset not found.');
  return { row, content: fs.readFileSync(target) };
}

/**
 * Store a user-selected data file directly in the asset library.  Unlike agent
 * deliverables this has no run/output dependency: the file is the user's
 * source of truth and is later referenced by the data workbench.
 */
export async function storeUploadedDataAsset(input: {
  name: string;
  content: Buffer;
  mimeType?: string;
  auth: Pick<AuthPrincipal, 'userId' | 'orgId'>;
}) {
  const name = path.basename(input.name || '数据文件').replace(/[\0/\\]/g, '_').slice(0, 180) || '数据文件';
  const content = input.content;
  if (!content.length) throw new Error('上传的文件为空。');
  if (content.length > 25 * 1024 * 1024) throw new Error('资产文件不能超过 25 MB。');
  const db = await database();
  const id = randomUUID();
  const runId = randomUUID();
  const folder = path.join(dataDir(), 'assets', id);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const target = path.join(folder, name);
  fs.writeFileSync(target, content, { mode: 0o600 });
  const createdAt = Date.now();
  const mimeType = input.mimeType || assetMimeType(name);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const relativePath = path.relative(dataDir(), target).split(path.sep).join('/');
  db.run(
    'INSERT INTO assets (id, name, relative_path, mime_type, size_bytes, created_at, conversation_id, employee_id, run_id, sha256, project_id, workspace_relative, org_id, owner_user_id, user_id, access_scope, access_grants) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, relativePath, mimeType, content.length, createdAt, null, null, runId, sha256, null, name, input.auth.orgId, input.auth.userId, input.auth.userId, 'private', '[]'],
  );
  flushDatabase(db);
  return { id, name, mimeType, sizeBytes: content.length, createdAt, sha256 };
}

async function archiveArtifact(value: { runId?: string; relativePath?: string; conversationId?: string; employeeId?: string; projectId?: string; orgId?: string; ownerUserId?: string; userId?: string; accessScope?: 'private' | 'org-shared' | 'delegated'; accessGrants?: AssetAccessGrant[] }) {
  const runId = String(value?.runId || '');
  const relativePath = String(value?.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!/^[a-f0-9-]{20,}$/i.test(runId) || !relativePath || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid artifact location.');
  }
  const processDirs = new Set(['tools', 'scripts', 'tmp', 'deps', '.python-packages', '__pycache__', 'node_modules']);
  const neverExt = new Set(['pyc', 'pyo', 'pyd', 'class', 'o', 'obj', 'exe', 'dll', 'so', 'dylib', 'map']);
  const parts = relativePath.split('/');
  const base = parts[parts.length - 1] || '';
  const ext = path.extname(base).slice(1).toLowerCase();
  if (parts[0] !== 'output' || parts.length < 2 || parts.some((part) => processDirs.has(part)) || !ext || neverExt.has(ext) || (base.startsWith('.') && base !== '.gitkeep')) {
    throw new Error('Only business deliverables under output/ can be archived to the asset library.');
  }
  let workspaceRoot = conversationStagingRoot(runId);
  let source = path.resolve(workspaceRoot, relativePath);
  // Retain read compatibility for runs created before staging moved under
  // assets/.staging. New runs never use this legacy path.
  if (!fs.existsSync(source)) {
    workspaceRoot = legacyConversationWorkspaceRoot(runId);
    source = path.resolve(workspaceRoot, relativePath);
  }
  if (!source.startsWith(`${workspaceRoot}${path.sep}`) || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error('Generated artifact is no longer available.');
  }
  const db = await database();
  const name = path.basename(source);
  const sizeBytes = fs.statSync(source).size;
  if (sizeBytes > 100 * 1024 * 1024) throw new Error('Generated artifact exceeds the 100 MB asset limit.');
  const sha256 = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const workspaceRelative = relativePath.replace(/^output\//, '');
  // A deliverable can be written in several append calls. The first
  // artifact.created event must not freeze an early, partial copy in the asset
  // library: refresh the same run/path asset in place whenever its contents
  // change, while keeping a repeated event for unchanged content idempotent.
  const existing = assetRows(db.exec(`${ASSET_SELECT} WHERE run_id = ? AND workspace_relative = ? LIMIT 1`, [runId, workspaceRelative]))[0];
  if (existing) {
    if (existing.sha256 !== sha256 || existing.sizeBytes !== sizeBytes) {
      const target = path.resolve(dataDir(), existing.relativePath);
      if (!target.startsWith(`${path.resolve(dataDir(), 'assets')}${path.sep}`)) {
        throw new Error('Existing asset location is invalid.');
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, target, 0);
      db.run('UPDATE assets SET name = ?, mime_type = ?, size_bytes = ?, sha256 = ? WHERE id = ?', [
        name,
        assetMimeType(name),
        sizeBytes,
        sha256,
        existing.id,
      ]);
      flushDatabase(db);
      return {
        ...existing,
        name,
        mimeType: assetMimeType(name),
        sizeBytes,
        sha256,
      };
    }
    return existing;
  }
  const id = randomUUID();
  const targetFolder = path.join(dataDir(), 'assets', id);
  fs.mkdirSync(targetFolder, { recursive: true, mode: 0o700 });
  const target = path.join(targetFolder, name);
  fs.copyFileSync(source, target, 0);
  const relativeAssetPath = path.relative(dataDir(), target).split(path.sep).join('/');
  const createdAt = Date.now();
  const projectId = String(value?.projectId || '').trim() || null;
  const conversationId = String(value?.conversationId || '') || null;
  const employeeId = String(value?.employeeId || '') || null;
  const orgId = String(value?.orgId || '').trim() || null;
  const ownerUserId = String(value?.ownerUserId || value?.userId || '').trim() || null;
  const userId = ownerUserId;
  const accessScope = value?.accessScope === 'org-shared' || value?.accessScope === 'delegated' ? value.accessScope : 'private';
  const accessGrants = JSON.stringify(Array.isArray(value?.accessGrants) ? value.accessGrants : []);
  db.run(
    'INSERT INTO assets (id, name, relative_path, mime_type, size_bytes, created_at, conversation_id, employee_id, run_id, sha256, project_id, workspace_relative, org_id, owner_user_id, user_id, access_scope, access_grants) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, relativeAssetPath, assetMimeType(name), sizeBytes, createdAt, conversationId, employeeId, runId, sha256, projectId, workspaceRelative, orgId, ownerUserId, userId, accessScope, accessGrants],
  );
  flushDatabase(db);
  return { id, name, relativePath: relativeAssetPath, mimeType: assetMimeType(name), sizeBytes, createdAt, conversationId, employeeId, runId, sha256, projectId, workspaceRelative, orgId, ownerUserId, userId, accessScope, accessGrants: parseAccessGrants(accessGrants) };
}

function bundleFiles(root: string, folder = root, out: Array<{ path: string; bytes: number; sha256: string; mimeType: string }> = []) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) bundleFiles(root, target, out);
    else if (entry.isFile()) {
      const relative = path.relative(root, target).split(path.sep).join('/');
      const bytes = fs.statSync(target).size;
      out.push({ path: relative, bytes, sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex'), mimeType: assetMimeType(relative) });
    }
  }
  return out;
}

async function archiveBundle(value: Parameters<typeof archiveArtifact>[0]) {
  const runId = String(value.runId || '');
  let workspaceRoot = conversationStagingRoot(runId);
  let source = path.join(workspaceRoot, 'output');
  if (!fs.existsSync(source)) {
    workspaceRoot = legacyConversationWorkspaceRoot(runId);
    source = path.join(workspaceRoot, 'output');
  }
  if (!/^[a-f0-9-]{20,}$/i.test(runId) || !fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('Bundle output is unavailable.');
  const files = bundleFiles(source);
  const entry = files.some((item) => item.path === 'index.html') ? 'index.html' : files[0]?.path;
  if (!files.length || !entry) throw new Error('Bundle has no deliverable files.');
  const db = await database();
  const manifest = { version: 1, files, entryPath: entry };
  const sha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const name = path.basename(entry) === 'index.html' ? '网站交付包' : path.basename(entry);
  const sizeBytes = files.reduce((n, f) => n + f.bytes, 0);
  const existing = assetRows(db.exec(`${ASSET_SELECT} WHERE run_id = ? AND kind = 'bundle' LIMIT 1`, [runId]))[0];
  const id = existing?.id || randomUUID();
  const assetRoot = path.join(dataDir(), 'assets', id);
  const folder = path.join(assetRoot, 'files');
  const temporary = path.join(dataDir(), 'assets', `.bundle-${id}-${randomUUID()}`);
  fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
  fs.cpSync(source, path.join(temporary, 'files'), { recursive: true });
  fs.rmSync(assetRoot, { recursive: true, force: true });
  fs.renameSync(temporary, assetRoot);
  const relativePath = path.relative(dataDir(), path.join(folder, entry)).split(path.sep).join('/');
  if (existing) {
    db.run('UPDATE assets SET name=?,relative_path=?,mime_type=?,size_bytes=?,sha256=?,entry_path=?,manifest_json=? WHERE id=?', [name, relativePath, 'application/x-openclawx-bundle', sizeBytes, sha256, entry, JSON.stringify(manifest), id]);
  } else {
    db.run('INSERT INTO assets (id,name,relative_path,mime_type,size_bytes,created_at,conversation_id,employee_id,run_id,sha256,project_id,workspace_relative,org_id,owner_user_id,user_id,access_scope,access_grants,kind,entry_path,manifest_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [id,name,relativePath,'application/x-openclawx-bundle',sizeBytes,Date.now(),value.conversationId||null,value.employeeId||null,runId,sha256,value.projectId||null,'output',value.orgId||null,value.ownerUserId||null,value.ownerUserId||null,value.accessScope||'private',JSON.stringify(value.accessGrants||[]),'bundle',entry,JSON.stringify(manifest)]);
  }
  flushDatabase(db); return assetRows(db.exec(`${ASSET_SELECT} WHERE id = ?`, [id]))[0];
}

async function linkAssetsToProject(value: { projectId?: string; assetIds?: string[]; workspacePath?: string }) {
  const db = await database();
  const projectId = String(value?.projectId || '').trim();
  const assetIds = Array.isArray(value?.assetIds) ? value.assetIds.map((id) => String(id || '')).filter(Boolean) : [];
  if (!projectId) throw new Error('projectId is required.');
  if (!assetIds.length) return { updated: 0, copied: 0, projectId };
  let updated = 0;
  for (const assetId of assetIds) {
    db.run('UPDATE assets SET project_id = ? WHERE id = ?', [projectId, assetId]);
    updated += 1;
  }
  flushDatabase(db);
  let copied = 0;
  const workspacePath = String(value?.workspacePath || '').trim();
  if (workspacePath) {
    const root = path.resolve(workspacePath);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const assetId of assetIds) {
      try {
        const { row, target: source } = await assetFile(assetId);
        const relative = String(row.workspaceRelative || row.name).replace(/\\/g, '/').replace(/^\/+/, '');
        if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) continue;
        const dest = path.resolve(root, relative);
        if (!dest.startsWith(`${root}${path.sep}`)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        fs.copyFileSync(source, dest, 0);
        copied += 1;
      } catch {
        /* Keep linking even if one file copy fails. */
      }
    }
  }
  return { updated, copied, projectId };
}

async function unlinkAssetsFromProject(assetIds: string[]) {
  const db = await database();
  const ids = Array.isArray(assetIds) ? assetIds.map((id) => String(id || '')).filter(Boolean) : [];
  let updated = 0;
  for (const assetId of ids) {
    db.run('UPDATE assets SET project_id = NULL WHERE id = ?', [assetId]);
    updated += 1;
  }
  flushDatabase(db);
  return { updated };
}

async function deleteAssets(assetIds: string[]) {
  const db = await database();
  const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
  const assetsRoot = path.resolve(dataDir(), 'assets');
  let deleted = 0;
  for (const assetId of ids) {
    const rows = assetRows(db.exec(`${ASSET_SELECT} WHERE id = ?`, [assetId]));
    const row = rows[0];
    if (!row) continue;
    db.run('DELETE FROM assets WHERE id = ?', [assetId]);
    deleted += 1;
    const folder = path.resolve(assetsRoot, assetId);
    if (folder.startsWith(`${assetsRoot}${path.sep}`) && fs.existsSync(folder)) {
      fs.rmSync(folder, { recursive: true, force: true });
    } else if (row.relativePath) {
      const target = path.resolve(dataDir(), row.relativePath);
      if (target.startsWith(`${assetsRoot}${path.sep}`) && fs.existsSync(target)) {
        fs.rmSync(path.dirname(target), { recursive: true, force: true });
      }
    }
  }
  if (deleted) flushDatabase(db);
  return { deleted };
}

function previewBinaryLimit(name: string) {
  if (/\.pdf$/i.test(name)) return 40 * 1024 * 1024;
  return /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(name) ? 12 * 1024 * 1024 : 2 * 1024 * 1024;
}

async function readAssetPreview(assetId: string) {
  const { row, target } = await assetFile(assetId);
  const size = fs.statSync(target).size;
  if (size > previewBinaryLimit(row.name)) throw new Error('File is too large to preview.');
  const textLike = /\.(md|markdown|txt|html?|css|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|xml|svg|csv)$/i.test(row.name);
  if (textLike) {
    return { kind: 'text' as const, name: row.name, mimeType: row.mimeType, content: fs.readFileSync(target, 'utf8'), bytes: size };
  }
  return { kind: 'binary' as const, name: row.name, mimeType: row.mimeType, base64: fs.readFileSync(target).toString('base64'), bytes: size };
}

async function assetContent(assetId: string) {
  const { row, target } = await assetFile(assetId);
  return { row, target };
}

function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

/**
 * Resolve the latest archived SITE bundle directory for a chat session.
 * Preview maps this path directly — no workspace hydrate/copy.
 */
export async function resolveConversationSiteBundleRoot(conversationId: string): Promise<{
  assetId: string;
  root: string;
  entryPath: string;
} | null> {
  const id = String(conversationId || '').trim();
  if (!id) return null;
  const db = await database();
  const rows = assetRows(db.exec(
    `${ASSET_SELECT} WHERE conversation_id = ? AND kind = 'bundle' ORDER BY created_at DESC LIMIT 12`,
    [id],
  ));
  for (const row of rows) {
    const filesRoot = path.resolve(dataDir(), 'assets', row.id, 'files');
    if (!fs.existsSync(filesRoot) || !fs.statSync(filesRoot).isDirectory()) continue;
    const entry = String(row.entryPath || 'index.html').replace(/\\/g, '/').replace(/^\/+/, '') || 'index.html';
    const indexAt = path.resolve(filesRoot, entry);
    if (!indexAt.startsWith(`${filesRoot}${path.sep}`) && indexAt !== filesRoot) continue;
    if (!fs.existsSync(path.join(filesRoot, 'index.html')) && !fs.existsSync(indexAt)) continue;
    return { assetId: row.id, root: filesRoot, entryPath: entry };
  }
  return null;
}

/** Resolve a specific SITE asset bundle on-disk files root. */
export async function resolveAssetSiteBundleRoot(assetId: string): Promise<{
  assetId: string;
  root: string;
  entryPath: string;
  row: ReturnType<typeof mapAssetRow>;
}> {
  const { row } = await assetFile(assetId);
  if (row.kind !== 'bundle') throw new Error('Asset is not a SITE website bundle.');
  const filesRoot = path.resolve(dataDir(), 'assets', row.id, 'files');
  if (!fs.existsSync(filesRoot) || !fs.statSync(filesRoot).isDirectory()) {
    throw new Error('SITE bundle files are unavailable.');
  }
  const entry = String(row.entryPath || 'index.html').replace(/\\/g, '/').replace(/^\/+/, '') || 'index.html';
  if (!fs.existsSync(path.join(filesRoot, 'index.html')) && !fs.existsSync(path.join(filesRoot, entry))) {
    throw new Error('SITE bundle has no index.html to deploy.');
  }
  return { assetId: row.id, root: filesRoot, entryPath: entry, row };
}

export const assetRoutes: FastifyPluginAsync = async (app) => {
  app.get('/assets', async (request) => listAssets(requireAuth(request)));

  app.post('/assets/import-chat-attachment', async (request, reply) => {
    const auth = requireAuth(request);
    const body = request.body as { sessionId?: string; attachmentId?: string };
    const sessionId = String(body?.sessionId || ''); const attachmentId = String(body?.attachmentId || '');
    const session = await getOrchestrator().chat.getChatSession(sessionId);
    if (!session || !canWriteOwnedResource(session, auth, { allowLegacyUnowned: true })) return reply.code(404).send({ message: 'Chat session not found.' });
    try {
      const file = await readChatFile(sessionId, attachmentId);
      return await storeUploadedDataAsset({ name: file.attachment.name, content: file.bytes, mimeType: file.attachment.mimeType, auth });
    } catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : '保存资产失败。' }); }
  });

  app.post('/assets/archive', async (request, reply) => {
    const auth = requireAuth(request);
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      const orch = getOrchestrator();
      const conversationId = typeof body.conversationId === 'string' ? body.conversationId : undefined;
      const projectId = typeof body.projectId === 'string' ? body.projectId : undefined;
      if (conversationId) {
        const session = await orch.chat.getChatSession(conversationId);
        if (!canWriteOwnedResource(session, auth, { allowLegacyUnowned: true })) throw new Error('Chat session not found.');
      }
      if (projectId) {
        const project = await orch.projects.getProject(projectId);
        if (!canWriteOwnedResource(project, auth, { allowLegacyUnowned: true })) throw new Error('Project not found.');
      }
      const asset = await archiveArtifact({
        runId: typeof body.runId === 'string' ? body.runId : undefined,
        relativePath: typeof body.relativePath === 'string' ? body.relativePath : undefined,
        conversationId,
        employeeId: typeof body.employeeId === 'string' ? body.employeeId : undefined,
        projectId,
        orgId: auth.orgId,
        ownerUserId: auth.userId,
      });
      if (conversationId && typeof body.runId === 'string') {
        const run = await orch.chat.getRun(body.runId);
        if (run?.taskId) await orch.durableTasks.attachAsset(run.taskId, { assetId: asset.id, name: asset.name, role: 'deliverable', sourceRunId: run.id });
      }
      return asset;
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/assets/archive-bundle', async (request, reply) => {
    const auth = requireAuth(request); const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
    try {
      const orch = getOrchestrator();
      const conversationId = typeof body.conversationId === 'string' ? body.conversationId : undefined;
      const projectId = typeof body.projectId === 'string' ? body.projectId : undefined;
      if (conversationId && !canWriteOwnedResource(await orch.chat.getChatSession(conversationId), auth, { allowLegacyUnowned: true })) throw new Error('Chat session not found.');
      if (projectId && !canWriteOwnedResource(await orch.projects.getProject(projectId), auth, { allowLegacyUnowned: true })) throw new Error('Project not found.');
      const runId = String(body.runId || '');
      const asset = await archiveBundle({ runId, conversationId, employeeId: typeof body.employeeId === 'string' ? body.employeeId : undefined, projectId, orgId: auth.orgId, ownerUserId: auth.userId });
      if (conversationId) {
        const run = await orch.chat.getRun(runId);
        if (run?.taskId) await orch.durableTasks.attachAsset(run.taskId, { assetId: asset.id, name: asset.name, role: 'deliverable', sourceRunId: run.id });
      }
      return asset;
    }
    catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) }); }
  });

  app.post('/assets/link', async (request, reply) => {
    const auth = requireAuth(request);
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      const orch = getOrchestrator();
      const projectId = typeof body.projectId === 'string' ? body.projectId : undefined;
      const assetIds = Array.isArray(body.assetIds) ? body.assetIds.map((id) => String(id || '')) : [];
      const project = projectId ? await orch.projects.getProject(projectId) : null;
      if (!canWriteOwnedResource(project, auth, { allowLegacyUnowned: true })) throw new Error('Project not found.');
      for (const assetId of assetIds) {
        const { row } = await assetFile(assetId);
        if (!canWriteOwnedResource(row, auth)) throw new Error('Asset not found.');
      }
      return await linkAssetsToProject({
        projectId,
        assetIds,
        workspacePath: typeof body.workspacePath === 'string' ? body.workspacePath : undefined,
      });
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/assets/unlink', async (request, reply) => {
    const auth = requireAuth(request);
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      const assetIds = Array.isArray(body.assetIds) ? body.assetIds.map((id) => String(id || '')) : [];
      for (const assetId of assetIds) {
        const { row } = await assetFile(assetId);
        if (!canWriteOwnedResource(row, auth)) throw new Error('Asset not found.');
      }
      return await unlinkAssetsFromProject(assetIds);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/assets/delete', async (request, reply) => {
    const auth = requireAuth(request);
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      const assetIds = Array.isArray(body.assetIds) ? body.assetIds.map((id) => String(id || '')) : [];
      if (!assetIds.length) return { deleted: 0 };
      const db = await database();
      for (const assetId of assetIds) {
        const row = assetRows(db.exec(`${ASSET_SELECT} WHERE id = ?`, [assetId]))[0];
        if (!row || !canWriteOwnedResource(row, auth)) throw new Error('Asset not found.');
      }
      return await deleteAssets(assetIds);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/assets/preview', async (request, reply) => {
    const auth = requireAuth(request);
    const query = request.query && typeof request.query === 'object' ? (request.query as Record<string, unknown>) : {};
    try {
      const preview = await readAssetPreview(String(query.assetId || ''));
      const { row } = await assetFile(String(query.assetId || ''));
      if (!canReadOwnedResource(row, auth)) throw new Error('Asset not found.');
      return preview;
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/assets/content', async (request, reply) => {
    const auth = requireAuth(request);
    const query = request.query && typeof request.query === 'object' ? (request.query as Record<string, unknown>) : {};
    try {
      const { row, target } = await assetContent(String(query.assetId || ''));
      if (!canReadOwnedResource(row, auth)) throw new Error('Asset not found.');
      reply.header('content-type', row.mimeType || 'application/octet-stream');
      reply.header('content-disposition', String(query.download || '') === '1' ? `attachment; filename="${encodeURIComponent(row.name)}"` : `inline; filename="${encodeURIComponent(row.name)}"`);
      reply.header('accept-ranges', 'bytes');
      reply.header('cache-control', 'private, max-age=3600');
      const size = fs.statSync(target).size;
      const requestedRange = request.headers.range;
      const range = parseByteRange(requestedRange, size);
      if (requestedRange && !range) return reply.code(416).header('content-range', `bytes */${size}`).send();
      if (range) {
        reply.code(206);
        reply.header('content-range', `bytes ${range.start}-${range.end}/${size}`);
        reply.header('content-length', String(range.end - range.start + 1));
        return reply.send(fs.createReadStream(target, range));
      }
      reply.header('content-length', String(size));
      return reply.send(fs.createReadStream(target));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/assets/bundle-content', async (request, reply) => {
    const auth = requireAuth(request); const query = request.query && typeof request.query === 'object' ? request.query as Record<string, unknown> : {};
    try {
      const { row } = await assetFile(String(query.assetId || '')); if (!canReadOwnedResource(row, auth) || row.kind !== 'bundle') throw new Error('Asset not found.');
      const relative = String(query.path || row.entryPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid bundle path.');
      const target = path.resolve(dataDir(), 'assets', row.id, 'files', relative); const root = path.resolve(dataDir(), 'assets', row.id, 'files');
      if (!target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('Bundle file is unavailable.');
      reply.header('content-type', assetMimeType(relative)); return reply.send(fs.createReadStream(target));
    } catch (error) { return reply.code(404).send({ message: error instanceof Error ? error.message : String(error) }); }
  });

  app.get('/assets/bundle/:assetId/*', async (request, reply) => {
    const auth = requireAuth(request); const params = request.params as { assetId: string; '*': string };
    try {
      const { row } = await assetFile(params.assetId); if (!canReadOwnedResource(row, auth) || row.kind !== 'bundle') throw new Error('Asset not found.');
      const relative = String(params['*'] || row.entryPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid bundle path.');
      const root = path.resolve(dataDir(), 'assets', row.id, 'files'); const target = path.resolve(root, relative);
      if (!target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('Bundle file is unavailable.');
      reply.header('content-type', assetMimeType(relative)); return reply.send(fs.createReadStream(target));
    } catch (error) { return reply.code(404).send({ message: error instanceof Error ? error.message : String(error) }); }
  });

  /** Start local / LAN deploy for a SITE asset bundle or project website root. */
  app.post('/assets/site-deploy/start', async (request, reply) => {
    const auth = requireAuth(request);
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      const assetId = String(body.assetId || '').trim();
      const projectId = String(body.projectId || '').trim();
      const access = body.access === 'local' ? 'local' : 'lan';
      const portHint = typeof body.portHint === 'number' ? body.portHint : undefined;
      if (assetId) {
        const resolved = await resolveAssetSiteBundleRoot(assetId);
        if (!canReadOwnedResource(resolved.row, auth)) throw new Error('Asset not found.');
        return await startPreviewServer({
          workspaceRoot: resolved.root,
          root: '.',
          access,
          assetId: resolved.assetId,
          source: 'asset-bundle',
          portHint,
        });
      }
      if (projectId) {
        const orch = getOrchestrator();
        const project = await orch.projects.getProject(projectId);
        if (!canReadOwnedResource(project, auth, { allowLegacyUnowned: true })) throw new Error('Project not found.');
        const workspacePath = String(project?.workspacePath || '').trim();
        if (!workspacePath) throw new Error('Project has no workspace path.');
        const root = path.resolve(workspacePath);
        const indexAt = path.join(root, 'index.html');
        if (!fs.existsSync(indexAt) || !fs.statSync(indexAt).isFile()) {
          throw new Error('Project workspace has no index.html at root — not a deployable website.');
        }
        return await startPreviewServer({
          workspaceRoot: root,
          root: '.',
          access,
          projectId,
          source: 'project',
          portHint,
        });
      }
      throw new Error('assetId or projectId is required.');
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Stop deploy/preview servers for a SITE bundle / project (or by id/port). */
  app.post('/assets/site-deploy/stop', async (request, reply) => {
    const auth = requireAuth(request);
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      const assetId = typeof body.assetId === 'string' ? body.assetId.trim() : '';
      const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
      if (assetId) {
        const { row } = await assetFile(assetId);
        if (!canReadOwnedResource(row, auth)) throw new Error('Asset not found.');
        return await stopPreviewServer({ assetId });
      }
      if (projectId) {
        const orch = getOrchestrator();
        const project = await orch.projects.getProject(projectId);
        if (!canReadOwnedResource(project, auth, { allowLegacyUnowned: true })) throw new Error('Project not found.');
        return await stopPreviewServer({ projectId });
      }
      const id = typeof body.id === 'string' ? body.id.trim() : undefined;
      const port = typeof body.port === 'number' ? body.port : undefined;
      if (!id && port == null) throw new Error('assetId, projectId, id, or port is required.');
      return await stopPreviewServer({ id, port });
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/assets/site-deploy/status', async (request, reply) => {
    const auth = requireAuth(request);
    const query = request.query && typeof request.query === 'object' ? (request.query as Record<string, unknown>) : {};
    try {
      const assetId = String(query.assetId || '').trim();
      const projectId = String(query.projectId || '').trim();
      if (assetId) {
        const { row } = await assetFile(assetId);
        if (!canReadOwnedResource(row, auth)) throw new Error('Asset not found.');
        return { ok: true as const, servers: listPreviewServers({ assetId }) };
      }
      if (projectId) {
        const orch = getOrchestrator();
        const project = await orch.projects.getProject(projectId);
        if (!canReadOwnedResource(project, auth, { allowLegacyUnowned: true })) throw new Error('Project not found.');
        return { ok: true as const, servers: listPreviewServers({ projectId }) };
      }
      return { ok: true as const, servers: listPreviewServers() };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });
};
