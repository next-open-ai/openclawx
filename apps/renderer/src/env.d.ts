/// <reference types="vite/client" />

interface Window {
  workmateDesktop?: {
    pickSkill(): Promise<{ path: string; content: string } | null>;
    pickProjectDirectory(): Promise<string | null>;
    createProjectWorkspace(value: { name: string; parentDirectory?: string }): Promise<string>;
    listProjectFiles(root: string): Promise<Array<{ relative: string; type: 'directory' | 'file' }>>;
    readProjectFile(root: string, relative: string): Promise<{ relative: string; content: string }>;
    writeProjectFile(root: string, relative: string, content: string): Promise<{ relative: string; content: string }>;
    syncProjectWorkspace(root: string, runId: string): Promise<Array<{ relative: string; type: 'directory' | 'file' }>>;
    materializeProjectAssets(root: string, assetIds: string[]): Promise<Array<{ relative: string; type: 'directory' | 'file' }>>;
    registerPreviewRoot(root: string): Promise<{ token: string; origin: string }>;
    registerAssetPreviewRoot(assetId: string): Promise<{ token: string; origin: string }>;
    readProjectPreview(root: string, relative: string): Promise<{ kind: 'text' | 'binary'; name: string; relative?: string; content?: string; base64?: string; bytes: number; mimeType?: string }>;
    readAssetPreview(assetId: string): Promise<{ kind: 'text' | 'binary'; name: string; content?: string; base64?: string; bytes: number; mimeType?: string }>;
    revealProjectFile(root: string, relative: string): Promise<boolean>;
    openAssetInBrowser(assetId: string): Promise<{ ok: boolean; url: string }>;
    openProjectFileInBrowser(root: string, relative: string): Promise<{ ok: boolean; url: string }>;
    createSkill(skill: { name: string; description: string }): Promise<{ path: string; content: string }>;
    writeSkillDraft(draft: { name: string; content: string }): Promise<{ path: string; content: string }>;
    readSkillDraft(path: string): Promise<{ path: string; content: string }>;
    listSkillFiles(path: string): Promise<Array<{ path: string; relative: string; type: 'directory' | 'file' }>>;
    readSkillFile(path: string): Promise<{ path: string; content: string }>;
    writeSkillFile(path: string, content: string): Promise<{ path: string; content: string }>;
    deleteManagedSkill(path: string): Promise<boolean>;
    installSkill(reference: string): Promise<{ output: string; manifest: { path: string; content: string } | null }>;
    importGitSkill(url: string): Promise<{ manifests: Array<{ path: string; content: string }>; skipped: string[] }>;
    findSkills(query: string, batchCount?: number): Promise<{ items: Array<{ reference: string; source: string; slug: string; name: string; description: string; installs: string; url: string }>; hasMore: boolean }>;
    openExternal(url: string): Promise<void>;
    getModelConfig(): Promise<unknown>;
    saveModelConfig(config: unknown): Promise<unknown>;
    getSearchConfig(): Promise<unknown>;
    saveSearchConfig(config: unknown): Promise<unknown>;
    testProvider(value: { type: string; baseUrl?: string; apiKey?: string }): Promise<{ ok: boolean; message: string }>;
    listProviderModels(value: { type: string; baseUrl?: string; apiKey?: string }): Promise<string[]>;
    listOllamaModels(baseUrl?: string): Promise<string[]>;
    pullOllamaModel(baseUrl: string | undefined, modelName: string): Promise<string>;
    storageGet(key: string): Promise<string | null>;
    storageSet(key: string, value: string): Promise<void>;
    listAssets(): Promise<Array<{ id: string; name: string; relativePath: string; mimeType: string; sizeBytes: number; createdAt: number; conversationId: string | null; employeeId: string | null; runId: string; sha256: string; projectId: string | null; workspaceRelative: string | null }>>;
    archiveArtifact(input: { runId: string; relativePath: string; conversationId?: string; employeeId?: string; projectId?: string }): Promise<{ id: string; name: string; relativePath: string; mimeType: string; sizeBytes: number; createdAt: number; conversationId: string | null; employeeId: string | null; runId: string; sha256: string; projectId: string | null; workspaceRelative: string | null }>;
    linkAssetsToProject(input: { projectId: string; assetIds: string[]; workspacePath?: string }): Promise<{ updated: number; copied: number; projectId: string }>;
    unlinkAssetsFromProject(assetIds: string[]): Promise<{ updated: number }>;
    deleteAssets(assetIds: string[]): Promise<{ deleted: number }>;
    saveAsset(assetId: string): Promise<boolean>;
    revealAsset(assetId: string): Promise<void>;
    getChannelSettings(): Promise<{ meta: Record<string, unknown>; secrets: { telegram?: { botToken?: string }; feishu?: { appSecret?: string }; dingtalk?: { clientSecret?: string }; relay?: { token?: string } } }>;
    saveChannelSettings(payload: unknown): Promise<{ ok: boolean; meta: Record<string, unknown> }>;
    gatewayStatus(): Promise<{ running: boolean; pid: number | null }>;
    gatewayRestart(): Promise<{ running: boolean; pid: number | null }>;
    getLocalEmbeddingStatus(): Promise<{
      enabled: boolean;
      manifest: {
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
      };
      runtime: { root: string; modelDir: string; logsDir: string };
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
      state: {
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
      };
    }>;
    getLocalEmbeddingSettings(): Promise<{
      autoRestart: boolean;
      backendUrl: string;
      backendModel: string;
      backendApiKey: string;
      updatedAt: number;
    }>;
    saveLocalEmbeddingSettings(value: { autoRestart?: boolean; backendUrl?: string; backendModel?: string; backendApiKey?: string }): Promise<{
      autoRestart: boolean;
      backendUrl: string;
      backendModel: string;
      backendApiKey: string;
      updatedAt: number;
    }>;
    setLocalEmbeddingEnabled(enabled: boolean): Promise<{
      ok: boolean;
      enabled: boolean;
      status: Awaited<ReturnType<NonNullable<Window['workmateDesktop']>['getLocalEmbeddingStatus']>>;
    }>;
    restartLocalEmbedding(): Promise<{
      ok: boolean;
      message: string;
      status: Awaited<ReturnType<NonNullable<Window['workmateDesktop']>['getLocalEmbeddingStatus']>>;
    }>;
    checkEnvironment(): Promise<EnvCheckReport>;
    onEnvCheckProgress(callback: (payload: EnvCheckProgressPayload) => void): () => void;
  };
}

type EnvCheckProgressPayload =
  | { kind: 'start'; id: string; name: string; required: string }
  | { kind: 'item'; item: EnvCheckItem }
  | { kind: 'done'; report: EnvCheckReport };

interface EnvCheckItem {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'error';
  required: string;
  found: string;
  command?: string;
  help: string;
}

interface EnvCheckReport {
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
