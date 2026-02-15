/**
 * MCP 客户端：连接、list_tools、call_tool、断开。
 * 支持 stdio（本地进程）与 sse（远程 HTTP）两种传输。
 */

import type { McpTool, McpToolCallResult, IMcpTransport } from "./types.js";
import { createTransport } from "./transport/index.js";
import type { McpServerConfig } from "./types.js";

export interface McpClientOptions {
    initTimeoutMs?: number;
    requestTimeoutMs?: number;
}

export class McpClient {
    private transport: IMcpTransport;
    private _tools: McpTool[] | null = null;
    private _requestId = 0;

    constructor(configOrTransport: McpServerConfig | IMcpTransport, options: McpClientOptions = {}) {
        if (
            typeof (configOrTransport as IMcpTransport).request === "function" &&
            typeof (configOrTransport as IMcpTransport).start === "function"
        ) {
            this.transport = configOrTransport as IMcpTransport;
        } else {
            this.transport = createTransport(configOrTransport as McpServerConfig, {
                initTimeoutMs: options.initTimeoutMs,
                requestTimeoutMs: options.requestTimeoutMs,
            });
        }
    }

    /** 建立连接并完成握手；成功后可使用 listTools / callTool */
    async connect(): Promise<void> {
        await this.transport.start();
    }

    /** 获取工具列表（会缓存；断开重连后需重新 list） */
    async listTools(): Promise<McpTool[]> {
        if (this._tools !== null) {
            return this._tools;
        }
        const res = await this.transport.request({
            jsonrpc: "2.0",
            id: ++this._requestId,
            method: "tools/list",
        });
        if (res.error) {
            throw new Error(`MCP tools/list failed: ${res.error.message}`);
        }
        const list = (res.result as { tools?: McpTool[] })?.tools;
        this._tools = Array.isArray(list) ? list : [];
        return this._tools;
    }

    /** 调用指定工具 */
    async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
        const res = await this.transport.request({
            jsonrpc: "2.0",
            id: ++this._requestId,
            method: "tools/call",
            params: { name, arguments: args ?? {} },
        });
        if (res.error) {
            return {
                content: [{ type: "text", text: `MCP call_tool error: ${res.error.message}` }],
                isError: true,
            };
        }
        const result = res.result as McpToolCallResult | undefined;
        if (!result || !Array.isArray(result.content)) {
            return { content: [{ type: "text", text: "Invalid MCP tools/call result" }], isError: true };
        }
        return result;
    }

    async close(): Promise<void> {
        this._tools = null;
        await this.transport.close();
    }

    get isConnected(): boolean {
        return this.transport.isConnected;
    }
}
