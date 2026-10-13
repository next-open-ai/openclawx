/** Single-flight with a short success cache. Failed requests can retry immediately. */
export function createRequestCoalescer<T>(ttlMs: number, maxEntries = 128, now = Date.now) {
  const entries = new Map<string, { promise: Promise<T>; expiresAt?: number }>();
  return {
    clear() { entries.clear(); },
    run(key: string, request: () => Promise<T>): Promise<T> {
      const existing = entries.get(key);
      if (existing && (existing.expiresAt === undefined || existing.expiresAt > now())) return existing.promise;
      const entry: { promise: Promise<T>; expiresAt?: number } = { promise: Promise.resolve().then(request) };
      entries.set(key, entry);
      entry.promise = entry.promise.then(value => {
        entry.expiresAt = now() + ttlMs;
        // Never evict pending work: doing so would allow duplicate writes.
        for (const [id, cached] of entries) {
          if (cached.expiresAt !== undefined && (cached.expiresAt <= now() || entries.size > maxEntries)) entries.delete(id);
        }
        return value;
      }, error => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      return entry.promise;
    },
  };
}
