/**
 * 长记忆模块单元测试：addMemory、searchMemory、getExperienceContext、getCompactionContext
 * 在无 RAG 配置且本地 embedding 不可用（或未加载）时，验证空转逻辑与 API 契约
 * 通过 jest.config.cjs 的 moduleNameMapper 将 @mariozechner/pi-coding-agent 指向 test/mocks/pi-coding-agent.js
 */
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
    initMemory,
    addMemory,
    searchMemory,
    getExperienceContextForUserMessage,
    getCompactionContextForSystemPrompt,
} from "../../../src/core/memory/index.js";

describe("core/memory (index)", () => {
    let testDir: string;
    let originalAgentDir: string | undefined;
    let originalHome: string | undefined;

    beforeAll(() => {
        originalAgentDir = process.env.OPENBOT_AGENT_DIR;
        originalHome = process.env.HOME;
        testDir = join(tmpdir(), `openbot-memory-index-${Date.now()}`);
        mkdirSync(join(testDir, ".openbot", "desktop"), { recursive: true });
        mkdirSync(join(testDir, ".openbot", "agent"), { recursive: true });
        process.env.OPENBOT_AGENT_DIR = join(testDir, ".openbot", "agent");
        process.env.HOME = testDir;
    });

    afterAll(() => {
        if (originalAgentDir !== undefined) process.env.OPENBOT_AGENT_DIR = originalAgentDir;
        else delete process.env.OPENBOT_AGENT_DIR;
        if (originalHome !== undefined) process.env.HOME = originalHome;
        else delete process.env.HOME;
        if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    });

    it("initMemory does not throw", async () => {
        await expect(initMemory()).resolves.toBeUndefined();
    });

    it(
        "addMemory returns non-empty id even when embed returns null (no-op write)",
        async () => {
            const id = await addMemory("不会写入向量库的内容", {
                infotype: "experience",
                sessionId: "no-vec-session",
            });
            expect(typeof id).toBe("string");
            expect(id.length).toBeGreaterThan(0);
        },
        15000,
    );

    it("searchMemory returns empty array when embed returns null", async () => {
        const results = await searchMemory("任意查询", 5);
        expect(Array.isArray(results)).toBe(true);
        expect(results).toHaveLength(0);
    });

    it("getExperienceContextForUserMessage returns string (empty when no experience)", async () => {
        const block = await getExperienceContextForUserMessage();
        expect(typeof block).toBe("string");
        if (block.trim().length > 0) {
            expect(block).toContain("以下为相关经验");
        }
    });

    it("getCompactionContextForSystemPrompt returns string (empty when no compaction)", async () => {
        const block = await getCompactionContextForSystemPrompt("session-1");
        expect(typeof block).toBe("string");
        if (block.trim().length > 0) {
            expect(block).toContain("历史对话摘要");
        }
    });

    it("searchMemory with options accepts topK and infotype", async () => {
        const results = await searchMemory("经验", 3, { infotype: "experience", topK: 3 });
        expect(Array.isArray(results)).toBe(true);
    });
});
