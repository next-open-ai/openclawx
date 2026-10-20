import { getStoredSessionToken } from './auth';
import { createRequestCoalescer } from './request-coalescer';
import type { DataAppDelivery } from '@workmate/contracts';
import { dataAppProjectExecutionSchema, type DataAppProjectCreate, type DataAppProjectExecute } from '@workmate/contracts';
import { DSH_ENV_FIX_ACTION_ID } from '../features/dsh/environment-ui';

export interface HealthStatus { status: 'ok'; service: 'workmate-api'; version: string; }
export interface EnvCheckItem {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'error';
  required: string;
  found: string;
  command?: string;
  help: string;
}

export interface EnvCheckReport {
  platform: string;
  checks: EnvCheckItem[];
  summary: { total: number; ok: number; warn: number; error: number };
  checkedAt: number;
  pythonDecision?: {
    source: 'override' | 'system' | 'bundled' | 'none';
    command: string | null;
    version: string | null;
    reason: string;
    isolationNote: string;
    systemFound: string | null;
    bundledFound: string | null;
  };
  workspaceScrap?: {
    totalBytes: number;
    totalBytesLabel: string;
    stagingRoot: string;
    rootCount: number;
    entryCount: number;
    scrapNames: string[];
    manualHelp: string;
  };
}

export interface RuntimeDispatcherRunState {
  runId: string;
  orgId?: string;
  userId?: string;
  sessionId: string;
  kind: 'chat' | 'project-task';
  priority: 'high' | 'normal';
  state: 'queued' | 'running';
  waitReason?: 'session-lane' | 'user-capacity' | 'global-capacity';
  queuedAt: number;
  startedAt?: number;
}

export interface RuntimeDispatcherStatus {
  limits: { global: number; perUser: number; maxQueueWaitMs: number; highPriorityBurstLimit: number };
  counts: { queued: number; running: number; activeSessions: number; activeUsers: number; highPriorityQueued: number; normalPriorityQueued: number };
  runs: RuntimeDispatcherRunState[];
}

export interface RuntimeSidecarRunState {
  runId: string;
  sessionId?: string;
  userId?: string;
  state: 'queued' | 'running';
  waitReason?: 'capacity';
  queuedAt: number;
  startedAt?: number;
}

export interface RuntimeSidecarStatus {
  status: 'stopped' | 'running';
  limits: { poolSize: number; maxRuns: number; queueWaitMs: number; restartCooldownMs: number };
  counts: { queued: number; activeRuns: number; sidecars: number; unhealthySidecars: number; coolingSidecars: number };
  endpoints: Array<{ id: string; port: number; url: string; activeRuns: number; status: 'running' | 'cooldown' | 'unhealthy' | 'stopped'; lastError?: string; cooldownRemainingMs?: number }>;
  runs: RuntimeSidecarRunState[];
}

export interface RuntimeStatusResponse {
  dispatcher: RuntimeDispatcherStatus | null;
  sidecar: RuntimeSidecarStatus;
}

export interface PptxEnhancedComponentStatus {
  state: 'not-installed' | 'ready' | 'broken';
  installed: boolean;
  version: string | null;
  location: string;
  message?: string;
}
export type DoclingEnhancedComponentStatus = PptxEnhancedComponentStatus;

export interface StorageCleanupReport {
  scannedAt: number;
  retentionDays: number;
  safeCleanup: {
    count: number;
    bytes: number;
    items: Array<{ id: string; category: 'run-intermediate' | 'legacy-workspace' | 'orphan-asset'; label: string; bytes: number; modifiedAt: number }>;
  };
  largeAssets: Array<{ id: string; name: string; mimeType: string; sizeBytes: number; createdAt: number; conversationId: string | null; projectId: string | null }>;
}

export async function getHealth(): Promise<HealthStatus> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/health`);
  if (!response.ok) throw new Error(`API health check failed: ${response.status}`);
  return response.json() as Promise<HealthStatus>;
}

export async function getServerModelConfig() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/model`);
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Model settings failed: ${response.status}`);
  return body as unknown;
}

export async function saveServerModelConfig(value: unknown) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/model`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value ?? {}),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Save model settings failed: ${response.status}`);
  return body as unknown;
}

export async function getServerSearchConfig() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/search`);
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Search settings failed: ${response.status}`);
  return body as unknown;
}

export async function saveServerSearchConfig(value: unknown) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/search`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value ?? {}),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Save search settings failed: ${response.status}`);
  return body as unknown;
}

export async function getServerKnowledgeProviderConfig() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/knowledge/providers`);
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Knowledge provider settings failed: ${response.status}`);
  return body as unknown;
}

export async function saveServerKnowledgeProviderConfig(value: unknown) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/knowledge/providers`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value ?? {}),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Save knowledge provider settings failed: ${response.status}`);
  return body as unknown;
}

export async function getServerKnowledgeBases() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/knowledge/bases`);
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Knowledge bases failed: ${response.status}`);
  return body as unknown;
}

export async function saveServerKnowledgeBases(value: unknown) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/knowledge/bases`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value ?? []),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Save knowledge bases failed: ${response.status}`);
  return body as unknown;
}

export async function getServerMcpConnections() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/mcp/connections`);
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `MCP connections failed: ${response.status}`);
  return body as unknown;
}

export async function saveServerMcpConnections(value: unknown) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/mcp/connections`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value ?? []),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Save MCP connections failed: ${response.status}`);
  return body as unknown;
}

export async function getServerCapabilitySkills() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/capabilities/skills`);
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Capability skills failed: ${response.status}`);
  return body as unknown;
}

export async function saveServerCapabilitySkills(value: unknown) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/capabilities/skills`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value ?? []),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Save capability skills failed: ${response.status}`);
  return body as unknown;
}

export async function getServerCapabilityPolicies() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/capabilities/policies`);
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Capability policies failed: ${response.status}`);
  return body as unknown;
}

export async function saveServerCapabilityPolicies(value: unknown) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/capabilities/policies`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value ?? []),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Save capability policies failed: ${response.status}`);
  return body as unknown;
}

export async function getServerRuntimeConfig() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/runtime`);
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Runtime settings failed: ${response.status}`);
  return body as unknown;
}

export async function saveServerRuntimeConfig(value: unknown) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/runtime`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value ?? {}),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Save runtime settings failed: ${response.status}`);
  return body as unknown;
}

export async function scanStorageCleanup(): Promise<StorageCleanupReport> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/storage/scan`);
  const body = await response.json().catch(() => ({})) as StorageCleanupReport & { message?: string };
  if (!response.ok) throw new Error(body.message || `Storage scan failed: ${response.status}`);
  return body;
}

export async function runStorageCleanup(): Promise<{ deleted: number; bytes: number; scan: StorageCleanupReport }> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/storage/cleanup`, { method: 'POST' });
  const body = await response.json().catch(() => ({})) as { deleted: number; bytes: number; scan: StorageCleanupReport; message?: string };
  if (!response.ok) throw new Error(body.message || `Storage cleanup failed: ${response.status}`);
  return body;
}

export async function getPptxEnhancedComponentStatus(): Promise<PptxEnhancedComponentStatus> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/components/pptx-enhanced`);
  const body = await response.json().catch(() => ({})) as PptxEnhancedComponentStatus & { message?: string };
  if (!response.ok) throw new Error(body.message || `PPTX component status failed: ${response.status}`);
  return body;
}

export async function installPptxEnhancedComponent(): Promise<PptxEnhancedComponentStatus> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/components/pptx-enhanced/install`, { method: 'POST' });
  const body = await response.json().catch(() => ({})) as PptxEnhancedComponentStatus & { message?: string };
  if (!response.ok) throw new Error(body.message || `PPTX component install failed: ${response.status}`);
  return body;
}

export async function removePptxEnhancedComponent(): Promise<PptxEnhancedComponentStatus> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/components/pptx-enhanced`, { method: 'DELETE' });
  const body = await response.json().catch(() => ({})) as PptxEnhancedComponentStatus & { message?: string };
  if (!response.ok) throw new Error(body.message || `PPTX component removal failed: ${response.status}`);
  return body;
}

export async function getDoclingEnhancedComponentStatus(): Promise<DoclingEnhancedComponentStatus> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/components/docling-enhanced`);
  const body = await response.json().catch(() => ({})) as DoclingEnhancedComponentStatus & { message?: string };
  if (!response.ok) throw new Error(body.message || `Docling component status failed: ${response.status}`);
  return body;
}
export async function installDoclingEnhancedComponent(): Promise<DoclingEnhancedComponentStatus> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/components/docling-enhanced/install`, { method: 'POST' });
  const body = await response.json().catch(() => ({})) as DoclingEnhancedComponentStatus & { message?: string };
  if (!response.ok) throw new Error(body.message || `Docling component install failed: ${response.status}`);
  return body;
}
export async function removeDoclingEnhancedComponent(): Promise<DoclingEnhancedComponentStatus> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/settings/components/docling-enhanced`, { method: 'DELETE' });
  const body = await response.json().catch(() => ({})) as DoclingEnhancedComponentStatus & { message?: string };
  if (!response.ok) throw new Error(body.message || `Docling component removal failed: ${response.status}`);
  return body;
}

export async function getRuntimeStatus(): Promise<RuntimeStatusResponse> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/orch/runtime/status`);
  const body = await response.json().catch(() => ({})) as RuntimeStatusResponse & { message?: string };
  if (!response.ok) throw new Error(body.message || `Runtime status failed: ${response.status}`);
  return body;
}

export function subscribeRuntimeStatus(handlers: {
  onMessage: (value: RuntimeStatusResponse) => void;
  onError?: () => void;
}): () => void {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const token = getStoredSessionToken();
  const params = new URLSearchParams();
  if (token) params.set('sessionToken', token);
  const source = new EventSource(`${apiBase}/api/orch/runtime/status/stream${params.size ? `?${params.toString()}` : ''}`);
  source.addEventListener('runtime-status', (event) => {
    if (!(event instanceof MessageEvent)) return;
    try {
      handlers.onMessage(JSON.parse(event.data) as RuntimeStatusResponse);
    } catch {
      handlers.onError?.();
    }
  });
  source.onerror = () => {
    handlers.onError?.();
  };
  return () => source.close();
}

export async function getEnvironmentReport(): Promise<EnvCheckReport> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/environment`);
  const body = await response.json().catch(() => ({})) as EnvCheckReport & { message?: string };
  if (!response.ok) throw new Error(body.message || `Environment check failed: ${response.status}`);
  return body;
}

export type EnvFixActionId =
  | 'fix-storage'
  | 'fix-pip'
  | 'fix-agentscope'
  | 'install-python'
  | 'clean-workspace-scrap'
  | typeof DSH_ENV_FIX_ACTION_ID;

export async function runEnvironmentFix(actionId: EnvFixActionId): Promise<{
  ok: boolean;
  message: string;
  detail?: string;
  actionId: EnvFixActionId;
  report?: EnvCheckReport;
}> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/environment/fix`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionId }),
  });
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    message?: string;
    detail?: string;
    actionId?: EnvFixActionId;
    report?: EnvCheckReport;
  };
  if (!response.ok) throw new Error(body.message || `Environment fix failed: ${response.status}`);
  return {
    ok: Boolean(body.ok),
    message: body.message || '修复完成',
    detail: body.detail,
    actionId: body.actionId || actionId,
    report: body.report,
  };
}

export interface RuntimeSkill {
  id: string; name: string; description: string; mode: 'available' | 'default'; rootPath?: string; instructions?: string;
  resources: Array<{ path: string; content: string }>;
  execution: { allowWorkspaceWrite: boolean; allowScriptExecution: boolean; allowedNetworkHosts: string[]; allowAllNonDestructive: boolean };
}

export interface ToolActivity { invocationId?: string; progress?: number; toolName: string; summary: string; detail?: string; status: 'running' | 'completed' | 'failed'; startedAt?: number; durationMs?: number; at?: number; }
export interface CapabilityHealthObservation {
  capability: import('@workmate/contracts').ModelCapability;
  modelId: string;
  ok: boolean;
  summary: string;
}
let capabilityHealthObserver: ((value: CapabilityHealthObservation) => void) | undefined;
/** Subscribe to terminal application-model results without coupling transport to settings storage. */
export function setCapabilityHealthObserver(observer: (value: CapabilityHealthObservation) => void) {
  capabilityHealthObserver = observer;
}
export function mergeToolActivity(activities: ToolActivity[], incoming: ToolActivity) {
  const existing = incoming.invocationId
    ? activities.find((item) => item.invocationId === incoming.invocationId)
    : activities.find((item) => !item.invocationId && item.toolName === incoming.toolName && item.status === 'running');
  if (existing) {
    const startedSummary = existing.summary;
    const startedDetail = existing.detail;
    const startedAt = existing.startedAt ?? existing.at ?? Date.now();
    Object.assign(existing, incoming);
    if (startedDetail && incoming.detail && !startedDetail.includes(incoming.detail)) {
      existing.detail = `${startedDetail}\n\n${incoming.detail}`.slice(0, 12_000);
    } else if (startedDetail && !incoming.detail) {
      existing.detail = startedDetail;
    }
    existing.startedAt = startedAt;
    if (incoming.status !== 'running' && existing.durationMs == null) existing.durationMs = Math.max(0, Date.now() - startedAt);
    if (incoming.status !== 'running' && incoming.status !== 'failed') existing.summary = startedSummary;
    else if (incoming.status === 'failed' && startedSummary && incoming.summary && !startedSummary.includes(incoming.summary)) {
      existing.summary = `${startedSummary} — ${incoming.summary}`;
    }
    return existing;
  }
  const duplicate = !incoming.invocationId && activities.find((item) => !item.invocationId
    && item.toolName === incoming.toolName && item.summary === incoming.summary && item.status === incoming.status);
  if (duplicate) return duplicate;
  const now = Date.now();
  const added = {
    ...incoming,
    startedAt: incoming.startedAt ?? incoming.at ?? now,
    ...(incoming.status !== 'running' && incoming.durationMs == null ? { durationMs: 0 } : {}),
  };
  activities.push(added);
  return added;
}
export interface ToolApproval { skillId: string; capability: 'workspace-write' | 'script-execution' | 'network-access'; summary: string; /** Server-side approval id when originating from /api/orch sessions. */ id?: string; }
export interface GeneratedArtifact { runId: string; path: string; }
export interface SearchSource { title: string; url: string; source?: string; }
export type McpConnectionPayload =
  | { id: string; name: string; url: string; transport: 'http' | 'sse'; enabled: boolean; apiKey?: string; description?: string }
  | { id: string; name: string; transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; enabled: boolean; description?: string };

export type KnowledgeBasePayload = {
  id: string;
  name: string;
  provider: 'lancedb' | 'bailian' | 'dify' | 'qdrant' | 'pinecone';
  enabled: boolean;
  description?: string;
  dataDir?: string;
  baseUrl?: string;
  apiKey?: string;
  externalId?: string;
  categoryId?: string;
  workspaceId?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  embeddingModel?: string;
  embeddingMode?: 'system' | 'model';
  embeddingModelConfigId?: string;
  embeddingMeta?: {
    dimension?: number;
    normalize?: boolean;
    maxBatch?: number;
    maxInputChars?: number;
  };
  indexState?: {
    status: 'ready' | 'stale' | 'rebuilding';
    signature?: string;
    lastBuildAt?: number;
    lastBuildModel?: string;
    lastBuildError?: string;
  };
};

export type StreamChatInput = {
  profile: { id: string; name: string; instructions: string; toolIds: string[] };
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  model: { provider: string; baseUrl?: string; chatModel: string; imageModel?: string; embeddingModel?: string; apiKey: string; disableThinking?: boolean; enableSearch?: boolean };
  skills?: RuntimeSkill[];
  searchProviders?: Array<{ id: 'bocha' | 'tavily' | 'brave' | 'exa' | 'zhipu' | 'aliyun'; label: string; apiKey: string; baseUrl?: string; enabled: boolean; preferred: boolean }>;
  mcpConnections?: McpConnectionPayload[];
  knowledgeBases?: KnowledgeBasePayload[];
  modelCapabilities?: import('@workmate/contracts').ModelCapabilityRuntime[];
  runId?: string;
  projectWorkspacePath?: string;
  maxSteps?: number;
  runTimeoutMs?: number;
  mcpToolTimeoutMs?: number;
  signal?: AbortSignal;
};

function isAbortError(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String((error as { name?: unknown }).name || '') : '';
  return name === 'AbortError';
}

export async function streamChat(
  input: StreamChatInput,
  onDelta: (text: string) => void,
  onToolActivity?: (activity: ToolActivity) => void,
  onApproval?: (approval: ToolApproval) => void,
  onArtifact?: (artifact: GeneratedArtifact) => void | Promise<void>,
  onSearchSources?: (value: { provider: string; sources: SearchSource[] }) => void,
): Promise<void> {
  const { signal, ...body } = input;
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw Object.assign(new Error('已由用户中止当前执行。'), { name: 'AbortError' });
    }
    throw error;
  }
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    let message = `Chat request failed: ${response.status}`;
    try {
      const parsed = JSON.parse(detail) as { message?: string; issues?: Array<{ path?: unknown[]; message?: string }> };
      if (parsed.message) message = parsed.message;
      const first = parsed.issues?.[0];
      if (first?.message) message = `${message}: ${first.message}`;
    } catch { /* keep status message */ }
    throw new Error(message);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        throw Object.assign(new Error('已由用户中止当前执行。'), { name: 'AbortError' });
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (isAbortError(error, signal)) {
          throw Object.assign(new Error('已由用户中止当前执行。'), { name: 'AbortError' });
        }
        throw error;
      }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const item of events) {
        if (!item.startsWith('data: ')) continue;
        const event = JSON.parse(item.slice(6)) as {
          type: string;
          text?: string;
          message?: string;
          toolName?: string;
          invocationId?: string;
          progress?: number;
          summary?: string;
          detail?: string;
          ok?: boolean;
          skillId?: string;
          capability?: ToolApproval['capability'];
          modelId?: string;
          runId?: string;
          path?: string;
          provider?: string;
          sources?: SearchSource[];
          reason?: 'user' | 'timeout';
        };
        if (event.type === 'message.delta' && event.text) onDelta(event.text);
        if (event.type === 'tool.started' && event.toolName && event.summary) onToolActivity?.({ invocationId: event.invocationId, toolName: event.toolName, summary: event.summary, detail: event.detail, status: 'running' });
        if (event.type === 'tool.progress' && event.toolName && event.summary) onToolActivity?.({ invocationId: event.invocationId, progress: event.progress, toolName: event.toolName, summary: event.summary, detail: event.detail, status: 'running' });
        if (event.type === 'tool.completed' && event.toolName && event.summary) onToolActivity?.({ invocationId: event.invocationId, toolName: event.toolName, summary: event.summary, detail: event.detail, status: event.ok ? 'completed' : 'failed' });
        if (event.type === 'tool.failed' && event.toolName && event.summary) onToolActivity?.({ invocationId: event.invocationId, toolName: event.toolName, summary: event.summary, detail: event.detail, status: 'failed' });
        if (event.type === 'capability.started' && event.capability && event.summary) onToolActivity?.({ invocationId: event.invocationId, toolName: `model:${event.capability}`, summary: event.summary, status: 'running' });
        if (event.type === 'capability.progress' && event.capability && event.summary) onToolActivity?.({ invocationId: event.invocationId, progress: event.progress, toolName: `model:${event.capability}`, summary: event.summary, status: 'running' });
        if (event.type === 'capability.completed' && event.capability && event.summary) {
          onToolActivity?.({ invocationId: event.invocationId, toolName: `model:${event.capability}`, summary: event.summary, status: event.ok ? 'completed' : 'failed' });
          if (event.modelId) capabilityHealthObserver?.({ capability: event.capability as import('@workmate/contracts').ModelCapability, modelId: event.modelId, ok: event.ok !== false, summary: event.summary });
        }
        if (event.type === 'capability.failed' && event.capability && event.summary) {
          onToolActivity?.({ invocationId: event.invocationId, toolName: `model:${event.capability}`, summary: event.summary, status: 'failed' });
          if (event.modelId) capabilityHealthObserver?.({ capability: event.capability as import('@workmate/contracts').ModelCapability, modelId: event.modelId, ok: false, summary: event.summary });
        }
        if (event.type === 'tool.approval_required' && event.skillId && event.capability && event.summary) onApproval?.({ skillId: event.skillId, capability: event.capability, summary: event.summary });
        if (event.type === 'artifact.created' && event.runId && event.path) await onArtifact?.({ runId: event.runId, path: event.path });
        if (event.type === 'search.sources' && event.provider && event.sources) onSearchSources?.({ provider: event.provider, sources: event.sources });
        if (event.type === 'run.cancelled') {
          throw Object.assign(new Error(event.message || '已中止当前执行。'), {
            name: 'AbortError',
            reason: event.reason || 'user',
          });
        }
        if (event.type === 'run.failed') throw new Error(event.message || 'Model request failed.');
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancelReader);
  }
}

export async function ingestKnowledgeDocument(input: {
  knowledgeBase: KnowledgeBasePayload;
  title: string;
  content?: string;
  fileBase64?: string;
  fileName?: string;
  source?: string;
  model?: { provider: string; baseUrl?: string; chatModel: string; embeddingModel?: string; apiKey: string };
}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/knowledge/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as {
    message?: string;
    chunks?: number;
    backend?: string;
    documentId?: string;
    jobId?: string;
    status?: string;
    indexState?: KnowledgeBasePayload['indexState'];
  };
  if (!response.ok) throw new Error(body.message || `Knowledge ingest failed: ${response.status}`);
  return body as {
    ok: true;
    chunks: number;
    backend: string;
    dataDir?: string;
    documentId?: string;
    jobId?: string;
    status?: string;
    indexState?: KnowledgeBasePayload['indexState'];
  };
}

function knowledgeApiBase() {
  return window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
}

async function postKnowledge<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${knowledgeApiBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error((payload as { message?: string }).message || `Knowledge request failed: ${response.status}`);
  return payload;
}

export type KnowledgeDocumentRow = {
  id: string;
  title: string;
  source?: string;
  chunkCount: number;
  createdAt: number;
  preview: string;
};

export type KnowledgeChunkRow = {
  id: string;
  documentId: string;
  documentTitle: string;
  title: string;
  content: string;
  source?: string;
  createdAt: number;
};

export async function listKnowledgeDocuments(input: {
  knowledgeBase: KnowledgeBasePayload;
}) {
  return postKnowledge<{
    ok: true;
    backend: string;
    dataDir: string;
    documentCount: number;
    chunkCount: number;
    documents: KnowledgeDocumentRow[];
  }>('/api/knowledge/documents', input);
}

export async function listKnowledgeChunks(input: {
  knowledgeBase: KnowledgeBasePayload;
  documentId?: string;
  query?: string;
  offset?: number;
  limit?: number;
}) {
  return postKnowledge<{
    ok: true;
    backend: string;
    total: number;
    offset: number;
    limit: number;
    chunks: KnowledgeChunkRow[];
  }>('/api/knowledge/chunks', input);
}

export async function deleteKnowledgeDocument(input: {
  knowledgeBase: KnowledgeBasePayload;
  documentId: string;
}) {
  return postKnowledge<{ ok: true; removedChunks: number; remainingChunks: number; documentCount: number }>(
    '/api/knowledge/documents/delete',
    input,
  );
}

export async function deleteKnowledgeChunk(input: {
  knowledgeBase: KnowledgeBasePayload;
  chunkId: string;
}) {
  return postKnowledge<{ ok: true; remainingChunks: number; documentCount: number }>(
    '/api/knowledge/chunks/delete',
    input,
  );
}

export async function searchKnowledge(input: {
  knowledgeBase: KnowledgeBasePayload;
  query: string;
  topK?: number;
  model?: { provider: string; baseUrl?: string; chatModel: string; embeddingModel?: string; apiKey: string };
}) {
  return postKnowledge<{
    ok: true;
    results: Array<{ id: string; title: string; content: string; score: number; source?: string; url?: string }>;
  }>('/api/knowledge/search', input);
}

export type OntologyWorkflowPayload = {
  draft: { version: number; nodes: unknown[]; edges: unknown[] };
  published?: { version: number; nodes: unknown[]; edges: unknown[] };
  candidates: Array<{
    id: string;
    kind: 'node' | 'edge';
    node?: { id: string; type: string; name: string; aliases: string[]; properties: Record<string, unknown>; status: string; source?: string };
    edge?: { id: string; subjectId: string; predicate: string; objectId: string; properties: Record<string, unknown>; status: string; source?: string };
    evidence: Array<{ documentId: string; chunkId?: string; quote: string; source?: string }>;
    confidence: number;
    status: string;
    reviewNote?: string;
  }>;
  updatedAt: number;
};

export type OntologyQueryPlanPayload = {
  query: string;
  matchedNodes: Array<{ id: string; type: string; name: string; aliases?: string[]; properties?: Record<string, unknown>; source?: string; status: string; score: number }>;
  relatedNodes: Array<{ id: string; type: string; name: string; aliases?: string[]; properties?: Record<string, unknown>; source?: string; status: string }>;
  edges: Array<{ id: string; subjectId: string; predicate: string; objectId: string; properties?: Record<string, unknown>; source?: string; status: string }>;
  paths: Array<{ nodeIds: string[]; edgeIds: string[]; depth: number }>;
  expandedTerms: string[];
  matchedPredicates: string[];
  filters: Record<string, string>;
  evidenceRefs: Array<{ documentId?: string; chunkId?: string; source?: string; nodeId?: string; edgeId?: string }>;
  constraints: { nodeTypes: string[]; predicates: string[]; properties: Record<string, string | number | boolean>; direction: 'both' | 'out' | 'in'; maxResults: number };
};

export type OntologyHybridSearchPayload = {
  ok: true;
  query: string;
  strategy: 'vector-only' | 'ontology-enhanced';
  plan: OntologyQueryPlanPayload;
  results: Array<{ id: string; title: string; content: string; score: number; source?: string; url?: string; knowledgeBaseId?: string; knowledgeBaseName?: string; provider?: string; retrievalRoutes?: Array<'raw-vector' | 'ontology-vector' | 'ontology-evidence'> }>;
};

export const readOntologyWorkflow = (knowledgeBase: KnowledgeBasePayload) => postKnowledge<{ ok: true; workflow: OntologyWorkflowPayload }>('/api/knowledge/ontology/workflow/read', { knowledgeBase });
export const saveOntologyDraft = (knowledgeBase: KnowledgeBasePayload, graph: unknown) => postKnowledge<{ ok: true; workflow: OntologyWorkflowPayload }>('/api/knowledge/ontology/draft/save', { knowledgeBase, graph });
export const publishOntologyDraft = (knowledgeBase: KnowledgeBasePayload, note?: string, publisher?: string) => postKnowledge<{ ok: true; workflow: OntologyWorkflowPayload }>('/api/knowledge/ontology/draft/publish', { knowledgeBase, note, publisher });
export const importOntologyCandidates = (knowledgeBase: KnowledgeBasePayload, candidates: unknown[]) => postKnowledge<{ ok: true; workflow: OntologyWorkflowPayload }>('/api/knowledge/ontology/candidates/import', { knowledgeBase, candidates });
export const extractOntologyCandidates = (input: {
  knowledgeBase: KnowledgeBasePayload;
  documentIds: string[];
  instructions?: string;
  model: { provider: string; baseUrl?: string; chatModel: string; embeddingModel?: string; apiKey: string };
}) => postKnowledge<{ ok: true; workflow: OntologyWorkflowPayload; generated: number; nodes: number; edges: number; analyzedChunks: number }>('/api/knowledge/ontology/candidates/extract', input);
export const reviewOntologyCandidates = (knowledgeBase: KnowledgeBasePayload, candidateIds: string[], decision: 'accepted' | 'rejected' | 'deferred', note?: string) => postKnowledge<{ ok: true; workflow: OntologyWorkflowPayload }>('/api/knowledge/ontology/candidates/review', { knowledgeBase, candidateIds, decision, note });
export const commitOntologyCandidates = (knowledgeBase: KnowledgeBasePayload) => postKnowledge<{ ok: true; workflow: OntologyWorkflowPayload & { committed?: number } }>('/api/knowledge/ontology/candidates/commit', { knowledgeBase });
export const upsertOntologyCandidate = (knowledgeBase: KnowledgeBasePayload, candidate: unknown) => postKnowledge<{ok:true;workflow:OntologyWorkflowPayload}>('/api/knowledge/ontology/candidates/upsert',{knowledgeBase,candidate});
export const deleteOntologyCandidates = (knowledgeBase: KnowledgeBasePayload, candidateIds:string[]) => postKnowledge<{ok:true;workflow:OntologyWorkflowPayload}>('/api/knowledge/ontology/candidates/delete',{knowledgeBase,candidateIds});
export const mergeOntologyCandidates = (knowledgeBase: KnowledgeBasePayload, sourceCandidateIds:string[], mergedCandidate:unknown) => postKnowledge<{ok:true;workflow:OntologyWorkflowPayload}>('/api/knowledge/ontology/candidates/merge',{knowledgeBase,sourceCandidateIds,mergedCandidate});
export const stageOntologyCandidates = (knowledgeBase: KnowledgeBasePayload) => postKnowledge<{ok:true;workflow:OntologyWorkflowPayload}>('/api/knowledge/ontology/candidates/stage',{knowledgeBase});
export type OntologyPreviewPayload={ok:true;graph:{version:number;nodes:unknown[];edges:unknown[]};summary:{addedNodes:number;modifiedNodes:number;deletedNodes:number;addedEdges:number;modifiedEdges:number;deletedEdges:number};validation:{blockers:string[];warnings:string[]}};
export const previewOntologyChanges=(knowledgeBase:KnowledgeBasePayload)=>postKnowledge<OntologyPreviewPayload>('/api/knowledge/ontology/preview',{knowledgeBase});
export const repairOntologyDraft=(knowledgeBase:KnowledgeBasePayload)=>postKnowledge<{ok:true;workflow:OntologyWorkflowPayload;removedEdgeIds:string[]}>('/api/knowledge/ontology/draft/repair',{knowledgeBase});
export type OntologyGovernanceCommand = {type:'merge_nodes';nodeIds:string[];canonicalId:string;canonicalName:string}|{type:'rename_node';nodeId:string;name:string;keepOldAsAlias:boolean}|{type:'change_node_type';nodeId:string;nodeType:string}|{type:'delete_node';nodeId:string;migrateToNodeId?:string}|{type:'delete_edge';edgeId:string}|{type:'reverse_edge';edgeId:string}|{type:'mark_term';nodeId:string}|{type:'add_edge';edgeId:string;subjectId:string;predicate:string;objectId:string};
export type OntologyGovernanceIssue={id:string;category:'duplicate_node'|'naming'|'isolated_node'|'orphan_edge'|'self_loop'|'duplicate_edge';severity:'blocker'|'warning';title:string;description:string;nodeIds:string[];edgeIds:string[];suggestedCommands:OntologyGovernanceCommand[]};
export type OntologyGovernancePayload={ok:true;graph:{version:number;nodes:unknown[];edges:unknown[]};issues:OntologyGovernanceIssue[];operations:Array<{id:string;commands:OntologyGovernanceCommand[];source:string;actor?:string;createdAt:number;undoneAt?:number}>};
export const readOntologyGovernance=(knowledgeBase:KnowledgeBasePayload)=>postKnowledge<OntologyGovernancePayload>('/api/knowledge/ontology/governance/read',{knowledgeBase});
export const applyOntologyGovernance=(knowledgeBase:KnowledgeBasePayload,commands:OntologyGovernanceCommand[],source:'manual'|'rule'|'ai'='manual',actor='管理员')=>postKnowledge<{ok:true;workflow:OntologyWorkflowPayload;operationId:string;issues:OntologyGovernanceIssue[]}>('/api/knowledge/ontology/governance/apply',{knowledgeBase,commands,source,actor});
export const undoOntologyGovernance=(knowledgeBase:KnowledgeBasePayload)=>postKnowledge<{ok:true;workflow:OntologyWorkflowPayload;issues:OntologyGovernanceIssue[]}>('/api/knowledge/ontology/governance/undo',{knowledgeBase});
export type OntologyGovernanceSuggestion={issueId:string;confidence:number;reason:string;commands:OntologyGovernanceCommand[]};
export const suggestOntologyGovernance=(knowledgeBase:KnowledgeBasePayload,model:{provider:string;baseUrl?:string;chatModel:string;embeddingModel?:string;apiKey:string},issueIds:string[]=[])=>postKnowledge<{ok:true;suggestions:OntologyGovernanceSuggestion[]}>('/api/knowledge/ontology/governance/suggest',{knowledgeBase,model,issueIds});
export type OntologyVersionPayload={version:number;graph:{version:number;nodes:unknown[];edges:unknown[]};publishedAt:number;note?:string;publisher?:string};
export const listOntologyVersions=(knowledgeBase:KnowledgeBasePayload)=>postKnowledge<{ok:true;versions:OntologyVersionPayload[]}>('/api/knowledge/ontology/versions',{knowledgeBase});
export const rollbackOntologyVersion=(knowledgeBase:KnowledgeBasePayload,version:number)=>postKnowledge<{ok:true;workflow:OntologyWorkflowPayload}>('/api/knowledge/ontology/versions/rollback',{knowledgeBase,version});
export const startOntologyAnalysis=(input:{knowledgeBase:KnowledgeBasePayload;documentIds:string[];instructions?:string;model:{provider:string;baseUrl?:string;chatModel:string;embeddingModel?:string;apiKey:string};intensity:'quick'|'standard'|'deep'})=>postKnowledge<{ok:true;jobId:string}>('/api/knowledge/ontology/analysis/start',input);
export type OntologyAnalysisJob={id:string;status:'running'|'completed'|'failed'|'cancelled';startedAt:number;completedAt?:number;phase:string;currentBatch:number;totalBatches:number;discovered?:number;result?:{workflow:OntologyWorkflowPayload;generated:number;nodes:number;edges:number;analyzedChunks:number};error?:string};
export const getOntologyAnalysisStatus=(jobId:string)=>postKnowledge<{ok:true;job:OntologyAnalysisJob}>('/api/knowledge/ontology/analysis/status',{jobId});
export const cancelOntologyAnalysis=(jobId:string)=>postKnowledge<{ok:true}>('/api/knowledge/ontology/analysis/cancel',{jobId});
export const queryOntology = (knowledgeBase: KnowledgeBasePayload, query: string, maxHops = 2) => postKnowledge<{ ok: true; plan: OntologyQueryPlanPayload }>('/api/knowledge/ontology/query', { knowledgeBase, query, maxHops });
export const searchKnowledgeWithOntology = (input: { knowledgeBase: KnowledgeBasePayload; query: string; topK?: number; model?: { provider: string; baseUrl?: string; chatModel: string; embeddingModel?: string; apiKey: string } }) => postKnowledge<OntologyHybridSearchPayload>('/api/knowledge/hybrid-search', input);

export async function listBailianPipelines(input: {
  apiKey: string;
  baseUrl?: string;
  workspaceId?: string;
}) {
  return postKnowledge<{
    ok: true;
    pipelines: Array<{ id: string; name: string; workspaceId: string; docNum: number }>;
  }>('/api/knowledge/bailian/pipelines', input);
}

export async function createBailianKnowledge(input: {
  accessKeyId: string;
  accessKeySecret: string;
  workspaceId: string;
  name: string;
  description?: string;
  embeddingModelName?: string;
}) {
  return postKnowledge<{
    ok: true;
    indexId: string;
    categoryId: string;
    workspaceId: string;
    name: string;
  }>('/api/knowledge/bailian/create', input);
}

export async function deleteBailianKnowledge(input: {
  accessKeyId: string;
  accessKeySecret: string;
  workspaceId: string;
  indexId: string;
}) {
  return postKnowledge<{ ok: true }>('/api/knowledge/bailian/delete', input);
}

export async function listBailianIndices(input: {
  accessKeyId: string;
  accessKeySecret: string;
  workspaceId: string;
  pageNumber?: number;
  pageSize?: number;
  indexName?: string;
}) {
  return postKnowledge<{
    ok: true;
    indices: Array<{ id: string; name: string; description: string; documentCount: number; categoryId?: string }>;
  }>('/api/knowledge/bailian/list', input);
}

export async function getKnowledgeJobStatus(input: {
  knowledgeBase: KnowledgeBasePayload;
  jobId: string;
}) {
  return postKnowledge<{
    ok: true;
    jobId: string;
    status: string;
    message?: string;
  }>('/api/knowledge/job-status', input);
}

export async function deleteRemoteKnowledgeBase(input: {
  knowledgeBase: KnowledgeBasePayload;
}) {
  return postKnowledge<{ ok: true }>('/api/knowledge/delete-remote', input);
}

export async function testMcpConnection(connection: McpConnectionPayload, timeoutMs = 25_000) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/mcp/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connection, timeoutMs }),
  });
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    toolCount?: number;
    toolNames?: string[];
    tools?: Array<{ name?: string; description?: string }>;
    durationMs?: number;
    error?: string;
    message?: string;
  };
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || body.message || `MCP test failed: ${response.status}`);
  }
  const tools = Array.isArray(body.tools)
    ? body.tools
        .map((item) => {
          const name = String(item?.name || '').trim();
          if (!name) return null;
          const description = item?.description ? String(item.description).slice(0, 400) : undefined;
          return { name, ...(description ? { description } : {}) };
        })
        .filter((item): item is { name: string; description?: string } => Boolean(item))
    : (Array.isArray(body.toolNames) ? body.toolNames.map((name) => ({ name: String(name) })) : []);
  return {
    ok: true as const,
    toolCount: Number(body.toolCount) || tools.length,
    toolNames: tools.map((item) => item.name),
    tools,
    durationMs: Number(body.durationMs) || 0,
  };
}

export async function testProviderConnection(input: {
  type: string;
  baseUrl?: string;
  workspaceId?: string;
  service?: string;
  apiKey?: string;
}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/providers/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; message?: string };
  if (!response.ok || body.ok === false) throw new Error(body.message || `Provider test failed: ${response.status}`);
  return { ok: true as const, message: body.message || '连接成功。' };
}

export async function testEmbeddingConnection(input: {
  type: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/providers/test-embedding`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    status?: 'healthy' | 'degraded' | 'unreachable' | 'unauthorized' | 'misconfigured';
    checkedAt?: number;
    latencyMs?: number;
    modelReachable?: boolean;
    message?: string;
    code?: string | null;
    detail?: Record<string, number>;
  };
  if (!response.ok || body.ok === false) {
    const error = new Error(body.message || `Embedding provider test failed: ${response.status}`) as Error & {
      status?: string;
      code?: string | null;
      detail?: Record<string, number>;
    };
    error.status = body.status;
    error.code = body.code;
    error.detail = body.detail;
    throw error;
  }
  return {
    ok: true as const,
    status: body.status || 'healthy',
    checkedAt: Number(body.checkedAt) || Date.now(),
    latencyMs: Number(body.latencyMs) || 0,
    modelReachable: Boolean(body.modelReachable),
    message: body.message || 'Embedding 连接成功。',
    code: body.code || null,
    detail: body.detail || {},
  };
}

export async function testConfiguredModelCapability(input: Record<string, unknown>) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/providers/test-model-capability`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; latencyMs?: number; result?: Record<string, unknown>; media?: { mimeType: string; base64: string }; message?: string };
  if (!response.ok || body.ok === false) throw Object.assign(new Error(body.message || `Model test failed: ${response.status}`), { latencyMs: body.latencyMs });
  return { ok: true as const, latencyMs: Number(body.latencyMs || 0), result: body.result || {}, media: body.media };
}

export async function testDecisionRuntime(input: Record<string, unknown>) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/providers/test-decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; latencyMs?: number; error?: string; message?: string };
  if (!response.ok || body.ok === false) throw new Error(body.error || body.message || `Decision test failed: ${response.status}`);
  return body;
}

export async function listProviderModels(input: {
  type: string;
  baseUrl?: string;
  workspaceId?: string;
  apiKey?: string;
}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/providers/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { models?: unknown[]; message?: string };
  if (!response.ok) throw new Error(body.message || `List provider models failed: ${response.status}`);
  return Array.isArray(body.models) ? body.models.map((item) => String(item || '')).filter(Boolean) : [];
}

export async function pullOllamaModel(input: {
  baseUrl?: string;
  modelName: string;
}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/providers/ollama/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; status?: string; message?: string };
  if (!response.ok || body.ok === false) throw new Error(body.message || `Ollama pull failed: ${response.status}`);
  return body.status || 'success';
}

export async function discoverSkills(query: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/skills/discover?${new URLSearchParams({ q: query })}`);
  const body = await response.json().catch(() => ({})) as {
    items?: Array<{ reference?: string; source?: string; slug?: string; name?: string; description?: string; installs?: string; url?: string }>;
    hasMore?: boolean;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Skill discovery failed: ${response.status}`);
  return {
    items: Array.isArray(body.items) ? body.items.map((item) => ({
      reference: String(item.reference || ''),
      source: String(item.source || ''),
      slug: String(item.slug || ''),
      name: String(item.name || ''),
      description: String(item.description || ''),
      installs: String(item.installs || ''),
      url: String(item.url || ''),
    })) : [],
    hasMore: Boolean(body.hasMore),
  };
}

export async function installSkillPackage(reference: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/skills/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reference }),
  });
  const body = await response.json().catch(() => ({})) as {
    manifest?: { path?: string; content?: string } | null;
    output?: string;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Skill install failed: ${response.status}`);
  return {
    output: String(body.output || ''),
    manifest: body.manifest && typeof body.manifest === 'object'
      ? {
        path: String(body.manifest.path || ''),
        content: String(body.manifest.content || ''),
      }
      : null,
  };
}

export async function importGitSkill(url: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/skills/import-git`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const body = await response.json().catch(() => ({})) as {
    manifests?: Array<{ path?: string; content?: string }>;
    skipped?: string[];
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Skill git import failed: ${response.status}`);
  return {
    manifests: Array.isArray(body.manifests)
      ? body.manifests.map((item) => ({
        path: String(item.path || ''),
        content: String(item.content || ''),
      }))
      : [],
    skipped: Array.isArray(body.skipped) ? body.skipped.map((item) => String(item || '')) : [],
  };
}

export async function importSkillZip(input: { filename: string; base64: string }) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/skills/import-zip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as {
    manifest?: { path?: string; content?: string } | null;
    importedFiles?: number;
    source?: string;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Skill zip import failed: ${response.status}`);
  return {
    manifest: body.manifest && typeof body.manifest === 'object'
      ? { path: String(body.manifest.path || ''), content: String(body.manifest.content || '') }
      : null,
    importedFiles: Number(body.importedFiles || 0),
    source: String(body.source || input.filename),
  };
}

export async function listSkillFiles(root: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/skills/files?${new URLSearchParams({ root })}`);
  const body = await response.json().catch(() => ({})) as {
    items?: Array<{ path?: string; relative?: string; type?: 'directory' | 'file' }>;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Skill file list failed: ${response.status}`);
  return Array.isArray(body.items)
    ? body.items.map((item) => ({
      path: String(item?.path || ''),
      relative: String(item?.relative || ''),
      type: item?.type === 'directory' ? 'directory' as const : 'file' as const,
    }))
    : [];
}

export async function readSkillFile(path: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/skills/file?${new URLSearchParams({ path })}`);
  const body = await response.json().catch(() => ({})) as { path?: string; content?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `Skill read failed: ${response.status}`);
  return { path: String(body.path || path), content: String(body.content || '') };
}

export async function writeSkillFile(input: { path: string; content: string }) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/skills/file`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { path?: string; content?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `Skill write failed: ${response.status}`);
  return { path: String(body.path || input.path), content: String(body.content || input.content) };
}

export async function writeSkillDraft(input: { name: string; content: string }) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/skills/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { path?: string; content?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `Skill draft save failed: ${response.status}`);
  return { path: String(body.path || ''), content: String(body.content || '') };
}

export async function deleteManagedSkill(path: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/skills?${new URLSearchParams({ path })}`, { method: 'DELETE' });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; message?: string };
  if (!response.ok) throw new Error(body.message || `Skill delete failed: ${response.status}`);
  return Boolean(body.ok);
}

export async function createManagedWorkspace(name: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/workspace/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = await response.json().catch(() => ({})) as { root?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `Workspace create failed: ${response.status}`);
  return String(body.root || '');
}

export async function listWorkspaceFiles(root: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/workspace/files?${new URLSearchParams({ root })}`);
  const body = await response.json().catch(() => ([])) as Array<{ relative?: string; type?: 'directory' | 'file' }> | { message?: string };
  if (!response.ok || !Array.isArray(body)) throw new Error((body as { message?: string }).message || `Workspace files failed: ${response.status}`);
  return body.map((item): { relative: string; type: 'directory' | 'file' } => ({
    relative: String(item.relative || ''),
    type: item.type === 'directory' ? 'directory' : 'file',
  }));
}

export async function readWorkspaceFile(root: string, relative: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/workspace/file?${new URLSearchParams({ root, relative })}`);
  const body = await response.json().catch(() => ({})) as { relative?: string; content?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `Workspace file read failed: ${response.status}`);
  return { relative: String(body.relative || relative), content: String(body.content || '') };
}

export async function writeWorkspaceFile(root: string, relative: string, content: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/workspace/file`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root, relative, content }),
  });
  const body = await response.json().catch(() => ({})) as { relative?: string; content?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `Workspace file write failed: ${response.status}`);
  return { relative: String(body.relative || relative), content: String(body.content || '') };
}

export async function uploadRecording(file: File): Promise<{ reference: string; name: string; size: number }> {
  if (!file.size || file.size > 25 * 1024 * 1024) throw new Error('录音文件必须非空且不超过25 MB。');
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('录音文件读取失败。'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(file);
  });
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/workspace/audio-input`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(getStoredSessionToken() ? { Authorization: `Bearer ${getStoredSessionToken()}` } : {}) },
    body: JSON.stringify({ name: file.name, base64 }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || '录音上传失败。');
  return body;
}

export async function readWorkspaceInfo(root: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/workspace/info?${new URLSearchParams({ root })}`);
  const body = await response.json().catch(() => ({})) as {
    version?: number;
    kind?: 'static-site' | 'files';
    entrypoint?: string | null;
    updatedAt?: number;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Workspace info failed: ${response.status}`);
  return {
    version: Number(body.version || 1),
    kind: body.kind === 'static-site' ? 'static-site' as const : 'files' as const,
    entrypoint: body.entrypoint ? String(body.entrypoint) : null,
    updatedAt: Number(body.updatedAt || 0),
  };
}

const workspaceSyncRequests = createRequestCoalescer<Array<{ relative: string; type: 'directory' | 'file' }>>(3_000);
let workspaceSyncScope: string | null | undefined;
export function syncWorkspaceRun(root: string, runId: string) {
  const scope = getStoredSessionToken();
  if (scope !== workspaceSyncScope) { workspaceSyncRequests.clear(); workspaceSyncScope = scope; }
  return workspaceSyncRequests.run(JSON.stringify([root, runId]), () => syncWorkspaceRunOnce(root, runId));
}

async function syncWorkspaceRunOnce(root: string, runId: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/workspace/sync-run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root, runId }),
  });
  const body = await response.json().catch(() => ([])) as Array<{ relative?: string; type?: 'directory' | 'file' }> | { message?: string };
  if (!response.ok || !Array.isArray(body)) throw new Error((body as { message?: string }).message || `Workspace sync failed: ${response.status}`);
  return body.map((item): { relative: string; type: 'directory' | 'file' } => ({
    relative: String(item.relative || ''),
    type: item.type === 'directory' ? 'directory' : 'file',
  }));
}

export async function normalizeWorkspaceLayout(root: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/workspace/normalize-layout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root }),
  });
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    moved?: Array<{ from?: string; to?: string }>;
    conflicts?: Array<{ from?: string; to?: string }>;
    entrypoint?: string | null;
    files?: Array<{ relative?: string; type?: 'directory' | 'file' }>;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Workspace normalization failed: ${response.status}`);
  return {
    ok: Boolean(body.ok),
    moved: (body.moved ?? []).map((item) => ({ from: String(item.from || ''), to: String(item.to || '') })),
    conflicts: (body.conflicts ?? []).map((item) => ({ from: String(item.from || ''), to: String(item.to || '') })),
    entrypoint: body.entrypoint ? String(body.entrypoint) : null,
    files: (body.files ?? []).map((item) => ({
      relative: String(item.relative || ''),
      type: item.type === 'directory' ? 'directory' as const : 'file' as const,
    })),
  };
}

export async function materializeWorkspaceAssets(root: string, items: Array<{ assetId?: string; relativePath?: string; name?: string }>) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/workspace/materialize-assets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root, items }),
  });
  const body = await response.json().catch(() => ([])) as Array<{ relative?: string; type?: 'directory' | 'file' }> | { message?: string };
  if (!response.ok || !Array.isArray(body)) throw new Error((body as { message?: string }).message || `Workspace materialize failed: ${response.status}`);
  return body.map((item): { relative: string; type: 'directory' | 'file' } => ({
    relative: String(item.relative || ''),
    type: item.type === 'directory' ? 'directory' : 'file',
  }));
}

export async function importWorkspaceZip(input: { root: string; filename: string; base64: string }) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/workspace/import-zip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    source?: string;
    importedFiles?: number;
    files?: Array<{ relative?: string; type?: 'directory' | 'file' }>;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Workspace zip import failed: ${response.status}`);
  return {
    ok: Boolean(body.ok),
    source: String(body.source || input.filename),
    importedFiles: Number(body.importedFiles || 0),
    files: Array.isArray(body.files) ? body.files.map((item) => ({
      relative: String(item.relative || ''),
      type: item.type === 'directory' ? 'directory' as const : 'file' as const,
    })) : [],
  };
}

export async function exportWorkspaceZip(root: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/workspace/export-zip?${new URLSearchParams({ root })}`);
  const body = await response.json().catch(() => ({})) as { ok?: boolean; filename?: string; base64?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `Workspace zip export failed: ${response.status}`);
  return {
    ok: Boolean(body.ok),
    filename: String(body.filename || 'workspace.zip'),
    base64: String(body.base64 || ''),
  };
}

export async function readWorkspacePreview(root: string, relative: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/workspace/preview?${new URLSearchParams({ root, relative })}`);
  const body = await response.json().catch(() => ({})) as {
    kind?: 'text' | 'binary';
    name?: string;
    relative?: string;
    content?: string;
    base64?: string;
    bytes?: number;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Workspace preview failed: ${response.status}`);
  return {
    kind: (body.kind === 'binary' ? 'binary' : 'text') as 'text' | 'binary',
    name: String(body.name || ''),
    relative: body.relative ? String(body.relative) : undefined,
    content: typeof body.content === 'string' ? body.content : undefined,
    base64: typeof body.base64 === 'string' ? body.base64 : undefined,
    bytes: Number(body.bytes || 0),
  };
}

export interface AssetPayload {
  id: string;
  name: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  orgId?: string | null;
  ownerUserId?: string | null;
  userId?: string | null;
  accessScope?: 'private' | 'org-shared' | 'delegated';
  accessGrants?: Array<{
    subjectType: 'user';
    subjectId: string;
    permissions: Array<'read' | 'write'>;
    createdAt: number;
    expiresAt?: number;
  }>;
  conversationId: string | null;
  employeeId: string | null;
  runId: string;
  sha256: string;
  projectId: string | null;
  workspaceRelative: string | null;
  kind?: 'file' | 'bundle';
  entryPath?: string | null;
  manifest?: {
    version: number;
    entryPath: string;
    files: Array<{ path: string; bytes: number; sha256: string; mimeType: string }>;
  } | null;
}

function normalizeAsset(item: Partial<AssetPayload>): AssetPayload {
  return {
    id: String(item.id || ''),
    name: String(item.name || ''),
    relativePath: String(item.relativePath || ''),
    mimeType: String(item.mimeType || ''),
    sizeBytes: Number(item.sizeBytes || 0),
    createdAt: Number(item.createdAt || 0),
    orgId: item.orgId ? String(item.orgId) : null,
    ownerUserId: item.ownerUserId ? String(item.ownerUserId) : (item.userId ? String(item.userId) : null),
    userId: item.userId ? String(item.userId) : (item.ownerUserId ? String(item.ownerUserId) : null),
    accessScope: item.accessScope === 'org-shared' || item.accessScope === 'delegated' ? item.accessScope : 'private',
    accessGrants: Array.isArray(item.accessGrants) ? item.accessGrants : [],
    conversationId: item.conversationId ? String(item.conversationId) : null,
    employeeId: item.employeeId ? String(item.employeeId) : null,
    runId: String(item.runId || ''),
    sha256: String(item.sha256 || ''),
    projectId: item.projectId ? String(item.projectId) : null,
    workspaceRelative: item.workspaceRelative ? String(item.workspaceRelative) : null,
    kind: item.kind === 'bundle' ? 'bundle' : 'file',
    entryPath: item.entryPath ? String(item.entryPath) : null,
    manifest: item.manifest && typeof item.manifest === 'object' ? item.manifest : null,
  };
}

export async function listArchivedAssets() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/assets`);
  const body = await response.json().catch(() => ([])) as Array<Partial<AssetPayload>> | { message?: string };
  if (!response.ok || !Array.isArray(body)) throw new Error((body as { message?: string }).message || `Assets list failed: ${response.status}`);
  return body.map((item) => normalizeAsset(item));
}

export async function importChatAttachmentToAssets(sessionId: string, attachmentId: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/assets/import-chat-attachment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, attachmentId }) });
  const body = await response.json().catch(() => ({})) as { id?: string; name?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `保存资产失败：${response.status}`);
  return body;
}

export async function archiveWorkspaceArtifact(input: {
  runId: string;
  relativePath: string;
  conversationId?: string;
  employeeId?: string;
  projectId?: string;
}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/assets/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as Partial<AssetPayload> & { message?: string };
  if (!response.ok) throw new Error(body.message || `Asset archive failed: ${response.status}`);
  return normalizeAsset(body);
}

export async function archiveWorkspaceBundle(input: { runId: string; conversationId?: string; employeeId?: string; projectId?: string }) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/assets/archive-bundle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const body = await response.json().catch(() => ({})) as Partial<AssetPayload> & { message?: string };
  if (!response.ok) throw new Error(body.message || `Bundle archive failed: ${response.status}`);
  return normalizeAsset(body);
}

export type SiteDeployServer = {
  id: string;
  url: string;
  localUrl?: string;
  lanUrls?: string[];
  access?: 'local' | 'lan';
  port: number;
  assetId?: string;
};

export async function startAssetSiteDeploy(input: { assetId?: string; projectId?: string; access?: 'local' | 'lan' }) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/assets/site-deploy/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assetId: input.assetId,
      projectId: input.projectId,
      access: input.access ?? 'lan',
    }),
  });
  const body = await response.json().catch(() => ({})) as SiteDeployServer & { ok?: boolean; message?: string };
  if (!response.ok || body.ok === false) throw new Error(body.message || `Site deploy failed: ${response.status}`);
  return body;
}

export async function stopAssetSiteDeploy(input: { assetId?: string; projectId?: string }) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/assets/site-deploy/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assetId: input.assetId, projectId: input.projectId }),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; stopped?: number; message?: string };
  if (!response.ok) throw new Error(body.message || `Stop site deploy failed: ${response.status}`);
  return body;
}

export async function assetSiteDeployStatus(input: { assetId?: string; projectId?: string }) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const params = new URLSearchParams();
  if (input.assetId) params.set('assetId', input.assetId);
  if (input.projectId) params.set('projectId', input.projectId);
  const response = await fetch(`${apiBase}/api/assets/site-deploy/status?${params.toString()}`);
  const body = await response.json().catch(() => ({})) as { ok?: boolean; servers?: SiteDeployServer[]; message?: string };
  if (!response.ok) throw new Error(body.message || `Site deploy status failed: ${response.status}`);
  return Array.isArray(body.servers) ? body.servers : [];
}

export function archivedBundleContentUrl(assetId: string, relativePath = '') {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  return `${apiBase}/api/assets/bundle/${encodeURIComponent(assetId)}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

export async function linkArchivedAssets(input: { projectId: string; assetIds: string[]; workspacePath?: string }) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/assets/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { updated?: number; copied?: number; projectId?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `Asset link failed: ${response.status}`);
  return {
    updated: Number(body.updated || 0),
    copied: Number(body.copied || 0),
    projectId: String(body.projectId || input.projectId),
  };
}

export async function unlinkArchivedAssets(assetIds: string[]) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/assets/unlink`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assetIds }),
  });
  const body = await response.json().catch(() => ({})) as { updated?: number; message?: string };
  if (!response.ok) throw new Error(body.message || `Asset unlink failed: ${response.status}`);
  return { updated: Number(body.updated || 0) };
}

export async function deleteArchivedAssets(assetIds: string[]) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/assets/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assetIds }),
  });
  const body = await response.json().catch(() => ({})) as { deleted?: number; message?: string };
  if (!response.ok) throw new Error(body.message || `Asset delete failed: ${response.status}`);
  return { deleted: Number(body.deleted || 0) };
}

export async function readArchivedAssetPreview(assetId: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${apiBase}/api/assets/preview?${new URLSearchParams({ assetId })}`);
  const body = await response.json().catch(() => ({})) as {
    kind?: 'text' | 'binary';
    name?: string;
    content?: string;
    base64?: string;
    bytes?: number;
    mimeType?: string;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Asset preview failed: ${response.status}`);
  return {
    kind: (body.kind === 'binary' ? 'binary' : 'text') as 'text' | 'binary',
    name: String(body.name || ''),
    content: typeof body.content === 'string' ? body.content : undefined,
    base64: typeof body.base64 === 'string' ? body.base64 : undefined,
    bytes: Number(body.bytes || 0),
    mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined,
  };
}

export function workspaceContentUrl(root: string, relative: string, options: { download?: boolean } = {}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const params = new URLSearchParams({ root, relative, ...(options.download ? { download: '1' } : {}) });
  return `${apiBase}/api/workspace/content?${params.toString()}`;
}

export function archivedAssetContentUrl(assetId: string, options: { download?: boolean } = {}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const params = new URLSearchParams({ assetId, ...(options.download ? { download: '1' } : {}) });
  return `${apiBase}/api/assets/content?${params.toString()}`;
}

/**
 * Load protected asset media through the authenticated fetch wrapper. Native
 * img/audio/video requests cannot attach Workmate's session header.
 */
export async function loadArchivedAssetContentUrl(assetId: string, signal?: AbortSignal) {
  const response = await fetch(archivedAssetContentUrl(assetId), { signal });
  if (!response.ok) throw new Error(`Asset media failed: ${response.status}`);
  return URL.createObjectURL(await response.blob());
}

export type { DataColumn } from '@workmate/contracts';
import type { DataColumn } from '@workmate/contracts';
export type DataTable = import('@workmate/contracts').DataResource;
export type DataApiConnection = {
  baseUrl: string;
  path: string;
  method: 'GET' | 'POST';
  authType: 'none' | 'bearer' | 'header';
  authHeaderName: string;
  hasToken: boolean;
  headers: Record<string, string>;
  itemsPath: string;
  description: string;
  requestBody: string;
  responseBody: string;
  lastSyncedAt: number | null;
  lastStatus: string;
  lastError: string;
};
export type DataSource = {
  accessMode?: 'live' | 'snapshot' | 'local';
  liveConnection?: import('@workmate/contracts').LiveDataObjectInfo;
  id: string;
  name: string;
  assetId: string;
  fileType: string;
  tableCount: number;
  rowCount: number;
  summary: string;
  createdAt: number;
  annotations: import('@workmate/contracts').DataObjectAnnotations;
  isDefault?: boolean;
  tables?: DataTable[];
  api?: DataApiConnection | null;
  databaseConnection?: import('@workmate/contracts').RemoteDatabasePublicConnection;
  syncError?: string;
};
export type DataApiSourceInput = {
  name: string;
  baseUrl: string;
  path?: string;
  method?: 'GET' | 'POST';
  authType?: 'none' | 'bearer' | 'header';
  authHeaderName?: string;
  authToken?: string;
  headers?: Record<string, string>;
  itemsPath?: string;
  description?: string;
  requestBody?: string;
  responseBody?: string;
  syncNow?: boolean;
};
export type DataRecord = { id: string; values: Record<string, string> };
export type DataApp = {
  queryMode?: 'managed-readonly';
  queryState?: { verifiedCount: number };
  id: string; name: string; appType: '管理后台' | '数据看板' | '查询网站' | '自定义应用'; sourceId: string; tableId: string; createdAt: number;
  published?: boolean; publishUrl?: string | null; lanUrl?: string | null; lanUrls?: string[];
  customSite?: { bound: boolean; updatedAt: number | null; bytes: number };
  delivery?: DataAppDelivery;
  projectId?: string;
};
export type DataAppDetail = DataApp & { table: { id: string; name: string; rowCount: number; columns: DataColumn[] }; records: DataRecord[] };

function dataApiBase() { return window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : ''; }

async function databaseRequest<T>(url: string, input: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100_000);
  try {
    const response = await fetch(`${dataApiBase()}/api${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || '数据库请求失败。');
    return body as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('连接请求超时，请检查数据库网络后重试。');
    throw error;
  } finally { clearTimeout(timer); }
}
export function inspectDatabaseConnection(connection: import('@workmate/contracts').RemoteDatabaseConnection) {
  return databaseRequest<{ databases: string[]; tables: Array<{ schema: string; name: string; description: string }> }>('/data/databases/inspect', connection);
}
export function importDatabaseObject(input: import('@workmate/contracts').RemoteDatabaseImport) {
  return databaseRequest<DataSource>('/data/sources/database', input);
}
export function refreshDatabaseObject(sourceId: string, password: string) {
  return databaseRequest<DataSource>(`/data/sources/${encodeURIComponent(sourceId)}/database-refresh`, { password });
}

export async function listDataSources() {
  const response = await fetch(`${dataApiBase()}/api/data/sources`);
  const body = await response.json().catch(() => ([])) as DataSource[] | { message?: string };
  if (!response.ok || !Array.isArray(body)) throw new Error((body as { message?: string }).message || `Data sources failed: ${response.status}`);
  return body;
}

export async function listDataApps(sourceId?: string) {
  const query = sourceId ? `?${new URLSearchParams({ sourceId }).toString()}` : '';
  const response = await fetch(`${dataApiBase()}/api/data/apps${query}`);
  const body = await response.json().catch(() => ([])) as DataApp[] | { message?: string };
  if (!response.ok || !Array.isArray(body)) throw new Error((body as { message?: string }).message || `Data apps failed: ${response.status}`);
  return body;
}

export async function getDataSource(sourceId: string) {
  const response = await fetch(`${dataApiBase()}/api/data/sources/${encodeURIComponent(sourceId)}`);
  const body = await response.json().catch(() => ({})) as DataSource & { message?: string };
  if (!response.ok) throw new Error(body.message || `Data source failed: ${response.status}`);
  return body;
}

export async function updateDataObjectAnnotations(sourceId: string, annotations: import('@workmate/contracts').DataObjectAnnotations) {
  const response = await fetch(`${dataApiBase()}/api/data/sources/${encodeURIComponent(sourceId)}/annotations`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(annotations),
  });
  const body = await response.json() as DataSource & { message?: string };
  if (!response.ok) throw new Error(body.message || '数据对象说明保存失败。');
  return body;
}

export async function getDataObjectSchema(sourceId: string) {
  const response = await fetch(`${dataApiBase()}/api/data/gateway/schema?sourceId=${encodeURIComponent(sourceId)}`);
  const body = await response.json() as import('@workmate/contracts').DataObjectModelSchema & { message?: string };
  if (!response.ok) throw new Error(body.message || '读取数据对象 Schema 失败。');
  return body;
}

export async function renameDataSource(sourceId: string, name: string) {
  const response = await fetch(`${dataApiBase()}/api/data/sources/${encodeURIComponent(sourceId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = await response.json().catch(() => ({})) as DataSource & { message?: string };
  if (!response.ok) throw new Error(body.message || `Rename data source failed: ${response.status}`);
  return body;
}

export async function deleteDataSource(sourceId: string) {
  const response = await fetch(`${dataApiBase()}/api/data/sources/${encodeURIComponent(sourceId)}`, { method: 'DELETE' });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; message?: string };
  if (!response.ok) throw new Error(body.message || `Delete data source failed: ${response.status}`);
  return body;
}

export async function importDataFile(input: { name: string; contentBase64: string }) {
  const response = await fetch(`${dataApiBase()}/api/data/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as DataSource & { message?: string };
  if (!response.ok) throw new Error(body.message || `Data import failed: ${response.status}`);
  return body;
}

export async function importDataFromAsset(assetId: string) {
  const response = await fetch(`${dataApiBase()}/api/data/import-from-asset`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetId }),
  });
  const body = await response.json().catch(() => ({})) as DataSource & { message?: string };
  if (!response.ok) throw new Error(body.message || `Import from asset failed: ${response.status}`);
  return body;
}

export async function importDataFromWorkspace(input: { projectId: string; relative: string }) {
  const response = await fetch(`${dataApiBase()}/api/data/import-from-workspace`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as DataSource & { message?: string };
  if (!response.ok) throw new Error(body.message || `Import from workspace failed: ${response.status}`);
  return body;
}

export async function createMobileDataUploadSession() {
  const response = await fetch(`${dataApiBase()}/api/data/mobile-upload-session`, { method: 'POST' });
  const body = await response.json().catch(() => ({})) as { url?: string; lanUrls?: string[]; expiresAt?: number; message?: string };
  if (!response.ok || !body.url) throw new Error(body.message || `Create mobile upload session failed: ${response.status}`);
  return { url: body.url, lanUrls: Array.isArray(body.lanUrls) ? body.lanUrls : [], expiresAt: Number(body.expiresAt || 0) };
}

export async function createMobileChatSession(sessionId: string) {
  const response = await fetch(`${dataApiBase()}/api/chat/mobile-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  const body = await response.json().catch(() => ({})) as {
    token?: string;
    url?: string;
    lanUrls?: string[];
    expiresAt?: number;
    sessionId?: string;
    managedTls?: boolean;
    caUrl?: string;
    message?: string;
  };
  if (!response.ok || !body.url || !body.token) throw new Error(body.message || `Create mobile chat session failed: ${response.status}`);
  return {
    token: body.token,
    url: body.url,
    lanUrls: Array.isArray(body.lanUrls) ? body.lanUrls : [],
    expiresAt: Number(body.expiresAt || 0),
    sessionId: String(body.sessionId || sessionId),
    managedTls: body.managedTls === true,
    caUrl: String(body.caUrl || ''),
  };
}

export async function getMobileChatSession(token: string) {
  const response = await fetch(`${dataApiBase()}/api/chat/mobile-session/${encodeURIComponent(token)}`);
  const body = await response.json().catch(() => ({})) as {
    sessionId?: string;
    title?: string;
    expiresAt?: number;
    message?: string;
  };
  if (!response.ok || !body.sessionId) throw new Error(body.message || `Mobile chat session status failed: ${response.status}`);
  return {
    sessionId: body.sessionId,
    title: String(body.title || '对话'),
    expiresAt: Number(body.expiresAt || 0),
  };
}

export async function createSqliteDataSource(name: string) {
  const response = await fetch(`${dataApiBase()}/api/data/sources/sqlite`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });
  const body = await response.json().catch(() => ({})) as DataSource & { message?: string };
  if (!response.ok) throw new Error(body.message || `Create SQLite source failed: ${response.status}`);
  return body;
}

export async function createApiDataSource(input: DataApiSourceInput) {
  const response = await fetch(`${dataApiBase()}/api/data/sources/api`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as DataSource & { message?: string };
  if (!response.ok) throw new Error(body.message || `Create API source failed: ${response.status}`);
  return body;
}

export async function updateApiDataSource(sourceId: string, input: DataApiSourceInput) {
  const response = await fetch(`${dataApiBase()}/api/data/sources/${encodeURIComponent(sourceId)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as DataSource & { message?: string };
  if (!response.ok) throw new Error(body.message || `Update API source failed: ${response.status}`);
  return body;
}

export async function syncDataSource(sourceId: string) {
  const response = await fetch(`${dataApiBase()}/api/data/sources/${encodeURIComponent(sourceId)}/sync`, { method: 'POST' });
  const body = await response.json().catch(() => ({})) as DataSource & { message?: string };
  if (!response.ok) throw new Error(body.message || `Sync data source failed: ${response.status}`);
  return body;
}

export async function updateDataTableSchema(sourceId: string, table: Pick<DataTable, 'id' | 'name' | 'columns' | 'description'>) {
  const response = await fetch(`${dataApiBase()}/api/data/sources/${encodeURIComponent(sourceId)}/tables/${encodeURIComponent(table.id)}/schema`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: table.name, columns: table.columns }),
  });
  const body = await response.json().catch(() => ({})) as DataSource & { message?: string };
  if (!response.ok) throw new Error(body.message || `Update schema failed: ${response.status}`);
  return body;
}

export async function getDataTableRows(sourceId: string, tableId: string) {
  const response = await fetch(`${dataApiBase()}/api/data/sources/${encodeURIComponent(sourceId)}/tables/${encodeURIComponent(tableId)}/rows`);
  const body = await response.json().catch(() => ({})) as { columns?: string[]; rows?: string[][]; message?: string };
  if (!response.ok) throw new Error(body.message || `Data rows failed: ${response.status}`);
  return { columns: Array.isArray(body.columns) ? body.columns : [], rows: Array.isArray(body.rows) ? body.rows : [] };
}

export async function createDataApp(input: { sourceId: string; tableId: string; name?: string; appType: DataApp['appType'] }) {
  const response = await fetch(`${dataApiBase()}/api/data/apps`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const body = await response.json().catch(() => ({})) as DataAppDetail & { message?: string };
  if (!response.ok) throw new Error(body.message || `Create data app failed: ${response.status}`);
  return body;
}

export async function customizeDataApp(input: {
  sourceId: string;
  tableId: string;
  idea: string;
  name?: string;
  appType?: DataApp['appType'];
}) {
  const response = await fetch(`${dataApiBase()}/api/data/apps/customize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as {
    app?: DataAppDetail;
    publishUrl?: string;
    prompt?: string;
    message?: string;
  };
  if (!response.ok || !body.app || !body.prompt || !body.publishUrl) {
    throw new Error(body.message || `Customize data app failed: ${response.status}`);
  }
  return { app: body.app, publishUrl: body.publishUrl, prompt: body.prompt };
}

export async function createDataAppProject(input: DataAppProjectCreate) {
  const response = await fetch(`${dataApiBase()}/api/data/apps/project-create`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { app?: DataAppDetail; message?: string; code?: string };
  if (!response.ok || !body.app) throw Object.assign(new Error(body.message || '应用项目准备失败，请重试。'), { code: body.code });
  return { ...dataAppProjectExecutionSchema.parse(body), app: body.app };
}

export async function executeDataAppProject(appId: string, input: DataAppProjectExecute) {
  const response = await fetch(`${dataApiBase()}/api/data/apps/${encodeURIComponent(appId)}/project-execute`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || '项目启动失败，请查看原项目。');
  return dataAppProjectExecutionSchema.parse(body);
}

export async function optimizeDataApp(appId: string, idea: string) {
  const response = await fetch(`${dataApiBase()}/api/data/apps/${encodeURIComponent(appId)}/optimize`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idea }),
  });
  const body = await response.json().catch(() => ({})) as { appId?: string; prompt?: string; publishUrl?: string; message?: string };
  if (!response.ok || !body.prompt) throw new Error(body.message || `Optimize data app failed: ${response.status}`);
  return { appId: body.appId || appId, prompt: body.prompt, publishUrl: body.publishUrl || '' };
}

export type DataAppRevision = { id: string; createdAt: number; note: string; bytes: number };
export async function listDataAppRevisions(appId: string) {
  const response = await fetch(`${dataApiBase()}/api/data/apps/${encodeURIComponent(appId)}/revisions`);
  const body = await response.json().catch(() => ([])) as DataAppRevision[] | { message?: string };
  if (!response.ok || !Array.isArray(body)) throw new Error((body as { message?: string }).message || `List revisions failed: ${response.status}`);
  return body;
}
export async function restoreDataAppRevision(appId: string, revisionId: string) {
  const response = await fetch(`${dataApiBase()}/api/data/apps/${encodeURIComponent(appId)}/revisions/${encodeURIComponent(revisionId)}/restore`, { method: 'POST' });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; message?: string };
  if (!response.ok) throw new Error(body.message || `Restore revision failed: ${response.status}`);
  return { ok: true as const };
}

export async function getDataAppCustomSite(appId: string) {
  const response = await fetch(`${dataApiBase()}/api/data/apps/${encodeURIComponent(appId)}/custom-site`);
  const body = await response.json().catch(() => ({})) as { bound?: boolean; updatedAt?: number | null; note?: string; bytes?: number; message?: string };
  if (!response.ok) throw new Error(body.message || `Custom site status failed: ${response.status}`);
  return { bound: Boolean(body.bound), updatedAt: body.updatedAt ?? null, note: body.note || '', bytes: body.bytes || 0 };
}

export async function clearDataAppCustomSite(appId: string) {
  const response = await fetch(`${dataApiBase()}/api/data/apps/${encodeURIComponent(appId)}/custom-site`, { method: 'DELETE' });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; message?: string };
  if (!response.ok) throw new Error(body.message || `Clear custom site failed: ${response.status}`);
  return { ok: true as const };
}

export async function getDataApp(appId: string, search = '') {
  const params = search ? `?${new URLSearchParams({ search }).toString()}` : '';
  const response = await fetch(`${dataApiBase()}/api/data/apps/${encodeURIComponent(appId)}${params}`);
  const body = await response.json().catch(() => ({})) as DataAppDetail & { message?: string };
  if (!response.ok) throw new Error(body.message || `Data app failed: ${response.status}`);
  return body;
}

export async function createDataAppRecord(appId: string, fields: Record<string, unknown>) {
  const response = await fetch(`${dataApiBase()}/api/data/apps/${encodeURIComponent(appId)}/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields }) });
  const body = await response.json().catch(() => ({})) as DataAppDetail & { message?: string };
  if (!response.ok) throw new Error(body.message || `Create record failed: ${response.status}`);
  return body;
}

export async function updateDataAppRecord(appId: string, recordId: string, fields: Record<string, unknown>) {
  const response = await fetch(`${dataApiBase()}/api/data/apps/${encodeURIComponent(appId)}/records/${encodeURIComponent(recordId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields }) });
  const body = await response.json().catch(() => ({})) as DataAppDetail & { message?: string };
  if (!response.ok) throw new Error(body.message || `Update record failed: ${response.status}`);
  return body;
}

export async function deleteDataAppRecord(appId: string, recordId: string) {
  const response = await fetch(`${dataApiBase()}/api/data/apps/${encodeURIComponent(appId)}/records/${encodeURIComponent(recordId)}`, { method: 'DELETE' });
  const body = await response.json().catch(() => ({})) as DataAppDetail & { message?: string };
  if (!response.ok) throw new Error(body.message || `Delete record failed: ${response.status}`);
  return body;
}

export async function deleteDataApp(appId: string) {
  const response = await fetch(`${dataApiBase()}/api/data/apps/${encodeURIComponent(appId)}`, { method: 'DELETE' });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; message?: string };
  if (!response.ok) throw new Error(body.message || `Delete data app failed: ${response.status}`);
  return { ok: true as const };
}

export async function publishDataApp(appId: string) {
  const response = await fetch(`${dataApiBase()}/api/data/apps/${encodeURIComponent(appId)}/publish`, { method: 'POST' });
  const body = await response.json().catch(() => ({})) as {
    appId?: string; access?: 'local' | 'lan'; url?: string; localUrl?: string; lanUrls?: string[]; message?: string;
  };
  if (!response.ok || !body.url) throw new Error(body.message || `Publish data app failed: ${response.status}`);
  return {
    url: body.url,
    localUrl: body.localUrl || body.url,
    lanUrls: Array.isArray(body.lanUrls) ? body.lanUrls : [],
    access: body.access ?? 'lan',
  };
}

export async function getDataAppPublish(appId: string) {
  const response = await fetch(`${dataApiBase()}/api/data/apps/${encodeURIComponent(appId)}/publish`);
  const body = await response.json().catch(() => ({})) as {
    appId?: string; published?: boolean; access?: 'local' | 'lan'; url?: string | null; localUrl?: string | null; lanUrls?: string[]; message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Get data app publish failed: ${response.status}`);
  return {
    published: Boolean(body.published),
    url: body.url || null,
    localUrl: body.localUrl || body.url || null,
    lanUrls: Array.isArray(body.lanUrls) ? body.lanUrls : [],
    access: body.access,
  };
}

export type RemoteChannelSecrets = {
  telegram?: { botToken?: string };
  feishu?: { appSecret?: string };
  dingtalk?: { clientSecret?: string };
  relay?: { token?: string };
};

export type RemoteChannelMeta = {
  version?: number;
  defaultEmployeeId?: string;
  allowlist?: string[];
  channels?: {
    telegram?: { enabled?: boolean };
    feishu?: { enabled?: boolean; appId?: string };
    dingtalk?: { enabled?: boolean; clientId?: string };
    relay?: { enabled?: boolean; baseUrl?: string; deviceId?: string };
  };
};

function remoteApiBase() {
  return window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
}

export async function getRemoteSettings() {
  const response = await fetch(`${remoteApiBase()}/api/remote/settings`);
  const body = await response.json().catch(() => ({})) as {
    meta?: RemoteChannelMeta;
    secrets?: RemoteChannelSecrets;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Remote settings failed: ${response.status}`);
  return {
    meta: (body.meta && typeof body.meta === 'object' ? body.meta : {}) as RemoteChannelMeta,
    secrets: (body.secrets && typeof body.secrets === 'object' ? body.secrets : {}) as RemoteChannelSecrets,
  };
}

export async function saveRemoteSettings(payload: { meta: RemoteChannelMeta; secrets: RemoteChannelSecrets }) {
  const response = await fetch(`${remoteApiBase()}/api/remote/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; meta?: RemoteChannelMeta; message?: string };
  if (!response.ok) throw new Error(body.message || `Remote settings save failed: ${response.status}`);
  return { ok: Boolean(body.ok), meta: (body.meta && typeof body.meta === 'object' ? body.meta : {}) as RemoteChannelMeta };
}

export async function getRemoteGatewayStatus() {
  const response = await fetch(`${remoteApiBase()}/api/remote/gateway/status`);
  const body = await response.json().catch(() => ({})) as { running?: boolean; pid?: number | null; message?: string };
  if (!response.ok) throw new Error(body.message || `Remote gateway status failed: ${response.status}`);
  return { running: Boolean(body.running), pid: body.pid ?? null };
}

export async function restartRemoteGateway() {
  const response = await fetch(`${remoteApiBase()}/api/remote/gateway/restart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = await response.json().catch(() => ({})) as { running?: boolean; pid?: number | null; message?: string };
  if (!response.ok) throw new Error(body.message || `Remote gateway restart failed: ${response.status}`);
  return { running: Boolean(body.running), pid: body.pid ?? null };
}
