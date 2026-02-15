/**
 * MCP Operator：管理 MCP 客户端生命周期，按配置为会话提供 ToolDefinition 列表。
 * 支持 stdio（本地）与 sse（远程）两种传输。
 */

import type { McpServerConfig } from "./types.js";
import { mcpConfigKey } from "./config.js";
import { McpClient } from "./client.js";
import { mcpToolsToToolDefinitions } from "./adapter.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

/** 按配置键缓存的客户端 */
const clientCache = new Map<string, McpClient>();

function configLabel(config: McpServerConfig): string {
    if (config.transport === "stdio") return config.command;
    return config.url;
}

/**
 * 为给定 MCP 服务器配置列表获取或创建客户端，并返回其工具对应的 ToolDefinition 数组。
 * 连接失败或 list_tools 失败的 server 会被跳过并打日志，不阻塞整体。
 */
export async function getMcpToolDefinitions(serverConfigs: McpServerConfig[]): Promise<ToolDefinition[]> {
    const allTools: ToolDefinition[] = [];
    for (let i = 0; i < serverConfigs.length; i++) {
        const config = serverConfigs[i];
        const key = mcpConfigKey(config);
        let client = clientCache.get(key);
        if (!client) {
            client = new McpClient(config);
            try {
                await client.connect();
                clientCache.set(key, client);
            } catch (err) {
                console.warn(`[mcp] 连接失败 (${configLabel(config)}):`, err instanceof Error ? err.message : err);
                continue;
            }
        }
        if (!client.isConnected) {
            clientCache.delete(key);
            try {
                await client.close();
            } catch {}
            const newClient = new McpClient(config);
            try {
                await newClient.connect();
                clientCache.set(key, newClient);
                client = newClient;
            } catch (err) {
                console.warn(`[mcp] 重连失败 (${configLabel(config)}):`, err instanceof Error ? err.message : err);
                continue;
            }
        }
        try {
            const tools = await client.listTools();
            const serverId = `mcp${i}`;
            const definitions = mcpToolsToToolDefinitions(tools, client, serverId);
            allTools.push(...definitions);
        } catch (err) {
            console.warn(`[mcp] list_tools 失败 (${configLabel(config)}):`, err instanceof Error ? err.message : err);
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
