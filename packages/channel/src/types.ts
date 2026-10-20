/**
 * Channel protocol types (M1). Transport-agnostic: inbound/outbound adapters
 * (Telegram long-poll, Feishu WS, future relay) speak through these so the
 * gateway core and orchestration runtime stay transport-independent.
 *
 * Reference: openclawx gateway/channel layout (UnifiedMessage / IChannel /
 * StreamSink) — re-implemented here per OpenClawX constraints.
 */

/** Optional attachment carried by an IM message. */
export interface ChannelAttachment {
  type: 'file' | 'image' | 'audio' | 'video' | 'unknown';
  /** Platform file id or URL, when available. */
  url?: string;
  name?: string;
  sizeBytes?: number;
}

/** Unified inbound message produced by every channel adapter. */
export interface UnifiedMessage {
  /** Channel id, e.g. `telegram` / `feishu`. */
  channelId: string;
  /** Platform thread id (chat/group/conversation id) — reply target. */
  threadId: string;
  /** Platform user id. */
  userId: string;
  /** Display name (optional). */
  userName?: string;
  /** Text content (after trimming platform-specific prefixes). */
  messageText: string;
  attachments?: ChannelAttachment[];
  /** Platform message id (dedupe). */
  messageId?: string;
  /** Outbound target override; defaults to "default" outbound. */
  replyTarget?: string;
  /** Raw payload for debugging. */
  raw?: unknown;
  /** Called after the reply is sent (used by stream-ack transports). */
  ack?: (sendResult?: unknown) => void | Promise<void>;
}

/** Unified outbound reply body. */
export interface UnifiedReply {
  text: string;
  attachments?: ChannelAttachment[];
}

/** Streaming outbound sink: first placeholder, then accumulated updates. */
export interface StreamSink {
  /** Update the accumulated full text (throttled by the channel core). */
  onChunk(accumulated: string): void | Promise<void>;
  /** Optional per-turn boundary (agent finished a tool turn). */
  onTurnEnd?(accumulated: string): void | Promise<void>;
  /** Final flush. */
  onDone(accumulated: string): void | Promise<void>;
}

export interface IInboundTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  setMessageHandler(handler: (message: UnifiedMessage) => void | Promise<void>): void;
}

export interface IOutboundTransport {
  send(targetId: string, reply: UnifiedReply): Promise<unknown>;
  /** Optional streaming reply; absence disables live streaming for the channel. */
  sendStream?(targetId: string): Promise<StreamSink>;
  canSend?(targetId: string): boolean;
}

/** A registered channel: identity + inbounds/outbounds + reply routing. */
export interface IChannel {
  id: string;
  name: string;
  /** Default employee id for threads without an explicit session employee. */
  defaultEmployeeId?: string;
  getInbounds(): IInboundTransport[];
  getOutbounds(): IOutboundTransport[];
  getOutboundForMessage?(message: UnifiedMessage): IOutboundTransport | undefined;
}
