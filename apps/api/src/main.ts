import { createApp } from './app.js';
import { requestParentSecrets } from './modules/orchestration/secrets.js';
import { ensureSharedAgentscopeRuntime, stopSharedAgentscopeRuntime, resolveAgentEngine } from '@openclawx/agent-core';
import { resolveMobileHttpsProxyConfig, startMobileHttpsProxy } from './modules/chat-mobile/https-proxy.js';

async function bootstrap() {
  const port = Number(process.env.OPENCLAWX_API_PORT ?? 47832);
  const host = process.env.OPENCLAWX_API_HOST || '127.0.0.1';
  let mobileHttpsConfig: ReturnType<typeof resolveMobileHttpsProxyConfig> = null;
  try { mobileHttpsConfig = resolveMobileHttpsProxyConfig(); }
  catch (error) { console.error('[openclawx-api] Mobile HTTPS disabled after TLS setup failure', error); }
  const engine = resolveAgentEngine();
  const warmAgentscope = process.env.OPENCLAWX_AGENTSCOPE_ENABLED === '1' || engine === 'agentscope';
  // Kick off secrets early, but do not block /api/health on the full 4s parent
  // IPC timeout — that raced Electron's waitForApi and left Vite ECONNREFUSED.
  const secretsReady = requestParentSecrets().catch(() => undefined);
  await Promise.race([
    secretsReady,
    new Promise<void>((resolve) => setTimeout(resolve, 750)),
  ]);
  if (warmAgentscope) {
    try {
      await secretsReady;
      const handle = await ensureSharedAgentscopeRuntime();
      const health = await handle.client.health();
      console.info('[openclawx-api] AgentScope runtime ready', { engine, port: handle.port, host, health });
    } catch (error) {
      console.error('[openclawx-api] AgentScope runtime failed to start', { engine, error });
      if (engine === 'agentscope') throw error;
    }
  }
  const app = await createApp();
  await app.listen({ port, host });
  let mobileHttps: Awaited<ReturnType<typeof startMobileHttpsProxy>> | null = null;
  try {
    mobileHttps = mobileHttpsConfig
      ? await startMobileHttpsProxy({ config: mobileHttpsConfig, apiPort: port })
      : null;
  } catch (error) {
    console.error('[openclawx-api] Mobile HTTPS failed; core API remains available', error);
    mobileHttps = null;
  }
  if (mobileHttps && mobileHttpsConfig) {
    process.env.OPENCLAWX_MOBILE_PUBLIC_ORIGIN = mobileHttpsConfig.publicOrigin;
    if (mobileHttpsConfig.managedCaFile) process.env.OPENCLAWX_MOBILE_HTTPS_CA_FILE = mobileHttpsConfig.managedCaFile;
  }
  if (mobileHttps) console.info('[openclawx-api] Mobile HTTPS ready', { origin: mobileHttps.origin, forwardedPrefix: '/api/chat-mobile/' });
  void secretsReady;

  const close = async () => {
    await mobileHttps?.close().catch(() => undefined);
    await stopSharedAgentscopeRuntime().catch(() => undefined);
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

void bootstrap();
