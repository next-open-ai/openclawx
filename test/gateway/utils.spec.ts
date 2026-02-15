/**
 * Gateway utils 单元测试：parseMessage、createErrorResponse、createSuccessResponse、createEvent
 */
import {
    parseMessage,
    createErrorResponse,
    createSuccessResponse,
    createEvent,
} from "../../src/gateway/utils.js";

describe("gateway/utils", () => {
    describe("parseMessage", () => {
        it("parses valid request JSON", () => {
            const msg = parseMessage(JSON.stringify({ type: "request", id: "1", method: "connect", params: {} }));
            expect(msg).not.toBeNull();
            expect(msg!.type).toBe("request");
            expect((msg as any).id).toBe("1");
            expect((msg as any).method).toBe("connect");
        });

        it("parses Buffer input", () => {
            const msg = parseMessage(Buffer.from(JSON.stringify({ type: "response", id: "2", result: { ok: true } })));
            expect(msg).not.toBeNull();
            expect(msg!.type).toBe("response");
            expect((msg as any).result?.ok).toBe(true);
        });

        it("infers type request when method present and type missing", () => {
            const msg = parseMessage(JSON.stringify({ id: "3", method: "agent.chat", params: { message: "hi" } }));
            expect(msg).not.toBeNull();
            expect(msg!.type).toBe("request");
        });

        it("returns null for invalid JSON", () => {
            expect(parseMessage("not json")).toBeNull();
        });
    });

    describe("createErrorResponse", () => {
        it("returns response with error", () => {
            const msg = createErrorResponse("req-1", "Something failed", "INTERNAL");
            expect(msg.type).toBe("response");
            expect((msg as any).id).toBe("req-1");
            expect(msg.error?.message).toBe("Something failed");
            expect(msg.error?.code).toBe("INTERNAL");
        });
    });

    describe("createSuccessResponse", () => {
        it("returns response with result", () => {
            const msg = createSuccessResponse("req-2", { sessionId: "s1" });
            expect(msg.type).toBe("response");
            expect((msg as any).id).toBe("req-2");
            expect((msg as any).result?.sessionId).toBe("s1");
        });
    });

    describe("createEvent", () => {
        it("returns event message", () => {
            const msg = createEvent("agent.chunk", { delta: "hello" });
            expect(msg.type).toBe("event");
            expect((msg as any).event).toBe("agent.chunk");
            expect((msg as any).payload?.delta).toBe("hello");
        });
    });
});
