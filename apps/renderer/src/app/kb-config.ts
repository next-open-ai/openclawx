import { computed, ref } from 'vue';
import { readStored, writeStored } from './storage';
import {
  getServerKnowledgeBases,
  getServerKnowledgeProviderConfig,
  saveServerKnowledgeBases,
  saveServerKnowledgeProviderConfig,
} from '../services/api.js';
import { resolveActiveEmbeddingConfig, resolveEmbeddingConfigById } from './model-config';

export const knowledgeProviderIds = ['lancedb', 'bailian', 'dify', 'qdrant', 'pinecone'] as const;
export type KnowledgeProviderId = (typeof knowledgeProviderIds)[number];

export interface KnowledgeBase {
  id: string;
  name: string;
  provider: KnowledgeProviderId;
  enabled: boolean;
  ontologyEnabled: boolean;
  description?: string;
  /** Absolute or app-relative data dir for LanceDB */
  dataDir?: string;
  baseUrl?: string;
  apiKey?: string;
  externalId?: string;
  /** Bailian datacenter category id (required for cloud upload). */
  categoryId?: string;
  /** Bailian workspace id (llm-xxxx). */
  workspaceId?: string;
  /** Optional Aliyun AccessKey for Bailian OpenAPI retrieve. */
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
  /** Local document count hint (updated on ingest). */
  documentCount?: number;
  updatedAt: number;
}

export type KnowledgeBaseUpsert = Omit<KnowledgeBase, 'id' | 'updatedAt' | 'documentCount' | 'ontologyEnabled'> & {
  id?: string;
  documentCount?: number;
  /** Omitted by legacy entry points; normalized to enabled. */
  ontologyEnabled?: boolean;
};

export interface KnowledgeProviderSetting {
  id: KnowledgeProviderId;
  enabled: boolean;
  /** Optional shared default endpoint for new knowledge bases of this provider. */
  defaultBaseUrl: string;
  /** Optional shared default API key for new knowledge bases of this provider. */
  defaultApiKey: string;
  /** Bailian: shared Model Studio workspace id (llm-xxxx). */
  defaultWorkspaceId: string;
  /** Bailian: shared Aliyun AccessKey Id (account-level, shared by all bases). */
  defaultAccessKeyId: string;
  /** Bailian: shared Aliyun AccessKey Secret. */
  defaultAccessKeySecret: string;
}

export interface KnowledgeProviderSettings {
  version: 1;
  providers: KnowledgeProviderSetting[];
}

export const knowledgeProviderMeta: Record<
  KnowledgeProviderId,
  { label: string; kind: 'local' | 'cloud'; needsApiKey: boolean; needsExternalId: boolean; needsBaseUrl: boolean; defaultBaseUrl: string }
> = {
  lancedb: { label: 'LanceDB（本地）', kind: 'local', needsApiKey: false, needsExternalId: false, needsBaseUrl: false, defaultBaseUrl: '' },
  bailian: { label: '阿里云百炼', kind: 'cloud', needsApiKey: true, needsExternalId: true, needsBaseUrl: false, defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1' },
  dify: { label: 'Dify', kind: 'cloud', needsApiKey: true, needsExternalId: true, needsBaseUrl: true, defaultBaseUrl: '' },
  qdrant: { label: 'Qdrant Cloud', kind: 'cloud', needsApiKey: true, needsExternalId: true, needsBaseUrl: true, defaultBaseUrl: '' },
  pinecone: { label: 'Pinecone', kind: 'cloud', needsApiKey: true, needsExternalId: true, needsBaseUrl: true, defaultBaseUrl: '' },
};

const basesKey = 'capabilities.knowledge';
const providersKey = 'settings.knowledge-providers';
const bases = ref<KnowledgeBase[]>([]);
const providerSettings = ref<KnowledgeProviderSettings>(defaultProviderSettings());
const basesLoaded = ref(false);
const providersLoaded = ref(false);

export function defaultProviderSettings(): KnowledgeProviderSettings {
  return {
    version: 1,
    providers: knowledgeProviderIds.map((id) => ({
      id,
      enabled: id === 'lancedb',
      defaultBaseUrl: knowledgeProviderMeta[id].defaultBaseUrl,
      defaultApiKey: '',
      defaultWorkspaceId: '',
      defaultAccessKeyId: '',
      defaultAccessKeySecret: '',
    })),
  };
}

function normalizeProviderSettings(value: unknown): KnowledgeProviderSettings {
  const raw = value && typeof value === 'object' ? (value as Partial<KnowledgeProviderSettings>) : {};
  const rows = Array.isArray(raw.providers) ? raw.providers : [];
  return {
    version: 1,
    providers: knowledgeProviderIds.map((id) => {
      const stored = rows.find((item) => item && typeof item === 'object' && (item as KnowledgeProviderSetting).id === id) as Partial<KnowledgeProviderSetting> | undefined;
      return {
        id,
        enabled: id === 'lancedb' ? stored?.enabled !== false : Boolean(stored?.enabled),
        defaultBaseUrl: String(stored?.defaultBaseUrl ?? knowledgeProviderMeta[id].defaultBaseUrl),
        defaultApiKey: String(stored?.defaultApiKey || ''),
        defaultWorkspaceId: String(stored?.defaultWorkspaceId || ''),
        defaultAccessKeyId: String(stored?.defaultAccessKeyId || ''),
        defaultAccessKeySecret: String(stored?.defaultAccessKeySecret || ''),
      };
    }),
  };
}

function normalizeOne(value: unknown): KnowledgeBase | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<KnowledgeBase>;
  const provider = raw.provider;
  if (!knowledgeProviderIds.includes(provider as KnowledgeProviderId)) return null;
  const name = String(raw.name || '').trim();
  if (!name) return null;
  const id = String(raw.id || '').trim() || crypto.randomUUID();
  return {
    id,
    name,
    provider: provider as KnowledgeProviderId,
    enabled: raw.enabled !== false,
    ontologyEnabled: raw.ontologyEnabled !== false,
    description: raw.description ? String(raw.description) : '',
    dataDir: raw.dataDir ? String(raw.dataDir) : '',
    baseUrl: raw.baseUrl ? String(raw.baseUrl).trim() : '',
    apiKey: raw.apiKey ? String(raw.apiKey) : '',
    externalId: raw.externalId ? String(raw.externalId).trim() : '',
    categoryId: raw.categoryId ? String(raw.categoryId).trim() : '',
    workspaceId: raw.workspaceId ? String(raw.workspaceId).trim() : '',
    accessKeyId: raw.accessKeyId ? String(raw.accessKeyId).trim() : '',
    accessKeySecret: raw.accessKeySecret ? String(raw.accessKeySecret) : '',
    embeddingBaseUrl: raw.embeddingBaseUrl ? String(raw.embeddingBaseUrl).trim() : '',
    embeddingApiKey: raw.embeddingApiKey ? String(raw.embeddingApiKey) : '',
    embeddingModel: raw.embeddingModel ? String(raw.embeddingModel).trim() : '',
    embeddingMode: raw.embeddingMode === 'model' ? 'model' : raw.embeddingMode === 'system' ? 'system' : undefined,
    embeddingModelConfigId: raw.embeddingModelConfigId ? String(raw.embeddingModelConfigId).trim() : '',
    embeddingMeta: raw.embeddingMeta && typeof raw.embeddingMeta === 'object'
      ? {
          dimension: Number((raw.embeddingMeta as { dimension?: unknown }).dimension) || undefined,
          normalize: typeof (raw.embeddingMeta as { normalize?: unknown }).normalize === 'boolean'
            ? Boolean((raw.embeddingMeta as { normalize?: unknown }).normalize)
            : undefined,
          maxBatch: Number((raw.embeddingMeta as { maxBatch?: unknown }).maxBatch) || undefined,
          maxInputChars: Number((raw.embeddingMeta as { maxInputChars?: unknown }).maxInputChars) || undefined,
        }
      : undefined,
    indexState: raw.indexState && typeof raw.indexState === 'object'
      ? {
          status: (raw.indexState as { status?: unknown }).status === 'stale'
            ? 'stale'
            : (raw.indexState as { status?: unknown }).status === 'rebuilding'
              ? 'rebuilding'
              : 'ready',
          signature: (raw.indexState as { signature?: unknown }).signature
            ? String((raw.indexState as { signature?: unknown }).signature)
            : undefined,
          lastBuildAt: Number((raw.indexState as { lastBuildAt?: unknown }).lastBuildAt) || undefined,
          lastBuildModel: (raw.indexState as { lastBuildModel?: unknown }).lastBuildModel
            ? String((raw.indexState as { lastBuildModel?: unknown }).lastBuildModel)
            : undefined,
          lastBuildError: (raw.indexState as { lastBuildError?: unknown }).lastBuildError
            ? String((raw.indexState as { lastBuildError?: unknown }).lastBuildError)
            : undefined,
        }
      : undefined,
    documentCount: Number(raw.documentCount) || 0,
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function normalizeAll(value: unknown): KnowledgeBase[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeOne).filter((item): item is KnowledgeBase => Boolean(item));
}

function sameEmbeddingMeta(
  left?: KnowledgeBase['embeddingMeta'],
  right?: KnowledgeBase['embeddingMeta'],
) {
  return (left?.dimension || 0) === (right?.dimension || 0)
    && Boolean(left?.normalize) === Boolean(right?.normalize)
    && (left?.maxBatch || 0) === (right?.maxBatch || 0)
    && (left?.maxInputChars || 0) === (right?.maxInputChars || 0);
}

function shouldMarkStale(previous: KnowledgeBase | undefined, next: KnowledgeBase) {
  if (!previous || (previous.documentCount || 0) <= 0) return false;
  return previous.embeddingModel !== next.embeddingModel
    || previous.embeddingMode !== next.embeddingMode
    || previous.embeddingModelConfigId !== next.embeddingModelConfigId
    || previous.embeddingBaseUrl !== next.embeddingBaseUrl
    || previous.embeddingApiKey !== next.embeddingApiKey
    || !sameEmbeddingMeta(previous.embeddingMeta, next.embeddingMeta);
}

function isReady(item: KnowledgeBase) {
  if (!item.enabled) return false;
  const meta = knowledgeProviderMeta[item.provider];
  if (item.provider === 'lancedb') return true;
  const defaults = resolveProviderDefaults(item.provider);
  const apiKey = item.apiKey?.trim() || defaults.apiKey;
  const accessKeyReady = Boolean((item.accessKeyId?.trim() || defaults.accessKeyId) && (item.accessKeySecret?.trim() || defaults.accessKeySecret));
  if (meta.needsApiKey && !apiKey && !(item.provider === 'bailian' && accessKeyReady)) return false;
  if (meta.needsExternalId && !item.externalId?.trim()) return false;
  if (meta.needsBaseUrl && !(item.baseUrl?.trim() || defaults.baseUrl)) return false;
  return true;
}

function resolveProviderDefaults(provider: KnowledgeProviderId) {
  const row = providerSettings.value.providers.find((item) => item.id === provider);
  return {
    baseUrl: row?.defaultBaseUrl || knowledgeProviderMeta[provider].defaultBaseUrl || '',
    apiKey: row?.defaultApiKey || '',
    workspaceId: row?.defaultWorkspaceId || '',
    accessKeyId: row?.defaultAccessKeyId || '',
    accessKeySecret: row?.defaultAccessKeySecret || '',
  };
}

/** Merge per-base overrides with shared provider credentials (AccessKey / workspace are account-level). */
function resolveRuntimeCredentials(item: KnowledgeBase) {
  const defaults = resolveProviderDefaults(item.provider);
  return {
    baseUrl: item.baseUrl?.trim() || defaults.baseUrl || undefined,
    apiKey: item.apiKey?.trim() || defaults.apiKey || undefined,
    workspaceId: item.workspaceId?.trim() || defaults.workspaceId || undefined,
    accessKeyId: item.accessKeyId?.trim() || defaults.accessKeyId || undefined,
    accessKeySecret: item.accessKeySecret?.trim() || defaults.accessKeySecret || undefined,
  };
}

function toRuntime(item: KnowledgeBase) {
  const creds = resolveRuntimeCredentials(item);
  const selectedEmbedding = item.embeddingMode === 'model' && item.embeddingModelConfigId
    ? resolveEmbeddingConfigById(item.embeddingModelConfigId)
    : item.embeddingMode === 'system'
      ? resolveActiveEmbeddingConfig()
      : null;
  return {
    id: item.id,
    name: item.name,
    provider: item.provider,
    enabled: true as const,
    ontologyEnabled: item.ontologyEnabled !== false,
    description: item.description || undefined,
    dataDir: item.dataDir?.trim() || undefined,
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    externalId: item.externalId?.trim() || undefined,
    categoryId: item.categoryId?.trim() || undefined,
    workspaceId: creds.workspaceId,
    accessKeyId: creds.accessKeyId,
    accessKeySecret: creds.accessKeySecret,
    embeddingBaseUrl: selectedEmbedding?.baseUrl || item.embeddingBaseUrl?.trim() || undefined,
    embeddingApiKey: selectedEmbedding?.apiKey || item.embeddingApiKey?.trim() || undefined,
    embeddingModel: selectedEmbedding?.modelId || item.embeddingModel?.trim() || undefined,
    embeddingMode: item.embeddingMode,
    embeddingModelConfigId: item.embeddingModelConfigId?.trim() || undefined,
    embeddingMeta: selectedEmbedding?.meta || item.embeddingMeta,
    indexState: item.indexState,
  };
}

export function useKnowledgeConfig() {
  const loadProviders = async () => {
    if (providersLoaded.value) return;
    try {
      const stored = window.openclawxDesktop
        ? JSON.parse((await readStored(providersKey)) || '{}')
        : await getServerKnowledgeProviderConfig();
      providerSettings.value = normalizeProviderSettings(stored);
    } catch {
      providerSettings.value = defaultProviderSettings();
    }
    providersLoaded.value = true;
  };

  const saveProviders = async (value = providerSettings.value) => {
    const next = normalizeProviderSettings(JSON.parse(JSON.stringify(value)));
    const local = next.providers.find((item) => item.id === 'lancedb');
    if (local) local.enabled = true;
    providerSettings.value = next;
    if (window.openclawxDesktop) await writeStored(providersKey, JSON.stringify(next));
    else await saveServerKnowledgeProviderConfig(next);
    return next;
  };

  const load = async () => {
    await loadProviders();
    if (basesLoaded.value) return;
    try {
      const stored = window.openclawxDesktop
        ? JSON.parse((await readStored(basesKey)) || '[]')
        : await getServerKnowledgeBases();
      bases.value = normalizeAll(stored);
    } catch {
      bases.value = [];
    }
    // Soft-migrate: promote first Bailian per-base credentials into shared provider settings.
    const bailian = providerSettings.value.providers.find((item) => item.id === 'bailian');
    if (bailian) {
      let changed = false;
      for (const base of bases.value.filter((item) => item.provider === 'bailian')) {
        if (!bailian.defaultApiKey && base.apiKey) {
          bailian.defaultApiKey = base.apiKey;
          changed = true;
        }
        if (!bailian.defaultWorkspaceId && base.workspaceId) {
          bailian.defaultWorkspaceId = base.workspaceId;
          changed = true;
        }
        if (!bailian.defaultAccessKeyId && base.accessKeyId) {
          bailian.defaultAccessKeyId = base.accessKeyId;
          changed = true;
        }
        if (!bailian.defaultAccessKeySecret && base.accessKeySecret) {
          bailian.defaultAccessKeySecret = base.accessKeySecret;
          changed = true;
        }
      }
      if (changed) {
        providerSettings.value = { ...providerSettings.value, providers: [...providerSettings.value.providers] };
        if (window.openclawxDesktop) await writeStored(providersKey, JSON.stringify(providerSettings.value));
        else await saveServerKnowledgeProviderConfig(providerSettings.value);
      }
    }
    basesLoaded.value = true;
  };

  const persist = async () => {
    if (window.openclawxDesktop) await writeStored(basesKey, JSON.stringify(bases.value));
    else await saveServerKnowledgeBases(bases.value);
  };

  const enabledProviders = computed(() =>
    providerSettings.value.providers.filter((item) => item.enabled || item.id === 'lancedb'),
  );

  const isProviderEnabled = (provider: KnowledgeProviderId) =>
    provider === 'lancedb' || Boolean(providerSettings.value.providers.find((item) => item.id === provider)?.enabled);

  const providerDefaults = (provider: KnowledgeProviderId) => resolveProviderDefaults(provider);

  const upsert = async (input: KnowledgeBaseUpsert) => {
    const id = input.id || crypto.randomUUID();
    const provider = input.provider;
    const name = String(input.name || '').trim();
    if (!name) throw new Error('Knowledge base name is required.');
    if (!knowledgeProviderMeta[provider]) throw new Error('Unsupported knowledge provider.');
    if (!isProviderEnabled(provider)) throw new Error('This knowledge provider is disabled in Settings.');
    const defaults = resolveProviderDefaults(provider);
    if (provider !== 'lancedb') {
      const apiKey = String(input.apiKey || '').trim() || defaults.apiKey;
      const accessKeyReady = Boolean(
        (String(input.accessKeyId || '').trim() || defaults.accessKeyId)
        && (String(input.accessKeySecret || '').trim() || defaults.accessKeySecret),
      );
      if (knowledgeProviderMeta[provider].needsApiKey && !apiKey && !(provider === 'bailian' && accessKeyReady)) {
        throw new Error(provider === 'bailian'
          ? 'Configure Bailian DashScope API Key or AccessKey in Settings → Knowledge.'
          : 'API key is required.');
      }
      if (knowledgeProviderMeta[provider].needsExternalId && !String(input.externalId || '').trim()) {
        throw new Error('External knowledge / index / collection id is required.');
      }
      if (knowledgeProviderMeta[provider].needsBaseUrl) {
        const url = String(input.baseUrl || '').trim() || defaults.baseUrl;
        if (!url) throw new Error('Service URL is required.');
        try {
          new URL(url);
        } catch {
          throw new Error('Service URL is invalid.');
        }
      }
    }
    const next: KnowledgeBase = {
      id,
      name,
      provider,
      enabled: input.enabled !== false,
      ontologyEnabled: input.ontologyEnabled !== false,
      description: String(input.description || '').trim(),
      dataDir: String(input.dataDir || '').trim(),
      // Keep per-base overrides empty when using shared provider credentials.
      baseUrl: String(input.baseUrl || '').trim(),
      apiKey: String(input.apiKey || ''),
      externalId: String(input.externalId || '').trim(),
      categoryId: String(input.categoryId || '').trim(),
      workspaceId: String(input.workspaceId || '').trim(),
      accessKeyId: String(input.accessKeyId || '').trim(),
      accessKeySecret: String(input.accessKeySecret || ''),
      embeddingBaseUrl: String(input.embeddingBaseUrl || '').trim(),
      embeddingApiKey: String(input.embeddingApiKey || ''),
      embeddingModel: String(input.embeddingModel || '').trim(),
      embeddingMode: input.embeddingMode,
      embeddingModelConfigId: String(input.embeddingModelConfigId || '').trim(),
      embeddingMeta: input.embeddingMeta ? { ...input.embeddingMeta } : undefined,
      documentCount: Number(input.documentCount) || 0,
      indexState: undefined,
      updatedAt: Date.now(),
    };
    const existing = bases.value.find((item) => item.id === id);
    next.indexState = shouldMarkStale(existing, next)
      ? {
          status: 'stale',
          signature: existing?.indexState?.signature,
          lastBuildAt: existing?.indexState?.lastBuildAt,
          lastBuildModel: existing?.indexState?.lastBuildModel,
          lastBuildError: existing?.indexState?.lastBuildError,
        }
      : existing?.indexState;
    const index = bases.value.findIndex((item) => item.id === id);
    if (index >= 0) bases.value[index] = next;
    else bases.value = [next, ...bases.value];
    bases.value = [...bases.value];
    await persist();
    return next;
  };

  const remove = async (id: string) => {
    bases.value = bases.value.filter((item) => item.id !== id);
    await persist();
  };

  const setEnabled = async (id: string, enabled: boolean) => {
    const item = bases.value.find((entry) => entry.id === id);
    if (!item) return;
    item.enabled = enabled;
    item.updatedAt = Date.now();
    bases.value = [...bases.value];
    await persist();
  };

  const setDocumentCount = async (id: string, count: number) => {
    const item = bases.value.find((entry) => entry.id === id);
    if (!item) return;
    item.documentCount = Math.max(0, Math.round(count));
    item.updatedAt = Date.now();
    bases.value = [...bases.value];
    await persist();
  };

  const setIndexState = async (id: string, indexState: KnowledgeBase['indexState'] | undefined) => {
    const item = bases.value.find((entry) => entry.id === id);
    if (!item) return;
    item.indexState = indexState ? { ...indexState } : undefined;
    item.updatedAt = Date.now();
    bases.value = [...bases.value];
    await persist();
  };

  const byIds = (ids: string[]) => {
    const wanted = new Set(ids);
    return bases.value.filter((item) => wanted.has(item.id) && isReady(item) && isProviderEnabled(item.provider));
  };

  const byProvider = (provider: KnowledgeProviderId, readyOnly = true) =>
    bases.value.filter((item) => item.provider === provider && isProviderEnabled(provider) && (!readyOnly || isReady(item)));

  const runtimePayload = (ids?: string[], provider?: KnowledgeProviderId | 'off' | null) => {
    if (provider === 'off') return [];
    let rows = ids?.length ? byIds(ids) : bases.value.filter((item) => isReady(item) && isProviderEnabled(item.provider));
    if (provider) rows = rows.filter((item) => item.provider === provider);
    return rows.map(toRuntime);
  };

  return {
    bases,
    providerSettings,
    load,
    loadProviders,
    saveProviders,
    upsert,
    remove,
    setEnabled,
    setDocumentCount,
    setIndexState,
    byIds,
    byProvider,
    runtimePayload,
    isReady,
    isProviderEnabled,
    enabledProviders,
    providerDefaults,
    resolveCredentials: resolveRuntimeCredentials,
    defaultProviderSettings,
  };
}
