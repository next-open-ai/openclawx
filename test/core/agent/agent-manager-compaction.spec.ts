/**
 * 会话关闭时将缓存的 compaction 写入向量库的逻辑（persist-compaction-on-close）单元测试
 */
import {
    persistStoredCompactionForSession,
    persistStoredCompactionForBusinessSession,
} from "../../../src/core/memory/persist-compaction-on-close.js";

describe("persist compaction on session close", () => {
    const mockAddMemory = jest.fn().mockResolvedValue(undefined);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("persistStoredCompactionForSession", () => {
        it("calls addMemory with trimmed summary and infotype compaction, then deletes from map", async () => {
            const map = new Map<string, string>();
            map.set("business-session-1::default", "  本次会话的 compaction 摘要  ");

            await persistStoredCompactionForSession(map, "business-session-1::default", mockAddMemory);

            expect(mockAddMemory).toHaveBeenCalledTimes(1);
            expect(mockAddMemory).toHaveBeenCalledWith("本次会话的 compaction 摘要", {
                infotype: "compaction",
                sessionId: "business-session-1",
            });
            expect(map.has("business-session-1::default")).toBe(false);
        });

        it("does not call addMemory when no summary stored", async () => {
            const map = new Map<string, string>();

            await persistStoredCompactionForSession(map, "no-summary::default", mockAddMemory);

            expect(mockAddMemory).not.toHaveBeenCalled();
        });

        it("deletes key from map even when summary is empty so map is cleared", async () => {
            const map = new Map<string, string>();
            map.set("s1::default", "  \n  ");

            await persistStoredCompactionForSession(map, "s1::default", mockAddMemory);

            expect(mockAddMemory).not.toHaveBeenCalled();
            expect(map.has("s1::default")).toBe(false);
        });

        it("does not throw when addMemory rejects", async () => {
            const map = new Map<string, string>();
            map.set("s1::default", "summary");
            mockAddMemory.mockRejectedValueOnce(new Error("network error"));

            await expect(
                persistStoredCompactionForSession(map, "s1::default", mockAddMemory),
            ).resolves.toBeUndefined();
            expect(map.has("s1::default")).toBe(false);
        });
    });

    describe("persistStoredCompactionForBusinessSession", () => {
        it("writes each matching key summary and clears those entries", async () => {
            const sessionId = "feishu-thread-1";
            const map = new Map<string, string>();
            map.set(sessionId + "::default", "summary A");
            map.set(sessionId + "::agent2", "summary B");
            const keysToProcess = [sessionId + "::default", sessionId + "::agent2"];

            await persistStoredCompactionForBusinessSession(map, keysToProcess, sessionId, mockAddMemory);

            expect(mockAddMemory).toHaveBeenCalledTimes(2);
            expect(mockAddMemory).toHaveBeenCalledWith("summary A", {
                infotype: "compaction",
                sessionId,
            });
            expect(mockAddMemory).toHaveBeenCalledWith("summary B", {
                infotype: "compaction",
                sessionId,
            });
            expect(map.size).toBe(0);
        });

        it("skips keys not starting with sessionId prefix and does not delete them", async () => {
            const map = new Map<string, string>();
            map.set("other::default", "other");
            const keysToProcess = ["other::default"];

            await persistStoredCompactionForBusinessSession(map, keysToProcess, "feishu-1", mockAddMemory);

            expect(mockAddMemory).not.toHaveBeenCalled();
            expect(map.has("other::default")).toBe(true);
        });

        it("does not call addMemory when session has no stored compaction for those keys", async () => {
            const map = new Map<string, string>();
            const keysToProcess = ["s1::default"];

            await persistStoredCompactionForBusinessSession(map, keysToProcess, "s1", mockAddMemory);

            expect(mockAddMemory).not.toHaveBeenCalled();
        });
    });
});
