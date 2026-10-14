import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { completeSimple } from '@mariozechner/pi-ai';
import { z } from 'zod';
import type { KnowledgeBaseRuntime, ModelCapabilityRuntime, ModelConfig, OntologyNode } from '@workmate/contracts';
import { Type } from '@sinclair/typebox';
import { defineAgentTool, type AgentTool } from './pi-tools.js';
import {
  bailianOpenApiCreateIndex,
  bailianOpenApiDeleteChunks,
  bailianOpenApiDeleteDocuments,
  bailianOpenApiDeleteIndex,
  bailianOpenApiGetJobStatus,
  bailianOpenApiListChunks,
  bailianOpenApiListDocuments,
  bailianOpenApiListIndices,
  bailianOpenApiRetrieve,
  bailianOpenApiUpdateIndex,
  bailianOpenApiUploadDocument,
} from './bailian-openapi.js';
import { buildEmbeddingSignature, embedOpenAiCompatible } from './embedding-http.js';
import { graphDocumentHints, planOntologyQuery, readOntologyGraph, type OntologyQueryPlan } from './ontology-runtime.js';
import {readDocument} from './document-service.js';
import { createChatCompletionsPayloadPatch, toPiModel } from './pi-model.js';

export type KnowledgeHit = {
  id: string;
  title: string;
  content: string;
  score: number;
  source?: string;
  url?: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  provider: string;
  retrievalRoutes?: Array<'raw-vector' | 'ontology-vector' | 'ontology-evidence'>;
};

type EmbedConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxBatch?: number;
  maxInputChars?: number;
};

type LocalChunk = {
  id: string;
  documentId: string;
  documentTitle: string;
  title: string;
  content: string;
  source?: string;
  vector: number[];
  createdAt: number;
};

export type KnowledgeDocumentSummary = {
  id: string;
  title: string;
  source?: string;
  chunkCount: number;
  createdAt: number;
  preview: string;
};

export type KnowledgeChunkSummary = {
  id: string;
  documentId: string;
  documentTitle: string;
  title: string;
  content: string;
  source?: string;
  createdAt: number;
};

const timeout = <T>(promise: Promise<T>, ms = 20_000) =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Knowledge request timed out.')), ms))]);

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function knowledgeRoot() {
  return process.env.WORKMATE_KNOWLEDGE_DIR?.trim() || path.resolve(process.cwd(), '.workmate-knowledge');
}

export function resolveKnowledgeDataDir(kb: KnowledgeBaseRuntime) {
  if (kb.dataDir?.trim()) return path.resolve(kb.dataDir.trim());
  return path.join(knowledgeRoot(), kb.id);
}

function resolveEmbedConfig(kb: KnowledgeBaseRuntime, model?: ModelConfig): EmbedConfig | null {
  const embeddingModel = (kb.embeddingModel || model?.embeddingModel || '').trim();
  const baseUrl = (kb.embeddingBaseUrl || model?.embeddingBaseUrl || model?.baseUrl || '').replace(/\/$/, '');
  const apiKey = kb.embeddingApiKey || model?.embeddingApiKey || model?.apiKey || '';
  if (!baseUrl || !embeddingModel) return null;
  if (!apiKey.trim() && !/ollama/i.test(baseUrl) && model?.provider !== 'ollama' && model?.provider !== 'openai-compatible') return null;
  return {
    baseUrl,
    apiKey: apiKey.trim(),
    model: embeddingModel,
    maxBatch: Math.max(1, Number(kb.embeddingMeta?.maxBatch) || 32),
    maxInputChars: Math.max(1, Number(kb.embeddingMeta?.maxInputChars) || 8_000),
  };
}

async function embedTexts(config: EmbedConfig, inputs: string[]): Promise<number[][]> {
  const result = await embedOpenAiCompatible(config, inputs);
  return result.vectors;
}

function cosine(a: number[], b: number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function chunkText(content: string, title: string) {
  const cleaned = content.replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [] as Array<{ title: string; content: string }>;
  const max = 1200;
  const parts: Array<{ title: string; content: string }> = [];
  if (cleaned.length <= max) {
    parts.push({ title, content: cleaned });
    return parts;
  }
  let offset = 0;
  let index = 1;
  while (offset < cleaned.length) {
    const slice = cleaned.slice(offset, offset + max);
    parts.push({ title: `${title}#${index}`, content: slice });
    offset += max - 120;
    index += 1;
  }
  return parts;
}

function fileStorePath(dataDir: string) {
  return path.join(dataDir, 'chunks.json');
}

function readFileStore(dataDir: string): LocalChunk[] {
  const file = fileStorePath(dataDir);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as LocalChunk[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeFileStore(dataDir: string, rows: LocalChunk[]) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(fileStorePath(dataDir), JSON.stringify(rows), 'utf8');
}

function normalizeLocalChunk(row: Partial<LocalChunk> & Record<string, unknown>): LocalChunk {
  const id = text(row.id) || crypto.randomUUID();
  const title = text(row.title) || 'Untitled';
  const source = text(row.source) || undefined;
  const baseTitle = title.replace(/#\d+$/, '') || 'Untitled';
  const documentId = text(row.documentId) || `legacy:${source || ''}:${baseTitle}`;
  const documentTitle = text(row.documentTitle) || baseTitle;
  const vector = Array.isArray(row.vector) ? row.vector.map(Number) : [];
  return {
    id,
    documentId,
    documentTitle,
    title,
    content: text(row.content),
    source,
    vector,
    createdAt: Number(row.createdAt) || Date.now(),
  };
}

function escapeSqlLiteral(value: string) {
  return value.replace(/'/g, "''");
}

async function tryLanceListAll(dataDir: string): Promise<LocalChunk[] | null> {
  try {
    const lancedb = await import('@lancedb/lancedb');
    const db = await lancedb.connect(dataDir);
    const names = await db.tableNames();
    if (!names.includes('chunks')) return [];
    const table = await db.openTable('chunks');
    const result = await table.query().limit(20_000).toArray();
    return result.map((row: any) => normalizeLocalChunk(row));
  } catch {
    return null;
  }
}

async function tryLanceDeleteByIds(dataDir: string, ids: string[]) {
  if (!ids.length) return true;
  try {
    const lancedb = await import('@lancedb/lancedb');
    const db = await lancedb.connect(dataDir);
    const names = await db.tableNames();
    if (!names.includes('chunks')) return true;
    const table = await db.openTable('chunks');
    for (const id of ids) {
      await table.delete(`id = '${escapeSqlLiteral(id)}'`);
    }
    return true;
  } catch {
    return false;
  }
}

async function loadAllLocalChunks(dataDir: string): Promise<{ rows: LocalChunk[]; backend: 'lancedb' | 'file-fallback' }> {
  const lanceRows = await tryLanceListAll(dataDir);
  if (lanceRows?.length || (lanceRows && !existsSync(fileStorePath(dataDir)))) return { rows: lanceRows, backend: 'lancedb' };
  return { rows: readFileStore(dataDir).map((row) => normalizeLocalChunk(row)), backend: 'file-fallback' };
}

async function persistLocalChunks(dataDir: string, rows: LocalChunk[], preferLance: boolean) {
  if (preferLance) {
    try {
      const lancedb = await import('@lancedb/lancedb');
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const db = await lancedb.connect(dataDir);
      const names = await db.tableNames();
      if (names.includes('chunks')) {
        const table = await db.openTable('chunks');
        await table.delete('true');
        if (rows.length) {
          await table.add(rows.map((row) => ({
            id: row.id,
            documentId: row.documentId,
            documentTitle: row.documentTitle,
            title: row.title,
            content: row.content,
            source: row.source || '',
            vector: row.vector,
            createdAt: row.createdAt,
          })));
        }
        return 'lancedb' as const;
      }
      if (rows.length) {
        await db.createTable('chunks', rows.map((row) => ({
          id: row.id,
          documentId: row.documentId,
          documentTitle: row.documentTitle,
          title: row.title,
          content: row.content,
          source: row.source || '',
          vector: row.vector,
          createdAt: row.createdAt,
        })));
      }
      return 'lancedb' as const;
    } catch {
      /* fall through */
    }
  }
  writeFileStore(dataDir, rows);
  return 'file-fallback' as const;
}

function groupDocuments(rows: LocalChunk[]): KnowledgeDocumentSummary[] {
  const map = new Map<string, KnowledgeDocumentSummary>();
  for (const row of rows) {
    const existing = map.get(row.documentId);
    if (!existing) {
      map.set(row.documentId, {
        id: row.documentId,
        title: row.documentTitle || row.title,
        source: row.source,
        chunkCount: 1,
        createdAt: row.createdAt,
        preview: row.content.slice(0, 160),
      });
    } else {
      existing.chunkCount += 1;
      existing.createdAt = Math.min(existing.createdAt, row.createdAt);
      if (!existing.source && row.source) existing.source = row.source;
    }
  }
  return [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
}

async function tryLanceUpsert(dataDir: string, rows: LocalChunk[]) {
  try {
    const lancedb = await import('@lancedb/lancedb');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const db = await lancedb.connect(dataDir);
    const names = await db.tableNames();
    const payload = rows.map((row) => ({
      id: row.id,
      documentId: row.documentId,
      documentTitle: row.documentTitle,
      title: row.title,
      content: row.content,
      source: row.source || '',
      vector: row.vector,
      createdAt: row.createdAt,
    }));
    if (names.includes('chunks')) {
      const table = await db.openTable('chunks');
      await table.add(payload);
    } else {
      await db.createTable('chunks', payload);
    }
    return true;
  } catch {
    return false;
  }
}

async function tryLanceSearch(dataDir: string, vector: number[], topK: number) {
  try {
    const lancedb = await import('@lancedb/lancedb');
    const db = await lancedb.connect(dataDir);
    const names = await db.tableNames();
    if (!names.includes('chunks')) return null;
    const table = await db.openTable('chunks');
    const result = await table.vectorSearch(vector).limit(topK).toArray();
    return result.map((row: any, index: number) => ({
      id: text(row.id) || `hit-${index}`,
      title: text(row.title) || 'Untitled',
      content: text(row.content),
      score: typeof row._distance === 'number' ? 1 / (1 + row._distance) : 0,
      source: text(row.source) || undefined,
    }));
  } catch {
    return null;
  }
}

export async function ingestLocalKnowledge(input: {
  kb: KnowledgeBaseRuntime;
  title: string;
  content: string;
  source?: string;
  model?: ModelConfig;
}) {
  if (input.kb.provider !== 'lancedb') throw new Error('Only local LanceDB knowledge bases support text-embed ingest.');
  const embed = resolveEmbedConfig(input.kb, input.model);
  if (!embed) throw new Error('Configure an embedding model (Settings → Models) before indexing local knowledge.');
  const dataDir = resolveKnowledgeDataDir(input.kb);
  const documentTitle = (input.title || 'document').trim() || 'document';
  const documentId = crypto.randomUUID();
  const pieces = chunkText(input.content, documentTitle);
  if (!pieces.length) throw new Error('Document content is empty.');
  const vectors = await embedTexts(embed, pieces.map((item) => item.content));
  const createdAt = Date.now();
  const rows: LocalChunk[] = pieces.map((piece, index) => ({
    id: crypto.randomUUID(),
    documentId,
    documentTitle,
    title: piece.title,
    content: piece.content,
    source: input.source,
    vector: vectors[index],
    createdAt,
  }));
  const usedLance = await tryLanceUpsert(dataDir, rows);
  if (!usedLance) {
    const existing = readFileStore(dataDir).map((row) => normalizeLocalChunk(row));
    writeFileStore(dataDir, [...rows, ...existing].slice(0, 20_000));
  }
  return {
    ok: true as const,
    documentId,
    chunks: rows.length,
    backend: usedLance ? 'lancedb' : 'file-fallback',
    dataDir,
    status: 'ready' as const,
    indexState: {
      status: 'ready' as const,
      signature: buildEmbeddingSignature({
        model: embed.model,
        dimension: rows[0]?.vector.length || input.kb.embeddingMeta?.dimension,
        normalize: input.kb.embeddingMeta?.normalize,
      }),
      lastBuildAt: createdAt,
      lastBuildModel: embed.model,
    },
  };
}

function requireBailianAuth(kb: KnowledgeBaseRuntime) {
  const accessKeyId = String(kb.accessKeyId || '').trim();
  const accessKeySecret = String(kb.accessKeySecret || '').trim();
  const workspaceId = String(kb.workspaceId || '').trim();
  const indexId = String(kb.externalId || '').trim();
  if (!accessKeyId || !accessKeySecret) {
    throw new Error('Bailian management requires AccessKey Id/Secret in Settings → Knowledge.');
  }
  if (!workspaceId) throw new Error('Bailian workspaceId is required in Settings → Knowledge.');
  if (!indexId) throw new Error('Bailian knowledge base Index ID (externalId) is required.');
  return { accessKeyId, accessKeySecret, workspaceId, indexId };
}

export async function ingestKnowledge(input: {
  kb: KnowledgeBaseRuntime;
  title: string;
  content?: string;
  fileBase64?: string;
  fileName?: string;
  source?: string;
  model?: ModelConfig;
}) {
  if (input.kb.provider === 'lancedb') {
    let content = String(input.content || '').trim();
    if (!content && input.fileBase64?.trim()) {
      const fileName = String(input.fileName || '').trim();
      if (!fileName) throw new Error('Local document ingest requires a file name.');
      const parsed = await readDocument({
        fileName,
        bytes: Buffer.from(input.fileBase64.trim(), 'base64'),
        allowEnhanced:true,
      });
      if(!parsed.ok)throw new Error(parsed.message);
      if(parsed.info.truncated)throw new Error('文档超出单次读取范围，正文存在截断；请拆分后重新导入，避免知识库只保存部分内容。');
      content = parsed.text;
    }
    if (!content) throw new Error('Local knowledge ingest requires text content or a supported PDF/DOCX file.');
    return ingestLocalKnowledge({
      kb: input.kb,
      title: input.title,
      content,
      source: input.source,
      model: input.model,
    });
  }
  if (input.kb.provider === 'bailian') {
    const auth = requireBailianAuth(input.kb);
    const categoryId = String(input.kb.categoryId || '').trim();
    if (!categoryId) {
      throw new Error('Bailian upload requires categoryId. Recreate the knowledge base from Workmate or set categoryId on the base.');
    }
    let bytes: Buffer;
    let fileName = String(input.fileName || '').trim();
    if (input.fileBase64?.trim()) {
      bytes = Buffer.from(input.fileBase64.trim(), 'base64');
      if (!fileName) fileName = `${input.title.trim() || 'document'}.bin`;
    } else {
      const content = String(input.content || '');
      if (!content.trim()) throw new Error('Bailian ingest requires fileBase64 or text content.');
      bytes = Buffer.from(content, 'utf8');
      if (!fileName) fileName = `${input.title.trim() || 'document'}.txt`;
    }
    const uploaded = await bailianOpenApiUploadDocument({
      ...auth,
      categoryId,
      fileName,
      bytes,
    });
    return {
      ok: true as const,
      documentId: uploaded.documentId,
      chunks: 0,
      backend: 'bailian',
      jobId: uploaded.jobId,
      status: uploaded.status,
    };
  }
  throw new Error(`Provider “${input.kb.provider}” does not support document ingest yet.`);
}

export async function listKnowledgeDocuments(kb: KnowledgeBaseRuntime) {
  if (kb.provider === 'lancedb') return listLocalKnowledgeDocuments(kb);
  if (kb.provider === 'bailian') {
    const auth = requireBailianAuth(kb);
    const result = await bailianOpenApiListDocuments({ ...auth, pageNumber: 1, pageSize: 50 });
    return {
      ok: true as const,
      backend: 'bailian',
      dataDir: '',
      documentCount: result.total,
      chunkCount: result.documents.reduce((sum: number, item: { chunkCount?: number }) => sum + (item.chunkCount || 0), 0),
      documents: result.documents,
    };
  }
  throw new Error(`Document listing is not available for provider “${kb.provider}”.`);
}

export async function listLocalKnowledgeDocuments(kb: KnowledgeBaseRuntime) {
  if (kb.provider !== 'lancedb') throw new Error('Document listing is only available for local LanceDB knowledge bases.');
  const dataDir = resolveKnowledgeDataDir(kb);
  const { rows, backend } = await loadAllLocalChunks(dataDir);
  const documents = groupDocuments(rows);
  return {
    ok: true as const,
    backend,
    dataDir,
    documentCount: documents.length,
    chunkCount: rows.length,
    documents,
  };
}

export async function listKnowledgeChunks(input: {
  kb: KnowledgeBaseRuntime;
  documentId?: string;
  query?: string;
  offset?: number;
  limit?: number;
}) {
  if (input.kb.provider === 'lancedb') return listLocalKnowledgeChunks(input);
  if (input.kb.provider === 'bailian') {
    const auth = requireBailianAuth(input.kb);
    const limit = Math.min(100, Math.max(1, Math.round(Number(input.limit) || 40)));
    const offset = Math.max(0, Math.round(Number(input.offset) || 0));
    const pageNum = Math.floor(offset / limit) + 1;
    const result = await bailianOpenApiListChunks({
      ...auth,
      fileId: input.documentId,
      pageNum,
      pageSize: limit,
    });
    let chunks = result.chunks;
    const q = text(input.query).trim().toLowerCase();
    if (q) {
      chunks = chunks.filter((row: KnowledgeChunkSummary) =>
        row.title.toLowerCase().includes(q)
        || row.documentTitle.toLowerCase().includes(q)
        || row.content.toLowerCase().includes(q));
    }
    return {
      ok: true as const,
      backend: 'bailian',
      total: q ? chunks.length : result.total,
      offset,
      limit,
      chunks,
    };
  }
  throw new Error(`Chunk listing is not available for provider “${input.kb.provider}”.`);
}

export async function listLocalKnowledgeChunks(input: {
  kb: KnowledgeBaseRuntime;
  documentId?: string;
  query?: string;
  offset?: number;
  limit?: number;
}) {
  if (input.kb.provider !== 'lancedb') throw new Error('Chunk listing is only available for local LanceDB knowledge bases.');
  const dataDir = resolveKnowledgeDataDir(input.kb);
  const { rows, backend } = await loadAllLocalChunks(dataDir);
  const q = text(input.query).trim().toLowerCase();
  let filtered = rows;
  if (input.documentId) filtered = filtered.filter((row) => row.documentId === input.documentId);
  if (q) {
    filtered = filtered.filter((row) =>
      row.title.toLowerCase().includes(q)
      || row.documentTitle.toLowerCase().includes(q)
      || row.content.toLowerCase().includes(q)
      || (row.source || '').toLowerCase().includes(q));
  }
  filtered = [...filtered].sort((a, b) => b.createdAt - a.createdAt);
  const offset = Math.max(0, Math.round(Number(input.offset) || 0));
  const limit = Math.min(100, Math.max(1, Math.round(Number(input.limit) || 40)));
  const page = filtered.slice(offset, offset + limit).map((row): KnowledgeChunkSummary => ({
    id: row.id,
    documentId: row.documentId,
    documentTitle: row.documentTitle,
    title: row.title,
    content: row.content,
    source: row.source,
    createdAt: row.createdAt,
  }));
  return {
    ok: true as const,
    backend,
    total: filtered.length,
    offset,
    limit,
    chunks: page,
  };
}

export async function deleteKnowledgeDocument(kb: KnowledgeBaseRuntime, documentId: string) {
  if (kb.provider === 'lancedb') return deleteLocalKnowledgeDocument(kb, documentId);
  if (kb.provider === 'bailian') {
    const auth = requireBailianAuth(kb);
    const id = text(documentId).trim();
    if (!id) throw new Error('documentId is required.');
    await bailianOpenApiDeleteDocuments({ ...auth, documentIds: [id] });
    return { ok: true as const, removedChunks: 0, remainingChunks: 0, documentCount: 0 };
  }
  throw new Error(`Document deletion is not available for provider “${kb.provider}”.`);
}

export async function deleteLocalKnowledgeDocument(kb: KnowledgeBaseRuntime, documentId: string) {
  if (kb.provider !== 'lancedb') throw new Error('Document deletion is only available for local LanceDB knowledge bases.');
  const id = text(documentId).trim();
  if (!id) throw new Error('documentId is required.');
  const dataDir = resolveKnowledgeDataDir(kb);
  const { rows, backend } = await loadAllLocalChunks(dataDir);
  const keep = rows.filter((row) => row.documentId !== id);
  const removed = rows.length - keep.length;
  if (!removed) throw new Error('Document not found.');
  if (backend === 'lancedb') {
    const ids = rows.filter((row) => row.documentId === id).map((row) => row.id);
    const ok = await tryLanceDeleteByIds(dataDir, ids);
    if (!ok) await persistLocalChunks(dataDir, keep, false);
  } else {
    writeFileStore(dataDir, keep);
  }
  return { ok: true as const, removedChunks: removed, remainingChunks: keep.length, documentCount: groupDocuments(keep).length };
}

export async function deleteKnowledgeChunk(kb: KnowledgeBaseRuntime, chunkId: string) {
  if (kb.provider === 'lancedb') return deleteLocalKnowledgeChunk(kb, chunkId);
  if (kb.provider === 'bailian') {
    const auth = requireBailianAuth(kb);
    const id = text(chunkId).trim();
    if (!id) throw new Error('chunkId is required.');
    await bailianOpenApiDeleteChunks({ ...auth, chunkIds: [id] });
    return { ok: true as const, remainingChunks: 0, documentCount: 0 };
  }
  throw new Error(`Chunk deletion is not available for provider “${kb.provider}”.`);
}

export async function deleteLocalKnowledgeChunk(kb: KnowledgeBaseRuntime, chunkId: string) {
  if (kb.provider !== 'lancedb') throw new Error('Chunk deletion is only available for local LanceDB knowledge bases.');
  const id = text(chunkId).trim();
  if (!id) throw new Error('chunkId is required.');
  const dataDir = resolveKnowledgeDataDir(kb);
  const { rows, backend } = await loadAllLocalChunks(dataDir);
  const keep = rows.filter((row) => row.id !== id);
  if (keep.length === rows.length) throw new Error('Chunk not found.');
  if (backend === 'lancedb') {
    const ok = await tryLanceDeleteByIds(dataDir, [id]);
    if (!ok) await persistLocalChunks(dataDir, keep, false);
  } else {
    writeFileStore(dataDir, keep);
  }
  return { ok: true as const, remainingChunks: keep.length, documentCount: groupDocuments(keep).length };
}

export async function getKnowledgeJobStatus(kb: KnowledgeBaseRuntime, jobId: string) {
  if (kb.provider !== 'bailian') throw new Error('Job status is only available for Bailian knowledge bases.');
  const auth = requireBailianAuth(kb);
  const result = await bailianOpenApiGetJobStatus({ ...auth, jobId });
  return {
    jobId: String(jobId).trim(),
    status: result.status,
    message: undefined as string | undefined,
    documentStatuses: Array.isArray(result.documents)
      ? result.documents.map((item: any) => ({
        id: String(item.DocId || item.DocumentId || item.id || ''),
        status: String(item.Status || item.status || ''),
        message: String(item.Message || item.message || ''),
      }))
      : [],
  };
}

async function searchLocal(kb: KnowledgeBaseRuntime, query: string, topK: number, model?: ModelConfig): Promise<KnowledgeHit[]> {
  const embed = resolveEmbedConfig(kb, model);
  if (!embed) throw new Error('Local knowledge search requires an embedding model.');
  const [vector] = await embedTexts(embed, [query]);
  const dataDir = resolveKnowledgeDataDir(kb);
  const lanceHits = await tryLanceSearch(dataDir, vector, topK);
  const rows = lanceHits ?? readFileStore(dataDir)
    .map((row) => ({ ...row, score: cosine(vector, row.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((row) => ({ id: row.id, title: row.title, content: row.content, score: row.score, source: row.source }));
  return rows.map((row) => ({
    ...row,
    knowledgeBaseId: kb.id,
    knowledgeBaseName: kb.name,
    provider: kb.provider,
  }));
}

async function readJsonOrThrow(response: Response, label: string) {
  const raw = await response.text();
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${label} returned empty body (HTTP ${response.status}).`);
  }
  if (trimmed.startsWith('<!') || trimmed.startsWith('<html') || trimmed.startsWith('<HTML')) {
    throw new Error(
      `${label} returned an HTML page instead of JSON (HTTP ${response.status}). `
      + 'Check the Bailian endpoint and knowledge-base ID (use the console Index ID such as 5190nw0e0y, not a custom name).',
    );
  }
  let data: any;
  try {
    data = JSON.parse(trimmed);
  } catch {
    throw new Error(`${label} returned invalid JSON (HTTP ${response.status}): ${trimmed.slice(0, 160)}`);
  }
  if (!response.ok) {
    const code = data?.code || data?.Code || '';
    if (code === 'BailianIndexServiceNotOpen') {
      throw new Error(
        '百炼知识库检索服务未开通（BailianIndexServiceNotOpen）。'
        + '请到百炼控制台开通/激活「知识库」检索能力后重试；上传与分片列表可正常使用。',
      );
    }
    const message = data?.message || data?.Message || code || `HTTP ${response.status}`;
    throw new Error(`${label} failed: ${message}`);
  }
  if (data?.success === false || data?.Success === false) {
    const message = data?.message || data?.Message || data?.code || data?.Code || 'request failed';
    throw new Error(`${label} failed: ${message}`);
  }
  if (typeof data?.code === 'string' && data.code && data.code !== 'Success' && data.status_code && Number(data.status_code) >= 400) {
    throw new Error(`${label} failed: ${data.message || data.code}`);
  }
  return data;
}

function bailianDashscopeRoot(kb: KnowledgeBaseRuntime) {
  const raw = (kb.baseUrl || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/$/, '');
  if (raw.includes('/indices/')) {
    return raw.replace(/\/indices\/.*$/, '');
  }
  if (raw.endsWith('/api/v1')) return raw;
  if (raw.includes('dashscope.aliyuncs.com') && !raw.includes('/api/')) {
    return `${raw}/api/v1`;
  }
  return raw.includes('aliyuncs.com') ? raw : 'https://dashscope.aliyuncs.com/api/v1';
}

function parseBailianIds(kb: KnowledgeBaseRuntime) {
  const workspaceId = String(kb.workspaceId || '').trim();
  let indexId = String(kb.externalId || '').trim();
  // Allow "workspaceId/indexId" in externalId for compact configs.
  if (indexId.includes('/') && !workspaceId) {
    const [ws, id] = indexId.split('/');
    return { workspaceId: ws.trim(), indexId: id.trim() };
  }
  return { workspaceId, indexId };
}

export async function listBailianPipelines(kb: Pick<KnowledgeBaseRuntime, 'apiKey' | 'baseUrl' | 'workspaceId'>) {
  const apiKey = String(kb.apiKey || '').trim();
  if (!apiKey) throw new Error('Bailian API key is required.');
  const root = bailianDashscopeRoot(kb as KnowledgeBaseRuntime);
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  };
  const workspaceId = String(kb.workspaceId || '').trim();
  if (workspaceId) headers['X-DashScope-WorkSpace'] = workspaceId;
  const response = await timeout(fetch(`${root}/indices/pipeline/list?page_number=1&page_size=50`, {
    method: 'GET',
    headers,
  }));
  const data = await readJsonOrThrow(response, 'Bailian pipeline list');
  const rows = Array.isArray(data?.pipeline_list) ? data.pipeline_list : [];
  return rows.map((item: any) => ({
    id: String(item.id || ''),
    name: String(item.name || item.id || ''),
    workspaceId: String(item.workspace_id || workspaceId || ''),
    docNum: Number(item.doc_num) || 0,
  })).filter((item: { id: string }) => item.id);
}

export async function createBailianKnowledgeBase(input: {
  accessKeyId: string;
  accessKeySecret: string;
  workspaceId: string;
  name: string;
  description?: string;
  embeddingModelName?: string;
}) {
  return bailianOpenApiCreateIndex(input);
}

export async function updateBailianKnowledgeBase(input: {
  accessKeyId: string;
  accessKeySecret: string;
  workspaceId: string;
  indexId: string;
  name?: string;
  description?: string;
}) {
  return bailianOpenApiUpdateIndex(input);
}

export async function deleteBailianKnowledgeBase(input: {
  accessKeyId: string;
  accessKeySecret: string;
  workspaceId: string;
  indexId: string;
}) {
  return bailianOpenApiDeleteIndex(input);
}

export async function listBailianKnowledgeBases(input: {
  accessKeyId: string;
  accessKeySecret: string;
  workspaceId: string;
  pageNumber?: number;
  pageSize?: number;
  indexName?: string;
}) {
  return bailianOpenApiListIndices(input);
}

/** Provider-level knowledge-base update (cloud index metadata). */
export async function updateKnowledgeBaseMeta(kb: KnowledgeBaseRuntime, patch: { name?: string; description?: string }) {
  if (kb.provider === 'bailian') {
    const auth = requireBailianAuth(kb);
    await bailianOpenApiUpdateIndex({ ...auth, name: patch.name, description: patch.description });
    return { ok: true as const };
  }
  if (kb.provider === 'lancedb') {
    return { ok: true as const };
  }
  throw new Error(`Knowledge-base update is not available for provider “${kb.provider}”.`);
}

/** Provider-level knowledge-base delete (cloud index). Local LanceDB only clears local store metadata via UI. */
export async function deleteKnowledgeBaseRemote(kb: KnowledgeBaseRuntime) {
  if (kb.provider === 'bailian') {
    const auth = requireBailianAuth(kb);
    await bailianOpenApiDeleteIndex(auth);
    return { ok: true as const };
  }
  throw new Error(`Remote knowledge-base deletion is not available for provider “${kb.provider}”.`);
}

async function resolveBailianPipelineId(kb: KnowledgeBaseRuntime, indexId: string) {
  // Already looks like a Bailian index id (short alphanumeric).
  if (/^[a-z0-9]{8,24}$/i.test(indexId) && !indexId.includes('-')) return indexId;
  try {
    const rows = await listBailianPipelines(kb);
    const hit = rows.find((item: { id: string; name: string }) => item.id === indexId || item.name === indexId);
    if (hit) return hit.id;
  } catch {
    // Fall through with original id; retrieve will surface a clearer error.
  }
  return indexId;
}

function mapBailianNodes(kb: KnowledgeBaseRuntime, rows: any[], topK: number): KnowledgeHit[] {
  return rows.slice(0, topK).map((item: any, index: number) => {
    let metadata = item.metadata ?? item.Metadata ?? {};
    if (typeof metadata === 'string') {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        metadata = {};
      }
    }
    return {
      id: text(item.id ?? metadata?.doc_id ?? metadata?._id) || `bailian-${index}`,
      title: text(metadata?.title ?? metadata?.doc_name ?? item.title) || kb.name,
      content: text(item.text ?? item.Text ?? item.content ?? metadata?.text ?? metadata?.content),
      score: Number(item.score ?? item.Score ?? item.similarity ?? 0),
      source: text(metadata?.file_path ?? metadata?.path ?? metadata?.url) || undefined,
      url: text(metadata?.url) || undefined,
      knowledgeBaseId: kb.id,
      knowledgeBaseName: kb.name,
      provider: kb.provider,
    };
  }).filter((item: KnowledgeHit) => item.content);
}

async function searchBailian(kb: KnowledgeBaseRuntime, query: string, topK: number): Promise<KnowledgeHit[]> {
  const { workspaceId, indexId: rawIndexId } = parseBailianIds(kb);
  if (!rawIndexId) throw new Error('Bailian knowledge base Index ID is required.');

  const accessKeyId = String(kb.accessKeyId || '').trim();
  const accessKeySecret = String(kb.accessKeySecret || '').trim();
  if (accessKeyId && accessKeySecret) {
    if (!workspaceId) throw new Error('Bailian workspaceId is required when using AccessKey retrieve.');
    try {
      const { nodes } = await bailianOpenApiRetrieve({
        accessKeyId,
        accessKeySecret,
        workspaceId,
        indexId: rawIndexId,
        query,
        topK,
      });
      return mapBailianNodes(kb, nodes, topK);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Retrieve product may be unopened while upload/list-chunks still work.
      if (/BailianIndexServiceNotOpen|Knowledge Base service is not activated/i.test(message)) {
        const fallback = await searchBailianViaChunks(kb, query, topK);
        if (fallback.length) return fallback;
        throw new Error(
          'Bailian Retrieve is not activated for this account (BailianIndexServiceNotOpen). '
          + 'Open Bailian console → Knowledge Base and activate the retrieval service, then retry. '
          + 'Documents/chunks can still be listed; semantic retrieve requires activation.',
        );
      }
      throw error;
    }
  }

  const apiKey = String(kb.apiKey || '').trim();
  if (!apiKey) {
    throw new Error('Bailian requires a DashScope API Key, or Aliyun AccessKey Id/Secret for OpenAPI retrieve.');
  }

  const indexId = await resolveBailianPipelineId(kb, rawIndexId);
  const root = bailianDashscopeRoot(kb);
  const endpoint = `${root}/indices/pipeline/retrieve_prompt`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  };
  if (workspaceId) headers['X-DashScope-WorkSpace'] = workspaceId;

  const response = await timeout(fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query,
      pipeline_id_list: [indexId],
      dense_similarity_top_k: Math.min(100, Math.max(1, topK)),
      sparse_similarity_top_k: Math.min(100, Math.max(1, topK)),
      enable_reranking: true,
      rerank_top_n: Math.min(20, Math.max(1, topK)),
    }),
  }));
  try {
    const data = await readJsonOrThrow(response, 'Bailian retrieve');
    const rows = Array.isArray(data?.data?.[0]?.nodes) ? data.data[0].nodes
      : Array.isArray(data?.output?.nodes) ? data.output.nodes
        : Array.isArray(data?.nodes) ? data.nodes
          : Array.isArray(data?.Data?.Nodes) ? data.Data.Nodes
            : [];
    return mapBailianNodes(kb, rows, topK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/BailianIndexServiceNotOpen|Knowledge Base service is not activated/i.test(message) && accessKeyId && accessKeySecret) {
      const fallback = await searchBailianViaChunks(kb, query, topK);
      if (fallback.length) return fallback;
    }
    throw error;
  }
}

/** Keyword fallback when Bailian semantic Retrieve is not activated. */
async function searchBailianViaChunks(kb: KnowledgeBaseRuntime, query: string, topK: number): Promise<KnowledgeHit[]> {
  const auth = requireBailianAuth(kb);
  const listed = await bailianOpenApiListChunks({
    ...auth,
    pageNum: 1,
    pageSize: Math.min(100, Math.max(20, topK * 10)),
  });
  const terms = query
    .toLowerCase()
    .split(/[\s,，。；;、]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 1);
  const scored = listed.chunks.map((chunk: KnowledgeChunkSummary) => {
    const hay = `${chunk.title}\n${chunk.documentTitle}\n${chunk.content}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (!term) continue;
      if (hay.includes(term)) score += term.length >= 2 ? 2 : 1;
    }
    return { chunk, score };
  }).filter((item: { chunk: KnowledgeChunkSummary; score: number }) => item.score > 0)
    .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
    .slice(0, topK);

  return scored.map(({ chunk, score }: { chunk: KnowledgeChunkSummary; score: number }) => ({
    id: chunk.id,
    title: chunk.title || chunk.documentTitle || kb.name,
    content: chunk.content,
    score,
    source: chunk.source,
    knowledgeBaseId: kb.id,
    knowledgeBaseName: kb.name,
    provider: kb.provider,
  }));
}

async function searchDify(kb: KnowledgeBaseRuntime, query: string, topK: number): Promise<KnowledgeHit[]> {
  const base = (kb.baseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('Dify base URL is required.');
  const response = await timeout(fetch(`${base}/datasets/${encodeURIComponent(kb.externalId || '')}/retrieve`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${kb.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query,
      retrieval_model: {
        search_method: 'hybrid_search',
        reranking_enable: false,
        top_k: topK,
        score_threshold_enabled: false,
      },
    }),
  }));
  if (!response.ok) throw new Error(`Dify returned HTTP ${response.status}.`);
  const data = await response.json() as any;
  const rows = Array.isArray(data?.records) ? data.records : [];
  return rows.slice(0, topK).map((item: any, index: number) => {
    const segment = item.segment || item;
    return {
      id: text(segment.id) || `dify-${index}`,
      title: text(segment.document?.name ?? item.document?.name) || kb.name,
      content: text(segment.content ?? item.content),
      score: Number(item.score ?? segment.score ?? 0),
      source: text(segment.document?.name) || undefined,
      knowledgeBaseId: kb.id,
      knowledgeBaseName: kb.name,
      provider: kb.provider,
    };
  }).filter((item: KnowledgeHit) => item.content);
}

async function searchQdrant(kb: KnowledgeBaseRuntime, query: string, topK: number, model?: ModelConfig): Promise<KnowledgeHit[]> {
  const embed = resolveEmbedConfig(kb, model);
  if (!embed) throw new Error('Qdrant search requires an embedding model.');
  const [vector] = await embedTexts(embed, [query]);
  const base = (kb.baseUrl || '').replace(/\/$/, '');
  const collection = kb.externalId || '';
  const response = await timeout(fetch(`${base}/collections/${encodeURIComponent(collection)}/points/query`, {
    method: 'POST',
    headers: {
      'api-key': kb.apiKey || '',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query: vector, limit: topK, with_payload: true }),
  }));
  if (!response.ok) throw new Error(`Qdrant returned HTTP ${response.status}.`);
  const data = await response.json() as any;
  const rows = Array.isArray(data?.result?.points) ? data.result.points
    : Array.isArray(data?.result) ? data.result
      : [];
  return rows.slice(0, topK).map((item: any, index: number) => {
    const payload = item.payload || {};
    return {
      id: text(item.id) || `qdrant-${index}`,
      title: text(payload.title ?? payload.name) || kb.name,
      content: text(payload.content ?? payload.text ?? payload.page_content),
      score: Number(item.score ?? 0),
      source: text(payload.source ?? payload.url) || undefined,
      url: text(payload.url) || undefined,
      knowledgeBaseId: kb.id,
      knowledgeBaseName: kb.name,
      provider: kb.provider,
    };
  }).filter((item: KnowledgeHit) => item.content);
}

async function searchPinecone(kb: KnowledgeBaseRuntime, query: string, topK: number, model?: ModelConfig): Promise<KnowledgeHit[]> {
  const embed = resolveEmbedConfig(kb, model);
  if (!embed) throw new Error('Pinecone search requires an embedding model.');
  const [vector] = await embedTexts(embed, [query]);
  const base = (kb.baseUrl || '').replace(/\/$/, '');
  const response = await timeout(fetch(`${base}/query`, {
    method: 'POST',
    headers: {
      'Api-Key': kb.apiKey || '',
      'content-type': 'application/json',
      'X-Pinecone-Api-Version': '2025-01',
    },
    body: JSON.stringify({
      namespace: kb.externalId || undefined,
      topK,
      vector,
      includeMetadata: true,
    }),
  }));
  if (!response.ok) throw new Error(`Pinecone returned HTTP ${response.status}.`);
  const data = await response.json() as any;
  const rows = Array.isArray(data?.matches) ? data.matches : [];
  return rows.slice(0, topK).map((item: any, index: number) => {
    const metadata = item.metadata || {};
    return {
      id: text(item.id) || `pinecone-${index}`,
      title: text(metadata.title ?? metadata.name) || kb.name,
      content: text(metadata.content ?? metadata.text ?? metadata.pageContent),
      score: Number(item.score ?? 0),
      source: text(metadata.source ?? metadata.url) || undefined,
      url: text(metadata.url) || undefined,
      knowledgeBaseId: kb.id,
      knowledgeBaseName: kb.name,
      provider: kb.provider,
    };
  }).filter((item: KnowledgeHit) => item.content);
}

export async function searchKnowledgeBase(kb: KnowledgeBaseRuntime, query: string, topK: number, model?: ModelConfig) {
  switch (kb.provider) {
    case 'lancedb':
      return searchLocal(kb, query, topK, model);
    case 'bailian':
      return searchBailian(kb, query, topK);
    case 'dify':
      return searchDify(kb, query, topK);
    case 'qdrant':
      return searchQdrant(kb, query, topK, model);
    case 'pinecone':
      return searchPinecone(kb, query, topK, model);
    default:
      return [];
  }
}

export type HybridKnowledgeSearchResult = {
  query: string;
  plan: OntologyQueryPlan;
  strategy: 'vector-only' | 'ontology-enhanced';
  results: KnowledgeHit[];
};

const SemanticOntologyMatchesSchema = z.object({
  matches: z.array(z.object({
    nodeId: z.string().min(1).max(240),
    confidence: z.number().min(0).max(1),
    reason: z.string().max(300).optional(),
  })).max(5).default([]),
});

function ontologyCandidateScore(node: OntologyNode, query: string) {
  const chars = new Set(query.toLocaleLowerCase().replace(/\s+/g, ''));
  const text = [node.name, ...node.aliases, node.type].join('').toLocaleLowerCase();
  let overlap = 0;
  for (const char of new Set(text)) if (chars.has(char)) overlap += 1;
  return overlap / Math.max(1, Math.min(chars.size, new Set(text).size));
}

function capabilityModel(config: ModelCapabilityRuntime): ModelConfig {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey || (config.provider === 'ollama' ? 'ollama' : ''),
    chatModel: config.modelId,
    providerLabel: config.providerLabel,
  };
}

/**
 * Semantic entity linking is a bounded fallback: it runs only after exact
 * name/alias rules miss, sees a capped candidate list, and may only select
 * supplied IDs. Invalid, low-confidence, slow, or unavailable model results
 * are treated as no match so retrieval remains fail-open.
 */
export async function resolveOntologyEntitiesWithModel(
  kb: KnowledgeBaseRuntime,
  query: string,
  config: ModelCapabilityRuntime,
): Promise<Array<{ nodeId: string; confidence: number; reason?: string }>> {
  const graph = await readOntologyGraph(kb);
  const candidates = graph.nodes
    .filter((node) => node.status !== 'archived')
    .sort((a, b) => ontologyCandidateScore(b, query) - ontologyCandidateScore(a, query))
    .slice(0, 60)
    .map((node) => ({ id: node.id, name: node.name, aliases: node.aliases.slice(0, 12), type: node.type }));
  if (!candidates.length) return [];
  const model = capabilityModel(config);
  const response = await completeSimple(toPiModel(model), {
    systemPrompt: [
      '你是企业本体实体链接器。判断用户问题是否与给定候选实体语义一致。',
      '只能选择候选列表中已有的 id，不得创建实体或关系。语义证据不足时返回空 matches。',
      '返回严格 JSON：{"matches":[{"nodeId":"候选id","confidence":0.0,"reason":"简短理由"}]}。最多 3 项，不要 Markdown。',
      '仅返回 confidence >= 0.72 的结果；同音、同字但业务含义不同不得匹配。',
    ].join('\n'),
    messages: [{ role: 'user', timestamp: Date.now(), content: [{ type: 'text', text: JSON.stringify({ question: query, candidates }) }] }],
  }, {
    apiKey: model.apiKey,
    signal: AbortSignal.timeout(8_000),
    maxTokens: 800,
    onPayload: createChatCompletionsPayloadPatch(model),
  });
  if (response.stopReason === 'error' || response.stopReason === 'aborted' || response.stopReason === 'length') return [];
  const text = response.content.filter((part): part is { type: 'text'; text: string } => part.type === 'text').map((part) => part.text).join('\n');
  const raw = (/```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] || text).trim();
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed: z.infer<typeof SemanticOntologyMatchesSchema>;
  try { parsed = SemanticOntologyMatchesSchema.parse(JSON.parse(raw.slice(start, end + 1))); } catch { return []; }
  const allowed = new Set(candidates.map((item) => item.id));
  return parsed.matches.filter((item) => allowed.has(item.nodeId) && item.confidence >= 0.72).slice(0, 3);
}

export async function recallOntologyEvidence(kb: KnowledgeBaseRuntime, plan: OntologyQueryPlan): Promise<KnowledgeHit[]> {
  const refs = plan.evidenceRefs.filter((ref) => ref.documentId).slice(0, 24);
  const documentIds = [...new Set(refs.map((ref) => ref.documentId!))].slice(0, 12);
  const settled = await Promise.allSettled(documentIds.map((documentId) => listKnowledgeChunks({ kb, documentId, offset: 0, limit: 100 })));
  const hits: KnowledgeHit[] = [];
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    if (result?.status !== 'fulfilled') continue;
    const documentId = documentIds[index]!;
    const documentRefs = refs.filter((ref) => ref.documentId === documentId);
    const exactChunkIds = new Set(documentRefs.map((ref) => ref.chunkId).filter((value): value is string => Boolean(value)));
    const selected = exactChunkIds.size
      ? result.value.chunks.filter((chunk: KnowledgeChunkSummary) => exactChunkIds.has(chunk.id))
      : result.value.chunks.slice(0, 2);
    for (const chunk of selected as KnowledgeChunkSummary[]) {
      hits.push({
        id: chunk.id,
        title: chunk.title || chunk.documentTitle,
        content: chunk.content,
        score: exactChunkIds.has(chunk.id) ? 0.96 : 0.82,
        source: chunk.source,
        knowledgeBaseId: kb.id,
        knowledgeBaseName: kb.name,
        provider: kb.provider,
      });
    }
  }
  return hits;
}

/**
 * Phase-1 hybrid retrieval. The original query always runs as a recall safety
 * net; ontology terms add a second route and graph document hints boost rather
 * than exclude candidates, so an incomplete graph cannot hide valid evidence.
 */
export async function searchKnowledgeWithOntology(kb: KnowledgeBaseRuntime, query: string, topK: number, model?: ModelConfig, semanticModel?: ModelCapabilityRuntime): Promise<HybridKnowledgeSearchResult> {
  let plan = await planOntologyQuery(kb, query, 2);
  if (!plan.matchedNodes.length && semanticModel) {
    try {
      const semanticMatches = await resolveOntologyEntitiesWithModel(kb, query, semanticModel);
      if (semanticMatches.length) plan = await planOntologyQuery(kb, query, 2, {}, semanticMatches);
    } catch {
      // The specialist model is optional. Network, timeout, and malformed
      // output failures intentionally preserve the deterministic/vector path.
    }
  }
  const enhancedQuery = [query, ...plan.expandedTerms, ...plan.relatedNodes.map((node) => node.name)].filter(Boolean).join(' ');
  const rawPromise = searchKnowledgeBase(kb, query, Math.min(8, Math.max(topK, topK * 2)), model);
  const enhancedPromise = enhancedQuery === query
    ? Promise.resolve([] as KnowledgeHit[])
    : searchKnowledgeBase(kb, enhancedQuery.slice(0, 800), Math.min(8, Math.max(topK, topK * 2)), model);
  const evidencePromise = plan.evidenceRefs.length ? recallOntologyEvidence(kb, plan) : Promise.resolve([] as KnowledgeHit[]);
  const [raw, enhanced, evidence] = await Promise.all([rawPromise, enhancedPromise, evidencePromise]);
  const hints = graphDocumentHints(plan).map((value) => value.toLocaleLowerCase());
  const merged = new Map<string, KnowledgeHit & { routes: Set<string> }>();
  for (const [route, hits] of [['raw-vector', raw], ['ontology-vector', enhanced], ['ontology-evidence', evidence]] as const) {
    for (const hit of hits) {
      const key = `${hit.knowledgeBaseId}:${hit.id}`;
      const hinted = hints.some((hint) => (hit.source || '').toLocaleLowerCase().includes(hint) || hit.title.toLocaleLowerCase().includes(hint));
      const score = Math.min(1, hit.score + (hinted ? 0.12 : 0));
      const current = merged.get(key);
      if (current) {
        current.score = Math.min(1, Math.max(current.score, score) + 0.03);
        current.routes.add(route);
      } else merged.set(key, { ...hit, score, routes: new Set([route]) });
    }
  }
  const results = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, topK).map(({ routes, ...hit }) => ({ ...hit, retrievalRoutes: [...routes] as KnowledgeHit['retrievalRoutes'] }));
  return { query, plan, strategy: plan.matchedNodes.length ? 'ontology-enhanced' : 'vector-only', results };
}

export function createKnowledgeTools(input: {
  knowledgeBases?: KnowledgeBaseRuntime[];
  model?: ModelConfig;
  semanticModel?: ModelCapabilityRuntime;
}): AgentTool[] {
  const enabled = (input.knowledgeBases ?? []).filter((item) => item.enabled);
  if (!enabled.length) return [];
  const catalog = enabled.map((item) => `${item.id}:${item.name}(${item.provider})`).join(', ');
  return [
    defineAgentTool({
      name: 'kb_search',
      description: `Search authorized private knowledge bases. Available: ${catalog}. Prefer kb_search for internal docs; use web_search only for public internet facts. Cite returned sources; never invent passages.`,
      parameters: Type.Object({
        query: Type.String({ minLength: 2, maxLength: 800 }),
        knowledgeBaseId: Type.Optional(Type.String({ description: 'Optional specific knowledge base id; omit to search all authorized bases.' })),
        topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
      }),
      execute: async ({ query, knowledgeBaseId, topK = 5 }) => {
        const targets = knowledgeBaseId
          ? enabled.filter((item) => item.id === knowledgeBaseId)
          : enabled;
        if (!targets.length) {
          return { ok: false, error: knowledgeBaseId ? `Knowledge base ${knowledgeBaseId} is not authorized.` : 'No knowledge base is authorized.' };
        }
        const hits: KnowledgeHit[] = [];
        const errors: string[] = [];
        const strategies: Array<{ knowledgeBaseId: string; strategy: HybridKnowledgeSearchResult['strategy']; matchedEntities: number }> = [];
        for (const kb of targets) {
          if (kb.ontologyEnabled === false) {
            try {
              hits.push(...await searchKnowledgeBase(kb, query, topK, input.model));
              strategies.push({ knowledgeBaseId: kb.id, strategy: 'vector-only', matchedEntities: 0 });
            } catch (error) {
              errors.push(`${kb.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
            continue;
          }
          try {
            const hybrid = await searchKnowledgeWithOntology(kb, query, topK, input.model, input.semanticModel);
            hits.push(...hybrid.results);
            strategies.push({ knowledgeBaseId: kb.id, strategy: hybrid.strategy, matchedEntities: hybrid.plan.matchedNodes.length });
          } catch (error) {
            // Ontology is an enhancement, never a hard dependency. A damaged or
            // unavailable graph must not hide otherwise valid private knowledge.
            try { hits.push(...await searchKnowledgeBase(kb, query, topK, input.model)); strategies.push({ knowledgeBaseId: kb.id, strategy: 'vector-only', matchedEntities: 0 }); }
            catch (fallbackError) { errors.push(`${kb.name}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`); }
          }
        }
        hits.sort((a, b) => b.score - a.score);
        const selected = hits.slice(0, topK);
        return {
          ok: selected.length > 0 || errors.length === 0,
          query,
          count: selected.length,
          results: selected,
          strategies,
          errors: errors.length ? errors : undefined,
        };
      },
    }),
  ];
}
