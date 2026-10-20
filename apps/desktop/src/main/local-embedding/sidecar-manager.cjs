const { fork } = require('node:child_process');
const path = require('node:path');
const { defaultManifest, embeddingRuntimePaths } = require('./manifest.cjs');
const { downloadSnapshot, ensureManifestFile, markDownloadIntent } = require('./download-manager.cjs');
const { ensureRuntimeFolders, readState, writeState } = require('./state-store.cjs');
const { readLocalEmbeddingSettings, writeLocalEmbeddingSettings } = require('./settings-store.cjs');

let sidecarProcess = null;

function resolveEndpoint(port) {
  return port ? `http://127.0.0.1:${port}/v1` : '';
}

function providerDraft(manifest, endpoint, modelId = manifest.modelId) {
  return {
    suggestedProviderName: manifest.providerName,
    providerType: manifest.providerType,
    baseUrl: endpoint,
    embeddingModel: modelId,
    meta: {
      dimension: manifest.dimension,
      normalize: manifest.normalize,
    },
  };
}

async function checkHealth(port) {
  if (!port) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function waitForHealth(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await checkHealth(port);
    if (health?.ok) return health;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

function stopSidecarProcess() {
  if (!sidecarProcess || sidecarProcess.killed || sidecarProcess.exitCode !== null) {
    sidecarProcess = null;
    return false;
  }
  sidecarProcess.kill('SIGTERM');
  sidecarProcess = null;
  return true;
}

async function resolveLocalEmbeddingStatus(storageRoot) {
  const manifest = defaultManifest();
  const state = readState(storageRoot);
  const settings = readLocalEmbeddingSettings(storageRoot);
  const paths = ensureRuntimeFolders(storageRoot);
  ensureManifestFile(storageRoot);
  const download = downloadSnapshot(storageRoot, manifest);
  const enabled = Boolean(state.enabled);
  const runtimePid = sidecarProcess && !sidecarProcess.killed && sidecarProcess.exitCode === null ? sidecarProcess.pid : null;
  const port = state.port || 11480;
  const health = runtimePid ? await checkHealth(port) : null;
  const serviceStatus = runtimePid
    ? (health?.ready ? 'running' : 'degraded')
    : (download.downloadStatus !== 'ready' ? 'stopped' : (state.serviceStatus || 'stopped'));
  const endpoint = runtimePid ? resolveEndpoint(port) : '';
  return {
    enabled,
    manifest,
    runtime: {
      root: paths.root,
      modelDir: download.modelDir || '',
      logsDir: paths.logs,
    },
    settings,
    providerDraft: providerDraft(manifest, endpoint, typeof health?.backendModel === 'string' && health.backendModel.trim() ? health.backendModel.trim() : manifest.modelId),
    state: {
      ...state,
      runtimeId: manifest.runtimeId,
      version: manifest.version,
      downloadStatus: download.downloadStatus,
      serviceStatus,
      endpoint,
      pid: runtimePid,
      port: runtimePid ? port : null,
      lastError: runtimePid ? (health?.message || state.lastError || '') : state.lastError,
      backendConfigured: Boolean(health?.backendConfigured),
      backendUrl: typeof health?.backendUrl === 'string' ? health.backendUrl : '',
      backendModel: typeof health?.backendModel === 'string' ? health.backendModel : '',
    },
  };
}

async function setLocalEmbeddingEnabled(storageRoot, enabled) {
  const manifest = defaultManifest();
  const next = enabled
    ? markDownloadIntent(storageRoot, manifest)
    : (stopSidecarProcess(), writeState(storageRoot, {
        enabled: false,
        runtimeId: manifest.runtimeId,
        version: manifest.version,
        downloadStatus: 'missing',
        serviceStatus: 'stopped',
        endpoint: '',
        pid: null,
        port: null,
        checkedAt: Date.now(),
        lastError: '',
      }));
  return {
    ok: true,
    enabled: next.enabled,
    status: await resolveLocalEmbeddingStatus(storageRoot),
  };
}

function saveLocalEmbeddingSettings(storageRoot, patch) {
  return writeLocalEmbeddingSettings(storageRoot, patch);
}

function getLocalEmbeddingSettings(storageRoot) {
  return readLocalEmbeddingSettings(storageRoot);
}

async function maybeAutoRestartLocalEmbedding(storageRoot) {
  const settings = readLocalEmbeddingSettings(storageRoot);
  const state = readState(storageRoot);
  if (!settings.autoRestart || !state.enabled) return { ok: false, skipped: true };
  return restartLocalEmbedding(storageRoot);
}

async function restartLocalEmbedding(storageRoot) {
  const manifest = defaultManifest();
  const download = downloadSnapshot(storageRoot, manifest);
  const settings = readLocalEmbeddingSettings(storageRoot);
  stopSidecarProcess();
  const port = 11480;
  const serverEntry = path.join(__dirname, 'server.cjs');
  sidecarProcess = fork(serverEntry, ['--port', String(port), '--model-id', manifest.modelId, '--dimension', String(manifest.dimension)], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OPENCLAWX_LOCAL_EMBEDDING_BACKEND_URL: settings.backendUrl || process.env.OPENCLAWX_LOCAL_EMBEDDING_BACKEND_URL || '',
      OPENCLAWX_LOCAL_EMBEDDING_BACKEND_MODEL: settings.backendModel || process.env.OPENCLAWX_LOCAL_EMBEDDING_BACKEND_MODEL || '',
      OPENCLAWX_LOCAL_EMBEDDING_BACKEND_API_KEY: settings.backendApiKey || process.env.OPENCLAWX_LOCAL_EMBEDDING_BACKEND_API_KEY || '',
    },
    silent: true,
  });
  sidecarProcess.once('exit', () => {
    if (sidecarProcess?.exitCode !== null) sidecarProcess = null;
  });
  const health = await waitForHealth(port);
  if (!health?.ok) {
    stopSidecarProcess();
    const failed = writeState(storageRoot, {
      enabled: true,
      runtimeId: manifest.runtimeId,
      version: manifest.version,
      downloadStatus: download.downloadStatus,
      serviceStatus: 'failed',
      endpoint: '',
      port: null,
      pid: null,
      checkedAt: Date.now(),
      lastError: 'Local embedding sidecar failed to start.',
    });
    return { ok: false, message: failed.lastError, status: await resolveLocalEmbeddingStatus(storageRoot) };
  }
  const state = writeState(storageRoot, {
    enabled: true,
    runtimeId: manifest.runtimeId,
    version: manifest.version,
    downloadStatus: download.downloadStatus,
    serviceStatus: 'degraded',
    endpoint: resolveEndpoint(port),
    port,
    pid: sidecarProcess.pid,
    checkedAt: Date.now(),
    lastError: download.downloadStatus === 'ready'
      ? String(health.message || 'Local embedding sidecar bootstrap is running.')
      : 'Local embedding bootstrap is running, but the runtime/model payload is not downloaded yet.',
  });
  return { ok: true, message: state.lastError, status: await resolveLocalEmbeddingStatus(storageRoot) };
}

module.exports = {
  getLocalEmbeddingSettings,
  maybeAutoRestartLocalEmbedding,
  stopSidecarProcess,
  resolveLocalEmbeddingStatus,
  restartLocalEmbedding,
  saveLocalEmbeddingSettings,
  setLocalEmbeddingEnabled,
};
