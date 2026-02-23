/**
 * Compaction 扩展单元测试：session_compact 时仅回调 onUpdateLatestCompaction(summary)，不写向量库
 */
import { createCompactionMemoryExtensionFactory } from "../../../src/core/memory/compaction-extension.js";

describe("core/memory/compaction-extension", () => {
    it("invokes onUpdateLatestCompaction with trimmed summary when session_compact fires", () => {
        const onUpdate = jest.fn();
        const factory = createCompactionMemoryExtensionFactory("session-1", onUpdate);

        const handlers: Record<string, (event: any) => void> = {};
        const mockPi = {
            on: (event: string, handler: (e: any) => void) => {
                handlers[event] = handler;
            },
        };

        factory(mockPi as any);

        expect(handlers["session_compact"]).toBeDefined();
        handlers["session_compact"]({
            compactionEntry: { summary: "  本轮对话摘要内容  " },
        });

        expect(onUpdate).toHaveBeenCalledTimes(1);
        expect(onUpdate).toHaveBeenCalledWith("本轮对话摘要内容");
    });

    it("does not invoke callback when summary is missing or empty", () => {
        const onUpdate = jest.fn();
        const factory = createCompactionMemoryExtensionFactory("s2", onUpdate);

        const handlers: Record<string, (event: any) => void> = {};
        const mockPi = { on: (event: string, handler: (e: any) => void) => { handlers[event] = handler; } };
        factory(mockPi as any);

        handlers["session_compact"]({ compactionEntry: {} });
        handlers["session_compact"]({ compactionEntry: { summary: "" } });
        handlers["session_compact"]({ compactionEntry: { summary: "   \n  " } });
        handlers["session_compact"]({});

        expect(onUpdate).not.toHaveBeenCalled();
    });
});
