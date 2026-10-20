/**
 * Parent-process channel-secrets channel (M2 P1).
 *
 * When the gateway runs as the Electron main process's forked child it asks
 * for the decrypted channel credentials (Telegram bot token, Feishu appSecret,
 * relay token) over the fork IPC. Standalone runs simply get an empty object
 * and must rely on a config file that carries tokens.
 */
export interface ChannelSecrets {
  channels?: {
    telegram?: { botToken?: string };
    feishu?: { appSecret?: string };
    dingtalk?: { clientSecret?: string };
    relay?: { token?: string };
  };
}

let cache: ChannelSecrets | null = null;
let requested = false;

export function getChannelSecrets(): ChannelSecrets {
  return cache ?? {};
}

export function requestParentChannelSecrets(timeoutMs = 4_000): Promise<void> {
  if (requested) return Promise.resolve();
  requested = true;
  if (!process.send || typeof process.on !== 'function') {
    cache = {};
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      process.off?.('message', onMessage);
      resolve();
    }, timeoutMs);
    function onMessage(message: unknown) {
      const payload = message as { type?: string; payload?: ChannelSecrets } | null;
      if (!payload || payload.type !== 'openclawx:channels:secrets') return;
      clearTimeout(timer);
      process.off?.('message', onMessage);
      cache = { channels: payload.payload?.channels };
      resolve();
    }
    process.on('message', onMessage);
    process.send?.({ type: 'openclawx:channels:secrets:request' });
  });
}
