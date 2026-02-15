/**
 * MCP 配置解析与校验。
 * 从 getOrCreateSession 的 options.mcpServers 中取出并规范化，支持 stdio 与 sse。
 */

import type { McpServerConfig, McpServerConfigStdio, McpServerConfigSse } from "./types.js";

/**
 * 从会话选项里解析出本会话启用的 MCP 服务器配置列表。
 * 支持 stdio（本地进程）与 sse（远程 HTTP）。
 */
export function resolveMcpServersForSession(mcpServers: McpServerConfig[] | undefined): McpServerConfig[] {
    if (!Array.isArray(mcpServers) || mcpServers.length === 0) {
        return [];
    }
    const result: McpServerConfig[] = [];
    for (const s of mcpServers) {
        if (!s || typeof s !== "object") continue;
        if (s.transport === "stdio") {
            if (typeof (s as McpServerConfigStdio).command !== "string" || !(s as McpServerConfigStdio).command.trim()) {
                console.warn("[mcp] 跳过无效 stdio 配置：缺少或无效 command");
                continue;
            }
            result.push({
                transport: "stdio",
                command: (s as McpServerConfigStdio).command.trim(),
                args: Array.isArray((s as McpServerConfigStdio).args) ? (s as McpServerConfigStdio).args : undefined,
                env: (s as McpServerConfigStdio).env && typeof (s as McpServerConfigStdio).env === "object" ? (s as McpServerConfigStdio).env : undefined,
            });
        } else if (s.transport === "sse") {
            const url = (s as McpServerConfigSse).url?.trim();
            if (!url) {
                console.warn("[mcp] 跳过无效 sse 配置：缺少或无效 url");
                continue;
            }
            result.push({
                transport: "sse",
                url,
                headers: (s as McpServerConfigSse).headers && typeof (s as McpServerConfigSse).headers === "object" ? (s as McpServerConfigSse).headers : undefined,
            });
        } else {
            console.warn("[mcp] 未知 transport:", (s as McpServerConfig).transport);
        }
    }
    return result;
}

/**
 * 为 stdio 配置生成缓存键（用于 Operator 复用同一进程连接）
 */
export function stdioConfigKey(config: McpServerConfigStdio): string {
    const args = (config.args ?? []).join(" ");
    const envStr = config.env ? JSON.stringify(config.env) : "";
    return `stdio:${config.command}\0${args}\0${envStr}`;
}

/**
 * 为 sse 配置生成缓存键
 */
export function sseConfigKey(config: McpServerConfigSse): string {
    const headersStr = config.headers ? JSON.stringify(config.headers) : "";
    return `sse:${config.url}\0${headersStr}`;
}

/**
 * 任意 MCP 配置的缓存键
 */
export function mcpConfigKey(config: McpServerConfig): string {
    if (config.transport === "stdio") return stdioConfigKey(config);
    return sseConfigKey(config);
}
