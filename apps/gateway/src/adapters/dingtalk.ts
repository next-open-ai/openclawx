import { DWClient, EventAck, TOPIC_ROBOT, type RobotMessage } from 'dingtalk-stream';
import type {
  IChannel,
  IInboundTransport,
  IOutboundTransport,
  StreamSink,
  UnifiedMessage,
  UnifiedReply,
} from '@workmate/channel';

export interface DingTalkConfig {
  clientId: string;
  clientSecret: string;
}

type DingTalkEnvelope = {
  data?: string;
  headers?: { messageId?: string };
};

export function parseDingTalkMessage(envelope: DingTalkEnvelope, ack?: (messageId: string, result?: unknown) => void): UnifiedMessage | null {
  if (!envelope.data) return null;
  const data = JSON.parse(envelope.data) as RobotMessage;
  const text = data.msgtype === 'text' ? data.text?.content?.trim() : '';
  if (!data.conversationId || !text) return null;
  const messageId = String(envelope.headers?.messageId || '');
  return {
    channelId: 'dingtalk',
    threadId: data.conversationId,
    userId: data.senderStaffId || data.senderId || 'unknown',
    userName: data.senderNick,
    messageText: text,
    messageId: messageId || undefined,
    raw: data,
    ack: messageId && ack ? (result) => ack(messageId, result) : undefined,
  };
}

class DingTalkStreamInbound implements IInboundTransport {
  private handler: ((message: UnifiedMessage) => void | Promise<void>) | null = null;

  constructor(
    private readonly client: DWClient,
    private readonly rememberWebhook: (conversationId: string, webhook: string) => void,
  ) {}

  setMessageHandler(handler: (message: UnifiedMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.client.registerCallbackListener(TOPIC_ROBOT, async (envelope) => {
      try {
        const raw = JSON.parse(envelope.data) as RobotMessage;
        if (raw.conversationId && raw.sessionWebhook) this.rememberWebhook(raw.conversationId, raw.sessionWebhook);
        const message = parseDingTalkMessage(envelope, (messageId, result) => {
          this.client.socketCallBackResponse(messageId, result ?? {});
        });
        if (message && this.handler) await this.handler(message);
      } catch (error) {
        console.warn('[dingtalk] inbound parse failed:', error instanceof Error ? error.message : error);
      }
    });
    this.client.registerAllEventListener(() => ({ status: EventAck.SUCCESS }));
    await this.client.connect();
  }

  async stop(): Promise<void> {
    this.client.disconnect();
  }
}

class DingTalkWebhookOutbound implements IOutboundTransport {
  constructor(
    private readonly client: DWClient,
    private readonly webhookFor: (conversationId: string) => string | undefined,
  ) {}

  private async post(webhook: string, text: string): Promise<unknown> {
    const token = await this.client.getAccessToken();
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
    });
    if (!response.ok) throw new Error(`DingTalk webhook failed (${response.status})`);
    return response.json().catch(() => ({}));
  }

  async send(targetId: string, reply: UnifiedReply): Promise<unknown> {
    const webhook = this.webhookFor(targetId);
    if (!webhook) throw new Error(`DingTalk session webhook is unavailable for ${targetId}`);
    return this.post(webhook, reply.text.trim() || '(无内容)');
  }

  async sendStream(targetId: string): Promise<StreamSink> {
    const webhook = this.webhookFor(targetId);
    if (!webhook) throw new Error(`DingTalk session webhook is unavailable for ${targetId}`);
    let sentLength = 0;
    let queue = Promise.resolve();
    const flush = (text: string) => {
      const pending = text.slice(sentLength).trim();
      if (!pending) return Promise.resolve();
      return this.post(webhook, pending).then(() => { sentLength = text.length; });
    };
    return {
      onChunk: async () => undefined,
      onTurnEnd: async (text) => { queue = queue.then(() => flush(text)); await queue; },
      onDone: async (text) => {
        const finalText = text.trim() || '(无内容)';
        queue = queue.then(() => sentLength ? flush(finalText) : this.post(webhook, finalText).then(() => { sentLength = finalText.length; }));
        await queue;
      },
    };
  }
}

export function createDingTalkChannel(config: DingTalkConfig): IChannel {
  if (!config.clientId.trim() || !config.clientSecret.trim()) throw new Error('DingTalk clientId and clientSecret are required');
  const client = new DWClient({ clientId: config.clientId.trim(), clientSecret: config.clientSecret.trim(), debug: false });
  const webhooks = new Map<string, string>();
  const inbound = new DingTalkStreamInbound(client, (id, webhook) => webhooks.set(id, webhook));
  const outbound = new DingTalkWebhookOutbound(client, (id) => webhooks.get(id));
  return {
    id: 'dingtalk',
    name: '钉钉',
    defaultEmployeeId: 'general',
    getInbounds: () => [inbound],
    getOutbounds: () => [outbound],
  };
}
