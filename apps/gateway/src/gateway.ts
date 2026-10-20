import {
  registerChannel,
  dispatchMessage,
  startAllChannels,
  stopAllChannels,
  type IChannel,
  type UnifiedMessage,
  type UnifiedReply,
} from '@workmate/channel';
import { createTelegramChannel } from './adapters/telegram.js';
import { createStubChannel } from './adapters/stub.js';
import { createFeishuChannel } from './adapters/feishu.js';
import { createDingTalkChannel } from './adapters/dingtalk.js';
import { RelayDeviceClient } from './relay/device.js';
import type { RelayRequest } from './relay/protocol.js';
import type { GatewayConfig } from './config.js';
import { GatewayRuntime } from './runtime.js';

export interface RunningGateway {
  runtime: GatewayRuntime;
  channels: IChannel[];
  /** Offline stub feed when options.stub is set. */
  stubFeed?: (message: UnifiedMessage) => void | Promise<void>;
  /** Replies recorded by the stub channel outbound (test observations). */
  stubReplies?: UnifiedReply[];
  /** Offline Feishu fake feed when options.fakeFeishu is set. */
  feishuFeed?: (message: UnifiedMessage) => void | Promise<void>;
  feishuReplies?: UnifiedReply[];
  /** Remote-relay device link (channels.relay) — resolves once registered. */
  relayClient?: RelayDeviceClient;
  relayReady?: Promise<void>;
  stop(): Promise<void>;
}

/**
 * Build the gateway for a config. Registers Telegram when enabled (token
 * present), Feishu when enabled with appId/appSecret (or in offline fake mode),
 * and an offline stub channel for acceptance (stub forces allowAll).
 */
export function createGateway(config: GatewayConfig, options: { stub?: boolean; fakeFeishu?: boolean } = {}): RunningGateway {
  const runtime = new GatewayRuntime(config);
  const channels: IChannel[] = [];
  let stubFeed: ((message: UnifiedMessage) => void | Promise<void>) | null = null;
  let stubReplies: UnifiedReply[] | undefined;
  let feishuFeed: ((message: UnifiedMessage) => void | Promise<void>) | null = null;
  let feishuReplies: UnifiedReply[] | undefined;
  let relayClient: RelayDeviceClient | undefined;
  let relayReady: Promise<void> | undefined;

  const telegram = config.channels?.telegram;
  if (telegram?.enabled && telegram.botToken) {
    channels.push(createTelegramChannel({ botToken: telegram.botToken }));
  }
  const feishu = config.channels?.feishu;
  if (feishu?.enabled) {
    const fake = Boolean(options.fakeFeishu);
    if (fake || (feishu.appId && feishu.appSecret)) {
      const handle = createFeishuChannel({ appId: feishu.appId || 'fake', appSecret: fake ? 'fake' : (feishu.appSecret || '') }, { fake });
      channels.push(handle.channel);
      if (fake && handle.feed && handle.replies) {
        feishuFeed = (message) => handle.feed!(message);
        feishuReplies = handle.replies;
      }
    }
  }
  const dingtalk = config.channels?.dingtalk;
  if (dingtalk?.enabled && dingtalk.clientId && dingtalk.clientSecret) {
    channels.push(createDingTalkChannel({ clientId: dingtalk.clientId, clientSecret: dingtalk.clientSecret }));
  }
  if (options.stub) {
    const stub = createStubChannel();
    channels.push(stub.channel);
    stubReplies = stub.replies;
    stubFeed = (message) => dispatchMessage(message, runtime);
  }
  // Remote relay (M2 P3): the gateway device link reuses the runtime text
  // command surface (plain chats and /project… commands).
  const relay = config.channels?.relay;
  if (relay?.enabled && relay.baseUrl && relay.deviceId) {
    relayClient = new RelayDeviceClient({
      url: relay.baseUrl,
      deviceId: relay.deviceId,
      token: relay.token ?? '',
      onRequest: async (request: RelayRequest) => {
        if (request.method === 'ping') return { ok: true };
        const text = String(request.params?.text ?? request.params?.content ?? '');
        const message: UnifiedMessage = {
          channelId: 'relay',
          threadId: String(request.id),
          userId: String(request.params?.userId ?? `relay:${relay.deviceId}`),
          messageText: text || String(request.method),
        };
        if (text && !(await runtime.isAuthorized(message))) {
          return { ok: false, error: '未授权：该终端不在白名单内。' };
        }
        let accumulated = '';
        for await (const delta of runtime.process(message)) accumulated += delta;
        return { ok: true, text: accumulated.trim() };
      },
    });
    relayReady = relayClient.start().catch((error) => {
      console.warn('[relay] device connect failed:', error instanceof Error ? error.message : error);
    });
  }
  for (const channel of channels) {
    for (const inbound of channel.getInbounds()) {
      inbound.setMessageHandler((message) => dispatchMessage(message, runtime));
    }
    registerChannel(channel);
  }

  return {
    runtime,
    channels,
    stubFeed: stubFeed ?? undefined,
    stubReplies,
    feishuFeed: feishuFeed ?? undefined,
    feishuReplies,
    relayClient,
    relayReady,
    async stop() {
      await relayClient?.close().catch(() => undefined);
      await stopAllChannels();
    },
  };
}

/** Start long-poll adapters (no-op for the offline stub). */
export async function startGateway(gateway: RunningGateway): Promise<void> {
  await startAllChannels();
}
