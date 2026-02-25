/**
 * MCP 配置解析与校验。
 * 从 getOrCreateSession 的 options.mcpServers 中取出并规范化，支持 stdio 与 sse。
 * 支持两种输入：数组（含 transport）或标准 JSON 对象（key 为名称，由 command/url 推断 transport）。
 */

import type {
    McpServerConfig,
    McpServerConfigStdio,
    McpServerConfigSse,
    McpServersStandardFormat,
    McpServerConfigStandardEntry,
} from "./types.js";

/**
 * 将标准格式（mcpServers 对象）转为内部数组格式。
 * 有 command 视为 stdio，有 url 视为 sse；无效项跳过。
 */
export function standardFormatToArray(mcpServers: McpServersStandardFormat): McpServerConfig[] {
    const result: McpServerConfig[] = [];
    for (const [_, entry] of Object.entries(mcpServers)) {
        if (!entry || typeof entry !== "object") continue;
        const cmd = typeof entry.command === "string" ? entry.command.trim() : "";
        const url = typeof entry.url === "string" ? entry.url.trim() : "";
        if (cmd) {
            result.push({
                transport: "stdio",
                command: cmd,
                args: Array.isArray(entry.args) ? entry.args : undefined,
                env: entry.env && typeof entry.env === "object" ? entry.env : undefined,
            });
        } else if (url) {
            result.push({
                transport: "sse",
                url,
                headers: entry.headers && typeof entry.headers === "object" ? entry.headers : undefined,
            });
        } else {
            console.warn("[mcp] 跳过无效标准格式项：需 command（stdio）或 url（sse）");
        }
    }
    return result;
}

/**
 * 将内部数组格式转为标准 JSON 对象（用于展示/编辑）。
 * 无名称的项使用 "MCP Server 1"、"MCP Server 2" 等占位 key。
 */
export function arrayToStandardFormat(mcpServers: McpServerConfig[]): McpServersStandardFormat {
    const out: McpServersStandardFormat = {};
    mcpServers.forEach((s, i) => {
        const name = `MCP Server ${i + 1}`;
        if (s.transport === "stdio") {
            const e: McpServerConfigStandardEntry = {
                command: (s as McpServerConfigStdio).command,
                args: (s as McpServerConfigStdio).args,
                env: (s as McpServerConfigStdio).env,
            };
            out[name] = e;
        } else {
            const e: McpServerConfigStandardEntry = {
                url: (s as McpServerConfigSse).url,
                headers: (s as McpServerConfigSse).headers,
            };
            out[name] = e;
        }
    });
    return out;
}

function isStandardFormat(obj: unknown): obj is McpServersStandardFormat {
    return obj !== null && typeof obj === "object" && !Array.isArray(obj);
}

/**
 * 从会话选项里解析出本会话启用的 MCP 服务器配置列表。
 * 支持：数组（含 transport）、标准 JSON 对象（key 为名称，由 command/url 推断）。
 */
export function resolveMcpServersForSession(
    mcpServers: McpServerConfig[] | McpServersStandardFormat | undefined
): McpServerConfig[] {
    if (mcpServers == null) return [];
    if (isStandardFormat(mcpServers)) return standardFormatToArray(mcpServers);
    if (!Array.isArray(mcpServers) || mcpServers.length === 0) return [];
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
