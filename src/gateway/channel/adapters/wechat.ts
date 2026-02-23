/**
 * 微信通道适配器：使用 Wechaty（Web/UOS 协议）接收消息，say() 发送回复。
 * 不支持流式（微信无法编辑已发消息），回复在 agent_end 后一次性发送。
 * 扫码：scan 事件产生二维码 URL，经 qrcode 库生成 base64 供前端展示。
 */
import type { IChannel, IInboundTransport, IOutboundTransport, UnifiedMessage, UnifiedReply } from "../types.js";
import { dispatchMessage } from "../registry.js";

export interface WechatChannelConfig {
    /** Puppet 名称，缺省使用 Wechaty 自带 puppet */
    puppet?: string;
    /** 默认绑定的 agentId */
    defaultAgentId?: string;
}

/* ---------- 模块级状态：供 Gateway API 查询 ---------- */

type WechatLoginStatus = "scanning" | "logged_in" | "logged_out";

let currentQrCodeBase64: string | null = null;
let currentLoginStatus: WechatLoginStatus = "logged_out";
let currentUserName: string | null = null;

/** 供 Gateway API 查询当前二维码（base64 Data URL 或 null） */
export function getWechatQrCode(): string | null {
    return currentQrCodeBase64;
}

/** 供 Gateway API 查询登录状态 */
export function getWechatStatus(): { status: WechatLoginStatus; userName: string | null } {
    return { status: currentLoginStatus, userName: currentUserName };
}

/** 重启 Wechaty 以刷新二维码（二维码过期后调用） */
export async function refreshWechatQrCode(): Promise<void> {
    if (currentLoginStatus === "logged_in") return; // 已登录无需刷新
    if (!wechatyBot) return; // bot 不存在
    console.log("[WeChat] Refreshing QR code by restarting bot...");
    currentQrCodeBase64 = null;
    currentLoginStatus = "logged_out";
    currentUserName = null;
    try {
        await wechatyBot.stop();
        await wechatyBot.start();
        console.log("[WeChat] Bot restarted for QR refresh");
    } catch (e) {
        console.error("[WeChat] Refresh failed:", e);
    }
}

/* ---------- Wechaty 实例引用 ---------- */

let wechatyBot: any = null;

/* ---------- Inbound ---------- */

class WechatInbound implements IInboundTransport {
    private config: WechatChannelConfig;
    private messageHandler: ((msg: UnifiedMessage) => void | Promise<void>) | null = null;
    private stopped = false;

    constructor(config: WechatChannelConfig) {
        this.config = config;
    }

    setMessageHandler(handler: (msg: UnifiedMessage) => void | Promise<void>): void {
        this.messageHandler = handler;
    }

    async start(): Promise<void> {
        this.stopped = false;
        currentLoginStatus = "logged_out";
        currentQrCodeBase64 = null;
        currentUserName = null;

        try {
            // 动态导入 wechaty 和 qrcode（ESM）
            const { WechatyBuilder } = await import("wechaty");
            const QRCode = await import("qrcode");

            const opts: Record<string, any> = { name: "openclawx-wechat" };
            if (this.config.puppet) {
                opts.puppet = this.config.puppet;
            }

            const builder = WechatyBuilder.build(opts);

            wechatyBot = builder;

            builder.on("scan", async (qrcode: string, status: number) => {
                if (this.stopped) return;
                console.log(`[WeChat] Scan event, status=${status}, qrcode=${qrcode ? 'present(' + qrcode.length + ' chars)' : 'empty'}`);
                // Status: 0=Unknown, 2=WaitingForScan, 3=WaitingForConfirm, 4=Cancelled, 5=Expired
                if (status === 4 || status === 5) {
                    // QR code expired or cancelled
                    currentQrCodeBase64 = null;
                    currentLoginStatus = "logged_out";
                    console.log("[WeChat] QR code expired or cancelled");
                    return;
                }
                if (qrcode) {
                    try {
                        currentQrCodeBase64 = await (QRCode as any).toDataURL(qrcode, { width: 256 });
                        currentLoginStatus = "scanning";
                        console.log("[WeChat] QR code generated successfully, waiting for scan...");
                    } catch (e) {
                        console.error("[WeChat] QR code generation failed:", e);
                    }
                } else {
                    console.log("[WeChat] Scan event without qrcode data, status:", status);
                }
            });

            builder.on("login", (user: any) => {
                currentLoginStatus = "logged_in";
                currentQrCodeBase64 = null;
                currentUserName = user?.name?.() || user?.payload?.name || String(user);
                console.log(`[WeChat] Logged in as: ${currentUserName}`);
            });

            builder.on("logout", (user: any) => {
                currentLoginStatus = "logged_out";
                currentQrCodeBase64 = null;
                currentUserName = null;
                console.log("[WeChat] Logged out:", user?.name?.() || user);
            });

            builder.on("message", async (message: any) => {
                if (this.stopped) return;
                try {
                    const isSelf = await message.self?.();
                    if (isSelf) return;

                    const text = (await message.text?.())?.trim?.() || message.text?.trim?.() || '';
                    if (!text) return;

                    console.log(`[WeChat] Received: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);

                    const talker = message.talker?.() ?? message.from?.();
                    const room = await message.room?.();

                    const talkerId = talker?.id || "unknown";
                    const talkerName = (await talker?.name?.()) || talker?.name || undefined;
                    const roomId = room?.id;
                    const threadId = room ? (roomId || String(await room.topic?.())) : talkerId;

                    const unified: UnifiedMessage = {
                        channelId: "wechat",
                        threadId: String(threadId),
                        userId: String(talkerId),
                        userName: typeof talkerName === 'string' ? talkerName : undefined,
                        messageText: text,
                        replyTarget: String(threadId),
                        raw: { roomId, talkerId },
                    };

                    if (this.messageHandler) {
                        await this.messageHandler(unified);
                    } else {
                        await dispatchMessage(unified);
                    }
                    console.log("[WeChat] message dispatched");
                } catch (e) {
                    console.error("[WeChat] message handler error:", e);
                }
            });

            builder.on("error", (e: any) => {
                console.error("[WeChat] bot error:", e?.message || e);
            });

            await builder.start();
            console.log("[WeChat] Wechaty bot started, waiting for scan...");
        } catch (e) {
            console.error("[WeChat] Failed to start Wechaty bot:", e);
            currentLoginStatus = "logged_out";
        }
    }

    async stop(): Promise<void> {
        this.stopped = true;
        currentLoginStatus = "logged_out";
        currentQrCodeBase64 = null;
        currentUserName = null;
        if (wechatyBot) {
            try {
                await wechatyBot.stop();
            } catch (e) {
                console.warn("[WeChat] stop error:", e);
            }
            wechatyBot = null;
        }
    }
}

/* ---------- Outbound ---------- */

class WechatOutbound implements IOutboundTransport {
    async send(targetId: string, reply: UnifiedReply): Promise<unknown> {
        if (!wechatyBot) {
            console.warn("[WeChat] bot not started, cannot send");
            return;
        }
        const text = reply.text?.trim() || "(无内容)";

        try {
            // 先尝试作为 Room（群聊）发送
            const room = await wechatyBot.Room?.find?.({ id: targetId });
            if (room) {
                await room.say(text);
                return { sent: true, type: "room", id: targetId };
            }

            // 否则作为 Contact（私聊）发送
            const contact = await wechatyBot.Contact?.find?.({ id: targetId });
            if (contact) {
                await contact.say(text);
                return { sent: true, type: "contact", id: targetId };
            }

            console.warn("[WeChat] cannot find room or contact for targetId:", targetId);
            return { sent: false, reason: "target not found" };
        } catch (e) {
            console.error("[WeChat] send failed:", e);
            throw e;
        }
    }

    // 不实现 sendStream：微信不支持编辑已发送消息
}

/* ---------- Channel 工厂 ---------- */

export function createWechatChannel(config: WechatChannelConfig): IChannel {
    const inbound = new WechatInbound(config);
    const outbound = new WechatOutbound();

    inbound.setMessageHandler((msg) => dispatchMessage(msg));

    return {
        id: "wechat",
        name: "WeChat",
        defaultAgentId: config.defaultAgentId ?? "default",
        getInbounds: () => [inbound],
        getOutbounds: () => [outbound],
    };
}
