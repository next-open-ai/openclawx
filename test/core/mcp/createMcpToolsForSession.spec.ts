/**
 * createMcpToolsForSession 单元测试（无真实 MCP 进程）
 */
import { createMcpToolsForSession } from "../../../src/core/mcp/index.js";

describe("core/mcp/createMcpToolsForSession", () => {
    it("returns empty array when mcpServers is undefined", async () => {
        const tools = await createMcpToolsForSession({});
        expect(tools).toEqual([]);
    });

    it("returns empty array when mcpServers is empty", async () => {
        const tools = await createMcpToolsForSession({ mcpServers: [] });
        expect(tools).toEqual([]);
    });

    it("returns empty array when only sse config and connection fails", async () => {
        const tools = await createMcpToolsForSession({
            mcpServers: [{ transport: "sse", url: "http://localhost:9999" }],
        });
        expect(Array.isArray(tools)).toBe(true);
        expect(tools.length).toBe(0);
    });

    it("does not throw when stdio command is invalid (connection fails)", async () => {
        const tools = await createMcpToolsForSession({
            mcpServers: [{ transport: "stdio", command: "/nonexistent/mcp-server-binary" }],
        });
        expect(Array.isArray(tools)).toBe(true);
        expect(tools.length).toBe(0);
    });
});
