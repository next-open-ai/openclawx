/**
 * 会话消息统一出口单元测试：验证 registerConsumer、emit、sendSessionMessage 与按 sessionId 路由。
 */
import { SessionOutlet, getSessionOutlet, setSessionOutlet, sendSessionMessage } from "../../../src/core/session-outlet/index.js";
import type { SessionMessage } from "../../../src/core/session-outlet/index.js";

describe("core/session-outlet", () => {
    beforeEach(() => {
        setSessionOutlet(null);
    });

    describe("SessionOutlet", () => {
        it("emit delivers message to registered consumer for that sessionId", () => {
            const outlet = new SessionOutlet();
            const received: SessionMessage[] = [];
            outlet.registerConsumer("s1", {
                send(msg) {
                    received.push(msg);
                },
            });
            outlet.emit("s1", { type: "system", code: "command.result", payload: { text: "hi" } });
            expect(received).toHaveLength(1);
            expect(received[0].sessionId).toBe("s1");
            expect(received[0].type).toBe("system");
            expect(received[0].code).toBe("command.result");
            expect(received[0].payload).toEqual({ text: "hi" });
            expect(typeof received[0].timestamp).toBe("number");
        });

        it("emit does not deliver to consumers of other sessionIds", () => {
            const outlet = new SessionOutlet();
            const s1Received: SessionMessage[] = [];
            const s2Received: SessionMessage[] = [];
            outlet.registerConsumer("s1", { send(m) { s1Received.push(m); } });
            outlet.registerConsumer("s2", { send(m) { s2Received.push(m); } });
            outlet.emit("s1", { type: "chat", code: "agent.chunk", payload: { text: "only s1" } });
            expect(s1Received).toHaveLength(1);
            expect(s2Received).toHaveLength(0);
        });

        it("multiple consumers for same sessionId all receive", () => {
            const outlet = new SessionOutlet();
            const a: SessionMessage[] = [];
            const b: SessionMessage[] = [];
            outlet.registerConsumer("s1", { send(m) { a.push(m); } });
            outlet.registerConsumer("s1", { send(m) { b.push(m); } });
            outlet.emit("s1", { type: "system", code: "mcp.progress", payload: { phase: "connecting" } });
            expect(a).toHaveLength(1);
            expect(b).toHaveLength(1);
            expect(a[0].payload).toEqual({ phase: "connecting" });
            expect(b[0].payload).toEqual({ phase: "connecting" });
        });

        it("unregister stops delivery to that consumer", () => {
            const outlet = new SessionOutlet();
            const received: SessionMessage[] = [];
            const unregister = outlet.registerConsumer("s1", { send(m) { received.push(m); } });
            outlet.emit("s1", { type: "chat", code: "agent.chunk", payload: { text: "1" } });
            expect(received).toHaveLength(1);
            unregister();
            outlet.emit("s1", { type: "chat", code: "agent.chunk", payload: { text: "2" } });
            expect(received).toHaveLength(1);
        });

        it("emit with no consumers for sessionId does not throw", () => {
            const outlet = new SessionOutlet();
            expect(() => {
                outlet.emit("nonexistent", { type: "system", code: "command.result", payload: {} });
            }).not.toThrow();
        });
    });

    describe("getSessionOutlet / setSessionOutlet", () => {
        it("getSessionOutlet returns null when not set", () => {
            expect(getSessionOutlet()).toBeNull();
        });

        it("getSessionOutlet returns outlet after setSessionOutlet", () => {
            const outlet = new SessionOutlet();
            setSessionOutlet(outlet);
            expect(getSessionOutlet()).toBe(outlet);
            setSessionOutlet(null);
            expect(getSessionOutlet()).toBeNull();
        });
    });

    describe("sendSessionMessage", () => {
        it("does nothing when outlet is not set", () => {
            expect(() => sendSessionMessage("s1", { type: "system", code: "command.result", payload: { text: "hi" } })).not.toThrow();
        });

        it("does nothing when sessionId is empty", () => {
            const outlet = new SessionOutlet();
            const received: SessionMessage[] = [];
            outlet.registerConsumer("s1", { send(m) { received.push(m); } });
            setSessionOutlet(outlet);
            sendSessionMessage("", { type: "system", code: "command.result", payload: { text: "hi" } });
            expect(received).toHaveLength(0);
        });

        it("emits via outlet when set and sessionId provided", () => {
            const outlet = new SessionOutlet();
            const received: SessionMessage[] = [];
            outlet.registerConsumer("my-session", { send(m) { received.push(m); } });
            setSessionOutlet(outlet);
            sendSessionMessage("my-session", { type: "system", code: "command.result", payload: { text: "已切换" } });
            expect(received).toHaveLength(1);
            expect(received[0].sessionId).toBe("my-session");
            expect(received[0].type).toBe("system");
            expect(received[0].payload).toEqual({ text: "已切换" });
        });
    });
});
