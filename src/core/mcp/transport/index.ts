import type { McpServerConfig, IMcpTransport } from "../types.js";
import type { McpServerConfigStdio } from "../types.js";
import type { McpServerConfigSse } from "../types.js";
import { StdioTransport } from "./stdio.js";
import { SseTransport } from "./sse.js";

export interface TransportOptions {
    initTimeoutMs?: number;
    requestTimeoutMs?: number;
    /** stdio：初始化失败时的重试次数（默认 1） */
    initRetries?: number;
    /** stdio：初始化重试间隔毫秒（默认 3000） */
    initRetryDelayMs?: number;
}

/**
 * 根据配置创建对应的传输层实例。
 */
export function createTransport(
    config: McpServerConfig,
    options?: TransportOptions,
): IMcpTransport {
    if (config.transport === "stdio") {
        return new StdioTransport(config as McpServerConfigStdio, {
            initTimeoutMs: options?.initTimeoutMs,
            requestTimeoutMs: options?.requestTimeoutMs,
            initRetries: options?.initRetries,
            initRetryDelayMs: options?.initRetryDelayMs,
        });
    }
    if (config.transport === "sse") {
        return new SseTransport(config as McpServerConfigSse, options);
    }
    throw new Error(`Unsupported MCP transport: ${(config as McpServerConfig).transport}`);
}

export { StdioTransport } from "./stdio.js";
export { SseTransport } from "./sse.js";
