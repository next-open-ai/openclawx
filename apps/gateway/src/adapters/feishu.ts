import type {
  IChannel,
  IInboundTransport,
  IOutboundTransport,
  StreamSink,
  UnifiedMessage,
  UnifiedReply,
} from '@openclawx/channel';

/**
 * Feishu (Lark) channel adapter (M2 P2).
 *
 * Real mode: WebSocket long-connection events via @larksuiteoapi/node-sdk
 * (im.message.receive_v1 → UnifiedMessage), outbound text or interactive card
 * create→patch streaming. The SDK is loaded lazily so builds/tests that never
 * run real mode do not require it at compile time.
 * Fake mode: offline inbound feed + recorded outbound (acceptance scripts).
 */

export interface FeishuConfig {
  appId: string;
  appSecret: string;
}

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-testable without the SDK)
 * ------------------------------------------------------------------ */

const PROCESSED = new Map<string, number>();
const TTL_MS = 5 * 60 * 1000;

export function isDuplicateMessage(messageId: string): boolean {
  const now = Date.now();
  if (PROCESSED.has(messageId)) {
    const ts = PROCESSED.get(messageId)!;
    if (now - ts < TTL_MS) return true;
    PROCESSED.delete(messageId);
  }
  return false;
}

export function markMessageProcessed(messageId: string): void {
  PROCESSED.set(messageId, Date.now());
  if (PROCESSED.size > 5000) {
    for (const [id, ts] of [...PROCESSED.entries()]) {
      if (Date.now() - ts > TTL_MS) PROCESSED.delete(id);
    }
  }
}

function textFromContent(content: unknown): string {
  if (typeof content !== 'string') return String(content ?? '');
  try {
    const parsed = JSON.parse(content) as { text?: string };
    if (parsed && typeof parsed.text === 'string') return parsed.text;
    return String(content);
  } catch {
    return String(content);
  }
}

/** Convert a Lark receive_v1 event payload into a UnifiedMessage. */
export function parseFeishuEvent(data: unknown): UnifiedMessage | null {
  const raw = (data ?? {}) as Record<string, unknown>;
  const message = (raw.message ?? (raw as { event?: { message?: unknown } }).event?.message ?? {}) as Record<string, unknown>;
  const chatId = String(message.chat_id ?? '');
  const messageId = String(message.message_id ?? '');
  const content = textFromContent(message.content);
  if (!chatId || !content.trim()) return null;
  const sender = (raw.sender ?? {}) as Record<string, unknown>;
  const senderId = sender.sender_id as Record<string, unknown> | undefined;
  const userId = String(senderId?.open_id ?? senderId?.user_id ?? 'unknown');
  return {
    channelId: 'feishu',
    threadId: chatId,
    userId,
    userName: typeof sender.name === 'string' ? sender.name : undefined,
    messageText: content.trim(),
    messageId,
    raw: data,
  };
}

/* ------------------------------------------------------------------ *
 * Real transports (SDK loaded lazily)
 * ------------------------------------------------------------------ */

type LarkModule = {
  EventDispatcher: new (options?: Record<string, never>) => { register(event: string, handler: (data: unknown) => Promise<void>): unknown };
  WSClient: new (options: { appId: string; appSecret: string; loggerLevel?: number }) => {
    start(options: { eventDispatcher: unknown }): Promise<unknown>;
    stop?(): Promise<unknown>;
  };
  Client: new (options: { appId: string; appSecret: string; appType: string; domain: string }) => {
    im: {
      v1: {
        message: {
          create(options: { params: { receive_id_type: string }; data: { receive_id: string; content: string; msg_type: string } }): Promise<{ data?: { message_id?: string } }>;
          patch(options: { path: { message_id: string }; data: { content: string } }): Promise<unknown>;
        };
      };
    };
  };
  LoggerLevel: { warn: number };
  AppType: { SelfBuild: string };
  Domain: { Feishu: string };
};

let larkPromise: Promise<LarkModule> | null = null;
function loadLark(): Promise<LarkModule> {
  if (!larkPromise) {
    larkPromise = import('@larksuiteoapi/node-sdk') as unknown as Promise<LarkModule>;
  }
  return larkPromise;
}

interface LarkWSClientLike {
  start(options: { eventDispatcher: unknown }): Promise<unknown>;
  stop?(): Promise<unknown>;
}

class FeishuWSInbound implements IInboundTransport {
  private handler: ((message: UnifiedMessage) => void | Promise<void>) | null = null;
  private client: LarkWSClientLike | null = null;

  constructor(private readonly config: FeishuConfig) {}

  setMessageHandler(handler: (message: UnifiedMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const lark = await loadLark();
    const dispatcher = new lark.EventDispatcher({}).register('im.message.receive_v1', async (data: unknown) => {
      const unified = parseFeishuEvent(data);
      if (!unified || !unified.messageId) return;
      if (isDuplicateMessage(unified.messageId)) return;
      markMessageProcessed(unified.messageId);
      if (this.handler) await this.handler(unified);
    });
    this.client = new lark.WSClient({ appId: this.config.appId, appSecret: this.config.appSecret, loggerLevel: lark.LoggerLevel.warn }) as LarkWSClientLike;
    await this.client.start({ eventDispatcher: dispatcher });
  }

  async stop(): Promise<void> {
    await this.client?.stop?.().catch(() => undefined);
    this.client = null;
  }
}

class FeishuApiOutbound implements IOutboundTransport {
  private client: InstanceType<LarkModule['Client']> | null = null;

  constructor(private readonly config: FeishuConfig) {}

  private async getClient(): Promise<InstanceType<LarkModule['Client']>> {
    if (!this.client) {
      const lark = await loadLark();
      this.client = new lark.Client({ appId: this.config.appId, appSecret: this.config.appSecret, appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu });
    }
    return this.client;
  }

  async send(targetId: string, reply: UnifiedReply): Promise<unknown> {
    const client = await this.getClient();
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: targetId, content: JSON.stringify({ text: reply.text }), msg_type: 'text' },
    });
    return { ok: true };
  }

  async sendStream(targetId: string): Promise<StreamSink> {
    const client = await this.getClient();
    const initial = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '🤔 思考中…' } },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: '正在生成回答…' } }],
    };
    const created = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: targetId, content: JSON.stringify(initial), msg_type: 'interactive' },
    });
    const messageId = created.data?.message_id;
    if (!messageId) throw new Error('feishu card create did not return message_id');
    const patch = async (content: string, title: string) => {
      const card = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: title } },
        elements: [{ tag: 'markdown', content }],
      };
      await client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } }).catch(() => undefined);
    };
    return {
      onChunk: async (accumulated) => patch(`${accumulated || ' '} ▌`, '回答中…'),
      onDone: async (accumulated) => patch(accumulated.trim() || '(无内容)', '✅ 完成'),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Fake transports (offline acceptance)
 * ------------------------------------------------------------------ */

class FakeFeishuInbound implements IInboundTransport {
  private handler: ((message: UnifiedMessage) => void | Promise<void>) | null = null;

  setMessageHandler(handler: (message: UnifiedMessage) => void | Promise<void>): void {
    this.handler = handler;
  }
  async start(): Promise<void> {
    /* offline */
  }
  async stop(): Promise<void> {
    /* offline */
  }
  async feed(message: UnifiedMessage): Promise<void> {
    if (this.handler) await this.handler(message);
  }
}

class FakeFeishuOutbound implements IOutboundTransport {
  readonly replies: UnifiedReply[] = [];
  async send(_targetId: string, reply: UnifiedReply): Promise<unknown> {
    this.replies.push(reply);
    return { ok: true, index: this.replies.length - 1 };
  }
}

export interface FeishuChannelHandle {
  channel: IChannel;
  inbound: FakeFeishuInbound | null;
  outbound: FakeFeishuOutbound | null;
  feed?: (message: UnifiedMessage) => Promise<void>;
  replies?: UnifiedReply[];
}

export function createFeishuChannel(config: FeishuConfig, options: { fake?: boolean } = {}): FeishuChannelHandle {
  if (options.fake) {
    const inbound = new FakeFeishuInbound();
    const outbound = new FakeFeishuOutbound();
    const channel: IChannel = {
      id: 'feishu',
      name: '飞书',
      defaultEmployeeId: 'general',
      getInbounds: () => [inbound],
      getOutbounds: () => [outbound],
    };
    return { channel, inbound, outbound, feed: (message) => inbound.feed(message), replies: outbound.replies };
  }
  const inbound = new FeishuWSInbound(config);
  const outbound = new FeishuApiOutbound(config);
  const channel: IChannel = {
    id: 'feishu',
    name: '飞书',
    defaultEmployeeId: 'general',
    getInbounds: () => [inbound],
    getOutbounds: () => [outbound],
  };
  return { channel, inbound: null, outbound: null };
}
