/**
 * MCP Operator：管理 MCP 客户端生命周期，按配置为会话提供 ToolDefinition 列表。
 * 支持 stdio（本地）与 sse（远程）两种传输。
 */

import type { McpServerConfig, McpServerConfigStdio, McpServerConfigSse } from "./types.js";
import { mcpConfigKey } from "./config.js";
import { McpClient } from "./client.js";
import { mcpToolsToToolDefinitions } from "./adapter.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { sendSessionMessage } from "../session-outlet/index.js";

/** 按配置键缓存的客户端 */
const clientCache = new Map<string, McpClient>();

function configLabel(config: McpServerConfig): string {
    if (config.transport === "stdio") return config.command;
    return config.url;
}

/** 用于系统消息展示的 MCP 名称：stdio 优先用首参（如 akshare-tools），否则 command；sse 用 URL 主机或路径末段 */
function mcpDisplayName(config: McpServerConfig): string {
    if (config.transport === "stdio") {
        const args = (config as McpServerConfigStdio).args;
        const first = args?.[0];
        if (typeof first === "string" && first.trim() && !first.includes("/") && !first.includes("\\")) {
            return first.trim();
        }
        return config.command;
    }
    try {
        const u = new URL((config as McpServerConfigSse).url);
        const host = u.hostname || u.pathname?.replace(/\/$/, "").split("/").pop() || "MCP";
        return host;
    } catch {
        return config.url;
    }
}

/** getMcpToolDefinitions 的可选参数：超时、重试与 sessionId（用于经 sendSessionMessage 推送进度） */
export interface GetMcpToolDefinitionsOptions {
    /** 连接或 list_tools 失败时的重试次数（不含首次，默认 1） */
    connectRetries?: number;
    /** 重试间隔（毫秒，默认 3000） */
    retryDelayMs?: number;
    /** stdio 初始化超时（毫秒） */
    initTimeoutMs?: number;
    /** stdio 初始化重试次数（默认 1） */
    initRetries?: number;
    /** stdio 初始化重试间隔（毫秒，默认 3000） */
    initRetryDelayMs?: number;
    /** 会话 ID，用于经全局 sendSessionMessage 推送 MCP 进度系统消息 */
    sessionId?: string;
    /** 单次 MCP 工具返回最大 token；超过则从尾部裁剪并打日志；不配置则不限制 */
    maxResultTokens?: number;
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * 为给定 MCP 服务器配置列表获取或创建客户端，并返回其工具对应的 ToolDefinition 数组。
 * 连接失败或 list_tools 失败的 server 会按 options 重试，仍失败则跳过并打日志，不阻塞整体。
 */
export async function getMcpToolDefinitions(
    serverConfigs: McpServerConfig[],
    options: GetMcpToolDefinitionsOptions = {},
): Promise<ToolDefinition[]> {
    const connectRetries = options.connectRetries ?? 1;
    const retryDelayMs = options.retryDelayMs ?? 3_000;
    const sessionId = options.sessionId;
    const clientOptions = {
        initTimeoutMs: options.initTimeoutMs,
        initRetries: options.initRetries,
        initRetryDelayMs: options.initRetryDelayMs,
    };

    const emitProgress = (displayMessage: string, phase: string, detail?: string) => {
        if (sessionId) {
            sendSessionMessage(sessionId, {
                type: "system",
                code: "mcp.progress",
                payload: { phase, message: displayMessage, serverLabel: detail },
            });
        }
    };

    const allTools: ToolDefinition[] = [];
    for (let i = 0; i < serverConfigs.length; i++) {
        const config = serverConfigs[i];
        const key = mcpConfigKey(config);
        const label = configLabel(config);
        const displayName = mcpDisplayName(config);
        let client = clientCache.get(key);

        if (!client || !client.isConnected) {
            if (client) {
                clientCache.delete(key);
                try {
                    await client.close();
                } catch {}
            }
            emitProgress(`${displayName} MCP connecting`, "connecting");
            let connected = false;
            for (let attempt = 0; attempt <= connectRetries; attempt++) {
                if (attempt > 0) {
                    emitProgress(`${displayName} MCP retrying (${attempt + 1}/${connectRetries + 1})`, "retrying", "connect");
                    await sleep(retryDelayMs);
                }
                try {
                    client = new McpClient(config, clientOptions);
                    await client.connect();
                    clientCache.set(key, client);
                    connected = true;
                    emitProgress(`${displayName} MCP ready`, "ready");
                    break;
                } catch (err) {
                    if (client) try { await client.close(); } catch {}
                    if (attempt === connectRetries) {
                        console.warn(`[mcp] 连接失败 (${label}):`, err instanceof Error ? err.message : err);
                        const errMsg = err instanceof Error ? err.message : String(err);
                        emitProgress(`${displayName} MCP failed: ${errMsg}`, "skipped", errMsg);
                    }
                }
            }
            if (!connected) continue;
        }

        client = clientCache.get(key)!;
        let toolsListed = false;
        for (let attempt = 0; attempt <= connectRetries; attempt++) {
            if (attempt > 0) {
                emitProgress(`${displayName} MCP retrying list tools (${attempt + 1}/${connectRetries + 1})`, "retrying", "list_tools");
                await sleep(retryDelayMs);
            }
            try {
                const tools = await client.listTools();
                const serverId = `mcp${i}`;
                const definitions = mcpToolsToToolDefinitions(
                    tools,
                    client,
                    serverId,
                    options.maxResultTokens,
                );
                allTools.push(...definitions);
                toolsListed = true;
                break;
            } catch (err) {
                if (attempt === connectRetries) {
                    console.warn(`[mcp] list_tools 失败 (${label}):`, err instanceof Error ? err.message : err);
                    const errMsg = err instanceof Error ? err.message : String(err);
                    emitProgress(`${displayName} MCP list tools failed: ${errMsg}`, "skipped", errMsg);
                }
            }
        }
    }
    return allTools;
}

/**
 * 关闭并移除所有缓存的 MCP 客户端（进程退出或显式清理时调用）。
 */
export async function shutdownMcpClients(): Promise<void> {
    const closeAll = Array.from(clientCache.values()).map((c) => c.close().catch(() => {}));
    clientCache.clear();
    await Promise.all(closeAll);
}
