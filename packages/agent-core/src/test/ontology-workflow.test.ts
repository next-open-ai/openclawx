import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { commitOntologyCandidates, importOntologyCandidates, planOntologyQuery, publishOntologyDraft, readOntologyWorkflow, reviewOntologyCandidates, saveOntologyDraft } from '../ontology-runtime.js';

test('ontology draft, publish, candidate review and commit form a closed loop', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'openclawx-ontology-flow-'));
  const kb = { id: 'kb-flow', name: 'Flow', provider: 'lancedb' as const, enabled: true, dataDir: dir };
  try {
    await saveOntologyDraft(kb, { version: 1, nodes: [{ id: 'customer-a', type: 'customer', name: '客户A', aliases: ['A公司'], properties: {}, status: 'draft' }], edges: [] });
    const published = await publishOntologyDraft(kb);
    assert.equal(published.published?.nodes.length, 1);
    await importOntologyCandidates(kb, [{
      id: 'candidate-project', kind: 'node', confidence: 0.96, status: 'pending',
      node: { id: 'project-x', type: 'project', name: '项目X', aliases: [], properties: {}, status: 'draft' },
      evidence: [{ documentId: 'doc-1', chunkId: 'chunk-2', quote: '客户A负责项目X', source: '合同.pdf' }],
    }, {
      id: 'candidate-edge', kind: 'edge', confidence: 0.91, status: 'pending',
      edge: { id: 'edge-a-x', subjectId: 'customer-a', predicate: '负责', objectId: 'project-x', properties: {}, status: 'draft' },
      evidence: [{ documentId: 'doc-1', chunkId: 'chunk-2', quote: '客户A负责项目X', source: '合同.pdf' }],
    }]);
    await reviewOntologyCandidates(kb, ['candidate-project', 'candidate-edge'], 'accepted');
    const committed = await commitOntologyCandidates(kb);
    assert.equal(committed.committed, 2);
    assert.equal((await readOntologyWorkflow(kb)).candidates.every((item) => item.status === 'committed'), true);
    const plan = await planOntologyQuery(kb, 'A公司负责哪个项目');
    assert.equal(plan.matchedNodes[0]?.id, 'customer-a');
    assert.equal(plan.relatedNodes[0]?.id, 'project-x');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('five-step governance stages candidates, validates changes and rolls back by creating a new version', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'openclawx-ontology-governance-'));
  const kb = { id: 'kb-governance', name: 'Governance', provider: 'lancedb' as const, enabled: true, dataDir: dir };
  try {
    const runtime = await import('../ontology-runtime.js');
    await saveOntologyDraft(kb, { version: 1, nodes: [{ id: 'base', type: 'Concept', name: '基础', aliases: [], properties: {}, status: 'draft' }], edges: [] });
    await publishOntologyDraft(kb, { note: '初始版本', publisher: 'tester' });
    await runtime.upsertOntologyCandidate(kb, { id: 'manual-candidate', kind: 'node', confidence: 1, status: 'pending', node: { id: 'next', type: 'Concept', name: '新增', aliases: [], properties: { _origin: '人工新增' }, status: 'draft' }, evidence: [{ documentId: 'manual', quote: '人工新增', source: '人工维护' }] });
    await reviewOntologyCandidates(kb, ['manual-candidate'], 'accepted');
    const preview = await runtime.previewOntologyChanges(kb);
    assert.equal(preview.summary.addedNodes, 1);
    assert.deepEqual(preview.validation.blockers, []);
    const staged = await runtime.stageOntologyCandidates(kb);
    assert.equal(staged.draft.nodes.some((node) => node.id === 'next'), true);
    await publishOntologyDraft(kb, { note: '增加实体', publisher: 'tester' });
    const versions = await runtime.listOntologyVersions(kb);
    assert.equal(versions.length, 2);
    const rolledBack = await runtime.rollbackOntologyVersion(kb, 1, 'tester');
    assert.equal(rolledBack.published?.version, 3);
    assert.equal(rolledBack.published?.nodes.some((node) => node.id === 'next'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('draft repair removes orphan relations and defers their candidates', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'openclawx-ontology-repair-'));
  const kb = { id: 'kb-repair', name: 'Repair', provider: 'lancedb' as const, enabled: true, dataDir: dir };
  try {
    const runtime = await import('../ontology-runtime.js');
    await runtime.importOntologyCandidates(kb, [{ id: 'orphan-candidate', kind: 'edge', confidence: 1, status: 'accepted', edge: { id: 'orphan-edge', subjectId: 'missing-a', predicate: '关联', objectId: 'missing-b', properties: {}, status: 'draft' }, evidence: [{ documentId: 'doc', quote: '关系证据' }] }]);
    await runtime.stageOntologyCandidates(kb);
    assert.equal((await runtime.previewOntologyChanges(kb)).validation.blockers.length, 1);
    const repaired = await runtime.repairOntologyDraft(kb);
    assert.deepEqual(repaired.removedEdgeIds, ['orphan-edge']);
    assert.equal(repaired.workflow.candidates[0]?.status, 'deferred');
    assert.deepEqual((await runtime.previewOntologyChanges(kb)).validation.blockers, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('governance detects duplicates, applies merge commands and supports undo', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'openclawx-ontology-governance-ops-'));
  const kb = { id: 'kb-governance-ops', name: 'GovernanceOps', provider: 'lancedb' as const, enabled: true, dataDir: dir };
  try {
    const runtime = await import('../ontology-runtime.js');
    await saveOntologyDraft(kb, { version: 1, nodes: [
      { id: 'weight-a', type: 'Indicator', name: 'shoe_weight', aliases: [], properties: { unit: 'g' }, status: 'draft' },
      { id: 'weight-b', type: 'Metric', name: 'indicator_shoe_weight', aliases: [], properties: { label: '鞋重' }, status: 'draft' },
      { id: 'shoe', type: 'Product', name: '鞋', aliases: [], properties: {}, status: 'draft' },
    ], edges: [{ id: 'edge-weight', subjectId: 'shoe', predicate: '具有指标', objectId: 'weight-b', properties: {}, status: 'draft' }] });
    const before = await runtime.readOntologyGovernance(kb);
    const duplicate = before.issues.find((issue) => issue.category === 'duplicate_node');
    assert.ok(duplicate);
    const applied = await runtime.applyOntologyGovernance(kb, [{ type: 'merge_nodes', nodeIds: ['weight-a', 'weight-b'], canonicalId: 'weight-a', canonicalName: '鞋重' }], 'manual', 'tester');
    assert.equal(applied.workflow.draft.nodes.filter((node) => node.id.startsWith('weight')).length, 1);
    assert.equal(applied.workflow.draft.edges[0]?.objectId, 'weight-a');
    assert.equal((await runtime.readOntologyGovernance(kb)).operations.length, 1);
    const undone = await runtime.undoOntologyGovernance(kb);
    assert.equal(undone.workflow.draft.nodes.filter((node) => node.id.startsWith('weight')).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('governance resolves naming and isolated entities through explicit actions', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'openclawx-ontology-actions-'));
  const kb = { id: 'kb-actions', name: 'Actions', provider: 'lancedb' as const, enabled: true, dataDir: dir };
  try {
    const runtime = await import('../ontology-runtime.js');
    await saveOntologyDraft(kb, { version: 1, nodes: [
      { id: 'internal', type: 'Metric', name: 'PRIORITY_WEIGHT', aliases: [], properties: {}, status: 'draft' },
      { id: 'term', type: 'Concept', name: '专业术语', aliases: [], properties: {}, status: 'draft' },
      { id: 'product', type: 'Product', name: '产品', aliases: [], properties: {}, status: 'draft' },
    ], edges: [] });
    await runtime.applyOntologyGovernance(kb, [{ type: 'rename_node', nodeId: 'internal', name: '重量优先级', keepOldAsAlias: true }], 'manual');
    assert.equal((await runtime.readOntologyGovernance(kb)).issues.some((issue) => issue.id === 'naming:internal'), false);
    await runtime.applyOntologyGovernance(kb, [{ type: 'mark_term', nodeId: 'term' }, { type: 'add_edge', edgeId: 'manual-edge', subjectId: 'product', predicate: '具有指标', objectId: 'internal' }], 'manual');
    const governed = await runtime.readOntologyGovernance(kb);
    assert.equal(governed.issues.some((issue) => issue.id === 'isolated:term'), false);
    assert.equal(governed.issues.some((issue) => issue.id === 'isolated:internal'), false);
    assert.equal(governed.graph.edges[0]?.id, 'manual-edge');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
