/**
 * 向量库单元测试：addToStore、queryStore、按 infotype/sessionId 过滤
 */
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { addToStore, queryStore } from "../../../src/core/memory/vector-store.js";

const TEST_VECTOR_DIM = 8;

function makeVector(seed: number): number[] {
    const v = new Array(TEST_VECTOR_DIM).fill(0).map((_, i) => (seed + i) * 0.1);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
}

describe("core/memory/vector-store", () => {
    let testDir: string;
    let originalAgentDir: string | undefined;

    beforeAll(() => {
        originalAgentDir = process.env.OPENBOT_AGENT_DIR;
        testDir = join(tmpdir(), `openbot-memory-vectra-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });
        process.env.OPENBOT_AGENT_DIR = testDir;
    });

    afterAll(() => {
        if (originalAgentDir !== undefined) process.env.OPENBOT_AGENT_DIR = originalAgentDir;
        else delete process.env.OPENBOT_AGENT_DIR;
        if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    });

    it("addToStore and queryStore return matching documents", async () => {
        const id = "id-1";
        const vec = makeVector(1);
        await addToStore(id, vec, "这是一条经验总结", {
            infotype: "experience",
            sessionId: "s1",
            createdAt: new Date().toISOString(),
        });

        const results = await queryStore(vec, 5);
        expect(results.length).toBeGreaterThanOrEqual(1);
        const first = results.find((r) => r.metadata.sessionId === "s1" && r.document === "这是一条经验总结");
        expect(first).toBeDefined();
        expect(first!.metadata.infotype).toBe("experience");
    });

    it("queryStore with infotype filter returns only that type", async () => {
        const vExp = makeVector(10);
        const vComp = makeVector(20);
        await addToStore("exp-1", vExp, "经验A", {
            infotype: "experience",
            sessionId: "s1",
            createdAt: new Date().toISOString(),
        });
        await addToStore("comp-1", vComp, "摘要B", {
            infotype: "compaction",
            sessionId: "s1",
            createdAt: new Date().toISOString(),
        });

        const experienceOnly = await queryStore(vExp, 5, { infotype: "experience" });
        expect(experienceOnly.every((r) => r.metadata.infotype === "experience")).toBe(true);

        const compactionOnly = await queryStore(vComp, 5, { infotype: "compaction" });
        expect(compactionOnly.every((r) => r.metadata.infotype === "compaction")).toBe(true);
    });

    it("queryStore with sessionId filter returns only that session", async () => {
        const v1 = makeVector(30);
        await addToStore("s2-exp", v1, "会话2的经验", {
            infotype: "experience",
            sessionId: "s2",
            createdAt: new Date().toISOString(),
        });

        const forS2 = await queryStore(v1, 5, { sessionId: "s2" });
        expect(forS2.length).toBeGreaterThanOrEqual(1);
        expect(forS2.every((r) => r.metadata.sessionId === "s2")).toBe(true);
    });
});
