/**
 * 钉钉通道适配器：使用 dingtalk-stream SDK Stream 模式接收机器人消息，通过 sessionWebhook 回传回复。
 */
import { DWClient, EventAck, TOPIC_ROBOT, type RobotMessage } from "dingtalk-stream";
import type { IChannel, IInboundTransport, IOutboundTransport, UnifiedMessage, UnifiedReply } from "../types.js";
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
 */
class DingTalkWebhookOutbound implements IOutboundTransport {
    private client: DWClient;

    constructor(client: DWClient) {
        this.client = client;
    }

    async send(targetId: string, reply: UnifiedReply): Promise<unknown> {
        const sessionWebhook = sessionWebhookByConversation.get(targetId);
        if (!sessionWebhook) {
            console.error("[DingTalk] send skipped: no sessionWebhook for conversationId", targetId);
            return undefined;
        }
        const text = reply.text?.trim() || "(无内容)";
        try {
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
            const data = await res.json().catch(() => ({}));
            return data;
        } catch (e) {
            console.error("[DingTalk] send message failed:", e);
            throw e;
        }
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
