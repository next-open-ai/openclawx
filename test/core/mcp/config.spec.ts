/**
 * MCP 配置解析单元测试
 */
import { resolveMcpServersForSession, stdioConfigKey, sseConfigKey } from "../../../src/core/mcp/config.js";
import type { McpServerConfigStdio, McpServerConfigSse } from "../../../src/core/mcp/types.js";

describe("core/mcp/config", () => {
    describe("resolveMcpServersForSession", () => {
        it("returns [] when mcpServers is undefined", () => {
            expect(resolveMcpServersForSession(undefined)).toEqual([]);
        });

        it("returns [] when mcpServers is empty array", () => {
            expect(resolveMcpServersForSession([])).toEqual([]);
        });

        it("keeps valid stdio config and normalizes", () => {
            const input = [
                { transport: "stdio" as const, command: "  npx  ", args: ["-y", "mcp-server"] },
            ];
            const out = resolveMcpServersForSession(input);
            expect(out).toHaveLength(1);
            expect(out[0].transport).toBe("stdio");
            expect((out[0] as McpServerConfigStdio).command).toBe("npx");
            expect((out[0] as McpServerConfigStdio).args).toEqual(["-y", "mcp-server"]);
        });

        it("skips stdio config without command", () => {
            const input = [{ transport: "stdio" as const, command: "" }];
            expect(resolveMcpServersForSession(input)).toHaveLength(0);
        });

        it("keeps valid sse config", () => {
            const input = [{ transport: "sse" as const, url: "http://localhost:8080" }];
            const out = resolveMcpServersForSession(input);
            expect(out).toHaveLength(1);
            expect(out[0].transport).toBe("sse");
            expect((out[0] as any).url).toBe("http://localhost:8080");
        });

        it("filters invalid entries", () => {
            const input = [
                null,
                { transport: "stdio", command: "ok" },
                { transport: "stdio", command: "" },
                {},
            ] as any;
            const out = resolveMcpServersForSession(input);
            expect(out).toHaveLength(1);
            expect((out[0] as McpServerConfigStdio).command).toBe("ok");
        });
    });

    describe("stdioConfigKey", () => {
        it("returns stable key for same config", () => {
            const a: McpServerConfigStdio = { transport: "stdio", command: "node", args: ["a"] };
            const b: McpServerConfigStdio = { transport: "stdio", command: "node", args: ["a"] };
            expect(stdioConfigKey(a)).toBe(stdioConfigKey(b));
        });

        it("returns different key for different args", () => {
            const a: McpServerConfigStdio = { transport: "stdio", command: "node", args: ["a"] };
            const b: McpServerConfigStdio = { transport: "stdio", command: "node", args: ["b"] };
            expect(stdioConfigKey(a)).not.toBe(stdioConfigKey(b));
        });
    });

    describe("sseConfigKey", () => {
        it("returns stable key for same config", () => {
            const a: McpServerConfigSse = { transport: "sse", url: "https://x.com" };
            const b: McpServerConfigSse = { transport: "sse", url: "https://x.com" };
            expect(sseConfigKey(a)).toBe(sseConfigKey(b));
        });
    });
});
