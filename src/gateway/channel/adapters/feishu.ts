/**
 * 飞书通道适配器：使用 @larksuiteoapi/node-sdk WebSocket 长连接模式接收消息，API 发送回复。
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import type { IChannel, IInboundTransport, IOutboundTransport, UnifiedMessage, UnifiedReply, StreamSink } from "../types.js";
import { dispatchMessage } from "../registry.js";

export interface FeishuChannelConfig {
    appId: string;
    appSecret: string;
    /** 默认绑定的 agentId */
    defaultAgentId?: string;
}

function parseFeishuTextContent(content: string): string {
    try {
        const obj = JSON.parse(content);
        if (obj && typeof obj.text === "string") return obj.text;
        return String(content);
    } catch {
        return String(content);
    }
}

/** 已处理的飞书 message_id 缓存，避免同一条消息被重复触发导致多条回复与顺序错乱。TTL 5 分钟。 */
const PROCESSED_MESSAGE_IDS = new Map<string, number>();
const PROCESSED_TTL_MS = 5 * 60 * 1000;

function isMessageAlreadyProcessed(messageId: string): boolean {
    const now = Date.now();
    if (PROCESSED_MESSAGE_IDS.has(messageId)) {
        const ts = PROCESSED_MESSAGE_IDS.get(messageId)!;
        if (now - ts < PROCESSED_TTL_MS) return true;
        PROCESSED_MESSAGE_IDS.delete(messageId);
    }
    return false;
}

function markMessageProcessed(messageId: string): void {
    const now = Date.now();
    PROCESSED_MESSAGE_IDS.set(messageId, now);
    if (PROCESSED_MESSAGE_IDS.size > 5000) {
        for (const [id, ts] of PROCESSED_MESSAGE_IDS.entries()) {
            if (now - ts > PROCESSED_TTL_MS) PROCESSED_MESSAGE_IDS.delete(id);
        }
    }
}

/**
 * 飞书 WebSocket 入站：SDK WSClient + EventDispatcher，收到 im.message.receive_v1 后转 UnifiedMessage。
 * 按 message_id 去重，同一条用户消息只处理一次，避免重复回复与顺序错乱。
 */
class FeishuWSInbound implements IInboundTransport {
    private config: FeishuChannelConfig;
    private wsClient: Lark.WSClient | null = null;
    private messageHandler: ((msg: UnifiedMessage) => void | Promise<void>) | null = null;

    constructor(config: FeishuChannelConfig) {
        this.config = config;
    }

    setMessageHandler(handler: (msg: UnifiedMessage) => void | Promise<void>): void {
        this.messageHandler = handler;
    }

    async start(): Promise<void> {
        if (this.wsClient) return;
        const { appId, appSecret } = this.config;
        if (!appId?.trim() || !appSecret?.trim()) {
            console.warn("[Feishu] appId/appSecret missing, skip WS start");
            return;
        }
        const eventDispatcher = new Lark.EventDispatcher({}).register({
            "im.message.receive_v1": async (data: any) => {
                const msg = data?.message;
                if (!msg?.chat_id) return;
                const messageId = msg?.message_id;
                if (messageId && isMessageAlreadyProcessed(messageId)) {
                    return;
                }
                if (messageId) markMessageProcessed(messageId);
                const content = msg.content ? parseFeishuTextContent(msg.content) : "";
                if (!content.trim()) return;
                const sender = data?.sender?.sender_id?.open_id ?? data?.sender?.sender_id?.user_id ?? "";
                const unified: UnifiedMessage = {
                    channelId: "feishu",
                    threadId: msg.chat_id,
                    userId: sender || "unknown",
                    userName: data?.sender?.sender_id?.name,
                    messageText: content,
                    replyTarget: "default",
                    messageId,
                    raw: data,
                };
                if (this.messageHandler) {
                    await this.messageHandler(unified);
                } else {
                    await dispatchMessage(unified);
                }
            },
        });
        this.wsClient = new Lark.WSClient({
            appId,
            appSecret,
            loggerLevel: Lark.LoggerLevel.warn,
        });
        await this.wsClient.start({ eventDispatcher });
        console.log("[Feishu] WS client started");
    }

    async stop(): Promise<void> {
        if (this.wsClient) {
            try {
                await (this.wsClient as any).stop?.();
            } catch (e) {
                console.warn("[Feishu] WS stop error", e);
            }
            this.wsClient = null;
        }
    }
}

/**
 * 飞书 API 出站：用 Client 调发送消息接口。
 */
class FeishuApiOutbound implements IOutboundTransport {
    private client: Lark.Client;

    constructor(config: FeishuChannelConfig) {
        this.client = new Lark.Client({
            appId: config.appId,
            appSecret: config.appSecret,
            appType: Lark.AppType.SelfBuild,
            domain: Lark.Domain.Feishu,
        });
    }

    async send(targetId: string, reply: UnifiedReply): Promise<void> {
        if (!targetId || targetId === "default") {
            console.error("[Feishu] send skipped: invalid receive_id (missing or 'default'), check threadId from event");
            return;
        }
        const text = reply.text?.trim() || "(无内容)";
        try {
            await this.client.im.v1.message.create({
                params: { receive_id_type: "chat_id" },
                data: {
                    receive_id: targetId,
                    content: JSON.stringify({ text }),
                    msg_type: "text",
                },
            });
        } catch (e) {
            console.error("[Feishu] send message failed:", e);
            throw e;
        }
    }

    async sendStream(targetId: string): Promise<StreamSink> {
        if (!targetId || targetId === "default") {
            throw new Error("[Feishu] sendStream: invalid receive_id");
        }
        const initialCard = {
            config: { wide_screen_mode: true },
            header: { title: { tag: "plain_text", content: "🤔 思考中..." } },
            elements: [{ tag: "div", text: { tag: "plain_text", content: "正在生成回答，请稍候..." } }],
        };
        const createRes = await this.client.im.v1.message.create({
            params: { receive_id_type: "chat_id" },
            data: {
                receive_id: targetId,
                msg_type: "interactive",
                content: JSON.stringify(initialCard),
            },
        });
        const messageId = (createRes as any).data?.message_id;
        if (!messageId) {
            throw new Error("[Feishu] sendStream: create card did not return message_id");
        }
        const patch = async (content: string, title: string, showCursor: boolean) => {
            const card = {
                config: { wide_screen_mode: true },
                header: { title: { tag: "plain_text", content: title } },
                elements: [{ tag: "markdown", content: content + (showCursor ? " ▌" : "") }],
            };
            await this.client.im.v1.message.patch({
                path: { message_id: messageId },
                data: { content: JSON.stringify(card) },
            });
        };
        return {
            onChunk: async (accumulated: string) => {
                try {
                    await patch(accumulated || " ", "🤖 回答中...", true);
                } catch (e) {
                    console.error("[Feishu] stream patch failed:", e);
                }
            },
            onDone: async (accumulated: string) => {
                try {
                    await patch(accumulated || "(无内容)", "✅ 回答完成", false);
                } catch (e) {
                    console.error("[Feishu] stream final patch failed:", e);
                }
            },
        };
    }
}

/**
 * 飞书通道：WebSocket 入站 + API 出站，使用官方 Node SDK。
 */
export function createFeishuChannel(config: FeishuChannelConfig): IChannel {
    const inbound = new FeishuWSInbound(config);
    const outbound = new FeishuApiOutbound(config);

    // 入站回调统一走 registry 分发（会带上 channelId，找到本 channel 再处理）
    inbound.setMessageHandler((msg) => dispatchMessage(msg));

    return {
        id: "feishu",
        name: "飞书",
        defaultAgentId: config.defaultAgentId ?? "default",
        getInbounds: () => [inbound],
        getOutbounds: () => [outbound],
    };
}
