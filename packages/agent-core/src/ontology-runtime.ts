import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OntologyGraphSchema, OntologyWorkflowSchema, type KnowledgeBaseRuntime, type OntologyCandidate, type OntologyEdge, type OntologyGovernanceCommand, type OntologyGraph, type OntologyNode, type OntologyQueryConstraints, type OntologyWorkflow } from '@openclawx/contracts';

export type OntologyEvidenceRef = { documentId?: string; chunkId?: string; source?: string; nodeId?: string; edgeId?: string };
export type OntologyQueryPath = { nodeIds: string[]; edgeIds: string[]; depth: number };
export type OntologyQueryPlan = { query: string; matchedNodes: Array<OntologyNode & { score: number }>; relatedNodes: OntologyNode[]; edges: OntologyEdge[]; paths: OntologyQueryPath[]; expandedTerms: string[]; matchedPredicates: string[]; filters: Record<string, string>; evidenceRefs: OntologyEvidenceRef[]; constraints: OntologyQueryConstraints; matchMode: 'rule' | 'semantic' | 'none'; semanticMatches?: Array<{ nodeId: string; confidence: number; reason?: string }> };
type SqlValue = string | number | Uint8Array | null;
type SqlDatabase = { run(sql: string, params?: SqlValue[]): void; exec(sql: string, params?: SqlValue[]): Array<{ columns: string[]; values: SqlValue[][] }>; export(): Uint8Array; close(): void };
type SqlJs = { Database: new (bytes?: Uint8Array) => SqlDatabase };
const require = createRequire(import.meta.url);
let sqlPromise: Promise<SqlJs> | null = null;
const queues = new Map<string, Promise<unknown>>();

function dir(kb: KnowledgeBaseRuntime) { return kb.dataDir?.trim() ? path.resolve(kb.dataDir) : path.resolve(process.env.OPENCLAWX_KNOWLEDGE_DIR?.trim() || '.openclawx-knowledge', kb.id); }
function dbPath(kb: KnowledgeBaseRuntime) { return path.join(dir(kb), 'ontology.sqlite'); }
function emptyGraph(): OntologyGraph { return { version: 1, nodes: [], edges: [] }; }

async function sqlJs(): Promise<SqlJs> {
  if (!sqlPromise) sqlPromise = Promise.resolve().then(async () => {
    const root = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
    const init = require(path.join(root, 'sql-wasm.js')) as (options: { wasmBinary: Buffer }) => Promise<SqlJs>;
    return init({ wasmBinary: readFileSync(path.join(root, 'sql-wasm.wasm')) });
  });
  return sqlPromise;
}

function schema(db: SqlDatabase) {
  db.run('CREATE TABLE IF NOT EXISTS ontology_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
  db.run('CREATE TABLE IF NOT EXISTS ontology_nodes (layer TEXT NOT NULL,id TEXT NOT NULL,type TEXT NOT NULL,name TEXT NOT NULL,aliases_json TEXT NOT NULL,properties_json TEXT NOT NULL,source TEXT,status TEXT NOT NULL,PRIMARY KEY(layer,id))');
  db.run('CREATE INDEX IF NOT EXISTS idx_ontology_nodes_name ON ontology_nodes(layer,name)');
  db.run('CREATE TABLE IF NOT EXISTS ontology_edges (layer TEXT NOT NULL,id TEXT NOT NULL,subject_id TEXT NOT NULL,predicate TEXT NOT NULL,object_id TEXT NOT NULL,properties_json TEXT NOT NULL,source TEXT,status TEXT NOT NULL,PRIMARY KEY(layer,id))');
  db.run('CREATE INDEX IF NOT EXISTS idx_ontology_edges_subject ON ontology_edges(layer,subject_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ontology_edges_object ON ontology_edges(layer,object_id)');
  db.run('CREATE TABLE IF NOT EXISTS ontology_candidates (id TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL,confidence REAL NOT NULL,status TEXT NOT NULL,node_json TEXT,edge_json TEXT,evidence_json TEXT NOT NULL,reviewed_at INTEGER,review_note TEXT)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ontology_candidates_status ON ontology_candidates(status)');
  db.run('CREATE TABLE IF NOT EXISTS ontology_versions (version INTEGER PRIMARY KEY NOT NULL,graph_json TEXT NOT NULL,published_at INTEGER NOT NULL)');
  db.run('CREATE TABLE IF NOT EXISTS ontology_version_notes (version INTEGER PRIMARY KEY NOT NULL,note TEXT,publisher TEXT,created_at INTEGER NOT NULL)');
  db.run('CREATE TABLE IF NOT EXISTS ontology_operations (id TEXT PRIMARY KEY NOT NULL,commands_json TEXT NOT NULL,before_graph_json TEXT NOT NULL,after_graph_json TEXT NOT NULL,source TEXT NOT NULL,actor TEXT,created_at INTEGER NOT NULL,undone_at INTEGER)');
}
function rows(db: SqlDatabase, sql: string, params: SqlValue[] = []) { const result = db.exec(sql, params)[0]; return result ? result.values.map((values) => Object.fromEntries(result.columns.map((column, i) => [column, values[i]]))) : []; }
function meta(db: SqlDatabase, key: string) { const value = rows(db, 'SELECT value FROM ontology_meta WHERE key=?', [key])[0]?.value; return value == null ? undefined : String(value); }
function setMeta(db: SqlDatabase, key: string, value: string | number) { db.run('INSERT INTO ontology_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(value)]); }

function readLayer(db: SqlDatabase, layer: 'draft' | 'published'): OntologyGraph {
  const nodes = rows(db, 'SELECT * FROM ontology_nodes WHERE layer=? ORDER BY rowid', [layer]).map((r) => ({ id: String(r.id), type: String(r.type), name: String(r.name), aliases: JSON.parse(String(r.aliases_json)), properties: JSON.parse(String(r.properties_json)), ...(r.source == null ? {} : { source: String(r.source) }), status: String(r.status) as OntologyNode['status'] }));
  const edges = rows(db, 'SELECT * FROM ontology_edges WHERE layer=? ORDER BY rowid', [layer]).map((r) => ({ id: String(r.id), subjectId: String(r.subject_id), predicate: String(r.predicate), objectId: String(r.object_id), properties: JSON.parse(String(r.properties_json)), ...(r.source == null ? {} : { source: String(r.source) }), status: String(r.status) as OntologyEdge['status'] }));
  return OntologyGraphSchema.parse({ version: Number(meta(db, `${layer}_version`)) || 1, nodes, edges });
}
function replaceLayer(db: SqlDatabase, layer: 'draft' | 'published', graph: OntologyGraph) {
  const parsed = OntologyGraphSchema.parse(graph); db.run('DELETE FROM ontology_nodes WHERE layer=?', [layer]); db.run('DELETE FROM ontology_edges WHERE layer=?', [layer]);
  for (const n of parsed.nodes) db.run('INSERT INTO ontology_nodes VALUES(?,?,?,?,?,?,?,?)', [layer, n.id, n.type, n.name, JSON.stringify(n.aliases), JSON.stringify(n.properties), n.source ?? null, n.status]);
  for (const e of parsed.edges) db.run('INSERT INTO ontology_edges VALUES(?,?,?,?,?,?,?,?)', [layer, e.id, e.subjectId, e.predicate, e.objectId, JSON.stringify(e.properties), e.source ?? null, e.status]);
  setMeta(db, `${layer}_version`, parsed.version); setMeta(db, `${layer}_exists`, 1);
}
function readCandidates(db: SqlDatabase): OntologyCandidate[] { return rows(db, 'SELECT * FROM ontology_candidates ORDER BY rowid').map((r) => ({ id: String(r.id), kind: String(r.kind) as OntologyCandidate['kind'], ...(r.node_json == null ? {} : { node: JSON.parse(String(r.node_json)) }), ...(r.edge_json == null ? {} : { edge: JSON.parse(String(r.edge_json)) }), evidence: JSON.parse(String(r.evidence_json)), confidence: Number(r.confidence), status: String(r.status) as OntologyCandidate['status'], ...(r.reviewed_at == null ? {} : { reviewedAt: Number(r.reviewed_at) }), ...(r.review_note == null ? {} : { reviewNote: String(r.review_note) }) })); }
function replaceCandidates(db: SqlDatabase, candidates: OntologyCandidate[]) { db.run('DELETE FROM ontology_candidates'); for (const c of candidates) db.run('INSERT INTO ontology_candidates VALUES(?,?,?,?,?,?,?,?,?)', [c.id, c.kind, c.confidence, c.status, c.node ? JSON.stringify(c.node) : null, c.edge ? JSON.stringify(c.edge) : null, JSON.stringify(c.evidence), c.reviewedAt ?? null, c.reviewNote ?? null]); }
function workflow(db: SqlDatabase): OntologyWorkflow { const published = meta(db, 'published_exists') === '1' ? readLayer(db, 'published') : undefined; return OntologyWorkflowSchema.parse({ draft: meta(db, 'draft_exists') === '1' ? readLayer(db, 'draft') : (published || emptyGraph()), ...(published ? { published } : {}), candidates: readCandidates(db), updatedAt: Number(meta(db, 'updated_at')) || Date.now() }); }
function replaceWorkflow(db: SqlDatabase, value: OntologyWorkflow) { const parsed = OntologyWorkflowSchema.parse(value); replaceLayer(db, 'draft', parsed.draft); if (parsed.published) replaceLayer(db, 'published', parsed.published); else { db.run('DELETE FROM ontology_nodes WHERE layer=?', ['published']); db.run('DELETE FROM ontology_edges WHERE layer=?', ['published']); setMeta(db, 'published_exists', 0); } replaceCandidates(db, parsed.candidates); setMeta(db, 'updated_at', parsed.updatedAt); }

function legacy(kb: KnowledgeBaseRuntime): OntologyWorkflow | null {
  try {
    const wf = path.join(dir(kb), 'ontology-workflow.json'); if (existsSync(wf)) return OntologyWorkflowSchema.parse(JSON.parse(readFileSync(wf, 'utf8')));
    const graphFile = path.join(dir(kb), 'ontology.json'); if (existsSync(graphFile)) { const graph = OntologyGraphSchema.parse(JSON.parse(readFileSync(graphFile, 'utf8'))); return { draft: graph, published: graph, candidates: [], updatedAt: Date.now() }; }
  } catch { /* Keep invalid legacy files untouched for manual recovery. */ }
  return null;
}
async function withDb<T>(kb: KnowledgeBaseRuntime, mutate: boolean, fn: (db: SqlDatabase) => T | Promise<T>): Promise<T> {
  const file = dbPath(kb), prior = queues.get(file) || Promise.resolve();
  const task = prior.catch(() => undefined).then(async () => { const SQL = await sqlJs(), existed = existsSync(file); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const db = new SQL.Database(existed ? readFileSync(file) : undefined); try { schema(db); if (!existed) { const old = legacy(kb); if (old) replaceWorkflow(db, old); setMeta(db, 'schema_version', 1); } const result = await fn(db); if (mutate || !existed) writeFileSync(file, Buffer.from(db.export()), { mode: 0o600 }); return result; } finally { db.close(); } });
  const settled = task.then(() => undefined, () => undefined); queues.set(file, settled); try { return await task; } finally { if (queues.get(file) === settled) queues.delete(file); }
}
function transaction<T>(db: SqlDatabase, fn: () => T): T { db.run('BEGIN'); try { const result = fn(); db.run('COMMIT'); return result; } catch (error) { db.run('ROLLBACK'); throw error; } }

export async function readOntologyGraph(kb: KnowledgeBaseRuntime) { return withDb(kb, false, (db) => meta(db, 'published_exists') === '1' ? readLayer(db, 'published') : emptyGraph()); }
export async function writeOntologyGraph(kb: KnowledgeBaseRuntime, graph: OntologyGraph) { return withDb(kb, true, (db) => transaction(db, () => { replaceLayer(db, 'published', graph); if (meta(db, 'draft_exists') !== '1') replaceLayer(db, 'draft', graph); setMeta(db, 'updated_at', Date.now()); db.run('INSERT OR REPLACE INTO ontology_versions VALUES(?,?,?)', [graph.version, JSON.stringify(graph), Date.now()]); return { ok: true as const, path: dbPath(kb), nodes: graph.nodes.length, edges: graph.edges.length }; })); }
export async function readOntologyWorkflow(kb: KnowledgeBaseRuntime) { return withDb(kb, false, workflow); }
export async function saveOntologyDraft(kb: KnowledgeBaseRuntime, graph: OntologyGraph) { return withDb(kb, true, (db) => transaction(db, () => { const state = workflow(db); replaceWorkflow(db, { ...state, draft: { ...graph, version: Math.max(1, graph.version || 1) }, updatedAt: Date.now() }); return workflow(db); })); }
export async function publishOntologyDraft(kb: KnowledgeBaseRuntime, metadata: { note?: string; publisher?: string } = {}) { return withDb(kb, true, (db) => transaction(db, () => { const state = workflow(db), validation = validateOntologyGraph(state.draft); if (validation.blockers.length) throw new Error(`发布前仍有 ${validation.blockers.length} 个阻断问题。`); const published = { ...state.draft, version: Math.max((state.published?.version || 0) + 1, state.draft.version || 1), nodes: state.draft.nodes.map((node) => ({ ...node, status: 'published' as const })), edges: state.draft.edges.map((edge) => ({ ...edge, status: 'published' as const })) }, candidates = state.candidates.map((candidate) => candidate.status === 'accepted' ? { ...candidate, status: 'committed' as const } : candidate), now = Date.now(); replaceWorkflow(db, { ...state, draft: published, published, candidates, updatedAt: now }); db.run('INSERT OR REPLACE INTO ontology_versions VALUES(?,?,?)', [published.version, JSON.stringify(published), now]); db.run('INSERT OR REPLACE INTO ontology_version_notes VALUES(?,?,?,?)', [published.version, metadata.note ?? null, metadata.publisher ?? null, now]); return workflow(db); })); }
export async function importOntologyCandidates(kb: KnowledgeBaseRuntime, candidates: OntologyCandidate[]) { return withDb(kb, true, (db) => transaction(db, () => { const state = workflow(db), byId = new Map(state.candidates.map((c) => [c.id, c])); for (const candidate of candidates) byId.set(candidate.id, candidate); replaceWorkflow(db, { ...state, candidates: [...byId.values()], updatedAt: Date.now() }); return workflow(db); })); }
export async function reviewOntologyCandidates(kb: KnowledgeBaseRuntime, ids: string[], decision: 'accepted' | 'rejected' | 'deferred', note?: string) { return withDb(kb, true, (db) => transaction(db, () => { const wanted = new Set(ids), state = workflow(db), candidates = state.candidates.map((c) => wanted.has(c.id) ? { ...c, status: decision, reviewedAt: Date.now(), ...(note ? { reviewNote: note } : {}) } : c); replaceWorkflow(db, { ...state, candidates, updatedAt: Date.now() }); return workflow(db); })); }
export async function upsertOntologyCandidate(kb: KnowledgeBaseRuntime, candidate: OntologyCandidate) { return importOntologyCandidates(kb, [candidate]); }
export async function deleteOntologyCandidates(kb: KnowledgeBaseRuntime, ids: string[]) { return withDb(kb, true, (db) => transaction(db, () => { const wanted = new Set(ids), state = workflow(db); replaceWorkflow(db, { ...state, candidates: state.candidates.filter((candidate) => !wanted.has(candidate.id)), updatedAt: Date.now() }); return workflow(db); })); }
export async function mergeOntologyCandidates(kb: KnowledgeBaseRuntime, sourceIds: string[], mergedCandidate: OntologyCandidate) {
  return withDb(kb, true, (db) => transaction(db, () => {
    const state = workflow(db), wanted = new Set(sourceIds), sources = state.candidates.filter((candidate) => wanted.has(candidate.id));
    const replacedNodeIds = new Set(sources.flatMap((candidate) => candidate.node?.id ? [candidate.node.id] : []));
    const targetNodeId = mergedCandidate.node?.id;
    const candidates = state.candidates.filter((candidate) => !wanted.has(candidate.id)).map((candidate) => {
      if (!targetNodeId || candidate.kind !== 'edge' || !candidate.edge) return candidate;
      const subjectId = replacedNodeIds.has(candidate.edge.subjectId) ? targetNodeId : candidate.edge.subjectId;
      const objectId = replacedNodeIds.has(candidate.edge.objectId) ? targetNodeId : candidate.edge.objectId;
      return { ...candidate, edge: { ...candidate.edge, subjectId, objectId } };
    });
    candidates.push({ ...mergedCandidate, evidence: [...new Map([...sources.flatMap((candidate) => candidate.evidence), ...mergedCandidate.evidence].map((evidence) => [`${evidence.documentId}:${evidence.chunkId || ''}:${evidence.quote}`, evidence])).values()] });
    replaceWorkflow(db, { ...state, candidates, updatedAt: Date.now() }); return workflow(db);
  }));
}

function graphWithAcceptedCandidates(state: OntologyWorkflow) {
  const nodes = new Map(state.draft.nodes.map((node) => [node.id, node])), edges = new Map(state.draft.edges.map((edge) => [edge.id, edge]));
  for (const candidate of state.candidates) if (candidate.status === 'accepted') {
    const evidence = candidate.evidence[0];
    if (candidate.kind === 'node' && candidate.node) nodes.set(candidate.node.id, { ...candidate.node, status: 'draft', source: evidence?.source || evidence?.documentId });
    if (candidate.kind === 'edge' && candidate.edge) edges.set(candidate.edge.id, { ...candidate.edge, status: 'draft', source: evidence?.source || evidence?.documentId });
  }
  return OntologyGraphSchema.parse({ version: state.draft.version, nodes: [...nodes.values()], edges: [...edges.values()] });
}
export function validateOntologyGraph(graph: OntologyGraph) {
  const nodeIds = new Set(graph.nodes.map((node) => node.id)), names = new Map<string, string[]>(), blockers: string[] = [], warnings: string[] = [];
  for (const node of graph.nodes) { const key = normalize(node.name); names.set(key, [...(names.get(key) || []), node.id]); }
  for (const edge of graph.edges) { if (!nodeIds.has(edge.subjectId) || !nodeIds.has(edge.objectId)) blockers.push(`关系 ${edge.id} 的端点实体不存在。`); if (edge.subjectId === edge.objectId) warnings.push(`关系 ${edge.id} 是自循环关系。`); }
  for (const [name, ids] of names) if (name && ids.length > 1) warnings.push(`实体名称重复：${ids.join('、')}`);
  const connected = new Set(graph.edges.flatMap((edge) => [edge.subjectId, edge.objectId]));
  const isolated = graph.nodes.filter((node) => !connected.has(node.id)).length; if (isolated) warnings.push(`存在 ${isolated} 个孤立实体。`);
  return { blockers, warnings, isolated };
}
export async function previewOntologyChanges(kb: KnowledgeBaseRuntime) { return withDb(kb, false, (db) => { const state = workflow(db), graph = graphWithAcceptedCandidates(state), base = state.published || emptyGraph(), baseNodes = new Map(base.nodes.map((node) => [node.id, node])), baseEdges = new Map(base.edges.map((edge) => [edge.id, edge])); const summary = { addedNodes: graph.nodes.filter((node) => !baseNodes.has(node.id)).length, modifiedNodes: graph.nodes.filter((node) => baseNodes.has(node.id) && JSON.stringify(node) !== JSON.stringify(baseNodes.get(node.id))).length, deletedNodes: base.nodes.filter((node) => !graph.nodes.some((item) => item.id === node.id)).length, addedEdges: graph.edges.filter((edge) => !baseEdges.has(edge.id)).length, modifiedEdges: graph.edges.filter((edge) => baseEdges.has(edge.id) && JSON.stringify(edge) !== JSON.stringify(baseEdges.get(edge.id))).length, deletedEdges: base.edges.filter((edge) => !graph.edges.some((item) => item.id === edge.id)).length }; return { graph, summary, validation: validateOntologyGraph(graph) }; }); }
export async function stageOntologyCandidates(kb: KnowledgeBaseRuntime) { return withDb(kb, true, (db) => transaction(db, () => { const state = workflow(db), draft = graphWithAcceptedCandidates(state); replaceWorkflow(db, { ...state, draft, updatedAt: Date.now() }); return workflow(db); })); }
export async function repairOntologyDraft(kb: KnowledgeBaseRuntime) { return withDb(kb, true, (db) => transaction(db, () => { const state = workflow(db), nodeIds = new Set(state.draft.nodes.map((node) => node.id)), removedEdgeIds = state.draft.edges.filter((edge) => !nodeIds.has(edge.subjectId) || !nodeIds.has(edge.objectId)).map((edge) => edge.id), removed = new Set(removedEdgeIds), draft = { ...state.draft, edges: state.draft.edges.filter((edge) => !removed.has(edge.id)) }, candidates = state.candidates.map((candidate) => candidate.kind === 'edge' && candidate.edge && removed.has(candidate.edge.id) ? { ...candidate, status: 'deferred' as const, reviewedAt: Date.now(), reviewNote: '发布前校验：关系端点不存在，已自动暂缓。' } : candidate); replaceWorkflow(db, { ...state, draft, candidates, updatedAt: Date.now() }); return { workflow: workflow(db), removedEdgeIds }; })); }

export type OntologyGovernanceIssue = { id: string; category: 'duplicate_node'|'naming'|'isolated_node'|'orphan_edge'|'self_loop'|'duplicate_edge'; severity: 'blocker'|'warning'; title: string; description: string; nodeIds: string[]; edgeIds: string[]; suggestedCommands: OntologyGovernanceCommand[] };
function governanceKey(name: string) { return normalize(name).replace(/^(indicator|metric|priority|entity|concept)/, '').replace(/(json|entity|node)$/, ''); }
export function inspectOntologyGovernance(graph: OntologyGraph): OntologyGovernanceIssue[] {
  const issues: OntologyGovernanceIssue[] = [], nodes = new Map(graph.nodes.map((node) => [node.id, node])), grouped = new Map<string, OntologyNode[]>();
  for (const node of graph.nodes) { const key = governanceKey(node.name); if (key) grouped.set(key, [...(grouped.get(key) || []), node]); if (/^[A-Z0-9_\-]+$/.test(node.name) || /^(indicator|metric|priority)[_\-]/i.test(node.name)) issues.push({ id: `naming:${node.id}`, category: 'naming', severity: 'warning', title: `名称需要规范：${node.name}`, description: '名称疑似内部字段或技术标识，建议设置业务显示名称并将原名称保留为别名。', nodeIds: [node.id], edgeIds: [], suggestedCommands: [] }); }
  for (const [key, values] of grouped) if (values.length > 1) { const canonical = values[0]!; issues.push({ id: `duplicate:${key}`, category: 'duplicate_node', severity: 'warning', title: `疑似重复实体：${values.map((node) => node.name).join(' / ')}`, description: '名称归一化后相同或仅包含通用前缀。合并前请核对类型、属性、关系和来源。', nodeIds: values.map((node) => node.id), edgeIds: [], suggestedCommands: [{ type: 'merge_nodes', nodeIds: values.map((node) => node.id), canonicalId: canonical.id, canonicalName: canonical.name }] }); }
  const edgeKeys = new Map<string, OntologyEdge[]>(), connected = new Set<string>();
  for (const edge of graph.edges) { connected.add(edge.subjectId); connected.add(edge.objectId); if (!nodes.has(edge.subjectId) || !nodes.has(edge.objectId)) issues.push({ id: `orphan:${edge.id}`, category: 'orphan_edge', severity: 'blocker', title: `关系端点不存在：${edge.predicate}`, description: `${edge.subjectId} → ${edge.objectId}`, nodeIds: [edge.subjectId, edge.objectId], edgeIds: [edge.id], suggestedCommands: [{ type: 'delete_edge', edgeId: edge.id }] }); if (edge.subjectId === edge.objectId) issues.push({ id: `self:${edge.id}`, category: 'self_loop', severity: 'warning', title: `自循环关系：${edge.predicate}`, description: nodeNameForGraph(nodes, edge.subjectId), nodeIds: [edge.subjectId], edgeIds: [edge.id], suggestedCommands: [{ type: 'delete_edge', edgeId: edge.id }] }); const key = `${edge.subjectId}:${normalize(edge.predicate)}:${edge.objectId}`; edgeKeys.set(key, [...(edgeKeys.get(key) || []), edge]); }
  for (const [key, values] of edgeKeys) if (values.length > 1) issues.push({ id: `edges:${key}`, category: 'duplicate_edge', severity: 'warning', title: `重复关系：${values[0]!.predicate}`, description: `发现 ${values.length} 条主体、谓词和客体相同的关系。`, nodeIds: [values[0]!.subjectId, values[0]!.objectId], edgeIds: values.map((edge) => edge.id), suggestedCommands: values.slice(1).map((edge) => ({ type: 'delete_edge' as const, edgeId: edge.id })) });
  for (const node of graph.nodes) if (!connected.has(node.id) && node.properties._ontologyRole !== 'term') issues.push({ id: `isolated:${node.id}`, category: 'isolated_node', severity: 'warning', title: `孤立实体：${node.name}`, description: '该实体没有任何入向或出向关系。可保留为术语、补充关系或从草稿删除。', nodeIds: [node.id], edgeIds: [], suggestedCommands: [] });
  return issues;
}
function nodeNameForGraph(nodes: Map<string, OntologyNode>, id: string) { return nodes.get(id)?.name || id; }
function applyGovernanceCommands(graph: OntologyGraph, commands: OntologyGovernanceCommand[]) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, structuredClone(node)])), edges = new Map(graph.edges.map((edge) => [edge.id, structuredClone(edge)]));
  for (const command of commands) {
    if (command.type === 'delete_edge') edges.delete(command.edgeId);
    else if (command.type === 'reverse_edge') { const edge = edges.get(command.edgeId); if (edge) edges.set(edge.id, { ...edge, subjectId: edge.objectId, objectId: edge.subjectId }); }
    else if (command.type === 'rename_node') { const node = nodes.get(command.nodeId); if (node) nodes.set(node.id, { ...node, name: command.name, aliases: command.keepOldAsAlias ? [...new Set([...node.aliases, node.name])] : node.aliases }); }
    else if (command.type === 'change_node_type') { const node = nodes.get(command.nodeId); if (node) nodes.set(node.id, { ...node, type: command.nodeType }); }
    else if (command.type === 'mark_term') { const node = nodes.get(command.nodeId); if (node) nodes.set(node.id, { ...node, properties: { ...node.properties, _ontologyRole: 'term' } }); }
    else if (command.type === 'add_edge') { if (nodes.has(command.subjectId) && nodes.has(command.objectId)) edges.set(command.edgeId, { id: command.edgeId, subjectId: command.subjectId, predicate: command.predicate, objectId: command.objectId, properties: { _origin: '人工治理' }, status: 'draft' }); }
    else if (command.type === 'delete_node') { if (command.migrateToNodeId && nodes.has(command.migrateToNodeId)) for (const [id, edge] of edges) edges.set(id, { ...edge, subjectId: edge.subjectId === command.nodeId ? command.migrateToNodeId : edge.subjectId, objectId: edge.objectId === command.nodeId ? command.migrateToNodeId : edge.objectId }); else for (const [id, edge] of edges) if (edge.subjectId === command.nodeId || edge.objectId === command.nodeId) edges.delete(id); nodes.delete(command.nodeId); }
    else if (command.type === 'merge_nodes') { const source = command.nodeIds.map((id) => nodes.get(id)).filter((node): node is OntologyNode => Boolean(node)), canonical = nodes.get(command.canonicalId) || source[0]; if (!canonical) continue; const merged = { ...canonical, id: command.canonicalId, name: command.canonicalName, aliases: [...new Set(source.flatMap((node) => [node.name, ...node.aliases]).filter((name) => name !== command.canonicalName))], properties: Object.assign({}, ...source.map((node) => node.properties)) }; for (const id of command.nodeIds) nodes.delete(id); nodes.set(command.canonicalId, merged); for (const [id, edge] of edges) edges.set(id, { ...edge, subjectId: command.nodeIds.includes(edge.subjectId) ? command.canonicalId : edge.subjectId, objectId: command.nodeIds.includes(edge.objectId) ? command.canonicalId : edge.objectId }); }
  }
  return OntologyGraphSchema.parse({ ...graph, nodes: [...nodes.values()], edges: [...edges.values()] });
}
export async function readOntologyGovernance(kb: KnowledgeBaseRuntime) { return withDb(kb, false, (db) => { const state = workflow(db), issues = inspectOntologyGovernance(state.draft), operations = rows(db, 'SELECT id,commands_json,source,actor,created_at,undone_at FROM ontology_operations ORDER BY created_at DESC LIMIT 50').map((row) => ({ id: String(row.id), commands: JSON.parse(String(row.commands_json)), source: String(row.source), actor: row.actor == null ? undefined : String(row.actor), createdAt: Number(row.created_at), undoneAt: row.undone_at == null ? undefined : Number(row.undone_at) })); return { graph: state.draft, issues, operations }; }); }
export async function applyOntologyGovernance(kb: KnowledgeBaseRuntime, commands: OntologyGovernanceCommand[], source: 'manual'|'rule'|'ai', actor?: string) { return withDb(kb, true, (db) => transaction(db, () => { const state = workflow(db), before = state.draft, after = applyGovernanceCommands(before, commands), id = `op-${Date.now()}-${Math.random().toString(36).slice(2,8)}`, now = Date.now(); replaceWorkflow(db, { ...state, draft: after, updatedAt: now }); db.run('INSERT INTO ontology_operations VALUES(?,?,?,?,?,?,?,?)', [id, JSON.stringify(commands), JSON.stringify(before), JSON.stringify(after), source, actor ?? null, now, null]); return { workflow: workflow(db), operationId: id, issues: inspectOntologyGovernance(after) }; })); }
export async function undoOntologyGovernance(kb: KnowledgeBaseRuntime) { return withDb(kb, true, (db) => transaction(db, () => { const row = rows(db, 'SELECT * FROM ontology_operations WHERE undone_at IS NULL ORDER BY created_at DESC LIMIT 1')[0]; if (!row) throw new Error('没有可撤销的图谱治理操作。'); const state = workflow(db), graph = OntologyGraphSchema.parse(JSON.parse(String(row.before_graph_json))), now = Date.now(); replaceWorkflow(db, { ...state, draft: graph, updatedAt: now }); db.run('UPDATE ontology_operations SET undone_at=? WHERE id=?', [now, String(row.id)]); return { workflow: workflow(db), issues: inspectOntologyGovernance(graph) }; })); }
export async function listOntologyVersions(kb: KnowledgeBaseRuntime) { return withDb(kb, false, (db) => rows(db, 'SELECT v.version,v.graph_json,v.published_at,n.note,n.publisher FROM ontology_versions v LEFT JOIN ontology_version_notes n ON n.version=v.version ORDER BY v.version DESC').map((row) => ({ version: Number(row.version), graph: OntologyGraphSchema.parse(JSON.parse(String(row.graph_json))), publishedAt: Number(row.published_at), ...(row.note == null ? {} : { note: String(row.note) }), ...(row.publisher == null ? {} : { publisher: String(row.publisher) }) }))); }
export async function rollbackOntologyVersion(kb: KnowledgeBaseRuntime, version: number, publisher?: string) { return withDb(kb, true, (db) => transaction(db, () => { const row = rows(db, 'SELECT graph_json FROM ontology_versions WHERE version=?', [version])[0]; if (!row) throw new Error(`本体版本 v${version} 不存在。`); const state = workflow(db), source = OntologyGraphSchema.parse(JSON.parse(String(row.graph_json))), nextVersion = Math.max(...rows(db, 'SELECT version FROM ontology_versions').map((item) => Number(item.version)), state.published?.version || 0) + 1, published = { ...source, version: nextVersion }, now = Date.now(); replaceWorkflow(db, { ...state, draft: published, published, updatedAt: now }); db.run('INSERT INTO ontology_versions VALUES(?,?,?)', [nextVersion, JSON.stringify(published), now]); db.run('INSERT INTO ontology_version_notes VALUES(?,?,?,?)', [nextVersion, `从 v${version} 回滚生成`, publisher ?? null, now]); return workflow(db); })); }
export async function commitOntologyCandidates(kb: KnowledgeBaseRuntime) {
  return withDb(kb, true, (db) => transaction(db, () => { const state = workflow(db), base = state.published || emptyGraph(), nodes = new Map(base.nodes.map((n) => [n.id, n])), edges = new Map(base.edges.map((e) => [e.id, e])), committed = new Set<string>();
    for (const c of state.candidates) { if (c.status !== 'accepted') continue; const ev = c.evidence[0]; if (c.kind === 'node' && c.node) nodes.set(c.node.id, { ...c.node, status: 'published', source: ev.source || ev.documentId, properties: { ...c.node.properties, documentId: ev.documentId, ...(ev.chunkId ? { chunkId: ev.chunkId } : {}) } }); if (c.kind === 'edge' && c.edge && nodes.has(c.edge.subjectId) && nodes.has(c.edge.objectId)) edges.set(c.edge.id, { ...c.edge, status: 'published', source: ev.source || ev.documentId, properties: { ...c.edge.properties, documentId: ev.documentId, ...(ev.chunkId ? { chunkId: ev.chunkId } : {}) } }); else if (c.kind === 'edge') continue; committed.add(c.id); }
    const published = { version: Math.max(1, base.version + (committed.size ? 1 : 0)), nodes: [...nodes.values()], edges: [...edges.values()] }, candidates = state.candidates.map((c) => committed.has(c.id) ? { ...c, status: 'committed' as const } : c); replaceWorkflow(db, { ...state, draft: published, published, candidates, updatedAt: Date.now() }); db.run('INSERT OR REPLACE INTO ontology_versions VALUES(?,?,?)', [published.version, JSON.stringify(published), Date.now()]); return { ...workflow(db), committed: committed.size }; }));
}

function normalize(value: string) { return value.trim().toLocaleLowerCase().replace(/[\s\-_]+/g, ''); }
function propertyMatches(node: OntologyNode, properties: OntologyQueryConstraints['properties']) {
  return Object.entries(properties).every(([key, value]) => String(node.properties[key] ?? '') === String(value));
}
function evidenceRef(value: OntologyNode | OntologyEdge, identity: { nodeId?: string; edgeId?: string }): OntologyEvidenceRef | null {
  const documentId = typeof value.properties.documentId === 'string' ? value.properties.documentId : undefined;
  const chunkId = typeof value.properties.chunkId === 'string' ? value.properties.chunkId : undefined;
  const source = value.source || (typeof value.properties.source === 'string' ? value.properties.source : undefined);
  return documentId || chunkId || source ? { documentId, chunkId, source, ...identity } : null;
}
export async function planOntologyQuery(kb: KnowledgeBaseRuntime, query: string, maxHops = 1, requested: Partial<OntologyQueryConstraints> = {}, semanticMatches: Array<{ nodeId: string; confidence: number; reason?: string }> = []): Promise<OntologyQueryPlan> {
  const graph = await readOntologyGraph(kb), q = normalize(query), hops = Math.min(2, Math.max(0, maxHops));
  const constraints: OntologyQueryConstraints = {
    nodeTypes: requested.nodeTypes || [], predicates: requested.predicates || [], properties: requested.properties || {},
    direction: requested.direction || 'both', maxResults: requested.maxResults || 50,
  };
  const activeNodes = graph.nodes.filter((node) => node.status !== 'archived');
  const allowedTypes = new Set(constraints.nodeTypes.map(normalize));
  const semanticById = new Map(semanticMatches.map((item) => [item.nodeId, item]));
  const matched = activeNodes.map((node) => {
    if (allowedTypes.size && !allowedTypes.has(normalize(node.type))) return { ...node, score: 0 };
    if (!propertyMatches(node, constraints.properties)) return { ...node, score: 0 };
    let score = 0;
    for (const label of [node.name, ...(node.aliases || [])]) {
      const normalized = normalize(label);
      if (normalized && q.includes(normalized)) score = Math.max(score, normalized === q ? 1 : normalized.length / Math.max(q.length, normalized.length));
    }
    const normalizedType = normalize(node.type);
    if (!score && normalizedType && q.includes(normalizedType)) score = 0.35;
    for (const value of Object.values(node.properties || {})) {
      const normalized = normalize(String(value));
      if (!score && normalized.length >= 2 && q.includes(normalized)) score = 0.3;
    }
    score = Math.max(score, semanticById.get(node.id)?.confidence || 0);
    return { ...node, score };
  }).filter((node) => node.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
  const explicitPredicates = constraints.predicates.map(normalize);
  const inferredPredicates = [...new Set(graph.edges.filter((edge) => edge.status !== 'archived' && normalize(edge.predicate) && q.includes(normalize(edge.predicate))).map((edge) => edge.predicate))];
  const traversalPredicates = new Set(explicitPredicates);
  const matchedPredicates = explicitPredicates.length ? constraints.predicates : inferredPredicates;
  const canTraverse = (edge: OntologyEdge, nodeId: string) => {
    if (edge.status === 'archived' || (traversalPredicates.size && !traversalPredicates.has(normalize(edge.predicate)))) return false;
    if (constraints.direction === 'out') return edge.subjectId === nodeId;
    if (constraints.direction === 'in') return edge.objectId === nodeId;
    return edge.subjectId === nodeId || edge.objectId === nodeId;
  };
  const nodeMap = new Map(activeNodes.map((node) => [node.id, node]));
  const matchedIds = new Set(matched.map((node) => node.id));
  const visited = new Set(matchedIds);
  const selectedEdges = new Map<string, OntologyEdge>();
  const paths: OntologyQueryPath[] = [];
  let frontier = matched.map((node) => ({ id: node.id, nodeIds: [node.id], edgeIds: [] as string[] }));
  for (let depth = 1; depth <= hops && frontier.length; depth += 1) {
    const next: typeof frontier = [];
    for (const item of frontier) {
      for (const edge of graph.edges) {
        if (!canTraverse(edge, item.id)) continue;
        const nextId = edge.subjectId === item.id ? edge.objectId : edge.subjectId;
        if (!nodeMap.has(nextId) || item.nodeIds.includes(nextId)) continue;
        selectedEdges.set(edge.id, edge);
        const path = { nodeIds: [...item.nodeIds, nextId], edgeIds: [...item.edgeIds, edge.id], depth };
        paths.push(path);
        if (!visited.has(nextId) && visited.size < constraints.maxResults + matchedIds.size) { visited.add(nextId); next.push({ id: nextId, nodeIds: path.nodeIds, edgeIds: path.edgeIds }); }
      }
    }
    frontier = next;
  }
  const relatedNodes = activeNodes.filter((node) => visited.has(node.id) && !matchedIds.has(node.id)).slice(0, constraints.maxResults);
  const edges = [...selectedEdges.values()];
  const expandedTerms = [...new Set([...matched, ...relatedNodes].flatMap((node) => [node.name, ...(node.aliases || [])]).concat(matchedPredicates).filter(Boolean))];
  const filters: Record<string, string> = {}; for (const node of [...matched, ...relatedNodes]) for (const [key, value] of Object.entries(node.properties || {})) if (typeof value === 'string') filters[key] ||= value;
  const evidenceRefs = [...matched, ...relatedNodes].map((node) => evidenceRef(node, { nodeId: node.id })).concat(edges.map((edge) => evidenceRef(edge, { edgeId: edge.id }))).filter((item): item is OntologyEvidenceRef => Boolean(item));
  const usedSemanticMatches = semanticMatches.filter((item) => matchedIds.has(item.nodeId));
  return { query, matchedNodes: matched, relatedNodes, edges, paths, expandedTerms, matchedPredicates, filters, evidenceRefs, constraints, matchMode: usedSemanticMatches.length ? 'semantic' : matched.length ? 'rule' : 'none', ...(usedSemanticMatches.length ? { semanticMatches: usedSemanticMatches } : {}) };
}
export function graphDocumentHints(plan: OntologyQueryPlan) { return [...new Set(plan.evidenceRefs.flatMap((ref) => [ref.documentId, ref.source]).filter((value): value is string => Boolean(value)))]; }
