/**
 * Coze AgentProxy 适配器：通过 Coze 开放 API 与 Bot 对话。
 * - 国际站：https://api.coze.com（默认）
 * - 国内站：在智能体配置中填写 endpoint 为 https://api.coze.cn
 * 参考：https://www.coze.com/docs/developer_guides/chat_api、https://www.coze.cn/open/docs/developer_guides/chat_api
 */
import type { DesktopAgentConfig } from "../../../config/desktop-config.js";
import type {
    IAgentProxyAdapter,
    RunAgentForChannelOptions,
    RunAgentStreamCallbacks,
} from "../types.js";

const COZE_ENDPOINT_COM = "https://api.coze.com";
const COZE_ENDPOINT_CN = "https://api.coze.cn";
const REQUEST_TIMEOUT_MS = 120_000;

function getCozeConfig(config: DesktopAgentConfig): { botId: string; apiKey: string; baseUrl: string; region: "cn" | "com" } | null {
    const coze = config.coze;
    if (!coze?.botId?.trim() || !coze?.apiKey?.trim()) {
        console.warn(
            `[Coze] getCozeConfig: missing coze config (hasCoze=${!!coze}, hasBotId=${!!coze?.botId?.trim()}, hasApiKey=${!!coze?.apiKey?.trim()})`
        );
        return null;
    }
    const explicitEndpoint = coze.endpoint?.trim();
    const region = coze.region === "cn" ? "cn" : "com";
    const defaultBase = region === "cn" ? COZE_ENDPOINT_CN : COZE_ENDPOINT_COM;
    const baseUrl = (explicitEndpoint || defaultBase).replace(/\/$/, "");
    const apiKey = coze.apiKey.trim();
    console.log(`[Coze] getCozeConfig: botId=${coze.botId.trim()}, region=${region}, baseUrl=${baseUrl}`);
    return { botId: coze.botId.trim(), apiKey, baseUrl, region };
}

/** 国内站常见内部事件：不当作正文展示 */
const COZE_INTERNAL_MSG_TYPES = new Set([
    "empty result",
    "generate_answer_finish",
]);

/** 若字符串明显是内部协议 JSON（不应展示给用户），返回 true */
function looksLikeInternalJson(s: string): boolean {
    const t = s.trim();
    if (t.startsWith("{")) {
        if (t.includes('"msg_type"') || t.includes("from_module") || t.includes("generate_answer_finish")) return true;
    }
    return false;
}

/** 从 Coze 流式 SSE 的 data 行 JSON 中解析出文本 delta（兼容国际站/国内站 v3） */
function parseCozeStreamLine(data: string): string | null {
    const trimmed = data.trim();
    if (!trimmed || trimmed === "[DONE]" || trimmed === "[done]") return null;
    try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const msgType = parsed.msg_type as string | undefined;
        if (msgType != null && COZE_INTERNAL_MSG_TYPES.has(String(msgType).toLowerCase())) return null;

        const d = parsed.data as Record<string, unknown> | undefined;
        if (d && typeof d.content === "string") {
            if (!looksLikeInternalJson(d.content)) return d.content;
            return null;
        }
        if (d && typeof (d as { delta?: string }).delta === "string") {
            const v = (d as { delta: string }).delta;
            if (!looksLikeInternalJson(v)) return v;
            return null;
        }
        if (d && (d as { delta?: { content?: string } }).delta?.content != null) {
            const v = String((d as { delta: { content: string } }).delta.content);
            if (!looksLikeInternalJson(v)) return v;
            return null;
        }
        const dataMsg = d?.message as Record<string, unknown> | undefined;
        if (dataMsg && typeof dataMsg.content === "string") {
            if (!looksLikeInternalJson(dataMsg.content)) return dataMsg.content;
            return null;
        }
        const msg = parsed.message as Record<string, unknown> | undefined;
        if (msg && typeof msg.content === "string") {
            if (!looksLikeInternalJson(msg.content)) return msg.content;
            return null;
        }
        if (typeof parsed.content === "string") {
            const v = parsed.content;
            if (!looksLikeInternalJson(v)) return v;
            return null;
        }
        if (typeof (parsed as { delta?: string }).delta === "string") {
            const v = (parsed as { delta: string }).delta;
            if (!looksLikeInternalJson(v)) return v;
            return null;
        }
        if ((parsed as { delta?: { content?: string } }).delta?.content != null) {
            const v = String((parsed as { delta: { content: string } }).delta.content);
            if (!looksLikeInternalJson(v)) return v;
            return null;
        }
        if (parsed.type === "answer" && typeof (parsed as { content?: string }).content === "string") {
            const v = (parsed as { content: string }).content;
            if (!looksLikeInternalJson(v)) return v;
            return null;
        }
        if (typeof (parsed as { answer?: string }).answer === "string") {
            const v = (parsed as { answer: string }).answer;
            if (!looksLikeInternalJson(v)) return v;
            return null;
        }
        if (typeof (parsed as { text?: string }).text === "string") {
            const v = (parsed as { text: string }).text;
            if (!looksLikeInternalJson(v)) return v;
            return null;
        }
        if (d && typeof (d as { text?: string }).text === "string") {
            const v = (d as { text: string }).text;
            if (!looksLikeInternalJson(v)) return v;
            return null;
        }
        const parts = (msg ?? dataMsg)?.parts as Array<{ content?: string }> | undefined;
        if (Array.isArray(parts) && parts.length > 0) {
            const text = parts.map((p) => (p?.content != null ? String(p.content) : "")).join("");
            if (text && !looksLikeInternalJson(text)) return text;
        }
        return null;
    } catch {
        return null;
    }
}

/** Coze 业务错误码：code !== 0 时抛出，提示用户检查配置（如 API Key） */
function throwIfCozeError(data: Record<string, unknown>): void {
    const code = data.code as number | undefined;
    if (code === undefined || code === 0) return;
    const msg = (data.msg as string) || "Unknown error";
    if (code === 4101) {
        throw new Error(
            "Coze 返回 4101：当前填写的 API Key 被 Coze 拒绝（已传递，但认证失败）。请检查：1) 必须使用「个人访问令牌」Personal Access Token，在 Coze 开放平台「个人中心 - API 密钥」创建，不要用 Bot ID 或其它 token；2) 国际站 (api.coze.com) 与国内站 (api.coze.cn) 的 Key 不通用，Endpoint 需与 Key 所属站点一致；3) Key 可能已过期或被撤销，请重新生成并保存。参考：https://www.coze.com/docs/developer_guides/authentication"
        );
    }
    throw new Error(`Coze API 错误 (code=${code}): ${msg}`);
}

/** 从 Coze 非流式 JSON 响应中解析出助手回复文本 */
function parseCozeCollectResponse(data: Record<string, unknown>): string {
    const dataObj = data.data as Record<string, unknown> | undefined;
    if (dataObj) {
        const msg = dataObj.message as Record<string, unknown> | undefined;
        if (msg && typeof msg.content === "string") return msg.content.trim();
        if (typeof dataObj.content === "string") return dataObj.content.trim();
        const messages = dataObj.messages as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(messages) && messages.length > 0) {
            const last = messages[messages.length - 1];
            if (last && typeof last.content === "string") return last.content.trim();
        }
    }
    const msg = data.message as Record<string, unknown> | undefined;
    if (msg && typeof msg.content === "string") return msg.content.trim();
    if (typeof data.content === "string") return data.content.trim();
    return "";
}

export const cozeAdapter: IAgentProxyAdapter = {
    type: "coze",

    async runStream(options, config, callbacks): Promise<void> {
        const cozeConfig = getCozeConfig(config);
        if (!cozeConfig) {
            throw new Error("Coze adapter: missing coze.botId or coze.apiKey in agent config");
        }
        const { sessionId, message } = options;
        const url = `${cozeConfig.baseUrl}/v3/chat?bot_id=${encodeURIComponent(cozeConfig.botId)}`;
        const body = {
            conversation_id: sessionId,
            bot_id: cozeConfig.botId,
            user_id: `channel:${sessionId}`,
            stream: true,
            auto_save_history: true,
            additional_messages: [{ role: "user", content: message, content_type: "text" }],
        };
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const userSignal = options.signal;
        if (userSignal) {
            if (userSignal.aborted) controller.abort();
            else userSignal.addEventListener("abort", () => controller.abort(), { once: true });
        }
        try {
            console.log(`[Coze] POST ${url} (stream=true)`);
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${cozeConfig.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            console.log(`[Coze] Response status=${res.status} content-type=${res.headers.get("content-type") ?? "(none)"}`);
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`Coze API error ${res.status}: ${text}`);
            }
            const contentType = (res.headers.get("content-type") || "").toLowerCase();
            // Coze 在 token 错误等情况下仍返回 200 + application/json，需先按 JSON 解析并检查 code
            if (contentType.includes("application/json")) {
                const text = await res.text();
                try {
                    const data = JSON.parse(text) as Record<string, unknown>;
                    throwIfCozeError(data);
                    const fullText = parseCozeCollectResponse(data);
                    if (fullText) callbacks.onChunk(fullText);
                } catch (e: any) {
                    if (e?.message?.startsWith("Coze API") || e?.message?.startsWith("Coze API Key")) throw e;
                    throw new Error(`Coze 返回了 JSON 但解析失败: ${e?.message ?? e}`);
                }
                callbacks.onTurnEnd?.();
                callbacks.onDone();
                return;
            }
            const reader = res.body?.getReader();
            if (!reader) {
                console.log(`[Coze] No stream reader, reading body as text`);
                const text = await res.text();
                if (text) callbacks.onChunk(text);
                callbacks.onTurnEnd?.();
                callbacks.onDone();
                return;
            }
            const decoder = new TextDecoder();
            let buffer = "";
            let hadAnyChunk = false;
            const rawDataSamples: string[] = [];
            let lastEvent = "";
            let streamAccumulated = "";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.replace(/\r\n/g, "\n").split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine.startsWith("event:")) {
                        lastEvent = trimmedLine.slice(6).trim();
                        continue;
                    }
                    if (!trimmedLine.startsWith("data:")) continue;
                    const raw = trimmedLine.slice(5).trim();
                    if (!raw) continue;
                    if (rawDataSamples.length < 5) rawDataSamples.push(lastEvent + " -> " + raw.slice(0, 150));
                    const e = lastEvent.toLowerCase();
                    const isMessageEvent =
                        e.includes("message") || e.includes("delta") || e.includes("answer") || e.includes("chunk") || lastEvent === "";
                    const content = isMessageEvent ? parseCozeStreamLine(raw) : null;
                    if (content) {
                        if (content === streamAccumulated) continue;
                        if (streamAccumulated.length > 0 && streamAccumulated.startsWith(content)) continue;
                        if (streamAccumulated.length > 0 && content.length >= 10 && streamAccumulated.endsWith(content)) continue;
                        if (content.startsWith(streamAccumulated)) {
                            const suffix = content.slice(streamAccumulated.length);
                            if (suffix) {
                                streamAccumulated = content;
                                hadAnyChunk = true;
                                callbacks.onChunk(suffix);
                            }
                            continue;
                        }
                        streamAccumulated += content;
                        hadAnyChunk = true;
                        callbacks.onChunk(content);
                    }
                }
            }
            // 若 SSE 流中没有任何可解析的 content，尝试：1) buffer 为 data: 行；2) buffer 为整段 JSON（非流式返回）
            if (!hadAnyChunk && buffer.trim()) {
                const dataPart = buffer.startsWith("data: ") ? buffer.slice(6) : buffer;
                const content = parseCozeStreamLine(dataPart);
                if (content) {
                    callbacks.onChunk(content);
                } else {
                    try {
                        const asJson = JSON.parse(buffer.trim()) as Record<string, unknown>;
                        const fullText = parseCozeCollectResponse(asJson);
                        if (fullText) callbacks.onChunk(fullText);
                    } catch {
                        // ignore
                    }
                }
            }
            if (!hadAnyChunk) {
                const sample = buffer.trim().slice(0, 300);
                console.log(`[Coze] Stream ended with no parsed chunks. Buffer sample: ${sample || "(empty)"}`);
                if (rawDataSamples.length > 0) {
                    console.log(`[Coze] First SSE data lines sample: ${rawDataSamples.join(" | ")}`);
                }
                // 可能是 Coze 返回的 JSON 错误体（如 4101 token 无效），先检查再决定是否回退
                try {
                    const asJson = JSON.parse(buffer.trim()) as Record<string, unknown>;
                    throwIfCozeError(asJson);
                    const fullText = parseCozeCollectResponse(asJson);
                    if (fullText) callbacks.onChunk(fullText);
                } catch (parseErr: any) {
                    if (parseErr?.message?.startsWith("Coze API") || parseErr?.message?.startsWith("Coze API Key")) throw parseErr;
                    // 流式未解析到内容，回退到非流式接口
                    try {
                        console.log(`[Coze] Stream had no parsed chunks, trying runCollect fallback`);
                        const fallbackText = await this.runCollect(options, config);
                        if (fallbackText) {
                            callbacks.onChunk(fallbackText);
                            console.log(`[Coze] Fallback runCollect returned ${fallbackText.length} chars`);
                        }
                    } catch (collectErr: any) {
                        if (collectErr?.message?.startsWith("Coze API") || collectErr?.message?.startsWith("Coze API Key")) throw collectErr;
                        console.warn(`[Coze] Fallback runCollect failed:`, collectErr?.message ?? collectErr);
                    }
                }
            }
            callbacks.onTurnEnd?.();
            callbacks.onDone();
            console.log(`[Coze] runStream finished`);
        } catch (err: any) {
            console.error(`[Coze] runStream error:`, err?.message ?? err);
            // 请求超时或网络错误时，尝试非流式接口兜底
            try {
                const fallbackText = await this.runCollect(options, config);
                if (fallbackText) {
                    callbacks.onChunk(fallbackText);
                    callbacks.onTurnEnd?.();
                    callbacks.onDone();
                    console.log(`[Coze] runStream recovered via runCollect`);
                    return;
                }
            } catch (_) {
                // ignore
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
        }
    },

    async runCollect(options, config): Promise<string> {
        const cozeConfig = getCozeConfig(config);
        if (!cozeConfig) {
            throw new Error("Coze adapter: missing coze.botId or coze.apiKey in agent config");
        }
        const { sessionId, message } = options;
        const url = `${cozeConfig.baseUrl}/v3/chat?bot_id=${encodeURIComponent(cozeConfig.botId)}`;
        const body = {
            conversation_id: sessionId,
            bot_id: cozeConfig.botId,
            user_id: `channel:${sessionId}`,
            stream: false,
            auto_save_history: true,
            additional_messages: [{ role: "user", content: message, content_type: "text" }],
        };
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${cozeConfig.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            const raw = await res.text();
            if (!res.ok) throw new Error(`Coze API error ${res.status}: ${raw}`);
            let data: Record<string, unknown>;
            try {
                data = JSON.parse(raw) as Record<string, unknown>;
            } catch {
                return "(无文本回复)";
            }
            throwIfCozeError(data);
            const content = parseCozeCollectResponse(data);
            return content || "(无文本回复)";
        } finally {
            clearTimeout(timeoutId);
        }
    },
};
