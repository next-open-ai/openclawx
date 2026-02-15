/**
 * Core MCP 模块：为 SessionAgent 提供 MCP Tools 能力（Client 端）。
 * 配置在创建 Session 时通过 options.mcpServers 传入，与 Skill 类似。
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { McpServerConfig } from "./types.js";
import { resolveMcpServersForSession } from "./config.js";
import { getMcpToolDefinitions } from "./operator.js";

export type { McpServerConfig, McpServerConfigStdio, McpServerConfigSse, McpTool } from "./types.js";
export { resolveMcpServersForSession, stdioConfigKey, sseConfigKey, mcpConfigKey } from "./config.js";
export { McpClient } from "./client.js";
export { getMcpToolDefinitions, shutdownMcpClients } from "./operator.js";
export { mcpToolToToolDefinition, mcpToolsToToolDefinitions } from "./adapter.js";

/**
 * 根据会话选项中的 mcpServers 配置，返回该会话可用的 MCP 工具（ToolDefinition 数组）。
 * 在 AgentManager.getOrCreateSession 中调用，并入 customTools。
 */
export async function createMcpToolsForSession(options: {
    mcpServers?: McpServerConfig[];
}): Promise<ToolDefinition[]> {
    const configs = resolveMcpServersForSession(options.mcpServers);
    if (configs.length === 0) return [];
    return getMcpToolDefinitions(configs);
}
