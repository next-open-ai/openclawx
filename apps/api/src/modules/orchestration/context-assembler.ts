import type { ChatRunContext, KeyValueStore, ProjectTask } from '@openclawx/orchestrator';
import { ProviderIdSchema, resolveProviderServiceEndpoint } from '@openclawx/contracts';
import type { DecisionGuardPolicy, DecisionRuntimeConfig, ModelCapabilityRuntime } from '@openclawx/contracts';
import { ensureModelSecrets } from './secrets.js';

/**
 * Server-side run-context assembly (M0).
 *
 * Lets a remote gateway confirm a project WITHOUT the desktop renderer's
 * per-employee runtime payloads: the orchestrator reads the same domain KV
 * (employee catalog, skill catalog + policies, runtime prefs, MCP/KB config)
 * the renderer writes, plus the keyring model/search secrets requested from
 * the Electron main process.
 *
 * This is a tolerant best-effort v1: missing pieces degrade gracefully
 * (empty tool sets / no model → task fails with a clear message) instead of
 * guessing. Rendering-layer mirrors of normalization live in the renderer
 * stores; when those move into a shared package this file shrinks.
 */

const EMPLOYEES_KEY = 'workspace.custom-employees';
const OVERRIDES_KEY = 'workspace.employee-overrides';
const SKILLS_KEY = 'capabilities.skills.v2';
const POLICIES_KEY = 'capabilities.employee-policies';
const PREFS_KEY = 'workspace.employee-runtime-prefs';
const MCP_KEY = 'capabilities.mcp';
const KB_BASES_KEY = 'capabilities.knowledge';
const KB_PROVIDERS_KEY = 'settings.knowledge-providers';

const PROVIDER_IDS = new Set(['openai', 'anthropic', 'google', 'deepseek', 'glm', 'qwen', 'ollama', 'openai-compatible']);
const PRESET_EMPLOYEE_NAMES: Record<string, string> = {
  general: 'General Assistant',
  research: 'Research Assistant',
  code: 'Code Assistant',
  administrator: 'Administrator',
};
const PRESET_DEFAULT_INSTRUCTIONS: Record<string, string> = {
  code:
    '凡任务要求「按既定设计规范」但没有提供规范/品牌/页面清单：必须采用一份文档化的默认企业规范（主/辅色、字阶、12 列栅格、断点、页面清单写入 README.md），并直接产出核心可运行页面；不得因缺品牌/规范/文案而停下澄清。只输出文字、不写文件=失败；要么写文件，要么给出精确阻塞点+唯一需要的输入。',
};


interface EmployeeRow { id?: string; name?: string; instructions?: string; description?: string }
interface SkillRow {
  id?: string; name?: string; description?: string; mode?: string; path?: string; instructions?: string;
  execution?: { allowWorkspaceWrite?: boolean; allowScriptExecution?: boolean; allowedNetworkHosts?: string[]; allowAllNonDestructive?: boolean };
}
interface PolicyRow { employeeId?: string; skillId?: string; mode?: string }
interface PrefsRow {
  defaultModelId?: string | null; searchMode?: string; maxSteps?: number;
  runTimeoutMs?: number; mcpToolTimeoutMs?: number; mcpIds?: string[];
  knowledgeProvider?: string; knowledgeBaseIds?: string[];
  engine?: string | null;
  useApplicationModels?: boolean;
}
interface ModelSettings {
  decisionRuntime?: DecisionGuardPolicy & Partial<Pick<DecisionRuntimeConfig, 'provider' | 'protocol' | 'baseUrl' | 'apiKey' | 'model'>>;
  providerInstances?: Array<{ id?: string; type?: string; name?: string; baseUrl?: string; workspaceId?: string; service?: 'language' | 'speech' | 'realtime' | 'unified'; endpoints?: Record<string, string>; appId?: string; apiSecret?: string; apiKey?: string; disableThinking?: boolean }>;
  models?: Array<{
    supportsVision?: boolean;
    id?: string;
    providerInstanceId?: string;
    capability?: string;
    modelId?: string;
    voice?: string;
    label?: string;
    imageProtocol?: string;
    decisionProtocol?: string;
    meta?: { dimension?: number; normalize?: boolean; maxBatch?: number; maxInputChars?: number };
  }>;
  activeChatModelId?: string | null;
  activeEmbeddingModelId?: string | null;
  employeeDefaultModelIds?: Record<string, string>;
  capabilityBindings?: Array<{ capability?: string; modelId?: string; enabled?: boolean }>;
  agentCapabilityAssignments?: Array<{ agentId?: string; capability?: string; mode?: string }>;
  activeProvider?: string;
  providers?: Array<{
    provider?: string;
    baseUrl?: string;
    chatModel?: string;
    apiKey?: string;
    disableThinking?: boolean;
    embeddingModel?: string;
  }>;
}

function decisionRuntimeFor(raw: unknown): DecisionRuntimeConfig | undefined {
  const settings = (raw && typeof raw === 'object' ? raw : {}) as ModelSettings;
  const policy = settings.decisionRuntime;
  if (!policy) return undefined;
  const selectedId = policy.applicationModelId
    ?? settings.capabilityBindings?.find((item) => item.capability === 'decision' && item.enabled !== false)?.modelId;
  const model = settings.models?.find((item) => item.id === selectedId && item.capability === 'decision');
  const provider = model ? settings.providerInstances?.find((item) => item.id === model.providerInstanceId) : undefined;
  if (model?.modelId?.trim() && provider?.baseUrl?.trim() && provider.type && ProviderIdSchema.safeParse(provider.type).success) {
    return {
      ...policy,
      applicationModelId: model.id,
      provider: provider.name?.trim() || provider.type,
      protocol: 'system-one-v1',
      baseUrl: resolveProviderServiceEndpoint({ provider: provider.type, baseUrl: provider.baseUrl, workspaceId: provider.workspaceId, service: provider.service, endpoints: provider.endpoints, endpoint: 'chat' }),
      apiKey: provider.apiKey || '',
      model: model.modelId.trim(),
    };
  }
  // Read-only compatibility for settings saved by the pre-application-model release.
  if (policy.baseUrl && policy.model) {
    return { ...policy, provider: policy.provider || 'jev', protocol: policy.protocol || 'system-one-v1', baseUrl: policy.baseUrl, apiKey: policy.apiKey || '', model: policy.model };
  }
  return undefined;
}

function modelCapabilitiesFor(employeeId: string, raw: unknown, enabled = true): ModelCapabilityRuntime[] {
  if (!enabled) return [];
  const settings = (raw && typeof raw === 'object' ? raw : {}) as ModelSettings;
  const models = settings.models ?? [];
  const instances = settings.providerInstances ?? [];
  const bindings = settings.capabilityBindings ?? [];
  const supported = new Set(['quantum-code', 'image', 'video', 'vision', 'embedding', 'asr', 'tts', 'ontology']);
  return bindings.flatMap((binding) => {
    const capability = String(binding.capability || '');
    if (!supported.has(capability) || binding.enabled === false) return [];
    const selectedBinding = binding
      ?? (capability === 'embedding' && settings.activeEmbeddingModelId
        ? { capability: 'embedding', modelId: settings.activeEmbeddingModelId, enabled: true }
        : undefined);
    const model = selectedBinding ? models.find((item) => item.id === selectedBinding.modelId && item.capability === capability) : undefined;
    const provider = model ? instances.find((item) => item.id === model.providerInstanceId) : undefined;
    if (!model?.id || !model.modelId?.trim() || !provider?.baseUrl?.trim() || !provider.type || !ProviderIdSchema.safeParse(provider.type).success) return [];
    return [{
      id: model.id,
      capability: capability as ModelCapabilityRuntime['capability'],
      provider: provider.type as ModelCapabilityRuntime['provider'],
      providerLabel: provider.name,
      baseUrl: resolveProviderServiceEndpoint({ provider: provider.type, baseUrl: provider.baseUrl, workspaceId: provider.workspaceId, service: provider.service, endpoints: provider.endpoints, endpoint: capability === 'image' || capability === 'video' ? 'image' : capability === 'embedding' ? 'embedding' : capability === 'asr' ? 'asr' : capability === 'tts' ? 'tts' : 'chat' }),
      apiKey: provider.apiKey || (provider.type === 'ollama' ? 'ollama' : ''),
      ...(provider.appId ? { appId: provider.appId } : {}),
      ...(provider.apiSecret ? { apiSecret: provider.apiSecret } : {}),
      modelId: model.modelId,
      ...(capability === 'tts' && model.voice?.trim() ? { voice: model.voice.trim() } : {}),
      ...(capability === 'image' && model.imageProtocol
        ? { imageProtocol: model.imageProtocol as ModelCapabilityRuntime['imageProtocol'] }
        : {}),
      mode: 'auto',
    }];
  });
}
interface SearchSettings {
  defaultProvider?: string;
  providers?: Array<{ id?: string; label?: string; apiKey?: string; baseUrl?: string; enabled?: boolean }>;
}

async function kvJson(store: KeyValueStore, key: string): Promise<unknown> {
  const raw = await store.get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Desktop stores prefs under `user:<id>:workspace.employee-runtime-prefs`.
 * Unscoped key is often empty; scan user-scoped keys as fallback.
 */
async function readEmployeePrefsMap(
  store: KeyValueStore,
  ownerUserId?: string | null,
): Promise<Record<string, unknown>> {
  const candidates: string[] = [];
  if (ownerUserId?.trim()) candidates.push(`user:${ownerUserId.trim()}:${PREFS_KEY}`);
  candidates.push(PREFS_KEY);
  for (const key of candidates) {
    const raw = await kvJson(store, key);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  }
  try {
    const keys = await store.keys('user:');
    const prefKeys = keys.filter((key) => key.endsWith(`:${PREFS_KEY}`));
    for (const key of prefKeys.reverse()) {
      const raw = await kvJson(store, key);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    }
  } catch {
    // ignore listing failures
  }
  return {};
}

function rows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/**
 * Resolve per-task tool-step budget.  Fifty is the platform baseline for all
 * project work; planners and users may request more, but never less.
 */
function taskMaxSteps(task: ProjectTask, prefs: PrefsRow) {
  const base = prefs.maxSteps && prefs.maxSteps >= 50 ? prefs.maxSteps : 50;
  if (task.contract?.maxSteps && task.contract.maxSteps > 0) {
    return Math.min(64, Math.max(50, Math.floor(task.contract.maxSteps)));
  }
  return Math.min(64, base);
}

/** Build the agent profile for an employee (KV catalog + preset fallback). */
function profileFor(
  employeeId: string,
  employees: EmployeeRow[],
  overrides: Record<string, { description?: string; instructions?: string }>,
): ChatRunContext['profile'] {
  const found = employees.find((item) => item.id === employeeId);
  const override = overrides[employeeId];
  const name = found?.name?.trim() || PRESET_EMPLOYEE_NAMES[employeeId] || 'General Assistant';
  const description = found?.description?.trim() || override?.description?.trim() || '';
  const focus =
    override?.instructions?.trim() ||
    found?.instructions?.trim() ||
    PRESET_DEFAULT_INSTRUCTIONS[employeeId] ||
    '按要求完成任务，不虚构执行结果。';
  const roleBrief = description ? ` Role brief: ${description}` : '';
  const instructions = `${name}（OpenClawX 数字员工）。自我介绍时使用当前员工名称，客观说明能力，不夸大。${roleBrief} ${focus}`.trim();
  return { id: employeeId, name, instructions, toolIds: [] };
}

/** Resolve a chat ModelConfig from the keyring model-settings snapshot. */
function modelFor(employeeId: string, prefs: PrefsRow, raw: unknown): ChatRunContext['model'] | null {
  const settings = (raw && typeof raw === 'object' ? raw : {}) as ModelSettings;
  const chatModels = Array.isArray(settings.models) ? settings.models.filter((model) => model.capability === 'chat') : [];
  const pick =
    chatModels.find((model) => model.id === prefs.defaultModelId) ??
    chatModels.find((model) => model.id === settings.employeeDefaultModelIds?.[employeeId]) ??
    chatModels.find((model) => model.id === settings.activeChatModelId) ??
    chatModels[0];
  const instances = Array.isArray(settings.providerInstances) ? settings.providerInstances : [];
  const instance = pick ? instances.find((item) => item.id === pick.providerInstanceId) : undefined;

  const embedPick = Array.isArray(settings.models)
    ? settings.models.find((model) => model.id === settings.activeEmbeddingModelId && model.capability === 'embedding')
    : undefined;
  const embedInstance = embedPick ? instances.find((item) => item.id === embedPick.providerInstanceId) : undefined;
  const embeddingFields = embedPick?.modelId?.trim() && embedInstance
    ? {
        embeddingModel: embedPick.modelId.trim(),
        ...(embedInstance.baseUrl?.trim() ? { embeddingBaseUrl: resolveProviderServiceEndpoint({ provider: embedInstance.type || '', baseUrl: embedInstance.baseUrl, workspaceId: embedInstance.workspaceId, service: embedInstance.service, endpoints: embedInstance.endpoints, endpoint: 'embedding' }) } : {}),
        ...(embedInstance.apiKey?.trim() || embedInstance.type === 'ollama'
          ? { embeddingApiKey: embedInstance.apiKey?.trim() || 'ollama' }
          : {}),
      }
    : {};

  const provider = instance?.type?.trim();
  if (pick && provider && PROVIDER_IDS.has(provider)) {
    return {
      provider: provider as ChatRunContext['model']['provider'],
      ...(instance?.baseUrl?.trim() ? { baseUrl: resolveProviderServiceEndpoint({ provider, baseUrl: instance.baseUrl, workspaceId: instance.workspaceId, service: instance.service, endpoints: instance.endpoints, endpoint: 'chat' }) } : {}),
      chatModel: pick.modelId || pick.id || '',
      supportsVision: Boolean(pick.supportsVision),
      ...(instance?.disableThinking ? { disableThinking: true } : {}),
      apiKey: instance?.apiKey ?? '',
      ...embeddingFields,
    };
  }

  // Legacy v1 settings shape.
  const providers = Array.isArray(settings.providers) ? settings.providers : [];
  const legacy = providers.find((item) => item.provider === (settings.activeProvider || 'openai'));
  if (legacy?.chatModel) {
    const provider = legacy.provider || 'openai';
    if (PROVIDER_IDS.has(provider)) {
      return {
        provider: provider as ChatRunContext['model']['provider'],
        ...(legacy.baseUrl?.trim() ? { baseUrl: legacy.baseUrl.trim() } : {}),
        chatModel: legacy.chatModel,
        ...(legacy.disableThinking ? { disableThinking: true } : {}),
        apiKey: legacy.apiKey ?? '',
        ...(legacy.embeddingModel?.trim() ? { embeddingModel: legacy.embeddingModel.trim() } : {}),
        ...embeddingFields,
      };
    }
  }
  return null;
}

function searchProvidersFor(prefs: PrefsRow, raw: unknown): ChatRunContext['searchProviders'] {
  const mode = prefs.searchMode ?? 'inherit';
  if (mode === 'off' || mode === 'llm-builtin') return [];
  const settings = (raw && typeof raw === 'object' ? raw : {}) as SearchSettings;
  const configured = (settings.providers ?? []).filter((item) => item.enabled && item.apiKey?.trim());
  const selected =
    mode === 'auto' || mode === 'inherit'
      ? configured
      : configured.filter((item) => item.id === mode);
  const defaultId = settings.defaultProvider;
  return selected
    .filter((item) => item && typeof item === 'object' && item.id)
    .map((item) => ({
      id: item.id as ChatRunContext['searchProviders'][number]['id'],
      label: item.label ?? item.id ?? '',
      apiKey: item.apiKey ?? '',
      ...(item.baseUrl?.trim() ? { baseUrl: item.baseUrl.trim() } : {}),
      enabled: true,
      preferred: Boolean(item.id === defaultId),
    }));
}

async function scopedRows(
  store: KeyValueStore,
  key: string,
  ownerUserId?: string | null,
): Promise<Array<Record<string, unknown>>> {
  const scoped = ownerUserId?.trim() ? rows(await kvJson(store, `user:${ownerUserId.trim()}:${key}`)) : [];
  return scoped.length > 0 ? scoped : rows(await kvJson(store, key));
}

/** Resolve the exact employee Skill grants used by server-originated runs. */
export async function resolveSkillRuntimeFor(
  store: KeyValueStore,
  task: ProjectTask,
  tier: string,
  ownerUserId?: string | null,
): Promise<ChatRunContext['skills']> {
  // Desktop storage is forwarded to domain KV under a per-user namespace.
  // Reading only the legacy unscoped keys made voice/mobile runs silently lose
  // every employee-associated Skill while ordinary desktop runs still had it.
  const skills = await scopedRows(store, SKILLS_KEY, ownerUserId) as SkillRow[];
  const policies = await scopedRows(store, POLICIES_KEY, ownerUserId) as PolicyRow[];
  const policiesFor = policies.filter((policy) => policy.employeeId === task.employeeId && policy.mode && policy.mode !== 'disabled');
  const selectedIds = new Set(task.skillIds ?? []);
  const runtime: ChatRunContext['skills'] = [];

  for (const policy of policiesFor) {
    if (selectedIds.size > 0 && !selectedIds.has(policy.skillId ?? '')) continue;
    const skill = skills.find((item) => item.id === policy.skillId);
    if (!skill?.id) continue;
    const execution = skill.execution ?? {};
    const readOnly = tier === 'read-only';
    runtime.push({
      id: skill.id,
      name: skill.name ?? skill.id,
      description: skill.description ?? '',
      mode: policy.mode === 'default' ? 'default' : 'available',
      ...(skill.path ? { rootPath: (skill.path as string).replace(/[\\/][^\\/]+$/, '') } : {}),
      ...(skill.instructions ? { instructions: String(skill.instructions).slice(0, 24_000) } : {}),
      resources: [],
      execution: {
        allowWorkspaceWrite: !readOnly && Boolean(execution.allowWorkspaceWrite),
        allowScriptExecution: !readOnly && Boolean(execution.allowScriptExecution),
        allowedNetworkHosts: execution.allowedNetworkHosts ?? [],
        allowAllNonDestructive: tier === 'full',
      },
    });
  }

  return runtime;
}

async function mcpConnectionsFor(
  store: KeyValueStore,
  prefs: PrefsRow,
  ownerUserId?: string | null,
): Promise<ChatRunContext['mcpConnections']> {
  // Desktop/web settings are user-scoped so one tenant/user cannot leak MCP
  // credentials or tools into another. The previous implementation only read
  // the legacy unscoped key, which made MCP tests pass in the UI but left chat
  // runs with no connectors at all.
  const scoped = ownerUserId?.trim() ? await kvJson(store, `user:${ownerUserId.trim()}:${MCP_KEY}`) : null;
  const scopedRows = rows(scoped) as Array<Record<string, unknown>>;
  const all = (scopedRows.length > 0 ? scopedRows : rows(await kvJson(store, MCP_KEY))) as Array<Record<string, unknown>>;
  const wanted = new Set(prefs.mcpIds ?? []);
  const AUTO_SKIP = new Set(['mcp-baseline-playwright', 'mcp-baseline-chrome-devtools']);
  const out: ChatRunContext['mcpConnections'] = [];
  for (const raw of all) {
    const id = String(raw.id ?? '');
    if (!id || raw.enabled === false) continue;
    // Explicit association restricts; empty prefs → enabled connectors minus heavy browsers.
    if (wanted.size > 0) {
      if (!wanted.has(id)) continue;
    } else if (AUTO_SKIP.has(id)) {
      continue;
    }
    // Prefer connectors that passed a probe when metadata is present.
    if (raw.lastTestStatus === 'failed') continue;
    const transport = raw.transport === 'sse' || raw.transport === 'http' || raw.transport === 'stdio' ? raw.transport : 'http';
    const base = { id, name: String(raw.name ?? id), enabled: true, description: raw.description ? String(raw.description) : undefined };
    if (transport === 'stdio' && raw.command) {
      out.push({
        ...base,
        transport,
        command: String(raw.command),
        args: Array.isArray(raw.args) ? (raw.args as string[]) : [],
        ...(raw.env && typeof raw.env === 'object' ? { env: raw.env as Record<string, string> } : {}),
        ...(raw.cwd ? { cwd: String(raw.cwd) } : {}),
      });
    } else if (raw.url) {
      out.push({ ...base, transport: transport === 'sse' ? 'sse' : 'http', url: String(raw.url), ...(raw.apiKey ? { apiKey: String(raw.apiKey) } : {}) });
    }
  }
  // Prefer market-data connectors first so they load even if later stdio servers are slow.
  const rank = (id: string) => {
    if (id.includes('stock') || id.includes('akshare')) return 0;
    if (id.includes('fetch') || id.includes('memory')) return 1;
    return 2;
  };
  out.sort((a, b) => rank(a.id) - rank(b.id));
  console.info('[orch] resolved MCP connectors', {
    ownerUserId: ownerUserId || null,
    requested: [...wanted],
    connectors: out.map((item) => item.id),
  });
  return out.slice(0, 12);
}

async function knowledgeBasesFor(store: KeyValueStore, prefs: PrefsRow, modelSettingsRaw: unknown): Promise<ChatRunContext['knowledgeBases']> {
  const provider = prefs.knowledgeProvider;
  if (!provider || provider === 'off') return [];
  const modelSettings = (modelSettingsRaw && typeof modelSettingsRaw === 'object' ? modelSettingsRaw : {}) as ModelSettings;
  const configuredModels = Array.isArray(modelSettings.models) ? modelSettings.models : [];
  const providerInstances = Array.isArray(modelSettings.providerInstances) ? modelSettings.providerInstances : [];
  const bases = rows(await kvJson(store, KB_BASES_KEY)) as Array<Record<string, unknown>>;
  const providersRaw = rows(await kvJson(store, KB_PROVIDERS_KEY)) as Array<Record<string, unknown>>;
  const wanted = new Set(prefs.knowledgeBaseIds ?? []);
  const out: ChatRunContext['knowledgeBases'] = [];
  for (const raw of bases) {
    const id = String(raw.id ?? '');
    if (!id || String(raw.provider ?? '') !== provider) continue;
    if (wanted.size > 0 && !wanted.has(id)) continue;
    const providerRow = providersRaw.find((item) => String(item.id ?? '') === provider || String(item.provider ?? '') === provider);
    const apiKey = raw.apiKey ? String(raw.apiKey) : providerRow?.apiKey ? String(providerRow.apiKey) : undefined;
    const embeddingConfigId = raw.embeddingMode === 'model'
      ? String(raw.embeddingModelConfigId || '')
      : raw.embeddingMode === 'system'
        ? String(modelSettings.activeEmbeddingModelId || '')
        : '';
    const embeddingModel = embeddingConfigId
      ? configuredModels.find((item) => item.id === embeddingConfigId && item.capability === 'embedding')
      : undefined;
    const embeddingProvider = embeddingModel
      ? providerInstances.find((item) => item.id === embeddingModel.providerInstanceId)
      : undefined;
    out.push({
      id,
      name: String(raw.name ?? id),
      provider: String(raw.provider ?? provider) as ChatRunContext['knowledgeBases'][number]['provider'],
      enabled: raw.enabled !== false,
      ontologyEnabled: raw.ontologyEnabled !== false,
      description: raw.description ? String(raw.description) : undefined,
      ...(raw.dataDir ? { dataDir: String(raw.dataDir) } : {}),
      ...(raw.baseUrl ? { baseUrl: String(raw.baseUrl) } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(raw.externalId ? { externalId: String(raw.externalId) } : {}),
      ...((embeddingProvider?.baseUrl || raw.embeddingBaseUrl) ? { embeddingBaseUrl: String(embeddingProvider?.baseUrl || raw.embeddingBaseUrl) } : {}),
      ...((embeddingProvider?.apiKey || raw.embeddingApiKey || embeddingProvider?.type === 'ollama') ? { embeddingApiKey: String(embeddingProvider?.apiKey || raw.embeddingApiKey || 'ollama') } : {}),
      ...((embeddingModel?.modelId || raw.embeddingModel) ? { embeddingModel: String(embeddingModel?.modelId || raw.embeddingModel) } : {}),
      ...(raw.embeddingMode === 'system' || raw.embeddingMode === 'model' ? { embeddingMode: raw.embeddingMode } : {}),
      ...(raw.embeddingModelConfigId ? { embeddingModelConfigId: String(raw.embeddingModelConfigId) } : {}),
      ...((embeddingModel?.meta || raw.embeddingMeta) && typeof (embeddingModel?.meta || raw.embeddingMeta) === 'object'
        ? { embeddingMeta: (embeddingModel?.meta || raw.embeddingMeta) as ChatRunContext['knowledgeBases'][number]['embeddingMeta'] }
        : {}),
      ...(raw.indexState && typeof raw.indexState === 'object'
        ? { indexState: raw.indexState as ChatRunContext['knowledgeBases'][number]['indexState'] }
        : {}),
    });
  }
  return out;
}

/**
 * MCP connectors for an employee (prefs association, or auto-default when empty).
 * Independent of model resolution so chat can backfill tools even when the
 * client already supplied the model.
 */
export async function resolveEmployeeMcpConnections(
  store: KeyValueStore,
  employeeId: string,
  ownerUserId?: string | null,
): Promise<ChatRunContext['mcpConnections']> {
  const prefsAll = await readEmployeePrefsMap(store, ownerUserId);
  const prefs = (prefsAll[employeeId] ?? {}) as PrefsRow;
  return mcpConnectionsFor(store, prefs, ownerUserId);
}

/** Text-model-only resolution; never fall back to another user's employee preferences. */
export async function resolveEmployeeChatModel(store:KeyValueStore,employeeId:string,ownerUserId?:string|null):Promise<ChatRunContext['model']|null>{
  const scoped=ownerUserId?await kvJson(store,`user:${ownerUserId}:${PREFS_KEY}`):null;
  const shared=await kvJson(store,PREFS_KEY);
  const prefsAll=(scoped&&typeof scoped==='object'&&!Array.isArray(scoped)?scoped:shared&&typeof shared==='object'&&!Array.isArray(shared)?shared:{}) as Record<string,PrefsRow>;
  const secrets=await ensureModelSecrets();
  return modelFor(employeeId,(prefsAll[employeeId]??{}) as PrefsRow,secrets.model);
}

/** Build a full run context from domain KV + keyring; null means no chat model. */
export async function resolveTaskContext(
  store: KeyValueStore,
  task: ProjectTask,
  ownerUserId?: string | null,
): Promise<ChatRunContext | null> {
  if (task.employeeId.startsWith('integration:coze:')) {
    return {
      profile: { id: task.employeeId, name: 'Coze 工作流节点', instructions: '由工作流显式调用 Coze Bot。', toolIds: [] },
      model: { provider: 'openai-compatible', chatModel: 'coze-workflow', apiKey: '' },
      skills: [], searchProviders: [], mcpConnections: [], knowledgeBases: [],
      maxSteps: 50, runTimeoutMs: 300_000, mcpToolTimeoutMs: 60_000, workspaceAccess: 'read',
      engine: 'coze-workflow',
    };
  }
  const employees = rows(await kvJson(store, EMPLOYEES_KEY)) as EmployeeRow[];
  const overridesRaw = await kvJson(store, OVERRIDES_KEY);
  const overrides = overridesRaw && typeof overridesRaw === 'object' ? (overridesRaw as Record<string, { description?: string; instructions?: string }>) : {};
  const prefsAll = await readEmployeePrefsMap(store, ownerUserId);
  const prefs = (prefsAll[task.employeeId] ?? {}) as PrefsRow;
  // Refresh keyring when empty: model settings are often saved after API boot.
  const secrets = await ensureModelSecrets();

  const model = modelFor(task.employeeId, prefs, secrets.model);
  if (!model) return null;

  const tier = task.permissionTier ?? 'default';
  const searchMode = prefs.searchMode;
  const enableSearch = searchMode === 'llm-builtin' && (model.provider === 'qwen' || model.provider === 'openai-compatible');
  const maxSteps = taskMaxSteps(task, prefs);
  // 600s was the former persisted default; migrate it to the new 30-minute
  // platform default while preserving every other explicit custom value.
  const runTimeoutMs = prefs.runTimeoutMs === 600_000 ? 1_800_000 : (prefs.runTimeoutMs ?? 1_800_000);
  const mcpToolTimeoutMs = prefs.mcpToolTimeoutMs ?? 60_000;
  const engineRaw = String(prefs.engine || '').trim().toLowerCase();
  const engine =
    engineRaw === 'pi' || engineRaw === 'agentscope' || engineRaw === 'dsh' || engineRaw === 'opencode' || engineRaw === 'claude-code'
      ? engineRaw
      : undefined;

  return {
    profile: profileFor(task.employeeId, employees, overrides),
    model: enableSearch ? { ...model, enableSearch: true } : model,
    skills: await resolveSkillRuntimeFor(store, task, tier, ownerUserId),
    searchProviders: enableSearch ? [] : searchProvidersFor(prefs, secrets.search),
    mcpConnections: await mcpConnectionsFor(store, prefs, ownerUserId),
    knowledgeBases: await knowledgeBasesFor(store, prefs, secrets.model),
    modelCapabilities: modelCapabilitiesFor(task.employeeId, secrets.model, prefs.useApplicationModels !== false),
    ...(decisionRuntimeFor(secrets.model) ? { decisionRuntime: decisionRuntimeFor(secrets.model) } : {}),
    maxSteps,
    runTimeoutMs,
    mcpToolTimeoutMs,
    workspaceAccess: tier === 'read-only' ? 'read' : tier === 'full' ? 'full' : 'write',
    ...(engine ? { engine } : {}),
  };
}
