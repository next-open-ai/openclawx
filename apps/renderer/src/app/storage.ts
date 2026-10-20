let storageNamespace: string | null = null;

export function setStorageNamespace(value: string | null) {
  storageNamespace = value?.trim() || null;
}

/** Current auth-scoped storage prefix (`user:<id>`), or null before login. */
export function getStorageNamespace(): string | null {
  return storageNamespace;
}

function scopedKey(key: string) {
  if (!storageNamespace || key.startsWith('auth.')) return key;
  return `${storageNamespace}:${key}`;
}

export async function readStored(key: string): Promise<string | null> {
  const actualKey = scopedKey(key);
  if (window.openclawxDesktop) return window.openclawxDesktop.storageGet(actualKey);
  return window.localStorage.getItem(actualKey);
}

export async function writeStored(key: string, value: string): Promise<void> {
  const actualKey = scopedKey(key);
  if (window.openclawxDesktop) return window.openclawxDesktop.storageSet(actualKey, value);
  window.localStorage.setItem(actualKey, value);
}
