/**
 * MCP 配置解析单元测试
 */
import {
    resolveMcpServersForSession,
    standardFormatToArray,
    arrayToStandardFormat,
    stdioConfigKey,
    sseConfigKey,
} from "../../../src/core/mcp/config.js";
import type { McpServerConfigStdio, McpServerConfigSse } from "../../../src/core/mcp/types.js";

describe("core/mcp/config", () => {
    describe("resolveMcpServersForSession", () => {
        it("returns [] when mcpServers is undefined", () => {
            expect(resolveMcpServersForSession(undefined)).toEqual([]);
        });

        it("returns [] when mcpServers is empty array", () => {
            expect(resolveMcpServersForSession([])).toEqual([]);
        });

        it("accepts standard format object and normalizes to array", () => {
            const input = {
                "YingDao RPA MCP Server": {
                    command: "npx",
                    args: ["-y", "yingdao-mcp-server"],
                    env: { RPA_MODEL: "openApi", ACCESS_KEY_ID: "xxx" },
                },
            };
            const out = resolveMcpServersForSession(input);
            expect(out).toHaveLength(1);
            expect(out[0].transport).toBe("stdio");
            expect((out[0] as McpServerConfigStdio).command).toBe("npx");
            expect((out[0] as McpServerConfigStdio).args).toEqual(["-y", "yingdao-mcp-server"]);
            expect((out[0] as McpServerConfigStdio).env).toEqual({ RPA_MODEL: "openApi", ACCESS_KEY_ID: "xxx" });
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

    describe("standardFormatToArray", () => {
        it("converts stdio entry to array item", () => {
            const out = standardFormatToArray({
                MyServer: { command: "npx", args: ["-y", "mcp"], env: { FOO: "bar" } },
            });
            expect(out).toHaveLength(1);
            expect(out[0].transport).toBe("stdio");
            expect((out[0] as McpServerConfigStdio).command).toBe("npx");
            expect((out[0] as McpServerConfigStdio).env).toEqual({ FOO: "bar" });
        });

        it("converts sse entry when url present", () => {
            const out = standardFormatToArray({
                Remote: { url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } },
            });
            expect(out).toHaveLength(1);
            expect(out[0].transport).toBe("sse");
            expect((out[0] as McpServerConfigSse).url).toBe("https://example.com/mcp");
        });
    });

    describe("arrayToStandardFormat", () => {
        it("produces object with generated names", () => {
            const arr: McpServerConfigStdio[] = [
                { transport: "stdio", command: "npx", args: ["-y", "x"] },
            ];
            const obj = arrayToStandardFormat(arr);
            expect(Object.keys(obj)).toContain("MCP Server 1");
            expect(obj["MCP Server 1"].command).toBe("npx");
            expect(obj["MCP Server 1"].args).toEqual(["-y", "x"]);
        });
    });
});
