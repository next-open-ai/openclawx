import { randomUUID } from 'node:crypto';
import type { RunModelRef, TokenUsage } from '@openclawx/contracts';
import type { ChatSessionService } from './chat-session.js';
import type { ProjectService } from './project.js';
import { deleteKey, readJson, writeJson } from './repo.js';
import type { RunEngine } from './run-engine.js';
import type { KeyValueStore } from './storage/kv.js';
import { namespaceKey } from './storage/kv.js';
import type { RunModelInfo, RunRecord, RunUsage, RunUsageStep } from './types.js';

const MAX_USAGE_STEPS = 64;

/** Soft ceiling for per-run usage details; when exceeded, older ones are rolled up. */
export const USAGE_DETAIL_LIMIT = 200;
/** Newest per-run usage rows to keep after a compaction. */
export const USAGE_DETAIL_KEEP = 50;

export const USAGE_ROLLUP_NS = 'usage-rollup';

export function emptyRunUsage(): RunUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    steps: [],
    byModel: [],
  };
}

export function modelInfoFromRequest(model: {
  provider: string;
  chatModel: string;
  baseUrl?: string;
  providerLabel?: string;
}): RunModelInfo {
  return {
    provider: model.provider,
    chatModel: model.chatModel,
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    ...(model.providerLabel ? { providerLabel: model.providerLabel } : {}),
  };
}

export function applyUsageEvent(
  run: RunRecord,
  usage: TokenUsage,
  model?: RunModelRef,
  capability?: import('@openclawx/contracts').ModelCapability,
): void {
  if (model && !run.model) {
    run.model = {
      provider: model.provider,
      chatModel: model.chatModel,
      ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
      ...(model.providerLabel ? { providerLabel: model.providerLabel } : {}),
    };
  }
  const bucket = run.usage ?? emptyRunUsage();
  const step: RunUsageStep = {
    at: Date.now(),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cacheReadTokens ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
    ...(model ? { model: { ...model } } : {}),
    ...(capability ? { capability } : {}),
  };
  bucket.steps.push(step);
  if (bucket.steps.length > MAX_USAGE_STEPS) {
    bucket.steps.splice(0, bucket.steps.length - MAX_USAGE_STEPS);
  }
  bucket.inputTokens += usage.inputTokens;
  bucket.outputTokens += usage.outputTokens;
  bucket.cacheReadTokens += usage.cacheReadTokens ?? 0;
  bucket.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  bucket.reasoningTokens += usage.reasoningTokens ?? 0;
  bucket.totalTokens += usage.totalTokens;
  const attributedModel = model ?? run.model;
  if (attributedModel) {
    const key = modelKey(attributedModel, capability);
    const models = bucket.byModel ??= [];
    let row = models.find((item) => modelKey(item, item.capability) === key);
    if (!row) {
      row = {
        ...attributedModel,
        ...(capability ? { capability } : {}),
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0,
      };
      models.push(row);
    }
    row.inputTokens += usage.inputTokens;
    row.outputTokens += usage.outputTokens;
    row.cacheReadTokens += usage.cacheReadTokens ?? 0;
    row.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    row.reasoningTokens += usage.reasoningTokens ?? 0;
    row.totalTokens += usage.totalTokens;
  }
  run.usage = bucket;
}

export interface UsageBucketTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  runCount: number;
}

export interface UsageStats {
  totals: UsageBucketTotals;
  byModel: Array<UsageBucketTotals & {
    provider: string;
    chatModel: string;
    baseUrl?: string;
    providerLabel?: string;
    key: string;
    capability?: import('@openclawx/contracts').ModelCapability;
  }>;
  byProject: Array<UsageBucketTotals & { projectId: string; name: string }>;
  byChat: Array<UsageBucketTotals & { sessionId: string; title: string }>;
  /** Local-calendar day buckets (`YYYY-MM-DD`), newest first. */
  byDay: Array<UsageBucketTotals & { period: string }>;
  /** Local ISO-week buckets (`YYYY-Www`), newest first. */
  byWeek: Array<UsageBucketTotals & { period: string }>;
  /** Local-calendar month buckets (`YYYY-MM`), newest first. */
  byMonth: Array<UsageBucketTotals & { period: string }>;
  recent: Array<{
    runId: string;
    sessionId: string;
    kind: RunRecord['kind'];
    taskId?: string;
    startedAt: number;
    finishedAt?: number;
    status: RunRecord['status'];
    provider?: string;
    chatModel?: string;
    baseUrl?: string;
    providerLabel?: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  }>;
  /** Present when historical details were compacted into a rollup. */
  rollup?: {
    id: string;
    periodStart: number;
    periodEnd: number;
    mergedRunCount: number;
  };
}

/** Durable merge of older per-run usage details (at most one kept after compact). */
export interface UsageRollup {
  id: string;
  createdAt: number;
  periodStart: number;
  periodEnd: number;
  mergedRunCount: number;
  totals: UsageBucketTotals;
  byModel: UsageStats['byModel'];
  byProject: UsageStats['byProject'];
  byChat: UsageStats['byChat'];
  byDay?: UsageStats['byDay'];
  byWeek?: UsageStats['byWeek'];
  byMonth?: UsageStats['byMonth'];
}

function emptyTotals(): UsageBucketTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    runCount: 0,
  };
}

function hasUsage(usage: RunUsage | undefined): boolean {
  if (!usage) return false;
  return usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0;
}

function addTotals(target: UsageBucketTotals, source: UsageBucketTotals) {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.totalTokens += source.totalTokens;
  target.runCount += source.runCount;
}

function addRunToTotals(target: UsageBucketTotals, run: RunRecord) {
  const usage = run.usage;
  if (!hasUsage(usage)) return false;
  target.inputTokens += usage!.inputTokens;
  target.outputTokens += usage!.outputTokens;
  target.cacheReadTokens += usage!.cacheReadTokens;
  target.cacheWriteTokens += usage!.cacheWriteTokens;
  target.reasoningTokens += usage!.reasoningTokens;
  target.totalTokens += usage!.totalTokens;
  target.runCount += 1;
  return true;
}

function modelKey(model: RunModelInfo | undefined, capability?: import('@openclawx/contracts').ModelCapability): string {
  if (!model) return 'unknown';
  return [model.provider, model.chatModel, model.baseUrl || '', model.providerLabel || '', capability || 'chat'].join('|');
}

function sortByTotal<T extends UsageBucketTotals>(rows: T[]) {
  return rows.sort((a, b) => b.totalTokens - a.totalTokens || b.runCount - a.runCount);
}

function sortByPeriodDesc<T extends { period: string }>(rows: T[]) {
  return rows.sort((a, b) => b.period.localeCompare(a.period));
}

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

/** Local calendar day / ISO week / month keys for a timestamp. */
export function usagePeriodKeys(ts: number): { day: string; week: string; month: string } {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const dayKey = `${year}-${pad2(month)}-${pad2(day)}`;
  const monthKey = `${year}-${pad2(month)}`;

  // ISO week (Monday-based), using local calendar date.
  const cursor = new Date(year, date.getMonth(), day);
  const dayNr = (cursor.getDay() + 6) % 7;
  cursor.setDate(cursor.getDate() - dayNr + 3);
  const weekYear = cursor.getFullYear();
  const firstThursday = new Date(weekYear, 0, 4);
  const week =
    1 +
    Math.round((cursor.getTime() - firstThursday.getTime()) / 604_800_000);
  const weekKey = `${weekYear}-W${pad2(week)}`;
  return { day: dayKey, week: weekKey, month: monthKey };
}

function mergePeriodRows(
  into: Map<string, UsageBucketTotals & { period: string }>,
  rows: Array<UsageBucketTotals & { period: string }> | undefined,
) {
  for (const row of rows ?? []) {
    let bucket = into.get(row.period);
    if (!bucket) {
      bucket = { ...emptyTotals(), period: row.period };
      into.set(row.period, bucket);
    }
    addTotals(bucket, row);
  }
}

function addRunToPeriod(
  into: Map<string, UsageBucketTotals & { period: string }>,
  period: string,
  run: RunRecord,
) {
  let bucket = into.get(period);
  if (!bucket) {
    bucket = { ...emptyTotals(), period };
    into.set(period, bucket);
  }
  addRunToTotals(bucket, run);
}

function mergeModelRows(
  into: Map<string, UsageStats['byModel'][number]>,
  rows: UsageStats['byModel'],
) {
  for (const row of rows) {
    let bucket = into.get(row.key);
    if (!bucket) {
      bucket = { ...emptyTotals(), key: row.key, provider: row.provider, chatModel: row.chatModel };
      if (row.baseUrl) bucket.baseUrl = row.baseUrl;
      if (row.providerLabel) bucket.providerLabel = row.providerLabel;
      if (row.capability) bucket.capability = row.capability;
      into.set(row.key, bucket);
    }
    addTotals(bucket, row);
  }
}

function mergeProjectRows(
  into: Map<string, UsageStats['byProject'][number]>,
  rows: UsageStats['byProject'],
) {
  for (const row of rows) {
    let bucket = into.get(row.projectId);
    if (!bucket) {
      bucket = { ...emptyTotals(), projectId: row.projectId, name: row.name };
      into.set(row.projectId, bucket);
    } else if (row.name && row.name !== row.projectId) {
      bucket.name = row.name;
    }
    addTotals(bucket, row);
  }
}

function mergeChatRows(
  into: Map<string, UsageStats['byChat'][number]>,
  rows: UsageStats['byChat'],
) {
  for (const row of rows) {
    let bucket = into.get(row.sessionId);
    if (!bucket) {
      bucket = { ...emptyTotals(), sessionId: row.sessionId, title: row.title };
      into.set(row.sessionId, bucket);
    } else if (row.title && row.title !== row.sessionId) {
      bucket.title = row.title;
    }
    addTotals(bucket, row);
  }
}

function contributeRun(
  run: RunRecord,
  totals: UsageBucketTotals,
  modelMap: Map<string, UsageStats['byModel'][number]>,
  projectMap: Map<string, UsageStats['byProject'][number]>,
  chatMap: Map<string, UsageStats['byChat'][number]>,
  dayMap: Map<string, UsageBucketTotals & { period: string }>,
  weekMap: Map<string, UsageBucketTotals & { period: string }>,
  monthMap: Map<string, UsageBucketTotals & { period: string }>,
  labels: { sessionTitle: Map<string, string>; projectName: Map<string, string> },
) {
  if (!addRunToTotals(totals, run)) return;

  const attributed = run.usage?.byModel?.length ? run.usage.byModel : [{
    ...(run.model ?? { provider: 'unknown', chatModel: 'unknown' }),
    inputTokens: run.usage!.inputTokens, outputTokens: run.usage!.outputTokens,
    cacheReadTokens: run.usage!.cacheReadTokens, cacheWriteTokens: run.usage!.cacheWriteTokens,
    reasoningTokens: run.usage!.reasoningTokens, totalTokens: run.usage!.totalTokens,
  }];
  for (const item of attributed) {
    const key = modelKey(item, item.capability);
    let modelBucket = modelMap.get(key);
    if (!modelBucket) {
      modelBucket = {
        ...emptyTotals(), key, provider: item.provider, chatModel: item.chatModel,
        ...(item.baseUrl ? { baseUrl: item.baseUrl } : {}),
        ...(item.providerLabel ? { providerLabel: item.providerLabel } : {}),
        ...(item.capability ? { capability: item.capability } : {}),
      };
      modelMap.set(key, modelBucket);
    }
    modelBucket.inputTokens += item.inputTokens;
    modelBucket.outputTokens += item.outputTokens;
    modelBucket.cacheReadTokens += item.cacheReadTokens;
    modelBucket.cacheWriteTokens += item.cacheWriteTokens;
    modelBucket.reasoningTokens += item.reasoningTokens;
    modelBucket.totalTokens += item.totalTokens;
    modelBucket.runCount += 1;
  }

  if (run.kind === 'project-task') {
    let projectBucket = projectMap.get(run.sessionId);
    if (!projectBucket) {
      projectBucket = {
        ...emptyTotals(),
        projectId: run.sessionId,
        name: labels.projectName.get(run.sessionId) || run.sessionId,
      };
      projectMap.set(run.sessionId, projectBucket);
    }
    addRunToTotals(projectBucket, run);
  } else {
    let chatBucket = chatMap.get(run.sessionId);
    if (!chatBucket) {
      chatBucket = {
        ...emptyTotals(),
        sessionId: run.sessionId,
        title: labels.sessionTitle.get(run.sessionId) || run.sessionId,
      };
      chatMap.set(run.sessionId, chatBucket);
    }
    addRunToTotals(chatBucket, run);
  }

  const periods = usagePeriodKeys(run.startedAt);
  addRunToPeriod(dayMap, periods.day, run);
  addRunToPeriod(weekMap, periods.week, run);
  addRunToPeriod(monthMap, periods.month, run);
}

function rollupKey(id: string) {
  return namespaceKey(USAGE_ROLLUP_NS, id);
}

export async function listUsageRollups(store: KeyValueStore): Promise<UsageRollup[]> {
  const keys = await store.keys(`${USAGE_ROLLUP_NS}:`);
  const rows: UsageRollup[] = [];
  for (const key of keys) {
    const item = await readJson<UsageRollup>(store, key);
    if (item) rows.push(item);
  }
  return rows.sort((a, b) => a.periodStart - b.periodStart);
}

/**
 * When per-run usage details exceed {@link USAGE_DETAIL_LIMIT}, merge older ones
 * (plus any existing rollups) into a single rollup and strip usage from those runs.
 * Chat/project RunRecords themselves are kept; only the usage payload is removed.
 */
export async function maybeCompactUsage(input: {
  store: KeyValueStore;
  engine: RunEngine;
  chat?: ChatSessionService;
  projects?: ProjectService;
  limit?: number;
  keep?: number;
}): Promise<UsageRollup | null> {
  const limit = input.limit ?? USAGE_DETAIL_LIMIT;
  const keep = Math.min(input.keep ?? USAGE_DETAIL_KEEP, Math.max(0, limit - 1));
  const runs = await input.engine.listRuns();
  const withUsage = runs
    .filter((run) => hasUsage(run.usage))
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  if (withUsage.length <= limit) return null;

  const mergeCount = withUsage.length - keep;
  const toMerge = withUsage.slice(0, mergeCount);
  const existing = await listUsageRollups(input.store);

  const sessions = input.chat ? await input.chat.listChatSessions() : [];
  const projects = input.projects ? await input.projects.listProjects() : [];
  const labels = {
    sessionTitle: new Map(sessions.map((item) => [item.id, item.title || item.id])),
    projectName: new Map(projects.map((item) => [item.id, item.name || item.id])),
  };

  const totals = emptyTotals();
  const modelMap = new Map<string, UsageStats['byModel'][number]>();
  const projectMap = new Map<string, UsageStats['byProject'][number]>();
  const chatMap = new Map<string, UsageStats['byChat'][number]>();
  const dayMap = new Map<string, UsageBucketTotals & { period: string }>();
  const weekMap = new Map<string, UsageBucketTotals & { period: string }>();
  const monthMap = new Map<string, UsageBucketTotals & { period: string }>();

  for (const rollup of existing) {
    addTotals(totals, rollup.totals);
    mergeModelRows(modelMap, rollup.byModel);
    mergeProjectRows(projectMap, rollup.byProject);
    mergeChatRows(chatMap, rollup.byChat);
    mergePeriodRows(dayMap, rollup.byDay);
    mergePeriodRows(weekMap, rollup.byWeek);
    mergePeriodRows(monthMap, rollup.byMonth);
  }
  for (const run of toMerge) {
    contributeRun(run, totals, modelMap, projectMap, chatMap, dayMap, weekMap, monthMap, labels);
  }

  const periodStart = Math.min(
    ...existing.map((item) => item.periodStart),
    ...toMerge.map((item) => item.startedAt),
  );
  const periodEnd = Math.max(
    ...existing.map((item) => item.periodEnd),
    ...toMerge.map((item) => item.finishedAt ?? item.startedAt),
  );

  const rollup: UsageRollup = {
    id: randomUUID(),
    createdAt: Date.now(),
    periodStart,
    periodEnd,
    mergedRunCount: totals.runCount,
    totals,
    byModel: sortByTotal([...modelMap.values()]),
    byProject: sortByTotal([...projectMap.values()]),
    byChat: sortByTotal([...chatMap.values()]),
    byDay: sortByPeriodDesc([...dayMap.values()]),
    byWeek: sortByPeriodDesc([...weekMap.values()]),
    byMonth: sortByPeriodDesc([...monthMap.values()]),
  };

  await writeJson(input.store, rollupKey(rollup.id), rollup);

  for (const old of existing) {
    await deleteKey(input.store, rollupKey(old.id));
  }

  for (const run of toMerge) {
    // Drop detailed usage from the run; keep model metadata for attribution elsewhere.
    delete run.usage;
    // Trim usage events from the bounded event log to reclaim space.
    run.eventLog = run.eventLog.filter((event) => event.type !== 'run.usage');
    await input.engine.save(run);
  }

  return rollup;
}

export async function buildUsageStats(input: {
  engine: RunEngine;
  chat: ChatSessionService;
  projects: ProjectService;
}): Promise<UsageStats> {
  const store = input.engine.store;
  await maybeCompactUsage({
    store,
    engine: input.engine,
    chat: input.chat,
    projects: input.projects,
  });

  const runs = await input.engine.listRuns();
  const sessions = await input.chat.listChatSessions();
  const projects = await input.projects.listProjects();
  const labels = {
    sessionTitle: new Map(sessions.map((item) => [item.id, item.title || item.id])),
    projectName: new Map(projects.map((item) => [item.id, item.name || item.id])),
  };

  const totals = emptyTotals();
  const modelMap = new Map<string, UsageStats['byModel'][number]>();
  const projectMap = new Map<string, UsageStats['byProject'][number]>();
  const chatMap = new Map<string, UsageStats['byChat'][number]>();
  const dayMap = new Map<string, UsageBucketTotals & { period: string }>();
  const weekMap = new Map<string, UsageBucketTotals & { period: string }>();
  const monthMap = new Map<string, UsageBucketTotals & { period: string }>();
  const recent: UsageStats['recent'] = [];

  const rollups = await listUsageRollups(store);
  for (const rollup of rollups) {
    addTotals(totals, rollup.totals);
    mergeModelRows(modelMap, rollup.byModel);
    mergeProjectRows(projectMap, rollup.byProject);
    mergeChatRows(chatMap, rollup.byChat);
    mergePeriodRows(dayMap, rollup.byDay);
    mergePeriodRows(weekMap, rollup.byWeek);
    mergePeriodRows(monthMap, rollup.byMonth);
  }

  for (const run of runs) {
    if (!hasUsage(run.usage)) continue;
    contributeRun(run, totals, modelMap, projectMap, chatMap, dayMap, weekMap, monthMap, labels);
    const usage = run.usage!;
    recent.push({
      runId: run.id,
      sessionId: run.sessionId,
      kind: run.kind,
      ...(run.taskId ? { taskId: run.taskId } : {}),
      startedAt: run.startedAt,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      status: run.status,
      ...(run.model?.provider ? { provider: run.model.provider } : {}),
      ...(run.model?.chatModel ? { chatModel: run.model.chatModel } : {}),
      ...(run.model?.baseUrl ? { baseUrl: run.model.baseUrl } : {}),
      ...(run.model?.providerLabel ? { providerLabel: run.model.providerLabel } : {}),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
    });
  }

  recent.sort((a, b) => b.startedAt - a.startedAt);
  const primaryRollup = rollups[0];

  return {
    totals,
    byModel: sortByTotal([...modelMap.values()]),
    byProject: sortByTotal([...projectMap.values()]),
    byChat: sortByTotal([...chatMap.values()]),
    byDay: sortByPeriodDesc([...dayMap.values()]).slice(0, 90),
    byWeek: sortByPeriodDesc([...weekMap.values()]).slice(0, 52),
    byMonth: sortByPeriodDesc([...monthMap.values()]).slice(0, 36),
    recent: recent.slice(0, 100),
    ...(primaryRollup
      ? {
          rollup: {
            id: primaryRollup.id,
            periodStart: primaryRollup.periodStart,
            periodEnd: primaryRollup.periodEnd,
            mergedRunCount: primaryRollup.mergedRunCount,
          },
        }
      : {}),
  };
}
