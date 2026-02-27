/**
 * MCP stdio 传输：子进程 + 标准输入/输出上的 Newline-delimited JSON-RPC。
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { McpServerConfigStdio } from "../types.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../types.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface StdioTransportOptions {
    /** 初始化超时（毫秒） */
    initTimeoutMs?: number;
    /** 单次请求超时（毫秒） */
    requestTimeoutMs?: number;
    /** 初始化失败时的重试次数（不含首次，默认 1，即最多 2 次尝试） */
    initRetries?: number;
    /** 初始化重试间隔（毫秒，默认 3000） */
    initRetryDelayMs?: number;
}

export class StdioTransport {
    private process: ChildProcess | null = null;
    private config: McpServerConfigStdio;
    private initTimeoutMs: number;
    private requestTimeoutMs: number;
    private initRetries: number;
    private initRetryDelayMs: number;
    private nextId = 1;
    private pending = new Map<number | string, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    private buffer = "";

    constructor(config: McpServerConfigStdio, options: StdioTransportOptions = {}) {
        this.config = config;
        this.initTimeoutMs = options.initTimeoutMs ?? 10_000;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
        this.initRetries = options.initRetries ?? 1;
        this.initRetryDelayMs = options.initRetryDelayMs ?? 3_000;
    }

    /** 启动子进程并完成 MCP initialize 握手 */
    async start(): Promise<void> {
        if (this.process) {
            return;
        }
        const env = { ...process.env, ...this.config.env };
        this.process = spawn(this.config.command, this.config.args ?? [], {
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });

        const child = this.process;
        child.stdout?.on("data", (chunk: Buffer) => {
            this.buffer += chunk.toString("utf-8");
            this.flushLines();
        });
        child.stderr?.on("data", (data: Buffer) => {
            const msg = data.toString("utf-8").trim();
            if (msg) console.warn("[mcp stdio stderr]", msg);
        });
        child.on("error", (err) => {
            this.rejectAll(new Error(`MCP process error: ${err.message}`));
        });
        child.on("exit", (code, signal) => {
            this.rejectAll(new Error(`MCP process exited: code=${code} signal=${signal}`));
            this.process = null;
        });

        const maxAttempts = 1 + this.initRetries;
        let lastErr: Error | null = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await this.initialize();
                lastErr = null;
                break;
            } catch (e) {
                lastErr = e instanceof Error ? e : new Error(String(e));
                const isTransient = lastErr.message.includes("timeout") || lastErr.message.includes("MCP process exited");
                if (!isTransient || attempt >= maxAttempts) {
                    throw lastErr;
                }
                console.warn(`[mcp stdio] initialize 超时或失败，${this.initRetryDelayMs}ms 后重试 (${attempt}/${maxAttempts}):`, lastErr.message);
                await new Promise((r) => setTimeout(r, this.initRetryDelayMs));
            }
        }
    }

    private flushLines(): void {
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const msg = JSON.parse(trimmed) as JsonRpcResponse | { method?: string };
                if ("id" in msg && (msg as JsonRpcResponse).id !== undefined) {
                    const pending = this.pending.get((msg as JsonRpcResponse).id);
                    if (pending) {
                        clearTimeout(pending.timer);
                        this.pending.delete((msg as JsonRpcResponse).id);
                        if ((msg as JsonRpcResponse).error) {
                            pending.reject(new Error((msg as JsonRpcResponse).error!.message));
                        } else {
                            pending.resolve(msg as JsonRpcResponse);
                        }
                    }
                }
            } catch {
                // 忽略非 JSON 行
            }
        }
    }

    private rejectAll(err: Error): void {
        for (const [, { reject, timer }] of this.pending) {
            clearTimeout(timer);
            reject(err);
        }
        this.pending.clear();
    }

    private async initialize(): Promise<void> {
        const initResult = await this.request({
            jsonrpc: "2.0",
            id: this.nextId++,
            method: "initialize",
            params: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: "openbot", version: "0.1.0" },
            },
        }, this.initTimeoutMs);
        if (initResult.error) {
            throw new Error(`MCP initialize failed: ${initResult.error.message}`);
        }
        this.sendNotification({ jsonrpc: "2.0", method: "notifications/initialized" });
    }

    private sendNotification(msg: { jsonrpc: string; method: string; params?: unknown }): void {
        if (!this.process?.stdin?.writable) return;
        this.process.stdin.write(JSON.stringify(msg) + "\n", "utf-8");
    }

    /** 发送 JSON-RPC 请求并等待响应 */
    request(req: JsonRpcRequest, timeoutMs?: number): Promise<JsonRpcResponse> {
        return new Promise((resolve, reject) => {
            if (!this.process?.stdin?.writable) {
                reject(new Error("MCP transport not connected"));
                return;
            }
            const t = timeoutMs ?? this.requestTimeoutMs;
            const timer = setTimeout(() => {
                if (this.pending.delete(req.id)) {
                    reject(new Error(`MCP request timeout (${t}ms)`));
                }
            }, t);
            this.pending.set(req.id, { resolve, reject, timer });
            this.process!.stdin!.write(JSON.stringify(req) + "\n", "utf-8");
        });
    }

    /** 关闭子进程 */
    async close(): Promise<void> {
        if (this.process) {
            this.rejectAll(new Error("MCP transport closed"));
            this.process.kill("SIGTERM");
            this.process = null;
        }
    }

    get isConnected(): boolean {
        return this.process != null && this.process.stdin?.writable === true;
    }
}
