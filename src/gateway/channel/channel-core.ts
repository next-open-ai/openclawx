/**
 * 通道核心：收 UnifiedMessage → 会话映射 → 调 Agent → 选 Outbound → 发 UnifiedReply。
 * 系统消息（// 命令结果、MCP 进度）经统一出口推送，通道注册消费者后按 outbound 发送。
 */
import type { UnifiedMessage, UnifiedReply, IChannel, IOutboundTransport, StreamSink } from "./types.js";
import { runAgentAndCollectReply, runAgentAndStreamReply } from "./run-agent.js";
import { getChannelSessionPersistence, persistChannelUserMessage, persistChannelAssistantMessage } from "./session-persistence.js";
import { preprocessInboundMessage } from "../../core/inbound-message-preprocess.js";
import { getSessionCurrentAgentUpdater } from "../../core/session-current-agent.js";
import { getSessionOutlet, sendSessionMessage } from "../../core/session-outlet/index.js";
import type { SessionMessage, SessionMessageConsumer } from "../../core/session-outlet/index.js";

/** 系统消息前缀，与正常回复同路下发，仅用此前缀区分，各端无需额外逻辑；结尾换行便于与正文分行 */
const SYSTEM_MSG_PREFIX = "[System Message] ";
const SYSTEM_MSG_SUFFIX = "\n";

const STREAM_THROTTLE_MS = 280;

function toSessionId(channelId: string, threadId: string): string {
    return `channel:${channelId}:${threadId}`;
}

/** 节流：在间隔内只执行最后一次 */
function throttle(fn: () => void, ms: number): { run: () => void; flush: () => void; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastRun = 0;
    const run = () => {
        const now = Date.now();
        if (timer) clearTimeout(timer);
        const elapsed = now - lastRun;
        if (elapsed >= ms || lastRun === 0) {
            lastRun = now;
            fn();
        } else {
            timer = setTimeout(() => {
                timer = null;
                lastRun = Date.now();
                fn();
            }, ms - elapsed);
        }
    };
    const flush = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        lastRun = Date.now();
        fn();
    };
    const cancel = () => {
        if (timer) clearTimeout(timer);
        timer = null;
    };
    return { run, flush, cancel };
}

/**
 * 处理一条入站消息：映射 session、跑 Agent、选出站并发送回复。
 * 若 outbound 支持 sendStream，则用流式（先发卡片再逐次更新）；否则一次性 send。
 */
export async function handleChannelMessage(
    channel: IChannel,
    msg: UnifiedMessage
): Promise<void> {
    const sessionId = toSessionId(msg.channelId, msg.threadId);
    const defaultAgentId = channel.defaultAgentId ?? "default";
    // 当前 agent：已存（DB）> 通道默认，保证对话中切换 agent 后下次仍用新 agent
    const persistence = getChannelSessionPersistence();
    const currentAgentId = persistence?.getSession(sessionId)?.agentId ?? defaultAgentId;

    const outbound = channel.getOutboundForMessage
        ? channel.getOutboundForMessage(msg)
        : channel.getOutbounds()[0];
    if (!outbound) {
        console.warn("[ChannelCore] no outbound for message", msg.channelId, msg.threadId);
        return;
    }

    const threadId = msg.threadId;
    if (!threadId || threadId === "default") {
        console.warn("[ChannelCore] invalid threadId, skip reply");
        return;
    }

    const rawMessage = msg.messageText?.trim() ?? "";
    const { message: messageText, agentId: effectiveAgentId, directResponse } = await preprocessInboundMessage({
        sessionId,
        message: rawMessage,
        currentAgentId,
    });
    getSessionCurrentAgentUpdater()?.(sessionId, effectiveAgentId);

    const outlet = getSessionOutlet();
    const channelConsumer: SessionMessageConsumer = {
        send(m: SessionMessage) {
            if (m.type !== "system") return;
            const raw = (m.payload?.text as string) ?? (m.payload?.message as string) ?? (m.payload?.phase as string) ?? "";
            if (raw) {
                const text = SYSTEM_MSG_PREFIX + raw + SYSTEM_MSG_SUFFIX;
                outbound.send(threadId, { text }).catch((e) => console.warn("[ChannelCore] outlet send failed:", e));
            }
        },
    };
    const unregisterConsumer = outlet ? outlet.registerConsumer(sessionId, channelConsumer) : () => {};

    try {
        if (directResponse != null && directResponse !== "") {
            await persistChannelUserMessage(sessionId, {
                agentId: effectiveAgentId,
                title: rawMessage.slice(0, 50) || undefined,
                messageText: rawMessage,
            });
            persistChannelAssistantMessage(sessionId, directResponse);
            sendSessionMessage(sessionId, { type: "system", code: "command.result", payload: { text: directResponse } });
            await msg.ack?.({ text: directResponse });
            return;
        }

        // 与 Web/Desktop 统一：通道会话入库并追加用户消息（用预处理后的 agentId 与消息）
        await persistChannelUserMessage(sessionId, {
            agentId: effectiveAgentId,
            title: messageText.slice(0, 50) || undefined,
            messageText,
        });

        const useStream = typeof (outbound as IOutboundTransport).sendStream === "function";

        if (useStream) {
            let sink: StreamSink;
            try {
                sink = await (outbound as IOutboundTransport).sendStream!(threadId);
            } catch (err) {
                console.error("[ChannelCore] sendStream init failed:", err);
                const reply: UnifiedReply = { text: "发信失败，请稍后再试。" };
                await outbound.send(threadId, reply);
                return;
            }
            let accumulated = "";
            let donePromise: Promise<void> | null = null;
            const throttled = throttle(() => {
                if (sink.onChunk) void Promise.resolve(sink.onChunk(accumulated)).catch((e) => console.error("[ChannelCore] stream onChunk error:", e));
            }, STREAM_THROTTLE_MS);
            try {
                await runAgentAndStreamReply(
                    { sessionId, message: messageText, agentId: effectiveAgentId },
                    {
                        onChunk(delta) {
                            accumulated += delta;
                            throttled.run();
                        },
                        onTurnEnd() {
                            throttled.flush();
                            if (sink.onTurnEnd) void Promise.resolve(sink.onTurnEnd(accumulated)).catch((e) => console.error("[ChannelCore] stream onTurnEnd error:", e));
                        },
                        onDone() {
                            throttled.cancel();
                            const final = accumulated.trim() || "(无文本回复)";
                            persistChannelAssistantMessage(sessionId, final);
                            donePromise = Promise.resolve(sink.onDone(final)).catch((e) => console.error("[ChannelCore] stream onDone error:", e));
                        },
                    }
                );
                if (donePromise) await donePromise;
                await msg.ack?.(undefined);
            } catch (err) {
                console.error("[ChannelCore] runAgent failed:", err);
                throttled.cancel();
                const fallback = accumulated.trim() || "处理时出错，请稍后再试。";
                await Promise.resolve(sink.onDone(fallback)).catch(() => {});
                await msg.ack?.(undefined);
            }
            return;
        }

        let replyText: string;
        try {
            replyText = await runAgentAndCollectReply({
                sessionId,
                message: messageText,
                agentId: effectiveAgentId,
            });
        } catch (err) {
            console.error("[ChannelCore] runAgent failed:", err);
            replyText = "处理时出错，请稍后再试。";
        }
        persistChannelAssistantMessage(sessionId, replyText);
        const reply: UnifiedReply = { text: replyText };
        const sendResult = await outbound.send(threadId, reply);
        await msg.ack?.(sendResult);
    } finally {
        unregisterConsumer();
    }
}
