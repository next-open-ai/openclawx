/**
 * 通道模块统一类型：与传输方式（webhook / 长连接）解耦。
 */

/** 统一入站消息：所有入站解析后的共同结构 */
export interface UnifiedMessage {
    /** 通道标识，如 feishu / telegram */
    channelId: string;
    /** 平台内会话/群组/单聊标识，回复时用 */
    threadId: string;
    /** 平台内用户标识 */
    userId: string;
    /** 用户显示名（可选） */
    userName?: string;
    /** 消息正文 */
    messageText: string;
    /** 附件（可选） */
    attachments?: { type: string; url?: string; name?: string }[];
    /** 原始 payload（排查用） */
    raw?: unknown;
    /** 回复应交给哪个出站，如 "default" 或 connectionId */
    replyTarget?: string;
    /** 平台消息 ID（可选，用于回复引用等） */
    messageId?: string;
}

/** 统一出站回复 */
export interface UnifiedReply {
    text: string;
    attachments?: { type: string; url?: string; name?: string }[];
}

/** 入站传输：从外部收数据 → 产出 UnifiedMessage */
export interface IInboundTransport {
    start(): Promise<void>;
    stop(): Promise<void>;
    /** 设置收到消息时的回调 */
    setMessageHandler(handler: (msg: UnifiedMessage) => void | Promise<void>): void;
}

/** 出站传输：将 UnifiedReply 发到外部 */
export interface IOutboundTransport {
    send(targetId: string, reply: UnifiedReply): Promise<void>;
    /** 可选：该出站是否还能往 targetId 发（如连接是否有效） */
    canSend?(targetId: string): boolean;
}

/** 通道：身份 + 入站/出站列表 + 回复路由 */
export interface IChannel {
    id: string;
    name: string;
    /** 默认 agentId，用于会话 */
    defaultAgentId?: string;
    getInbounds(): IInboundTransport[];
    getOutbounds(): IOutboundTransport[];
    /** 根据消息或 threadId 选择出站；默认返回第一个 outbound */
    getOutboundForMessage?(msg: UnifiedMessage): IOutboundTransport | undefined;
}
