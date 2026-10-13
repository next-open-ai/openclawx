import { z } from 'zod';
export * from './task-templates.js';
export * from './workspace-write.js';

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('workmate-api'),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const AgentProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  instructions: z.string(),
  toolIds: z.array(z.string()),
});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/** Pluggable agent execution backends (pi / agentscope / dsh). */
export const AgentEngineIdSchema = z.enum(['pi', 'agentscope', 'dsh']);
export type AgentEngineId = z.infer<typeof AgentEngineIdSchema>;
export const AGENT_ENGINE_IDS = AgentEngineIdSchema.options;

/**
 * A capability package made available to one agent run. Content is kept out
 * of the model prompt until the agent explicitly loads the skill (except for
 * deliberately configured default skills).
 */
export const AgentSkillResourceSchema = z.object({
  path: z.string().min(1).max(240),
  content: z.string().max(48_000),
});
export const SkillExecutionPolicySchema = z.object({
  /** A per-run workspace can be written only after this capability is granted. */
  allowWorkspaceWrite: z.boolean().default(false),
  /** Only executable files under this Skill's scripts/ directory may run. */
  allowScriptExecution: z.boolean().default(false),
  /** Exact HTTPS host names permitted for this Skill. Empty means no egress. */
  allowedNetworkHosts: z.array(z.string().min(1).max(253)).max(32).default([]),
  allowAllNonDestructive: z.boolean().default(false),
});
export type SkillExecutionPolicy = z.infer<typeof SkillExecutionPolicySchema>;
export const AgentSkillRuntimeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1).max(2_000),
  mode: z.enum(['available', 'default']),
  /** Private runtime location; it is never included in model-visible tool output. */
  rootPath: z.string().min(1).optional(),
  instructions: z.string().max(24_000).optional(),
  resources: z.array(AgentSkillResourceSchema).max(40).default([]),
  execution: SkillExecutionPolicySchema.default({}),
});
export type AgentSkillRuntime = z.infer<typeof AgentSkillRuntimeSchema>;

export const ModelCapabilitySchema = z.enum(['chat', 'quantum-code', 'image', 'video', 'vision', 'embedding', 'asr', 'tts', 'realtime', 'decision', 'ontology']);
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;
export const ImageGenerationProtocolSchema = z.enum([
  'openai-images',
  'dashscope-multimodal',
  'dashscope-image-async',
]);
export type ImageGenerationProtocol = z.infer<typeof ImageGenerationProtocolSchema>;

export const UnifiedToolCategorySchema = z.enum(['platform', 'mcp', 'model-capability']);
export type UnifiedToolCategory = z.infer<typeof UnifiedToolCategorySchema>;
export const UnifiedToolDescriptorSchema = z.object({
  id: z.string().min(1).max(120), name: z.string().min(1).max(120), description: z.string().max(4_000),
  inputSchema: z.unknown(), category: UnifiedToolCategorySchema, capability: ModelCapabilitySchema.optional(),
});
export type UnifiedToolDescriptor = z.infer<typeof UnifiedToolDescriptorSchema>;
export const UnifiedToolInvocationSchema = z.object({
  version: z.literal(1), invocationId: z.string().min(1).max(160), runId: z.string().min(1).max(120),
  toolId: z.string().min(1).max(120), input: z.record(z.unknown()).default({}), deadlineAt: z.string().datetime().optional(),
});
export type UnifiedToolInvocation = z.infer<typeof UnifiedToolInvocationSchema>;
export const UnifiedToolResultSchema = z.object({
  version: z.literal(1), invocationId: z.string().min(1).max(160), toolId: z.string().min(1).max(120),
  status: z.enum(['succeeded', 'failed', 'cancelled', 'timed-out']), output: z.unknown().optional(),
  error: z.object({ code: z.string().min(1).max(120), message: z.string().max(2_000) }).optional(),
  startedAt: z.string().datetime(), completedAt: z.string().datetime(),
});
export type UnifiedToolResult = z.infer<typeof UnifiedToolResultSchema>;

/** Normalized token counters for one LLM call or one run aggregate. */
export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** Non-secret model / channel identity attached to usage events. */
export const RunModelRefSchema = z.object({
  provider: z.string().min(1),
  chatModel: z.string().min(1),
  baseUrl: z.string().optional(),
  providerLabel: z.string().max(120).optional(),
});
export type RunModelRef = z.infer<typeof RunModelRefSchema>;

export const RunFailureSchema = z.object({
  code: z.enum(['MODEL_IDLE_TIMEOUT', 'UPSTREAM_BALANCE', 'UPSTREAM_RATE_LIMIT', 'UPSTREAM_AUTH', 'UPSTREAM_SERVICE', 'CONNECTION_INTERRUPTED', 'TOOL_ARGUMENTS', 'MODEL_ABORTED', 'MODEL_ERROR']),
  phase: z.enum(['first-response', 'after-tool', 'streaming', 'execution']),
  elapsedMs: z.number().nonnegative(),
  status: z.number().int().optional(),
  transportCode: z.string().max(40).optional(),
  signature: z.string().max(120),
});
export type RunFailure = z.infer<typeof RunFailureSchema>;

export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run.started'),
    runId: z.string(),
    /** Resolved execution backend for this run (pi / agentscope / dsh). */
    engine: AgentEngineIdSchema.optional(),
  }),
  z.object({ type: z.literal('reasoning.delta'), runId: z.string(), text: z.string() }),
  z.object({ type: z.literal('message.delta'), runId: z.string(), text: z.string() }),
  z.object({ type: z.literal('tool.started'), runId: z.string(), invocationId: z.string().optional(), toolName: z.string(), summary: z.string(), detail: z.string().max(12_000).optional() }),
  z.object({ type: z.literal('tool.progress'), runId: z.string(), invocationId: z.string().optional(), toolName: z.string(), summary: z.string(), progress: z.number().min(0).max(100).optional(), detail: z.string().max(12_000).optional() }),
  z.object({ type: z.literal('tool.completed'), runId: z.string(), invocationId: z.string().optional(), toolName: z.string(), summary: z.string(), ok: z.boolean(), detail: z.string().max(12_000).optional() }),
  z.object({ type: z.literal('tool.failed'), runId: z.string(), invocationId: z.string().optional(), toolName: z.string(), summary: z.string(), detail: z.string().max(12_000).optional() }),
  z.object({ type: z.literal('capability.started'), runId: z.string(), invocationId: z.string().optional(), capability: ModelCapabilitySchema, modelId: z.string(), summary: z.string() }),
  z.object({ type: z.literal('capability.progress'), runId: z.string(), invocationId: z.string().optional(), capability: ModelCapabilitySchema, modelId: z.string(), summary: z.string(), progress: z.number().min(0).max(100).optional() }),
  z.object({ type: z.literal('capability.completed'), runId: z.string(), invocationId: z.string().optional(), capability: ModelCapabilitySchema, modelId: z.string(), summary: z.string(), ok: z.boolean() }),
  z.object({ type: z.literal('capability.failed'), runId: z.string(), invocationId: z.string().optional(), capability: ModelCapabilitySchema, modelId: z.string(), summary: z.string() }),
  z.object({ type: z.literal('artifact.created'), runId: z.string(), path: z.string().min(1).max(240) }),
  z.object({
    type: z.literal('project.file.published'),
    runId: z.string(),
    /** Relative path inside the run workspace (source). */
    path: z.string().min(1).max(240),
    /** Relative path written under the shared project workspace. */
    projectPath: z.string().min(1).max(240),
  }),
  z.object({ type: z.literal('search.sources'), runId: z.string(), provider: z.string(), sources: z.array(z.object({ title: z.string(), url: z.string().url(), source: z.string().optional() })).max(10) }),
  z.object({ type: z.literal('tool.approval_required'), runId: z.string(), skillId: z.string(), capability: z.enum(['workspace-write', 'script-execution', 'network-access']), summary: z.string() }),
  z.object({
    type: z.literal('run.usage'),
    runId: z.string(),
    usage: TokenUsageSchema,
    model: RunModelRefSchema.optional(),
    /** Application capability when this usage came from a specialist model. */
    capability: ModelCapabilitySchema.optional(),
    /** 0-based LLM step within the run when known. */
    stepIndex: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal('run.completed'), runId: z.string() }),
  z.object({ type: z.literal('run.failed'), runId: z.string(), message: z.string(), failure: RunFailureSchema.optional() }),
  z.object({
    type: z.literal('run.cancelled'),
    runId: z.string(),
    reason: z.enum(['user', 'timeout']),
    message: z.string(),
  }),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;

/** Provider-confirmed counters plus local audio timing for one realtime voice session. */
export const RealtimeVoiceUsageSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  source: z.enum(['upstream', 'local']),
  elapsedMs: z.number().int().nonnegative(),
  inputAudioMs: z.number().int().nonnegative(),
  outputAudioMs: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  characters: z.number().int().nonnegative().optional(),
});
export type RealtimeVoiceUsage = z.infer<typeof RealtimeVoiceUsageSchema>;

export const ProviderIdSchema = z.enum(['openai', 'anthropic', 'google', 'deepseek', 'glm', 'qwen', 'volcengine', 'iflytek', 'ollama', 'openai-compatible']);
export const ProviderServiceSchema = z.enum(['language', 'speech', 'realtime', 'unified']);
export type ProviderService = z.infer<typeof ProviderServiceSchema>;
export const ProviderEndpointKindSchema = z.enum(['chat', 'image', 'embedding', 'asr', 'tts', 'realtime', 'native']);
export type ProviderEndpointKind = z.infer<typeof ProviderEndpointKindSchema>;
export const ProviderEndpointOverridesSchema = z.object({
  chat: z.string().url().optional(),
  image: z.string().url().optional(),
  embedding: z.string().url().optional(),
  asr: z.string().url().optional(),
  tts: z.string().url().optional(),
  realtime: z.string().url().optional(),
  native: z.string().url().optional(),
}).partial();
export type ProviderEndpointOverrides = z.infer<typeof ProviderEndpointOverridesSchema>;
export const AUDIO_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const AUDIO_UPLOAD_EXTENSIONS = ['aac', 'flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'ogg', 'opus', 'wav', 'webm'] as const;
export const AudioUploadSchema = z.object({
  name: z.string().min(1).max(240),
  base64: z.string().min(4).max(Math.ceil(AUDIO_UPLOAD_MAX_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export const CapabilityBindingSchema = z.object({
  capability: ModelCapabilitySchema,
  modelId: z.string().min(1),
  enabled: z.boolean().default(true),
  updatedAt: z.string().datetime(),
});
export type CapabilityBinding = z.infer<typeof CapabilityBindingSchema>;

export const AgentCapabilityModeSchema = z.enum(['disabled', 'auto', 'preferred']);
export type AgentCapabilityMode = z.infer<typeof AgentCapabilityModeSchema>;
export const AgentCapabilityAssignmentSchema = z.object({
  agentId: z.string().min(1),
  capability: ModelCapabilitySchema,
  mode: AgentCapabilityModeSchema.default('disabled'),
  updatedAt: z.string().datetime(),
});
export type AgentCapabilityAssignment = z.infer<typeof AgentCapabilityAssignmentSchema>;

export const QuantumExecutionModeSchema = z.enum(['secure-sandbox', 'workspace-isolation', 'disabled']);
export type QuantumExecutionMode = z.infer<typeof QuantumExecutionModeSchema>;
export const QuantumIsolationLevelSchema = z.enum(['oci', 'microvm', 'workspace-only', 'none']);
export type QuantumIsolationLevel = z.infer<typeof QuantumIsolationLevelSchema>;

/** Resolved, authorized specialist model made available to one Agent run. */
export const ModelCapabilityRuntimeSchema = z.object({
  id: z.string().min(1),
  capability: ModelCapabilitySchema,
  provider: ProviderIdSchema,
  providerLabel: z.string().max(120).optional(),
  baseUrl: z.string().url(),
  apiKey: z.string(),
  appId: z.string().max(160).optional(),
  apiSecret: z.string().max(500).optional(),
  modelId: z.string().min(1),
  /** Optional system or pre-authorized cloned voice identifier for TTS. */
  voice: z.string().max(240).optional(),
  /** Required for image capabilities after settings resolution; omitted by legacy callers. */
  imageProtocol: ImageGenerationProtocolSchema.optional(),
  mode: AgentCapabilityModeSchema,
});
export type ModelCapabilityRuntime = z.infer<typeof ModelCapabilityRuntimeSchema>;

export const DecisionProtocolSchema = z.enum(['system-one-v1']);
export type DecisionProtocol = z.infer<typeof DecisionProtocolSchema>;

/** Persisted guard policy. Provider credentials live in the selected application model. */
export const DecisionGuardPolicySchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(['off', 'observe', 'enforce']).default('off'),
  applicationModelId: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(200).max(10_000).default(1_500),
  failurePolicy: z.enum(['allow', 'deny']).default('allow'),
  guardTools: z.boolean().default(true),
  agentTool: z.boolean().default(true),
  mcpEnabled: z.boolean().default(false),
});
export type DecisionGuardPolicy = z.infer<typeof DecisionGuardPolicySchema>;

/** Resolved immutable run snapshot. Never persisted as the source of provider credentials. */
export const DecisionRuntimeConfigSchema = DecisionGuardPolicySchema.extend({
  provider: z.string().min(1).max(80).default('jev'),
  protocol: DecisionProtocolSchema.default('system-one-v1'),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  model: z.string().min(1).max(120).default('jev-latest'),
});
export type DecisionRuntimeConfig = z.infer<typeof DecisionRuntimeConfigSchema>;

/** Curated suggestions, not an exhaustive allowlist. Keep custom/clone voices valid. */
export function suggestedSpeechVoices(provider: string, modelId: string): string[] {
  if (provider === 'volcengine' && /^(?:1\.2\.6\.1|seedduplex|realtime)/i.test(modelId.trim())) {
    return [
      'zh_female_vv_jupiter_bigtts',
      'zh_female_xiaohe_jupiter_bigtts',
      'zh_male_yunzhou_jupiter_bigtts',
      'zh_male_xiaotian_jupiter_bigtts',
      'saturn_zh_female_aojiaonvyou_tob',
    ];
  }
  if (provider === 'qwen' && /realtime/i.test(modelId.trim())) {
    if (/omni/i.test(modelId)) return ['Tina'];
    return ['longanqian_v3.1', 'longanhuan_v3.1', 'longanlingxin_v3.1', 'longanfengyue_v3.1', 'xunanchuan_v3.1'];
  }
  if (provider !== 'qwen') return provider === 'iflytek' ? ['xiaoyan'] : [];
  const model = modelId.trim().toLowerCase();
  if (model === 'qwen-audio-3.1-tts-flash') return ['longanhuan_v3.1', 'longanlingxin_v3.1', 'xunanchuan_v3.1'];
  if (model === 'qwen-audio-3.0-tts-flash') return ['longanhuan_v3.6'];
  if (model === 'qwen-audio-3.0-tts-plus') return ['longanlingxin', 'longanlufeng'];
  if (model === 'cosyvoice-v3-flash' || model === 'cosyvoice-v3-plus') return ['longanyang', 'longanhuan'];
  if (model === 'cosyvoice-v2') return ['longxiaochun_v2', 'longxiaocheng_v2'];
  if (model === 'cosyvoice-v1') return ['longxiaochun'];
  return [];
}

const QWEN_SHARED_HOST_REGIONS: Record<string, string> = {
  'dashscope.aliyuncs.com': 'cn-beijing',
  'dashscope-intl.aliyuncs.com': 'ap-southeast-1',
  'dashscope-us.aliyuncs.com': 'us-east-1',
  'cn-hongkong.dashscope.aliyuncs.com': 'cn-hongkong',
};

/** Resolve a Bailian workspace host while keeping region implicit in the shared API host. */
export function resolveProviderBaseUrl(input: { provider: string; baseUrl: string; workspaceId?: string }): string {
  const baseUrl = input.baseUrl.trim();
  const workspaceId = String(input.workspaceId || '').trim();
  if (input.provider !== 'qwen' || !workspaceId || !baseUrl) return baseUrl;
  let url: URL;
  try { url = new URL(baseUrl); } catch { return baseUrl; }
  if (url.hostname.endsWith('.maas.aliyuncs.com')) return baseUrl;
  const region = QWEN_SHARED_HOST_REGIONS[url.hostname];
  if (!region) return baseUrl;
  url.hostname = `${workspaceId}.${region}.maas.aliyuncs.com`;
  return url.toString().replace(/\/$/, '');
}

function replaceProviderPath(value: string, path: string, protocol?: 'http' | 'ws') {
  try {
    const url = new URL(value);
    if (protocol === 'ws') url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    if (protocol === 'http') url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
    url.pathname = path;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

/** Resolve one capability endpoint while preserving legacy single-URL connections. */
export function resolveProviderServiceEndpoint(input: {
  provider: string;
  baseUrl: string;
  workspaceId?: string;
  service?: ProviderService;
  endpoint: ProviderEndpointKind;
  endpoints?: ProviderEndpointOverrides;
}): string {
  const overridden = input.endpoints?.[input.endpoint]?.trim();
  if (overridden) return overridden;
  const base = resolveProviderBaseUrl(input);
  if (!base) return base;
  if (input.provider === 'qwen') {
    if (input.endpoint === 'native') return replaceProviderPath(base, '/api/v1', 'http');
    if (input.endpoint === 'realtime') return replaceProviderPath(base, '/api-ws/v1/realtime', 'ws');
    if (input.endpoint === 'asr' || input.endpoint === 'tts') return replaceProviderPath(base, '/api/v1', 'http');
    return replaceProviderPath(base, '/compatible-mode/v1', 'http');
  }
  if (input.provider === 'volcengine' && input.service === 'language') {
    return replaceProviderPath(base, '/api/v3', 'http');
  }
  if (input.provider === 'volcengine' && input.endpoint === 'realtime') {
    return replaceProviderPath(base, '/api/v3/duplex/realtime/dialogue', 'ws');
  }
  return base;
}
export const DEFAULT_EMBEDDING_META = Object.freeze({
  dimension: 1024,
  normalize: true,
  maxBatch: 32,
  maxInputChars: 8000,
});
export const EmbeddingMetaSchema = z.object({
  dimension: z.number().int().positive().max(65_536).optional(),
  normalize: z.boolean().optional(),
  maxBatch: z.number().int().positive().max(10_000).optional(),
  maxInputChars: z.number().int().positive().max(10_000_000).optional(),
});
export type EmbeddingMeta = z.infer<typeof EmbeddingMetaSchema>;
export const ModelConfigSchema = z.object({
  provider: ProviderIdSchema,
  baseUrl: z.string().url().optional(),
  chatModel: z.string().min(1),
  /** Human label of the provider connection / channel (never a secret). */
  providerLabel: z.string().max(120).optional(),
  disableThinking: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  /**
   * When true, DashScope-compatible chat requests inject `enable_search: true`
   * (Bailian / Qwen built-in web search). Not an external search provider tool.
   */
  enableSearch: z.boolean().optional(),
  imageModel: z.string().optional(),
  /**
   * Global / system embedding model id (from Settings → active embedding).
   * Used by experience memory, local knowledge, and other vector tools.
   */
  embeddingModel: z.string().optional(),
  /** Optional override when the embedding model lives on a different connection than chat. */
  embeddingBaseUrl: z.string().url().optional(),
  embeddingApiKey: z.string().optional(),
  asrModel: z.string().optional(),
  ttsModel: z.string().optional(),
  apiKey: z.string(),
}).refine((value) => value.provider === 'ollama' || value.provider === 'openai-compatible' || value.apiKey.trim().length > 0, { message: 'API key is required for this provider.' });
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const SearchProviderIdSchema = z.enum(['bocha', 'tavily', 'brave', 'exa', 'zhipu', 'aliyun']);
export type SearchProviderId = z.infer<typeof SearchProviderIdSchema>;
export const SearchProviderRuntimeSchema = z.object({
  id: SearchProviderIdSchema,
  label: z.string().min(1).max(80),
  apiKey: z.string().min(1),
  /** Optional provider endpoint override; Aliyun requires its workspace service endpoint. */
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().default(true),
  preferred: z.boolean().default(false),
});
export type SearchProviderRuntime = z.infer<typeof SearchProviderRuntimeSchema>;

const McpRemoteRuntimeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  transport: z.enum(['http', 'sse']).default('http'),
  url: z.string().url(),
  enabled: z.boolean().default(true),
  apiKey: z.string().optional(),
  description: z.string().max(500).optional(),
});

const McpStdioRuntimeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  transport: z.literal('stdio'),
  command: z.string().min(1).max(240),
  args: z.array(z.string().max(500)).max(64).default([]),
  env: z.record(z.string().max(2000)).optional(),
  cwd: z.string().max(1000).optional(),
  enabled: z.boolean().default(true),
  description: z.string().max(500).optional(),
});

export const McpConnectionRuntimeSchema = z.union([McpRemoteRuntimeSchema, McpStdioRuntimeSchema]);
export type McpConnectionRuntime = z.infer<typeof McpConnectionRuntimeSchema>;

export const McpProbeRequestSchema = z.object({
  connection: McpConnectionRuntimeSchema,
  timeoutMs: z.number().int().min(3_000).max(60_000).optional(),
});
export type McpProbeRequest = z.infer<typeof McpProbeRequestSchema>;

/** Phase-1 knowledge base providers: local LanceDB + selected cloud engines. */
export const KnowledgeProviderIdSchema = z.enum(['lancedb', 'bailian', 'dify', 'qdrant', 'pinecone']);
export type KnowledgeProviderId = z.infer<typeof KnowledgeProviderIdSchema>;

export const KnowledgeIndexStateSchema = z.object({
  status: z.enum(['ready', 'stale', 'rebuilding']),
  signature: z.string().max(500).optional(),
  lastBuildAt: z.number().int().nonnegative().optional(),
  lastBuildModel: z.string().max(240).optional(),
  lastBuildError: z.string().max(2_000).optional(),
});
export type KnowledgeIndexState = z.infer<typeof KnowledgeIndexStateSchema>;

export const KnowledgeBaseRuntimeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  provider: KnowledgeProviderIdSchema,
  enabled: z.boolean().default(true),
  /** Use a published ontology to expand and rerank retrieval. Falls back to vector search on failure. */
  ontologyEnabled: z.boolean().optional(),
  description: z.string().max(500).optional(),
  /** Local LanceDB directory (absolute). */
  dataDir: z.string().max(1000).optional(),
  /** Cloud API base URL (Dify / Qdrant / custom Bailian endpoint). */
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  /** External dataset / index / collection / knowledge-base id. */
  externalId: z.string().max(240).optional(),
  /** Bailian datacenter category id (required for cloud upload). */
  categoryId: z.string().max(120).optional(),
  /** Bailian / Model Studio workspace id (e.g. llm-xxxx). */
  workspaceId: z.string().max(120).optional(),
  /** Optional Aliyun AccessKey for Bailian OpenAPI Retrieve (preferred for console knowledge bases). */
  accessKeyId: z.string().max(120).optional(),
  accessKeySecret: z.string().max(120).optional(),
  /** Optional OpenAI-compatible embedding endpoint override for vector providers. */
  embeddingBaseUrl: z.string().url().optional(),
  embeddingApiKey: z.string().optional(),
  embeddingModel: z.string().max(120).optional(),
  /** How this knowledge base resolves its embedding model. Legacy records omit this field. */
  embeddingMode: z.enum(['system', 'model']).optional(),
  /** Configured embedding model id when embeddingMode=model. */
  embeddingModelConfigId: z.string().max(240).optional(),
  embeddingMeta: EmbeddingMetaSchema.optional(),
  indexState: KnowledgeIndexStateSchema.optional(),
});
export type KnowledgeBaseRuntime = z.infer<typeof KnowledgeBaseRuntimeSchema>;

/** Allows an 8 MB source file after Base64 expansion, plus a small safety margin. */
export const MAX_KNOWLEDGE_FILE_BASE64_CHARS = 12_000_000;

export const KnowledgeIngestRequestSchema = z.object({
  knowledgeBase: KnowledgeBaseRuntimeSchema,
  title: z.string().min(1).max(240),
  /** Plain-text content. Optional when a supported binary document is provided. */
  content: z.string().max(200_000).optional(),
  /** Base64-encoded PDF/DOCX bytes for local parsing, or document bytes for Bailian upload. */
  fileBase64: z.string().max(MAX_KNOWLEDGE_FILE_BASE64_CHARS).optional(),
  fileName: z.string().max(240).optional(),
  source: z.string().max(500).optional(),
  model: ModelConfigSchema.optional(),
}).refine((value) => Boolean(value.content?.trim() || value.fileBase64?.trim()), {
  message: 'Either content or fileBase64 is required.',
});
export type KnowledgeIngestRequest = z.infer<typeof KnowledgeIngestRequestSchema>;

export const KnowledgeSearchRequestSchema = z.object({
  knowledgeBase: KnowledgeBaseRuntimeSchema,
  query: z.string().min(2).max(800),
  topK: z.number().int().min(1).max(8).default(5),
  model: ModelConfigSchema.optional(),
});
export type KnowledgeSearchRequest = z.infer<typeof KnowledgeSearchRequestSchema>;

/** Phase-1 business ontology / graph primitives. */
export const OntologyNodeSchema = z.object({
  id: z.string().min(1).max(240),
  type: z.string().min(1).max(80),
  name: z.string().min(1).max(240),
  aliases: z.array(z.string().min(1).max(240)).max(32).default([]),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  source: z.string().max(500).optional(),
  status: z.enum(['draft', 'published', 'archived']).default('published'),
});
export type OntologyNode = z.infer<typeof OntologyNodeSchema>;
export const OntologyEdgeSchema = z.object({
  id: z.string().min(1).max(240),
  subjectId: z.string().min(1).max(240),
  predicate: z.string().min(1).max(120),
  objectId: z.string().min(1).max(240),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  source: z.string().max(500).optional(),
  status: z.enum(['draft', 'published', 'archived']).default('published'),
});
export type OntologyEdge = z.infer<typeof OntologyEdgeSchema>;
export const OntologyGraphSchema = z.object({
  version: z.number().int().positive().default(1),
  nodes: z.array(OntologyNodeSchema).max(100_000).default([]),
  edges: z.array(OntologyEdgeSchema).max(200_000).default([]),
});
export type OntologyGraph = z.infer<typeof OntologyGraphSchema>;
export const OntologyGraphRequestSchema = z.object({
  knowledgeBase: KnowledgeBaseRuntimeSchema,
  graph: OntologyGraphSchema,
});
export type OntologyGraphRequest = z.infer<typeof OntologyGraphRequestSchema>;
export const OntologyQueryConstraintsSchema = z.object({
  nodeTypes: z.array(z.string().min(1).max(80)).max(20).default([]),
  predicates: z.array(z.string().min(1).max(120)).max(30).default([]),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  direction: z.enum(['both', 'out', 'in']).default('both'),
  maxResults: z.number().int().min(1).max(100).default(50),
}).default({});
export type OntologyQueryConstraints = z.infer<typeof OntologyQueryConstraintsSchema>;
export const OntologyQueryRequestSchema = z.object({
  knowledgeBase: KnowledgeBaseRuntimeSchema,
  query: z.string().min(2).max(800),
  maxHops: z.number().int().min(0).max(2).default(1),
  constraints: OntologyQueryConstraintsSchema.optional(),
});
export type OntologyQueryRequest = z.infer<typeof OntologyQueryRequestSchema>;

export const OntologyEvidenceSchema = z.object({
  documentId: z.string().min(1).max(240),
  chunkId: z.string().min(1).max(240).optional(),
  title: z.string().max(500).optional(),
  quote: z.string().min(1).max(4000),
  source: z.string().max(1000).optional(),
});
export type OntologyEvidence = z.infer<typeof OntologyEvidenceSchema>;
export const OntologyCandidateSchema = z.object({
  id: z.string().min(1).max(240),
  kind: z.enum(['node', 'edge']),
  node: OntologyNodeSchema.optional(),
  edge: OntologyEdgeSchema.optional(),
  evidence: z.array(OntologyEvidenceSchema).min(1).max(20),
  confidence: z.number().min(0).max(1).default(0.5),
  status: z.enum(['pending', 'accepted', 'rejected', 'deferred', 'committed']).default('pending'),
  reviewedAt: z.number().int().positive().optional(),
  reviewNote: z.string().max(1000).optional(),
}).superRefine((value, ctx) => {
  if (value.kind === 'node' && !value.node) ctx.addIssue({ code: 'custom', path: ['node'], message: 'Node candidate requires node.' });
  if (value.kind === 'edge' && !value.edge) ctx.addIssue({ code: 'custom', path: ['edge'], message: 'Edge candidate requires edge.' });
});
export type OntologyCandidate = z.infer<typeof OntologyCandidateSchema>;
export const OntologyWorkflowSchema = z.object({
  draft: OntologyGraphSchema.default({ version: 1, nodes: [], edges: [] }),
  published: OntologyGraphSchema.optional(),
  candidates: z.array(OntologyCandidateSchema).default([]),
  updatedAt: z.number().int().positive(),
});
export type OntologyWorkflow = z.infer<typeof OntologyWorkflowSchema>;
export const OntologyWorkflowRequestSchema = z.object({ knowledgeBase: KnowledgeBaseRuntimeSchema });
export const OntologyDraftSaveRequestSchema = OntologyWorkflowRequestSchema.extend({ graph: OntologyGraphSchema });
export const OntologyCandidateImportRequestSchema = OntologyWorkflowRequestSchema.extend({ candidates: z.array(OntologyCandidateSchema).min(1).max(1000) });
export const OntologyExtractRequestSchema = OntologyWorkflowRequestSchema.extend({
  documentIds: z.array(z.string().min(1).max(240)).min(1).max(20),
  instructions: z.string().max(2000).optional(),
  model: ModelConfigSchema,
  intensity: z.enum(['quick', 'standard', 'deep']).default('standard'),
});
export type OntologyExtractRequest = z.infer<typeof OntologyExtractRequestSchema>;
export const OntologyReviewRequestSchema = OntologyWorkflowRequestSchema.extend({
  candidateIds: z.array(z.string().min(1)).min(1).max(1000),
  decision: z.enum(['accepted', 'rejected', 'deferred']),
  note: z.string().max(1000).optional(),
});
export const OntologyCandidateUpsertRequestSchema = OntologyWorkflowRequestSchema.extend({ candidate: OntologyCandidateSchema });
export const OntologyCandidateDeleteRequestSchema = OntologyWorkflowRequestSchema.extend({ candidateIds: z.array(z.string().min(1)).min(1).max(1000) });
export const OntologyCandidateMergeRequestSchema = OntologyWorkflowRequestSchema.extend({ sourceCandidateIds: z.array(z.string().min(1)).min(2).max(50), mergedCandidate: OntologyCandidateSchema });
export const OntologyPublishRequestSchema = OntologyWorkflowRequestSchema.extend({ note: z.string().max(1000).optional(), publisher: z.string().max(120).optional() });
export const OntologyVersionRequestSchema = OntologyWorkflowRequestSchema.extend({ version: z.number().int().positive() });
export const OntologyAnalysisJobRequestSchema = z.object({ jobId: z.string().uuid() });
export const OntologyGovernanceCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('merge_nodes'), nodeIds: z.array(z.string().min(1)).min(2).max(20), canonicalId: z.string().min(1), canonicalName: z.string().min(1).max(240) }),
  z.object({ type: z.literal('rename_node'), nodeId: z.string().min(1), name: z.string().min(1).max(240), keepOldAsAlias: z.boolean().default(true) }),
  z.object({ type: z.literal('change_node_type'), nodeId: z.string().min(1), nodeType: z.string().min(1).max(120) }),
  z.object({ type: z.literal('delete_node'), nodeId: z.string().min(1), migrateToNodeId: z.string().min(1).optional() }),
  z.object({ type: z.literal('delete_edge'), edgeId: z.string().min(1) }),
  z.object({ type: z.literal('reverse_edge'), edgeId: z.string().min(1) }),
  z.object({ type: z.literal('mark_term'), nodeId: z.string().min(1) }),
  z.object({ type: z.literal('add_edge'), edgeId: z.string().min(1), subjectId: z.string().min(1), predicate: z.string().min(1).max(120), objectId: z.string().min(1) }),
]);
export type OntologyGovernanceCommand = z.infer<typeof OntologyGovernanceCommandSchema>;
export const OntologyGovernanceApplyRequestSchema = OntologyWorkflowRequestSchema.extend({ commands: z.array(OntologyGovernanceCommandSchema).min(1).max(100), actor: z.string().max(120).optional(), source: z.enum(['manual', 'rule', 'ai']).default('manual') });
export const OntologyGovernanceSuggestRequestSchema = OntologyWorkflowRequestSchema.extend({ issueIds: z.array(z.string().min(1)).max(100).default([]), model: ModelConfigSchema });

export const BailianCreateKnowledgeRequestSchema = z.object({
  accessKeyId: z.string().min(1).max(120),
  accessKeySecret: z.string().min(1).max(120),
  workspaceId: z.string().min(1).max(120),
  name: z.string().min(1).max(20),
  description: z.string().max(1000).optional(),
  embeddingModelName: z.string().max(120).optional(),
});
export type BailianCreateKnowledgeRequest = z.infer<typeof BailianCreateKnowledgeRequestSchema>;

export const BailianDeleteKnowledgeRequestSchema = z.object({
  accessKeyId: z.string().min(1).max(120),
  accessKeySecret: z.string().min(1).max(120),
  workspaceId: z.string().min(1).max(120),
  indexId: z.string().min(1).max(120),
});
export type BailianDeleteKnowledgeRequest = z.infer<typeof BailianDeleteKnowledgeRequestSchema>;

export const KnowledgeManageRequestSchema = z.object({
  knowledgeBase: KnowledgeBaseRuntimeSchema,
  model: ModelConfigSchema.optional(),
});
export type KnowledgeManageRequest = z.infer<typeof KnowledgeManageRequestSchema>;

export const KnowledgeChunksRequestSchema = KnowledgeManageRequestSchema.extend({
  documentId: z.string().min(1).max(240).optional(),
  query: z.string().max(400).optional(),
  offset: z.number().int().min(0).max(100_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type KnowledgeChunksRequest = z.infer<typeof KnowledgeChunksRequestSchema>;

export const KnowledgeDeleteDocumentRequestSchema = KnowledgeManageRequestSchema.extend({
  documentId: z.string().min(1).max(240),
});
export type KnowledgeDeleteDocumentRequest = z.infer<typeof KnowledgeDeleteDocumentRequestSchema>;

export const KnowledgeDeleteChunkRequestSchema = KnowledgeManageRequestSchema.extend({
  chunkId: z.string().min(1).max(240),
});
export type KnowledgeDeleteChunkRequest = z.infer<typeof KnowledgeDeleteChunkRequestSchema>;

export const KnowledgeJobStatusRequestSchema = KnowledgeManageRequestSchema.extend({
  jobId: z.string().min(1).max(240),
});
export type KnowledgeJobStatusRequest = z.infer<typeof KnowledgeJobStatusRequestSchema>;
export const ChatImageAttachmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(180),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  size: z.number().int().positive().max(10 * 1024 * 1024),
});
export type ChatImageAttachment = z.infer<typeof ChatImageAttachmentSchema>;
export const ChatImagesSchema = z.array(ChatImageAttachmentSchema).max(4);
export const ChatFileAttachmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(180),
  mimeType: z.string().min(1).max(120),
  size: z.number().int().positive().max(25 * 1024 * 1024),
  kind: z.enum(['document', 'spreadsheet', 'audio']),
  status: z.enum(['ready', 'degraded']).default('ready'),
  summary: z.string().max(500).optional(),
  createdAt: z.number().int().positive(),
});
export type ChatFileAttachment = z.infer<typeof ChatFileAttachmentSchema>;
export const ChatFilesSchema = z.array(ChatFileAttachmentSchema).max(10);
export const ChatModelMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
  attachments: ChatImagesSchema.optional(),
}).refine((message) => message.role === 'user' || !message.attachments?.length, { message: 'Only user messages can attach images.' });
export type ChatModelMessage = z.infer<typeof ChatModelMessageSchema>;

export const ChatRequestSchema = z.object({
  /** Pure text inference: no tools, filesystem, Skill/MCP or backend execution. */
  responseMode: z.literal('text-only').optional(),
  profile: AgentProfileSchema,
  messages: z.array(ChatModelMessageSchema).min(1),
  model: ModelConfigSchema,
  skills: z.array(AgentSkillRuntimeSchema).max(24).default([]),
  searchProviders: z.array(SearchProviderRuntimeSchema).max(6).default([]),
  mcpConnections: z.array(McpConnectionRuntimeSchema).max(12).default([]),
  knowledgeBases: z.array(KnowledgeBaseRuntimeSchema).max(12).default([]),
  /** Authorized specialist models. Disabled assignments are omitted before prompt construction. */
  modelCapabilities: z.array(ModelCapabilityRuntimeSchema).max(12).optional(),
  decisionRuntime: DecisionRuntimeConfigSchema.optional(),
  /**
   * Stable run id shared by orchestrator records and the on-disk run workspace
   * (`~/.workmate/workspaces/<runId>`). When omitted, agent-core generates one.
   */
  runId: z.string().min(1).max(120).optional(),
  /**
   * Chat session id for tooling that needs session-scoped assets (e.g. mapping
   * preview_server_start to the latest SITE asset bundle). Does not change
   * workspace isolation — each run still uses its own staging directory.
   */
  conversationId: z.string().min(1).max(120).optional(),
  /**
   * Absolute shared project workspace root. When set, `publish_to_project` may
   * promote deliverables from the isolated run workspace into this directory.
   */
  projectWorkspacePath: z.string().min(1).max(500).optional(),
  /** Platform workspace capability. This is runtime policy, never a Skill permission. */
  workspaceAccess: z.enum(['read', 'write', 'full']).optional(),
  /** Platform baseline is 50 steps; callers may request a higher ceiling. */
  maxSteps: z.number().int().min(50).max(64).optional(),
  /** Wall-clock budget for the whole agent run (ms). */
  runTimeoutMs: z.number().int().min(15_000).max(1_800_000).optional(),
  /** Per MCP tool call budget (ms). */
  mcpToolTimeoutMs: z.number().int().min(3_000).max(300_000).optional(),
  /**
   * Per-employee / per-run execution backend. When omitted, routing uses
   * runtime default (and optional prefer* hints). Ops force requires
   * `WORKMATE_AGENT_ENGINE_FORCE=1` with `WORKMATE_AGENT_ENGINE`, or call-site override.
   */
  engine: AgentEngineIdSchema.optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export * from './agent-data-query.js';

/* ------------------------------------------------------------------ *
 * Conversation durable tasks
 * ------------------------------------------------------------------ */

export const DurableTaskStatusSchema = z.enum([
  'running',
  'waiting_user',
  'waiting_external',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);
export type DurableTaskStatus = z.infer<typeof DurableTaskStatusSchema>;

export const DurableTaskArtifactRoleSchema = z.enum(['source', 'intermediate', 'deliverable', 'checkpoint', 'state']);
export type DurableTaskArtifactRole = z.infer<typeof DurableTaskArtifactRoleSchema>;

export const DurableTaskWorkingSetEntrySchema = z.object({
  id: z.string().uuid(),
  logicalPath: z.string().min(1).max(500),
  role: DurableTaskArtifactRoleSchema,
  /** Original upload id when this entry was promoted from a chat attachment. */
  sourceAttachmentId: z.string().uuid().optional(),
  mimeType: z.string().min(1).max(160).optional(),
  sourceRunId: z.string().min(1).max(120).optional(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.number().int().positive(),
});
export type DurableTaskWorkingSetEntry = z.infer<typeof DurableTaskWorkingSetEntrySchema>;

export const DurableTaskAssetReferenceSchema = z.object({
  assetId: z.string().min(1).max(160),
  name: z.string().min(1).max(300),
  role: DurableTaskArtifactRoleSchema,
  sourceRunId: z.string().min(1).max(120).optional(),
  addedAt: z.number().int().positive(),
});
export type DurableTaskAssetReference = z.infer<typeof DurableTaskAssetReferenceSchema>;

export const DurableTaskCheckpointSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().min(1).max(120),
  status: DurableTaskStatusSchema,
  summary: z.string().min(1).max(2_000),
  createdAt: z.number().int().positive(),
  workingSetVersion: z.number().int().nonnegative(),
});
export type DurableTaskCheckpoint = z.infer<typeof DurableTaskCheckpointSchema>;

export const DurableTaskSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().min(1).max(120),
  title: z.string().min(1).max(120),
  objective: z.string().min(1).max(4_000),
  status: DurableTaskStatusSchema,
  version: z.number().int().positive(),
  runIds: z.array(z.string().min(1).max(120)).max(500),
  workingSet: z.array(DurableTaskWorkingSetEntrySchema).max(500),
  assetRefs: z.array(DurableTaskAssetReferenceSchema).max(500),
  checkpoints: z.array(DurableTaskCheckpointSchema).max(200),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
});
export type DurableTask = z.infer<typeof DurableTaskSchema>;

export * from './data-schema.js';
export * from './data-query.js';
export * from './workflow-schema.js';
export * from './project-instruction.js';
export * from './run-text.js';
export * from './voice-work.js';
export * from './mobile-voice.js';
export * from './voice-asr.js';
export * from './project-conversation.js';
export * from './project-application.js';

export * from './task-parameter-ui.js';
export * from './task-schedule.js';
export {TaskReportUiSchema,TaskReportProjectPreviewSchema,type TaskReportUi} from './task-parameter-ui.js';
export * from './data-app-query.js';
export * from './data-schema-change.js';
export * from './query-assets.js';
export * from './experience.js';
