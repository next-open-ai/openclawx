/**
 * MCP Tool 转为 pi-coding-agent ToolDefinition 的适配层。
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { McpTool } from "./types.js";
import type { McpClient } from "./client.js";
import { truncateTextToMaxTokens } from "../tools/truncate-result.js";

/** 通用参数：MCP 工具接受任意 JSON 对象作为 arguments */
const McpToolParamsSchema = Type.Record(Type.String(), Type.Any());

/**
 * 将单个 MCP 工具封装为 pi-coding-agent 的 ToolDefinition。
 * @param tool MCP tools/list 返回的项
 * @param client 已连接的 McpClient，用于 callTool
 * @param serverId 可选前缀，用于避免多 MCP 时工具名冲突
 * @param maxResultTokens 可选，单次返回最大 token；超过则从尾部裁剪并打日志；不配置则不限制
 */
export function mcpToolToToolDefinition(
    tool: McpTool,
    client: McpClient,
    serverId?: string,
    maxResultTokens?: number,
): ToolDefinition {
    const name = serverId ? `${serverId}_${tool.name}` : tool.name;
    const description = (tool.description ?? "").trim() || `MCP tool: ${tool.name}`;
    return {
        name,
        label: tool.name,
        description,
        parameters: McpToolParamsSchema,
        execute: async (
            _toolCallId: string,
            params: Record<string, unknown>,
            _signal: AbortSignal | undefined,
            _onUpdate: unknown,
            _ctx: unknown,
        ) => {
            const args = params && typeof params === "object" ? params : {};
            try {
                const result = await client.callTool(tool.name, args);
                let text = result.content
                    ?.filter((c) => c.type === "text")
                    .map((c) => (c as { type: "text"; text: string }).text)
                    .join("\n") ?? (result.isError ? "MCP 调用返回错误" : "");
                if (typeof maxResultTokens === "number" && maxResultTokens > 0) {
                    text = truncateTextToMaxTokens(text, maxResultTokens, `MCP ${name}`);
                }
                return {
                    content: [{ type: "text" as const, text }],
                    details: result.isError ? { isError: true } : undefined,
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `MCP 调用失败: ${msg}` }],
                    details: undefined,
                };
            }
        },
    };
}

/**
 * 将某 MCP 客户端的全部工具转为 ToolDefinition 数组。
 * @param maxResultTokens 可选，单次返回最大 token；不配置则不限制
 */
export function mcpToolsToToolDefinitions(
    tools: McpTool[],
    client: McpClient,
    serverId?: string,
    maxResultTokens?: number,
): ToolDefinition[] {
    return tools.map((t) => mcpToolToToolDefinition(t, client, serverId, maxResultTokens));
}
