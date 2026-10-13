import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promoteWorkspaceDeliverablesToProject } from '@workmate/agent-core';

async function checkedCopy(source: string, destination: string) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error('项目文件不能通过符号链接引用其他目录');
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(source)) {
      await checkedCopy(path.join(source, entry), path.join(destination, entry));
    }
  } else if (info.isFile()) {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await cp(source, destination);
  } else throw new Error('项目目录包含不支持的特殊文件');
}

async function treeRevision(root: string) {
  const hash = createHash('sha256');
  let files = 0, bytes = 0;
  async function walk(target: string) {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error('项目文件不能通过符号链接引用其他目录');
    hash.update(path.relative(root, target)).update(info.isDirectory() ? 'directory' : 'file');
    if (info.isDirectory()) for (const entry of (await readdir(target)).sort()) {
      // UI metadata is refreshed on reads, not a user edit to deliverables.
      if (entry === '.workmate') continue;
      await walk(path.join(target, entry));
    }
    else if (info.isFile()) {
      if (++files > 5000 || (bytes += info.size) > 512 * 1024 * 1024) throw new Error('项目文件过多或超过512MB，请整理后再执行');
      hash.update(await readFile(target));
    } else throw new Error('项目目录包含不支持的特殊文件');
  }
  await walk(root);
  return hash.digest('hex');
}

export async function prepareConversationWorkspace(projectRoot: string, runRoot: string) {
  const revision = await treeRevision(projectRoot);
  await mkdir(path.join(runRoot, 'output'), { recursive: true, mode: 0o700 });
  if ((await lstat(projectRoot)).isSymbolicLink()) throw new Error('项目目录不能是符号链接');
  for (const entry of await readdir(projectRoot)) {
    if (['.git', '.workmate', 'node_modules', '__pycache__'].includes(entry)) continue;
    await checkedCopy(path.join(projectRoot, entry), path.join(runRoot, entry === 'inputs' ? entry : `output/${entry}`));
  }
  if (await treeRevision(projectRoot) !== revision) throw new Error('项目文件在准备期间发生变化，请重试');
  return revision;
}

/** Build a full replacement first; failed promotion preserves old bytes. */
export async function publishConversationWorkspace(runRoot: string, projectRoot: string, signal?: AbortSignal, expectedRevision?: string) {
  const stage = await mkdtemp(path.join(path.dirname(projectRoot), '.project-delivery-'));
  const candidate = path.join(stage, 'candidate');
  const backup = path.join(stage, 'previous');
  let moved = false;
  try {
    await checkedCopy(projectRoot, candidate);
    const published = await promoteWorkspaceDeliverablesToProject(runRoot, candidate, { strict: true });
    if (!published.length) return published;
    if (signal?.aborted) throw new Error('运行已取消，保留原有项目成果');
    if (expectedRevision && await treeRevision(projectRoot) !== expectedRevision) throw new Error('项目文件已被修改，本轮成果保留在运行目录，未覆盖当前文件');
    await rename(projectRoot, backup);
    moved = true;
    try { await rename(candidate, projectRoot); }
    catch (cause) { await rename(backup, projectRoot); moved = false; throw cause; }
    moved = false;
    return published;
  } finally {
    // Retain backup if rollback itself fails.
    if (!moved) await rm(stage, { recursive: true, force: true });
  }
}
