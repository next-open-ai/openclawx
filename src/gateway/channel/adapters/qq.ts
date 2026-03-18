/**
 * QQ 频道通道适配器。
 * - 鉴权：使用 appId + appSecret 调用 getAppAccessToken，请求头与 WebSocket 鉴权均使用 QQBot + access_token（官方已禁用固定 Bot Token）。
 * - 入站：自实现 WebSocket 连接 gateway，监听 MESSAGE_CREATE、DIRECT_MESSAGE_CREATE 转为 UnifiedMessage。
 * - 出站：使用 fetch + Authorization: QQBot {access_token} 调用 OpenAPI 发消息。
 */
import type {
    IChannel,
    IInboundTransport,
    IOutboundTransport,
    StreamSink,
    UnifiedMessage,
    UnifiedReply,
} from "../types.js";
import { dispatchMessage } from "../registry.js";
import WebSocket from "ws";

const QQ_GET_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
/** 鉴权头前缀，官方文档：Authorization: QQBot {ACCESS_TOKEN} */
const AUTH_PREFIX = "QQBot ";
/** Access token 提前刷新时间（秒） */
const TOKEN_REFRESH_BEFORE_SEC = 1800;
/** 单条消息最大长度（QQ 限制约 2000 字符） */
const MAX_MESSAGE_LENGTH = 2000;

/** OpCode */
const OpCode = {
    DISPATCH: 0,
    HEARTBEAT: 1,
    IDENTIFY: 2,
    RESUME: 6,
    RECONNECT: 7,
    HELLO: 10,
    HEARTBEAT_ACK: 11,
} as const;

/** 需要的 intents：频道消息 + 私信 + 公域@消息（频道内 @ 机器人） */
const INTENTS_GUILD_MESSAGES = 1 << 9;
const INTENTS_DIRECT_MESSAGE = 1 << 12;
const INTENTS_PUBLIC_GUILD_MESSAGES = 1 << 30;
const INTENTS = INTENTS_GUILD_MESSAGES | INTENTS_DIRECT_MESSAGE | INTENTS_PUBLIC_GUILD_MESSAGES;

export interface QQChannelConfig {
    appId: string;
    /** App Secret，用于 getAppAccessToken；与 QQ 文档 clientSecret 对应 */
    appSecret: string;
    /** 默认绑定的 agentId */
    defaultAgentId?: string;
    /** 是否使用沙箱环境 */
    sandbox?: boolean;
}

/** getAppAccessToken 响应（文档请求参数为 appId + clientSecret） */
interface TokenResponse {
    access_token?: string;
    expires_in?: number;
    code?: number;
    message?: string;
}

function getBaseUrl(sandbox: boolean): string {
    return sandbox ? "https://sandbox.api.sgroup.qq.com" : "https://api.sgroup.qq.com";
}

/** 获取 Access Token；请求体使用 clientSecret（与 QQ 开放平台文档一致） */
async function getAccessToken(appId: string, appSecret: string): Promise<string> {
    const res = await fetch(QQ_GET_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            appId,
            clientSecret: appSecret,
        }),
    });
    const data = (await res.json()) as TokenResponse;
    if (data.access_token) return data.access_token;
    const msg = data.message ?? data.code ?? res.status;
    throw new Error(`[QQ] getAppAccessToken failed: ${msg}`);
}

/** 带 QQBot 鉴权请求 gateway URL */
async function getGatewayUrl(accessToken: string, sandbox: boolean): Promise<{ url: string }> {
    const base = getBaseUrl(sandbox);
    const res = await fetch(`${base}/gateway/bot`, {
        method: "GET",
        headers: {
            Accept: "*/*",
            Authorization: AUTH_PREFIX + accessToken,
        },
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`[QQ] gateway/bot failed: ${res.status} ${body}`);
    }
    const data = (await res.json()) as { url?: string };
    if (!data?.url) throw new Error("[QQ] gateway/bot response missing url");
    return { url: data.url };
}

/** threadId 前缀：g = 频道子频道，d = 私信（DM 的 guild_id） */
const PREFIX_GUILD = "g:";
const PREFIX_DM = "d:";

function toThreadId(channelId: string, isDirect: boolean, dmGuildId?: string): string {
    if (isDirect && dmGuildId) return PREFIX_DM + dmGuildId;
    return PREFIX_GUILD + channelId;
}

function parseThreadId(
    threadId: string
): { type: "guild"; channelId: string } | { type: "dm"; guildId: string } {
    if (threadId.startsWith(PREFIX_DM))
        return { type: "dm", guildId: threadId.slice(PREFIX_DM.length) };
    if (threadId.startsWith(PREFIX_GUILD))
        return { type: "guild", channelId: threadId.slice(PREFIX_GUILD.length) };
    return { type: "guild", channelId: threadId };
}

function truncate(text: string): string {
    if (text.length <= MAX_MESSAGE_LENGTH) return text;
    return text.slice(0, MAX_MESSAGE_LENGTH - 3) + "...";
}

/** 共享的 access_token，供入站刷新、出站发消息 */
interface QQSharedState {
    accessToken: string | null;
}

/**
 * 入站：自实现 WebSocket 连接，使用 QQBot + access_token 鉴权，监听 MESSAGE_CREATE / DIRECT_MESSAGE_CREATE。
 */
class QQWebSocketInbound implements IInboundTransport {
    private config: QQChannelConfig;
    private shared: QQSharedState;
    private messageHandler: ((msg: UnifiedMessage) => void | Promise<void>) | null = null;
    private ws: WebSocket | null = null;
    private tokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private heartbeatIntervalMs = 0;
    private seq: number | null = null;
    private sessionId: string | null = null;

    constructor(config: QQChannelConfig, shared: QQSharedState) {
        this.config = config;
        this.shared = shared;
    }

    setMessageHandler(handler: (msg: UnifiedMessage) => void | Promise<void>): void {
        this.messageHandler = handler;
    }

    private async ensureToken(): Promise<string> {
        if (this.shared.accessToken) return this.shared.accessToken;
        const secret = this.config.appSecret?.trim();
        if (!secret) throw new Error("[QQ] appSecret required");
        this.shared.accessToken = await getAccessToken(this.config.appId, secret);
        return this.shared.accessToken;
    }

    private scheduleTokenRefresh(): void {
        this.tokenRefreshTimer = setInterval(async () => {
            try {
                this.shared.accessToken = null;
                await this.ensureToken();
            } catch (e) {
                console.warn("[QQ] token refresh failed:", (e as Error)?.message);
            }
        }, (7200 - TOKEN_REFRESH_BEFORE_SEC) * 1000);
    }

    private toUnifiedMessage(
        eventType: string,
        msg: {
            channel_id?: string;
            guild_id?: string;
            content?: string;
            author?: { id: string; username?: string };
            id?: string;
        }
    ): UnifiedMessage | null {
        const channelId = msg.channel_id ?? "";
        const guildId = msg.guild_id;
        const isDirect = eventType === "DIRECT_MESSAGE_CREATE";
        const content = (msg.content ?? "").trim();
        if (!content && !msg.id) return null;
        const userId = msg.author?.id ?? "unknown";
        const userName = msg.author?.username;
        const threadId = toThreadId(channelId, isDirect, isDirect ? guildId : undefined);
        return {
            channelId: "qq",
            threadId,
            userId,
            userName,
            messageText: content,
            replyTarget: "default",
            messageId: msg.id,
            raw: msg,
        };
    }

    private dispatch(msg: UnifiedMessage): void {
        const handler = this.messageHandler ?? ((m: UnifiedMessage) => dispatchMessage(m));
        Promise.resolve(handler(msg)).catch((err) => {
            console.error("[QQ] dispatch/reply failed:", (err as Error)?.message ?? err);
        });
    }

    private setupWsHandlers(): void {
        if (!this.ws) return;
        const ws = this.ws;
        let heartbeatAckCount = 0;

        ws.on("message", (data: Buffer) => {
            interface WsFrame {
                op?: number;
                t?: string;
                d?: unknown;
                s?: number;
            }
            let obj: WsFrame | null = null;
            try {
                obj = JSON.parse(data.toString()) as WsFrame;
            } catch {
                return;
            }
            if (!obj) return;

            // 调试：打印每条 QQ 下行帧，确认是否收到任何数据（op=10 HELLO, op=0 DISPATCH, op=11 HEARTBEAT_ACK）
            if (obj.op === OpCode.DISPATCH) {
                console.log("[QQ] WS recv DISPATCH t=%s", obj.t ?? "(无t)");
            } else if (obj.op === OpCode.HEARTBEAT_ACK) {
                heartbeatAckCount += 1;
                if (heartbeatAckCount === 1 || heartbeatAckCount % 20 === 0) {
                    console.log("[QQ] WS recv HEARTBEAT_ACK (count=%d)", heartbeatAckCount);
                }
            } else if (obj.op !== undefined) {
                console.log("[QQ] WS recv op=%s", obj.op);
            }

            const d = obj.d as { heartbeat_interval?: number; session_id?: string } | undefined;
            if (obj.op === OpCode.HELLO && d && typeof d.heartbeat_interval === "number") {
                this.heartbeatIntervalMs = d.heartbeat_interval;
                const token = this.shared.accessToken;
                if (!token) return;
                ws.send(
                    JSON.stringify({
                        op: OpCode.IDENTIFY,
                        d: {
                            token: AUTH_PREFIX + token,
                            intents: INTENTS,
                            shard: [0, 1],
                            properties: { $os: "linux", $browser: "openclawx", $device: "openclawx" },
                        },
                    })
                );
                return;
            }

            if (obj.t === "READY" && d) {
                if (d.session_id) this.sessionId = d.session_id;
                this.seq = obj.s ?? this.seq;
            console.log("[QQ] 鉴权通过。若收不到消息：请在 QQ 频道 内发消息或 @ 机器人（本通道为频道机器人，不支持 QQ 群）");
            this.startHeartbeat();
                return;
            }

            if (obj.op === OpCode.HEARTBEAT_ACK || obj.t === "RESUMED") {
                this.seq = obj.s ?? this.seq;
                this.startHeartbeat();
                return;
            }

            if (obj.op === OpCode.DISPATCH && obj.s != null) {
                this.seq = obj.s;
                const t = obj.t as string | undefined;
                const d = obj.d as Record<string, unknown> | undefined;
                if (!d) return;
                // 调试：所有 DISPATCH 打一条，便于确认 QQ 是否推送了消息类事件
                const isMsg = t === "MESSAGE_CREATE" || t === "AT_MESSAGE_CREATE" || t === "DIRECT_MESSAGE_CREATE";
                if (isMsg) {
                    console.log("[QQ] DISPATCH t=%s keys=%s", t, Object.keys(d).join(","));
                }
                // QQ 部分接口可能把消息放在 d.msg 或 d.message 里，优先取一层
                const rawPayload = d;
                const msgPayload = (rawPayload.msg ?? rawPayload.message ?? rawPayload) as Parameters<QQWebSocketInbound["toUnifiedMessage"]>[1];
                if (t === "MESSAGE_CREATE") {
                    const unified = this.toUnifiedMessage("MESSAGE_CREATE", msgPayload);
                    if (unified) {
                        console.log("[QQ] message received, threadId=%s", unified.threadId);
                        this.dispatch(unified);
                    } else {
                        console.log("[QQ] MESSAGE_CREATE skipped: content=%s channel_id=%s", String(msgPayload?.content ?? "").slice(0, 50), msgPayload?.channel_id);
                    }
                } else if (t === "AT_MESSAGE_CREATE") {
                    const unified = this.toUnifiedMessage("MESSAGE_CREATE", msgPayload);
                    if (unified) {
                        console.log("[QQ] @message received, threadId=%s", unified.threadId);
                        this.dispatch(unified);
                    } else {
                        console.log("[QQ] AT_MESSAGE_CREATE skipped: content=%s channel_id=%s", String(msgPayload?.content ?? "").slice(0, 50), msgPayload?.channel_id);
                    }
                } else if (t === "DIRECT_MESSAGE_CREATE") {
                    const unified = this.toUnifiedMessage("DIRECT_MESSAGE_CREATE", msgPayload);
                    if (unified) {
                        console.log("[QQ] DM received, threadId=%s", unified.threadId);
                        this.dispatch(unified);
                    } else {
                        console.log("[QQ] DIRECT_MESSAGE_CREATE skipped: content=%s guild_id=%s", String(msgPayload?.content ?? "").slice(0, 50), msgPayload?.guild_id);
                    }
                }
            }
        });

        ws.on("close", (code: number, reason: Buffer) => {
            console.warn("[QQ] WebSocket 关闭 code=%s reason=%s", code, reason?.toString() || "");
            this.stopHeartbeat();
        });

        ws.on("error", (err) => {
            console.warn("[QQ] WebSocket error:", (err as Error)?.message);
        });
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        if (this.heartbeatIntervalMs <= 0 || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.heartbeatTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ op: OpCode.HEARTBEAT, d: this.seq }));
            }
        }, this.heartbeatIntervalMs);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    async start(): Promise<void> {
        const { appId, appSecret, sandbox } = this.config;
        if (!appId?.trim() || !appSecret?.trim()) {
            console.warn("[QQ] appId and appSecret required; skip start.");
            return;
        }
        try {
            console.log("[QQ] using getAppAccessToken + QQBot auth. If 401: check IP whitelist in QQ console (开发设置→IP白名单).");
            const accessToken = await this.ensureToken();
            this.scheduleTokenRefresh();

            const { url } = await getGatewayUrl(accessToken, !!sandbox);
            this.ws = new WebSocket(url);
            this.setupWsHandlers();
            console.log("[QQ] WebSocket 已连接。在 QQ 频道 发消息或 @ 机器人后，此处应出现 [QQ] WS recv DISPATCH t=MESSAGE_CREATE 或 AT_MESSAGE_CREATE；若无，请检查机器人是否已加入该子频道且具有「读消息」权限。");
        } catch (e) {
            console.warn("[QQ] WebSocket start failed:", (e as Error)?.message);
        }
    }

    async stop(): Promise<void> {
        this.stopHeartbeat();
        if (this.tokenRefreshTimer) {
            clearInterval(this.tokenRefreshTimer);
            this.tokenRefreshTimer = null;
        }
        if (this.ws) {
            try {
                this.ws.close();
            } catch (_) {}
            this.ws = null;
        }
        this.shared.accessToken = null;
        this.sessionId = null;
        this.seq = null;
    }
}

/**
 * 出站：使用 fetch + QQBot access_token 调用 OpenAPI 发消息。
 */
class QQApiOutbound implements IOutboundTransport {
    private config: QQChannelConfig;
    private getToken: () => string | null;

    constructor(config: QQChannelConfig, getToken: () => string | null) {
        this.config = config;
        this.getToken = getToken;
    }

    private async openApiPost(path: string, body: Record<string, unknown>): Promise<unknown> {
        const token = this.getToken();
        if (!token) throw new Error("[QQ] AccessToken not ready");
        const base = getBaseUrl(!!this.config.sandbox);
        const res = await fetch(`${base}${path}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: AUTH_PREFIX + token,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`[QQ] OpenAPI ${path}: ${res.status} ${text}`);
        }
        return res.json();
    }

    async send(targetId: string, reply: UnifiedReply): Promise<unknown> {
        const text = reply.text?.trim() || "(无内容)";
        const parsed = parseThreadId(targetId);
        if (parsed.type === "dm") {
            return this.openApiPost(`/dms/${parsed.guildId}/messages`, { content: truncate(text) });
        }
        return this.openApiPost(`/channels/${parsed.channelId}/messages`, { content: truncate(text) });
    }

    async sendStream(targetId: string): Promise<StreamSink> {
        const parsed = parseThreadId(targetId);
        const postOne = async (content: string) => {
            if (parsed.type === "dm") {
                return this.openApiPost(`/dms/${parsed.guildId}/messages`, { content: truncate(content) });
            }
            return this.openApiPost(`/channels/${parsed.channelId}/messages`, { content: truncate(content) });
        };
        try {
            await postOne("…");
        } catch (e) {
            console.error("[QQ] sendStream init (placeholder) failed:", (e as Error)?.message ?? e);
            throw e;
        }
        return {
            onChunk: async () => {},
            onTurnEnd: async () => {},
            onDone: async (acc) => {
                try {
                    await postOne(acc.trim() || "(无内容)");
                    console.log("[QQ] reply sent, targetId=%s", targetId);
                } catch (e) {
                    console.error("[QQ] stream onDone failed:", (e as Error)?.message ?? e);
                }
            },
        };
    }
}

/**
 * QQ 通道：自实现 WebSocket 入站（QQBot 鉴权）+ fetch 出站；threadId 格式 g:channelId（频道）或 d:guildId（私信）。
 */
export function createQQChannel(config: QQChannelConfig): IChannel {
    const shared: QQSharedState = { accessToken: null };
    const inbound = new QQWebSocketInbound(config, shared);
    const outbound = new QQApiOutbound(config, () => shared.accessToken);

    inbound.setMessageHandler((msg) => dispatchMessage(msg));

    return {
        id: "qq",
        name: "QQ",
        defaultAgentId: config.defaultAgentId ?? "default",
        getInbounds: () => [inbound],
        getOutbounds: () => [outbound],
    };
}
