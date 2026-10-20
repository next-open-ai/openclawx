import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyFile, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';

/**
 * Dual workspace modes for every execution backend (pi / dsh / …):
 *
 * - conversation: isolated run dir; finished files under output/ → artifact.created → session assets
 * - project: cwd is the shared project root; write the real tree at root → project.file.published
 */
export type WorkspaceMode = 'conversation' | 'project';

const INTERNAL_SNAPSHOT_SKIP = new Set([
  '.agents',
  '.dsh-sessions',
  '.git',
  '.python-packages',
  '.openclawx-workspaces',
  'node_modules',
  '__pycache__',
]);

export function resolveWorkspaceMode(projectWorkspacePath?: string | null): WorkspaceMode {
  return String(projectWorkspacePath || '').trim() ? 'project' : 'conversation';
}

export function workspacesRootDir() {
  // Conversation runs write directly into the asset subsystem's private
  // staging area.  The controller promotes a completed run into an immutable
  // asset; incomplete/cancelled runs never enter the asset library.
  return process.env.OPENCLAWX_ASSET_STAGING_DIR?.trim()
    || process.env.OPENCLAWX_WORKSPACES_DIR?.trim()
    || path.join(process.env.OPENCLAWX_DATA_DIR?.trim() || path.join(os.homedir(), '.openclawx'), 'assets', '.staging');
}

/** Same root resolution for pi and dsh so mode behaviour stays aligned. */
export function resolveAgentWorkspaceRoot(input: {
  runId: string;
  projectWorkspacePath?: string | null;
}): string {
  const project = String(input.projectWorkspacePath || '').trim();
  if (project) {
    fs.mkdirSync(project, { recursive: true });
    return path.resolve(project);
  }
  const runId = String(input.runId || 'run').replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = path.join(workspacesRootDir(), runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function conversationModeContract() {
  return [
    '[Workspace mode: conversation]',
    'This run uses an isolated conversation workspace.',
    'Finished user-facing files (PDF, DOCX, HTML, Markdown, CSV, images, …) MUST be written under output/',
    '(create the directory if needed). Prefer output/<clear-name> over workspace-root files.',
    'Process files (generators/scripts/tmp) stay outside output/.',
    'Deliverables are archived to the session asset library via output/.',
    'To preview or LAN-deploy an already-delivered website, call preview_server_start (access=local or access=lan). Do not rebuild for preview-only requests.',
  ].join('\n');
}

export function projectModeContract() {
  return [
    '[Workspace mode: project]',
    'The current working directory is the final shared project root.',
    'Create and edit the actual project structure directly here (index.html, src/, assets/, …).',
    'Do not wrap the product in an output/ directory.',
    'Keep temporary process files out of the final project tree when possible (prefer scripts/ or hidden dirs).',
    'Deliverables appear in the project file tree, not as conversation-only assets.',
    'To preview or LAN-deploy the site, call preview_server_start with access=local or access=lan (maps this project workspace root as the web root).',
  ].join('\n');
}

export function workspaceModeContract(mode: WorkspaceMode) {
  return mode === 'project' ? projectModeContract() : conversationModeContract();
}

export type ProjectOutputReconciliation = {
  moved: Array<{ from: string; to: string }>;
  conflicts: Array<{ from: string; to: string }>;
};

/**
 * Safety net for engines whose native filesystem tools ignored project mode and
 * created an `output/` wrapper. Files are moved (not copied) into the project
 * tree. Existing destinations are never overwritten; conflicting sources stay
 * under output/ for explicit user resolution.
 */
export async function reconcileProjectOutputDirectory(projectRoot: string): Promise<ProjectOutputReconciliation> {
  const root = path.resolve(projectRoot);
  const outputRoot = path.join(root, 'output');
  const result: ProjectOutputReconciliation = { moved: [], conflicts: [] };

  const moveFile = async (source: string, relativeFromOutput: string) => {
    const normalized = relativeFromOutput.split(path.sep).join('/');
    if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) return;
    const destination = path.resolve(root, normalized);
    if (destination === root || !destination.startsWith(`${root}${path.sep}`)) return;
    try {
      const existing = await stat(destination).catch(() => null);
      if (existing) {
        result.conflicts.push({ from: `output/${normalized}`, to: normalized });
        return;
      }
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      try {
        await rename(source, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        await copyFile(source, destination);
        await unlink(source);
      }
      result.moved.push({ from: `output/${normalized}`, to: normalized });
    } catch {
      result.conflicts.push({ from: `output/${normalized}`, to: normalized });
    }
  };

  const walk = async (directory: string, relative = '', depth = 0): Promise<void> => {
    if (depth > 12 || result.moved.length + result.conflicts.length >= 2_000) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || INTERNAL_SNAPSHOT_SKIP.has(entry.name)) continue;
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const source = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(source, childRelative, depth + 1);
      else if (entry.isFile()) await moveFile(source, childRelative);
    }
  };

  await walk(outputRoot);
  if (!result.conflicts.length) await rm(outputRoot, { recursive: true, force: true }).catch(() => undefined);
  return result;
}

/** Fingerprint project/conversation tree for end-of-run publish detection. */
export async function snapshotWorkspaceFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const visit = async (directory: string, relative = '', depth = 0): Promise<void> => {
    if (depth > 12 || files.size >= 2_000) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (INTERNAL_SNAPSHOT_SKIP.has(entry.name) || entry.name === '.openclawx-dsh.cordis.yml') continue;
      if (entry.name.startsWith('.') && entry.name !== '.gitkeep') continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target, childRelative, depth + 1);
      } else if (entry.isFile() && childRelative.length <= 240) {
        const info = await stat(target).catch(() => null);
        if (info) files.set(childRelative, `${info.size}:${info.mtimeMs}`);
      }
      if (files.size >= 2_000) return;
    }
  };
  await visit(path.resolve(root));
  return files;
}
