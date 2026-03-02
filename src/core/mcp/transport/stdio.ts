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
    private pending = new Map<string, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    private buffer = "";
    private stderrBuffer = "";

    private static pendingKey(id: number | string | undefined | null): string {
        if (id === undefined || id === null) return "";
        return String(id);
    }

    constructor(config: McpServerConfigStdio, options: StdioTransportOptions = {}) {
        this.config = config;
        const isUvx = /^uvx?$/i.test((config.command || "").trim().replace(/^.*[/\\]/, ""));
        const defaultInitMs = isUvx ? 60_000 : 20_000;
        this.initTimeoutMs = options.initTimeoutMs ?? defaultInitMs;
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
        // 避免 Python 类 MCP 在 pipe 下全缓冲 stdout，导致 initialize 响应迟迟不到而超时
        if (env.PYTHONUNBUFFERED === undefined) env.PYTHONUNBUFFERED = "1";
        // npx/uvx 可能向 stdout 输出安装/进度等，污染 Newline-delimited JSON，导致无法解析；设为静默
        const cmd = (this.config.command || "").trim().toLowerCase();
        const cmdBase = cmd.includes("/") ? cmd.split("/").pop()! : cmd;
        if (cmdBase === "npx" || cmdBase === "npm") {
            if (env.CI === undefined) env.CI = "1";
            if (env.NO_UPDATE_NOTIFIER === undefined) env.NO_UPDATE_NOTIFIER = "1";
            if (env.npm_config_loglevel === undefined) env.npm_config_loglevel = "silent";
        } else if (cmdBase === "uvx" || cmdBase === "uv") {
            if (env.CI === undefined) env.CI = "1";
            if (env.UV_SILENT === undefined) env.UV_SILENT = "1";
        }
        // uvx/uv 不支持 -y 参数（与 npx -y 不同），自动去掉以免报错 "unexpected argument '-y' found"
        let args = this.config.args ?? [];
        if (cmdBase === "uvx" || cmdBase === "uv") {
            args = args.filter((a) => a !== "-y" && a !== "--yes");
        }
        this.process = spawn(this.config.command, args, {
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });

        const child = this.process;
        child.stdout?.on("data", (chunk: Buffer) => {
            this.buffer += chunk.toString("utf-8");
            this.flushLines();
        });
        // 部分 MCP 实现或包装可能把 JSON-RPC 写到 stderr，单独按行解析以尝试匹配响应（不混入 stdout 避免交叉破坏 JSON）
        child.stderr?.on("data", (data: Buffer) => {
            const raw = data.toString("utf-8");
            const trimmed = raw.trim();
            if (trimmed && !raw.includes("jsonrpc")) console.warn("[mcp stdio stderr]", trimmed);
            this.stderrBuffer += raw;
            this.flushStderrLines();
        });
        child.on("error", (err) => {
            this.rejectAll(new Error(`MCP process error: ${err.message}`));
        });
        child.on("exit", (code, signal) => {
            if (code !== 0 && code !== null) {
                const cmd = this.config.command;
                const args = JSON.stringify(this.config.args ?? []);
                // 延后读取 stderr，以便管道中尚未 flush 的输出先写入 stderrBuffer
                setImmediate(() => {
                    const stderrTail = this.stderrBuffer.trim().slice(-2048) || "(无 stderr 输出)";
                    console.warn(`[mcp stdio] 子进程异常退出 command=${cmd} args=${args} code=${code} signal=${signal}`);
                    console.warn("[mcp stdio] 子进程 stderr 末尾:", stderrTail);
                });
            }
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

    /** 从一行中解析 JSON-RPC 响应：整行即 JSON，或从第一个 { 开始提取到匹配的 }（兼容 npx/uvx 等前缀输出） */
    private static parseJsonRpcResponse(line: string): JsonRpcResponse | null {
        const trimmed = line.trim();
        if (!trimmed) return null;
        try {
            const msg = JSON.parse(trimmed) as JsonRpcResponse;
            if ("id" in msg && msg.id !== undefined) return msg;
            return null;
        } catch {
            const start = trimmed.indexOf("{");
            if (start === -1) return null;
            let depth = 0;
            let end = -1;
            for (let i = start; i < trimmed.length; i++) {
                const c = trimmed[i];
                if (c === "{") depth++;
                else if (c === "}") {
                    depth--;
                    if (depth === 0) {
                        end = i;
                        break;
                    }
                }
            }
            if (end === -1) return null;
            try {
                const msg = JSON.parse(trimmed.slice(start, end + 1)) as JsonRpcResponse;
                if ("id" in msg && msg.id !== undefined) return msg;
                return null;
            } catch {
                return null;
            }
        }
    }

    private flushLines(): void {
        this.flushLinesFromBuffer(this.buffer, (rest) => {
            this.buffer = rest;
        });
    }

    private flushStderrLines(): void {
        this.flushLinesFromBuffer(this.stderrBuffer, (rest) => {
            this.stderrBuffer = rest;
        });
    }

    private flushLinesFromBuffer(
        buf: string,
        setRest: (rest: string) => void,
    ): void {
        const lines = buf.split("\n");
        setRest(lines.pop() ?? "");
        for (const line of lines) {
            const msg = StdioTransport.parseJsonRpcResponse(line);
            if (!msg) continue;
            const key = StdioTransport.pendingKey(msg.id);
            const pending = key ? this.pending.get(key) : undefined;
            if (pending) {
                clearTimeout(pending.timer);
                this.pending.delete(key);
                if (msg.error) {
                    pending.reject(new Error(msg.error.message));
                } else {
                    pending.resolve(msg);
                }
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
            const key = StdioTransport.pendingKey(req.id);
            if (!key) {
                reject(new Error("MCP request id is required"));
                return;
            }
            const t = timeoutMs ?? this.requestTimeoutMs;
            const timer = setTimeout(() => {
                if (this.pending.delete(key)) {
                    reject(new Error(`MCP request timeout (${t}ms)`));
                }
            }, t);
            this.pending.set(key, { resolve, reject, timer });
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
