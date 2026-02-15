/**
 * MCP SSE/HTTP 传输：通过 HTTP POST 向远程 URL 发送 JSON-RPC 请求，响应在 response body。
 */

import type { McpServerConfigSse } from "../types.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../types.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface SseTransportOptions {
    initTimeoutMs?: number;
    requestTimeoutMs?: number;
}

export class SseTransport {
    private config: McpServerConfigSse;
    private initTimeoutMs: number;
    private requestTimeoutMs: number;
    private _connected = false;

    constructor(config: McpServerConfigSse, options: SseTransportOptions = {}) {
        this.config = config;
        this.initTimeoutMs = options.initTimeoutMs ?? 15_000;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    }

    async start(): Promise<void> {
        if (this._connected) return;
        const url = (this.config.url ?? "").trim();
        if (!url) throw new Error("MCP SSE url is required");
        const initResult = await this.request(
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: MCP_PROTOCOL_VERSION,
                    capabilities: {},
                    clientInfo: { name: "openbot", version: "0.1.0" },
                },
            },
            this.initTimeoutMs,
        );
        if (initResult.error) {
            throw new Error(`MCP initialize failed: ${initResult.error.message}`);
        }
        await this.request(
            { jsonrpc: "2.0", id: 2, method: "notifications/initialized" },
            this.requestTimeoutMs,
        ).catch(() => ({}));
        this._connected = true;
    }

    request(req: JsonRpcRequest, timeoutMs?: number): Promise<JsonRpcResponse> {
        const url = (this.config.url ?? "").trim();
        if (!url) {
            return Promise.reject(new Error("MCP SSE url is required"));
        }
        const t = timeoutMs ?? this.requestTimeoutMs;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), t);
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...this.config.headers,
        };
        return fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(req),
            signal: controller.signal,
        })
            .then(async (res) => {
                clearTimeout(timeoutId);
                if (!res.ok) {
                    const text = await res.text();
                    throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
                }
                const json = (await res.json()) as JsonRpcResponse;
                if (!json || json.jsonrpc !== "2.0") {
                    throw new Error("Invalid MCP response");
                }
                return json;
            })
            .catch((err) => {
                clearTimeout(timeoutId);
                if (err.name === "AbortError") {
                    throw new Error(`MCP request timeout (${t}ms)`);
                }
                throw err;
            });
    }

    async close(): Promise<void> {
        this._connected = false;
    }

    get isConnected(): boolean {
        return this._connected;
    }
}
