import { computed, ref } from 'vue';
import { materializeWorkspaceAssets, createManagedWorkspace, mergeToolActivity, streamChat, syncWorkspaceRun, type RuntimeSkill, type ToolActivity, type ToolApproval, type SearchSource } from '../services/api.js';
import * as orch from '../services/orchestration.js';
import type { ProviderConfig } from './model-config.js';
import { resolveDecisionRuntime, toModelPayload, useModelConfig } from './model-config.js';
import { useSearchConfig } from './search-config.js';
import { DEFAULT_MAX_STEPS, DEFAULT_MCP_TOOL_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS, useEmployeeRuntimePrefs } from './employee-prefs.js';
import { useMcpConfig } from './mcp-config.js';
import { useKnowledgeConfig } from './kb-config.js';
import { readStored, writeStored } from './storage.js';
import { useCapabilities, type ExecutionLevel } from './capabilities.js';
import { useAssets, type Asset } from './assets.js';
import { useAutoScheduleConfig } from './auto-schedule-config.js';
import { resolveAssistantTiming } from './chat-run-timing.js';
import type { Automation } from './automations.js';
import {
  useEmployeeCatalog,
  type Employee,
  type EmployeeDraft,
  type EmployeeId,
} from './employees.js';

export type { Employee, EmployeeDraft, EmployeeId } from './employees.js';
export type View = 'chat' | 'employees' | 'capabilities' | 'knowledge' | 'assets' | 'data' | 'automations' | 'projects' | 'workflows' | 'algorithms' | 'remote' | 'env' | 'docs' | 'settings';
export type CollaborationDelivery = 'synthesize' | 'direct';
export interface CollaborationRun { employeeId: EmployeeId; task: string; status: 'running' | 'completed' | 'failed'; summary: string; activities: ToolActivity[]; error?: string; }
export type ScheduleTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface ScheduleTaskRun {
  id: string;
  title: string;
  objective: string;
  employeeId: EmployeeId;
  skillIds: string[];
  dependsOn: string[];
  status: ScheduleTaskStatus;
  summary: string;
  activities: ToolActivity[];
  error?: string;
  assets?: Array<{ id: string; name: string; sizeBytes: number }>;
}
export interface ChatScheduleState {
  status: 'planning' | 'running' | 'completed' | 'failed' | 'cancelled';
  mode: 'dag';
  rationale?: string;
  tasks: ScheduleTaskRun[];
  selectedTaskId?: string;
}
export interface Message {
  workflowResult?: import('@workmate/contracts').WorkflowResultReference;
  attachments?: import('@workmate/contracts').ChatImageAttachment[];
  fileAttachments?: import('@workmate/contracts').ChatFileAttachment[];
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  activities?: ToolActivity[];
  approvals?: ToolApproval[];
  assets?: Asset[];
  sources?: Array<SearchSource & { provider: string }>;
  collaborations?: CollaborationRun[];
  collaborationDelivery?: CollaborationDelivery;
  /** Auto-schedule (planner → DAG → multi-agent) turn state. */
  schedule?: ChatScheduleState;
  /** Resolved execution engine for this assistant turn. */
  engine?: 'pi' | 'agentscope' | 'dsh' | 'opencode' | 'claude-code';
  /** Server run id when this assistant turn was executed via orch. */
  runId?: string;
  /** Durable task associated with this turn, used to anchor its inline task card. */
  durableTaskId?: string;
  startedAt?: number;
  elapsedMs?: number;
}
export interface Conversation {
  id: string;
  title: string;
  employeeId: EmployeeId;
  messages: Message[];
  updatedAt: number;
  serverSessionId?: string;
  /** Periodic server mirror is opt-in after the user creates a mobile chat link. */
  mobileMirrorEnabled?: boolean;
}
export interface ProjectTaskDraft { title: string; objective: string; employeeId: EmployeeId; skillIds: string[]; dependsOn?: number[]; contract?: { outputs?: string[]; acceptance?: string; maxSteps?: number; timeoutMs?: number; maxAttempts?: number } };
export interface ProjectTaskTranscript {
  error?: string;
  failure?: import('@workmate/contracts').RunFailure;
  assistantContent: string;
  reasoningContent?: string;
  activities: ToolActivity[];
  approvals: ToolApproval[];
  assets: Array<{ id: string; name: string; sizeBytes: number; runId?: string }>;
  sources?: SearchSource[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalTokens: number;
  };
  model?: { provider: string; chatModel: string; baseUrl?: string; providerLabel?: string };
  trace?: Array<{ type: string; toolName?: string; summary?: string; message?: string; reason?: 'user' | 'timeout' }>;
  runId?: string;
}

/** Keep in sync with agent-core deliverable contract: only output/ is archived. */
const NEVER_DELIVERABLE_EXT = new Set(['pyc', 'pyo', 'pyd', 'class', 'o', 'obj', 'exe', 'dll', 'so', 'dylib', 'map']);
const PROCESS_ONLY_DIRS = new Set(['tools', 'scripts', 'tmp', 'deps', '.python-packages', '__pycache__', 'node_modules']);

function isUserFacingDeliverablePath(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts[0] !== 'output' || parts.length < 2) return false;
  if (parts.some((part) => !part || part === '.' || part === '..' || PROCESS_ONLY_DIRS.has(part))) return false;
  const base = parts[parts.length - 1] || '';
  if (base.startsWith('.') && base !== '.gitkeep') return false;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  return Boolean(ext) && !NEVER_DELIVERABLE_EXT.has(ext);
}

const view = ref<View>('chat');
const currentEmployeeId = ref<EmployeeId>('general');
const conversations = ref<Conversation[]>([]);
const activeConversationId = ref<string | null>(null);
const permissionTierByEmployee = ref<Record<string, ExecutionLevel>>({});
const sessionGrants = new Map<string, Set<ToolApproval['capability']>>();
/** Aborts the in-flight chat/MCP run (and closes server-side resources via disconnect). */
let activeRunAbort: AbortController | null = null;
/** True while addMessage / schedule is in flight (survives ChatWorkspace remount). */
export const chatBusy = ref(false);

function isAbortError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'name' in error && (error as { name?: string }).name === 'AbortError');
}

function markActivitiesInterrupted(activities?: ToolActivity[]) {
  if (!activities?.length) return;
  for (const activity of activities) {
    if (activity.status === 'running') {
      activity.status = 'failed';
      activity.summary = activity.summary ? `${activity.summary}（已中止）` : '已中止';
    }
  }
}

/** Close out leftover `running` rows after a successful settle (lost tool.completed, etc.). */
function markActivitiesSettled(activities?: ToolActivity[]) {
  if (!activities?.length) return;
  for (const activity of activities) {
    if (activity.status === 'running') {
      // A settled run is not proof that a tool/capability succeeded. If its
      // terminal event was lost, presenting green "completed" is misleading.
      activity.status = 'failed';
      activity.summary = activity.summary
        ? `${activity.summary} — 运行已结束，但未收到该步骤的完成结果`
        : '运行已结束，但未收到该步骤的完成结果';
    }
  }
}

function appendAssistantNotice(message: Message, notice: string) {
  const normalized = notice.trim();
  if (!normalized) return;
  if (!message.content.trim()) {
    message.content = normalized;
    return;
  }
  if (message.content.includes(normalized)) return;
  message.content = `${message.content.trim()}\n\n${normalized}`;
}

const NETWORK_ERROR_RE =
  /connection\s*error|failed to fetch|fetch failed|terminated|econnreset|econnrefused|enotfound|eai_again|broken pipe|network|ssl|tls|timed?\s*out|timeout|stream idle|remote end closed|temporarily unavailable|socket hang up|ECONNABORTED|UND_ERR|模型流已中断|网络连接超时/i;

const FRIENDLY_NETWORK_ERROR =
  '网络连接超时或中断了，这次没能完成回答，也还没有生成最终文件。请检查网络后重试；若正在使用 VPN，也可先切换网络再试。';

const UNFINISHED_DELIVERABLE_NOTICE =
  '本轮还没有生成最终文件。重新发送后通常可以继续完成。';

function friendlyAssistantError(raw: string) {
  const text = raw.trim();
  if (!text) return '请求失败，请稍后重试。';
  if (NETWORK_ERROR_RE.test(text)) return FRIENDLY_NETWORK_ERROR;
  if (/Bad control character|Unterminated string|Bad escaped character|in string literal in JSON|Expected ',' or '}' after property value|Expected ',' or '\]'|JSON at position|Unexpected non-whitespace/i.test(text)) {
    return '工具参数 JSON 解析失败（常见原因：单次写入内容过大或转义被截断）。请缩小本次 write 内容，改用一次初始写入加必要的原生 edit 后重试。';
  }
  return text;
}

/** Explicit policy / budget failures must fail the schedule node — never soft-complete. */
function isHardScheduleFailure(raw: unknown): boolean {
  const text = raw instanceof Error ? raw.message : String(raw || '');
  return /工具调用步数超过上限|步数超过上限|轮次\s*\/\s*步骤上限|max steps|step limit|run timeout|运行超时|已自动中止/i.test(text);
}

function isSoftCompletableStreamError(raw: unknown): boolean {
  if (isHardScheduleFailure(raw)) return false;
  const text = raw instanceof Error ? raw.message : String(raw || '');
  return NETWORK_ERROR_RE.test(text) || /模型流已中断|stream.*interrupt|unexpected end|incomplete/i.test(text);
}

function appendUnfinishedDeliverableNotice(message: Message) {
  if ((message.assets?.length ?? 0) > 0) return;
  // Network-friendly copy already covers the missing deliverable.
  if (message.content.includes(FRIENDLY_NETWORK_ERROR) || /网络连接超时或中断/.test(message.content)) return;
  appendAssistantNotice(message, `⚠ ${UNFINISHED_DELIVERABLE_NOTICE}`);
}

const catalog = useEmployeeCatalog();
const employees = catalog.employees;

function labelEmployee(employee: Employee) {
  if (employee.name?.trim()) return employee.name.trim();
  if (employee.id === 'general') return '通用助理';
  if (employee.id === 'research') return '研究助理';
  if (employee.id === 'code') return '编程助理';
  if (employee.id === 'administrator') return '系统管理员';
  return employee.id;
}

function profileInstructions(employee: Employee, extra = '') {
  const configuredLanguage = typeof document !== 'undefined' && document.documentElement.lang.toLowerCase().startsWith('en')
    ? 'English'
    : '简体中文';
  const languageDirective = configuredLanguage === 'English'
    ? 'The application language is English. Respond in English by default, including headings, explanations, progress updates, and tool-facing summaries. Only use another language when the user explicitly asks for it.'
    : '当前应用语言为简体中文。默认使用简体中文回答，包括标题、解释、进度更新和工具结果摘要；只有用户明确要求时才切换为其他语言。';
  const role = employee.name?.trim()
    || (employee.id === 'general' ? 'General Assistant'
      : employee.id === 'research' ? 'Research Assistant'
        : employee.id === 'code' ? 'Coding Assistant'
          : employee.id === 'administrator' ? 'System Administrator'
            : employee.id);
  const focus = employee.instructions?.trim()
    || (employee.id === 'research' ? 'Focus on facts, evidence, sources, and uncertainty.'
      : employee.id === 'code' ? 'Focus on technical feasibility, implementation paths, and verification.'
        : employee.id === 'administrator' ? 'Focus on permissions, safety, runtime boundaries, and governance risk.'
          : employee.id === 'general' ? 'Focus on clear answers, writing quality, and practical next steps.'
            : 'Be helpful, accurate, and concise.');
  const roleBrief = employee.description?.trim() ? ` Role brief: ${employee.description.trim()}` : '';
  const researchMode = employee.id === 'research'
    ? ' Research output mode: deliver a concise Markdown or structured research brief with findings, evidence/source pointers, uncertainty, and next actions. Do not narrate planning or self-correction. Use only the minimum relevant tools; after a failed file operation, state the concrete blocker instead of repeatedly retrying the same write/read path.'
    : '';
  return `You are Workmate's digital employee "${role}" (${employee.id}). Introduce yourself using this employee name; describe capabilities accurately without exaggeration.${roleBrief} ${focus} ${languageDirective} Reply in the user's language when it differs only because the user explicitly requests another language.${researchMode} ${extra}`.trim();
}

function collaboratorFocus(employee: Employee) {
  if (employee.instructions?.trim()) return employee.instructions.trim();
  if (employee.id === 'research') return '聚焦事实、证据、资料线索与不确定性；给出可核查的研究简报。';
  if (employee.id === 'code') return '聚焦技术可行性、实现路径、工程风险与验证建议；给出技术简报。';
  if (employee.id === 'administrator') return '聚焦权限、安全、运行边界和治理风险；给出审查简报。';
  if (employee.id === 'general') return '聚焦用户目标、执行方案、交付结构与表达方式；给出行动简报。';
  return `以「${labelEmployee(employee)}」的职责完成简报：${employee.description || '聚焦用户目标并给出可执行建议。'}`;
}

async function persist() { await writeStored('workspace.conversations', JSON.stringify(conversations.value)); }
/** Set inside useWorkspace() once server-backed chat helpers exist. */
let hydrateServerHook: (() => Promise<void>) | null = null;
async function load() {
  await catalog.load();
  try { conversations.value = JSON.parse((await readStored('workspace.conversations')) ?? '[]') as Conversation[]; } catch { conversations.value = []; }
  const employee = await readStored('workspace.default-employee');
  if (employee && employees.value.some((item) => item.id === employee)) currentEmployeeId.value = employee;
  else if (!employees.value.some((item) => item.id === currentEmployeeId.value)) currentEmployeeId.value = employees.value[0]?.id ?? 'general';
  activeConversationId.value = conversations.value[0]?.id ?? null;
  permissionTierByEmployee.value = parsePermissionTiers(await readStored('workspace.permission-tiers'));
  await hydrateServerHook?.();
}
function parsePermissionTiers(value: string | null): Record<string, ExecutionLevel> { try { const parsed = JSON.parse(value || '{}') as Record<string, unknown>; return Object.fromEntries(Object.entries(parsed).filter(([, tier]) => tier === 'read-only' || tier === 'default' || tier === 'full')) as Record<string, ExecutionLevel>; } catch { return {}; } }


export function useWorkspace() {
  const { runtimeProviders, runtimeProvidersFor, load: loadSearchConfig } = useSearchConfig();
  void loadSearchConfig();
  const { get: getEmployeePrefs, load: loadEmployeePrefs } = useEmployeeRuntimePrefs();
  // Do not eager-load prefs here: auth namespace may not be set yet, and a sticky
  // empty load would drop employee engine overrides (falling back to pi).
  const { runtimePayload: mcpRuntimePayload, load: loadMcpConfig, connections: mcpConnectionsState } = useMcpConfig();
  void loadMcpConfig();
  const { runtimePayload: kbRuntimePayload, load: loadKnowledgeConfig } = useKnowledgeConfig();
  void loadKnowledgeConfig();
  const { allowedSkillsFor, policyFor, skills, setExecutionPolicy } = useCapabilities();
  const { archiveArtifact, archiveBundle } = useAssets();
  const { config: autoScheduleConfig, load: loadAutoScheduleConfig } = useAutoScheduleConfig();
  void loadAutoScheduleConfig();
  const { settings: modelSettings, modelForEmployee, modelCapabilitiesForAgent } = useModelConfig();

  const runOptionsFor = (employeeId: EmployeeId, onlineSearch = true) => {
    const prefs = getEmployeePrefs(employeeId);
    const timeouts = {
      runTimeoutMs: prefs.runTimeoutMs || DEFAULT_RUN_TIMEOUT_MS,
      mcpToolTimeoutMs: prefs.mcpToolTimeoutMs || DEFAULT_MCP_TOOL_TIMEOUT_MS,
    };
    const engine = prefs.engine || undefined;
    if (!onlineSearch || prefs.searchMode === 'off') {
      return {
        searchProviders: [] as ReturnType<typeof runtimeProvidersFor>,
        enableBuiltinSearch: false,
        maxSteps: prefs.maxSteps || DEFAULT_MAX_STEPS,
        ...timeouts,
        engine,
        mcpConnections: mcpRuntimePayload(prefs.mcpIds),
        knowledgeBases: kbRuntimePayload(prefs.knowledgeBaseIds, prefs.knowledgeProvider),
        modelCapabilities: modelCapabilitiesForAgent(employeeId, prefs.useApplicationModels),
        decisionRuntime: resolveDecisionRuntime(modelSettings.value),
      };
    }
    const enableBuiltinSearch = prefs.searchMode === 'llm-builtin';
    return {
      searchProviders: enableBuiltinSearch ? [] : runtimeProvidersFor(prefs.searchMode),
      enableBuiltinSearch,
      maxSteps: prefs.maxSteps || DEFAULT_MAX_STEPS,
      ...timeouts,
      engine,
      mcpConnections: mcpRuntimePayload(prefs.mcpIds),
      knowledgeBases: kbRuntimePayload(prefs.knowledgeBaseIds, prefs.knowledgeProvider),
      modelCapabilities: modelCapabilitiesForAgent(employeeId, prefs.useApplicationModels),
      decisionRuntime: resolveDecisionRuntime(modelSettings.value),
    };
  };

  const abortActiveRun = () => {
    const serverRun = activeConversationId.value ? serverActiveRuns.get(activeConversationId.value) : undefined;
    if (serverRun) void orch.cancelChatRun(serverRun.sessionId).catch(() => undefined);
    if (activeRunAbort) {
      activeRunAbort.abort();
      return true;
    }
    return Boolean(serverRun);
  };

  /* ------------------------------------------------------------------ *
   * Server-backed chat sessions (M0)
   *
   * Desktop conversations may live on the orchestration server
   * (`/api/orch/sessions`); the server owns run/approval state machines and
   * the page mirrors it via SSE + polling. Enabled when the renderer runs
   * inside Electron (window.workmateDesktop present) and the caller does not
   * request legacy collaborator briefs.
   * ------------------------------------------------------------------ */

  const serverChatActive = () => Boolean(window.workmateDesktop);
  const serverActiveRuns = new Map<string, { sessionId: string; unsubscribe: () => void }>();
  const serverBump = () => {
    conversations.value = [...conversations.value];
  };

  async function ensureServerSession(conversation: Conversation, firstText: string): Promise<string> {
    if (conversation.serverSessionId) return conversation.serverSessionId;
    const session = await orch.createChatSession({ title: conversation.title || firstText.slice(0, 28), employeeId: conversation.employeeId });
    conversation.serverSessionId = session.id;
    await persist();
    return session.id;
  }

  /** Align a local conversation mirror with the server's canonical session. */
  async function alignServerConversation(conversation: Conversation, sessionId: string): Promise<void> {
    const session = await orch.getChatSession(sessionId);
    if (!session) return;
    // While a run streams, assistant message.content stays empty until settle;
    // live text is on the run transcript — hydrate so mobile/desktop stay in sync.
    const runs = await orch.sessionRuns(sessionId).catch(() => [] as orch.ServerRunRecord[]);
    const liveByRunId = new Map(runs.map((run) => [run.id, run] as const));
    const preserved = new Map<string, Message>(conversation.messages.map((message) => [message.id, message]));
    conversation.messages = session.messages
      .filter((message) => !message.superseded)
      .map((message) => {
        const old = preserved.get(message.id);
        const run = message.runId ? liveByRunId.get(message.runId) : undefined;
        const liveText = run?.transcript?.trim() || '';
        const failedText = run?.status === 'failed' ? `⚠ ${run.error || '回复失败'}` : '';
        const cancelledText = run?.status === 'cancelled' ? `⏹ ${run.error || '已中止'}` : '';
        const base: Message = {
          attachments: message.attachments,
          fileAttachments: message.fileAttachments,
          workflowResult: message.workflowResult,
          id: message.id,
          role: message.role,
          content: message.content || liveText || failedText || cancelledText || old?.content || '',
          runId: message.runId || old?.runId,
          durableTaskId: message.durableTaskId || old?.durableTaskId,
        };
        if (message.role === 'assistant') {
          if (old?.reasoning) base.reasoning = old.reasoning;
          if (old?.schedule) base.schedule = old.schedule;
          // Durable terminal activity state wins over a stale renderer copy.
          // This prevents a locally inferred "completed" row from hiding a
          // persisted capability failure after hydration/navigation.
          base.activities = run?.activities?.length
            ? run.activities.map((activity) => ({ ...activity }))
            : old?.activities ?? [];
          base.approvals = run
            ? run.approvals.filter((approval) => approval.status === 'pending').map(({ id, skillId, capability, summary }) => ({ id, skillId, capability, summary }))
            : old?.approvals ?? [];
          base.assets = old?.assets ?? [];
          base.sources = old?.sources ?? [];
          base.collaborations = old?.collaborations;
          if (old?.engine) base.engine = old.engine;
          Object.assign(base, resolveAssistantTiming(old, run, message.createdAt));
        }
        if (message.role === 'assistant' && run?.engine && !base.engine) base.engine = run.engine;
        return base;
      });
    conversation.title = session.title || conversation.title;
    conversation.updatedAt = session.updatedAt;
    await archiveMissingArtifactsFromRuns(conversation, conversation.messages, runs);
    serverBump();
    await persist();
  }

  async function archiveServerArtifact(conversation: Conversation, assistantMessage: Message, runId: string, relativePath: string) {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!isUserFacingDeliverablePath(normalized)) return;
    try {
      // SITE packages: archive index.html as one bundle. Standalone deliverables
      // under output/ (xlsx/pdf/md/…) must still become asset-library cards —
      // the previous "only index.html" gate dropped Excel/PDF from server chat
      // even when the run had already registered them.
      const asset = normalized === 'output/index.html'
        ? await archiveBundle({ runId, conversationId: conversation.serverSessionId, employeeId: conversation.employeeId })
        : await archiveArtifact({ runId, relativePath: normalized, conversationId: conversation.serverSessionId, employeeId: conversation.employeeId });
      if (!assistantMessage.assets) assistantMessage.assets = [];
      const current = assistantMessage.assets.findIndex((item) => item.id === asset.id);
      if (current >= 0) assistantMessage.assets.splice(current, 1, asset as Asset);
      else if (!assistantMessage.assets.some((item) => item.name === asset.name && item.sizeBytes === asset.sizeBytes)) {
        assistantMessage.assets.push(asset as Asset);
      }
      serverBump();
    } catch (error) {
      const message = error instanceof Error ? error.message : '资产归档失败。';
      if (/Only business deliverables|Only user-facing deliverables|no longer available/i.test(message)) return;
      if (!assistantMessage.activities) assistantMessage.activities = [];
      assistantMessage.activities.push({ toolName: 'archive_asset', status: 'failed', summary: message });
    }
  }

  /** Phone-originated turns miss the desktop SSE archive hook — catch up from run.artifacts. */
  async function archiveMissingArtifactsFromRuns(
    conversation: Conversation,
    messages: Message[],
    runs: orch.ServerRunRecord[],
  ) {
    for (const run of runs) {
      if (!run.artifacts?.length || run.status === 'running') continue;
      const assistantMessage = messages.find((message) => message.role === 'assistant' && message.runId === run.id);
      if (!assistantMessage) continue;
      if (!assistantMessage.assets) assistantMessage.assets = [];
      for (const artifact of run.artifacts) {
        const name = artifact.path.split('/').pop() || artifact.path;
        if (assistantMessage.assets.some((item) => item.name === name)) continue;
        await archiveServerArtifact(conversation, assistantMessage, run.id, artifact.path);
      }
    }
  }

  /**
   * Merge a settled server turn into the local mirror without discarding the
   * SSE-collected detail of this turn. The server owns durable message ids and
   * the final assistant text (it persists content only after the run settles),
   * so we adopt the server ids/content for THIS turn while keeping the local
   * activities/approvals/assets gathered live via SSE.
   */
  async function syncServerTurnToMirror(conversation: Conversation, userMessage: Message, assistantMessage: Message, sessionId: string, runId: string): Promise<void> {
    const session = await orch.getChatSession(sessionId);
    if (!session) return;
    const visible = session.messages.filter((message) => !message.superseded);
    const serverUser = [...visible].reverse().find((message) => message.role === 'user' && message.content === userMessage.content);
    const serverAssistant = visible.find((message) => message.role === 'assistant' && message.runId === runId);
    if (serverUser && userMessage.id !== serverUser.id) userMessage.id = serverUser.id;
    if (serverAssistant) {
      if (assistantMessage.id !== serverAssistant.id) assistantMessage.id = serverAssistant.id;
      // Adopt the durable final text. This is what makes the reply appear even
      // when deltas were missed (SSE gap) or the run outlived the subscription.
      if (serverAssistant.content && assistantMessage.content !== serverAssistant.content) assistantMessage.content = serverAssistant.content;
      assistantMessage.durableTaskId = serverAssistant.durableTaskId;
    }
    assistantMessage.runId = runId;
    const runs = await orch.sessionRuns(sessionId).catch(() => [] as orch.ServerRunRecord[]);
    const run = runs.find((item) => item.id === runId);
    if (!assistantMessage.engine && run?.engine) assistantMessage.engine = run.engine;
    Object.assign(assistantMessage, resolveAssistantTiming(assistantMessage, run, serverAssistant?.createdAt));
    if (run?.artifacts?.length) {
      await archiveMissingArtifactsFromRuns(conversation, [assistantMessage], [run]);
    }
    conversation.updatedAt = session.updatedAt;
    serverBump();
    await persist();
  }

  async function serverChatTurn(
    conversation: Conversation,
    userMessage: Message,
    assistantMessage: Message,
    text: string,
    model: ProviderConfig,
    skillIds?: string[],
    onRunAccepted?: (sessionId: string, runId: string) => void,
  ) {
    const sessionId = await ensureServerSession(conversation, text);
    const previous = serverActiveRuns.get(conversation.id);
    if (previous) previous.unsubscribe();

    const abort = new AbortController();
    activeRunAbort = abort;
    // Subscribe BEFORE posting the message so no early run event (first delta,
    // approval/activity, artifact…) is lost between the POST and the subscribe.
    // Until sendChatMessage returns the runId, buffer events then replay — do not
    // drop early deltas (that looked like "wait for full answer then dump").
    let currentRunId: string | null = null;
    const pendingEvents: orch.OrcEvent[] = [];
    let sseLive = false;
    let sseResolved = false;
    let sseError: string | null = null;

    let settleRun: ((info: { status?: string; error?: string }) => void) | null = null;
    const settledViaSse = new Promise<{ status?: string; error?: string }>((resolve) => {
      settleRun = resolve;
    });

    const applyServerEvent = (event: orch.OrcEvent) => {
      if (event.runId && currentRunId && event.runId !== currentRunId) return;
      if (event.type === 'run.settled') {
        if (event.status === 'failed' || event.status === 'cancelled') {
          markActivitiesInterrupted(assistantMessage.activities);
          serverBump();
        } else if (event.status === 'completed') {
          markActivitiesSettled(assistantMessage.activities);
          serverBump();
        }
        settleRun?.({ status: event.status, error: event.error });
        settleRun = null;
        return;
      }
      if (event.type === 'run.engine' && event.engine) {
        assistantMessage.engine = event.engine;
        serverBump();
      } else if (event.type === 'run.reasoning.delta' && event.text) {
        assistantMessage.reasoning = `${assistantMessage.reasoning || ''}${event.text}`;
        serverBump();
      } else if (event.type === 'run.delta' && event.text) {
        assistantMessage.content += event.text;
        serverBump();
      } else if (event.type === 'run.activity' && event.activity) {
        const activity = event.activity;
        mergeToolActivity(assistantMessage.activities ??= [], activity);
        serverBump();
      } else if (event.type === 'run.approval' && event.approval) {
        const approval = event.approval;
        if (!assistantMessage.approvals?.some((item) => item.skillId === approval.skillId && item.capability === approval.capability)) {
          assistantMessage.approvals?.push({ id: approval.id, skillId: approval.skillId, capability: approval.capability, summary: approval.summary });
          serverBump();
        }
      } else if (event.type === 'run.artifact' && event.artifact && event.runId) {
        void archiveServerArtifact(conversation, assistantMessage, event.runId, event.artifact.path);
      } else if (event.type === 'run.sources' && event.sources) {
        assistantMessage.sources = event.sources.map((source) => ({ ...source, provider: String(event.provider ?? '') }));
        serverBump();
      }
    };

    const unsubscribe = orch.subscribeSessionEvents(
      sessionId,
      (event) => {
        if (!currentRunId) {
          pendingEvents.push(event);
          return;
        }
        applyServerEvent(event);
      },
      {
        signal: abort.signal,
        onStatus: (status, detail) => {
          sseResolved = true;
          if (status === 'open') {
            sseLive = true;
            sseError = null;
            return;
          }
          if (status === 'error') {
            sseLive = false;
            sseError = detail || 'SSE stream failed';
            console.warn(`[workmate] session SSE unavailable (${sseError}); falling back to run.transcript polling`);
          } else if (status === 'closed') {
            sseLive = false;
          }
        },
      },
    );
    serverActiveRuns.set(conversation.id, { sessionId, unsubscribe });
    try {
      // Prefer renderer-assembled context (includes employee MCP prefs). Server
      // KV fallback alone misses unsynced / never-saved runtime prefs.
      await loadEmployeePrefs();
      await loadMcpConfig({ force: mcpConnectionsState.value.length === 0 });
      const employee = employees.value.find((item) => item.id === conversation.employeeId) ?? currentEmployee.value;
      const onlineSearch = getEmployeePrefs(employee.id).searchMode !== 'off';
      const opts = runOptionsFor(employee.id, onlineSearch);
      if (opts.engine) {
        console.info(`[workmate] chat context engine override: ${opts.engine}`);
      } else {
        console.info('[workmate] chat context engine: inherit global default');
      }
      const skills = await skillRuntimeFor(employee.id, skillIds);
      const runModel = modelForEmployee(employee.id, model) ?? model;
      const context = {
        profile: {
          id: employee.id,
          name: labelEmployee(employee),
          toolIds: skills.map((skill) => skill.id),
          instructions: profileInstructions(employee),
        },
        model: toModelPayload(runModel, { enableSearch: opts.enableBuiltinSearch }),
        skills,
        searchProviders: opts.searchProviders,
        mcpConnections: opts.mcpConnections,
        knowledgeBases: opts.knowledgeBases,
        modelCapabilities: opts.modelCapabilities,
        decisionRuntime: opts.decisionRuntime,
        maxSteps: opts.maxSteps,
        runTimeoutMs: opts.runTimeoutMs,
        mcpToolTimeoutMs: opts.mcpToolTimeoutMs,
        ...(opts.engine ? { engine: opts.engine } : {}),
      };
      if (!context.mcpConnections.length) {
        console.warn('[workmate] chat context has 0 MCP connectors; server may backfill from KV');
      } else {
        console.info(`[workmate] chat context MCP connectors: ${context.mcpConnections.map((item) => item.name).join(', ')}`);
      }
      const result = await orch.sendChatMessage(sessionId, {
        content: text,
        attachments: userMessage.attachments,
        fileAttachments: userMessage.fileAttachments,
        workflowResult: userMessage.workflowResult,
        employeeId: conversation.employeeId,
        context,
      });
      const runId = result.runId;
      currentRunId = runId;
      // Observer failures must never turn an accepted task into a send failure.
      try { onRunAccepted?.(sessionId, runId); } catch (cause) { console.warn('Run observer failed', cause); }
      for (const event of pendingEvents) applyServerEvent(event);
      pendingEvents.length = 0;
      await waitForServerSettled(sessionId, runId, abort, assistantMessage, () => ({ sseLive, sseResolved, sseError }), settledViaSse, opts.runTimeoutMs);
    } finally {
      unsubscribe();
      serverActiveRuns.delete(conversation.id);
      if (activeRunAbort === abort) activeRunAbort = null;
    }
    if (abort.signal.aborted || !currentRunId) {
      const reason = abort.signal.reason instanceof Error
        ? abort.signal.reason.message
        : typeof abort.signal.reason === 'string'
          ? abort.signal.reason
          : '已由用户中止当前执行。';
      throw Object.assign(new Error(reason || '已由用户中止当前执行。'), { name: 'AbortError' });
    }
    await syncServerTurnToMirror(conversation, userMessage, assistantMessage, sessionId, currentRunId);
    {
      const runs = await orch.sessionRuns(sessionId).catch(() => [] as orch.ServerRunRecord[]);
      const run = runs.find((item) => item.id === currentRunId);
      if (run && (run.status === 'failed' || run.status === 'cancelled')) {
        markActivitiesInterrupted(assistantMessage.activities);
        appendUnfinishedDeliverableNotice(assistantMessage);
      } else if (run?.status === 'completed') {
        markActivitiesSettled(assistantMessage.activities);
      }
      if (!assistantMessage.content.trim()) {
        if (run?.error) {
          appendAssistantNotice(assistantMessage, `⚠ ${friendlyAssistantError(run.error)}`);
          appendUnfinishedDeliverableNotice(assistantMessage);
          serverBump();
        }
      } else if (run && (run.status === 'failed' || run.status === 'cancelled') && run.error) {
        const friendly = friendlyAssistantError(run.error);
        if (!assistantMessage.content.includes(friendly)) {
          appendAssistantNotice(assistantMessage, `⚠ ${friendly}`);
          appendUnfinishedDeliverableNotice(assistantMessage);
          serverBump();
        }
      }
    }
    return {
      conversationId: conversation.id,
      transcript: {
        prompt: userMessage.content,
        conversationId: conversation.id,
        assistantContent: assistantMessage.content,
        reasoningContent: assistantMessage.reasoning,
        activities: [...(assistantMessage.activities ?? [])],
        approvals: [...(assistantMessage.approvals ?? [])],
        assets: (assistantMessage.assets ?? []).map((asset) => ({ id: asset.id, name: asset.name, sizeBytes: asset.sizeBytes })),
        runId: currentRunId,
      },
    };
  }

  /**
   * Wait until a server run is truly settled and durable.
   *
   * Prefer SSE `run.settled` (already published by RunEngine). Aggressive 300ms
   * dual polling of session+runs was burning CPU and log noise during the whole
   * model-generation window. Sparse poll remains only as backup / transcript
   * hydration when SSE is down or silent.
   *
   * The renderer never cancels a server run merely because its visible state is
   * quiet. Long-running encoders and converters may legitimately produce no
   * output for minutes; the server-side configured run timeout is authoritative.
   */
  async function waitForServerSettled(
    sessionId: string,
    runId: string,
    abort: AbortController,
    assistantMessage: Message,
    sseState?: () => { sseLive: boolean; sseResolved: boolean; sseError: string | null },
    settledViaSse?: Promise<{ status?: string; error?: string }>,
    requestedRunTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  ): Promise<void> {
    // The UI watcher must outlive the authoritative server run budget. A fixed
    // 12-minute deadline used to cancel healthy 30-minute encoding jobs.
    const deadline = Date.now() + Math.max(DEFAULT_RUN_TIMEOUT_MS, requestedRunTimeoutMs) + 120_000;
    const POLL_MS_SSE_LIVE = 15_000;
    const POLL_MS_FALLBACK = 800;
    let lastFingerprint = '';
    let lastProgressAt = Date.now();
    let warnedSseGap = false;
    let settled = false;

    const markSettled = () => { settled = true; };
    if (settledViaSse) {
      void settledViaSse.then(markSettled, () => undefined);
    }

    while (Date.now() < deadline) {
      if (abort.signal.aborted) return;
      if (settled) {
        // Session assistant text is written after run.settled; brief catch-up.
        for (let i = 0; i < 6; i += 1) {
          if (abort.signal.aborted) return;
          const [session, runs] = await Promise.all([
            orch.getChatSession(sessionId).catch(() => null),
            orch.sessionRuns(sessionId).catch(() => [] as orch.ServerRunRecord[]),
          ]);
          const run = runs.find((item) => item.id === runId);
          const assistant = session?.messages.find(
            (message) => message.role === 'assistant' && message.runId === runId,
          );
          if (run?.transcript && run.transcript.length > assistantMessage.content.length) {
            const local = assistantMessage.content;
            const remote = run.transcript;
            if (remote.startsWith(local) || !local.trim()) {
              assistantMessage.content = remote;
              serverBump();
            }
          }
          if (run?.engine && assistantMessage.engine !== run.engine) {
            assistantMessage.engine = run.engine;
            serverBump();
          }
          const contentReady = Boolean(assistant?.content.trim()) || Boolean(run?.transcript?.trim()) || Boolean(assistantMessage.content.trim());
          const errored = run?.status === 'failed' || run?.status === 'cancelled';
          const parked = run?.status === 'waiting-approval';
          if (contentReady || errored || parked || !run || run.status !== 'running') return;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return;
      }

      const status = sseState?.();
      const sseOk = Boolean(status?.sseLive && !status.sseError);
      const needsPollHydration = Boolean(
        status?.sseResolved && (!status.sseLive || status.sseError || !assistantMessage.content.trim()),
      );

      if (needsPollHydration || !sseOk || Date.now() - lastProgressAt >= POLL_MS_SSE_LIVE) {
        const [session, runs] = await Promise.all([
          orch.getChatSession(sessionId).catch(() => null),
          orch.sessionRuns(sessionId).catch(() => [] as orch.ServerRunRecord[]),
        ]);
        const run = runs.find((item) => item.id === runId);
        const assistant = session?.messages.find(
          (message) => message.role === 'assistant' && message.runId === runId,
        );

        const preferTranscript = Boolean(status?.sseResolved && (!status.sseLive || status.sseError));
        const silentSseGap = Boolean(
          status?.sseLive
          && !assistantMessage.content.trim()
          && (run?.transcript?.length ?? 0) > 0
          && Date.now() - lastProgressAt >= 1_500,
        );
        if ((preferTranscript || silentSseGap) && run?.transcript) {
          const local = assistantMessage.content;
          const remote = run.transcript;
          if (remote.length > local.length && (remote.startsWith(local) || !local.trim())) {
            assistantMessage.content = remote;
            serverBump();
            if (!warnedSseGap) {
              warnedSseGap = true;
              console.warn('[workmate] adopted run.transcript via poll (SSE gap or offline)');
            }
          }
        }
        if (run?.reasoning) {
          const localReasoning = assistantMessage.reasoning || '';
          const remoteReasoning = run.reasoning;
          if (remoteReasoning.length > localReasoning.length && (remoteReasoning.startsWith(localReasoning) || !localReasoning.trim())) {
            assistantMessage.reasoning = remoteReasoning;
            serverBump();
          }
        }
        if (run?.engine && assistantMessage.engine !== run.engine) {
          assistantMessage.engine = run.engine;
          serverBump();
        }
        if (run?.activities?.length) {
          let activitiesChanged = false;
          for (const activity of run.activities) {
            mergeToolActivity(assistantMessage.activities ??= [], activity);
            activitiesChanged = true;
          }
          if (activitiesChanged) serverBump();
        }

        if (run && run.status !== 'running') {
          const contentReady = Boolean(assistant?.content.trim()) || Boolean(run.transcript?.trim()) || Boolean(assistantMessage.content.trim());
          const errored = run.status === 'failed' || run.status === 'cancelled';
          const parked = run.status === 'waiting-approval';
          if (errored) markActivitiesInterrupted(assistantMessage.activities);
          else if (run.status === 'completed') markActivitiesSettled(assistantMessage.activities);
          if (contentReady || errored || parked) return;
        }

        const fingerprint = [
          run?.status ?? 'missing',
          run?.transcript?.length ?? 0,
          run?.activities?.length ?? 0,
          assistant?.content?.length ?? 0,
          run?.error ?? '',
        ].join('|');
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          lastProgressAt = Date.now();
        }
      } else if (assistantMessage.content.trim()) {
        lastProgressAt = Date.now();
      }

      const pollMs = sseOk && !needsPollHydration ? POLL_MS_SSE_LIVE : POLL_MS_FALLBACK;
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, pollMs)),
        settledViaSse?.then(() => undefined) ?? new Promise<void>(() => undefined),
      ]);
    }
    await orch.cancelChatRun(sessionId).catch(() => undefined);
    abort.abort(new Error('等待模型回合结束超时，已自动中止。'));
  }

  async function hydrateServerConversations(): Promise<void> {
    if (!serverChatActive()) return;
    const sessions = await orch.listChatSessions().catch(() => [] as orch.ServerChatSession[]);
    if (!sessions.length) return;
    const next = [...conversations.value];
    const byServerId = new Map(next.filter((c) => c.serverSessionId).map((c) => [c.serverSessionId!, c]));
    for (const session of sessions) {
      const existing = byServerId.get(session.id);
      if (existing) {
        await alignServerConversation(existing, session.id).catch(() => undefined);
      } else {
        const conversation: Conversation = {
          id: crypto.randomUUID(),
          title: session.title || '服务端会话',
          employeeId: session.employeeId,
          messages: [],
          updatedAt: session.updatedAt,
          serverSessionId: session.id,
        };
        next.unshift(conversation);
        await alignServerConversation(conversation, session.id).catch(() => undefined);
      }
    }
    conversations.value = next;
  }
  hydrateServerHook = hydrateServerConversations;

  const permissionTier = computed<ExecutionLevel>(() => permissionTierByEmployee.value[currentEmployeeId.value] ?? 'default');
  /** Avoid re-reading every Skill file on consecutive turns / double-load in addMessage. */
  const skillRuntimeCache = new Map<string, { at: number; skills: RuntimeSkill[] }>();
  const SKILL_RUNTIME_CACHE_TTL_MS = 45_000;
  const skillRuntimeFor = async (employeeId: EmployeeId, onlySkillIds?: string[], tierOverride?: ExecutionLevel): Promise<RuntimeSkill[]> => {
    const tier = tierOverride ?? permissionTierByEmployee.value[employeeId] ?? 'default';
    const grantKey = [...sessionGrants.entries()]
      .map(([id, caps]) => `${id}:${[...caps].sort().join('+')}`)
      .sort()
      .join(',');
    const filterKey = onlySkillIds?.length ? [...onlySkillIds].sort().join(',') : '*';
    const cacheKey = `${employeeId}|${tier}|${filterKey}|${grantKey}`;
    const cached = skillRuntimeCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SKILL_RUNTIME_CACHE_TTL_MS) {
      return cached.skills.map((skill) => ({
        ...skill,
        resources: skill.resources ? [...skill.resources] : [],
        execution: { ...skill.execution },
      }));
    }
    const authorized = allowedSkillsFor(employeeId).filter((skill) => !onlySkillIds?.length || onlySkillIds.includes(skill.id)).sort((left, right) => (policyFor(employeeId, right.id)?.mode === 'default' ? 1 : 0) - (policyFor(employeeId, left.id)?.mode === 'default' ? 1 : 0));
    const userSkills = await Promise.all(authorized.map(async (skill) => {
      const mode = policyFor(employeeId, skill.id)?.mode === 'default' ? 'default' as const : 'available' as const;
      let instructions: string | undefined;
      let resources: RuntimeSkill['resources'] = [];
      const rootPath = skill.path?.replace(/[\\/][^\\/]+$/, '');
      // Pre-hydrate associated skills before the first model turn so the agent can
      // reason with domain-specific instructions immediately instead of racing
      // with a later load_skill call.
      const engine = getEmployeePrefs(employeeId).engine;
      const hydrateForDsh = engine === 'dsh';
      const hydrateForPi = engine === 'pi';
      const shouldHydrateSkillBody = mode === 'default' || hydrateForDsh || hydrateForPi;
      if (shouldHydrateSkillBody && skill.path) {
        try {
          const api = await import('../services/api');
          instructions = (await api.readSkillFile(skill.path)).content.slice(0, 24_000);
          const files = await api.listSkillFiles(skill.path);
          const readable = files.filter((file) => file.type === 'file' && file.relative !== 'SKILL.md' && /\.(md|txt|json|ya?ml)$/i.test(file.relative)).slice(0, 20);
          resources = (await Promise.all(readable.map(async (file) => {
            try { const result = await api.readSkillFile(file.path); return result ? { path: file.relative, content: result.content.slice(0, 48_000) } : null; } catch { return null; }
          }))).filter((item): item is { path: string; content: string } => item !== null);
        } catch { /* Fall back to embedded instructions / description below. */ }
      }
      if (!instructions && shouldHydrateSkillBody && skill.instructions) {
        instructions = skill.instructions.slice(0, 24_000);
      } else if (!instructions && shouldHydrateSkillBody && skill.description) {
        instructions = skill.description.slice(0, 24_000);
      }
      return {
        id: skill.id, name: skill.name, description: skill.description, mode, ...(rootPath ? { rootPath } : {}), ...(instructions ? { instructions } : {}), resources,
        // Persisted per-Skill permissions are deny-by-default and are enforced
        // again by Agent Core; they are not model-controlled.
        execution: {
          ...skill.execution,
          allowWorkspaceWrite: tier !== 'read-only' && (skill.execution.allowWorkspaceWrite || sessionGrants.get(skill.id)?.has('workspace-write') === true),
          allowScriptExecution: tier !== 'read-only' && (skill.execution.allowScriptExecution || sessionGrants.get(skill.id)?.has('script-execution') === true),
          allowAllNonDestructive: tier === 'full',
        },
      };
    }));
    const merged = userSkills.map((skill) => ({
      ...skill,
      execution: {
        ...skill.execution,
        allowWorkspaceWrite: skill.execution.allowWorkspaceWrite || sessionGrants.get(skill.id)?.has('workspace-write') === true,
        allowScriptExecution: skill.execution.allowScriptExecution || sessionGrants.get(skill.id)?.has('script-execution') === true,
      },
    }));
    skillRuntimeCache.set(cacheKey, { at: Date.now(), skills: merged });
    return merged;
  };
  const activeConversation = computed(() => conversations.value.find((item) => item.id === activeConversationId.value) ?? null);
  const currentEmployee = computed(() => employees.value.find((item) => item.id === currentEmployeeId.value) ?? employees.value[0]);
  const setView = (value: View) => { view.value = value; };
  const flushLeavingConversation = (leavingId: string | null) => {
    if (!leavingId) return;
    const leaving = conversations.value.find((item) => item.id === leavingId);
    const sessionId = leaving?.serverSessionId;
    if (!sessionId) return;
    void orch.flushChatSessionMemory(sessionId).catch(() => undefined);
  };
  const startChat = (employeeId: EmployeeId = currentEmployeeId.value) => {
    flushLeavingConversation(activeConversationId.value);
    currentEmployeeId.value = employeeId;
    activeConversationId.value = null;
    view.value = 'chat';
  };
  /** Open a fresh conversation and immediately send a prepared prompt (e.g. data customize). */
  const startChatWithPrompt = async (
    prompt: string,
    model: ProviderConfig,
    options: { employeeId?: EmployeeId; title?: string } = {},
  ) => {
    const text = prompt.trim();
    if (!text) return undefined;
    flushLeavingConversation(activeConversationId.value);
    if (options.employeeId) currentEmployeeId.value = options.employeeId;
    activeConversationId.value = null;
    view.value = 'chat';
    return addMessage(text, model, { newConversation: true, employeeId: options.employeeId });
  };
  const selectConversation = (id: string) => {
    const conversation = conversations.value.find((item) => item.id === id);
    if (!conversation) return;
    if (activeConversationId.value && activeConversationId.value !== id) {
      flushLeavingConversation(activeConversationId.value);
    }
    activeConversationId.value = id;
    currentEmployeeId.value = conversation.employeeId;
    view.value = 'chat';
  };
  const clearConversation = async (id: string) => {
    const conversation = conversations.value.find((item) => item.id === id);
    if (!conversation) return;
    const serverRun = serverActiveRuns.get(id);
    if (serverRun) { serverRun.unsubscribe(); serverActiveRuns.delete(id); }
    if (conversation.serverSessionId) {
      const session = await orch.clearChatSession(conversation.serverSessionId);
      conversation.serverSessionId = session.id;
    }
    conversation.messages = [];
    conversation.title = '新对话';
    conversation.updatedAt = Date.now();
    conversations.value = [...conversations.value];
    await persist();
  };
  const deleteConversation = async (id: string) => {
    const conversation = conversations.value.find((item) => item.id === id);
    const index = conversations.value.findIndex((item) => item.id === id);
    if (index < 0) return;
    const serverRun = serverActiveRuns.get(id);
    if (serverRun) serverRun.unsubscribe();
    if (conversation?.serverSessionId) {
      await orch.deleteChatSession(conversation.serverSessionId).catch(() => undefined);
    }
    conversations.value = conversations.value.filter((item) => item.id !== id);
    if (activeConversationId.value === id) activeConversationId.value = conversations.value[0]?.id ?? null;
    await persist();
  };
  const selectEmployee = (id: EmployeeId) => { currentEmployeeId.value = id; };
  const setDefaultEmployee = (id: EmployeeId) => { currentEmployeeId.value = id; void writeStored('workspace.default-employee', id); };
  const setPermissionTier = (tier: ExecutionLevel) => { permissionTierByEmployee.value = { ...permissionTierByEmployee.value, [currentEmployeeId.value]: tier }; void writeStored('workspace.permission-tiers', JSON.stringify(permissionTierByEmployee.value)); };
  const createEmployee = async (draft: EmployeeDraft) => catalog.create(draft);
  const updateEmployee = async (id: EmployeeId, draft: EmployeeDraft) => catalog.update(id, draft);
  const resetEmployee = async (id: EmployeeId) => catalog.resetPreset(id);
  const hasEmployeeOverride = (id: EmployeeId) => catalog.hasPresetOverride(id);
  const removeEmployee = async (id: EmployeeId) => {
    await catalog.remove(id);
    if (currentEmployeeId.value === id) {
      currentEmployeeId.value = employees.value[0]?.id ?? 'general';
      void writeStored('workspace.default-employee', currentEmployeeId.value);
    }
  };
  const addMessage = async (content: string, model: ProviderConfig, options: { workflowResult?: import('@workmate/contracts').WorkflowResultReference; attachments?: import('@workmate/contracts').ChatImageAttachment[]; fileAttachments?: import('@workmate/contracts').ChatFileAttachment[]; employeeId?: EmployeeId; skillIds?: string[]; collaboratorIds?: EmployeeId[]; collaborationDelivery?: CollaborationDelivery; newConversation?: boolean; onlineSearch?: boolean; autoSchedule?: boolean; onRunAccepted?: (sessionId: string, runId: string) => void } = {}) => {
    const text = content.trim(); if (!text) return undefined;
    if (options.workflowResult && (options.autoSchedule || options.collaboratorIds?.length || options.attachments?.length || options.fileAttachments?.length)) throw new Error('成果问答不支持自动调度、协作者或混入附件。');
    const hasImages = !options.workflowResult && Boolean(options.attachments?.length || activeConversation.value?.messages.some((message) => message.attachments?.length));
    if (hasImages && (options.autoSchedule || options.collaboratorIds?.length)) throw new Error('含图片的会话暂只支持单员工对话，请关闭自动调度并移除协作者。');
    const effectiveModel = modelForEmployee(options.employeeId ?? activeConversation.value?.employeeId ?? currentEmployeeId.value, model) ?? model;
    const visionEmployeeId = options.employeeId ?? activeConversation.value?.employeeId ?? currentEmployeeId.value;
    const visionService = modelCapabilitiesForAgent(visionEmployeeId, getEmployeePrefs(visionEmployeeId).useApplicationModels).find((item) => item.capability === 'vision');
    if (hasImages && !effectiveModel.supportsVision && !visionService) throw new Error('请使用视觉主模型，或绑定“图片理解”应用模型并为员工开启该能力。');
    chatBusy.value = true;
    try {
    if (options.employeeId) currentEmployeeId.value = options.employeeId;
    if (options.newConversation) activeConversationId.value = null;
    let conversation = activeConversation.value;
    if (!conversation) {
      conversation = { id: crypto.randomUUID(), title: text.slice(0, 28), employeeId: currentEmployeeId.value, messages: [], updatedAt: Date.now() };
      conversations.value.unshift(conversation); activeConversationId.value = conversation.id;
    }
    conversation.messages.push({ id: crypto.randomUUID(), role: 'user', content: text, workflowResult: options.workflowResult, attachments: options.attachments, fileAttachments: options.fileAttachments });
    const userMessage = conversation.messages[conversation.messages.length - 1];
    conversation.updatedAt = Date.now();
    conversations.value = [...conversations.value].sort((a, b) => b.updatedAt - a.updatedAt);
    void persist();
    const employee = currentEmployee.value;
    conversation.messages.push({ id: crypto.randomUUID(), role: 'assistant', content: '', activities: [], approvals: [], assets: [], collaborations: [], startedAt: Date.now() });
    // Use the reactive proxy from the array so stream mutations invalidate UI computeds.
    const assistantMessage = conversation.messages[conversation.messages.length - 1];

    const bump = () => { conversations.value = [...conversations.value]; };

    const runChatAutoSchedule = async () => {
      activeRunAbort?.abort();
      const runAbort = new AbortController();
      activeRunAbort = runAbort;
      const throwIfAborted = () => {
        if (runAbort.signal.aborted) throw Object.assign(new Error('已由用户中止当前执行。'), { name: 'AbortError' });
      };

      assistantMessage.schedule = { status: 'planning', mode: 'dag', tasks: [] };
      assistantMessage.content = '🧭 自动调度：正在根据可用数字员工规划 DAG…';
      bump();

      // Keep assets on this chat session (same id used by session archives).
      let sessionAssetId = conversation.serverSessionId || conversation.id;
      if (serverChatActive()) {
        sessionAssetId = await ensureServerSession(conversation, text);
      }

      const visibleEmployeeIds = employees.value.map((item) => item.id);
      const schedulePrefs = autoScheduleConfig.value;
      const draft = await generateProjectDraft(text, model, {
        preferredMode: 'dag',
        employeeIds: visibleEmployeeIds,
        primaryEmployeeId: employee.id,
        preferMinimal: schedulePrefs.preferMinimal,
        strongFitOnly: schedulePrefs.strongFitOnly,
        maxAgents: schedulePrefs.maxAgents,
      });
      throwIfAborted();

      const scheduleTasks: ScheduleTaskRun[] = draft.tasks.map((task, index) => ({
        id: `t${index}`,
        title: task.title,
        objective: task.objective,
        employeeId: task.employeeId,
        skillIds: task.skillIds ?? [],
        dependsOn: (task.dependsOn ?? []).map((dep) => `t${dep}`),
        status: 'queued',
        summary: '',
        activities: [],
        assets: [],
      }));

      assistantMessage.schedule = {
        status: 'running',
        mode: 'dag',
        rationale: draft.modeRationale,
        tasks: scheduleTasks,
        selectedTaskId: scheduleTasks[0]?.id,
      };
      assistantMessage.content = `🧭 已规划 ${scheduleTasks.length} 个任务（${draft.suggestedMode}），开始调度执行…\n${draft.modeRationale ? `\n规划说明：${draft.modeRationale}` : ''}`;
      bump();

      // One shared workspace for the whole schedule so downstream agents can read upstream deliverables.
      let sharedWorkspace = '';
      try {
        sharedWorkspace = await createManagedWorkspace(`chat-sched-${conversation.id.slice(0, 8)}`);
      } catch {
        sharedWorkspace = '';
      }

      const byId = new Map(scheduleTasks.map((task) => [task.id, task]));
      const pending = new Set(scheduleTasks.map((task) => task.id));

      while (pending.size) {
        throwIfAborted();
        const ready = [...pending].filter((id) => {
          const task = byId.get(id)!;
          return task.dependsOn.every((dep) => byId.get(dep)?.status === 'completed');
        });

        if (!ready.length) {
          for (const id of [...pending]) {
            const task = byId.get(id)!;
            const blocked = task.dependsOn.some((dep) => {
              const status = byId.get(dep)?.status;
              return status === 'failed' || status === 'cancelled';
            });
            if (blocked) {
              task.status = 'cancelled';
              task.error = '依赖任务未完成，已跳过。';
              pending.delete(id);
            }
          }
          if (![...pending].some((id) => {
            const task = byId.get(id)!;
            return task.dependsOn.every((dep) => byId.get(dep)?.status === 'completed');
          })) {
            break;
          }
          continue;
        }

        await Promise.all(ready.map(async (taskId) => {
          const task = byId.get(taskId)!;
          pending.delete(taskId);
          task.status = 'running';
          if (!assistantMessage.schedule?.selectedTaskId) {
            assistantMessage.schedule!.selectedTaskId = task.id;
          }
          bump();
          const agent = employees.value.find((item) => item.id === task.employeeId) ?? employee;
          let lastRunId = '';
          try {
            const skills = await skillRuntimeFor(agent.id, task.skillIds.length ? task.skillIds : undefined);
            const opts = runOptionsFor(agent.id, options.onlineSearch ?? true);
            const agentModel = modelForEmployee(agent.id, model) ?? model;
            const dependencyBrief = task.dependsOn
              .map((dep) => byId.get(dep))
              .filter((item): item is ScheduleTaskRun => Boolean(item?.summary.trim()))
              .map((item) => {
                // Keep upstream context short — full agent narration + pasted CSS derails the next node.
                const summary = item.summary.trim().slice(0, 1_200);
                const assets = (item.assets ?? []).map((asset) => asset.name).filter(Boolean).slice(0, 12);
                const assetLine = assets.length ? `\n上游已归档文件：${assets.join(', ')}` : '';
                return `### ${item.title}\n${summary}${item.summary.trim().length > 1_200 ? '…' : ''}${assetLine}`;
              })
              .join('\n\n');
            const upstreamAssets = task.dependsOn
              .flatMap((dep) => byId.get(dep)?.assets ?? [])
              .filter((asset, index, list) => list.findIndex((item) => item.id === asset.id) === index);
            if (sharedWorkspace && upstreamAssets.length) {
              await materializeWorkspaceAssets(
                sharedWorkspace,
                upstreamAssets.map((asset) => ({ assetId: asset.id, name: asset.name })),
              ).catch(() => undefined);
            }
            const prompt = [
              `用户目标：${text}`,
              `你的任务：${task.title}`,
              `任务目标：${task.objective}`,
              dependencyBrief ? `上游任务结果：\n${dependencyBrief}` : '',
              sharedWorkspace
                ? '本轮自动调度会把上游已归档的交付文件同步到当前运行工作区（对话模式）。请按文件名复用，不要把整份 CSS/JS 读回上下文。成品仍须写入 output/。'
                : '上游交付仅以文字摘要提供；请依据摘要继续，不要依赖其它节点的隔离工作区路径。',
              '【对话模式】成品文件必须写入 output/（如 output/index.html、output/assets/…）。网站类任务优先用 CSS 渐变/内联 SVG 占位图，禁止反复编写图片生成脚本。写成功后不要整文件回读。',
            ].filter(Boolean).join('\n\n');

            // Dual workspace modes (pi / dsh / …):
            // - Conversation mode (this chat auto-schedule path): NO projectWorkspacePath.
            //   Agents write under output/ → artifact.created → session asset library.
            // - Project mode (Projects / runProjectTask): pass projectWorkspacePath so the
            //   agent cwd is the project root → project.file.published → project file tree.
            // sharedWorkspace below is only a DAG handoff cache (materialize upstream assets),
            // not project mode — never pass it as projectWorkspacePath.
            await streamChat({
              profile: {
                id: agent.id,
                name: labelEmployee(agent),
                toolIds: skills.map((skill) => skill.id),
                instructions: profileInstructions(agent, 'You are executing one node in an auto-scheduled DAG. Complete only this assigned task. Upstream deliverables may already exist under output/ — reuse by path, do not re-read entire CSS/JS into context. Write every finished user-facing file under output/. For websites prefer CSS gradients/inline SVG placeholders over image-generator scripts. Reply in the user\'s language. Keep visible progress updates on separate lines.'),
              },
              messages: [{ role: 'user', content: prompt }],
              model: toModelPayload(agentModel, { enableSearch: opts.enableBuiltinSearch }),
              skills,
              searchProviders: opts.searchProviders,
              // dsh coding runs already have write/bash; baseline stock/filesystem MCPs
              // slow boot and distract the agent (e.g. mcp filesystem vs dsh write).
              mcpConnections: opts.engine === 'dsh' ? [] : opts.mcpConnections,
              knowledgeBases: opts.knowledgeBases,
              modelCapabilities: opts.modelCapabilities,
              maxSteps: opts.maxSteps,
              runTimeoutMs: opts.runTimeoutMs,
              mcpToolTimeoutMs: opts.mcpToolTimeoutMs,
              ...(opts.engine ? { engine: opts.engine } : {}),
              signal: runAbort.signal,
            }, (delta) => {
              const chunk = String(delta || '');
              if (!chunk) return;
              // Stream deltas already carry their own spaces/newlines — do not inject
              // separators (that turns Chinese tokens into a vertical column in <pre>).
              task.summary += chunk;
              bump();
            }, (activity) => {
              mergeToolActivity(task.activities, activity);
              bump();
            }, (approval) => {
              if (!assistantMessage.approvals?.some((item) => item.skillId === approval.skillId && item.capability === approval.capability)) {
                assistantMessage.approvals?.push(approval);
                bump();
              }
            }, async (artifact) => {
              lastRunId = artifact.runId;
              const normalized = artifact.path.replace(/\\/g, '/').replace(/^\/+/, '');
              if (!isUserFacingDeliverablePath(normalized)) return;
              try {
                const asset = await archiveArtifact({
                  runId: artifact.runId,
                  relativePath: normalized,
                  conversationId: sessionAssetId,
                  employeeId: agent.id,
                });
                if (!task.assets?.some((item) => item.id === asset.id)) {
                  task.assets = [...(task.assets ?? []), { id: asset.id, name: asset.name, sizeBytes: asset.sizeBytes }];
                }
                if (!assistantMessage.assets?.some((item) => item.id === asset.id)) {
                  assistantMessage.assets?.push(asset as Asset);
                }
                bump();
              } catch (error) {
                const message = error instanceof Error ? error.message : '';
                if (/Only business deliverables|Only user-facing deliverables|no longer available/i.test(message)) return;
              }
            });

            if (sharedWorkspace && lastRunId) {
              await syncWorkspaceRun(sharedWorkspace, lastRunId).catch(() => undefined);
              if (task.assets?.length) {
                await materializeWorkspaceAssets(
                  sharedWorkspace,
                  task.assets.map((asset) => ({ assetId: asset.id, name: asset.name })),
                ).catch(() => undefined);
              }
            }

            if (runAbort.signal.aborted) {
              task.status = 'cancelled';
              task.error = '已由用户中止';
              markActivitiesInterrupted(task.activities);
            } else {
              task.status = 'completed';
              if (!task.summary.trim()) task.summary = '（本任务未返回文本。）';
            }
          } catch (cause) {
            if (isAbortError(cause)) {
              task.status = 'cancelled';
              task.error = cause instanceof Error ? cause.message : '已中止';
              markActivitiesInterrupted(task.activities);
            } else if (
              !isHardScheduleFailure(cause)
              && isSoftCompletableStreamError(cause)
              && (task.summary.trim().length >= 80 || (task.assets?.length ?? 0) > 0)
            ) {
              // Only soft-complete genuine mid-stream network drops after useful work.
              task.status = 'completed';
              task.error = undefined;
              if (sharedWorkspace && lastRunId) {
                await syncWorkspaceRun(sharedWorkspace, lastRunId).catch(() => undefined);
              }
            } else {
              task.status = 'failed';
              task.error = friendlyAssistantError(cause instanceof Error ? cause.message : '任务执行失败');
              markActivitiesInterrupted(task.activities);
            }
          }
          bump();
        }));

        // Fail fast: any hard failure cancels the rest of the DAG immediately.
        const failedInWave = ready.some((id) => byId.get(id)?.status === 'failed');
        if (failedInWave) {
          for (const id of [...pending]) {
            const task = byId.get(id)!;
            task.status = 'cancelled';
            task.error = '上游任务失败，已取消后续调度';
            pending.delete(id);
          }
          bump();
          break;
        }
      }

      throwIfAborted();

      const failed = scheduleTasks.filter((task) => task.status === 'failed' || task.status === 'cancelled');
      const completed = scheduleTasks.filter((task) => task.status === 'completed');
      const hardFailed = scheduleTasks.filter((task) => task.status === 'failed');
      assistantMessage.schedule!.status = hardFailed.length
        ? 'failed'
        : failed.length && !completed.length
          ? 'failed'
          : 'completed';

      if (hardFailed.length) {
        const lead = hardFailed[0]!;
        const detail = [lead.summary.trim(), lead.error ? `⚠ ${lead.error}` : '']
          .filter(Boolean)
          .join('\n\n');
        assistantMessage.content = detail
          || `⚠ 自动调度失败：${lead.error || '任务执行失败'}`;
        appendAssistantNotice(assistantMessage, `⚠ ${hardFailed.length} 个任务失败，调度已中止（不再继续后续节点或最终汇总）。`);
        bump();
        return;
      }

      const digest = completed.map((task) => {
        const name = labelEmployee(employees.value.find((item) => item.id === task.employeeId) ?? { id: task.employeeId, color: '#526fe0', initials: 'AI' } as Employee);
        return `### ${task.title} · ${name}\n${task.summary}`;
      }).join('\n\n');

      assistantMessage.content = '🧭 调度执行完成，正在汇总最终答复…\n';
      bump();

      const synthesizeModel = modelForEmployee(employee.id, model) ?? model;
      const synthesizeOpts = runOptionsFor(employee.id, options.onlineSearch ?? true);
      const synthesizeSkills = await skillRuntimeFor(employee.id, options.skillIds);
      let finalText = '';
      await streamChat({
        profile: {
          id: employee.id,
          name: labelEmployee(employee),
          toolIds: [],
          instructions: profileInstructions(employee, 'You are the lead coordinator. Synthesize the scheduled agents\' results into one clear final answer for the user. Do not invent missing deliverables.'),
        },
        messages: [{
          role: 'user',
          content: `用户请求：${text}\n\n各任务结果：\n${digest || '（无成功任务结果）'}\n\n请给出面向用户的最终答复。`,
        }],
        model: toModelPayload(synthesizeModel, { enableSearch: false }),
        skills: [],
        searchProviders: [],
        maxSteps: synthesizeOpts.maxSteps,
        runTimeoutMs: synthesizeOpts.runTimeoutMs,
        signal: runAbort.signal,
      }, (delta) => {
        finalText += delta;
        assistantMessage.content = finalText;
        bump();
      });

      if (!assistantMessage.content.trim()) {
        assistantMessage.content = completed.length
          ? `自动调度已完成 ${completed.length} 个任务。\n\n${digest}`
          : '自动调度未产生可用结果，请重试或关闭自动调度后直接对话。';
      }
      if (failed.length) {
        appendAssistantNotice(assistantMessage, `⚠ ${failed.length} 个任务未成功完成。`);
      }
      bump();
    };

    if (options.autoSchedule) {
      try {
        await runChatAutoSchedule();
        assistantMessage.elapsedMs = Date.now() - (assistantMessage.startedAt ?? Date.now());
        void persist();
        return { conversationId: conversation.id, transcript: { prompt: userMessage.content, conversationId: conversation.id, assistantContent: assistantMessage.content, activities: assistantMessage.activities ?? [], approvals: assistantMessage.approvals ?? [], assets: (assistantMessage.assets ?? []).map((asset) => ({ id: asset.id, name: asset.name, sizeBytes: asset.sizeBytes })) } };
      } catch (cause) {
        assistantMessage.elapsedMs = Date.now() - (assistantMessage.startedAt ?? Date.now());
        if (assistantMessage.schedule) {
          assistantMessage.schedule.status = isAbortError(cause) ? 'cancelled' : 'failed';
          for (const task of assistantMessage.schedule.tasks) {
            if (task.status === 'queued' || task.status === 'running') {
              task.status = 'cancelled';
              task.error = task.error || (isAbortError(cause) ? '已中止' : '调度中断');
            }
          }
        }
        if (isAbortError(cause)) {
          appendAssistantNotice(assistantMessage, `⏹ ${cause instanceof Error ? cause.message : '已由用户中止当前执行。'}`);
          markActivitiesInterrupted(assistantMessage.activities);
        } else {
          appendAssistantNotice(assistantMessage, cause instanceof Error ? `⚠ ${friendlyAssistantError(cause.message)}` : '⚠ 自动调度失败，请稍后重试。');
        }
        void persist();
        return { conversationId: conversation.id, transcript: { prompt: userMessage.content, conversationId: conversation.id, assistantContent: assistantMessage.content, activities: assistantMessage.activities ?? [], approvals: assistantMessage.approvals ?? [], assets: (assistantMessage.assets ?? []).map((asset) => ({ id: asset.id, name: asset.name, sizeBytes: asset.sizeBytes })) } };
      } finally {
        if (activeRunAbort) activeRunAbort = null;
      }
    }

    const plannedCollaborators = [...new Set(options.collaboratorIds ?? [])].filter((cid) => cid !== employee.id).slice(0, 3);
    if ((serverChatActive() || hasImages || options.onRunAccepted || options.workflowResult) && !plannedCollaborators.length) {
      // M0 server-backed turn: the orchestration server owns the run/approval
      // state machine; UI only mirrors deltas and persists the local copy.
      // Skill hydration happens once inside serverChatTurn (avoid double IO here).
      const runAbortCtl = new AbortController();
      activeRunAbort = runAbortCtl;
      try {
        const outcome = await serverChatTurn(conversation, userMessage, assistantMessage, text, model, options.skillIds, options.onRunAccepted);
        assistantMessage.elapsedMs = Date.now() - (assistantMessage.startedAt ?? Date.now());
        conversations.value = [...conversations.value];
        return outcome;
      } catch (cause) {
        assistantMessage.elapsedMs = Date.now() - (assistantMessage.startedAt ?? Date.now());
        if (isAbortError(cause)) {
          const reason = cause instanceof Error ? cause.message : '已由用户中止当前执行。';
          appendAssistantNotice(assistantMessage, `⏹ ${reason}`);
          appendUnfinishedDeliverableNotice(assistantMessage);
          markActivitiesInterrupted(assistantMessage.activities);
        } else {
          appendAssistantNotice(assistantMessage, cause instanceof Error ? `⚠ ${friendlyAssistantError(cause.message)}` : '⚠ 请求失败，请稍后重试。');
          appendUnfinishedDeliverableNotice(assistantMessage);
        }
        void persist();
        return {
          conversationId: conversation.id,
          transcript: {
            prompt: userMessage.content,
            conversationId: conversation.id,
            assistantContent: assistantMessage.content,
            reasoningContent: assistantMessage.reasoning,
            activities: assistantMessage.activities ?? [],
            approvals: assistantMessage.approvals ?? [],
            assets: (assistantMessage.assets ?? []).map((asset) => ({ id: asset.id, name: asset.name, sizeBytes: asset.sizeBytes })),
          },
        };
      }
    }
    const onlineSearch = options.onlineSearch ?? (getEmployeePrefs(employee.id).searchMode !== 'off');
    /** Collaborators inherit the primary employee's search strategy for this turn. */
    const primarySearch = runOptionsFor(employee.id, onlineSearch);
    const skills = await skillRuntimeFor(employee.id, options.skillIds);
    activeRunAbort?.abort();
    const runAbort = new AbortController();
    activeRunAbort = runAbort;
    try {
      const collaboratorIds = [...new Set(options.collaboratorIds ?? [])].filter((id) => id !== employee.id).slice(0, 3);
      // A single selected specialist can own the answer directly. With multiple
      // reports, the primary employee must reconcile scope and possible conflicts.
      assistantMessage.collaborationDelivery = collaboratorIds.length === 1
        ? (options.collaborationDelivery ?? 'direct')
        : 'synthesize';
      if (collaboratorIds.length) {
        assistantMessage.collaborations = collaboratorIds.map((employeeId) => {
          const collaborator = employees.value.find((item) => item.id === employeeId);
          return {
            employeeId,
            task: collaborator ? collaboratorFocus(collaborator) : '聚焦用户目标并给出可执行建议。',
            status: 'running' as const,
            summary: '',
            activities: [],
          };
        });
        conversations.value = [...conversations.value];
        await Promise.all(collaboratorIds.map(async (collaboratorId) => {
          const collaborator = employees.value.find((item) => item.id === collaboratorId);
          const run = assistantMessage.collaborations?.find((item) => item.employeeId === collaboratorId);
          if (!collaborator || !run) return;
          try {
            const collaboratorSkills = await skillRuntimeFor(collaborator.id, undefined, 'read-only');
            const collabOpts = runOptionsFor(collaborator.id, onlineSearch);
            const collaboratorModel = modelForEmployee(collaborator.id, model) ?? model;
            await streamChat({
              profile: {
                id: collaborator.id,
                name: labelEmployee(collaborator),
                toolIds: collaboratorSkills.map((skill) => skill.id),
                instructions: `${profileInstructions(collaborator, `You are acting as a consultation collaborator. Your assigned focus is: ${run.task}`)} Analyze only the assigned user request. Do not delegate, do not write files, do not execute scripts, and return a concise evidence-based brief in the user's language for the primary employee.`,
              },
              messages: [{ role: 'user', content: `用户请求：${text}\n\n你的分工：${run.task}` }],
              model: toModelPayload(collaboratorModel, { enableSearch: primarySearch.enableBuiltinSearch }),
              skills: collaboratorSkills,
              searchProviders: primarySearch.searchProviders,
              mcpConnections: collabOpts.mcpConnections,
              knowledgeBases: collabOpts.knowledgeBases,
              modelCapabilities: collabOpts.modelCapabilities,
              maxSteps: collabOpts.maxSteps,
              runTimeoutMs: collabOpts.runTimeoutMs,
              mcpToolTimeoutMs: collabOpts.mcpToolTimeoutMs,
              ...(collabOpts.engine ? { engine: collabOpts.engine } : {}),
              signal: runAbort.signal,
            }, (delta) => { run.summary += delta; conversations.value = [...conversations.value]; }, (activity) => {
              mergeToolActivity(run.activities, activity);
              conversations.value = [...conversations.value];
            });
            run.status = 'completed';
          } catch (cause) {
            if (isAbortError(cause)) {
              run.status = 'failed';
              run.error = cause instanceof Error ? cause.message : '已中止';
              markActivitiesInterrupted(run.activities);
            } else {
              run.status = 'failed';
              run.error = cause instanceof Error ? cause.message : '协作者未能完成任务。';
            }
          }
          conversations.value = [...conversations.value];
        }));
        if (runAbort.signal.aborted) throw Object.assign(new Error('已由用户中止当前执行。'), { name: 'AbortError' });
      }
      const collaborationBrief = (assistantMessage.collaborations ?? []).filter((item) => item.status === 'completed' && item.summary.trim()).map((item) => {
        const name = labelEmployee(employees.value.find((row) => row.id === item.employeeId) ?? { id: item.employeeId, color: '#526fe0', initials: 'AI' });
        return `### ${name} 协作者报告\n${item.summary}`;
      }).join('\n\n');
      if (collaboratorIds.length === 1 && assistantMessage.collaborationDelivery === 'direct' && collaborationBrief) {
        assistantMessage.content = assistantMessage.collaborations?.[0]?.summary ?? '';
        conversations.value = [...conversations.value];
        void persist();
        return {
          conversationId: conversation.id,
          transcript: { prompt: userMessage.content, conversationId: conversation.id, assistantContent: assistantMessage.content, reasoningContent: assistantMessage.reasoning, activities: [], approvals: [], assets: [] },
        };
      }
      await streamChat({
        profile: {
          id: employee.id,
          name: labelEmployee(employee),
          toolIds: skills.map((skill) => skill.id),
          instructions: profileInstructions(employee, collaborationBrief ? 'This turn includes reports from explicitly selected collaborators. Synthesize their useful findings, resolve conflicts, and do not claim they completed actions you cannot verify.' : ''),
        },
        messages: conversation.messages
          .filter((message) => message.id !== assistantMessage.id)
          .map(({ role, content }) => ({
            role,
            content: role === 'user' && content === text && collaborationBrief
              ? `${content}\n\n协作者报告（仅作参考）：\n${collaborationBrief}`
              : content,
          }))
          .filter((message) => message.content.trim().length > 0),
        model: toModelPayload(model, { enableSearch: primarySearch.enableBuiltinSearch }),
        skills,
        searchProviders: primarySearch.searchProviders,
        mcpConnections: primarySearch.mcpConnections,
        knowledgeBases: primarySearch.knowledgeBases,
        modelCapabilities: primarySearch.modelCapabilities,
        maxSteps: primarySearch.maxSteps,
        runTimeoutMs: primarySearch.runTimeoutMs,
        mcpToolTimeoutMs: primarySearch.mcpToolTimeoutMs,
        signal: runAbort.signal,
      }, (delta: string) => { assistantMessage.content += delta; conversations.value = [...conversations.value]; }, (activity) => {
        mergeToolActivity(assistantMessage.activities ??= [], activity);
        conversations.value = [...conversations.value];
      }, (approval) => { if (!assistantMessage.approvals?.some((item) => item.skillId === approval.skillId && item.capability === approval.capability)) assistantMessage.approvals?.push(approval); conversations.value = [...conversations.value]; }, async (artifact) => {
        const normalized = artifact.path.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!isUserFacingDeliverablePath(normalized)) return;
        try {
          const asset = await archiveArtifact({
            runId: artifact.runId,
            relativePath: normalized,
            conversationId: conversation.serverSessionId,
            employeeId: employee.id,
          });
          const current = assistantMessage.assets?.findIndex((item) => item.id === asset.id) ?? -1;
          if (current >= 0) assistantMessage.assets?.splice(current, 1, asset);
          else assistantMessage.assets?.push(asset);
          conversations.value = [...conversations.value];
        } catch (error) {
          const message = error instanceof Error ? error.message : '资产归档失败。';
          if (/Only business deliverables|Only user-facing deliverables|no longer available/i.test(message)) return;
          assistantMessage.activities?.push({ toolName: 'archive_asset', status: 'failed', summary: message });
          conversations.value = [...conversations.value];
        }
      }, (search) => { const next = search.sources.map((source) => ({ ...source, provider: search.provider })); assistantMessage.sources = [...new Map([...(assistantMessage.sources ?? []), ...next].map((source) => [source.url, source])).values()]; conversations.value = [...conversations.value]; });
      if (!assistantMessage.content.trim()) {
        assistantMessage.content = '（本轮未返回文本。可重试，或检查模型 / MCP 是否正常。）';
      }
      void persist();
      return {
        conversationId: conversation.id,
        transcript: {
          prompt: userMessage.content,
          conversationId: conversation.id,
          assistantContent: assistantMessage.content,
          reasoningContent: assistantMessage.reasoning,
          activities: [...(assistantMessage.activities ?? [])],
          approvals: [...(assistantMessage.approvals ?? [])],
          assets: (assistantMessage.assets ?? []).map((asset) => ({ id: asset.id, name: asset.name, sizeBytes: asset.sizeBytes })),
        },
      };
    } catch (error) {
      markActivitiesInterrupted(assistantMessage.activities);
      for (const run of assistantMessage.collaborations ?? []) markActivitiesInterrupted(run.activities);
      if (isAbortError(error)) {
        const message = error instanceof Error ? error.message : '已中止当前执行。';
        appendAssistantNotice(assistantMessage, `⏹ ${message}`);
        appendUnfinishedDeliverableNotice(assistantMessage);
      } else {
        appendAssistantNotice(assistantMessage, error instanceof Error ? `⚠ ${friendlyAssistantError(error.message)}` : '⚠ 请求失败，请稍后重试。');
        appendUnfinishedDeliverableNotice(assistantMessage);
      }
      conversations.value = [...conversations.value];
      void persist();
      return {
        conversationId: conversation.id,
        transcript: {
          prompt: userMessage.content,
          conversationId: conversation.id,
          assistantContent: assistantMessage.content,
          reasoningContent: assistantMessage.reasoning,
          activities: [...(assistantMessage.activities ?? [])],
          approvals: [...(assistantMessage.approvals ?? [])],
          assets: (assistantMessage.assets ?? []).map((asset) => ({ id: asset.id, name: asset.name, sizeBytes: asset.sizeBytes })),
        },
      };
    } finally {
      if (activeRunAbort === runAbort) activeRunAbort = null;
    }
    } finally {
      chatBusy.value = false;
    }
  };
  const runAutomation = async (automation: Automation, model: ProviderConfig) => {
    const previousConversation = activeConversationId.value; const previousEmployee = currentEmployeeId.value;
    try {
      const result = await addMessage(automation.prompt, model, { employeeId: automation.employeeId, skillIds: automation.skillIds, newConversation: true });
      return result?.transcript;
    } finally { activeConversationId.value = previousConversation; currentEmployeeId.value = previousEmployee; }
  };
  /**
   * Runs a project task without selecting or mutating the user's active chat.
   * This is the concurrency boundary used by the project orchestrator.
   */
  const runProjectTask = async (input: { projectId: string; taskId: string; prompt: string; employeeId: EmployeeId; skillIds: string[]; permissionTier?: ExecutionLevel; model: ProviderConfig; workspacePath?: string }, onActivity?: (activity: ToolActivity) => void, onDelta?: (delta: string) => void): Promise<ProjectTaskTranscript> => {
    const employee = employees.value.find((item) => item.id === input.employeeId) ?? employees.value[0];
    const skills = await skillRuntimeFor(employee.id, input.skillIds, input.permissionTier);
    const opts = runOptionsFor(employee.id, true);
    const model = modelForEmployee(employee.id, input.model) ?? input.model;
    const transcript: ProjectTaskTranscript = { assistantContent: '', activities: [], approvals: [], assets: [] };
    await streamChat({
      profile: {
        id: employee.id,
        name: labelEmployee(employee),
        toolIds: skills.map((skill) => skill.id),
        instructions: profileInstructions(employee, 'You are working on one assigned project task in PROJECT MODE. The workspace root is the shared project directory — write the real project tree there (do not wrap products in output/). Complete only this task, report concrete findings and deliverables in the user\'s language. Do not delegate further.'),
      },
      messages: [{ role: 'user', content: input.prompt }],
      model: toModelPayload(model, { enableSearch: opts.enableBuiltinSearch }),
      skills,
      searchProviders: opts.searchProviders,
      mcpConnections: opts.mcpConnections,
      knowledgeBases: opts.knowledgeBases,
      modelCapabilities: opts.modelCapabilities,
      projectWorkspacePath: input.workspacePath,
      maxSteps: opts.maxSteps,
      runTimeoutMs: opts.runTimeoutMs,
      mcpToolTimeoutMs: opts.mcpToolTimeoutMs,
      ...(opts.engine ? { engine: opts.engine } : {}),
    }, (delta) => { transcript.assistantContent += delta; onDelta?.(delta); }, (activity) => {
      mergeToolActivity(transcript.activities, activity);
      onActivity?.(activity);
    }, (approval) => { if (!transcript.approvals.some((item) => item.skillId === approval.skillId && item.capability === approval.capability)) transcript.approvals.push(approval); }, async (artifact) => {
      transcript.runId = artifact.runId;
      const normalized = artifact.path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!isUserFacingDeliverablePath(normalized)) return;
      if (transcript.assets.some((item) => item.runId === artifact.runId && item.name === (normalized.split('/').pop() || normalized))) return;
      try {
        const asset = await archiveArtifact({ runId: artifact.runId, relativePath: normalized, employeeId: employee.id, projectId: input.projectId });
        if (!transcript.assets.some((item) => item.id === asset.id)) transcript.assets.push({ id: asset.id, name: asset.name, sizeBytes: asset.sizeBytes, runId: asset.runId });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/Only business deliverables|Only user-facing deliverables|no longer available/i.test(message)) return;
        throw error;
      }
    });
    return transcript;
  };
  const generateProjectDraft = async (
    goal: string,
    model: ProviderConfig,
    options?: {
      employeeIds?: EmployeeId[];
      preferredMode?: import('./projects.js').ProjectMode;
      /** Prefer the fewest agents; collapse to primary when sufficient. */
      preferMinimal?: boolean;
      /** Only keep agents that are a strong fit for a distinct need. */
      strongFitOnly?: boolean;
      /** Hard cap on distinct agents in the plan (default 5). */
      maxAgents?: number;
      /** Current conversation employee — preferred solo owner when capable. */
      primaryEmployeeId?: EmployeeId;
    },
  ): Promise<import('./project-planning.js').ProjectDraftResult> => {
    const { analyzeModeFit } = await import('./project-planning.js');
    type ProjectMode = import('./project-planning.js').PlanningMode;
    const preferredMode: ProjectMode = options?.preferredMode ?? 'parallel';
    const maxAgents = Math.max(1, Math.min(12, options?.maxAgents ?? 5));
    const preferMinimal = options?.preferMinimal === true;
    const strongFitOnly = options?.strongFitOnly === true;
    const allowedList = (options?.employeeIds?.length
      ? options.employeeIds.filter((id) => employees.value.some((item) => item.id === id))
      : employees.value.map((item) => item.id));
    const primaryEmployeeId = (options?.primaryEmployeeId && allowedList.includes(options.primaryEmployeeId))
      ? options.primaryEmployeeId
      : (allowedList[0] ?? 'general');
    const roster = allowedList.join('|') || 'general|research|code|administrator';
    const allowed = new Set<EmployeeId>(allowedList.length ? allowedList : ['general', 'research', 'code', 'administrator']);
    const rosterBrief = allowedList.map((id) => {
      const item = employees.value.find((row) => row.id === id);
      const focus = item ? collaboratorFocus(item).slice(0, 120) : id;
      const name = item ? labelEmployee(item) : id;
      const mark = id === primaryEmployeeId ? ' [PRIMARY]' : '';
      return `- ${id}${mark}: ${name} — ${focus}`;
    }).join('\n');

    const modeGuide: Record<ProjectMode, string> = {
      waterfall: 'Prefer a linear chain: each task depends on the previous index only.',
      parallel: 'Prefer independent tasks with empty dependsOn; no edges.',
      discussion: 'Prefer 2+ independent viewpoint tasks, then one integrator that depends on all of them.',
      dag: 'Prefer an explicit DAG with meaningful fan-in/fan-out dependsOn — but only when multiple strong-fit agents are truly required.',
    };

    const minimalRules = preferMinimal || strongFitOnly
      ? `
HARD PLANNING CONSTRAINTS (must obey):
1. Minimize distinct agents. If the PRIMARY employee (${primaryEmployeeId}) can complete the goal alone, return EXACTLY 1 task with employeeId="${primaryEmployeeId}" and set singleAgentSufficient=true.
2. Only add another agent when they are a STRONG fit for a capability the primary clearly lacks and that is necessary for success. Never add agents for optional review, polish, or "more perspectives".
3. At most ${maxAgents} distinct employeeIds. Prefer 1; 2-3 only when clearly necessary; never pad to fill a quota.
4. Task count may be small (1 is ideal). Do not invent filler tasks.
5. Every included employeeId must appear in the roster and must be justified in rationale as a strong fit.`
      : `Use 2-${maxAgents} tasks when helpful. dependsOn are 0-based indices of prior tasks.`;

    // Phase 1 — structure only (roles + edges).
    let structureOut = '';
    const structurePrompt = `You are Workmate's project coordinator (phase 1: structure). Preferred collaboration mode: ${preferredMode}. ${modeGuide[preferredMode]} If the goal cannot honestly fit that mode, still propose the best graph and set suggestedMode accordingly.
${minimalRules}

Available employees (choose only from these):
${rosterBrief}

Return ONLY JSON: {"suggestedMode":"waterfall|parallel|discussion|dag","singleAgentSufficient":boolean,"rationale":string,"tasks":[{"title":string,"employeeId": one of [${roster}],"dependsOn":number[],"fitReason":string}]}.
dependsOn are 0-based indices of prior tasks. Goal: ${goal}`;
    await streamChat({
      profile: { id: 'project-coordinator-structure', name: 'Project coordinator', instructions: 'Output valid JSON only. Prefer the fewest strong-fit agents.', toolIds: [] },
      messages: [{ role: 'user', content: structurePrompt }],
      model: toModelPayload(model),
      skills: [],
      searchProviders: runtimeProviders(),
      maxSteps: DEFAULT_MAX_STEPS,
    }, (delta) => { structureOut += delta; });

    type StructureTask = { title: string; employeeId: EmployeeId; dependsOn: number[]; fitReason?: string };
    let structureTasks: StructureTask[] = [];
    let llmSuggested: ProjectMode | undefined;
    let llmRationale = '';
    let singleAgentSufficient = false;
    try {
      const json = structureOut.match(/\{[\s\S]*\}/)?.[0] ?? structureOut;
      const parsed = JSON.parse(json) as {
        suggestedMode?: string;
        rationale?: string;
        singleAgentSufficient?: boolean;
        tasks?: Array<Partial<StructureTask>>;
      };
      if (parsed.suggestedMode === 'waterfall' || parsed.suggestedMode === 'parallel' || parsed.suggestedMode === 'discussion' || parsed.suggestedMode === 'dag') {
        llmSuggested = parsed.suggestedMode;
      }
      llmRationale = String(parsed.rationale || '').slice(0, 400);
      singleAgentSufficient = parsed.singleAgentSufficient === true;
      structureTasks = (parsed.tasks ?? []).slice(0, Math.max(maxAgents, 5)).map((item, index) => ({
        title: String(item.title || `任务 ${index + 1}`).slice(0, 80),
        employeeId: allowed.has(item.employeeId as EmployeeId) ? item.employeeId as EmployeeId : primaryEmployeeId,
        dependsOn: Array.isArray(item.dependsOn)
          ? item.dependsOn.filter((value): value is number => typeof value === 'number' && value >= 0 && value < index)
          : [],
        fitReason: typeof item.fitReason === 'string' ? item.fitReason.slice(0, 160) : undefined,
      }));
    } catch { /* fall through to template-ish structure */ }

    // Enforce minimal / strong-fit / max-agent caps after the model responds.
    if (preferMinimal && (singleAgentSufficient || structureTasks.length <= 1)) {
      const sole = structureTasks[0];
      structureTasks = [{
        title: sole?.title || '完成用户目标',
        employeeId: singleAgentSufficient ? primaryEmployeeId : (sole?.employeeId ?? primaryEmployeeId),
        dependsOn: [],
        fitReason: sole?.fitReason || '当前智能体可独立完成',
      }];
    } else if (structureTasks.length) {
      const kept: StructureTask[] = [];
      const usedAgents = new Set<EmployeeId>();
      const indexMap = new Map<number, number>();
      structureTasks.forEach((task, index) => {
        const isNewAgent = !usedAgents.has(task.employeeId);
        if (isNewAgent && usedAgents.size >= maxAgents) return;
        const nextIndex = kept.length;
        indexMap.set(index, nextIndex);
        kept.push({
          ...task,
          dependsOn: task.dependsOn
            .map((dep) => indexMap.get(dep))
            .filter((dep): dep is number => typeof dep === 'number'),
        });
        usedAgents.add(task.employeeId);
      });
      structureTasks = kept.length ? kept : [{
        title: '完成用户目标',
        employeeId: primaryEmployeeId,
        dependsOn: [],
        fitReason: '回退为当前智能体',
      }];
      // If minimal mode still somehow kept many weak extras, collapse when only primary is needed.
      if (preferMinimal && usedAgents.size > 1 && singleAgentSufficient) {
        structureTasks = [{
          title: structureTasks[0]?.title || '完成用户目标',
          employeeId: primaryEmployeeId,
          dependsOn: [],
          fitReason: '当前智能体可独立完成',
        }];
      }
    }

    if (!structureTasks.length) {
      structureTasks = [{
        title: '完成用户目标',
        employeeId: primaryEmployeeId,
        dependsOn: [],
        fitReason: '默认由当前智能体执行',
      }];
    }

    // Phase 2 — fill objectives + contracts for the fixed structure.
    let detailOut = '';
    const detailPrompt = `You are Workmate's project coordinator (phase 2: objectives). Fill objectives for this fixed task structure. Return ONLY a JSON array aligned 1:1 with the structure (same length/order). Each item: {"objective":string,"skillIds":string[],"contract"?:{"outputs"?:string[],"acceptance"?:string,"maxSteps"?:number,"maxAttempts"?:number}}. The platform baseline is 50 tool steps for every project task. Omit contract.maxSteps when 50 is sufficient; set it only when a task clearly needs MORE than 50. Never set it below 50. Prefer concrete deliverable contracts when the goal clearly needs files, but do not force fixed filenames. Keep objectives focused — do not invent work that would require extra agents. Structure: ${JSON.stringify(structureTasks)}. Goal: ${goal}`;
    await streamChat({
      profile: { id: 'project-coordinator-detail', name: 'Project coordinator', instructions: 'Output valid JSON array only.', toolIds: [] },
      messages: [{ role: 'user', content: detailPrompt }],
      model: toModelPayload(model),
      skills: [],
      searchProviders: runtimeProviders(),
      maxSteps: DEFAULT_MAX_STEPS,
    }, (delta) => { detailOut += delta; });

    let details: Array<{ objective: string; skillIds: string[]; contract?: ProjectTaskDraft['contract'] }> = [];
    try {
      const json = detailOut.match(/\[[\s\S]*\]/)?.[0] ?? detailOut;
      const parsed = JSON.parse(json) as Array<Partial<ProjectTaskDraft>>;
      details = parsed.slice(0, structureTasks.length).map((item) => ({
        objective: String(item.objective || goal).slice(0, 2000),
        skillIds: Array.isArray(item.skillIds) ? item.skillIds.filter((id): id is string => typeof id === 'string').slice(0, 12) : [],
        contract: item.contract,
      }));
    } catch { /* defaults below */ }

    const tasks: ProjectTaskDraft[] = structureTasks.map((item, index) => ({
      title: item.title,
      objective: details[index]?.objective || `围绕目标推进「${item.title}」：${goal}`,
      employeeId: item.employeeId,
      skillIds: details[index]?.skillIds ?? [],
      dependsOn: item.dependsOn,
      contract: details[index]?.contract,
    }));

    const uniqueAgents = new Set(tasks.map((task) => task.employeeId)).size;
    const fit = analyzeModeFit(preferredMode, tasks);
    // Prefer structural inference; LLM suggestedMode is advisory when it disagrees with graph.
    const suggestedMode = tasks.length <= 1
      ? 'parallel'
      : (fit.suggestedMode !== preferredMode ? fit.suggestedMode : (llmSuggested ?? fit.suggestedMode));
    const modeFitsPreferred = suggestedMode === preferredMode;
    const minimalNote = preferMinimal
      ? `最少智能体约束：${uniqueAgents} 人参与${singleAgentSufficient || uniqueAgents === 1 ? '（当前智能体可独立完成则不扩编）' : ''}。`
      : '';
    return {
      tasks,
      preferredMode,
      suggestedMode: modeFitsPreferred ? preferredMode : suggestedMode,
      modeFitsPreferred,
      modeRationale: [minimalNote, modeFitsPreferred ? (llmRationale || fit.modeRationale) : (llmRationale || fit.modeRationale)]
        .filter(Boolean)
        .join(' '),
    };
  };
  const approveAndRetry = async (conversationId: string, approval: ToolApproval, scope: 'session' | 'always', model: ProviderConfig) => {
    const conversation = conversations.value.find((item) => item.id === conversationId);
    // Server-backed session: resolve on the server (it re-runs the same turn
    // automatically via its context resolver), then align the mirror.
    if (conversation?.serverSessionId) {
      const sessionId = conversation.serverSessionId;
      if (!approval.id) {
        // Legacy approvals without a server id cannot be resolved remotely.
        return;
      }
      const resolved = await orch
        .resolveChatApproval(sessionId, approval.id, { allow: true, scope })
        .catch(() => undefined);
      // The server auto-resumes the same turn as a new attempt; wait until that
      // resumed run is settled and its content persisted before re-aligning.
      if (resolved?.resumedRunId) {
        const resumeAbort = new AbortController();
        const resumedAssistant = conversation?.messages[conversation.messages.length - 1];
        if (resumedAssistant) await waitForServerSettled(sessionId, resolved.resumedRunId, resumeAbort, resumedAssistant);
      }
      await waitForServerApprovalResume(sessionId, conversation);
      if (conversation) {
        for (const message of conversation.messages) {
          if (!message.approvals) continue;
          message.approvals = message.approvals.filter(
            (item) => !(item.skillId === approval.skillId && item.capability === approval.capability),
          );
        }
        void persist();
      }
      return;
    }
    if (scope === 'session') { const grants = sessionGrants.get(approval.skillId) ?? new Set<ToolApproval['capability']>(); grants.add(approval.capability); sessionGrants.set(approval.skillId, grants); }
    else {
      const skill = skills.value.find((item) => item.id === approval.skillId);
      if (skill) await setExecutionPolicy(skill.id, { ...skill.execution, allowWorkspaceWrite: approval.capability === 'workspace-write' ? true : skill.execution.allowWorkspaceWrite, allowScriptExecution: approval.capability === 'script-execution' ? true : skill.execution.allowScriptExecution });
    }
    const lastUser = [...(conversation?.messages ?? [])].reverse().find((message) => message.role === 'user');
    if (lastUser) { activeConversationId.value = conversationId; await addMessage(lastUser.content, model); }
  };
  /** Wait for a server-side approval resume (new attempt) to settle. */
  const waitForServerApprovalResume = async (sessionId: string, conversation: Conversation): Promise<void> => {
    const deadline = Date.now() + 3 * 60_000;
    const before = conversation.updatedAt;
    while (Date.now() < deadline) {
      const session = await orch.getChatSession(sessionId).catch(() => null);
      if (session && session.updatedAt > before) {
        const pending = await orch.chatPendingApprovals(sessionId).catch(() => []);
        if (pending.length === 0) {
          await alignServerConversation(conversation, sessionId).catch(() => undefined);
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  };
  async function ensureActiveServerSession(): Promise<string | null> {
    let conversation = activeConversation.value;
    if (!conversation) {
      conversation = { id: crypto.randomUUID(), title: '新对话', employeeId: currentEmployeeId.value, messages: [], updatedAt: Date.now() };
      conversations.value.unshift(conversation);
      activeConversationId.value = conversation.id;
    }
    return ensureServerSession(conversation, conversation.title || '手机对话');
  }

  async function pullActiveConversationFromServer(): Promise<void> {
    const conversation = activeConversation.value;
    if (!conversation?.serverSessionId) return;
    await alignServerConversation(conversation, conversation.serverSessionId).catch(() => undefined);
    serverBump();
  }

  /**
   * When the phone taps “新对话”, the QR token rebinds to a new orch session.
   * Adopt that session into the local conversation list and switch to it.
   */
  async function followMobileChatSession(sessionId: string, title?: string): Promise<Conversation | null> {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    await hydrateServerConversations().catch(() => undefined);
    let conversation = conversations.value.find((item) => item.serverSessionId === id) || null;
    if (!conversation) {
      conversation = {
        id: crypto.randomUUID(),
        title: title || '新对话',
        employeeId: activeConversation.value?.employeeId || currentEmployeeId.value,
        messages: [],
        updatedAt: Date.now(),
        serverSessionId: id,
      };
      conversations.value = [conversation, ...conversations.value];
      await alignServerConversation(conversation, id).catch(() => undefined);
      await persist();
    }
    activeConversationId.value = conversation.id;
    serverBump();
    return conversation;
  }

  return { employees, view, currentEmployeeId, currentEmployee, conversations, activeConversation, permissionTier, chatBusy, load, setView, startChat, startChatWithPrompt, selectConversation, selectEmployee, setDefaultEmployee, setPermissionTier, clearConversation, deleteConversation, addMessage, abortActiveRun, runAutomation, runProjectTask, generateProjectDraft, approveAndRetry, createEmployee, updateEmployee, removeEmployee, resetEmployee, hasEmployeeOverride, ensureActiveServerSession, pullActiveConversationFromServer, followMobileChatSession };
}
