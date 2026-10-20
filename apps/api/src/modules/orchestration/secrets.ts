import { readFileSync } from 'node:fs';

/**
 * Parent-process secrets channel (M0 keyring).
 *
 * Model/search provider secrets live only in the Electron main process behind
 * `safeStorage`. When the API runs as the desktop's forked child it requests a
 * one-time decrypted snapshot over the fork IPC channel (`openclawx:secrets`); the
 * snapshot stays in this process's memory and is never persisted or logged.
 * The parent may also push updated snapshots when the user saves settings.
 * Standalone (`node dist/main.cjs`) runs simply get an empty keyring and any
 * server-side context assembly degrades to "no model configured".
 */

export interface OpcaiSecrets {
  model?: unknown;
  search?: unknown;
}

let cache: OpcaiSecrets | null = null;
let requested = false;

export function getSecrets(): OpcaiSecrets {
  return cache ?? {};
}

/** True when the keyring has a usable chat model snapshot (v2 instances or legacy providers). */
export function hasModelSecrets(secrets: OpcaiSecrets = getSecrets()): boolean {
  const model = secrets.model;
  if (!model || typeof model !== 'object') return false;
  const value = model as {
    providerInstances?: unknown[];
    models?: unknown[];
    providers?: unknown[];
    chatModel?: unknown;
  };
  if (Array.isArray(value.providerInstances) && value.providerInstances.length && Array.isArray(value.models) && value.models.length) {
    return true;
  }
  if (Array.isArray(value.providers) && value.providers.some((item) => item && typeof item === 'object' && (item as { chatModel?: unknown }).chatModel)) {
    return true;
  }
  return Boolean(value.chatModel);
}

function applySecretsPayload(payload?: OpcaiSecrets) {
  cache = { model: payload?.model, search: payload?.search };
}

/** Apply a decrypted snapshot from the desktop parent (IPC or internal HTTP). */
export function applyParentSecrets(payload?: OpcaiSecrets) {
  applySecretsPayload(payload);
  ensurePushListener();
}

function loadSecretsFile(): OpcaiSecrets | null {
  const file = process.env.OPENCLAWX_SECRETS_FILE;
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as OpcaiSecrets;
    return { model: parsed.model, search: parsed.search };
  } catch {
    return null;
  }
}

let listeningForPushes = false;

/** Accept unsolicited parent pushes (e.g. after the user saves model settings). */
function ensurePushListener() {
  if (listeningForPushes || typeof process.on !== 'function') return;
  listeningForPushes = true;
  process.on('message', (message: unknown) => {
    const payload = message as { type?: string; payload?: OpcaiSecrets } | null;
    if (!payload || payload.type !== 'openclawx:secrets') return;
    applySecretsPayload(payload.payload);
  });
}

/**
 * Ask the Electron parent for a decrypted model/search snapshot.
 * Safe to call repeatedly (e.g. after the user configures a provider mid-session).
 */
export function requestParentSecrets(timeoutMs = 4_000, options?: { force?: boolean }): Promise<void> {
  if (requested && !options?.force) return Promise.resolve();
  requested = true;
  ensurePushListener();
  // Local acceptance/dev shortcut: seed the keyring from a JSON file
  // (OPENCLAWX_SECRETS_FILE: {model?, search?}). Never used in desktop runs.
  const fromFile = loadSecretsFile();
  if (fromFile) {
    applySecretsPayload(fromFile);
    return Promise.resolve();
  }
  if (!process.send || typeof process.on !== 'function') {
    if (!cache) cache = {};
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      process.off?.('message', onMessage);
      resolve();
    }, timeoutMs);
    function onMessage(message: unknown) {
      const payload = message as { type?: string; payload?: OpcaiSecrets } | null;
      if (!payload || payload.type !== 'openclawx:secrets') return;
      clearTimeout(timer);
      process.off?.('message', onMessage);
      applySecretsPayload(payload.payload);
      resolve();
    }
    process.on('message', onMessage);
    process.send?.({ type: 'openclawx:secrets:request' });
  });
}

/** Re-fetch secrets when the keyring is empty (user configured models after API boot). */
export async function ensureModelSecrets(timeoutMs = 2_500): Promise<OpcaiSecrets> {
  ensurePushListener();
  if (hasModelSecrets()) return getSecrets();
  await requestParentSecrets(timeoutMs, { force: true }).catch(() => undefined);
  return getSecrets();
}
