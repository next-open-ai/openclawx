import type {
  IChannel,
  IInboundTransport,
  IOutboundTransport,
  UnifiedMessage,
  UnifiedReply,
} from '@openclawx/channel';

/**
 * Offline stub channel used by acceptance scripts: feed() injects a message,
 * sent replies are recorded. No network involved.
 */
export interface StubFeed {
  readonly replies: UnifiedReply[];
  feed(message: UnifiedMessage): Promise<void>;
  channel: IChannel;
}

export function createStubChannel(): StubFeed {
  const replies: UnifiedReply[] = [];
  const outbound: IOutboundTransport = {
    async send(_targetId: string, reply: UnifiedReply): Promise<unknown> {
      replies.push(reply);
      return { ok: true, index: replies.length - 1 };
    },
  };
  let handler: ((message: UnifiedMessage) => void | Promise<void>) | null = null;
  const inbound: IInboundTransport = {
    start: async () => undefined,
    stop: async () => undefined,
    setMessageHandler(next) {
      handler = next;
    },
  };
  const channel: IChannel = {
    id: 'stub',
    name: 'Stub',
    defaultEmployeeId: 'general',
    getInbounds: () => [inbound],
    getOutbounds: () => [outbound],
  };
  return {
    replies,
    channel,
    async feed(message: UnifiedMessage) {
      if (handler) await handler(message);
    },
  };
}
