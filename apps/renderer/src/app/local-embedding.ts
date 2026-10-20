import { computed, ref } from 'vue';

export interface LocalEmbeddingManifest {
  runtimeId: string;
  version: string;
  providerName: string;
  providerType: 'openai-compatible';
  modelId: string;
  dimension: number;
  normalize: boolean;
  sizeBytes: number;
  platforms: string[];
  platform: string;
  supported: boolean;
}

export interface LocalEmbeddingState {
  enabled: boolean;
  runtimeId: string;
  version: string;
  downloadStatus: 'missing' | 'ready';
  serviceStatus: 'stopped' | 'degraded' | 'running' | 'failed';
  endpoint: string;
  port: number | null;
  pid: number | null;
  checkedAt: number;
  lastError: string;
  updatedAt: number;
  backendConfigured?: boolean;
  backendUrl?: string;
  backendModel?: string;
}

export interface LocalEmbeddingStatus {
  enabled: boolean;
  manifest: LocalEmbeddingManifest;
  runtime: {
    root: string;
    modelDir: string;
    logsDir: string;
  };
  settings: {
    autoRestart: boolean;
    backendUrl: string;
    backendModel: string;
    backendApiKey: string;
    updatedAt: number;
  };
  providerDraft: {
    suggestedProviderName: string;
    providerType: 'openai-compatible';
    baseUrl: string;
    embeddingModel: string;
    meta: {
      dimension: number;
      normalize: boolean;
    };
  };
  state: LocalEmbeddingState;
}

const status = ref<LocalEmbeddingStatus | null>(null);
const loaded = ref(false);
const loading = ref(false);

function fallbackStatus(): LocalEmbeddingStatus {
  return {
    enabled: false,
    manifest: {
      runtimeId: 'local-embedding-default',
      version: 'v1',
      providerName: 'Local Embedding (System)',
      providerType: 'openai-compatible',
      modelId: 'local-embedding-default',
      dimension: 1024,
      normalize: true,
      sizeBytes: 800 * 1024 * 1024,
      platforms: [],
      platform: 'web',
      supported: false,
    },
    runtime: {
      root: '',
      modelDir: '',
      logsDir: '',
    },
    settings: {
      autoRestart: false,
      backendUrl: '',
      backendModel: '',
      backendApiKey: '',
      updatedAt: 0,
    },
    providerDraft: {
      suggestedProviderName: 'Local Embedding (System)',
      providerType: 'openai-compatible',
      baseUrl: '',
      embeddingModel: 'local-embedding-default',
      meta: {
        dimension: 1024,
        normalize: true,
      },
    },
    state: {
      enabled: false,
      runtimeId: 'local-embedding-default',
      version: 'v1',
      downloadStatus: 'missing',
      serviceStatus: 'stopped',
      endpoint: '',
      port: null,
      pid: null,
      checkedAt: 0,
      lastError: '',
      updatedAt: 0,
      backendConfigured: false,
    },
  };
}

async function fetchStatus() {
  if (!window.openclawxDesktop?.getLocalEmbeddingStatus) {
    status.value = fallbackStatus();
    loaded.value = true;
    return status.value;
  }
  loading.value = true;
  try {
    status.value = await window.openclawxDesktop.getLocalEmbeddingStatus();
    loaded.value = true;
    return status.value;
  } finally {
    loading.value = false;
  }
}

export function useLocalEmbedding() {
  const load = async (force = false) => {
    if (loaded.value && !force) return status.value ?? fallbackStatus();
    return fetchStatus();
  };

  const refresh = async () => fetchStatus();

  const setEnabled = async (enabled: boolean) => {
    if (!window.openclawxDesktop?.setLocalEmbeddingEnabled) {
      status.value = {
        ...(status.value ?? fallbackStatus()),
        enabled,
        state: {
          ...(status.value?.state ?? fallbackStatus().state),
          enabled,
          updatedAt: Date.now(),
        },
      };
      return status.value;
    }
    const result = await window.openclawxDesktop.setLocalEmbeddingEnabled(enabled);
    status.value = result.status;
    loaded.value = true;
    return result.status;
  };

  const saveSettings = async (value: { autoRestart?: boolean; backendUrl?: string; backendModel?: string; backendApiKey?: string }) => {
    if (!window.openclawxDesktop?.saveLocalEmbeddingSettings) {
      status.value = {
        ...(status.value ?? fallbackStatus()),
        settings: {
          ...(status.value?.settings ?? fallbackStatus().settings),
          autoRestart: Boolean(value.autoRestart),
          updatedAt: Date.now(),
        },
      };
      return status.value.settings;
    }
    const next = await window.openclawxDesktop.saveLocalEmbeddingSettings(value);
    status.value = {
      ...(status.value ?? fallbackStatus()),
      settings: next,
    };
    loaded.value = true;
    return next;
  };

  const restart = async () => {
    if (!window.openclawxDesktop?.restartLocalEmbedding) return status.value ?? fallbackStatus();
    const result = await window.openclawxDesktop.restartLocalEmbedding();
    status.value = result.status;
    loaded.value = true;
    return result.status;
  };

  const ready = computed(() =>
    status.value?.state.downloadStatus === 'ready' && status.value?.state.serviceStatus === 'running',
  );

  const supported = computed(() => Boolean(status.value?.manifest.supported));

  return {
    status,
    loaded,
    loading,
    ready,
    supported,
    load,
    refresh,
    setEnabled,
    saveSettings,
    restart,
  };
}
