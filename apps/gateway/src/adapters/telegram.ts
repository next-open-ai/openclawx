import type {
  IChannel,
  IInboundTransport,
  IOutboundTransport,
  StreamSink,
  UnifiedMessage,
  UnifiedReply,
} from '@openclawx/channel';

const API = 'https://api.telegram.org/bot';
const MAX_TEXT = 4096;

interface TgMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number };
  text?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

function truncate(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 3)}...`;
}

function apiUrl(token: string, method: string): string {
  return `${API}${encodeURIComponent(token)}/${method}`;
}

async function telegramPost(token: string, method: string, body: Record<string, unknown>): Promise<{ ok: boolean; description?: string; result?: Record<string, unknown> }> {
  const response = await fetch(apiUrl(token, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<{ ok: boolean; description?: string; result?: Record<string, unknown> }>;
}

async function telegramGet(token: string, params: Record<string, string | number>): Promise<{ ok: boolean; description?: string; result?: TgUpdate[] }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  const response = await fetch(`${apiUrl(token, 'getUpdates')}?${query.toString()}`);
  return response.json() as Promise<{ ok: boolean; description?: string; result?: TgUpdate[] }>;
}

class TelegramLongPollInbound implements IInboundTransport {
  private handler: ((message: UnifiedMessage) => void | Promise<void>) | null = null;
  private stopped = false;
  private lastOffset = 0;

  constructor(private readonly token: string) {}

  setMessageHandler(handler: (message: UnifiedMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.stopped = false;
    const poll = async () => {
      while (!this.stopped) {
        try {
          const response = await telegramGet(this.token, { offset: this.lastOffset, timeout: 25 });
          if (!response.ok || !Array.isArray(response.result)) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            continue;
          }
          for (const update of response.result) {
            if (update.update_id >= this.lastOffset) this.lastOffset = update.update_id + 1;
            const raw = update.message ?? update.edited_message;
            if (!raw?.text?.trim() || !raw.chat?.id) continue;
            const unified: UnifiedMessage = {
              channelId: 'telegram',
              threadId: String(raw.chat.id),
              userId: String(raw.from?.id ?? 'unknown'),
              userName: raw.from?.first_name || raw.from?.username,
              messageText: raw.text.trim(),
              messageId: String(raw.message_id),
              raw: raw,
            };
            if (this.handler) await this.handler(unified);
          }
        } catch (error) {
          console.warn('[telegram] poll error:', error instanceof Error ? error.message : error);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    };
    void poll();
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

class TelegramApiOutbound implements IOutboundTransport {
  constructor(private readonly token: string) {}

  async send(targetId: string, reply: UnifiedReply): Promise<unknown> {
    const response = await telegramPost(this.token, 'sendMessage', { chat_id: targetId, text: truncate(reply.text || '(无内容)') });
    if (!response.ok) throw new Error(response.description ?? 'telegram send failed');
    return response.result;
  }

  async sendStream(targetId: string): Promise<StreamSink> {
    const placeholder = await telegramPost(this.token, 'sendMessage', { chat_id: targetId, text: '…' });
    const messageId = placeholder.result?.message_id;
    if (!placeholder.ok || !messageId) throw new Error(placeholder.description ?? 'telegram placeholder failed');
    const edit = async (content: string) => {
      const response = await telegramPost(this.token, 'editMessageText', { chat_id: targetId, message_id: messageId, text: truncate(content || ' ') });
      if (!response.ok && !response.description?.includes('message is not modified')) {
        console.warn('[telegram] edit failed:', response.description);
      }
    };
    return {
      onChunk: async (accumulated) => edit(`${accumulated} ▌`),
      onTurnEnd: async (accumulated) => edit(accumulated || ' '),
      onDone: async (accumulated) => edit(accumulated.trim() || '(无内容)'),
    };
  }
}

/** Telegram channel: long-poll inbound + sendMessage/editMessageText outbound. */
export function createTelegramChannel(input: { botToken: string }): IChannel {
  const inbound = new TelegramLongPollInbound(input.botToken);
  const outbound = new TelegramApiOutbound(input.botToken);
  return {
    id: 'telegram',
    name: 'Telegram',
    defaultEmployeeId: 'general',
    getInbounds: () => [inbound],
    getOutbounds: () => [outbound],
  };
}
