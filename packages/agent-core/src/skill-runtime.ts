import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile,rename,unlink } from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {DocumentToolInputSchema,DocumentToolInputJsonSchema,type AgentSkillRuntime} from '@openclawx/contracts';
import { Type, StringEnum, defineAgentTool,jsonSchemaParameters, type AgentTool } from './pi-tools.js';
import {readDocument} from './document-service.js';
import { PDF_SKILL_ID } from './builtin-skill-packages.js';
import { pythonArgv, resolveOpenClawXPython } from './python-runtime.js';
import { resolveAgentWorkspaceRoot } from './workspace-mode.js';
import { assertResourcePath } from './resource-access.js';
import {
  MAX_FILE_BYTES,
  MAX_STAGED_APPEND_CHARS,
  MAX_WRITE_CHUNK,
  MAX_WRITE_CHUNKS,
  MAX_WRITE_CONTENT,
  appendStagedWrite,
  resolveWriteBody,
  startStagedWrite,
  beginStagedCommit,settleStagedCommit,statusStagedWrite,withWorkspaceWriteLock,
} from './workspace-write.js';

/** Agent-facing read cap — full 96KB dumps pollute context and derail subsequent tool JSON. */
const MAX_READ_RETURN_CHARS = 6_000;
const MAX_NETWORK_BYTES = 256_000;
const MAX_SCRIPT_OUTPUT = 32_000;
const SCRIPT_TIMEOUT_MS = 30_000;
const textFilePattern = /\.(md|txt|json|ya?ml|csv|html?|css|ts|js|mjs|cjs|py|sh)$/i;
const executablePattern = /^scripts\/.+\.(sh|js|mjs|cjs|py)$/i;

/** Canonical directory for finished business deliverables inside a run workspace. */
export const WORKSPACE_OUTPUT_DIR = 'output';

/** Keep enough generated source in the tool result for the final chat answer. */
export function pdfChatPreview(content: string, maxChars = 2_400) {
  const normalized = content.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** Process / cache directories — never auto-archived or promoted. */
const PROCESS_ONLY_DIRS = new Set(['tools', 'scripts', 'tmp', 'deps', '.python-packages', '__pycache__', 'node_modules']);

/** Bytecode / native objects — never deliverables, even under output/. */
const NEVER_DELIVERABLE_EXT = new Set([
  'pyc', 'pyo', 'pyd', 'class', 'o', 'obj', 'exe', 'dll', 'so', 'dylib', 'map',
]);

/**
 * Document-like files that LLMs often write at workspace root by mistake.
 * After a script run we stage these into output/ so they still reach the asset library,
 * without treating generator sources (.py/.sh/…) as deliverables.
 */
const STAGEABLE_ROOT_DOCUMENT_EXT = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico',
  'html', 'htm', 'css', 'md', 'markdown', 'txt', 'csv', 'json',
  'zip', 'gz', 'tgz', 'mp3', 'mp4', 'webm', 'wav',
]);

function normalizeWorkspacePath(relative: string) {
  return relative.replace(/\\/g, '/').replace(/^\/+/, '');
}

function pathParts(relative: string) {
  return normalizeWorkspacePath(relative).split('/').filter(Boolean);
}

function safeRelative(value: string) {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Path must be a safe relative path.');
  }
  return normalized;
}

function isNeverDeliverableFile(base: string) {
  if (!base || (base.startsWith('.') && base !== '.gitkeep')) return true;
  const ext = path.extname(base).slice(1).toLowerCase();
  return !ext || NEVER_DELIVERABLE_EXT.has(ext);
}

/** True when the path is under the canonical business-output directory. */
export function isUnderWorkspaceOutput(relative: string) {
  const parts = pathParts(relative);
  return parts[0] === WORKSPACE_OUTPUT_DIR && parts.length >= 2;
}

/**
 * True when a run-workspace relative path is a finished business deliverable.
 * Policy (intent, not extension guesswork):
 * - Must live under `output/` (or be placed there via register_deliverable).
 * - Process trees (scripts/tools/tmp/…) are never deliverables.
 * - Bytecode/cache files are never deliverables even under output/.
 * - Under output/, source files such as .py/.js ARE allowed (they can be the product).
 */
export function isBusinessDeliverablePath(relative: string) {
  const normalized = normalizeWorkspacePath(relative);
  const parts = pathParts(normalized);
  if (!normalized || parts.some((part) => part === '.' || part === '..')) return false;
  if (parts.some((part) => PROCESS_ONLY_DIRS.has(part))) return false;
  if (!isUnderWorkspaceOutput(normalized)) return false;
  return !isNeverDeliverableFile(parts[parts.length - 1] || '');
}

/** @deprecated Use isBusinessDeliverablePath — kept for call-site compatibility. */
export function isProjectDeliverablePath(relative: string) {
  return isBusinessDeliverablePath(relative);
}

function toOutputPath(relative: string, destName?: string) {
  const normalized = safeRelative(relative);
  if (isUnderWorkspaceOutput(normalized) && !destName) return normalized;
  const base = destName ? path.basename(safeRelative(destName)) : path.basename(normalized);
  if (!base || base === '.' || base === '..') throw new Error('Invalid deliverable file name.');
  return `${WORKSPACE_OUTPUT_DIR}/${base}`;
}

/**
 * Copy every deliverable under output/ from an isolated run workspace into the
 * shared project workspace. End-of-run safety net; prefer explicit publish.
 */
export async function promoteWorkspaceDeliverablesToProject(
  workspaceRoot: string,
  projectRoot: string,
  options: { strict?: boolean } = {},
): Promise<Array<{ path: string; projectPath: string }>> {
  const published: Array<{ path: string; projectPath: string }> = [];
  const root = path.resolve(workspaceRoot);
  const destRoot = path.resolve(projectRoot);
  const outputRoot = path.join(root, WORKSPACE_OUTPUT_DIR);

  async function walk(folder: string, depth = 0) {
    if (depth > 8 || published.length >= 200) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch (cause) {
      if (options.strict && (cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || PROCESS_ONLY_DIRS.has(entry.name)) continue;
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(target, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, target).split(path.sep).join('/');
      if (!isBusinessDeliverablePath(relative)) continue;
      // Promote as output-relative path without forcing the "output/" prefix into the project tree.
      const projectPath = relative.startsWith(`${WORKSPACE_OUTPUT_DIR}/`)
        ? relative.slice(WORKSPACE_OUTPUT_DIR.length + 1)
        : relative;
      if (!projectPath || projectPath.split('/').some((part) => !part || part === '.' || part === '..')) continue;
      const dest = path.join(destRoot, ...projectPath.split('/'));
      await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await copyFile(target, dest);
      published.push({ path: relative, projectPath });
      if (published.length >= 200) return;
    }
  }

  try {
    await walk(outputRoot);
  } catch (cause) {
    if (options.strict) throw cause;
    /* Legacy callers keep best-effort promotion. */
  }
  return published;
}

function truncate(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated]` : value;
}

async function pathInside(root: string, relative: string) {
  const resolvedRoot = await realpath(root);
  return assertResourcePath(resolvedRoot, safeRelative(relative));
}

async function ensureWorkspaceScaffold(root: string, mode: 'conversation' | 'project' = 'conversation') {
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Project mode writes the real tree at root — do not force an output/ wrapper.
  if (mode === 'conversation') {
    await mkdir(path.join(root, WORKSPACE_OUTPUT_DIR), { recursive: true, mode: 0o700 });
    await mkdir(path.join(root, 'scripts'), { recursive: true, mode: 0o700 });
  }
}

async function listSkillFiles(root: string, folder = root, depth = 0, entries: string[] = []): Promise<string[]> {
  if (depth > 5 || entries.length >= 80) return entries;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const target = path.join(folder, entry.name);
    const relative = path.relative(root, target).split(path.sep).join('/');
    if (entry.isDirectory()) await listSkillFiles(root, target, depth + 1, entries);
    else if (entry.isFile() && textFilePattern.test(entry.name)) entries.push(relative);
    if (entries.length >= 80) break;
  }
  return entries;
}

/**
 * List finished deliverables under output/ only.
 */
export async function listOutputDeliverables(root: string, folder = path.join(root, WORKSPACE_OUTPUT_DIR), depth = 0, entries: string[] = []): Promise<string[]> {
  if (depth > 5 || entries.length >= 40) return entries;
  let listing: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    listing = await readdir(folder, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const entry of listing) {
    if (entry.name.startsWith('.') || PROCESS_ONLY_DIRS.has(entry.name)) continue;
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      await listOutputDeliverables(root, target, depth + 1, entries);
    } else if (entry.isFile()) {
      const relative = path.relative(root, target).split(path.sep).join('/');
      if (isBusinessDeliverablePath(relative)) entries.push(relative);
    }
    if (entries.length >= 40) break;
  }
  return entries;
}

function isStageableRootDocument(relative: string) {
  const parts = pathParts(relative);
  if (parts.length !== 1) return false;
  if (isNeverDeliverableFile(parts[0])) return false;
  const ext = path.extname(parts[0]).slice(1).toLowerCase();
  return STAGEABLE_ROOT_DOCUMENT_EXT.has(ext);
}

/**
 * After a generator script runs:
 * 1) collect new/changed files under output/
 * 2) stage accidental root documents (pdf/html/…) into output/ (generators stay put)
 */
async function collectScriptDeliverables(root: string, before: Set<string>, startedAtMs: number): Promise<string[]> {
  const staged = new Set<string>();

  // Walk whole tree lightly for root-document staging + output discovery.
  async function walk(folder: string, depth = 0) {
    if (depth > 5) return;
    let listing: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      listing = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of listing) {
      if (entry.name.startsWith('.') || PROCESS_ONLY_DIRS.has(entry.name)) continue;
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(target, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, target).split(path.sep).join('/');
      let info: { mtimeMs: number };
      try {
        info = await stat(target);
      } catch {
        continue;
      }
      const isNewOrTouched = !before.has(relative) || info.mtimeMs >= startedAtMs - 1_000;
      if (!isNewOrTouched) continue;

      if (isBusinessDeliverablePath(relative)) {
        staged.add(relative);
        continue;
      }
      if (!isStageableRootDocument(relative)) continue;
      const destRel = toOutputPath(relative);
      const destAbs = path.join(root, ...destRel.split('/'));
      await mkdir(path.dirname(destAbs), { recursive: true, mode: 0o700 });
      await copyFile(target, destAbs);
      staged.add(destRel);
    }
  }

  await walk(root);
  // Also pick up anything already under output/ that may have been missed if walk skipped.
  for (const item of await listOutputDeliverables(root).catch(() => [])) {
    if (!before.has(item)) staged.add(item);
  }
  return [...staged];
}

/**
 * End-of-run safety net for engines without register_deliverable (e.g. dsh):
 * stage root PDF/HTML/… into output/ and return relative deliverable paths for
 * artifact.created events. Call once before run.completed.
 */
export async function harvestWorkspaceDeliverables(
  workspaceRoot: string,
  options?: { startedAtMs?: number; before?: Iterable<string> },
): Promise<string[]> {
  const root = path.resolve(workspaceRoot);
  const startedAtMs = options?.startedAtMs ?? Date.now();
  const before = new Set(options?.before ?? []);
  if (!before.size) {
    for (const item of await listOutputDeliverables(root).catch(() => [])) before.add(item);
  }
  return collectScriptDeliverables(root, before, startedAtMs);
}

/**
 * Finalize the explicit conversation delivery boundary at successful run end.
 *
 * Writing a file under output/ is itself a declaration of delivery intent. The
 * explicit commit tool can publish it earlier, but run completion must not
 * depend on a probabilistic second model action. Unlike the legacy harvester,
 * this function never promotes files from the workspace root.
 */
export async function finalizeOutputDeliverables(
  workspaceRoot: string,
  options: { startedAtMs: number; before: Iterable<string> },
): Promise<string[]> {
  const root = path.resolve(workspaceRoot);
  const before = new Set(options.before);
  const finalized: string[] = [];
  for (const relative of await listOutputDeliverables(root).catch(() => [])) {
    const absolute = path.join(root, ...relative.split('/'));
    let info: { mtimeMs: number };
    try {
      info = await stat(absolute);
    } catch {
      continue;
    }
    if (!before.has(relative) || info.mtimeMs >= options.startedAtMs - 1_000) finalized.push(relative);
  }
  return finalized;
}

function approvedSkillRoot(skill: AgentSkillRuntime) {
  const configuredRoot = process.env.OPENCLAWX_SKILLS_DIR;
  if (!configuredRoot || !skill.rootPath) return null;
  const root = path.resolve(configuredRoot);
  const candidate = path.resolve(skill.rootPath);
  return candidate.startsWith(`${root}${path.sep}`) ? candidate : null;
}

function approval(skillId: string, capability: 'workspace-write' | 'script-execution' | 'network-access', error: string) {
  return { ok: false, error, approval: { skillId, capability } };
}

function runProcess(command: string, args: string[], cwd: string, options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: options.env });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? SCRIPT_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout = truncate(stdout + String(chunk), MAX_SCRIPT_OUTPUT); });
    child.stderr.on('data', (chunk) => { stderr = truncate(stderr + String(chunk), MAX_SCRIPT_OUTPUT); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout, stderr }); });
  });
}

/** Run with the resolved script Python; deps must stay under workspace `.python-packages`. */
function runPython(rest: string[], cwd: string, options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  const python = resolveOpenClawXPython();
  const { command, args } = pythonArgv(python, rest);
  return runProcess(command, args, cwd, options);
}

function pythonCommandForExtension(extension: string): string {
  if (extension === '.py') return resolveOpenClawXPython();
  if (extension === '.sh') return 'bash';
  return process.execPath;
}

function pythonImportProbeModuleName(dependency: string) {
  return dependency
    .replace(/==.*$/, '')
    .trim()
    .replace(/-/g, '_');
}

/**
 * The local execution boundary for Agent Skills. Skill packages are immutable
 * at runtime.
 *
 * Dual workspace modes (aligned with dsh):
 * - conversation: isolated run dir; finished products under output/
 * - project: workspace root IS the shared project directory; write the real tree at root
 *
 * Tools are native pi AgentTool + TypeBox (no Vercel AI SDK tool()).
 */
export function createSkillExecutionTools(input: {
  skills: AgentSkillRuntime[];
  runId: string;
  projectRoot?: string;
  workspaceAccess?: 'read' | 'write' | 'full';
}): AgentTool[] {
  const packages = new Map(input.skills.map((skill) => [skill.id, skill]));
  const projectRoot = input.projectRoot?.trim() ? path.resolve(input.projectRoot.trim()) : '';
  const projectBound = Boolean(projectRoot);
  // Project mode: cwd == project root (same as dsh). Conversation: isolated run workspace.
  const workspaceRoot = resolveAgentWorkspaceRoot({
    runId: input.runId,
    projectWorkspacePath: projectRoot || undefined,
  });
  const workspaceAccess = input.workspaceAccess ?? 'write';
  const writeScope=JSON.stringify([input.runId,workspaceRoot]);
  const canWriteWorkspace = workspaceAccess === 'write' || workspaceAccess === 'full';
  // "write" is the normal task tier. It must retain the controlled local
  // execution needed to produce artifacts (for example, a PDF renderer).
  // "full" is reserved for future elevated capabilities such as networked
  // execution; it is not required merely to run a workspace script.
  const canRunWorkspaceScript = workspaceAccess === 'write' || workspaceAccess === 'full';
  const writeDenied = () => ({ ok: false, error: 'Workspace write is not permitted for this run.' });
  const scriptDenied = () => ({ ok: false, error: 'Workspace script execution is not permitted for this run.' });
  // Preloaded instructions are for first-turn reasoning, not implicit execution
  // of every skill. Workspace operations are platform tools, never a Skill.
  const loaded = new Set(
    input.skills
      .filter((skill) => skill.mode === 'default' && skill.instructions)
      .map((skill) => skill.id),
  );
  const getSkill = (skillId: string) => {
    const skill = packages.get(skillId);
    if (!skill) throw new Error('Skill is not authorized for this run.');
    return skill;
  };
  const ensureLoaded = (skillId: string) => {
    if (!loaded.has(skillId)) throw new Error('Load the Skill before accessing its files or execution capabilities.');
  };
  const workspacePath = async (relative: string) => {
    await ensureWorkspaceScaffold(workspaceRoot, projectBound ? 'project' : 'conversation');
    return pathInside(workspaceRoot, relative);
  };
  const projectPath = async (relative: string) => {
    if (!projectRoot) throw new Error('Current run is not bound to a project workspace.');
    await mkdir(projectRoot, { recursive: true, mode: 0o700 });
    return pathInside(projectRoot, relative);
  };
  const runWorkspaceScript = async (relative: string, args: string[]) => {
    if (!canRunWorkspaceScript) return scriptDenied();
    const normalized = safeRelative(relative);
    if (!/\.(sh|js|mjs|cjs|py)$/i.test(normalized)) return { ok: false, error: 'Only .sh, .js, .mjs, .cjs, or .py workspace scripts may run.' };
    let script: string;
    try {
      script = await workspacePath(normalized);
      if (!(await stat(script)).isFile()) throw new Error('Not a file');
    } catch (_) { return { ok: false, error: `Workspace script is unavailable: ${normalized}. Write it first with write_workspace_file.` }; }
    const extension = path.extname(script).toLowerCase();
    const dependencyRoot = path.join(workspaceRoot, '.python-packages');
    await ensureWorkspaceScaffold(workspaceRoot, projectBound ? 'project' : 'conversation');
    const before = new Set(await listOutputDeliverables(workspaceRoot).catch(() => []));
    const startedAtMs = Date.now();
    const result = extension === '.py'
      ? await runPython([script, ...args], workspaceRoot, { env: { ...process.env, PYTHONPATH: dependencyRoot } })
      : await runProcess(pythonCommandForExtension(extension), [script, ...args], workspaceRoot, { env: { ...process.env, PYTHONPATH: dependencyRoot } });
    const artifacts = await collectScriptDeliverables(workspaceRoot, before, startedAtMs).catch(() => []);
    return { ok: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, artifacts };
  };

  const persistWorkspaceText = async (input: {
    relative: string;
    body: string;
    mode: 'replace' | 'append';
    deliverable?: boolean;
    signal?: AbortSignal;
  }) => {
    input.signal?.throwIfAborted();
    const requested = safeRelative(input.relative);
    const body = input.body;
    const writeMode = input.mode;
    let asDeliverable = false;
    let targetRel = requested;

    if (projectBound) {
      if (isUnderWorkspaceOutput(requested)) {
        return {
          ok: false as const,
          error: `PROJECT_OUTPUT_DIRECTORY_NOT_ALLOWED: project mode writes directly to the project root. Retry with ${requested.slice(WORKSPACE_OUTPUT_DIR.length + 1) || '<a root-relative path>'}.`,
        };
      }
      asDeliverable = !PROCESS_ONLY_DIRS.has(pathParts(targetRel)[0] || '');
    } else {
      asDeliverable = Boolean(input.deliverable) || isUnderWorkspaceOutput(requested);
      targetRel = asDeliverable ? toOutputPath(requested) : requested;
      if (!asDeliverable && writeMode === 'append') {
        const outputRel = toOutputPath(requested);
        try {
          const outputFile = await workspacePath(outputRel);
          if ((await stat(outputFile)).isFile()) {
            asDeliverable = true;
            targetRel = outputRel;
          }
        } catch {
          // No matching staged deliverable yet.
        }
      }
      if (asDeliverable && !isBusinessDeliverablePath(targetRel)) {
        return { ok: false as const, error: 'Deliverable path is invalid. Use output/<filename> and avoid cache/bytecode names.' };
      }
    }

    if (!textFilePattern.test(targetRel)) return { ok: false as const, error: 'Only approved text formats can be written.' };
    if (Buffer.byteLength(body) > MAX_FILE_BYTES) {
      return { ok: false as const, error: `File exceeds ${MAX_FILE_BYTES} UTF-8 bytes. Reduce content; staged writes have the same file limit.` };
    }
    const file = await workspacePath(targetRel);
    return withWorkspaceWriteLock(file, async () => {
      input.signal?.throwIfAborted();
      await workspacePath(targetRel);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      let complete = body;
      if (writeMode === 'append') {
        try {
          const existing = await stat(file);
          if (existing.size + Buffer.byteLength(body) > MAX_FILE_BYTES) {
            return { ok: false as const, error: `Append would exceed ${MAX_FILE_BYTES} UTF-8 bytes. File unchanged.` };
          }
          complete = (await readFile(file, 'utf8')) + body;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        }
      }
      if (Buffer.byteLength(complete) > MAX_FILE_BYTES) {
        return { ok: false as const, error: `File exceeds ${MAX_FILE_BYTES} UTF-8 bytes. File unchanged.` };
      }
      const temporary = path.join(path.dirname(file), `.openclawx-write-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, complete, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await workspacePath(targetRel);
        input.signal?.throwIfAborted();
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch(cause => {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        });
      }
      return {
        ok: true as const,
        path: targetRel,
        bytes: Buffer.byteLength(body),
        totalBytes: Buffer.byteLength(complete),
        mode: writeMode,
        deliverable: asDeliverable,
        workspaceMode: projectBound ? 'project' as const : 'conversation' as const,
      };
    });
  };

  const finishedWrites=new Map<string,Awaited<ReturnType<typeof persistWorkspaceText>>>();

  const tools: AgentTool[] = [
    defineAgentTool({
      name: 'load_skill',
      description: 'Load the full SKILL.md instructions for a relevant authorized user Skill.',
      parameters: Type.Object({ skillId: Type.String({ minLength: 1 }) }),
      execute: async ({ skillId }) => {
        const skill = getSkill(skillId);
        if (!skill.instructions) return { ok: false, error: 'This Skill has metadata only; portable instructions are unavailable.' };
        loaded.add(skillId);
        const root = approvedSkillRoot(skill);
        const files = root ? await listSkillFiles(root).catch(() => []) : [];
        return {
          ok: true,
          skill: { id: skill.id, name: skill.name, instructions: skill.instructions },
          files: [...new Set([...files, ...skill.resources.map((resource) => resource.path)])],
          note: 'Only open a file listed in files. Do not guess scripts or paths that are not listed.',
        };
      },
    }),
    defineAgentTool({
      name: 'read_skill_file',
      description: 'Read a text file belonging to a loaded Skill. Path must be relative to that Skill directory; binary files and paths outside the Skill are blocked.',
      parameters: Type.Object({
        skillId: Type.String({ minLength: 1 }),
        path: Type.String({ minLength: 1, maxLength: 240 }),
      }),
      execute: async ({ skillId, path: relative }) => {
        ensureLoaded(skillId);
        const skill = getSkill(skillId);
        if (!textFilePattern.test(relative)) return { ok: false, error: 'Only approved text resource formats can be read.' };
        const root = approvedSkillRoot(skill);
        if (!root) return { ok: false, error: 'Local Skill filesystem access is unavailable for this package.' };
        try {
          const file = await pathInside(root, relative);
          return { ok: true, path: safeRelative(relative), content: truncate(await readFile(file, 'utf8'), MAX_READ_RETURN_CHARS) };
        } catch {
          return { ok: false, error: `Skill file is unavailable: ${safeRelative(relative)}. Load the Skill and use only a path returned in its files list.` };
        }
      },
    }),
    defineAgentTool({
      name: 'read_workspace_file',
      description: projectBound
        ? 'Read a text file from the shared project workspace root. Use only a relative path. Returns at most ~6KB — do not use this to re-dump CSS/JS you just wrote.'
        : 'Read a text artifact from this run\'s isolated conversation workspace. Use only a relative path. Returns at most ~6KB — do not use this to re-dump CSS/JS you just wrote.',
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 240 }) }),
      execute: async ({ path: relative }) => {
        if (!textFilePattern.test(relative)) return { ok: false, error: 'Only approved text formats can be read from the workspace.' };
        const file = await workspacePath(relative);
        return { ok: true, path: safeRelative(relative), content: truncate(await readFile(file, 'utf8'), MAX_READ_RETURN_CHARS) };
      },
    }),
    defineAgentTool({
      name:'read_document',
      description:'使用统一文档服务读取当前工作区的PDF、Word、PPT、表格、HTML或文本。只能传工作区相对路径（附件副本通常在.task/source/）。基础读取不调用模型、不执行Skill；nextAction=delegate时请自行选择已授权Skill继续处理，不能用历史摘要冒充正文，也不要递归委托自己。返回正文、解析器、页数、截断、警告与明确错误。',
      parameters:jsonSchemaParameters(DocumentToolInputJsonSchema),
      execute:async(raw,ctx)=>{
        const failure=(code:'DOCUMENT_INVALID_INPUT'|'DOCUMENT_NOT_AVAILABLE'|'DOCUMENT_TOO_LARGE',message:string)=>({ok:false,code,message,info:{format:'unknown',truncated:false,warnings:[],nextAction:'none'}});
        const input=DocumentToolInputSchema.safeParse(raw);if(!input.success)return failure('DOCUMENT_INVALID_INPUT','请提供文档的工作区相对路径及有效读取范围。');
        try{
          const file=await workspacePath(input.data.path),info=await stat(file);
          if(!info.isFile())return failure('DOCUMENT_NOT_AVAILABLE','工作区文档不可用。');
          if(info.size>25*1024*1024)return failure('DOCUMENT_TOO_LARGE','工作区文档超过25MB，请精简后重试。');
          return readDocument({fileName:path.basename(file),bytes:await readFile(file),maxChars:input.data.maxChars??6000,maxPages:input.data.maxPages??20,allowEnhanced:false,signal:ctx.signal});
        }catch{return failure('DOCUMENT_NOT_AVAILABLE','工作区文档不可用或路径不安全。');}
      },
    }),
    defineAgentTool({
      name: 'write_workspace_file',
      description: projectBound
        ? 'Write UTF-8 text directly at the shared project root. Complete content up to 32000 chars is accepted; prefer concise files. For larger/unfinished output use start → append(seq, recommended ≤8000 chars) → finish, omit totalParts unless known. chunks joins in order (each ≤16000 chars), same 96000 UTF-8 byte file limit. No shell merge needed. Prefer utf8, base64 only as last resort.'
        : 'Write UTF-8 text in this run workspace; deliverables use output/. Complete content up to 32000 chars is accepted. Larger files: start → append(seq, recommended ≤8000 chars) → finish, omit totalParts unless known. chunks joins in order (each ≤16000 chars), same 96000 UTF-8 byte file limit. Query workspace_write_status on failure; do not rewrite accepted pieces or create merge scripts.',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 240 }),
        content: Type.Optional(Type.String({ maxLength: MAX_WRITE_CONTENT })),
        chunks: Type.Optional(Type.Array(Type.String({ maxLength: MAX_WRITE_CHUNK }), { maxItems: MAX_WRITE_CHUNKS })),
        encoding: Type.Optional(StringEnum(['utf8', 'base64'] as const)),
        mode: Type.Optional(StringEnum(['replace', 'append'] as const)),
        deliverable: Type.Optional(Type.Boolean()),
      }),
      execute: async ({ path: relative, content, chunks, encoding, mode, deliverable },ctx) => {
        if (!canWriteWorkspace) return writeDenied();
        ctx.signal?.throwIfAborted();
        const resolved = resolveWriteBody({ content, chunks, encoding });
        if (!resolved.ok) return { ok: false, error: resolved.error };
        return persistWorkspaceText({
          relative,
          body: resolved.body,
          mode: mode === 'append' ? 'append' : 'replace',
          deliverable,
          signal:ctx.signal,
        });
      },
    }),
    defineAgentTool({
      name: 'start_workspace_write',
      description: 'Begin run-scoped staged text assembly; nothing on disk until finish. Append seq=1,2,3…; recommend ≤8000 chars per piece (hard cap16000). Omit totalParts by default: finish when complete. On failure query workspace_write_status and continue, do not restart or create merge scripts.',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 240 }),
        mode: Type.Optional(StringEnum(['replace', 'append'] as const)),
        deliverable: Type.Optional(Type.Boolean()),
        totalParts: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
      }),
      execute: async ({ path: relative, mode, deliverable, totalParts }) => {
        if (!canWriteWorkspace) return writeDenied();
        const requested = safeRelative(relative);
        if (!textFilePattern.test(requested) && !textFilePattern.test(toOutputPath(requested))) {
          return { ok: false, error: 'Only approved text formats can be written.' };
        }
        const session = startStagedWrite({
          path: requested,
          mode: mode === 'append' ? 'append' : 'replace',
          deliverable,
          totalParts,
          scope:writeScope,
        });
        return {
          ok: true,
          writeId: session.id,
          path: session.path,
          mode: session.mode,
          nextSeq: 1,
          totalParts: session.totalParts,
          maxAppendChars: MAX_STAGED_APPEND_CHARS,
          maxFileBytes:MAX_FILE_BYTES,
          hint: `Next: append_workspace_write({ writeId: "${session.id}", seq: 1, text: "<recommended ≤8000 chars>" }). Copy nextSeq from results. Omit total. Finish when complete; query workspace_write_status to recover, not restart.`,
        };
      },
    }),
    defineAgentTool({
      name: 'append_workspace_write',
      description: `Append UTF-8 text (recommended ≤8000, hard cap${MAX_STAGED_APPEND_CHARS} chars). Use nextSeq from result. Identical seq/text retry is safe; changed or skipped seq rejected. Omit total by default. Wrong total? workspace_write_status({writeId,totalParts:null}) preserves pieces. reset=true+seq=1 explicitly discards prior pieces.`,
      parameters: Type.Object({
        writeId: Type.String({ minLength: 8, maxLength: 80 }),
        text: Type.String({ minLength: 1, maxLength: MAX_STAGED_APPEND_CHARS }),
        seq: Type.Integer({ minimum: 1, maximum: 64 }),
        total: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
        reset: Type.Optional(Type.Boolean()),
      }),
      execute: async ({ writeId, text, seq, total, reset }) => {
        if (!canWriteWorkspace) return writeDenied();
        const result = appendStagedWrite(writeId, text, { seq, total, reset: reset === true,scope:writeScope });
        if (!result.ok) return result;
        return {
          ok: true,
          writeId,
          seq,
          nextSeq: result.session.nextSeq,
          appended: result.appended,
          totalBytes: result.session.bytes,
          parts: result.session.parts.length,
          totalParts: result.session.totalParts,
          path: result.session.path,
          ...(result.duplicate?{duplicate:true}:{}),
          ...(result.reset
            ? { reset: true, hint: 'Assembly restarted from seq=1; prior pieces discarded.' }
            : {}),
        };
      },
    }),
    defineAgentTool({
      name:'workspace_write_status',
      description:'Inspect this run staged write without reading content. Returns accepted parts/bytes and nextSeq. Optional totalParts explicitly corrects declared count; null removes count restriction without losing accepted pieces. Never use reset merely to fix a mistaken total.',
      parameters:Type.Object({writeId:Type.String({minLength:8,maxLength:80}),totalParts:Type.Optional(Type.Union([Type.Integer({minimum:1,maximum:64}),Type.Null()]))}),
      execute:async({writeId,totalParts})=>canWriteWorkspace?statusStagedWrite(writeId,writeScope,totalParts):writeDenied(),
    }),
    defineAgentTool({
      name: 'finish_workspace_write',
      description: 'Commit accepted pieces atomically. Incomplete declared total returns recovery state. Persistence failure retains assembly for retry. Repeated successful finish is idempotent in this run tool instance. Returns committed path/bytes only after success.',
      parameters: Type.Object({
        writeId: Type.String({ minLength: 8, maxLength: 80 }),
      }),
      execute: async ({ writeId },ctx) => {
        if (!canWriteWorkspace) return writeDenied();
        ctx.signal?.throwIfAborted();
        const finished=finishedWrites.get(writeId);if(finished)return {...finished,duplicate:true};
        const taken = beginStagedCommit(writeId,writeScope);
        if (!taken.ok) return taken;
        let committed=false;
        try{
        const result=await persistWorkspaceText({
          relative: taken.session.path,
          body: taken.body,
          mode: taken.session.mode,
          deliverable: taken.session.deliverable,
          signal:ctx.signal,
        });
        committed=result.ok;
        if(committed)finishedWrites.set(writeId,result);
        return result;
        }finally{settleStagedCommit(writeId,writeScope,committed);}
      },
    }),
    defineAgentTool({
      name: 'register_deliverable',
      description: projectBound
        ? 'Confirm a finished file already written in the project workspace root. Prefer writing final files directly at the project root; this call is an idempotent confirmation.'
        : 'Mark an existing run-workspace file as a finished business deliverable. Copies it into output/ (if needed) so it can be archived to the asset library. Use this for final products of any type (including .py/.js) — do not register generator scripts you only needed as intermediate tooling.',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 240 }),
        destName: Type.Optional(Type.String({ minLength: 1, maxLength: 180 })),
      }),
      execute: async ({ path: relative, destName }) => {
        if (!canWriteWorkspace) return writeDenied();
        const sourceRel = safeRelative(relative);
        if (PROCESS_ONLY_DIRS.has(pathParts(sourceRel)[0] || '')) {
          return { ok: false, error: 'Files under scripts/tools/tmp/… are process files and cannot be registered as deliverables. Copy the final product out first, or write it under output/.' };
        }
        let source: string;
        try {
          source = await workspacePath(sourceRel);
          if (!(await stat(source)).isFile()) throw new Error('Not a file');
        } catch {
          return { ok: false, error: `Run workspace file is unavailable: ${sourceRel}.` };
        }
        if (projectBound) {
          const bytes = (await stat(source)).size;
          return {
            ok: true,
            path: sourceRel,
            sourcePath: sourceRel,
            projectPath: sourceRel,
            bytes,
            deliverable: true,
            alreadyRegistered: true,
            workspaceMode: 'project',
          };
        }
        // A file already under output/ is already a business deliverable. Do
        // not turn a harmless "register" confirmation into a second renamed
        // PDF and a duplicate asset card.
        if (isBusinessDeliverablePath(sourceRel)) {
          const bytes = (await stat(source)).size;
          return {
            ok: true,
            path: sourceRel,
            sourcePath: sourceRel,
            bytes,
            deliverable: true,
            alreadyRegistered: true,
          };
        }
        const destRel = toOutputPath(sourceRel, destName);
        if (!isBusinessDeliverablePath(destRel)) {
          return { ok: false, error: 'Deliverable name is invalid (cache/bytecode names are blocked).' };
        }
        const dest = await workspacePath(destRel);
        await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        if (path.resolve(source) !== path.resolve(dest)) await copyFile(source, dest);
        const bytes = (await stat(dest)).size;
        return { ok: true, path: destRel, sourcePath: sourceRel, bytes, deliverable: true };
      },
    }),
    defineAgentTool({
      name: 'run_skill_script',
      description: 'Run a bundled script under scripts/ for a loaded Skill, in the isolated run workspace. No shell expressions are accepted. Requires explicit execution permission.',
      parameters: Type.Object({
        skillId: Type.String({ minLength: 1 }),
        path: Type.String({ minLength: 1, maxLength: 240 }),
        args: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 16 })),
      }),
      execute: async ({ skillId, path: relative, args }) => {
        ensureLoaded(skillId);
        const skill = getSkill(skillId);
        if (!skill.execution.allowScriptExecution) return approval(skillId, 'script-execution', 'Running this Skill script requires your approval.');
        const normalized = safeRelative(relative);
        if (!executablePattern.test(normalized)) return { ok: false, error: 'Only script files under scripts/ with an approved extension may run.' };
        const root = approvedSkillRoot(skill);
        if (!root) return { ok: false, error: 'Local Skill script execution is unavailable for this package.' };
        let script: string;
        try {
          script = await pathInside(root, normalized);
          if (!(await stat(script)).isFile()) throw new Error('Not a file');
        } catch {
          return { ok: false, error: `Script is unavailable: ${normalized}. Use only a script listed by load_skill.` };
        }
        await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
        const extension = path.extname(script).toLowerCase();
        const before = new Set(await listOutputDeliverables(workspaceRoot).catch(() => []));
        const startedAtMs = Date.now();
        // Dependencies installed by install_python_dependency are deliberately
        // isolated under this run workspace.  Skill scripts must receive the
        // same PYTHONPATH as workspace scripts; otherwise a successful install
        // is invisible to the bundled renderer and agents fall back to copying
        // the renderer into the workspace.
        const dependencyRoot = path.join(workspaceRoot, '.python-packages');
        const result = extension === '.py'
          ? await runPython([script, ...(args ?? [])], workspaceRoot, {
            env: { ...process.env, PYTHONPATH: dependencyRoot },
          })
          : await runProcess(pythonCommandForExtension(extension), [script, ...(args ?? [])], workspaceRoot, {
            env: { ...process.env, PYTHONPATH: dependencyRoot },
          });
        const declared = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.startsWith('OPENCLAWX_DELIVERABLE:'))
          .map((line) => line.slice('OPENCLAWX_DELIVERABLE:'.length))
          .filter((item) => isBusinessDeliverablePath(item));
        const artifacts = declared.length
          ? [...new Set(declared)]
          : await collectScriptDeliverables(workspaceRoot, before, startedAtMs).catch(() => []);
        return { ok: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, artifacts };
      },
    }),
    defineAgentTool({
      name: 'run_workspace_script',
      description: 'Run a script previously written to this isolated run workspace to create or verify an artifact. No shell expressions are accepted.',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 240 }),
        args: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 16 })),
      }),
      execute: async ({ path: relative, args }) => runWorkspaceScript(relative, args ?? []),
    }),
    defineAgentTool({
      name: 'publish_to_project',
      description: projectBound
        ? 'Optional: copy/rename a file within the project workspace root. Prefer writing final files directly at the desired project path; this is mainly for relocating a finished file.'
        : 'Promote a finished business deliverable from this run workspace into the shared project workspace. Source must be under output/ (or already registered). Requires a project-bound run.',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 240 }),
        destPath: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      }),
      execute: async ({ path: relative, destPath }) => {
        if (!canWriteWorkspace) return writeDenied();
        if (!projectRoot) {
          return { ok: false, error: 'Current run is not bound to a project workspace. publish_to_project is only available for project tasks.' };
        }
        const sourceRel = safeRelative(relative);
        // Project mode: workspace root already is the project. Allow any non-process file.
        if (projectBound) {
          const destRel = safeRelative(destPath || (isUnderWorkspaceOutput(sourceRel)
            ? sourceRel.slice(WORKSPACE_OUTPUT_DIR.length + 1)
            : sourceRel));
          if (PROCESS_ONLY_DIRS.has(pathParts(sourceRel)[0] || '') || PROCESS_ONLY_DIRS.has(pathParts(destRel)[0] || '')) {
            return { ok: false, error: 'Process files under scripts/tools/tmp cannot be published as project deliverables.' };
          }
          let source: string;
          try {
            source = await workspacePath(sourceRel);
            if (!(await stat(source)).isFile()) throw new Error('Not a file');
          } catch {
            return { ok: false, error: `Project file is unavailable: ${sourceRel}.` };
          }
          const dest = await projectPath(destRel);
          await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
          if (path.resolve(source) !== path.resolve(dest)) await copyFile(source, dest);
          const bytes = (await stat(dest)).size;
          return { ok: true, path: sourceRel, projectPath: destRel, bytes, projectRoot, deliverable: true, workspaceMode: 'project' };
        }
        const stagedRel = isBusinessDeliverablePath(sourceRel) ? sourceRel : toOutputPath(sourceRel);
        const destRel = safeRelative(destPath || (isUnderWorkspaceOutput(sourceRel)
          ? sourceRel.slice(WORKSPACE_OUTPUT_DIR.length + 1)
          : path.basename(sourceRel)));
        if (!isBusinessDeliverablePath(stagedRel)) {
          return {
            ok: false,
            error: 'Only files under output/ may be published. Write/register the finished product with deliverable=true or register_deliverable first.',
          };
        }
        let source: string;
        try {
          source = await workspacePath(isBusinessDeliverablePath(sourceRel) ? sourceRel : stagedRel);
          if (!(await stat(source)).isFile()) throw new Error('Not a file');
        } catch {
          // If caller passed a non-output path that exists, stage then publish.
          try {
            const raw = await workspacePath(sourceRel);
            if (!(await stat(raw)).isFile()) throw new Error('Not a file');
            const stagedAbs = await workspacePath(stagedRel);
            await mkdir(path.dirname(stagedAbs), { recursive: true, mode: 0o700 });
            await copyFile(raw, stagedAbs);
            source = stagedAbs;
          } catch {
            return { ok: false, error: `Run workspace file is unavailable: ${sourceRel}. Write it with write_workspace_file first.` };
          }
        }
        const dest = await projectPath(destRel);
        await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        await copyFile(source, dest);
        const bytes = (await stat(dest)).size;
        return { ok: true, path: stagedRel, projectPath: destRel, bytes, projectRoot, deliverable: true };
      },
    }),
    defineAgentTool({
      name: 'install_python_dependency',
      description: 'Install a Python package into this run workspace only when required to create or verify an artifact. This is allowed by default work permission; it never modifies system Python.',
      parameters: Type.Object({
        package: Type.String({ minLength: 1, maxLength: 120 }),
      }),
      execute: async ({ package: dependency }) => {
        if (!canRunWorkspaceScript) return scriptDenied();
        if (!/^[a-zA-Z0-9_.-]+(?:==[a-zA-Z0-9_.+-]+)?$/.test(dependency)) return { ok: false, error: 'Only a simple PyPI package name with an optional exact version is permitted.' };
        await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
        const dependencyRoot = path.join(workspaceRoot, '.python-packages');
        const moduleName = pythonImportProbeModuleName(dependency);
        const probe = await runPython(['-c', `import importlib.util, sys; sys.exit(0 if importlib.util.find_spec(${JSON.stringify(moduleName)}) else 1)`], workspaceRoot, { timeoutMs: 10_000 }).catch(() => null);
        if (probe?.exitCode === 0) {
          return {
            ok: true,
            package: dependency,
            exitCode: 0,
            alreadyAvailable: true,
            stdout: `Python module already available: ${moduleName}`,
            stderr: '',
          };
        }
        const result = await runPython(['-m', 'pip', 'install', '--disable-pip-version-check', '--target', dependencyRoot, dependency], workspaceRoot, { timeoutMs: 120_000 });
        return { ok: result.exitCode === 0, package: dependency, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      },
    }),
    defineAgentTool({
      name: 'fetch_skill_url',
      description: 'Fetch a public HTTPS URL for a loaded Skill. The URL host must be explicitly allowlisted by that Skill. This tool only performs GET requests and returns bounded text.',
      parameters: Type.Object({
        skillId: Type.String({ minLength: 1 }),
        url: Type.String({ minLength: 1, maxLength: 2_000 }),
      }),
      execute: async ({ skillId, url }) => {
        ensureLoaded(skillId);
        const skill = getSkill(skillId);
        let target: URL;
        try {
          target = new URL(url);
        } catch {
          return { ok: false, error: 'Invalid URL.' };
        }
        if (target.protocol !== 'https:') return { ok: false, error: 'Only HTTPS network requests are permitted.' };
        if (!skill.execution.allowAllNonDestructive && !skill.execution.allowedNetworkHosts.includes(target.hostname)) {
          return approval(skillId, 'network-access', `Network access to ${target.hostname} requires your approval and an allowlist entry.`);
        }
        const response = await fetch(target, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
          headers: { accept: 'text/plain, text/markdown, application/json, text/html;q=0.5' },
        });
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok) return { ok: false, status: response.status, error: `Network request failed with HTTP ${response.status}.` };
        if (!/^(text\/|application\/(json|xml|javascript))/i.test(contentType)) {
          return { ok: false, error: `Unsupported response content type: ${contentType || 'unknown'}.` };
        }
        const content = truncate(await response.text(), MAX_NETWORK_BYTES);
        return { ok: true, url: target.toString(), contentType, content };
      },
    }),
    defineAgentTool({
      name: 'export_data_app_custom_site',
      description: 'Export the currently published HTML of an existing OpenClawX data app into this run workspace before conversational optimization.',
      parameters: Type.Object({
        appId: Type.String({ minLength: 8, maxLength: 80 }),
        token: Type.String({ minLength: 8, maxLength: 200 }),
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      }),
      execute: async ({ appId, token, path: relative }) => {
        if (!canWriteWorkspace) return writeDenied();
        const targetRel = safeRelative(relative || 'output/index.html');
        if (!/\.html?$/i.test(targetRel)) return { ok: false as const, error: 'Export target must be an HTML file.' };
        const origin = (process.env.OPENCLAWX_API_ORIGIN?.trim() || `http://127.0.0.1:${process.env.OPENCLAWX_API_PORT?.trim() || process.env.PORT?.trim() || '47832'}`).replace(/\/$/, '');
        try {
          const response = await fetch(`${origin}/api/data-apps/${encodeURIComponent(appId)}/site?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(30_000) });
          if (!response.ok) return { ok: false as const, status: response.status, error: `Current site export failed with HTTP ${response.status}.` };
          const html = await response.text();
          if (Buffer.byteLength(html, 'utf8') > 2_500_000) return { ok: false as const, error: 'Current site exceeds the 2.5MB workspace limit.' };
          const target = await workspacePath(targetRel);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, html, 'utf8');
          return { ok: true as const, appId, path: targetRel, bytes: Buffer.byteLength(html, 'utf8') };
        } catch (error) {
          return { ok: false as const, error: error instanceof Error ? error.message : 'Current site export failed.' };
        }
      },
    }),
    defineAgentTool({
      name: 'bind_data_app_custom_site',
      description:
        'Bind a finished HTML file from this run workspace as the published custom site for a OpenClawX local data app. '
        + 'Use after writing output/index.html. Reads the file on disk and uploads it — do NOT paste HTML into MCP fetch / PUT tool args.',
      parameters: Type.Object({
        appId: Type.String({ minLength: 8, maxLength: 80 }),
        token: Type.String({ minLength: 8, maxLength: 200 }),
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
        note: Type.Optional(Type.String({ maxLength: 200 })),
      }),
      execute: async ({ appId, token, path: relative, note }) => {
        if (!canWriteWorkspace) return writeDenied();
        const sourceRel = safeRelative(relative || 'output/index.html');
        if (!/\.html?$/i.test(sourceRel)) {
          return { ok: false as const, error: 'Only .html files can be bound as a data-app custom site.' };
        }
        let file: string;
        try {
          file = await workspacePath(sourceRel);
          if (!(await stat(file)).isFile()) throw new Error('Not a file');
        } catch {
          return { ok: false as const, error: `Workspace HTML unavailable: ${sourceRel}. Write it first.` };
        }
        const html = await readFile(file, 'utf8');
        if (html.trim().length < 32) {
          return { ok: false as const, error: 'HTML file is empty or too short.' };
        }
        if (Buffer.byteLength(html, 'utf8') > 2_500_000) {
          return { ok: false as const, error: 'HTML exceeds 2.5MB bind limit. Simplify the page.' };
        }
        const origin = (
          process.env.OPENCLAWX_API_ORIGIN?.trim()
          || `http://127.0.0.1:${process.env.OPENCLAWX_API_PORT?.trim() || process.env.PORT?.trim() || '47832'}`
        ).replace(/\/$/, '');
        const target = `${origin}/api/data-apps/${encodeURIComponent(appId)}/custom-site?token=${encodeURIComponent(token)}`;
        try {
          const response = await fetch(target, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ html, note: String(note || 'agent').slice(0, 200) }),
            signal: AbortSignal.timeout(60_000),
          });
          const body = await response.json().catch(() => ({})) as { ok?: boolean; url?: string; message?: string };
          if (!response.ok) {
            return {
              ok: false as const,
              error: body.message || `Bind failed with HTTP ${response.status}`,
              status: response.status,
            };
          }
          return {
            ok: true as const,
            appId,
            path: sourceRel,
            bytes: Buffer.byteLength(html, 'utf8'),
            url: body.url || `${origin}/api/data-apps/${encodeURIComponent(appId)}/site?token=${encodeURIComponent(token)}`,
          };
        } catch (error) {
          return {
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    }),
  ];

  // This is deliberately a Skill-owned adapter, not a platform PDF tool. It is
  // exposed only when the authorized PDF Skill is present, keeping generic
  // agents and unrelated Skills free to choose their own execution strategy.
  if (packages.has(PDF_SKILL_ID)) {
    tools.push(defineAgentTool({
      name: 'render_pdf_report',
      description: 'PDF 报告生成 Skill 的专属适配器。传入标题、正文和文件名；它在隔离工作区中安全生成、校验并声明唯一 PDF 交付物。不要手写 JSON、复制渲染器或改用 workspace 脚本。',
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 240 }),
        content: Type.String({ minLength: 1, maxLength: 80_000 }),
        filename: Type.String({ minLength: 1, maxLength: 180 }),
      }),
      execute: async ({ title, content, filename }) => {
        if (!canWriteWorkspace || !canRunWorkspaceScript) return writeDenied();
        ensureLoaded(PDF_SKILL_ID);
        const skill = getSkill(PDF_SKILL_ID);
        if (!skill.execution.allowScriptExecution) {
          return approval(PDF_SKILL_ID, 'script-execution', 'Running this PDF Skill requires your approval.');
        }
        const root = approvedSkillRoot(skill);
        if (!root) return { ok: false, error: 'PDF Skill renderer is unavailable for this package.' };
        let script: string;
        try {
          script = await pathInside(root, 'scripts/render_pdf.py');
          if (!(await stat(script)).isFile()) throw new Error('Not a file');
        } catch {
          return { ok: false, error: 'PDF Skill renderer is unavailable: scripts/render_pdf.py.' };
        }

        const leaf = path.basename(filename.trim());
        if (!leaf || leaf === '.' || leaf === '..' || leaf !== filename.trim() || leaf.startsWith('.')) {
          return { ok: false, error: 'PDF filename must be a plain file name without a path.' };
        }
        const outputName = /\.pdf$/i.test(leaf) ? leaf : `${leaf}.pdf`;
        const outputRel = `${WORKSPACE_OUTPUT_DIR}/${outputName}`;
        if (!isBusinessDeliverablePath(outputRel)) return { ok: false, error: 'PDF filename is invalid.' };

        const inputRel = 'tmp/pdf-input.json';
        const inputFile = await workspacePath(inputRel);
        const outputFile = await workspacePath(outputRel);
        await mkdir(path.dirname(inputFile), { recursive: true, mode: 0o700 });
        await mkdir(path.dirname(outputFile), { recursive: true, mode: 0o700 });
        await writeFile(inputFile, JSON.stringify({ title: title.trim(), content: content.trim() }), { encoding: 'utf8', mode: 0o600 });

        const dependencyRoot = path.join(workspaceRoot, '.python-packages');
        const runRenderer = () => runPython([script, inputRel, outputRel], workspaceRoot, {
          env: { ...process.env, PYTHONPATH: dependencyRoot },
        });
        let result = await runRenderer();
        let installedDependency = false;
        const diagnostics = () => `${result.stdout}\n${result.stderr}`;
        if (result.exitCode !== 0 && /no module named ['\"]reportlab['\"]/i.test(diagnostics())) {
          const install = await runPython(['-m', 'pip', 'install', '--disable-pip-version-check', '--target', dependencyRoot, 'reportlab'], workspaceRoot, { timeoutMs: 120_000 });
          if (install.exitCode !== 0) {
            return { ok: false, exitCode: install.exitCode, error: truncate(`${install.stderr}\n${install.stdout}`, 2_000), artifacts: [] };
          }
          installedDependency = true;
          result = await runRenderer();
        }
        if (result.exitCode !== 0) {
          return { ok: false, exitCode: result.exitCode, error: truncate(diagnostics(), 2_000), stdout: result.stdout, stderr: result.stderr, artifacts: [] };
        }
        try {
          const bytes = await readFile(outputFile);
          if (bytes.length < 512 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('invalid PDF header');
          return {
            ok: true,
            path: outputRel,
            bytes: bytes.length,
            title: title.trim(),
            contentPreview: pdfChatPreview(content),
            presentationHint: '最终回答除文件名外，应给出结构化内容摘要；行程类至少列出逐日核心安排。',
            artifacts: [outputRel],
            installedDependency,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        } catch {
          return { ok: false, error: 'PDF renderer completed but did not produce a valid PDF file.', artifacts: [] };
        }
      },
    }));
  }
  return tools;
}
