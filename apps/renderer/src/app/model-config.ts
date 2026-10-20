import { computed, ref } from 'vue';
import { DEFAULT_EMBEDDING_META, resolveProviderServiceEndpoint, suggestedSpeechVoices } from '@openclawx/contracts';
import type { AgentCapabilityAssignment, AgentCapabilityMode, CapabilityBinding, DecisionGuardPolicy, DecisionProtocol, DecisionRuntimeConfig, ImageGenerationProtocol, ModelCapability, ProviderEndpointKind, ProviderEndpointOverrides, ProviderService } from '@openclawx/contracts';
import { getServerModelConfig, saveServerModelConfig, setCapabilityHealthObserver, type CapabilityHealthObservation } from '../services/api.js';
import { getLegacyRealtimeMigrationSource } from '../services/realtime-voice.js';

export const providerIds = ['openai', 'anthropic', 'google', 'deepseek', 'glm', 'qwen', 'volcengine', 'iflytek', 'ollama', 'openai-compatible'] as const;
export type ProviderId = (typeof providerIds)[number];
export type { AgentCapabilityAssignment, AgentCapabilityMode, CapabilityBinding, ImageGenerationProtocol, ModelCapability };

export const imageGenerationProtocols: ImageGenerationProtocol[] = ['openai-images', 'dashscope-multimodal', 'dashscope-image-async'];

export const modelCapabilities: ModelCapability[] = ['chat', 'quantum-code', 'image', 'video', 'vision', 'embedding', 'asr', 'tts', 'realtime', 'decision', 'ontology'];

/** Connection instance — same provider type can appear multiple times. */
export interface ProviderInstance {
  id: string;
  type: ProviderId;
  name: string;
  baseUrl: string;
  /** Product line sharing this connection's credential set. Missing means legacy single-endpoint behavior. */
  service?: ProviderService;
  /** Expert overrides. Official endpoints are derived from vendor + service + region/workspace. */
  endpoints?: ProviderEndpointOverrides;
  /** Optional Bailian workspace. Region is inferred from the API host. */
  workspaceId?: string;
  /** Vendor application identifier used by Volcengine and iFlytek speech APIs. */
  appId?: string;
  /** Additional signing secret used by iFlytek speech APIs. */
  apiSecret?: string;
  apiKey: string;
  disableThinking: boolean;
}

/** User-registered model that appears in pickers across the app. */
export interface ConfiguredModel {
  supportsVision?: boolean;
  id: string;
  providerInstanceId: string;
  capability: ModelCapability;
  modelId: string;
  label?: string;
  /** Default system voice or a pre-authorized cloned voice identifier for TTS. */
  voice?: string;
  /** Transport protocol is independent from both provider brand and image capability. */
  imageProtocol?: ImageGenerationProtocol;
  /** Decision-provider wire protocol; independent from the Provider connection type. */
  decisionProtocol?: DecisionProtocol;
  meta?: {
    dimension?: number;
    normalize?: boolean;
    maxBatch?: number;
    maxInputChars?: number;
  };
  /**
   * Chat models that support provider-native web search (e.g. Bailian/Qwen `enable_search`).
   * Only meaningful for qwen / openai-compatible connections.
   */
  supportsBuiltinWebSearch?: boolean;
  /** Latest passive verification from a real capability invocation. */
  health?: {
    status: 'available' | 'configuration_error' | 'permission_error' | 'temporarily_unavailable';
    checkedAt: string;
    summary: string;
  };
}

/**
 * Runtime payload for chat / agent calls.
 * `id` is the configured-model id used by pickers; connection fields come from the provider instance.
 */
export interface ProviderConfig {
  supportsVision?: boolean;
  id: string;
  providerInstanceId: string;
  providerLabel: string;
  provider: ProviderId;
  baseUrl: string;
  chatModel: string;
  chatModels: string[];
  disableThinking: boolean;
  /** Capability flag from configured model registry. */
  supportsBuiltinWebSearch: boolean;
  imageModel: string;
  embeddingModel: string;
  asrModel: string;
  ttsModel: string;
  apiKey: string;
  appId?: string;
  apiSecret?: string;
}

export interface ModelSettings {
  version: 3;
  providerInstances: ProviderInstance[];
  models: ConfiguredModel[];
  /** Default chat model for the main workspace selector. */
  activeChatModelId: string | null;
  /**
   * System-wide embedding / vector model for experience memory, local knowledge,
   * and other tools that need embeddings. Unset ⇒ vector features are not ready.
   */
  activeEmbeddingModelId: string | null;
  /** Per digital-employee default when acting as sub-agent / collaborator. */
  employeeDefaultModelIds: Record<string, string>;
  /** Default model per specialist capability; independent from the controller chat model. */
  capabilityBindings: CapabilityBinding[];
  /** Explicit per-agent authorization. Missing entries resolve to disabled. */
  agentCapabilityAssignments: AgentCapabilityAssignment[];
  decisionRuntime?: DecisionGuardPolicy;
}

export interface LocalEmbeddingProviderDraft {
  suggestedProviderName: string;
  providerType: 'openai-compatible';
  baseUrl: string;
  embeddingModel: string;
  meta?: {
    dimension?: number;
    normalize?: boolean;
    maxBatch?: number;
    maxInputChars?: number;
  };
}

export const providerSuggestedChatModels: Partial<Record<ProviderId, string[]>> = {
  openai: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'o3-mini', 'gpt-4o'],
  anthropic: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-5'],
  google: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash'],
  glm: ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2', 'glm-4.7-flash'],
  qwen: ['qwen3.8-flash', 'qwen3.8-max', 'qwen3.7-plus', 'qwen3.7-flash', 'qwen-plus'],
  volcengine: ['doubao-seed-2-1-pro-260628'],
  ollama: ['llama3.2', 'qwen2.5', 'deepseek-r1', 'mistral'],
  'openai-compatible': [],
};

export const providerSuggestedByCapability: Partial<Record<ProviderId, Partial<Record<ModelCapability, string[]>>>> = {
  openai: {
    chat: providerSuggestedChatModels.openai,
    image: ['gpt-image-1', 'dall-e-3'],
    embedding: ['text-embedding-3-small', 'text-embedding-3-large'],
    asr: ['gpt-4o-mini-transcribe', 'whisper-1'],
    tts: ['gpt-4o-mini-tts', 'tts-1'],
  },
  anthropic: { chat: providerSuggestedChatModels.anthropic },
  google: {
    chat: providerSuggestedChatModels.google,
    image: ['gemini-2.5-flash-image'],
    embedding: ['text-embedding-004'],
  },
  deepseek: { chat: providerSuggestedChatModels.deepseek },
  glm: {
    chat: providerSuggestedChatModels.glm,
    vision: ['glm-4.6v-flash', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5v-turbo'],
    image: ['cogview-3-flash', 'glm-image', 'cogview-4-250304'],
    video: ['cogvideox-flash', 'cogvideox-3', 'cogvideox-2'],
    embedding: ['embedding-3'],
  },
  qwen: {
    chat: providerSuggestedChatModels.qwen,
    vision: ['qwen-vl-plus', 'qwen3.8-flash', 'qwen3.8-max', 'qwen3.7-plus', 'qwen3.7-flash', 'qwen3.5-ocr', 'qwen3-vl-flash', 'qwen-vl-max'],
    image: ['qwen-image-2.0', 'qwen-image-3.0-pro', 'qwen-image-3.0', 'qwen-image', 'wan2.7-image-pro', 'wan2.7-image', 'wan2.6-t2i', 'wan2.5-t2i-preview', 'wan2.2-t2i-flash'],
    embedding: ['text-embedding-v4', 'text-embedding-v3'],
    asr: ['qwen-audio-3.1-asr-flash-filetrans', 'qwen-audio-3.0-asr-flash-filetrans', 'paraformer-v2', 'paraformer-8k-v2'],
    tts: ['qwen-audio-3.1-tts-flash', 'qwen-audio-3.0-tts-flash', 'cosyvoice-v3-flash', 'cosyvoice-v2'],
    realtime: ['qwen-audio-3.1-realtime-plus', 'qwen3.8-omni-flash-realtime'],
  },
  volcengine: { chat: providerSuggestedChatModels.volcengine, asr: ['bigmodel'], tts: ['volc-tts'], realtime: ['1.2.6.1'] },
  iflytek: { asr: ['ifasr'], tts: ['online-tts'] },
  ollama: { chat: providerSuggestedChatModels.ollama },
  // Compatible services are intentionally vendor-neutral. eSight is entered
  // as a model ID under `quantum-code`, never as a provider protocol/type.
  'openai-compatible': { chat: [], 'quantum-code': [], image: [], video: [], vision: [], embedding: [], asr: [], tts: [], realtime: [], decision: [], ontology: [] },
};

const providerAutoProfiles: Partial<Record<ProviderId, Partial<Record<ModelCapability, string>>>> = {
  openai: { chat: 'gpt-4.1-mini', vision: 'gpt-4.1-mini', image: 'gpt-image-1', embedding: 'text-embedding-3-small', asr: 'gpt-4o-mini-transcribe', tts: 'gpt-4o-mini-tts' },
  anthropic: { chat: 'claude-sonnet-4-5', vision: 'claude-sonnet-4-5' },
  google: { chat: 'gemini-2.5-flash', vision: 'gemini-2.5-flash', image: 'gemini-2.5-flash-image', embedding: 'text-embedding-004' },
  deepseek: { chat: 'deepseek-chat' },
  // Official catalog checked 2026-10-09: image/vision Flash models are free;
  // GLM-5.3 and embedding-3 are not covered by that free-model policy.
  glm: { chat: 'glm-5.3', vision: 'glm-4.6v-flash', image: 'cogview-3-flash', video: 'cogvideox-flash', embedding: 'embedding-3' },
  qwen: { chat: 'qwen3.8-flash', vision: 'qwen-vl-plus', image: 'qwen-image-2.0', embedding: 'text-embedding-v4', asr: 'qwen-audio-3.1-asr-flash-filetrans', tts: 'qwen-audio-3.1-tts-flash', realtime: 'qwen-audio-3.1-realtime-plus' },
  volcengine: { chat: 'doubao-seed-2-1-pro-260628', asr: 'bigmodel', tts: 'volc-tts', realtime: '1.2.6.1' },
  iflytek: { asr: 'ifasr', tts: 'online-tts' },
  ollama: { chat: 'llama3.2' },
};

export interface ProviderAutoConfigurationResult {
  settings: ModelSettings;
  configured: ModelCapability[];
  addedModels: number;
  preserved: ModelCapability[];
  manualRequired: boolean;
}

export function migrateLegacyRealtimeProvider(current: ModelSettings, legacy: { apiKey?: string; model?: string; voice?: string }) {
  if (!legacy.apiKey?.trim() || current.models.some((item) => item.capability === 'realtime')) return current;
  const provider = createProviderInstance('volcengine', current.providerInstances);
  provider.service = 'realtime'; provider.name = suggestedProviderConnectionName('volcengine', 'realtime', current.providerInstances);
  provider.baseUrl = defaultProviderBaseUrlForService('volcengine', 'realtime'); provider.apiKey = legacy.apiKey.trim();
  const next = applyRecommendedProviderSetup(current, provider).settings;
  const realtime = next.models.find((item) => item.providerInstanceId === provider.id && item.capability === 'realtime');
  if (realtime) { realtime.modelId = legacy.model?.trim() || realtime.modelId; realtime.voice = legacy.voice?.trim() || realtime.voice; }
  return sanitizeModelSettings(next);
}

export const MODEL_HEALTH_FRESH_MS = 30 * 24 * 60 * 60 * 1000;

export function modelHealthIsStale(model: ConfiguredModel, now = Date.now()) {
  if (!model.health?.checkedAt) return false;
  const checkedAt = Date.parse(model.health.checkedAt);
  return !Number.isFinite(checkedAt) || now - checkedAt > MODEL_HEALTH_FRESH_MS;
}

export function summarizeProviderModelHealth(models: ConfiguredModel[], providerInstanceId: string, now = Date.now()) {
  const scoped = models.filter((item) => item.providerInstanceId === providerInstanceId);
  return {
    total: scoped.length,
    available: scoped.filter((item) => item.health?.status === 'available' && !modelHealthIsStale(item, now)).length,
    issues: scoped.filter((item) => item.health && item.health.status !== 'available' && !modelHealthIsStale(item, now)).length,
    stale: scoped.filter((item) => modelHealthIsStale(item, now)).length,
    unverified: scoped.filter((item) => !item.health).length,
  };
}

/** Add only missing recommended entries. Existing user choices always win. */
export function applyRecommendedProviderSetup(
  current: ModelSettings,
  instance: ProviderInstance,
  agentIds: string[] = ['general'],
): ProviderAutoConfigurationResult {
  const settingsValue: ModelSettings = JSON.parse(JSON.stringify(current));
  if (!settingsValue.providerInstances.some((item) => item.id === instance.id)) settingsValue.providerInstances.push(JSON.parse(JSON.stringify(instance)));
  const profile = { ...(providerAutoProfiles[instance.type] ?? {}) };
  if (instance.service === 'language') {
    delete profile.asr;
    delete profile.tts;
    delete profile.realtime;
  } else if (instance.service === 'speech' || instance.service === 'realtime') {
    for (const capability of ['chat', 'vision', 'image', 'video', 'embedding', 'decision', 'ontology', 'quantum-code'] as ModelCapability[]) delete profile[capability];
    if (instance.service === 'speech' && instance.type !== 'volcengine') delete profile.realtime;
    if (instance.service === 'speech' && instance.type === 'volcengine' && !instance.appId?.trim()) delete profile.tts;
    if (instance.service === 'realtime') { delete profile.asr; delete profile.tts; }
  }
  const configured: ModelCapability[] = [];
  const preserved: ModelCapability[] = [];
  let addedModels = 0;
  for (const capability of modelCapabilities) {
    const modelId = profile[capability];
    if (!modelId) continue;
    let model = settingsValue.models.find((item) => item.providerInstanceId === instance.id && item.capability === capability && item.modelId === modelId);
    if (!model) {
      model = {
        id: newId(), providerInstanceId: instance.id, capability, modelId,
        ...(capability === 'chat' && ['openai', 'anthropic', 'google', 'qwen'].includes(instance.type) ? { supportsVision: true } : {}),
        ...(capability === 'chat' && instance.type === 'qwen' ? { supportsBuiltinWebSearch: true } : {}),
        ...(capability === 'image' ? { imageProtocol: inferImageGenerationProtocol(instance.type, modelId) } : {}),
        ...(capability === 'tts' ? { voice: suggestedSpeechVoices(instance.type, modelId)[0] } : {}),
        ...(capability === 'realtime' ? { voice: suggestedSpeechVoices(instance.type, modelId)[0] } : {}),
      };
      settingsValue.models.push(model);
      addedModels += 1;
    }
    if (capability === 'chat') {
      if (!settingsValue.activeChatModelId) settingsValue.activeChatModelId = model.id;
      else if (settingsValue.activeChatModelId !== model.id) preserved.push(capability);
      configured.push(capability);
      continue;
    }
    if (capability === 'embedding' && !settingsValue.activeEmbeddingModelId) settingsValue.activeEmbeddingModelId = model.id;
    const existingBinding = settingsValue.capabilityBindings.find((item) => item.capability === capability && item.enabled);
    if (!existingBinding) {
      settingsValue.capabilityBindings = settingsValue.capabilityBindings.filter((item) => item.capability !== capability);
      settingsValue.capabilityBindings.push({ capability, modelId: model.id, enabled: true, updatedAt: new Date().toISOString() });
    } else if (existingBinding.modelId !== model.id) preserved.push(capability);
    for (const agentId of [...new Set(agentIds.filter(Boolean))]) {
      if (settingsValue.agentCapabilityAssignments.some((item) => item.agentId === agentId && item.capability === capability)) continue;
      settingsValue.agentCapabilityAssignments.push({ agentId, capability, mode: 'auto', updatedAt: new Date().toISOString() });
    }
    configured.push(capability);
  }
  return {
    settings: sanitizeModelSettings(settingsValue), configured: [...new Set(configured)], addedModels,
    preserved: [...new Set(preserved)], manualRequired: configured.length === 0,
  };
}

/** Best-effort filtering for large remote catalogs. Manual entry and “show all” remain available. */
export function modelLikelySupportsCapability(modelId: string, capability: ModelCapability) {
  const id = modelId.toLowerCase();
  const patterns: Partial<Record<ModelCapability, RegExp>> = {
    image: /(image|text.?to.?image|t2i|wan\d|cogview|seedream|dall-e)/,
    video: /(video|text.?to.?video|t2v|cogvideo|vidu)/,
    embedding: /(embed|embedding|vector)/,
    asr: /(asr|speech.?to.?text|transcri|whisper|paraformer|recogn)/,
    tts: /(tts|text.?to.?speech|speech.?synth|cosyvoice)/,
    realtime: /(realtime|duplex|omni|speech.?to.?speech|1\.2\.6\.1)/,
    'quantum-code': /(quantum|esight)/,
    vision: /(vision|(?:^|[-_])vl(?:[-_]|$)|gemini|claude|gpt-4o|gpt-4\.1)/,
  };
  const selected = patterns[capability];
  if (selected) return selected.test(id);
  if (capability === 'chat') return !Object.entries(patterns).some(([key, pattern]) => key !== 'quantum-code' && key !== 'vision' && pattern?.test(id));
  return true;
}

export const defaultBaseUrl: Record<ProviderId, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
  iflytek: 'https://raasr.xfyun.cn',
  ollama: 'http://127.0.0.1:11434/v1',
  'openai-compatible': '',
};

/** @deprecated kept for migration helpers */
export const providerDefaults: Record<ProviderId, Omit<ProviderConfig, 'apiKey' | 'id' | 'providerInstanceId' | 'providerLabel'>> = {
  openai: { provider: 'openai', baseUrl: defaultBaseUrl.openai, chatModel: 'gpt-4.1-mini', chatModels: ['gpt-4.1-mini'], disableThinking: false, supportsBuiltinWebSearch: false, imageModel: 'gpt-image-1', embeddingModel: 'text-embedding-3-small', asrModel: 'gpt-4o-mini-transcribe', ttsModel: 'gpt-4o-mini-tts' },
  anthropic: { provider: 'anthropic', baseUrl: '', chatModel: 'claude-sonnet-4-5', chatModels: ['claude-sonnet-4-5'], disableThinking: false, supportsBuiltinWebSearch: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
  google: { provider: 'google', baseUrl: '', chatModel: 'gemini-2.5-flash', chatModels: ['gemini-2.5-flash'], disableThinking: false, supportsBuiltinWebSearch: false, imageModel: 'gemini-2.5-flash-image', embeddingModel: 'text-embedding-004', asrModel: '', ttsModel: '' },
  deepseek: { provider: 'deepseek', baseUrl: defaultBaseUrl.deepseek, chatModel: 'deepseek-chat', chatModels: ['deepseek-chat'], disableThinking: false, supportsBuiltinWebSearch: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
  glm: { provider: 'glm', baseUrl: defaultBaseUrl.glm, chatModel: 'glm-5.3', chatModels: ['glm-5.3'], disableThinking: false, supportsBuiltinWebSearch: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
  qwen: { provider: 'qwen', baseUrl: defaultBaseUrl.qwen, chatModel: 'qwen-plus', chatModels: ['qwen-plus'], disableThinking: false, supportsBuiltinWebSearch: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
  volcengine: { provider: 'volcengine', baseUrl: defaultBaseUrl.volcengine, chatModel: '', chatModels: [], disableThinking: false, supportsBuiltinWebSearch: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
  iflytek: { provider: 'iflytek', baseUrl: defaultBaseUrl.iflytek, chatModel: '', chatModels: [], disableThinking: false, supportsBuiltinWebSearch: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
  ollama: { provider: 'ollama', baseUrl: defaultBaseUrl.ollama, chatModel: 'llama3.2', chatModels: [], disableThinking: false, supportsBuiltinWebSearch: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
  'openai-compatible': { provider: 'openai-compatible', baseUrl: '', chatModel: '', chatModels: [], disableThinking: false, supportsBuiltinWebSearch: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
};

export const ollamaLibraryCatalog = [
  'llama3.2', 'llama3.1', 'qwen2.5', 'qwen2.5:7b', 'qwen2.5-coder', 'deepseek-r1', 'mistral', 'gemma2', 'phi3', 'codellama',
];

const settings = ref<ModelSettings>(emptySettings());
const loaded = ref(false);
export const ollamaLocalModelNames = ref<string[]>([]);
let healthSaveTimer: ReturnType<typeof setTimeout> | undefined;

export function classifyCapabilityFailure(summary: string): NonNullable<ConfiguredModel['health']>['status'] {
  const text = summary.toLowerCase();
  if (/(401|403|permission|forbidden|unauthori|api.?key|无权限|未授权)/.test(text)) return 'permission_error';
  if (/(400|404|model.*not found|workspace|endpoint|invalid|参数|配置|未开通|不存在)/.test(text)) return 'configuration_error';
  return 'temporarily_unavailable';
}

function observeCapabilityHealth(observation: CapabilityHealthObservation) {
  if (!loaded.value) return;
  const candidates = settings.value.models.filter((item) => item.capability === observation.capability && item.modelId === observation.modelId);
  const boundId = settings.value.capabilityBindings.find((item) => item.capability === observation.capability && item.enabled)?.modelId;
  const model = candidates.find((item) => item.id === boundId) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!model) return;
  model.health = {
    status: observation.ok ? 'available' : classifyCapabilityFailure(observation.summary),
    checkedAt: new Date().toISOString(),
    summary: observation.summary.slice(0, 500),
  };
  if (healthSaveTimer) clearTimeout(healthSaveTimer);
  healthSaveTimer = setTimeout(() => {
    const snapshot = sanitizeModelSettings(JSON.parse(JSON.stringify(settings.value)) as ModelSettings);
    void (window.openclawxDesktop ? window.openclawxDesktop.saveModelConfig(snapshot) : saveServerModelConfig(snapshot)).catch(() => undefined);
  }, 150);
}

setCapabilityHealthObserver(observeCapabilityHealth);

function newId() {
  return crypto.randomUUID();
}

export function defaultDecisionRuntime(): DecisionGuardPolicy {
  return { enabled: false, mode: 'off', timeoutMs: 1500, failurePolicy: 'allow', guardTools: true, agentTool: true, mcpEnabled: false };
}

function normalizeDecisionPolicy(raw: unknown): DecisionGuardPolicy {
  const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const mode = row.mode === 'observe' || row.mode === 'enforce' ? row.mode : 'off';
  const timeout = Math.round(Number(row.timeoutMs) || 1500);
  return {
    enabled: Boolean(row.enabled),
    mode,
    ...(String(row.applicationModelId || '').trim() ? { applicationModelId: String(row.applicationModelId).trim() } : {}),
    timeoutMs: Math.min(10_000, Math.max(200, timeout)),
    failurePolicy: row.failurePolicy === 'deny' ? 'deny' : 'allow',
    guardTools: row.guardTools !== false,
    agentTool: row.agentTool !== false,
    mcpEnabled: Boolean(row.mcpEnabled),
  };
}

function emptySettings(): ModelSettings {
  return { version: 3, providerInstances: [], models: [], activeChatModelId: null, activeEmbeddingModelId: null, employeeDefaultModelIds: {}, capabilityBindings: [], agentCapabilityAssignments: [], decisionRuntime: defaultDecisionRuntime() };
}

export function providerCanBuiltinWebSearch(provider: ProviderId) {
  return provider === 'qwen' || provider === 'openai-compatible';
}

export function inferImageGenerationProtocol(provider: ProviderId, modelId: string): ImageGenerationProtocol {
  const id = modelId.trim().toLowerCase();
  if (provider !== 'qwen') return 'openai-images';
  if (/^qwen-image-3(?:\.|-|$)/.test(id)) return 'openai-images';
  if (/^(wan2\.[0-5]|wanx)/.test(id)) return 'dashscope-image-async';
  return 'dashscope-multimodal';
}

export function providerNeedsApiKey(provider: ProviderId) {
  return provider !== 'ollama' && provider !== 'openai-compatible';
}

export function providerSupportsOpenAiModelList(provider: ProviderId) {
  return provider === 'openai' || provider === 'deepseek' || provider === 'glm' || provider === 'qwen' || provider === 'volcengine' || provider === 'openai-compatible' || provider === 'ollama';
}

export function uniqueModels(values: string[]) {
  const seen = new Set<string>();
  return values.map((item) => item.trim()).filter((item) => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

export function ollamaModelIsLocal(name: string) {
  if (!ollamaLocalModelNames.value.length) return true;
  const base = name.split(':')[0].toLowerCase();
  return ollamaLocalModelNames.value.some((item) => item === name || item.split(':')[0].toLowerCase() === base);
}

export function defaultProviderName(type: ProviderId, existing: ProviderInstance[]) {
  const count = existing.filter((item) => item.type === type).length + 1;
  const labels: Record<ProviderId, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google',
    deepseek: 'DeepSeek',
    glm: 'GLM（智谱）',
    qwen: '通义千问',
    volcengine: '火山引擎',
    iflytek: '科大讯飞',
    ollama: 'Ollama',
    'openai-compatible': 'OpenAI 兼容',
  };
  return count <= 1 ? labels[type] : `${labels[type]} #${count}`;
}

export function suggestedProviderConnectionName(type: ProviderId, service: ProviderService, existing: ProviderInstance[]) {
  const base = defaultProviderName(type, existing);
  if (providerServiceOptions(type).length <= 1 || service === 'unified') return base;
  const suffix: Record<ProviderService, string> = { language: '大模型', speech: '语音', realtime: '实时语音', unified: '' };
  return `${base} · ${suffix[service]}`;
}

export function providerSupportsRecommendedSetup(instance: Pick<ProviderInstance, 'type' | 'service'>) {
  return Boolean(providerAutoProfiles[instance.type] && Object.keys(providerAutoProfiles[instance.type] ?? {}).length);
}

export function createProviderInstance(type: ProviderId, existing: ProviderInstance[] = []): ProviderInstance {
  const service = defaultProviderService(type);
  return {
    id: newId(),
    type,
    name: suggestedProviderConnectionName(type, service, existing),
    baseUrl: defaultProviderBaseUrlForService(type, service),
    service,
    endpoints: {},
    workspaceId: '',
    appId: '',
    apiSecret: '',
    apiKey: '',
    disableThinking: false,
  };
}

export function providerInstanceReady(instance: ProviderInstance) {
  if (instance.type === 'openai-compatible' && !instance.baseUrl.trim()) return false;
  if (providerNeedsApiKey(instance.type) && !instance.apiKey.trim()) return false;
  if (instance.type === 'iflytek' && !instance.appId?.trim()) return false;
  if (instance.type === 'iflytek' && !instance.apiSecret?.trim()) return false;
  if (instance.type === 'ollama' && !instance.baseUrl.trim()) return false;
  if (instance.baseUrl.trim()) {
    try { new URL(instance.baseUrl); } catch { return false; }
  }
  return true;
}

function inferLegacyProviderService(instance: Pick<ProviderInstance, 'type' | 'baseUrl' | 'appId'>): ProviderService {
  if (instance.type === 'volcengine' && (/openspeech|speech/i.test(instance.baseUrl) || Boolean(instance.appId))) return 'speech';
  return defaultProviderService(instance.type);
}

export function providerServiceOptions(provider: ProviderId): ProviderService[] {
  if (provider === 'volcengine') return ['language', 'speech', 'realtime'];
  if (provider === 'qwen' || provider === 'openai') return ['unified', 'language', 'speech'];
  if (provider === 'iflytek') return ['speech'];
  return ['language'];
}

/** UI scenarios are simpler than persisted legacy protocol categories. */
export function providerServiceChoices(provider: ProviderId): ProviderService[] {
  return providerServiceOptions(provider).filter(service => service !== 'realtime');
}

export function visibleProviderService(service: ProviderService | undefined): ProviderService {
  return service === 'realtime' ? 'speech' : service || 'language';
}

/**
 * Only expose product-line selection when one credential cannot reliably cover
 * every adapted service. Unified providers keep their internal legacy options
 * for backwards compatibility, but new and edited connections stay simple.
 */
export function providerRequiresServiceSelection(provider: ProviderId) {
  return provider === 'volcengine';
}

export function defaultProviderService(provider: ProviderId): ProviderService {
  if (provider === 'qwen' || provider === 'openai') return 'unified';
  if (provider === 'iflytek') return 'speech';
  return 'language';
}

export function defaultProviderBaseUrlForService(provider: ProviderId, service: ProviderService) {
  if (provider === 'volcengine' && service !== 'language') return 'https://openspeech.bytedance.com';
  return defaultBaseUrl[provider];
}

export function providerDerivedEndpoints(instance: ProviderInstance) {
  const capabilities: ModelCapability[] = instance.service === 'speech' || instance.service === 'realtime'
    ? ['asr', 'tts']
    : instance.service === 'language'
      ? ['chat', 'image', 'video', 'embedding']
      : ['chat', 'image', 'video', 'embedding', 'asr', 'tts'];
  const rows = capabilities.map((capability) => ({ capability, url: effectiveProviderBaseUrl(instance, capability) }));
  if (instance.service === 'realtime' || instance.service === 'unified' || (instance.type === 'volcengine' && instance.service === 'speech')) {
    rows.push({ capability: 'realtime' as ModelCapability, url: resolveProviderServiceEndpoint({
      provider: instance.type, baseUrl: instance.baseUrl, workspaceId: instance.workspaceId,
      service: instance.service, endpoint: 'realtime', endpoints: instance.endpoints,
    }) });
  }
  return rows.filter((row, index) => row.url && rows.findIndex((candidate) => candidate.url === row.url) === index);
}

export function endpointKindForCapability(capability: ModelCapability): ProviderEndpointKind {
  if (capability === 'image' || capability === 'video') return 'image';
  if (capability === 'embedding') return 'embedding';
  if (capability === 'asr') return 'asr';
  if (capability === 'tts') return 'tts';
  if (capability === 'realtime') return 'realtime';
  return 'chat';
}

export function effectiveProviderBaseUrl(instance: ProviderInstance, capability: ModelCapability = 'chat') {
  return resolveProviderServiceEndpoint({
    provider: instance.type,
    baseUrl: instance.baseUrl,
    workspaceId: instance.workspaceId,
    service: instance.service,
    endpoint: endpointKindForCapability(capability),
    endpoints: instance.endpoints,
  });
}

/** Drop models whose provider connection is incomplete (no valid key/URL). */
export function sanitizeModelSettings(value: ModelSettings): ModelSettings {
  const instances = value.providerInstances.filter((item) => item.id);
  const readyIds = new Set(instances.filter((item) => providerInstanceReady(item)).map((item) => item.id));
  const models = value.models.filter((item) => item.modelId.trim() && readyIds.has(item.providerInstanceId));
  let activeChatModelId = value.activeChatModelId;
  if (activeChatModelId && !models.some((item) => item.id === activeChatModelId && item.capability === 'chat')) {
    activeChatModelId = models.find((item) => item.capability === 'chat')?.id ?? null;
  }
  let activeEmbeddingModelId = value.activeEmbeddingModelId ?? null;
  if (activeEmbeddingModelId && !models.some((item) => item.id === activeEmbeddingModelId && item.capability === 'embedding')) {
    activeEmbeddingModelId = models.find((item) => item.capability === 'embedding')?.id ?? null;
  }
  const employeeDefaultModelIds: Record<string, string> = {};
  for (const [employeeId, modelId] of Object.entries(value.employeeDefaultModelIds ?? {})) {
    if (models.some((item) => item.id === modelId && item.capability === 'chat')) employeeDefaultModelIds[employeeId] = modelId;
  }
  const capabilityBindings = (value.capabilityBindings ?? []).filter((binding) =>
    models.some((model) => model.id === binding.modelId && model.capability === binding.capability),
  );
  if (activeEmbeddingModelId && !capabilityBindings.some((binding) => binding.capability === 'embedding')) {
    capabilityBindings.push({ capability: 'embedding', modelId: activeEmbeddingModelId, enabled: true, updatedAt: new Date().toISOString() });
  }
  const agentCapabilityAssignments = (value.agentCapabilityAssignments ?? []).filter((assignment) =>
    assignment.agentId && modelCapabilities.includes(assignment.capability),
  );
  const decisionModelId = value.decisionRuntime?.applicationModelId;
  const decisionRuntime = {
    ...normalizeDecisionPolicy(value.decisionRuntime),
    ...(decisionModelId && models.some((item) => item.id === decisionModelId && item.capability === 'decision')
      ? { applicationModelId: decisionModelId }
      : { applicationModelId: capabilityBindings.find((item) => item.capability === 'decision' && item.enabled)?.modelId }),
  };
  return {
    version: 3,
    providerInstances: instances,
    models,
    activeChatModelId,
    activeEmbeddingModelId,
    employeeDefaultModelIds,
    capabilityBindings,
    agentCapabilityAssignments,
    decisionRuntime,
  };
}

/** Resolve the persisted guard policy + selected application model into one immutable run snapshot. */
export function resolveDecisionRuntime(settingsValue = settings.value): DecisionRuntimeConfig | undefined {
  const policy = settingsValue.decisionRuntime;
  if (!policy) return undefined;
  const selectedId = policy.applicationModelId
    ?? settingsValue.capabilityBindings.find((item) => item.capability === 'decision' && item.enabled)?.modelId;
  const model = settingsValue.models.find((item) => item.id === selectedId && item.capability === 'decision');
  const provider = model ? settingsValue.providerInstances.find((item) => item.id === model.providerInstanceId) : undefined;
  if (!model || !provider || !provider.baseUrl.trim()) return undefined;
  return {
    ...policy,
    applicationModelId: model.id,
    provider: provider.name.trim() || provider.type,
    protocol: model.decisionProtocol ?? 'system-one-v1',
    baseUrl: effectiveProviderBaseUrl(provider),
    apiKey: provider.apiKey,
    model: model.modelId,
  };
}

function migrateLegacyDecisionModel(value: ModelSettings, legacy: unknown): ModelSettings {
  const row = legacy && typeof legacy === 'object' ? legacy as Record<string, unknown> : {};
  if (value.models.some((item) => item.capability === 'decision') || !String(row.baseUrl || '').trim()) return value;
  const provider: ProviderInstance = {
    id: newId(),
    type: 'openai-compatible',
    name: String(row.provider || 'JEV').trim() || 'JEV',
    baseUrl: String(row.baseUrl),
    apiKey: String(row.apiKey || ''),
    disableThinking: false,
  };
  const model: ConfiguredModel = {
    id: newId(),
    providerInstanceId: provider.id,
    capability: 'decision',
    modelId: String(row.model || 'jev-latest'),
    decisionProtocol: 'system-one-v1',
  };
  return {
    ...value,
    providerInstances: [...value.providerInstances, provider],
    models: [...value.models, model],
    capabilityBindings: [...value.capabilityBindings.filter((item) => item.capability !== 'decision'), { capability: 'decision', modelId: model.id, enabled: true, updatedAt: new Date().toISOString() }],
    decisionRuntime: { ...normalizeDecisionPolicy(row), applicationModelId: model.id },
  };
}

export function resolveConfiguredModel(model: ConfiguredModel, instances = settings.value.providerInstances): ProviderConfig | undefined {
  const instance = instances.find((item) => item.id === model.providerInstanceId);
  if (!instance || !providerInstanceReady(instance) || !model.modelId.trim()) return undefined;
  return {
    id: model.id,
    providerInstanceId: instance.id,
    providerLabel: instance.name,
    provider: instance.type,
    baseUrl: effectiveProviderBaseUrl(instance, model.capability),
    chatModel: model.capability === 'chat' ? model.modelId : '',
    chatModels: model.capability === 'chat' ? [model.modelId] : [],
    disableThinking: instance.disableThinking,
    supportsBuiltinWebSearch: Boolean(model.supportsBuiltinWebSearch) && providerCanBuiltinWebSearch(instance.type),
    supportsVision: model.capability === 'chat' && Boolean(model.supportsVision),
    imageModel: model.capability === 'image' ? model.modelId : '',
    embeddingModel: model.capability === 'embedding' ? model.modelId : '',
    asrModel: model.capability === 'asr' ? model.modelId : '',
    ttsModel: model.capability === 'tts' ? model.modelId : '',
    apiKey: instance.apiKey,
    appId: instance.appId,
    apiSecret: instance.apiSecret,
  };
}

export function chatEndpointLabel(config: ProviderConfig) {
  return `${config.providerLabel} · ${config.chatModel}`;
}

function migrateFromV1(legacy: {
  activeProvider?: ProviderId;
  providers?: Array<{
    provider?: ProviderId;
    baseUrl?: string;
    apiKey?: string;
    chatModel?: string;
    chatModels?: string[];
    disableThinking?: boolean;
    imageModel?: string;
    embeddingModel?: string;
    asrModel?: string;
    ttsModel?: string;
  }>;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): ModelSettings {
  const next = emptySettings();
  const rows = Array.isArray(legacy.providers) ? legacy.providers : [];
  if (!rows.length && (legacy.apiKey || legacy.model)) {
    rows.push({ provider: 'openai', baseUrl: legacy.baseUrl, apiKey: legacy.apiKey, chatModel: legacy.model, chatModels: legacy.model ? [legacy.model] : [] });
  }
  for (const row of rows) {
    const type = providerIds.includes(row.provider as ProviderId) ? (row.provider as ProviderId) : 'openai';
    // Never seed catalog defaults from incomplete connections — only migrate usable providers.
    const draft: ProviderInstance = {
      id: newId(),
      type,
      name: defaultProviderName(type, next.providerInstances),
      baseUrl: row.baseUrl?.trim() || defaultBaseUrl[type],
      workspaceId: '',
      appId: '',
      apiSecret: '',
      apiKey: String(row.apiKey || ''),
      disableThinking: Boolean(row.disableThinking),
    };
    if (!providerInstanceReady(draft)) continue;

    next.providerInstances.push(draft);
    // Only carry over chat models the user actually used — not the full suggestion catalog / optional capability defaults.
    const preferred = row.chatModel?.trim() || '';
    const chatModels = uniqueModels(preferred ? [preferred] : []);
    for (const modelId of chatModels) {
      next.models.push({ id: newId(), providerInstanceId: draft.id, capability: 'chat', modelId });
    }
    if (preferred && !next.activeChatModelId) {
      next.activeChatModelId = next.models.find((item) => item.providerInstanceId === draft.id && item.capability === 'chat' && item.modelId === preferred)?.id ?? null;
    }
  }
  if (!next.activeChatModelId) {
    next.activeChatModelId = next.models.find((item) => item.capability === 'chat')?.id ?? null;
  }
  return sanitizeModelSettings(next);
}

function normalizeModelHealth(value: unknown): ConfiguredModel['health'] {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const status = String(row.status || '');
  if (!['available', 'configuration_error', 'permission_error', 'temporarily_unavailable'].includes(status)) return undefined;
  return {
    status: status as NonNullable<ConfiguredModel['health']>['status'],
    checkedAt: String(row.checkedAt || ''),
    summary: String(row.summary || '').slice(0, 500),
  };
}

function normalize(value: unknown): ModelSettings {
  const raw = (value ?? {}) as Omit<Partial<ModelSettings>, 'version'> & {
    activeProvider?: ProviderId;
    providers?: unknown[];
    version?: number;
  };
  if ((raw.version === 2 || raw.version === 3) && Array.isArray(raw.providerInstances) && Array.isArray(raw.models)) {
    const instances = raw.providerInstances
      .map((item) => ({
        id: String(item.id || newId()),
        type: providerIds.includes(item.type) ? item.type : ('openai-compatible' as ProviderId),
        name: String(item.name || '').trim() || defaultProviderName(item.type, []),
        baseUrl: String(item.baseUrl || ''),
        service: (() => {
          const type = providerIds.includes(item.type) ? item.type : 'openai-compatible';
          const requested = String(item.service || '') as ProviderService;
          return providerServiceOptions(type).includes(requested)
            ? requested
            : inferLegacyProviderService({ type, baseUrl: String(item.baseUrl || ''), appId: String(item.appId || '') });
        })(),
        endpoints: item.endpoints && typeof item.endpoints === 'object'
          ? Object.fromEntries(Object.entries(item.endpoints).filter(([, endpoint]) => {
              try { return Boolean(endpoint) && Boolean(new URL(String(endpoint))); } catch { return false; }
            })) as ProviderEndpointOverrides
          : {},
        workspaceId: String(item.workspaceId || '').trim() || undefined,
        appId: String(item.appId || '').trim() || undefined,
        apiSecret: String(item.apiSecret || ''),
        apiKey: String(item.apiKey || ''),
        disableThinking: Boolean(item.disableThinking),
      }))
      .filter((item) => item.id);
    const instanceIds = new Set(instances.map((item) => item.id));
    const models = raw.models
      .map((item) => {
        const instanceType = instances.find((row) => row.id === String(item.providerInstanceId || ''))?.type;
        const imageProtocol = String(item.imageProtocol || '') as ImageGenerationProtocol;
        const supportsBuiltinWebSearch = Boolean(item.supportsBuiltinWebSearch)
          && Boolean(instanceType && providerCanBuiltinWebSearch(instanceType));
        return {
          id: String(item.id || newId()),
          providerInstanceId: String(item.providerInstanceId || ''),
          capability: (modelCapabilities.includes(item.capability) ? item.capability : 'chat') as ModelCapability,
          modelId: String(item.modelId || '').trim(),
          voice: (item.capability === 'tts' || item.capability === 'realtime') && item.voice ? String(item.voice).trim() || undefined : undefined,
          label: item.label ? String(item.label) : undefined,
          imageProtocol: item.capability === 'image' && imageGenerationProtocols.includes(imageProtocol)
            ? imageProtocol
            : undefined,
          decisionProtocol: item.capability === 'decision' ? ('system-one-v1' as const) : undefined,
          meta: item.capability === 'embedding'
            ? {
                dimension: Number((item.meta as { dimension?: unknown } | undefined)?.dimension) || DEFAULT_EMBEDDING_META.dimension,
                normalize: typeof (item.meta as { normalize?: unknown } | undefined)?.normalize === 'boolean'
                  ? Boolean((item.meta as { normalize?: unknown }).normalize)
                  : DEFAULT_EMBEDDING_META.normalize,
                maxBatch: Number((item.meta as { maxBatch?: unknown } | undefined)?.maxBatch) || DEFAULT_EMBEDDING_META.maxBatch,
                maxInputChars: Number((item.meta as { maxInputChars?: unknown } | undefined)?.maxInputChars) || DEFAULT_EMBEDDING_META.maxInputChars,
              }
            : undefined,
          supportsBuiltinWebSearch: supportsBuiltinWebSearch || undefined,
          supportsVision: item.capability === 'chat' && Boolean(item.supportsVision),
          health: normalizeModelHealth(item.health),
        };
      })
      .filter((item) => item.id && item.modelId && instanceIds.has(item.providerInstanceId));
    const normalized = {
      version: 3,
      providerInstances: instances,
      models,
      activeChatModelId: raw.activeChatModelId ? String(raw.activeChatModelId) : null,
      activeEmbeddingModelId: raw.activeEmbeddingModelId ? String(raw.activeEmbeddingModelId) : null,
      employeeDefaultModelIds: (raw.employeeDefaultModelIds ?? {}) as Record<string, string>,
      capabilityBindings: Array.isArray(raw.capabilityBindings)
        ? raw.capabilityBindings.map((item) => ({
            capability: modelCapabilities.includes(item.capability) ? item.capability : 'chat',
            modelId: String(item.modelId || ''),
            enabled: item.enabled !== false,
            updatedAt: String(item.updatedAt || new Date().toISOString()),
          }))
        : [],
      agentCapabilityAssignments: Array.isArray(raw.agentCapabilityAssignments)
        ? raw.agentCapabilityAssignments.map((item) => ({
            agentId: String(item.agentId || ''),
            capability: modelCapabilities.includes(item.capability) ? item.capability : 'chat',
            mode: (item.mode === 'auto' || item.mode === 'preferred' ? item.mode : 'disabled') as AgentCapabilityMode,
            updatedAt: String(item.updatedAt || new Date().toISOString()),
          }))
        : [],
      decisionRuntime: normalizeDecisionPolicy(raw.decisionRuntime),
    } satisfies ModelSettings;
    return sanitizeModelSettings(migrateLegacyDecisionModel(normalized, raw.decisionRuntime));
  }
  return migrateFromV1(raw as Parameters<typeof migrateFromV1>[0]);
}

async function load() {
  if (loaded.value) return;
  const stored = window.openclawxDesktop ? await window.openclawxDesktop.getModelConfig() : await getServerModelConfig();
  const before = JSON.stringify(stored ?? {});
  let next = normalize(stored);
  if (!next.models.some((item) => item.capability === 'realtime')) {
    const legacy = await getLegacyRealtimeMigrationSource().catch(() => null);
    if (legacy?.available) next = migrateLegacyRealtimeProvider(next, legacy);
  }
  settings.value = next;
  loaded.value = true;
  const after = JSON.stringify(next);
  // Persist only when migration/pruning removed invalid catalog entries.
  if (before !== after) {
    if (window.openclawxDesktop) {
      try { await window.openclawxDesktop.saveModelConfig(next); } catch { /* ignore */ }
    } else {
      try { await saveServerModelConfig(next); } catch { /* ignore */ }
    }
  }
}

export function apiKeyForRequest(config: ProviderConfig) {
  if (config.provider === 'ollama') return config.apiKey.trim() || 'ollama';
  return config.apiKey;
}

/** Resolve the system-wide embedding / vector model from Settings. */
export function resolveActiveEmbeddingConfig(settingsValue = settings.value): {
  label?: string;
  modelId: string;
  provider: ProviderId;
  providerLabel: string;
  baseUrl: string;
  apiKey: string;
  configuredModelId: string;
  meta?: ConfiguredModel['meta'];
} | null {
  const id = settingsValue.activeEmbeddingModelId;
  return id ? resolveEmbeddingConfigById(id, settingsValue) : null;
}

/** Resolve one user-configured embedding model with its provider connection. */
export function resolveEmbeddingConfigById(id: string, settingsValue = settings.value): {
  label?: string;
  modelId: string;
  provider: ProviderId;
  providerLabel: string;
  baseUrl: string;
  apiKey: string;
  configuredModelId: string;
  meta?: ConfiguredModel['meta'];
} | null {
  const model = settingsValue.models.find((item) => item.id === id && item.capability === 'embedding');
  if (!model) return null;
  const resolved = resolveConfiguredModel(model, settingsValue.providerInstances);
  if (!resolved?.embeddingModel.trim()) return null;
  return {
    label: model.label,
    modelId: resolved.embeddingModel,
    provider: resolved.provider,
    providerLabel: resolved.providerLabel,
    baseUrl: resolved.baseUrl,
    apiKey: apiKeyForRequest(resolved),
    configuredModelId: model.id,
    meta: model.meta,
  };
}

/** Whether system vector features (experience / local KB embed) are ready. */
export function isSystemEmbeddingReady(settingsValue = settings.value) {
  return Boolean(resolveActiveEmbeddingConfig(settingsValue));
}

export function toModelPayload(config: ProviderConfig, options?: { enableSearch?: boolean }) {
  const embed = resolveActiveEmbeddingConfig();
  return {
    provider: config.provider,
    chatModel: config.chatModel,
    apiKey: apiKeyForRequest(config),
    baseUrl: config.baseUrl || undefined,
    providerLabel: config.providerLabel || undefined,
    disableThinking: config.disableThinking || undefined,
    supportsVision: config.supportsVision || undefined,
    enableSearch: Boolean(options?.enableSearch) && config.supportsBuiltinWebSearch,
    imageModel: config.imageModel || undefined,
    embeddingModel: embed?.modelId || config.embeddingModel || undefined,
    ...(embed
      ? {
          embeddingBaseUrl: embed.baseUrl || undefined,
          embeddingApiKey: embed.apiKey || undefined,
        }
      : {}),
    asrModel: config.asrModel || undefined,
    ttsModel: config.ttsModel || undefined,
  };
}

/** @deprecated use resolveConfiguredModel */
export function chatModelList(config: ProviderConfig) {
  return uniqueModels([...(config.chatModels ?? []), config.chatModel]);
}

/** 启动时可检测的模型配置缺口类型 */
export type ModelSetupGapId = 'no-provider' | 'provider-incomplete' | 'no-model' | 'no-active-chat-model';

/**
 * 分析当前模型配置还缺什么，供启动引导弹窗使用。
 * 返回按严重程度排列的缺口列表；空数组表示已有可用的对话模型。
 */
export function analyzeModelSetup(value: ModelSettings): ModelSetupGapId[] {
  const gaps: ModelSetupGapId[] = [];
  if (!value.providerInstances.length) {
    gaps.push('no-provider');
    return gaps;
  }
  const readyIds = new Set(value.providerInstances.filter((item) => providerInstanceReady(item)).map((item) => item.id));
  if (!readyIds.size) {
    gaps.push('provider-incomplete');
    return gaps;
  }
  const readyChatModels = value.models.filter(
    (item) => item.capability === 'chat' && item.modelId.trim() && readyIds.has(item.providerInstanceId),
  );
  if (!readyChatModels.length) {
    gaps.push('no-model');
    return gaps;
  }
  if (!value.activeChatModelId || !readyChatModels.some((item) => item.id === value.activeChatModelId)) {
    gaps.push('no-active-chat-model');
  }
  return gaps;
}

export function providerConfigured(config: ProviderConfig) {
  if (!config.chatModel.trim()) return false;
  if (!providerNeedsApiKey(config.provider)) return true;
  return Boolean(config.apiKey.trim());
}

function localEmbeddingLabel(draft: LocalEmbeddingProviderDraft) {
  return draft.suggestedProviderName.trim() || 'Local Embedding (System)';
}

export function upsertLocalEmbeddingRegistration(
  value: ModelSettings,
  draft: LocalEmbeddingProviderDraft,
  options: { makeDefault?: boolean } = {},
): ModelSettings {
  const next = normalize(JSON.parse(JSON.stringify(value))) as ModelSettings;
  const baseUrl = draft.baseUrl.trim();
  const modelId = draft.embeddingModel.trim();
  if (!baseUrl || !modelId) return next;

  let provider = next.providerInstances.find((item) =>
    item.type === 'openai-compatible' && item.baseUrl.trim() === baseUrl,
  );
  if (!provider) {
    provider = {
      id: newId(),
      type: 'openai-compatible',
      name: localEmbeddingLabel(draft),
      baseUrl,
      apiKey: '',
      disableThinking: false,
    };
    next.providerInstances.push(provider);
  } else {
    provider.name = localEmbeddingLabel(draft);
    provider.baseUrl = baseUrl;
  }

  let model = next.models.find((item) =>
    item.providerInstanceId === provider!.id
      && item.capability === 'embedding'
      && item.modelId.trim() === modelId,
  );
  if (!model) {
    model = {
      id: newId(),
      providerInstanceId: provider.id,
      capability: 'embedding',
      modelId,
      label: localEmbeddingLabel(draft),
    };
    next.models.push(model);
  }
  model.meta = draft.meta ? { ...draft.meta } : undefined;
  if (!model.label?.trim()) model.label = localEmbeddingLabel(draft);

  if (options.makeDefault !== false) {
    next.activeEmbeddingModelId = model.id;
  }

  return sanitizeModelSettings(next);
}

export function useModelConfig() {
  const availableChatModels = computed(() =>
    settings.value.models
      .filter((item) => item.capability === 'chat')
      .map((item) => resolveConfiguredModel(item))
      .filter((item): item is ProviderConfig => Boolean(item)),
  );

  const emptyConfig = (): ProviderConfig => ({
    id: '',
    providerInstanceId: '',
    providerLabel: '',
    provider: 'openai',
    baseUrl: '',
    chatModel: '',
    chatModels: [],
    disableThinking: false,
    supportsBuiltinWebSearch: false,
    imageModel: '',
    embeddingModel: '',
    asrModel: '',
    ttsModel: '',
    apiKey: '',
  });

  const activeConfig = computed(() => {
    const byId = availableChatModels.value.find((item) => item.id === settings.value.activeChatModelId);
    return byId ?? availableChatModels.value[0] ?? emptyConfig();
  });

  const configured = computed(() => Boolean(activeConfig.value && providerConfigured(activeConfig.value)));

  const save = async (value: ModelSettings) => {
    const plainSettings = sanitizeModelSettings(JSON.parse(JSON.stringify(normalize(value))) as ModelSettings);
    settings.value = plainSettings;
    if (window.openclawxDesktop) await window.openclawxDesktop.saveModelConfig(plainSettings);
    else await saveServerModelConfig(plainSettings);
  };

  const selectChatEndpoint = async (token: string) => {
    const model = settings.value.models.find((item) => item.id === token && item.capability === 'chat');
    if (!model) {
      // legacy token provider::chatModel
      const [provider, chatModel] = token.split('::');
      const match = availableChatModels.value.find((item) => item.provider === provider && item.chatModel === chatModel);
      if (!match) return;
      settings.value.activeChatModelId = match.id;
      await save(settings.value);
      return;
    }
    settings.value.activeChatModelId = model.id;
    await save(settings.value);
  };

  const chatEndpointToken = computed(() => activeConfig.value?.id ?? '');

  const modelForProvider = (provider: ProviderId) => availableChatModels.value.find((item) => item.provider === provider);

  const modelById = (modelId: string | null | undefined) => {
    if (!modelId) return undefined;
    const configuredModel = settings.value.models.find((item) => item.id === modelId && item.capability === 'chat');
    return configuredModel ? resolveConfiguredModel(configuredModel) : undefined;
  };

  const modelForEmployee = (employeeId: string, fallback?: ProviderConfig | null) => {
    const preferred = settings.value.employeeDefaultModelIds[employeeId];
    return modelById(preferred) ?? fallback ?? (activeConfig.value.id ? activeConfig.value : undefined);
  };

  const setEmployeeDefaultModel = async (employeeId: string, modelId: string | null) => {
    if (!modelId) delete settings.value.employeeDefaultModelIds[employeeId];
    else settings.value.employeeDefaultModelIds[employeeId] = modelId;
    await save(settings.value);
  };

  const registerLocalEmbeddingProvider = async (
    draft: LocalEmbeddingProviderDraft,
    options?: { makeDefault?: boolean },
  ) => {
    const next = upsertLocalEmbeddingRegistration(settings.value, draft, options);
    await save(next);
    return next;
  };

  const agentCapabilityMode = (agentId: string, capability: ModelCapability): AgentCapabilityMode =>
    settings.value.agentCapabilityAssignments.find((item) => item.agentId === agentId && item.capability === capability)?.mode ?? 'disabled';

  const setAgentCapabilityMode = async (agentId: string, capability: ModelCapability, mode: AgentCapabilityMode) => {
    const next = settings.value.agentCapabilityAssignments.filter(
      (item) => !(item.agentId === agentId && item.capability === capability),
    );
    next.push({ agentId, capability, mode, updatedAt: new Date().toISOString() });
    await save({ ...settings.value, agentCapabilityAssignments: next });
  };

  const capabilityAvailable = (capability: ModelCapability) => {
    const binding = settings.value.capabilityBindings.find((item) => item.capability === capability && item.enabled);
    return Boolean(binding && settings.value.models.some((item) => item.id === binding.modelId && item.capability === capability));
  };

  const modelCapabilitiesForAgent = (_agentId: string, enabled = true) => enabled
    ? settings.value.capabilityBindings
    .filter((binding) => binding.enabled && binding.capability !== 'chat' && binding.capability !== 'decision')
    .map((binding) => {
      const model = settings.value.models.find((item) => item.id === binding.modelId && item.capability === binding.capability);
      const provider = model ? settings.value.providerInstances.find((item) => item.id === model.providerInstanceId) : undefined;
      if (!binding || !model || !provider || !providerInstanceReady(provider) || !provider.baseUrl.trim()) return null;
      return {
        id: model.id,
        capability: binding.capability,
        provider: provider.type,
        providerLabel: provider.name,
        baseUrl: effectiveProviderBaseUrl(provider, model.capability),
        apiKey: apiKeyForRequest(resolveConfiguredModel(model, settings.value.providerInstances)!),
        ...(provider.appId ? { appId: provider.appId } : {}),
        ...(provider.apiSecret ? { apiSecret: provider.apiSecret } : {}),
        modelId: model.modelId,
        ...((model.capability === 'tts' || model.capability === 'realtime') && model.voice?.trim() ? { voice: model.voice.trim() } : {}),
        imageProtocol: model.capability === 'image'
          ? (model.imageProtocol ?? inferImageGenerationProtocol(provider.type, model.modelId))
          : undefined,
        mode: 'auto' as const,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : [];

  return {
    settings,
    activeConfig,
    availableChatModels,
    configured,
    load,
    save,
    selectChatEndpoint,
    chatEndpointToken,
    providerConfigured,
    chatModelList,
    modelForProvider,
    modelById,
    modelForEmployee,
    setEmployeeDefaultModel,
    registerLocalEmbeddingProvider,
    agentCapabilityMode,
    setAgentCapabilityMode,
    capabilityAvailable,
    modelCapabilitiesForAgent,
    resolveConfiguredModel,
  };
}
