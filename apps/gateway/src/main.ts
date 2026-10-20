import { loadConfigFile, loadConfigFromKv, type GatewayConfig } from './config.js';
import { createGateway, startGateway } from './gateway.js';
import { requestParentChannelSecrets, getChannelSecrets } from './parent.js';

/**
 * Gateway process entry. The Electron desktop main forks this file with:
 *   OPENCLAWX_API_URL=<orchestrator base>   (defaults to the local api)
 *   OPENCLAWX_GATEWAY_CONFIG=<json file>    (optional override)
 *   OPENCLAWX_GATEWAY_STUB=1                (offline stub channel; acceptance only)
 * When no file is given the config is read from the orchestrator KV key
 * `channels.v1` (written by the desktop settings / config script); credentials
 * are requested once from the parent (main) process over fork IPC.
 */
async function main(): Promise<void> {
  const apiBaseUrl = process.env.OPENCLAWX_API_URL ?? 'http://127.0.0.1:47832/api/orch';
  const fileConfig = loadConfigFile(process.env.OPENCLAWX_GATEWAY_CONFIG);
  const kvConfig = await loadConfigFromKv(apiBaseUrl);
  await requestParentChannelSecrets();
  const secrets = getChannelSecrets();
  const config: GatewayConfig = {
    apiBaseUrl,
    ...kvConfig,
    ...fileConfig,
    ...(process.env.OPENCLAWX_GATEWAY_STUB === '1' ? { allowAll: true } : {}),
    channels: {
      telegram: {
        ...kvConfig.channels?.telegram,
        ...fileConfig.channels?.telegram,
        ...(secrets.channels?.telegram?.botToken
          ? { botToken: secrets.channels.telegram.botToken }
          : {}),
      },
      feishu: {
        ...kvConfig.channels?.feishu,
        ...fileConfig.channels?.feishu,
        ...(secrets.channels?.feishu?.appSecret
          ? { appSecret: secrets.channels.feishu.appSecret }
          : {}),
      },
      dingtalk: {
        ...kvConfig.channels?.dingtalk,
        ...fileConfig.channels?.dingtalk,
        ...(secrets.channels?.dingtalk?.clientSecret
          ? { clientSecret: secrets.channels.dingtalk.clientSecret }
          : {}),
      },
      relay: {
        ...kvConfig.channels?.relay,
        ...fileConfig.channels?.relay,
        ...(secrets.channels?.relay?.token ? { token: secrets.channels.relay.token } : {}),
      },
    },
  };
  const gateway = createGateway(config, {
    stub: process.env.OPENCLAWX_GATEWAY_STUB === '1',
    fakeFeishu: process.env.OPENCLAWX_FEISHU_FAKE === '1',
  });
  const names = gateway.channels.map((channel) => channel.id).join(',');
  console.log(`[gateway] ready channels=${names || '(none)'}`);
  if (!names) {
    console.log('[gateway] no enabled channels — exiting');
    process.exit(0);
  }
  await startGateway(gateway);

  const shutdown = async () => {
    await gateway.stop();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

void main();
