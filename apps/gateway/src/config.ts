import { readFileSync } from 'node:fs';
import type { UnifiedMessage } from '@openclawx/channel';

/** M1 gateway configuration (single source for allowlists / defaults). */
export interface GatewayConfig {
  /** Orchestrator API base URL (defaults to the desktop local API). */
  apiBaseUrl?: string;
  defaultEmployeeId?: string;
  /** Per-channel enable + credentials. */
  channels?: {
    telegram?: {
      enabled?: boolean;
      botToken?: string;
    };
    /** M2 P2: Feishu connector config. */
    feishu?: {
      enabled?: boolean;
      appId?: string;
      appSecret?: string;
    };
    dingtalk?: {
      enabled?: boolean;
      clientId?: string;
      clientSecret?: string;
    };
    /** M2 P3: remote relay device config. */
    relay?: {
      enabled?: boolean;
      baseUrl?: string;
      deviceId?: string;
      token?: string;
    };
  };
  /**
   * Personal-use allowlist. An entry may be:
   *   - `${channelId}:user:${userId}`            (allow a specific user)
   *   - `${channelId}:chat:${threadId}`          (allow an entire thread)
   *   - `${channelId}:chat:${threadId}:${userId}` (user within a thread)
   * Empty list (default) denies everyone unless allowAll is true.
   */
  allowlist?: string[];
  /** Danger: allow all incoming messages (smoke/dev only). */
  allowAll?: boolean;
}

export interface ThreadState {
  sessionId?: string;
  employeeId: string;
}

/** Loads config from a JSON file (explicit path). */
export function loadConfigFile(file?: string): GatewayConfig {
  if (!file) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as GatewayConfig;
  } catch {
    return {};
  }
}

/**
 * Reads the channel config persisted in the orchestrator domain KV under
 * `channels.v1` (desktop settings write there). Returns {} when missing.
 */
export async function loadConfigFromKv(apiBaseUrl: string): Promise<GatewayConfig> {
  try {
    const response = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/kv?key=channels.v1`);
    if (!response.ok) return {};
    const body = (await response.json()) as { value?: string | null };
    if (!body.value) return {};
    const parsed = JSON.parse(body.value) as GatewayConfig;
    return { apiBaseUrl: parsed.apiBaseUrl ?? apiBaseUrl, ...parsed };
  } catch {
    return {};
  }
}

/** Authorization rule evaluated per inbound message. */
export function isAllowed(message: UnifiedMessage, config: GatewayConfig): boolean {
  if (config.allowAll) return true;
  const list = config.allowlist ?? [];
  if (!list.length) return false;
  const candidates = [
    `${message.channelId}:user:${message.userId}`,
    `${message.channelId}:chat:${message.threadId}`,
    `${message.channelId}:chat:${message.threadId}:${message.userId}`,
  ];
  return candidates.some((candidate) => list.includes(candidate));
}
