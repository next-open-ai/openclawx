import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { KnowledgeBaseRuntime } from '@openclawx/contracts';
import { recallOntologyEvidence, resolveOntologyEntitiesWithModel } from '../knowledge-runtime.js';
import { planOntologyQuery, readOntologyGraph, writeOntologyGraph } from '../ontology-runtime.js';

test('ontology graph persists and expands aliases/relationships deterministically', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'openclawx-ontology-'));
  try {
    const kb = { id: 'kb-test', name: 'Test', provider: 'lancedb', dataDir: dir, enabled: true } as KnowledgeBaseRuntime;
    await writeOntologyGraph(kb, {
      version: 1,
      nodes: [
        { id: 'issue', type: 'Issue', name: '退款未到账', aliases: ['退钱没收到'], properties: {}, status: 'published' },
        { id: 'flow', type: 'Process', name: '退款异常处理流程', aliases: [], properties: { documentId: 'doc-flow' }, status: 'published' },
      ],
      edges: [{ id: 'e1', subjectId: 'flow', predicate: '处理', objectId: 'issue', properties: {}, status: 'published' }],
    });
    assert.equal(existsSync(path.join(dir, 'ontology.sqlite')), true);
    assert.equal((await readOntologyGraph(kb)).nodes.length, 2);
    const plan = await planOntologyQuery(kb, '客人退钱没收到怎么办');
    assert.equal(plan.matchedNodes[0]?.id, 'issue');
    assert.equal(plan.relatedNodes[0]?.id, 'flow');
    assert.ok(plan.expandedTerms.includes('退款未到账'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy JSON graph migrates once into SQLite without deleting the backup', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'openclawx-ontology-migrate-'));
  const legacy = path.join(dir, 'ontology.json');
  try {
    writeFileSync(legacy, JSON.stringify({
      version: 3,
      nodes: [{ id: 'legacy-node', type: 'Company', name: '旧数据公司', aliases: [], properties: {}, status: 'published' }],
      edges: [],
    }));
    const kb = { id: 'kb-legacy', name: 'Legacy', provider: 'lancedb', dataDir: dir, enabled: true } as KnowledgeBaseRuntime;
    const graph = await readOntologyGraph(kb);
    assert.equal(graph.version, 3);
    assert.equal(graph.nodes[0]?.id, 'legacy-node');
    assert.equal(existsSync(path.join(dir, 'ontology.sqlite')), true);
    assert.equal(existsSync(legacy), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ontology query supports controlled two-hop traversal, predicates and evidence references', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'openclawx-ontology-query-'));
  try {
    const kb = { id: 'kb-query', name: 'Query', provider: 'lancedb', dataDir: dir, enabled: true } as KnowledgeBaseRuntime;
    await writeOntologyGraph(kb, {
      version: 1,
      nodes: [
        { id: 'material-a', type: 'Material', name: '材料A', aliases: ['A材料'], properties: { documentId: 'doc-material', chunkId: 'chunk-material' }, status: 'published' },
        { id: 'product-b', type: 'Product', name: '产品B', aliases: [], properties: { documentId: 'doc-product', chunkId: 'chunk-product' }, status: 'published' },
        { id: 'team-c', type: 'Team', name: '团队C', aliases: [], properties: { region: '华东' }, status: 'published' },
      ],
      edges: [
        { id: 'uses', subjectId: 'material-a', predicate: '用于', objectId: 'product-b', properties: { documentId: 'doc-product', chunkId: 'chunk-product' }, status: 'published' },
        { id: 'owns', subjectId: 'product-b', predicate: '负责团队', objectId: 'team-c', properties: {}, status: 'published' },
      ],
    });
    const plan = await planOntologyQuery(kb, 'A材料用于的产品由哪个团队负责', 2);
    assert.deepEqual(plan.paths.map((item) => item.depth), [1, 2]);
    assert.deepEqual(plan.relatedNodes.map((item) => item.id), ['product-b', 'team-c']);
    assert.equal(plan.matchedPredicates.includes('用于'), true);
    assert.equal(plan.evidenceRefs.some((item) => item.chunkId === 'chunk-product'), true);
    const constrained = await planOntologyQuery(kb, '材料A', 1, { nodeTypes: ['Material'], direction: 'out', predicates: ['用于'] });
    assert.deepEqual(constrained.relatedNodes.map((item) => item.id), ['product-b']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ontology evidence references recall the bound local chunk without vector search', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'openclawx-ontology-evidence-'));
  try {
    const kb = { id: 'kb-evidence', name: 'Evidence', provider: 'lancedb', dataDir: dir, enabled: true } as KnowledgeBaseRuntime;
    writeFileSync(path.join(dir, 'chunks.json'), JSON.stringify([{ id: 'chunk-1', documentId: 'doc-1', documentTitle: '制度', title: '制度#1', content: '产品B由团队C负责。', source: 'policy.md', vector: [], createdAt: Date.now() }]));
    await writeOntologyGraph(kb, {
      version: 1,
      nodes: [{ id: 'product-b', type: 'Product', name: '产品B', aliases: [], properties: { documentId: 'doc-1', chunkId: 'chunk-1' }, status: 'published' }],
      edges: [],
    });
    const plan = await planOntologyQuery(kb, '产品B', 1);
    const hits = await recallOntologyEvidence(kb, plan);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, 'chunk-1');
    assert.equal(hits[0]?.score, 0.96);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('semantic matches seed deterministic graph traversal without creating graph data', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'openclawx-ontology-semantic-'));
  try {
    const kb = { id: 'kb-semantic', name: 'Semantic', provider: 'lancedb', dataDir: dir, enabled: true } as KnowledgeBaseRuntime;
    await writeOntologyGraph(kb, {
      version: 1,
      nodes: [
        { id: 'refund-missing', type: 'Issue', name: '退款未到账', aliases: [], properties: {}, status: 'published' },
        { id: 'refund-flow', type: 'Process', name: '退款异常处理流程', aliases: [], properties: {}, status: 'published' },
      ],
      edges: [{ id: 'handles', subjectId: 'refund-flow', predicate: '处理', objectId: 'refund-missing', properties: {}, status: 'published' }],
    });
    const rulePlan = await planOntologyQuery(kb, '钱一直没有退回来', 2);
    assert.equal(rulePlan.matchMode, 'none');
    const semanticPlan = await planOntologyQuery(kb, '钱一直没有退回来', 2, {}, [{ nodeId: 'refund-missing', confidence: 0.91, reason: '语义一致' }]);
    assert.equal(semanticPlan.matchMode, 'semantic');
    assert.equal(semanticPlan.matchedNodes[0]?.id, 'refund-missing');
    assert.equal(semanticPlan.relatedNodes[0]?.id, 'refund-flow');
    assert.equal((await readOntologyGraph(kb)).nodes.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('semantic entity linker accepts only high-confidence IDs from the bounded candidate set', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'openclawx-ontology-linker-'));
  const server = createServer((request, response) => {
    if (request.url !== '/v1/chat/completions') return void response.writeHead(404).end();
    response.setHeader('content-type', 'text/event-stream');
    const content = JSON.stringify({ matches: [
        { nodeId: 'refund-missing', confidence: 0.91, reason: '语义一致' },
        { nodeId: 'invented', confidence: 0.99, reason: '越界' },
        { nodeId: 'refund-rejected', confidence: 0.3, reason: '置信度不足' },
      ] });
    response.end(`data: ${JSON.stringify({ id: 'ontology', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const kb = { id: 'kb-linker', name: 'Linker', provider: 'lancedb', dataDir: dir, enabled: true } as KnowledgeBaseRuntime;
    await writeOntologyGraph(kb, { version: 1, nodes: [
      { id: 'refund-missing', type: 'Issue', name: '退款未到账', aliases: [], properties: {}, status: 'published' },
      { id: 'refund-rejected', type: 'Issue', name: '退款被拒绝', aliases: [], properties: {}, status: 'published' },
    ], edges: [] });
    const matches = await resolveOntologyEntitiesWithModel(kb, '钱一直没有退回来', {
      id: 'ontology-test', capability: 'ontology', provider: 'openai-compatible', providerLabel: 'Test',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', modelId: 'test-model', mode: 'auto',
    });
    assert.deepEqual(matches.map((item) => item.nodeId), ['refund-missing']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
