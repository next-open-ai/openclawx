/**
 * Typed client for the server-side orchestration API (`/api/orch/**`).
 *
 * The Vue renderer and future channel/relay gateways call the SAME endpoints;
 * the orchestrator process owns the durable state machines (chat sessions,
 * resumable runs, project scheduling). Development uses the Vite `/api` proxy;
 * packaged desktop loads from `file:` and calls `http://127.0.0.1:47832` — same
 * convention as services/api.ts.
 */

import type { ChatFileAttachment, ChatImageAttachment, DurableTask, DurableTaskStatus, RunTextDeltaPosition } from '@workmate/contracts';
import type { AlgorithmDefinition, WorkflowDefinition, CreateConversationProject } from '@workmate/contracts';
import type { ProjectApplicationStatus, ProjectApplicationView, ProjectApplicationSnapshot, PublishProjectApplication } from '@workmate/contracts';
import type { ProjectDraftFiles } from '@workmate/contracts';
import type { WorkflowExecutionInput, WorkflowExecutionSummary, WorkflowInvocationInput, WorkflowInvocationResult } from '@workmate/contracts';

const apiBase = () =>
  window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';

/* ------------------------------------------------------------------ *
 * Server shapes (mirror of packages/orchestrator/src/types.ts)
 * ------------------------------------------------------------------ */

export type ServerProjectStatus = 'draft' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AccessScope = 'private' | 'org-shared' | 'delegated';
export type ServerTaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stale'
  | 'superseded';
export type ServerProjectMode = 'waterfall' | 'parallel' | 'discussion' | 'dag';
export type GrantCapability = 'workspace-write' | 'script-execution' | 'network-access';

export interface AccessGrant {
  subjectType: 'user';
  subjectId: string;
  permissions: Array<'read' | 'write'>;
  createdAt: number;
  expiresAt?: number;
}

export interface ServerRunApproval {
  id: string;
  skillId: string;
  capability: GrantCapability;
  summary: string;
  status: 'pending' | 'allowed' | 'denied';
  at: number;
  scope?: 'session' | 'always';
  resolvedAt?: number;
}

export interface ServerRunActivity {
  invocationId?: string;
  progress?: number;
  toolName: string;
  summary: string;
  detail?: string;
  status: 'running' | 'completed' | 'failed';
  startedAt?: number;
  durationMs?: number;
  at: number;
}

export interface ServerRunArtifact {
  path: string;
  assetId?: string;
  assetName?: string;
  assetSizeBytes?: number;
  createdAt?: number;
}

export interface ServerRunRecord {
  id: string;
  turnId?: string;
  orgId?: string;
  ownerUserId?: string;
  userId?: string;
  accessScope?: AccessScope;
  accessGrants?: AccessGrant[];
  sessionId: string;
  kind: 'chat' | 'project-task';
  taskId?: string;
  attemptNo: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting-approval';
  error?: string;
  engine?: 'pi' | 'agentscope' | 'dsh' | 'opencode' | 'claude-code';
  failure?: import('@workmate/contracts').RunFailure;
  startedAt: number;
  finishedAt?: number;
  transcript: string;
  reasoning?: string;
  activities: ServerRunActivity[];
  approvals: ServerRunApproval[];
  artifacts: ServerRunArtifact[];
  sources: Array<{ title: string; url: string; source?: string }>;
  cancelReason?: 'user' | 'timeout';
  model?: {
    provider: string;
    chatModel: string;
    baseUrl?: string;
    providerLabel?: string;
  };
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    steps: Array<{
      at: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      totalTokens: number;
      model?: { provider: string; chatModel: string; baseUrl?: string; providerLabel?: string };
      capability?: import('@workmate/contracts').ModelCapability;
    }>;
    byModel?: Array<{
      provider: string; chatModel: string; baseUrl?: string; providerLabel?: string;
      capability?: import('@workmate/contracts').ModelCapability;
      inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; totalTokens: number;
    }>;
  };
  eventLog?: Array<{
    type: string;
    toolName?: string;
    summary?: string;
    message?: string;
    reason?: "user" | "timeout";
  }>;
}

export interface ServerUsageBucket {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  runCount: number;
}

export interface ServerUsageStats {
  totals: ServerUsageBucket;
  byModel: Array<ServerUsageBucket & {
    key: string;
    provider: string;
    chatModel: string;
    baseUrl?: string;
    providerLabel?: string;
    capability?: import('@workmate/contracts').ModelCapability;
  }>;
  byProject: Array<ServerUsageBucket & { projectId: string; name: string }>;
  byChat: Array<ServerUsageBucket & { sessionId: string; title: string }>;
  byDay: Array<ServerUsageBucket & { period: string }>;
  byWeek: Array<ServerUsageBucket & { period: string }>;
  byMonth: Array<ServerUsageBucket & { period: string }>;
  recent: Array<{
    runId: string;
    sessionId: string;
    kind: 'chat' | 'project-task';
    taskId?: string;
    startedAt: number;
    finishedAt?: number;
    status: ServerRunRecord['status'];
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
  rollup?: {
    id: string;
    periodStart: number;
    periodEnd: number;
    mergedRunCount: number;
  };
}



export interface ServerTask {
  id: string;
  title: string;
  objective: string;
  employeeId: string;
  skillIds: string[];
  dependsOn: string[];
  permissionTier: 'read-only' | 'default' | 'full';
  status: ServerTaskStatus;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  runId?: string;
  error?: string;
  contract?: {
    outputs?: string[];
    acceptance?: string;
    maxSteps?: number;
    timeoutMs?: number;
    maxAttempts?: number;
  };
  planVersion?: number;
}

export interface ServerMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  employeeId?: string;
  taskId?: string;
  createdAt: number;
  changeSetId?: string;
  runId?: string;
}

export interface ServerProjectPlan {
  version: number;
  createdAt: number;
  strategy: ServerProjectMode;
  taskIds: string[];
  note?: string;
}

export interface ServerProjectChangeSet {
  id: string;
  createdAt: number;
  kind: 'instruction' | 'replan' | 'invalidate';
  summary: string;
  targetTaskIds: string[];
  invalidatedTaskIds: string[];
  planVersionBefore: number;
  planVersionAfter: number;
}

export interface ServerProject {
  kind?: 'conversation';
  defaultEmployeeId?: string;
  id: string;
  orgId?: string;
  ownerUserId?: string;
  userId?: string;
  accessScope?: AccessScope;
  accessGrants?: AccessGrant[];
  name: string;
  goal: string;
  status: ServerProjectStatus;
  mode: ServerProjectMode;
  workspacePath: string;
  executionWorkspaceMode?: 'isolated';
  tasks: ServerTask[];
  messages: ServerMessage[];
  createdAt: number;
  updatedAt: number;
  activeRunId?: string;
  summary?: string;
  coordinator?: { provider: string; model: string };
  plan?: ServerProjectPlan;
  planHistory?: ServerProjectPlan[];
  changeSets?: ServerProjectChangeSet[];
}

export interface ServerProjectRun {
  id: string;
  projectId: string;
  orgId?: string;
  ownerUserId?: string;
  userId?: string;
  accessScope?: AccessScope;
  accessGrants?: AccessGrant[];
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  taskIds: string[];
  summary?: string;
  error?: string;
  planVersion?: number;
  changeSetId?: string;
  messages?: ServerMessage[];
}

/* ------------------------------------------------------------------ *
 * OrcEvent (mirror of packages/orchestrator/src/events.ts)
 * ------------------------------------------------------------------ */

export interface OrcEvent extends RunTextDeltaPosition {
  type: string;
  projectId?: string;
  sessionId?: string;
  runId?: string;
  taskId?: string;
  status?: string;
  text?: string;
  reasoningText?: string;
  provider?: string;
  attemptNo?: number;
  engine?: 'pi' | 'agentscope' | 'dsh' | 'opencode' | 'claude-code';
  activity?: ServerRunActivity;
  approval?: ServerRunApproval;
  artifact?: { path: string };
  path?: string;
  projectPath?: string;
  sources?: ServerRunRecord['sources'];
  message?: ServerMessage;
  error?: string;
  ts?: number;
  failure?: import('@workmate/contracts').RunFailure;
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase()}/api/orch${path}`, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  const body = (await response.json().catch(() => ({}))) as { message?: string } & T;
  if (!response.ok) {
    throw new Error(body?.message || `Orchestration request failed: ${response.status}`);
  }
  return body;
}

export function listProjectDraftFiles(projectId: string, runId: string) {
  return request<ProjectDraftFiles>(`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/draft-files`);
}
export function readProjectDraftFile(projectId: string, runId: string, relative: string) {
  return request<{ relative: string; content: string }>(`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/draft-file?${new URLSearchParams({ relative })}`);
}

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

export async function createProject(input: {
  name?: string;
  goal: string;
  mode: ServerProjectMode;
  workspacePath: string;
  accessScope?: AccessScope;
  accessGrants?: AccessGrant[];
  coordinator?: { provider: string; model: string };
  tasks: Array<{ id?: string; title: string; objective: string; employeeId: string; skillIds: string[]; dependsOn?: string[]; contract?: ServerTask["contract"] }>;
}): Promise<ServerProject> {
  const result = await request<{ project: ServerProject }>('/projects', { method: 'POST', body: JSON.stringify(input) });
  return result.project;
}

export async function listProjects(): Promise<ServerProject[]> {
  const result = await request<{ projects: ServerProject[] }>('/projects');
  return result.projects;
}

export async function createConversationProject(input: { name: string; goal?: string; employeeId?: string; workspace?: CreateConversationProject['workspace'] }): Promise<ServerProject> {
  const result = await request<{ project: ServerProject }>('/projects/conversations', { method: 'POST', body: JSON.stringify(input) });
  return result.project;
}

export function getProjectApplication(projectId: string): Promise<ProjectApplicationStatus> {
  return request(`/projects/${encodeURIComponent(projectId)}/application`);
}
export function previewProjectApplication(projectId: string): Promise<ProjectApplicationView> {
  return request(`/projects/${encodeURIComponent(projectId)}/application/preview`, { method: 'POST' });
}
export function viewPublishedProjectApplication(projectId: string): Promise<ProjectApplicationView> {
  return request(`/projects/${encodeURIComponent(projectId)}/application/view`, { method: 'POST' });
}
export async function publishProjectApplication(projectId: string, input: PublishProjectApplication): Promise<ProjectApplicationSnapshot> {
  return (await request<{ published: ProjectApplicationSnapshot }>(`/projects/${encodeURIComponent(projectId)}/application/publish`, { method: 'POST', body: JSON.stringify(input) })).published;
}
export function projectApplicationViewUrl(view: ProjectApplicationView): string {
  return `${apiBase()}${view.viewPath}`;
}

export function listDefinitions(kind: 'workflows'): Promise<{ items: WorkflowDefinition[] }>;
export function listDefinitions(kind: 'algorithms'): Promise<{ items: AlgorithmDefinition[] }>;
export function listDefinitions(kind: 'workflows' | 'algorithms'): Promise<{ items: Array<WorkflowDefinition | AlgorithmDefinition> }> {
  return request(`/definitions/${kind}`);
}
export async function saveDefinition(kind: 'workflows' | 'algorithms', definition: WorkflowDefinition | AlgorithmDefinition): Promise<void> {
  await request(`/definitions/${kind}/${encodeURIComponent(definition.id)}`, { method: 'PUT', body: JSON.stringify(definition) });
}
export async function deleteDefinition(kind: 'workflows' | 'algorithms', id: string): Promise<void> {
  await request(`/definitions/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function prepareWorkflowRun(id: string, input: WorkflowExecutionInput): Promise<{ projectId: string }> {
  return request(`/definitions/workflows/${encodeURIComponent(id)}/runs`, { method: 'POST', body: JSON.stringify(input) });
}
export function listWorkflowRuns(id: string): Promise<{ items: WorkflowExecutionSummary[] }> {
  return request(`/definitions/workflows/${encodeURIComponent(id)}/runs`);
}
export function invokeChatWorkflow(sessionId: string, workflowId: string, input: WorkflowInvocationInput): Promise<WorkflowInvocationResult> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/workflows/${encodeURIComponent(workflowId)}/invocations`, { method: 'POST', body: JSON.stringify(input) });
}
export function listChatWorkflowInvocations(sessionId: string): Promise<{ items: WorkflowExecutionSummary[] }> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/workflow-invocations`);
}
export function resumeChatWorkflowInvocation(sessionId: string, requestId: string): Promise<WorkflowInvocationResult> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/workflow-invocations/${encodeURIComponent(requestId)}/resume`, { method: 'POST', body: '{}' });
}
export function invokeProjectWorkflow(projectId: string, workflowId: string, input: WorkflowInvocationInput): Promise<WorkflowInvocationResult> {
  return request(`/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/invocations`, { method: 'POST', body: JSON.stringify(input) });
}
export function listProjectWorkflowInvocations(projectId: string): Promise<{ items: WorkflowExecutionSummary[] }> {
  return request(`/projects/${encodeURIComponent(projectId)}/workflow-invocations`);
}
export function resumeProjectWorkflowInvocation(projectId: string, requestId: string): Promise<WorkflowInvocationResult> {
  return request(`/projects/${encodeURIComponent(projectId)}/workflow-invocations/${encodeURIComponent(requestId)}/resume`, { method: 'POST', body: '{}' });
}

export async function getProject(id: string): Promise<ServerProject | null> {
  try {
    const result = await request<{ project: ServerProject }>(`/projects/${encodeURIComponent(id)}`);
    return result.project;
  } catch {
    return null;
  }
}

export function workflowResultEvidence(sessionId: string, requestId: string): Promise<{ evidence: import('@workmate/contracts').WorkflowResultEvidence }> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/workflow-invocations/${encodeURIComponent(requestId)}/evidence`);
}

export async function deleteProject(id: string): Promise<void> {
  await request(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function updateProjectAccess(
  id: string,
  input: { accessScope: AccessScope; accessGrants?: AccessGrant[] },
): Promise<ServerProject> {
  const result = await request<{ project: ServerProject }>(
    `/projects/${encodeURIComponent(id)}/access`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
  return result.project;
}

/** Start the server scheduler (contexts are assembled server-side). */
export async function confirmProject(id: string, options: { resumeIncomplete?: boolean } = {}): Promise<{ project: ServerProject; run: ServerProjectRun }> {
  const result = await request<{ project: ServerProject; run: ServerProjectRun }>(
    `/projects/${encodeURIComponent(id)}/confirm`,
    { method: 'POST', body: JSON.stringify(options) },
  );
  return result;
}

/** Rebuild task graph after member roster changes. */
export async function replanProject(
  id: string,
  input: {
    tasks: Array<{ id?: string; title: string; objective: string; employeeId: string; skillIds: string[]; dependsOn?: string[]; contract?: ServerTask["contract"] }>;
    note?: string;
  },
): Promise<ServerProject> {
  const result = await request<{ project: ServerProject }>(
    `/projects/${encodeURIComponent(id)}/replan`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return result.project;
}

/** Follow-up instruction through the scheduler (resets target + downstream). */
export async function dispatchProjectInstruction(
  id: string,
  input: { employeeId: string; content: string; employeeLabel?: string; requestId?: string; fileIds?: string[] },
): Promise<{ project: ServerProject; run: ServerProjectRun }> {
  const result = await request<{ project: ServerProject; run: ServerProjectRun }>(
    `/projects/${encodeURIComponent(id)}/instructions`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return result;
}

export async function cancelProject(id: string): Promise<boolean> {
  const result = await request<{ cancelled: boolean }>(`/projects/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({}) });
  return result.cancelled;
}

export async function retryTask(projectId: string, taskId: string): Promise<boolean> {
  const result = await request<{ started: boolean }>(
    `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/retry`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  return result.started;
}

export async function projectTranscript(projectId: string, taskId: string): Promise<ServerRunRecord | null> {
  const result = await request<{ transcript: ServerRunRecord | null }>(
    `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/transcript`,
  );
  return result.transcript;
}

export async function projectRuns(projectId: string): Promise<ServerProjectRun[]> {
  const result = await request<{ runs: ServerProjectRun[] }>(`/projects/${encodeURIComponent(projectId)}/runs`);
  return result.runs;
}

export async function resolveTaskApproval(input: {
  projectId: string;
  taskId: string;
  approvalId: string;
  allow: boolean;
  scope?: 'session' | 'always';
}): Promise<{ resumed?: boolean }> {
  return request(
    `/projects/${encodeURIComponent(input.projectId)}/tasks/${encodeURIComponent(input.taskId)}/approvals/${encodeURIComponent(input.approvalId)}/resolve`,
    { method: 'POST', body: JSON.stringify({ allow: input.allow, scope: input.scope }) },
  );
}

/* ------------------------------------------------------------------ *
 * Chat sessions (普通对话)
 * ------------------------------------------------------------------ */

export interface ServerChatMessage {
  workflowResult?: import('@workmate/contracts').WorkflowResultReference;
  attachments?: ChatImageAttachment[];
  fileAttachments?: ChatFileAttachment[];
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  turnId?: string;
  runId?: string;
  durableTaskId?: string;
  superseded?: boolean;
}

export interface ServerChatSession {
  id: string;
  kind: 'chat';
  orgId?: string;
  ownerUserId?: string;
  userId?: string;
  accessScope?: AccessScope;
  accessGrants?: AccessGrant[];
  title: string;
  employeeId: string;
  modelLabel?: string;
  messages: ServerChatMessage[];
  memory?: {
    summary: string;
    coveredUntilId: string;
    updatedAt: number;
    dirty: boolean;
  };
  channelBinding?: { channelId: string; threadId: string } | null;
  activeDurableTaskId?: string;
  grantsSession: Record<string, GrantCapability[]>;
  grantsAlways: Record<string, GrantCapability[]>;
  createdAt: number;
  updatedAt: number;
}

export async function createChatSession(input: { title?: string; employeeId?: string }): Promise<ServerChatSession> {
  const result = await request<{ session: ServerChatSession }>('/sessions', { method: 'POST', body: JSON.stringify(input) });
  return result.session;
}

export async function listChatSessions(): Promise<ServerChatSession[]> {
  const result = await request<{ sessions: ServerChatSession[] }>('/sessions');
  return result.sessions;
}

export async function getChatSession(id: string): Promise<ServerChatSession | null> {
  try {
    const result = await request<{ session: ServerChatSession }>(`/sessions/${encodeURIComponent(id)}`);
    return result.session;
  } catch {
    return null;
  }
}

export async function deleteChatSession(id: string): Promise<void> {
  await request(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function clearChatSession(id: string): Promise<ServerChatSession> {
  const result = await request<{ session: ServerChatSession }>(`/sessions/${encodeURIComponent(id)}/clear`, { method: 'POST', body: JSON.stringify({}) });
  return result.session;
}

/**
 * Send a chat message. `context` is optional: the server assembles the run
 * context for the session's employee (domain KV + keyring) when omitted.
 */
export async function sendChatMessage(id: string, input: { content: string; attachments?: ChatImageAttachment[]; fileAttachments?: ChatFileAttachment[]; employeeId?: string; context?: Record<string, unknown>; workflowResult?: import('@workmate/contracts').WorkflowResultReference }): Promise<{ runId: string; turnId: string; attemptNo: number }> {
  return request(`/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify(input) });
}

export async function uploadChatFile(sessionId: string, file: File): Promise<{ attachment: ChatFileAttachment; warning?: string }> {
  const response = await fetch(`${apiBase()}/api/orch/sessions/${encodeURIComponent(sessionId)}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-workmate-file-name': encodeURIComponent(file.name) },
    body: file,
  });
  const body = await response.json().catch(() => ({})) as { attachment?: ChatFileAttachment; warning?: string; message?: string };
  if (!response.ok || !body.attachment) throw new Error(body.message || `附件上传失败：${response.status}`);
  return { attachment: body.attachment, warning: body.warning };
}

export async function uploadWorkflowDocument(workflowId: string, requestId: string, file: File): Promise<{ attachment: ChatFileAttachment; warning?: string }> {
  const response = await fetch(`${apiBase()}/api/orch/definitions/workflows/${encodeURIComponent(workflowId)}/uploads/${encodeURIComponent(requestId)}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-workmate-file-name': encodeURIComponent(file.name) }, body: file,
  });
  const body = await response.json().catch(() => ({})) as { attachment?: ChatFileAttachment; warning?: string; message?: string };
  if (!response.ok || !body.attachment) throw new Error(body.message || '文档上传失败');
  return { attachment: body.attachment, warning: body.warning };
}

export async function uploadProjectDocument(projectId: string, requestId: string, file: File): Promise<{ attachment: ChatFileAttachment; warning?: string }> {
  const response = await fetch(`${apiBase()}/api/orch/projects/${encodeURIComponent(projectId)}/uploads/${encodeURIComponent(requestId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Workmate-File-Name': encodeURIComponent(file.name) }, body: file,
  });
  const body = await response.json().catch(() => ({})) as { attachment?: ChatFileAttachment; warning?: string; message?: string };
  if (!response.ok || !body.attachment) throw new Error(body.message || '文档上传失败');
  return { attachment: body.attachment, warning: body.warning };
}

export async function deleteChatFile(sessionId: string, fileId: string): Promise<void> {
  await request(`/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
}

export async function getChatAttachmentStats(): Promise<{ bytes: number; count: number; limitBytes: number; warning: boolean }> {
  return request('/attachments/stats');
}

export async function cleanupChatAttachments(dryRun = false): Promise<{ count: number; bytes: number; dryRun: boolean }> {
  return request('/attachments/cleanup', { method: 'POST', body: JSON.stringify({ dryRun }) });
}

export async function uploadChatImage(sessionId: string, file: File): Promise<ChatImageAttachment> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('只支持 PNG、JPEG、WebP 图片。');
  if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('每张图片须小于等于 10 MB。');
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('无法读取图片。'));
    reader.readAsDataURL(file);
  });
  const result = await request<{ attachment: ChatImageAttachment }>(`/sessions/${encodeURIComponent(sessionId)}/images`, { method: 'POST', body: JSON.stringify({ name: file.name, dataBase64 }) });
  return result.attachment;
}

export async function loadChatImageUrl(sessionId: string, imageId: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${apiBase()}/api/orch/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(imageId)}`, { signal });
  if (!response.ok) throw new Error('图片不可用，请重新上传。');
  return URL.createObjectURL(await response.blob());
}

export async function cancelChatRun(id: string): Promise<boolean> {
  const result = await request<{ aborted: boolean }>(`/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({}) });
  return result.aborted;
}

/** Flush durable session rolling memory (call when leaving a chat). */
export async function flushChatSessionMemory(id: string): Promise<ServerChatSession | null> {
  try {
    const result = await request<{ session: ServerChatSession }>(`/sessions/${encodeURIComponent(id)}/memory/flush`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return result.session;
  } catch {
    return null;
  }
}

export async function chatPendingApprovals(id: string): Promise<ServerRunRecord[]> {
  const result = await request<{ pending: ServerRunRecord[] }>(`/sessions/${encodeURIComponent(id)}/approvals`);
  return result.pending;
}

/** Runs reachable from a session's messages (for waiting/status checks). */
export async function sessionRuns(id: string): Promise<ServerRunRecord[]> {
  const result = await request<{ runs: ServerRunRecord[] }>(`/sessions/${encodeURIComponent(id)}/runs`);
  return result.runs;
}

/** Read one authorized linked run; a monitor never needs other conversation runs. */
export async function getRunRecord(id:string,signal?:AbortSignal):Promise<ServerRunRecord>{
  return (await request<{run:ServerRunRecord}>(`/runs/${encodeURIComponent(id)}`,{signal})).run;
}

export async function sessionDurableTasks(id: string): Promise<{ tasks: DurableTask[]; activeTaskId: string | null }> {
  return request(`/sessions/${encodeURIComponent(id)}/tasks`);
}

export async function updateDurableTaskStatus(sessionId: string, taskId: string, status: DurableTaskStatus): Promise<DurableTask> {
  const result = await request<{ task: DurableTask }>(`/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH', body: JSON.stringify({ status }),
  });
  return result.task;
}

export async function fetchUsageStats(): Promise<ServerUsageStats> {
  const result = await request<{ stats: ServerUsageStats }>('/usage');
  return result.stats;
}

export async function resolveChatApproval(
  id: string,
  approvalId: string,
  input: { allow: boolean; scope?: 'session' | 'always' },
): Promise<{ resumedRunId?: string; turnId?: string }> {
  return request(`/sessions/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}/resolve`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export type OrchSubscribeStatus = 'open' | 'error' | 'closed';

export type OrchSubscribeOptions = {
  signal?: AbortSignal;
  /** Fired when the SSE transport opens, fails, or ends. Failures are no longer silent. */
  onStatus?: (status: OrchSubscribeStatus, detail?: string) => void;
};

/** Subscribe to a session's orchestration events (run deltas/activities/...). */
export function subscribeSessionEvents(
  sessionId: string,
  onEvent: (event: OrcEvent) => void,
  options: OrchSubscribeOptions = {},
): () => void {
  return subscribeEvents('session', sessionId, onEvent, options);
}

/* ------------------------------------------------------------------ *
 * Generic event stream (fetch-based SSE — EventSource is CORS-blocked from file:)
 * ------------------------------------------------------------------ */

function subscribeEvents(
  topic: 'session' | 'project',
  id: string,
  onEvent: (event: OrcEvent) => void,
  options: OrchSubscribeOptions,
): () => void {
  let cancelled = false;
  const controller = new AbortController();
  const abortFromOutside = () => controller.abort();
  options.signal?.addEventListener('abort', abortFromOutside, { once: true });

  void (async () => {
    try {
      const response = await fetch(`${apiBase()}/api/orch/events?${topic}=${encodeURIComponent(id)}`, { signal: controller.signal });
      if (!response.ok || !response.body) {
        options.onStatus?.('error', `SSE ${response.status || 'no-body'}`);
        return;
      }
      options.onStatus?.('open');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          if (!chunk.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(chunk.slice(6)) as OrcEvent;
            onEvent(event);
          } catch {
            /* skip malformed/heartbeat */
          }
        }
      }
      if (!cancelled && !controller.signal.aborted) options.onStatus?.('closed');
    } catch (error) {
      if (controller.signal.aborted || cancelled) return;
      const detail = error instanceof Error ? error.message : String(error);
      options.onStatus?.('error', detail || 'SSE stream failed');
    } finally {
      cancelled = true;
      options.signal?.removeEventListener('abort', abortFromOutside);
    }
  })();

  return () => {
    if (!cancelled) controller.abort();
  };
}

export function subscribeProjectEvents(
  projectId: string,
  onEvent: (event: OrcEvent) => void,
  options: OrchSubscribeOptions = {},
): () => void {
  return subscribeEvents('project', projectId, onEvent, options);
}
