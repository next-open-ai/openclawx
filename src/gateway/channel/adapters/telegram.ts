/**
 * Telegram 通道适配器：长轮询（getUpdates）接收消息，sendMessage / editMessageText 发送与流式更新。
 * 桌面端无公网 URL 时用 long polling 是官方推荐方式；支持流式输出（先发占位再 editMessageText 更新）。
 */
import type { IChannel, IInboundTransport, IOutboundTransport, StreamSink, UnifiedMessage, UnifiedReply } from "../types.js";
import { dispatchMessage } from "../registry.js";

const TELEGRAM_API_BASE = "https://api.telegram.org/bot";
/** getUpdates 长轮询等待秒数（1–50） */
const LONG_POLL_TIMEOUT = 25;
/** 单条消息/编辑最大长度 */
const MAX_MESSAGE_LENGTH = 4096;

export interface TelegramChannelConfig {
    botToken: string;
    /** 默认绑定的 agentId */
    defaultAgentId?: string;
}

/** Telegram Update 中 message 结构（仅用到的字段） */
interface TgMessage {
    message_id: number;
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
    chat: { id: number; type?: string };
    text?: string;
}

interface TgUpdate {
    update_id: number;
    message?: TgMessage;
    edited_message?: TgMessage;
}

interface TgApiResponse<T = unknown> {
    ok: boolean;
    result?: T;
    description?: string;
}

function apiUrl(token: string, method: string): string {
    return `${TELEGRAM_API_BASE}${encodeURIComponent(token)}/${method}`;
}

async function telegramGet<T>(token: string, method: string, params: Record<string, string | number> = {}): Promise<TgApiResponse<T>> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
    const url = `${apiUrl(token, method)}?${q.toString()}`;
    const res = await fetch(url, { method: "GET" });
    return res.json() as Promise<TgApiResponse<T>>;
}

async function telegramPost<T>(token: string, method: string, body: Record<string, unknown>): Promise<TgApiResponse<T>> {
    const res = await fetch(apiUrl(token, method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return res.json() as Promise<TgApiResponse<T>>;
}

function truncateForTelegram(text: string): string {
    if (text.length <= MAX_MESSAGE_LENGTH) return text;
    return text.slice(0, MAX_MESSAGE_LENGTH - 3) + "...";
}

/**
 * 入站：长轮询 getUpdates，收到 message/edited_message 后转 UnifiedMessage 并分发。
 */
/** 轮询错误日志节流：同一类错误至少间隔此毫秒数再打印，避免刷屏 */
const TELEGRAM_POLL_ERROR_LOG_INTERVAL_MS = 60_000;

class TelegramLongPollInbound implements IInboundTransport {
    private config: TelegramChannelConfig;
    private messageHandler: ((msg: UnifiedMessage) => void | Promise<void>) | null = null;
    private stopped = false;
    private lastOffset = 0;
    private lastPollErrorLogTime = 0;

    constructor(config: TelegramChannelConfig) {
        this.config = config;
    }

    setMessageHandler(handler: (msg: UnifiedMessage) => void | Promise<void>): void {
        this.messageHandler = handler;
    }

    async start(): Promise<void> {
        const token = this.config.botToken?.trim();
        if (!token) {
            console.warn("[Telegram] botToken missing, skip long poll start");
            return;
        }
        this.stopped = false;
        this.lastOffset = 0;
        const poll = async () => {
            while (!this.stopped) {
                try {
                    const resp = await telegramGet<TgUpdate[]>(token, "getUpdates", {
                        offset: this.lastOffset,
                        timeout: LONG_POLL_TIMEOUT,
                    });
                    if (!resp.ok || !Array.isArray(resp.result)) {
                        if (resp.description) console.warn("[Telegram] getUpdates error:", resp.description);
                        await new Promise((r) => setTimeout(r, 1000));
                        continue;
                    }
                    for (const update of resp.result) {
                        if (update.update_id >= this.lastOffset) this.lastOffset = update.update_id + 1;
                        const msg = update.message ?? update.edited_message;
                        if (!msg?.text?.trim() || !msg.chat?.id) continue;
                        const from = msg.from;
                        const userId = from?.id != null ? String(from.id) : "unknown";
                        const userName = [from?.first_name, from?.last_name].filter(Boolean).join(" ").trim() || from?.username;
                        const unified: UnifiedMessage = {
                            channelId: "telegram",
                            threadId: String(msg.chat.id),
                            userId,
                            userName: userName || undefined,
                            messageText: msg.text.trim(),
                            replyTarget: "default",
                            messageId: String(msg.message_id),
                            raw: msg,
                        };
                        if (this.messageHandler) {
                            await this.messageHandler(unified);
                        } else {
                            await dispatchMessage(unified);
                        }
                    }
                } catch (e: any) {
                    if (!this.stopped) {
                        const now = Date.now();
                        if (now - this.lastPollErrorLogTime >= TELEGRAM_POLL_ERROR_LOG_INTERVAL_MS) {
                            this.lastPollErrorLogTime = now;
                            const cause = e?.cause?.code === "UND_ERR_CONNECT_TIMEOUT"
                                ? " (api.telegram.org 连接超时，可能需代理或网络不可达，将继续重试)"
                                : "";
                            console.warn("[Telegram] long poll error:", e?.message ?? e, cause);
                        }
                    }
                    await new Promise((r) => setTimeout(r, 2000));
                }
            }
        };
        void poll();
        console.log("[Telegram] long poll started");
    }

    async stop(): Promise<void> {
        this.stopped = true;
    }
}

/**
 * 出站：sendMessage 一次性发送；sendStream 先发占位再 editMessageText 流式更新（真流式）。
 */
class TelegramApiOutbound implements IOutboundTransport {
    private config: TelegramChannelConfig;

    constructor(config: TelegramChannelConfig) {
        this.config = config;
    }

    private getToken(): string {
        const t = this.config.botToken?.trim();
        if (!t) throw new Error("[Telegram] botToken required");
        return t;
    }

    async send(targetId: string, reply: UnifiedReply): Promise<unknown> {
        const text = reply.text?.trim() || "(无内容)";
        const resp = await telegramPost<{ message_id: number }>(this.getToken(), "sendMessage", {
            chat_id: targetId,
            text: truncateForTelegram(text),
        });
        if (!resp.ok) throw new Error(resp.description ?? "Telegram sendMessage failed");
        return resp.result;
    }

    async sendStream(targetId: string): Promise<StreamSink> {
        const token = this.getToken();
        const placeholder = "…";
        const createResp = await telegramPost<{ message_id: number }>(token, "sendMessage", {
            chat_id: targetId,
            text: placeholder,
        });
        if (!createResp.ok || createResp.result?.message_id == null) {
            throw new Error(createResp.description ?? "Telegram sendMessage (stream placeholder) failed");
        }
        const messageId = createResp.result.message_id;
        const chatId = targetId;

        const edit = async (content: string) => {
            const body = truncateForTelegram(content || " ");
            const r = await telegramPost(token, "editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: body,
            });
            if (!r.ok && r.description?.includes("message is not modified")) return;
            if (!r.ok) console.error("[Telegram] editMessageText failed:", r.description);
        };

        return {
            onChunk: async (accumulated: string) => {
                try {
                    await edit(accumulated + " ▌");
                } catch (e) {
                    console.error("[Telegram] stream edit failed:", e);
                }
            },
            onTurnEnd: async (accumulated: string) => {
                try {
                    await edit(accumulated || " ");
                } catch (e) {
                    console.error("[Telegram] stream onTurnEnd edit failed:", e);
                }
            },
            onDone: async (accumulated: string) => {
                try {
                    await edit(accumulated.trim() || "(无内容)");
                } catch (e) {
                    console.error("[Telegram] stream onDone edit failed:", e);
                }
            },
        };
    }
}

/**
 * Telegram 通道：长轮询入站 + API 出站，支持流式（editMessageText）。
 */
export function createTelegramChannel(config: TelegramChannelConfig): IChannel {
    const inbound = new TelegramLongPollInbound(config);
    const outbound = new TelegramApiOutbound(config);

    inbound.setMessageHandler((msg) => dispatchMessage(msg));

    return {
        id: "telegram",
        name: "Telegram",
        defaultAgentId: config.defaultAgentId ?? "default",
        getInbounds: () => [inbound],
        getOutbounds: () => [outbound],
    };
}
