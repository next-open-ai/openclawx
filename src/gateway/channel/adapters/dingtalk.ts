/**
 * 钉钉通道适配器：使用 dingtalk-stream SDK Stream 模式接收机器人消息，通过 sessionWebhook 回传回复。
 */
import { DWClient, EventAck, TOPIC_ROBOT, type RobotMessage } from "dingtalk-stream";
import type { IChannel, IInboundTransport, IOutboundTransport, StreamSink, UnifiedMessage, UnifiedReply } from "../types.js";
import { dispatchMessage } from "../registry.js";

export interface DingTalkChannelConfig {
    clientId: string;
    clientSecret: string;
    /** 默认绑定的 agentId */
    defaultAgentId?: string;
}

/** conversationId -> sessionWebhook，用于回复时 POST；收到新消息时更新 */
const sessionWebhookByConversation = new Map<string, string>();

/**
 * 钉钉 Stream 入站：DWClient + registerCallbackListener(TOPIC_ROBOT)，解析 RobotMessage 转 UnifiedMessage。
 * 回复发送完成后需调用 ack（socketCallBackResponse）避免钉钉重试。
 */
class DingTalkStreamInbound implements IInboundTransport {
    private client: DWClient;
    private messageHandler: ((msg: UnifiedMessage) => void | Promise<void>) | null = null;

    constructor(client: DWClient) {
        this.client = client;
    }

    setMessageHandler(handler: (msg: UnifiedMessage) => void | Promise<void>): void {
        this.messageHandler = handler;
    }

    async start(): Promise<void> {
        this.client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
            try {
                const data = JSON.parse(res.data) as RobotMessage;
                const conversationId = data.conversationId;
                const sessionWebhook = data.sessionWebhook;
                if (sessionWebhook) {
                    sessionWebhookByConversation.set(conversationId, sessionWebhook);
                }
                const textContent = data.msgtype === "text" && data.text?.content ? data.text.content.trim() : "";
                if (!textContent) return;

                const messageId = res.headers?.messageId ?? "";
                const unified: UnifiedMessage = {
                    channelId: "dingtalk",
                    threadId: conversationId,
                    userId: data.senderStaffId ?? data.senderId ?? "unknown",
                    userName: data.senderNick,
                    messageText: textContent,
                    replyTarget: "default",
                    messageId,
                    raw: data,
                    ack: (sendResult?: unknown) => {
                        if (messageId) {
                            this.client.socketCallBackResponse(messageId, sendResult ?? {});
                        }
                    },
                };
                if (this.messageHandler) {
                    await this.messageHandler(unified);
                } else {
                    await dispatchMessage(unified);
                }
            } catch (e) {
                console.error("[DingTalk] onBotMessage error:", e);
            }
        });
        this.client.registerAllEventListener(() => ({ status: EventAck.SUCCESS }));
        await this.client.connect();
        console.log("[DingTalk] Stream client connected");
    }

    async stop(): Promise<void> {
        try {
            this.client.disconnect();
        } catch (e) {
            console.warn("[DingTalk] disconnect error", e);
        }
    }
}

/**
 * 钉钉出站：通过 sessionWebhook POST 发送文本回复（需 access_token）。
 * 支持 sendStream：按 agent 每轮（turn_end）发一条消息，不拆解最终回答。
 */
class DingTalkWebhookOutbound implements IOutboundTransport {
    private client: DWClient;

    constructor(client: DWClient) {
        this.client = client;
    }

    private async postOne(sessionWebhook: string, text: string): Promise<unknown> {
        const accessToken = await this.client.getAccessToken();
        const body = JSON.stringify({
            msgtype: "text",
            text: { content: text },
        });
        const res = await fetch(sessionWebhook, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-acs-dingtalk-access-token": accessToken,
            },
            body,
        });
        return res.json().catch(() => ({}));
    }

    async send(targetId: string, reply: UnifiedReply): Promise<unknown> {
        const sessionWebhook = sessionWebhookByConversation.get(targetId);
        if (!sessionWebhook) {
            console.error("[DingTalk] send skipped: no sessionWebhook for conversationId", targetId);
            return undefined;
        }
        const text = reply.text?.trim() || "(无内容)";
        try {
            return await this.postOne(sessionWebhook, text);
        } catch (e) {
            console.error("[DingTalk] send message failed:", e);
            throw e;
        }
    }

    async sendStream(targetId: string): Promise<StreamSink> {
        const sessionWebhook = sessionWebhookByConversation.get(targetId);
        if (!sessionWebhook) {
            throw new Error("[DingTalk] sendStream: no sessionWebhook for conversationId " + targetId);
        }
        /** 已发送的字符右边界，[lastSentIndex, accumulated.length) 为未发送 */
        let lastSentIndex = 0;
        /** 串行锁：onTurnEnd 与 onDone 可能不 await，必须顺序执行发送，避免重复发同一段 */
        let sendLock: Promise<void> = Promise.resolve();

        const sendOne = (text: string): Promise<void> => {
            if (!text.trim()) return Promise.resolve();
            return this.postOne(sessionWebhook!, text.trim()).then(
                () => {},
                (e) => {
                    console.error("[DingTalk] sendStream post failed:", e);
                }
            );
        };

        /** 仅发送尚未发送的区间，并推进 lastSentIndex；在锁内执行 */
        const flushPending = (accumulated: string): Promise<void> => {
            const pending = accumulated.slice(lastSentIndex).trim();
            if (!pending) return Promise.resolve();
            return sendOne(pending).then(() => {
                lastSentIndex = accumulated.length;
            });
        };

        return {
            onChunk: async () => {
                // 钉钉按轮发，不按 chunk 发
            },
            onTurnEnd: async (accumulated: string) => {
                sendLock = sendLock.then(() => flushPending(accumulated));
                await sendLock;
            },
            onDone: async (accumulated: string) => {
                const final = accumulated.trim() || "(无内容)";
                sendLock = sendLock.then(() => {
                    const remaining = final.slice(lastSentIndex).trim();
                    if (remaining) {
                        return sendOne(remaining).then(() => {
                            lastSentIndex = final.length;
                        });
                    }
                    if (lastSentIndex === 0) {
                        return sendOne(final).then(() => {
                            lastSentIndex = final.length;
                        });
                    }
                    return Promise.resolve();
                });
                await sendLock;
            },
        };
    }
}

/**
 * 钉钉通道：Stream 入站 + Webhook 出站，共用一个 DWClient。
 */
export function createDingTalkChannel(config: DingTalkChannelConfig): IChannel {
    const { clientId, clientSecret } = config;
    if (!clientId?.trim() || !clientSecret?.trim()) {
        throw new Error("[DingTalk] clientId and clientSecret are required");
    }
    const client = new DWClient({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        debug: false,
    });
    const inbound = new DingTalkStreamInbound(client);
    const outbound = new DingTalkWebhookOutbound(client);

    inbound.setMessageHandler((msg) => dispatchMessage(msg));

    return {
        id: "dingtalk",
        name: "钉钉",
        defaultAgentId: config.defaultAgentId ?? "default",
        getInbounds: () => [inbound],
        getOutbounds: () => [outbound],
    };
}
