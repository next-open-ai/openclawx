/**
 * create_agent 工具单元测试：无 provider、缺 name、缺省 workspace/systemPrompt、成功与失败返回
 */
import { createCreateAgentTool } from "../../../src/core/tools/create-agent-tool.js";
import {
    setCreateAgentProvider,
    getCreateAgentProvider,
} from "../../../src/core/session-current-agent.js";

const noopCtx = {} as any;

describe("core/tools/create-agent-tool", () => {
    let tool: ReturnType<typeof createCreateAgentTool>;

    beforeAll(() => {
        tool = createCreateAgentTool();
    });

    afterEach(() => {
        setCreateAgentProvider(null);
    });

    it("exposes name and parameters schema", () => {
        expect(tool.name).toBe("create_agent");
        expect(tool.label).toBe("Create Agent");
        expect(tool.parameters).toBeDefined();
    });

    it("returns unsupported when provider is not set", async () => {
        const result = await tool.execute!("tc1", {}, undefined, undefined, noopCtx);
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe("text");
        expect((result.content[0] as any).text).toContain("当前环境不支持创建智能体");
    });

    it("returns error when name is empty", async () => {
        setCreateAgentProvider(async () => ({ id: "x", name: "x" }));
        const result = await tool.execute!("tc2", { name: "  " }, undefined, undefined, noopCtx);
        expect((result.content[0] as any).text).toContain("请提供智能体名称");
    });

    it("calls provider with name, derived workspace and default systemPrompt when only name given", async () => {
        const received: any[] = [];
        setCreateAgentProvider(async (params) => {
            received.push({ ...params });
            return { id: params.workspace, name: params.name };
        });
        await tool.execute!("tc3", { name: "Beauty Assistant" }, undefined, undefined, noopCtx);
        expect(received).toHaveLength(1);
        expect(received[0].name).toBe("Beauty Assistant");
        expect(received[0].workspace).toBe("beauty-assistant");
        expect(received[0].systemPrompt).toContain("helpful assistant customized");
    });

    it("uses zh default systemPrompt when language is zh", async () => {
        const received: any[] = [];
        setCreateAgentProvider(async (params) => {
            received.push({ ...params });
            return { id: params.workspace, name: params.name };
        });
        await tool.execute!("tc4", { name: "美妆助手", language: "zh" }, undefined, undefined, noopCtx);
        expect(received[0].systemPrompt).toContain("根据用户需求定制的助手");
    });

    it("uses provided workspace and system_prompt when given", async () => {
        const received: any[] = [];
        setCreateAgentProvider(async (params) => {
            received.push({ ...params });
            return { id: params.workspace, name: params.name };
        });
        await tool.execute!("tc5", {
            name: "Code Review",
            workspace: "code-review",
            system_prompt: "You are a code reviewer.",
        }, undefined, undefined, noopCtx);
        expect(received[0].workspace).toBe("code-review");
        expect(received[0].systemPrompt).toBe("You are a code reviewer.");
    });

    it("returns success text and details when provider returns id and name", async () => {
        setCreateAgentProvider(async () => ({ id: "my-agent", name: "My Agent" }));
        const result = await tool.execute!("tc6", { name: "My Agent" }, undefined, undefined, noopCtx);
        expect((result.content[0] as any).text).toContain("已创建智能体");
        expect((result.content[0] as any).text).toContain("my-agent");
        expect(result.details).toEqual({ id: "my-agent", name: "My Agent" });
    });

    it("returns error text when provider returns error", async () => {
        setCreateAgentProvider(async () => ({ error: "该工作空间名已存在" }));
        const result = await tool.execute!("tc7", { name: "Dup", workspace: "dup" }, undefined, undefined, noopCtx);
        expect((result.content[0] as any).text).toContain("创建失败");
        expect((result.content[0] as any).text).toContain("该工作空间名已存在");
        expect(result.details).toBeUndefined();
    });

    it("replaces reserved workspace default with agent-timestamp", async () => {
        const received: any[] = [];
        setCreateAgentProvider(async (params) => {
            received.push({ ...params });
            return { id: params.workspace, name: params.name };
        });
        await tool.execute!("tc8", { name: "default", workspace: "default" }, undefined, undefined, noopCtx);
        expect(received[0].workspace).not.toBe("default");
        expect(received[0].workspace).toMatch(/^agent-[a-z0-9]+$/);
    });
});
