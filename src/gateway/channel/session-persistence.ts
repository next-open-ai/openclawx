/**
 * 通道会话持久化：与 Web/Desktop 统一使用同一套 session + chat_messages 入库。
 * 由 Gateway 启动时注入 AgentsService，通道在处理消息前后调用 ensureSession / appendMessage。
 */

export type SessionType = "chat" | "scheduled" | "system";

export interface IChannelSessionPersistence {
    getOrCreateSession(
        sessionId: string,
        options?: { agentId?: string; workspace?: string; title?: string; type?: SessionType },
    ): Promise<unknown>;
    getSession(sessionId: string): { agentId?: string } | undefined;
    appendMessage(
        sessionId: string,
        role: "user" | "assistant",
        content: string,
        options?: { toolCalls?: unknown[]; contentParts?: unknown[] },
    ): void;
}

let persistence: IChannelSessionPersistence | null = null;

export function setChannelSessionPersistence(service: IChannelSessionPersistence | null): void {
    persistence = service;
}

export function getChannelSessionPersistence(): IChannelSessionPersistence | null {
    return persistence;
}

/**
 * 确保通道会话已入库（getOrCreateSession），并追加一条用户消息。
 * 在跑 Agent 前调用；若未注入持久化则静默跳过。
 */
export async function persistChannelUserMessage(
    sessionId: string,
    options: { agentId: string; title?: string; messageText: string },
): Promise<void> {
    const p = getChannelSessionPersistence();
    if (!p) return;
    try {
        await p.getOrCreateSession(sessionId, {
            agentId: options.agentId,
            title: options.title ?? (options.messageText.slice(0, 50) || undefined),
            type: "chat",
        });
        p.appendMessage(sessionId, "user", options.messageText);
    } catch (e) {
        console.warn("[ChannelSessionPersistence] persist user message failed:", e);
    }
}

/**
 * 通道本轮助手回复结束时，将助手消息入库。
 * 在 onDone 时调用；若未注入持久化则静默跳过。
 */
export function persistChannelAssistantMessage(sessionId: string, content: string): void {
    const p = getChannelSessionPersistence();
    if (!p) return;
    try {
        p.appendMessage(sessionId, "assistant", content);
    } catch (e) {
        console.warn("[ChannelSessionPersistence] persist assistant message failed:", e);
    }
}
