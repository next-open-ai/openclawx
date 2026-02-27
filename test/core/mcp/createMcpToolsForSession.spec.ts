/**
 * createMcpToolsForSession 单元测试（无真实 MCP 进程）
 */
import { createMcpToolsForSession } from "../../../src/core/mcp/index.js";
import type { ISessionOutlet } from "../../../src/core/session-outlet/index.js";

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

    it("emits mcp.progress system messages via sessionOutlet when sessionId and outlet provided", async () => {
        const emitted: { sessionId: string; message: { type: string; code?: string; payload?: unknown } }[] = [];
        const sessionOutlet: ISessionOutlet = {
            emit(sessionId, message) {
                emitted.push({ sessionId, message: { type: message.type, code: message.code, payload: message.payload } });
            },
            registerConsumer() {
                return () => {};
            },
        };
        await createMcpToolsForSession({
            mcpServers: [{ transport: "stdio", command: "/nonexistent/mcp-server-binary" }],
            sessionId: "test-session-1",
            sessionOutlet,
        });
        expect(emitted.length).toBeGreaterThanOrEqual(1);
        const progressMessages = emitted.filter((e) => e.message.type === "system" && e.message.code === "mcp.progress");
        expect(progressMessages.length).toBeGreaterThanOrEqual(1);
        expect(progressMessages[0].sessionId).toBe("test-session-1");
        expect(progressMessages[0].message.payload).toEqual(
            expect.objectContaining({ phase: expect.any(String) })
        );
    });
});
