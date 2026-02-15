/**
 * 通道核心：收 UnifiedMessage → 会话映射 → 调 Agent → 选 Outbound → 发 UnifiedReply。
 */
import type { UnifiedMessage, UnifiedReply, IChannel, IOutboundTransport } from "./types.js";
import { runAgentAndCollectReply } from "./run-agent.js";

function toSessionId(channelId: string, threadId: string): string {
    return `channel:${channelId}:${threadId}`;
}

/**
 * 处理一条入站消息：映射 session、跑 Agent、选出站并发送回复。
 */
export async function handleChannelMessage(
    channel: IChannel,
    msg: UnifiedMessage
): Promise<void> {
    const sessionId = toSessionId(msg.channelId, msg.threadId);
    const agentId = channel.defaultAgentId ?? "default";

    let replyText: string;
    try {
        replyText = await runAgentAndCollectReply({
            sessionId,
            message: msg.messageText,
            agentId,
        });
    } catch (err) {
        console.error("[ChannelCore] runAgent failed:", err);
        replyText = "处理时出错，请稍后再试。";
    }

    const outbound = channel.getOutboundForMessage
        ? channel.getOutboundForMessage(msg)
        : channel.getOutbounds()[0];
    if (!outbound) {
        console.warn("[ChannelCore] no outbound for message", msg.channelId, msg.threadId);
        return;
    }

    const reply: UnifiedReply = { text: replyText };
    // 发信目标始终用 threadId（如飞书 chat_id），replyTarget 仅用于选出站
    await outbound.send(msg.threadId, reply);
}
