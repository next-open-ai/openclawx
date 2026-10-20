import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { getOrchestrator } from '../orchestration/routes.js';

type ChannelSecrets = {
  telegram?: { botToken?: string };
  feishu?: { appSecret?: string };
  dingtalk?: { clientSecret?: string };
  relay?: { token?: string };
};

type ChannelMeta = {
  enabled?: boolean;
  appId?: string;
  clientId?: string;
  baseUrl?: string;
  deviceId?: string;
};

type ChannelMetaShape = {
  version?: number;
  defaultEmployeeId?: string;
  allowlist?: string[];
  channels?: {
    telegram?: ChannelMeta;
    feishu?: ChannelMeta;
    dingtalk?: ChannelMeta;
    relay?: ChannelMeta;
  };
};

let gatewayProcess: ChildProcess | null = null;

function dataDir(): string {
  return process.env.WORKMATE_DATA_DIR || path.join(os.homedir(), '.workmate');
}

function secretsFile(): string {
  return path.join(dataDir(), 'settings.channels.v1.json');
}

function runtimeGatewayConfigFile(): string {
  return path.join(dataDir(), 'gateway.runtime.json');
}

function gatewayEntry(): string {
  return path.join(process.cwd(), 'apps', 'gateway', 'dist', 'main.js');
}

function gatewayApiUrl(): string {
  const port = Number(process.env.WORKMATE_API_PORT ?? 47832);
  return `http://127.0.0.1:${port}/api/orch`;
}

function fail(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(400).send({ message });
}

function cleanChannelMeta(value: unknown): ChannelMetaShape {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const channels = source.channels && typeof source.channels === 'object' ? source.channels as Record<string, unknown> : {};
  const telegram = channels.telegram && typeof channels.telegram === 'object' ? channels.telegram as Record<string, unknown> : {};
  const feishu = channels.feishu && typeof channels.feishu === 'object' ? channels.feishu as Record<string, unknown> : {};
  const dingtalk = channels.dingtalk && typeof channels.dingtalk === 'object' ? channels.dingtalk as Record<string, unknown> : {};
  const relay = channels.relay && typeof channels.relay === 'object' ? channels.relay as Record<string, unknown> : {};
  const allowlist = Array.isArray(source.allowlist)
    ? source.allowlist.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  return {
    version: 1,
    defaultEmployeeId: String(source.defaultEmployeeId || 'general'),
    channels: {
      telegram: { enabled: Boolean(telegram.enabled) },
      feishu: {
        enabled: Boolean(feishu.enabled),
        ...(String(feishu.appId || '').trim() ? { appId: String(feishu.appId).trim() } : {}),
      },
      dingtalk: {
        enabled: Boolean(dingtalk.enabled),
        ...(String(dingtalk.clientId || '').trim() ? { clientId: String(dingtalk.clientId).trim() } : {}),
      },
      relay: {
        enabled: Boolean(relay.enabled),
        ...(String(relay.baseUrl || '').trim() ? { baseUrl: String(relay.baseUrl).trim() } : {}),
        ...(String(relay.deviceId || '').trim() ? { deviceId: String(relay.deviceId).trim() } : {}),
      },
    },
    ...(allowlist.length ? { allowlist } : {}),
  };
}

function readChannelSecrets(): ChannelSecrets {
  try {
    if (!fs.existsSync(secretsFile())) return {};
    const raw = JSON.parse(fs.readFileSync(secretsFile(), 'utf8')) as { secrets?: ChannelSecrets };
    return raw?.secrets && typeof raw.secrets === 'object' ? raw.secrets : {};
  } catch {
    return {};
  }
}

function writeChannelSecrets(tokens: ChannelSecrets) {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    secretsFile(),
    JSON.stringify({ version: 1, secrets: tokens, updatedAt: Date.now() }, null, 2),
    { mode: 0o600 },
  );
}

async function readChannelMeta(): Promise<ChannelMetaShape> {
  const raw = await getOrchestrator().store.get('channels.v1');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ChannelMetaShape;
  } catch {
    return {};
  }
}

async function writeChannelMeta(meta: ChannelMetaShape) {
  await getOrchestrator().store.set('channels.v1', JSON.stringify(meta));
}

function enabledChannels(meta: ChannelMetaShape): string[] {
  const entries = meta.channels && typeof meta.channels === 'object' ? meta.channels : {};
  return ['telegram', 'feishu', 'dingtalk', 'relay'].filter((id) => Boolean((entries as Record<string, ChannelMeta | undefined>)[id]?.enabled));
}

function gatewayStatus() {
  return {
    running: Boolean(gatewayProcess && !gatewayProcess.killed && gatewayProcess.exitCode === null),
    pid: gatewayProcess && !gatewayProcess.killed ? gatewayProcess.pid ?? null : null,
  };
}

function stopGateway(): void {
  if (gatewayProcess && !gatewayProcess.killed && gatewayProcess.exitCode === null) {
    gatewayProcess.kill('SIGTERM');
  }
  gatewayProcess = null;
}

async function startGatewayIfEnabled(): Promise<{ running: boolean; pid: number | null }> {
  if (gatewayStatus().running) return gatewayStatus();
  const meta = await readChannelMeta();
  if (!enabledChannels(meta).length) return gatewayStatus();
  const entry = gatewayEntry();
  if (!fs.existsSync(entry)) throw new Error(`Gateway build is missing: ${entry}`);
  const secrets = readChannelSecrets();
  const runtimeConfig = {
    apiBaseUrl: gatewayApiUrl(),
    defaultEmployeeId: String(meta.defaultEmployeeId || 'general'),
    allowlist: Array.isArray(meta.allowlist) ? meta.allowlist : [],
    channels: {
      telegram: {
        enabled: Boolean(meta.channels?.telegram?.enabled),
        ...(secrets.telegram?.botToken ? { botToken: String(secrets.telegram.botToken) } : {}),
      },
      feishu: {
        enabled: Boolean(meta.channels?.feishu?.enabled),
        ...(meta.channels?.feishu?.appId ? { appId: String(meta.channels.feishu.appId) } : {}),
        ...(secrets.feishu?.appSecret ? { appSecret: String(secrets.feishu.appSecret) } : {}),
      },
      dingtalk: {
        enabled: Boolean(meta.channels?.dingtalk?.enabled),
        ...(meta.channels?.dingtalk?.clientId ? { clientId: String(meta.channels.dingtalk.clientId) } : {}),
        ...(secrets.dingtalk?.clientSecret ? { clientSecret: String(secrets.dingtalk.clientSecret) } : {}),
      },
      relay: {
        enabled: Boolean(meta.channels?.relay?.enabled),
        ...(meta.channels?.relay?.baseUrl ? { baseUrl: String(meta.channels.relay.baseUrl) } : {}),
        ...(meta.channels?.relay?.deviceId ? { deviceId: String(meta.channels.relay.deviceId) } : {}),
        ...(secrets.relay?.token ? { token: String(secrets.relay.token) } : {}),
      },
    },
  };
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(runtimeGatewayConfigFile(), JSON.stringify(runtimeConfig, null, 2), { mode: 0o600 });
  gatewayProcess = fork(entry, [], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WORKMATE_API_URL: gatewayApiUrl(),
      WORKMATE_GATEWAY_CONFIG: runtimeGatewayConfigFile(),
    },
    stdio: 'inherit',
  });
  gatewayProcess.once('exit', () => {
    gatewayProcess = null;
  });
  return gatewayStatus();
}

export const remoteRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onReady', async () => {
    await startGatewayIfEnabled().catch((error) => {
      app.log.warn({ err: error }, 'remote gateway failed to start');
    });
  });
  app.addHook('onClose', async () => {
    stopGateway();
  });

  app.get('/remote/settings', async () => {
    return { meta: await readChannelMeta(), secrets: readChannelSecrets() };
  });

  app.put('/remote/settings', async (request, reply) => {
    const body = (request.body ?? {}) as { meta?: unknown; secrets?: unknown };
    const meta = cleanChannelMeta(body.meta);
    const secretsIn = body.secrets && typeof body.secrets === 'object' ? body.secrets as Record<string, unknown> : {};
    const telegram = secretsIn.telegram && typeof secretsIn.telegram === 'object' ? secretsIn.telegram as Record<string, unknown> : {};
    const feishu = secretsIn.feishu && typeof secretsIn.feishu === 'object' ? secretsIn.feishu as Record<string, unknown> : {};
    const dingtalk = secretsIn.dingtalk && typeof secretsIn.dingtalk === 'object' ? secretsIn.dingtalk as Record<string, unknown> : {};
    const relay = secretsIn.relay && typeof secretsIn.relay === 'object' ? secretsIn.relay as Record<string, unknown> : {};
    await writeChannelMeta(meta);
    writeChannelSecrets({
      telegram: { botToken: String(telegram.botToken || '').trim() },
      feishu: { appSecret: String(feishu.appSecret || '').trim() },
      dingtalk: { clientSecret: String(dingtalk.clientSecret || '').trim() },
      relay: { token: String(relay.token || '').trim() },
    });
    return { ok: true, meta };
  });

  app.get('/remote/gateway/status', async () => gatewayStatus());

  app.post('/remote/gateway/restart', async (_request, reply) => {
    try {
      stopGateway();
      return await startGatewayIfEnabled();
    } catch (error) {
      return fail(reply, error);
    }
  });
};
