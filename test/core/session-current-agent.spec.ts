/**
 * session-current-agent 单元测试：CreateAgentProvider 的 set/get
 */
import {
    setCreateAgentProvider,
    getCreateAgentProvider,
} from "../../src/core/session-current-agent.js";

describe("core/session-current-agent", () => {
    afterEach(() => {
        setCreateAgentProvider(null);
    });

    it("getCreateAgentProvider returns null when not set", () => {
        expect(getCreateAgentProvider()).toBeNull();
    });

    it("getCreateAgentProvider returns the set provider", async () => {
        const fn = async (params: any) => ({ id: params.workspace, name: params.name });
        setCreateAgentProvider(fn);
        expect(getCreateAgentProvider()).toBe(fn);
        const result = await getCreateAgentProvider()!({ name: "X", workspace: "x" });
        expect(result).toEqual({ id: "x", name: "X" });
    });

    it("setCreateAgentProvider(null) clears provider", () => {
        setCreateAgentProvider(async () => ({ id: "a", name: "A" }));
        expect(getCreateAgentProvider()).not.toBeNull();
        setCreateAgentProvider(null);
        expect(getCreateAgentProvider()).toBeNull();
    });
});
