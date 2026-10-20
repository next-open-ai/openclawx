import type { FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireAdmin } from '../auth/service.js';
import {
  BailianCreateKnowledgeRequestSchema,
  BailianDeleteKnowledgeRequestSchema,
  KnowledgeChunksRequestSchema,
  KnowledgeDeleteChunkRequestSchema,
  KnowledgeDeleteDocumentRequestSchema,
  KnowledgeIngestRequestSchema,
  KnowledgeJobStatusRequestSchema,
  KnowledgeManageRequestSchema,
  KnowledgeSearchRequestSchema,
  OntologyGraphRequestSchema,
  OntologyQueryRequestSchema,
  OntologyWorkflowRequestSchema,
  OntologyDraftSaveRequestSchema,
  OntologyCandidateImportRequestSchema,
  OntologyExtractRequestSchema,
  OntologyReviewRequestSchema,
  OntologyCandidateUpsertRequestSchema, OntologyCandidateDeleteRequestSchema, OntologyCandidateMergeRequestSchema,
  OntologyPublishRequestSchema, OntologyVersionRequestSchema, OntologyAnalysisJobRequestSchema,
  OntologyGovernanceApplyRequestSchema, OntologyGovernanceSuggestRequestSchema,
} from '@openclawx/contracts';
import {
  createBailianKnowledgeBase,
  deleteBailianKnowledgeBase,
  deleteKnowledgeChunk,
  deleteKnowledgeDocument,
  deleteKnowledgeBaseRemote,
  getKnowledgeJobStatus,
  ingestKnowledge,
  listBailianKnowledgeBases,
  listBailianPipelines,
  listKnowledgeChunks,
  listKnowledgeDocuments,
  searchKnowledgeBase,
  searchKnowledgeWithOntology,
  planOntologyQuery,
  writeOntologyGraph,
  readOntologyGraph,
  readOntologyWorkflow,
  saveOntologyDraft,
  publishOntologyDraft,
  importOntologyCandidates,
  extractOntologyCandidates,
  reviewOntologyCandidates,
  commitOntologyCandidates,
  upsertOntologyCandidate, deleteOntologyCandidates, mergeOntologyCandidates, previewOntologyChanges,
  stageOntologyCandidates, listOntologyVersions, rollbackOntologyVersion,
  repairOntologyDraft,
  readOntologyGovernance, applyOntologyGovernance, undoOntologyGovernance, suggestOntologyGovernanceRepairs,
  updateBailianKnowledgeBase,
  updateKnowledgeBaseMeta,
} from '@openclawx/agent-core';

type AnalysisJobData = { id: string; status: 'running'|'completed'|'failed'|'cancelled'; startedAt: number; completedAt?: number; phase: string; currentBatch: number; totalBatches: number; discovered?: number; result?: unknown; error?: string };
type AnalysisJob = AnalysisJobData & { controller?: AbortController };
function ontologyJobsFile() { return path.join(process.env.OPENCLAWX_DATA_DIR || path.join(os.homedir(), '.openclawx'), 'ontology-analysis-jobs.json'); }
function publicJob(job: AnalysisJob): AnalysisJobData { const { controller: _controller, ...data } = job; return data; }
function loadOntologyJobs(): Map<string, AnalysisJob> {
  try {
    const rows = JSON.parse(fs.readFileSync(ontologyJobsFile(), 'utf8')) as AnalysisJobData[];
    const now = Date.now();
    return new Map<string, AnalysisJob>(rows.map((row) => [row.id, row.status === 'running'
      ? { ...row, status: 'failed' as const, phase: '服务重启后已停止', error: '服务重启中断了分析。原任务记录已保留，请重新开始分析。', completedAt: now }
      : row]));
  } catch { return new Map<string, AnalysisJob>(); }
}
const ontologyJobs = loadOntologyJobs();
function persistOntologyJobs() {
  const file = ontologyJobsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const rows = [...ontologyJobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 100).map(publicJob);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
if (ontologyJobs.size) persistOntologyJobs();

export const knowledgeRoutes: FastifyPluginAsync = async (app) => {
  // The UI accepts source files up to 8 MB. Base64 expands those bytes by roughly
  // one third, so this route needs a larger limit than Fastify's 1 MB default.
  app.post('/knowledge/ingest', { bodyLimit: 16 * 1024 * 1024 }, async (request, reply) => {
    const parsed = KnowledgeIngestRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid ingest request.', issues: parsed.error.issues });
    try {
      return await ingestKnowledge({
        kb: parsed.data.knowledgeBase,
        title: parsed.data.title,
        content: parsed.data.content,
        fileBase64: parsed.data.fileBase64,
        fileName: parsed.data.fileName,
        source: parsed.data.source,
        model: parsed.data.model,
      });
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Ingest failed.' });
    }
  });

  app.post('/knowledge/search', async (request, reply) => {
    const parsed = KnowledgeSearchRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid search request.', issues: parsed.error.issues });
    try {
      const results = await searchKnowledgeBase(
        parsed.data.knowledgeBase,
        parsed.data.query,
        parsed.data.topK,
        parsed.data.model,
      );
      return { ok: true, results };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Search failed.' });
    }
  });

  /** Phase-1 ontology-aware search: raw vector recall is always retained. */
  app.post('/knowledge/hybrid-search', async (request, reply) => {
    const parsed = KnowledgeSearchRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid hybrid search request.', issues: parsed.error.issues });
    try {
      return { ok: true, ...(await searchKnowledgeWithOntology(parsed.data.knowledgeBase, parsed.data.query, parsed.data.topK, parsed.data.model)) };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Hybrid search failed.' });
    }
  });

  app.post('/knowledge/ontology/replace', async (request, reply) => {
    const parsed = OntologyGraphRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid ontology graph.', issues: parsed.error.issues });
    try { return await writeOntologyGraph(parsed.data.knowledgeBase, parsed.data.graph); }
    catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : 'Ontology write failed.' }); }
  });

  app.post('/knowledge/ontology/query', async (request, reply) => {
    const parsed = OntologyQueryRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid ontology query.', issues: parsed.error.issues });
    try { return { ok: true, plan: await planOntologyQuery(parsed.data.knowledgeBase, parsed.data.query, parsed.data.maxHops, parsed.data.constraints) }; }
    catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : 'Ontology query failed.' }); }
  });

  app.post('/knowledge/ontology/read', async (request, reply) => {
    const parsed = OntologyQueryRequestSchema.pick({ knowledgeBase: true }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid ontology read request.', issues: parsed.error.issues });
    return { ok: true, graph: await readOntologyGraph(parsed.data.knowledgeBase) };
  });

  app.post('/knowledge/ontology/workflow/read', async (request, reply) => {
    const parsed = OntologyWorkflowRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid ontology workflow request.', issues: parsed.error.issues });
    return { ok: true, workflow: await readOntologyWorkflow(parsed.data.knowledgeBase) };
  });

  app.post('/knowledge/ontology/draft/save', async (request, reply) => {
    const parsed = OntologyDraftSaveRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid ontology draft.', issues: parsed.error.issues });
    return { ok: true, workflow: await saveOntologyDraft(parsed.data.knowledgeBase, parsed.data.graph) };
  });

  app.post('/knowledge/ontology/draft/publish', async (request, reply) => {
    let admin;
    try { admin = requireAdmin(request); } catch { return reply.code(403).send({ message: '只有管理员可以发布正式本体版本。' }); }
    const parsed = OntologyPublishRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid ontology publish request.', issues: parsed.error.issues });
    return { ok: true, workflow: await publishOntologyDraft(parsed.data.knowledgeBase, { note: parsed.data.note, publisher: admin.displayName || admin.username }) };
  });

  app.post('/knowledge/ontology/candidates/import', async (request, reply) => {
    const parsed = OntologyCandidateImportRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid ontology candidates.', issues: parsed.error.issues });
    return { ok: true, workflow: await importOntologyCandidates(parsed.data.knowledgeBase, parsed.data.candidates) };
  });

  app.post('/knowledge/ontology/candidates/extract', async (request, reply) => {
    const parsed = OntologyExtractRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid ontology extraction request.', issues: parsed.error.issues });
    try {
      return { ok: true, ...(await extractOntologyCandidates({
        kb: parsed.data.knowledgeBase,
        documentIds: parsed.data.documentIds,
        instructions: parsed.data.instructions,
        model: parsed.data.model,
      })) };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Ontology extraction failed.' });
    }
  });

  app.post('/knowledge/ontology/candidates/review', async (request, reply) => {
    const parsed = OntologyReviewRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid ontology review.', issues: parsed.error.issues });
    return { ok: true, workflow: await reviewOntologyCandidates(parsed.data.knowledgeBase, parsed.data.candidateIds, parsed.data.decision, parsed.data.note) };
  });

  app.post('/knowledge/ontology/candidates/commit', async (request, reply) => {
    const parsed = OntologyWorkflowRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid ontology commit request.', issues: parsed.error.issues });
    return { ok: true, workflow: await commitOntologyCandidates(parsed.data.knowledgeBase) };
  });

  app.post('/knowledge/ontology/candidates/upsert', async (request, reply) => { const parsed = OntologyCandidateUpsertRequestSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ message: 'Invalid candidate.' }); return { ok: true, workflow: await upsertOntologyCandidate(parsed.data.knowledgeBase, parsed.data.candidate) }; });
  app.post('/knowledge/ontology/candidates/delete', async (request, reply) => { const parsed = OntologyCandidateDeleteRequestSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ message: 'Invalid candidate deletion.' }); return { ok: true, workflow: await deleteOntologyCandidates(parsed.data.knowledgeBase, parsed.data.candidateIds) }; });
  app.post('/knowledge/ontology/candidates/merge', async (request, reply) => { const parsed = OntologyCandidateMergeRequestSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ message: 'Invalid candidate merge.' }); return { ok: true, workflow: await mergeOntologyCandidates(parsed.data.knowledgeBase, parsed.data.sourceCandidateIds, parsed.data.mergedCandidate) }; });
  app.post('/knowledge/ontology/candidates/stage', async (request, reply) => { const parsed = OntologyWorkflowRequestSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ message: 'Invalid stage request.' }); return { ok: true, workflow: await stageOntologyCandidates(parsed.data.knowledgeBase) }; });
  app.post('/knowledge/ontology/preview', async (request, reply) => { const parsed = OntologyWorkflowRequestSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ message: 'Invalid preview request.' }); return { ok: true, ...(await previewOntologyChanges(parsed.data.knowledgeBase)) }; });
  app.post('/knowledge/ontology/draft/repair', async (request, reply) => { const parsed = OntologyWorkflowRequestSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ message: 'Invalid repair request.' }); return { ok: true, ...(await repairOntologyDraft(parsed.data.knowledgeBase)) }; });
  app.post('/knowledge/ontology/governance/read', async (request, reply) => { const parsed = OntologyWorkflowRequestSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ message: 'Invalid governance request.' }); return { ok: true, ...(await readOntologyGovernance(parsed.data.knowledgeBase)) }; });
  app.post('/knowledge/ontology/governance/apply', async (request, reply) => { const parsed = OntologyGovernanceApplyRequestSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ message: 'Invalid governance commands.', issues: parsed.error.issues }); return { ok: true, ...(await applyOntologyGovernance(parsed.data.knowledgeBase, parsed.data.commands, parsed.data.source, parsed.data.actor)) }; });
  app.post('/knowledge/ontology/governance/undo', async (request, reply) => { const parsed = OntologyWorkflowRequestSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ message: 'Invalid governance undo request.' }); try { return { ok: true, ...(await undoOntologyGovernance(parsed.data.knowledgeBase)) }; } catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : 'Undo failed.' }); } });
  app.post('/knowledge/ontology/governance/suggest', async (request, reply) => { const parsed = OntologyGovernanceSuggestRequestSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ message: 'AI 治理请求参数不完整。', issues: parsed.error.issues }); try { const governance = await readOntologyGovernance(parsed.data.knowledgeBase), wanted = new Set(parsed.data.issueIds), issues = wanted.size ? governance.issues.filter((issue) => wanted.has(issue.id)) : governance.issues; return { ok: true, suggestions: await suggestOntologyGovernanceRepairs({ graph: governance.graph, issues, model: parsed.data.model }) }; } catch (error) { const technical = error instanceof Error ? error.message : ''; const malformed = error instanceof SyntaxError || error instanceof Error && (error.name === 'ZodError' || technical.includes('suggestions')); return reply.code(400).send({ message: malformed ? '模型返回的治理建议格式不完整，系统已放弃本次结果。请重新分析；若持续出现，可减少当前问题范围后重试。' : technical || 'AI 治理建议生成失败。' }); } });
  app.post('/knowledge/ontology/versions', async (request, reply) => { const parsed = OntologyWorkflowRequestSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ message: 'Invalid versions request.' }); return { ok: true, versions: await listOntologyVersions(parsed.data.knowledgeBase) }; });
  app.post('/knowledge/ontology/versions/rollback', async (request, reply) => { try { requireAdmin(request); } catch { return reply.code(403).send({ message: '只有管理员可以回滚正式本体版本。' }); } const parsed = OntologyVersionRequestSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ message: 'Invalid rollback request.' }); return { ok: true, workflow: await rollbackOntologyVersion(parsed.data.knowledgeBase, parsed.data.version) }; });

  app.post('/knowledge/ontology/analysis/start', async (request, reply) => {
    const parsed = OntologyExtractRequestSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ message: 'Invalid ontology extraction request.', issues: parsed.error.issues });
    const id = randomUUID(), controller = new AbortController();
    const totalBatches = Math.max(1, Math.ceil(parsed.data.documentIds.length * 3 / (parsed.data.intensity === 'deep' ? 3 : 4)));
    const job: AnalysisJob = { id, status: 'running', startedAt: Date.now(), phase: '读取文档', currentBatch: 0, totalBatches, controller }; ontologyJobs.set(id, job); persistOntologyJobs();
    void extractOntologyCandidates({ kb: parsed.data.knowledgeBase, documentIds: parsed.data.documentIds, instructions: parsed.data.instructions, model: parsed.data.model, intensity: parsed.data.intensity, signal: controller.signal, onProgress: (event) => { Object.assign(job, event); persistOntologyJobs(); } }).then((result) => { job.status = 'completed'; job.phase = '候选归并完成'; job.result = result; job.completedAt = Date.now(); persistOntologyJobs(); }).catch((error) => { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = error instanceof Error ? error.message : String(error); job.completedAt = Date.now(); persistOntologyJobs(); });
    return { ok: true, jobId: id };
  });
  app.post('/knowledge/ontology/analysis/status', async (request, reply) => { const parsed = OntologyAnalysisJobRequestSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ message: 'Invalid job.' }); const job = ontologyJobs.get(parsed.data.jobId); if (!job) return reply.code(404).send({ message: '分析任务不存在或已超过保留期限。' }); return { ok: true, job: publicJob(job) }; });
  app.post('/knowledge/ontology/analysis/cancel', async (request, reply) => { const parsed = OntologyAnalysisJobRequestSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ message: 'Invalid job.' }); const job = ontologyJobs.get(parsed.data.jobId); job?.controller?.abort(); if (job && job.status === 'running') { job.status = 'cancelled'; job.phase = '已取消'; job.completedAt = Date.now(); persistOntologyJobs(); } return { ok: true }; });

  app.post('/knowledge/bailian/pipelines', async (request, reply) => {
    const body = (request.body || {}) as { apiKey?: string; baseUrl?: string; workspaceId?: string };
    if (!body.apiKey?.trim()) return reply.code(400).send({ message: 'apiKey is required.' });
    try {
      const pipelines = await listBailianPipelines({
        apiKey: body.apiKey,
        baseUrl: body.baseUrl,
        workspaceId: body.workspaceId,
      });
      return { ok: true, pipelines };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'List Bailian pipelines failed.' });
    }
  });

  app.post('/knowledge/bailian/create', async (request, reply) => {
    const parsed = BailianCreateKnowledgeRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid Bailian create request.', issues: parsed.error.issues });
    try {
      const created = await createBailianKnowledgeBase(parsed.data);
      return { ok: true, ...created };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Create Bailian knowledge base failed.' });
    }
  });

  app.post('/knowledge/bailian/update', async (request, reply) => {
    const body = (request.body || {}) as {
      accessKeyId?: string;
      accessKeySecret?: string;
      workspaceId?: string;
      indexId?: string;
      name?: string;
      description?: string;
    };
    if (!body.accessKeyId?.trim() || !body.accessKeySecret?.trim() || !body.workspaceId?.trim() || !body.indexId?.trim()) {
      return reply.code(400).send({ message: 'accessKeyId, accessKeySecret, workspaceId and indexId are required.' });
    }
    try {
      await updateBailianKnowledgeBase({
        accessKeyId: body.accessKeyId,
        accessKeySecret: body.accessKeySecret,
        workspaceId: body.workspaceId,
        indexId: body.indexId,
        name: body.name,
        description: body.description,
      });
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Update Bailian knowledge base failed.' });
    }
  });

  app.post('/knowledge/bailian/delete', async (request, reply) => {
    const parsed = BailianDeleteKnowledgeRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid Bailian delete request.', issues: parsed.error.issues });
    try {
      await deleteBailianKnowledgeBase(parsed.data);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Delete Bailian knowledge base failed.' });
    }
  });

  app.post('/knowledge/bailian/list', async (request, reply) => {
    const body = (request.body || {}) as {
      accessKeyId?: string;
      accessKeySecret?: string;
      workspaceId?: string;
      pageNumber?: number;
      pageSize?: number;
      indexName?: string;
    };
    if (!body.accessKeyId?.trim() || !body.accessKeySecret?.trim() || !body.workspaceId?.trim()) {
      return reply.code(400).send({ message: 'accessKeyId, accessKeySecret and workspaceId are required.' });
    }
    try {
      const indices = await listBailianKnowledgeBases({
        accessKeyId: body.accessKeyId,
        accessKeySecret: body.accessKeySecret,
        workspaceId: body.workspaceId,
        pageNumber: body.pageNumber,
        pageSize: body.pageSize,
        indexName: body.indexName,
      });
      return { ok: true, indices };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'List Bailian knowledge bases failed.' });
    }
  });

  app.post('/knowledge/documents', async (request, reply) => {
    const parsed = KnowledgeManageRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid documents request.', issues: parsed.error.issues });
    try {
      return await listKnowledgeDocuments(parsed.data.knowledgeBase);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'List documents failed.' });
    }
  });

  app.post('/knowledge/chunks', async (request, reply) => {
    const parsed = KnowledgeChunksRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid chunks request.', issues: parsed.error.issues });
    try {
      return await listKnowledgeChunks({
        kb: parsed.data.knowledgeBase,
        documentId: parsed.data.documentId,
        query: parsed.data.query,
        offset: parsed.data.offset,
        limit: parsed.data.limit,
      });
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'List chunks failed.' });
    }
  });

  app.post('/knowledge/documents/delete', async (request, reply) => {
    const parsed = KnowledgeDeleteDocumentRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid delete document request.', issues: parsed.error.issues });
    try {
      return await deleteKnowledgeDocument(parsed.data.knowledgeBase, parsed.data.documentId);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Delete document failed.' });
    }
  });

  app.post('/knowledge/chunks/delete', async (request, reply) => {
    const parsed = KnowledgeDeleteChunkRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid delete chunk request.', issues: parsed.error.issues });
    try {
      return await deleteKnowledgeChunk(parsed.data.knowledgeBase, parsed.data.chunkId);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Delete chunk failed.' });
    }
  });

  app.post('/knowledge/job-status', async (request, reply) => {
    const parsed = KnowledgeJobStatusRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid job status request.', issues: parsed.error.issues });
    try {
      const status = await getKnowledgeJobStatus(parsed.data.knowledgeBase, parsed.data.jobId);
      return { ok: true, ...status };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Job status failed.' });
    }
  });

  app.post('/knowledge/update', async (request, reply) => {
    const body = (request.body || {}) as {
      knowledgeBase?: unknown;
      name?: string;
      description?: string;
    };
    const parsed = KnowledgeManageRequestSchema.safeParse({ knowledgeBase: body.knowledgeBase });
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid update request.', issues: parsed.error.issues });
    try {
      return await updateKnowledgeBaseMeta(parsed.data.knowledgeBase, {
        name: body.name,
        description: body.description,
      });
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Update knowledge base failed.' });
    }
  });

  app.post('/knowledge/delete-remote', async (request, reply) => {
    const parsed = KnowledgeManageRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid delete request.', issues: parsed.error.issues });
    try {
      return await deleteKnowledgeBaseRemote(parsed.data.knowledgeBase);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Delete remote knowledge base failed.' });
    }
  });
};
