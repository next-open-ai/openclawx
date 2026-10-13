import path from 'node:path';
import { cosine, ensureDir, readJsonFile, writeJsonFile } from './embed.js';
import { experienceDirForAgent } from './paths.js';
import { invalidateExperienceRecallReadiness } from './readiness.js';
import type { ExperienceRecord } from './types.js';
import { EXPERIENCE_LIMITS } from './types.js';

const TABLE = 'experiences';

function metaPath(agentId: string) {
  return path.join(experienceDirForAgent(agentId), 'experiences.json');
}

function normalize(row: Partial<ExperienceRecord> & Record<string, unknown>, agentId: string): ExperienceRecord | null {
  const id = String(row.id || '').trim();
  if (!id) return null;
  const title = String(row.title || '').trim() || 'Experience';
  const situation = String(row.situation || '').trim();
  const action = String(row.action || '').trim();
  if (!situation || !action) return null;
  return {
    id,
    agentId,
    title,
    situation,
    action,
    pitfall: String(row.pitfall || '').trim(),
    whenNot: String(row.whenNot || '').trim(),
    tags: Array.isArray(row.tags) ? row.tags.map((item) => String(item).trim()).filter(Boolean) : [],
    embedText: String(row.embedText || '').trim(),
    vector: Array.isArray(row.vector) ? row.vector.map(Number) : [],
    quality: Number(row.quality) || 0.5,
    hitCount: Math.max(0, Math.round(Number(row.hitCount) || 0)),
    createdAt: Number(row.createdAt) || Date.now(),
    updatedAt: Number(row.updatedAt) || Date.now(),
  };
}

/** Legacy agent-scoped JSON reader; current tool source of truth is local-store.ts SQLite. */
export function listExperiences(agentId: string): ExperienceRecord[] {
  const raw = readJsonFile<unknown[]>(metaPath(agentId), []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalize(item as Partial<ExperienceRecord>, agentId))
    .filter((item): item is ExperienceRecord => Boolean(item))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, EXPERIENCE_LIMITS.maxPerAgent);
}

export function getExperience(agentId: string, id: string): ExperienceRecord | null {
  return listExperiences(agentId).find((item) => item.id === id) || null;
}

export function upsertExperienceMeta(agentId: string, record: ExperienceRecord) {
  const rows = listExperiences(agentId);
  const next = [record, ...rows.filter((item) => item.id !== record.id)].slice(0, EXPERIENCE_LIMITS.maxPerAgent);
  writeJsonFile(metaPath(agentId), next);
  return record;
}

export function bumpExperienceHit(agentId: string, id: string) {
  const rows = listExperiences(agentId);
  const index = rows.findIndex((item) => item.id === id);
  if (index < 0) return;
  rows[index] = {
    ...rows[index],
    hitCount: rows[index].hitCount + 1,
    updatedAt: Date.now(),
  };
  writeJsonFile(metaPath(agentId), rows);
}

async function tryLanceUpsert(agentId: string, record: ExperienceRecord) {
  try {
    const dataDir = experienceDirForAgent(agentId);
    ensureDir(dataDir);
    const lancedb = await import('@lancedb/lancedb');
    const db = await lancedb.connect(dataDir);
    const names = await db.tableNames();
    const payload = [{
      id: record.id,
      agentId: record.agentId,
      title: record.title,
      situation: record.situation,
      action: record.action,
      pitfall: record.pitfall,
      whenNot: record.whenNot,
      tags: record.tags.join(','),
      embedText: record.embedText,
      vector: record.vector,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }];
    if (names.includes(TABLE)) {
      const table = await db.openTable(TABLE);
      try {
        await table.delete(`id = '${record.id.replace(/'/g, "''")}'`);
      } catch {
        // ignore delete failures; add still upserts a new row
      }
      await table.add(payload);
    } else {
      await db.createTable(TABLE, payload);
    }
    return true;
  } catch {
    return false;
  }
}

async function tryLanceSearch(agentId: string, vector: number[], topK: number) {
  try {
    const dataDir = experienceDirForAgent(agentId);
    const lancedb = await import('@lancedb/lancedb');
    const db = await lancedb.connect(dataDir);
    const names = await db.tableNames();
    if (!names.includes(TABLE)) return null;
    const table = await db.openTable(TABLE);
    const result = await table.vectorSearch(vector).limit(Math.max(topK, 8)).toArray();
    return result.map((row: Record<string, unknown>, index: number) => ({
      id: String(row.id || `hit-${index}`),
      score: typeof row._distance === 'number' ? 1 / (1 + Number(row._distance)) : 0,
    }));
  } catch {
    return null;
  }
}

export async function saveExperienceRecord(record: ExperienceRecord) {
  upsertExperienceMeta(record.agentId, record);
  const lanceOk = await tryLanceUpsert(record.agentId, record);
  invalidateExperienceRecallReadiness(record.agentId);
  return { ok: true as const, id: record.id, backend: lanceOk ? 'lancedb+json' : 'json' };
}

export async function searchExperienceVectors(input: {
  agentId: string;
  vector: number[];
  topK?: number;
}) {
  const topK = Math.min(8, Math.max(1, input.topK || 3));
  const lanceHits = await tryLanceSearch(input.agentId, input.vector, topK);
  if (lanceHits) return lanceHits;

  // File fallback: score stored vectors with cosine.
  return listExperiences(input.agentId)
    .filter((item) => item.vector.length)
    .map((item) => ({ id: item.id, score: cosine(input.vector, item.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function findNearDuplicate(agentId: string, vector: number[], threshold = EXPERIENCE_LIMITS.dedupeScore) {
  let best: { record: ExperienceRecord; score: number } | null = null;
  for (const record of listExperiences(agentId)) {
    if (!record.vector.length) continue;
    const score = cosine(vector, record.vector);
    if (score < threshold) continue;
    if (!best || score > best.score) best = { record, score };
  }
  return best;
}
