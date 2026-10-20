import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { KeyValueStore } from './kv.js';

interface FileShape {
  version: 1;
  kv: Record<string, string>;
}

/**
 * Durable KeyValueStore backed by one JSON document.
 *
 * - Whole document is kept in memory; writes go to a temp file and are then
 *   atomically renamed, so a crash never leaves a truncated document.
 * - Only the API/orchestrator process should open a given file (single-writer
 *   invariant). Use `OPENCLAWX_DATA_DIR` to place it next to the other local state.
 */
export class JsonFileStore implements KeyValueStore {
  private readonly file: string;
  private kv: Record<string, string>;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly flushDelayMs: number;

  constructor(file: string, options?: { flushDelayMs?: number }) {
    this.file = file;
    this.flushDelayMs = options?.flushDelayMs ?? 50;
    this.kv = JsonFileStore.load(file);
  }

  private static load(file: string): Record<string, string> {
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<FileShape>;
      return parsed && typeof parsed === 'object' && parsed.kv ? parsed.kv : {};
    } catch {
      return {};
    }
  }

  private scheduleFlush() {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      void this.flush();
    }, this.flushDelayMs);
  }

  async get(key: string): Promise<string | null> {
    return this.kv[key] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.kv[key] = value;
    this.scheduleFlush();
  }

  async delete(key: string): Promise<void> {
    if (!(key in this.kv)) return;
    delete this.kv[key];
    this.scheduleFlush();
  }

  async keys(prefix = ''): Promise<string[]> {
    return Object.keys(this.kv).filter((key) => key.startsWith(prefix)).sort();
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty || this.closed) return;
    this.dirty = false;
    const body: FileShape = { version: 1, kv: this.kv };
    const serialized = JSON.stringify(body);
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, serialized, { mode: 0o600 });
    renameSync(temp, this.file);
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }
}
