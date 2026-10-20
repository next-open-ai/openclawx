/**
 * Storage service contract for OpenClawX domain state.
 *
 * M0 decision: the Fastify/API process is the single writer of domain data
 * (conversations, projects, employees, skill policies, …). The Electron main
 * process forwards its legacy `storageGet/storageSet` IPC handlers to this
 * store over loopback HTTP, so the Vue renderer and future channel/relay
 * gateways observe the same durable state without extra migration.
 *
 * The implementation is intentionally a plain JSON document store for M0;
 * the interface is what matters — swapping in sql.js later does not touch
 * callers.
 */
export interface KeyValueStore {
  /** Read a raw JSON-string value. Returns null when absent. */
  get(key: string): string | null | Promise<string | null>;
  /** Persist a raw JSON-string value. */
  set(key: string, value: string): Promise<void>;
  /** Remove a key. */
  delete(key: string): Promise<void>;
  /** List stored keys that start with `prefix`. */
  keys(prefix?: string): Promise<string[]>;
  /** Flush any pending writes to durable storage. */
  flush(): Promise<void>;
  /** Close the store (flush + release resources). */
  close(): Promise<void>;
}

/** Keys are grouped under a namespace so domain collections never collide. */
export function namespaceKey(namespace: string, id: string): string {
  return `${namespace}:${id}`;
}
