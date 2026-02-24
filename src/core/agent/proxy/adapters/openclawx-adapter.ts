/**
 * OpenClawX AgentProxy 适配器：代理到另一台 OpenClawX 实例（调用其 server-api/agents/proxy-chat 接口）。
 */
import type { DesktopAgentConfig } from "../../../config/desktop-config.js";
import type {
    IAgentProxyAdapter,
    RunAgentForChannelOptions,
    RunAgentStreamCallbacks,
} from "../types.js";

const REQUEST_TIMEOUT_MS = 120_000;

function getOpenClawXConfig(config: DesktopAgentConfig): { baseUrl: string; apiKey?: string } | null {
    const ox = config.openclawx;
    if (!ox?.baseUrl?.trim()) return null;
    return {
        baseUrl: ox.baseUrl.replace(/\/$/, ""),
        apiKey: ox.apiKey?.trim(),
    };
}

function buildHeaders(apiKey?: string): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    return headers;
}

export const openclawxAdapter: IAgentProxyAdapter = {
    type: "openclawx",

    async runStream(options, config, callbacks): Promise<void> {
        const oxConfig = getOpenClawXConfig(config);
        if (!oxConfig) {
            throw new Error("OpenClawX adapter: missing openclawx.baseUrl in agent config");
        }
        const url = `${oxConfig.baseUrl}/server-api/agents/proxy-chat/stream`;
        const body = { sessionId: options.sessionId, message: options.message, agentId: options.agentId };
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const userSignal = options.signal;
        if (userSignal) {
            if (userSignal.aborted) controller.abort();
            else userSignal.addEventListener("abort", () => controller.abort(), { once: true });
        }
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: buildHeaders(oxConfig.apiKey),
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`OpenClawX proxy stream error ${res.status}: ${text}`);
            }
            const reader = res.body?.getReader();
            if (!reader) {
                callbacks.onDone();
                return;
            }
            const decoder = new TextDecoder();
            let buffer = "";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    if (line.startsWith("data:")) {
                        const data = line.slice(5).trim();
                        if (!data) continue;
                        try {
                            const parsed = JSON.parse(data) as { delta?: string; done?: boolean };
                            if (parsed.done) {
                                callbacks.onDone();
                                return;
                            }
                            if (typeof parsed.delta === "string" && parsed.delta) {
                                callbacks.onChunk(parsed.delta);
                            }
                        } catch {
                            // ignore
                        }
                    }
                }
            }
            callbacks.onDone();
        } finally {
            clearTimeout(timeoutId);
        }
    },

    async runCollect(options, config): Promise<string> {
        const oxConfig = getOpenClawXConfig(config);
        if (!oxConfig) {
            throw new Error("OpenClawX adapter: missing openclawx.baseUrl in agent config");
        }
        const url = `${oxConfig.baseUrl}/server-api/agents/proxy-chat`;
        const body = { sessionId: options.sessionId, message: options.message, agentId: options.agentId };
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: buildHeaders(oxConfig.apiKey),
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`OpenClawX proxy error ${res.status}: ${text}`);
            }
            const data = (await res.json()) as { text?: string };
            const text = data.text;
            return typeof text === "string" ? text.trim() || "(无文本回复)" : "(无文本回复)";
        } finally {
            clearTimeout(timeoutId);
        }
    },
};
