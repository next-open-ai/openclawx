/**
 * 会话消息出口：统一消息类型与消费者接口。
 * 所有发给各端（Web/Desktop、通道）的会话消息经此抽象，由出口按 sessionId 路由到已注册的消费者。
 */

/** 消息类型：对话内容 vs 系统消息（MCP 进度、// 命令结果等） */
export type SessionMessageType = "chat" | "system";

/** 系统消息子类型，便于各端区分展示 */
export type SessionMessageCode =
    | "agent.chunk"
    | "agent.tool"
    | "turn_end"
    | "message_complete"
    | "agent_end"
    | "conversation_end"
    | "mcp.progress"
    | "command.result";

/**
 * 统一会话消息：出口只认 sessionId + 本结构，不关心具体传输。
 */
export interface SessionMessage {
    type: SessionMessageType;
    code?: SessionMessageCode;
    payload: Record<string, unknown>;
    sessionId: string;
    timestamp?: number;
}

/** 发送时调用方可不带 sessionId，由出口注入 */
export type SessionMessageInput = Omit<SessionMessage, "sessionId"> & { sessionId?: string };

/**
 * 消费者接口：各端（Web、通道）注册后，出口将消息推送给 send(message)。
 */
export interface SessionMessageConsumer {
    send(message: SessionMessage): void | Promise<void>;
}

/**
 * 出口接口：支持注册消费者与发送消息，便于注入与测试。
 */
export interface ISessionOutlet {
    emit(sessionId: string, message: Omit<SessionMessage, "sessionId" | "timestamp">): void;
    registerConsumer(sessionId: string, consumer: SessionMessageConsumer): () => void;
}
