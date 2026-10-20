import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { copyFile, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { workspacesRootDir } from '@openclawx/agent-core';
import { DurableTaskSchema } from '@openclawx/contracts';
import type {
  DurableTask,
  DurableTaskArtifactRole,
  DurableTaskStatus,
  DurableTaskWorkingSetEntry,
} from '@openclawx/contracts';
import { deleteKey, listJsonIds, readJson, writeJson } from './repo.js';
import type { KeyValueStore } from './storage/kv.js';
import { namespaceKey } from './storage/kv.js';
import type { RunRecord } from './types.js';

export const DURABLE_TASK_KEY_PREFIX = 'durable-tasks:';
const TASK_NS = 'durable-tasks';
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const EXCLUDED_NAMES = new Set(['.task', '.git', '.python-packages', 'node_modules', '__pycache__', '.DS_Store']);
const RESUMABLE = new Set<DurableTaskStatus>(['running', 'waiting_user', 'waiting_external', 'paused', 'failed']);
const CONTINUATION_PATTERN = /(?:尚未|未完成|还需|仍需|下一步|请继续|需要继续|等待.+后)/i;

function tasksRootDir(): string {
  return process.env.OPENCLAWX_TASKS_DIR?.trim()
    || path.join(process.env.OPENCLAWX_DATA_DIR?.trim() || path.join(os.homedir(), '.openclawx'), 'tasks');
}

function safeLogicalPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.length > 500 || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid task working-set path.');
  }
  return normalized;
}

function within(root: string, relative: string): string {
  const target = path.resolve(root, safeLogicalPath(relative));
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Task path escapes its workspace.');
  return target;
}

function roleFor(relative: string): DurableTaskArtifactRole {
  if (relative === 'output' || relative.startsWith('output/')) return 'deliverable';
  if (/^(state|checkpoints?)\//i.test(relative)) return 'state';
  return 'intermediate';
}

function checkpointStatus(run: RunRecord, hasExistingDeliverable = false): DurableTaskStatus {
  if (run.status === 'completed') {
    const hasFailedStep = run.activities.some((activity) => activity.status === 'failed');
    const hasDeliverable = run.artifacts.some((artifact) => /(^|\/)output\//i.test(artifact.path) || /\.[a-z0-9]{2,8}$/i.test(artifact.path));
    const hasContinuation = CONTINUATION_PATTERN.test(run.transcript);
    const textClaimsCompletion = /(?:任务|工作|处理|制作|转换|生成|交付).{0,12}(?:已完成|完成了|已生成|已交付)|(?:全部|最终).{0,12}(?:完成|生成|交付)/i.test(run.transcript);
    // A clean run with a produced deliverable is terminal. Text-only completion
    // is accepted only when the answer explicitly says the whole task finished.
    return !hasFailedStep && !hasContinuation && (hasDeliverable || hasExistingDeliverable || textClaimsCompletion) ? 'completed' : 'waiting_user';
  }
  if (run.status === 'cancelled') return 'paused';
  if (run.status === 'waiting-approval') return 'waiting_user';
  if (/network|fetch failed|timeout|socket/i.test(run.error ?? '')) return 'waiting_external';
  return 'failed';
}

export function isDurableTaskResumeIntent(text: string): boolean {
  return /(?:^|[，。,.!?\s])(继续|接着|恢复|续跑|重试|补齐|完成剩余|从上次继续)/i.test(text.trim());
}

export function shouldCreateDurableTask(text: string, fileCount = 0): boolean {
  const value = text.trim();
  if (value.length < 4) return false;
  const explicit = /(分阶段|多步骤|长期任务|持续任务|后续继续|稍后继续|批量处理|完整项目|从头到尾)/i.test(value);
  const producesOutput = /(生成|制作|创建|开发|编写|修改|改写|转换|转成|导出|搭建|设计|合并|拆分)/i.test(value);
  const deepProcessing = /(处理|分析|整理|检查|审核|总结|提取)/i.test(value);
  const complexityCue = /(完整|详细|逐个|逐项|逐页|分批|批量|全部|最终|交付|多个|多份|一整套)/i.test(value);
  return explicit || (fileCount > 0 && (producesOutput || (deepProcessing && (fileCount > 1 || complexityCue))));
}

export class DurableTaskService {
  private readonly tasksRoot: string;
  private readonly runsRoot: string;

  constructor(private readonly store: KeyValueStore, options: { tasksRoot?: string; runsRoot?: string } = {}) {
    this.tasksRoot = options.tasksRoot ?? tasksRootDir();
    this.runsRoot = options.runsRoot ?? workspacesRootDir();
  }

  private key(id: string): string { return namespaceKey(TASK_NS, id); }
  private root(id: string): string { return path.join(this.tasksRoot, id); }
  private workingRoot(id: string): string { return path.join(this.root(id), 'working'); }

  async create(input: { conversationId: string; title?: string; objective: string }): Promise<DurableTask> {
    const now = Date.now();
    const task: DurableTask = {
      id: randomUUID(), conversationId: input.conversationId,
      title: (input.title?.trim() || input.objective.trim()).slice(0, 120),
      objective: input.objective.trim().slice(0, 4_000), status: 'running', version: 1,
      runIds: [], workingSet: [], assetRefs: [], checkpoints: [], createdAt: now, updatedAt: now,
    };
    await mkdir(this.workingRoot(task.id), { recursive: true, mode: 0o700 });
    await this.save(task);
    return task;
  }

  async get(id: string): Promise<DurableTask | null> {
    const value = await readJson<DurableTask>(this.store, this.key(id));
    return value ? DurableTaskSchema.parse(value) : null;
  }

  async listForConversation(conversationId: string): Promise<DurableTask[]> {
    const ids = await listJsonIds(this.store, DURABLE_TASK_KEY_PREFIX);
    const tasks = await Promise.all(ids.map((id) => this.get(id)));
    const scoped = tasks.filter((task): task is DurableTask => Boolean(task && task.conversationId === conversationId));
    // Repair older tasks that were left at waiting_user after a later clean
    // turn even though a deliverable had already been captured. Explicit
    // unfinished language always wins and keeps the task resumable.
    for (const task of scoped) {
      const latest = task.checkpoints.at(-1);
      const hasDeliverable = task.workingSet.some((item) => item.role === 'deliverable')
        || task.assetRefs.some((item) => item.role === 'deliverable');
      if (task.status === 'waiting_user' && latest && hasDeliverable && !CONTINUATION_PATTERN.test(latest.summary)) {
        task.status = 'completed'; task.version += 1; task.updatedAt = Date.now(); await this.save(task);
      }
    }
    return scoped.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async latestResumable(conversationId: string): Promise<DurableTask | null> {
    return (await this.listForConversation(conversationId)).find((task) => RESUMABLE.has(task.status)) ?? null;
  }

  async setStatus(id: string, status: DurableTaskStatus): Promise<DurableTask> {
    const task = await this.required(id);
    task.status = status; task.version += 1; task.updatedAt = Date.now();
    await this.save(task); return task;
  }

  async attachAsset(id: string, asset: { assetId: string; name: string; role?: DurableTaskArtifactRole; sourceRunId?: string }): Promise<DurableTask> {
    const task = await this.required(id);
    const existing = task.assetRefs.find((item) => item.assetId === asset.assetId);
    if (existing) Object.assign(existing, asset, { role: asset.role ?? existing.role });
    else task.assetRefs.push({ ...asset, role: asset.role ?? 'deliverable', addedAt: Date.now() });
    task.version += 1; task.updatedAt = Date.now(); await this.save(task); return task;
  }

  async addSourceFile(id: string, input: { attachmentId: string; name: string; mimeType: string; bytes: Uint8Array }): Promise<DurableTask> {
    const task = await this.required(id);
    const bytes = Buffer.from(input.bytes);
    if (!bytes.length) throw new Error('Task source file is empty.');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const duplicate = task.workingSet.find((entry) => entry.role === 'source' && entry.sha256 === sha256);
    if (duplicate) return task;
    if (task.workingSet.length >= MAX_FILES) throw new Error('Task working set has reached its file limit.');
    const totalBytes = task.workingSet.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    if (bytes.byteLength > MAX_TOTAL_BYTES || totalBytes + bytes.byteLength > MAX_TOTAL_BYTES) {
      throw new Error('Task working set has reached its storage limit.');
    }
    const rawName = path.basename(input.name).replace(/[\\/\x00-\x1f]/g, '_').trim().slice(0, 240) || 'source';
    let logicalPath = safeLogicalPath(`source/${rawName}`);
    const collision = task.workingSet.find((entry) => entry.logicalPath === logicalPath && entry.sha256 !== sha256);
    if (collision) {
      const extension = path.extname(rawName);
      const stem = rawName.slice(0, Math.max(1, rawName.length - extension.length));
      logicalPath = safeLogicalPath(`source/${stem}-${sha256.slice(0, 8)}${extension}`);
    }
    const destination = within(this.workingRoot(task.id), logicalPath);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { mode: 0o600 });
    task.workingSet.push({
      id: randomUUID(), logicalPath, role: 'source', sourceAttachmentId: input.attachmentId,
      mimeType: input.mimeType, sizeBytes: bytes.byteLength, sha256, updatedAt: Date.now(),
    });
    task.version += 1; task.updatedAt = Date.now(); await this.save(task); return task;
  }

  async prepareRun(taskId: string, runId: string): Promise<DurableTask> {
    const task = await this.required(taskId);
    const destinationRoot = path.join(this.runsRoot, runId, '.task');
    await rm(destinationRoot, { recursive: true, force: true });
    for (const entry of task.workingSet) {
      const source = within(this.workingRoot(task.id), entry.logicalPath);
      const destination = within(destinationRoot, entry.logicalPath);
      const info = await lstat(source).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) continue;
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
    }
    if (!task.runIds.includes(runId)) task.runIds.push(runId);
    task.status = 'running'; task.version += 1; task.updatedAt = Date.now(); await this.save(task); return task;
  }

  async settleRun(taskId: string, run: RunRecord): Promise<DurableTask> {
    const task = await this.required(taskId);
    await this.captureRunWorkspace(task, run.id);
    const hasExistingDeliverable = task.workingSet.some((item) => item.role === 'deliverable')
      || task.assetRefs.some((item) => item.role === 'deliverable');
    const status = checkpointStatus(run, hasExistingDeliverable);
    task.status = status;
    if (!task.runIds.includes(run.id)) task.runIds.push(run.id);
    task.checkpoints.push({
      id: randomUUID(), runId: run.id, status,
      summary: (run.transcript.trim() || run.error || `Run ${run.status}`).slice(0, 2_000),
      createdAt: Date.now(), workingSetVersion: task.version + 1,
    });
    if (task.checkpoints.length > 200) task.checkpoints.splice(0, task.checkpoints.length - 200);
    task.version += 1; task.updatedAt = Date.now(); await this.save(task); return task;
  }

  async deleteForConversation(conversationId: string): Promise<void> {
    for (const task of await this.listForConversation(conversationId)) {
      await deleteKey(this.store, this.key(task.id));
      await rm(this.root(task.id), { recursive: true, force: true });
    }
  }

  private async captureRunWorkspace(task: DurableTask, runId: string): Promise<void> {
    const runRoot = path.join(this.runsRoot, runId);
    const files = new Map<string, { relative: string; source: string; size: number }>();
    let total = 0;
    const walk = async (directory: string, relative = '', depth = 0): Promise<void> => {
      if (depth > 12 || files.size >= MAX_FILES || total >= MAX_TOTAL_BYTES) return;
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (EXCLUDED_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        const source = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(source, child, depth + 1);
        else if (entry.isFile()) {
          const info = await stat(source).catch(() => null);
          if (!info || info.size > MAX_TOTAL_BYTES || total + info.size > MAX_TOTAL_BYTES) continue;
          const logicalPath = safeLogicalPath(child);
          const previous = files.get(logicalPath);
          const nextTotal = total - (previous?.size ?? 0) + info.size;
          if (nextTotal > MAX_TOTAL_BYTES) continue;
          files.set(logicalPath, { relative: logicalPath, source, size: info.size }); total = nextTotal;
        }
      }
    };
    // A resumed run receives prior state under .task/. Capture changes made there
    // back into the durable working set, then let same-path files at run root win.
    await walk(path.join(runRoot, '.task'));
    await walk(runRoot);
    for (const file of files.values()) {
      const sourceInfo = await lstat(file.source).catch(() => null);
      if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) continue;
      const destination = within(this.workingRoot(task.id), file.relative);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(file.source, destination);
      const sha256 = createHash('sha256').update(await readFile(destination)).digest('hex');
      const existing = task.workingSet.find((item) => item.logicalPath === file.relative);
      const next: DurableTaskWorkingSetEntry = {
        id: existing?.id ?? randomUUID(),
        logicalPath: file.relative, role: existing?.role ?? roleFor(file.relative),
        ...(existing?.sourceAttachmentId ? { sourceAttachmentId: existing.sourceAttachmentId } : {}),
        ...(existing?.mimeType ? { mimeType: existing.mimeType } : {}),
        sourceRunId: existing?.role === 'source' ? existing.sourceRunId : runId,
        sizeBytes: file.size, sha256, updatedAt: Date.now(),
      };
      const index = task.workingSet.findIndex((item) => item.logicalPath === file.relative);
      if (index >= 0) task.workingSet[index] = next; else task.workingSet.push(next);
    }
  }

  private async required(id: string): Promise<DurableTask> {
    const task = await this.get(id); if (!task) throw new Error('Durable task not found.'); return task;
  }
  private async save(task: DurableTask): Promise<void> { await writeJson(this.store, this.key(task.id), DurableTaskSchema.parse(task)); }
}
