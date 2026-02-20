/**
 * AgentConfigService 单元测试：listAgents、getAgent、createAgent、updateAgent、deleteAgent
 */
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { AgentConfigModule } from "../../src/server/agent-config/agent-config.module.js";
import { AgentConfigService, DEFAULT_AGENT_ID } from "../../src/server/agent-config/agent-config.service.js";

describe("AgentConfigService", () => {
    let service: AgentConfigService;
    let testDir: string;
    let desktopDir: string;
    let originalHome: string | undefined;

    beforeAll(() => {
        originalHome = process.env.HOME;
        testDir = join(tmpdir(), `openbot-agent-config-test-${Date.now()}`);
        desktopDir = join(testDir, ".openbot", "desktop");
        mkdirSync(desktopDir, { recursive: true });
        process.env.HOME = testDir;
    });

    afterAll(() => {
        if (originalHome !== undefined) process.env.HOME = originalHome;
        else delete process.env.HOME;
        if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    });

    beforeEach(async () => {
        const agentsPath = join(desktopDir, "agents.json");
        if (existsSync(agentsPath)) rmSync(agentsPath);
        const module: TestingModule = await Test.createTestingModule({
            imports: [AgentConfigModule],
        }).compile();
        service = module.get(AgentConfigService);
    });

    describe("listAgents", () => {
        it("returns default agent when agents.json is empty or missing", async () => {
            const list = await service.listAgents();
            expect(list.length).toBeGreaterThanOrEqual(1);
            expect(list[0].id).toBe(DEFAULT_AGENT_ID);
            expect(list[0].isDefault).toBe(true);
        });

        it("returns custom agents after default", async () => {
            await service.createAgent({ name: "My Agent", workspace: "my-agent" });
            const list = await service.listAgents();
            expect(list.length).toBe(2);
            expect(list[0].id).toBe(DEFAULT_AGENT_ID);
            expect(list[1].id).toBe("my-agent");
            expect(list[1].name).toBe("My Agent");
        });
    });

    describe("getAgent", () => {
        it("returns default agent when id is default", async () => {
            const agent = await service.getAgent(DEFAULT_AGENT_ID);
            expect(agent).not.toBeNull();
            expect(agent!.id).toBe(DEFAULT_AGENT_ID);
            expect(agent!.isDefault).toBe(true);
        });

        it("returns null for unknown id", async () => {
            const agent = await service.getAgent("unknown-id");
            expect(agent).toBeNull();
        });

        it("returns created agent by id", async () => {
            await service.createAgent({ name: "Test", workspace: "test-ws" });
            const agent = await service.getAgent("test-ws");
            expect(agent).not.toBeNull();
            expect(agent!.id).toBe("test-ws");
            expect(agent!.workspace).toBe("test-ws");
        });
    });

    describe("createAgent", () => {
        it("creates agent with name and workspace only", async () => {
            const agent = await service.createAgent({ name: "Code Review", workspace: "code-review" });
            expect(agent.id).toBe("code-review");
            expect(agent.name).toBe("Code Review");
            expect(agent.workspace).toBe("code-review");
            expect(agent.provider).toBeUndefined();
            expect(agent.model).toBeUndefined();
            expect(agent.systemPrompt).toBeUndefined();
        });

        it("creates agent with optional provider, model, systemPrompt", async () => {
            const agent = await service.createAgent({
                name: "Beauty",
                workspace: "beauty",
                provider: "deepseek",
                model: "deepseek-chat",
                systemPrompt: "You are a beauty assistant.",
            });
            expect(agent.provider).toBe("deepseek");
            expect(agent.model).toBe("deepseek-chat");
            expect(agent.systemPrompt).toBe("You are a beauty assistant.");
        });

        it("rejects workspace default", async () => {
            await expect(service.createAgent({ name: "X", workspace: "default" })).rejects.toThrow(
                BadRequestException,
            );
        });

        it("rejects invalid workspace format", async () => {
            await expect(service.createAgent({ name: "X", workspace: "有空格" })).rejects.toThrow(BadRequestException);
            await expect(service.createAgent({ name: "X", workspace: "a b" })).rejects.toThrow(BadRequestException);
        });

        it("rejects duplicate workspace", async () => {
            await service.createAgent({ name: "First", workspace: "dup" });
            await expect(service.createAgent({ name: "Second", workspace: "dup" })).rejects.toThrow(
                ConflictException,
            );
        });

        it("uses workspace as name when name is empty", async () => {
            const agent = await service.createAgent({ name: "", workspace: "auto-name" });
            expect(agent.name).toBe("auto-name");
        });
    });

    describe("updateAgent", () => {
        it("updates name and systemPrompt", async () => {
            await service.createAgent({ name: "Old", workspace: "upd-ws" });
            const updated = await service.updateAgent("upd-ws", {
                name: "New Name",
                systemPrompt: "Updated prompt.",
            });
            expect(updated.name).toBe("New Name");
            expect(updated.systemPrompt).toBe("Updated prompt.");
        });

        it("clears systemPrompt when set to empty string", async () => {
            await service.createAgent({ name: "X", workspace: "clear-sp", systemPrompt: "Had prompt" });
            const updated = await service.updateAgent("clear-sp", { systemPrompt: "" });
            expect(updated.systemPrompt).toBeUndefined();
        });

        it("throws NotFoundException for unknown id", async () => {
            await expect(service.updateAgent("no-such-id", { name: "X" })).rejects.toThrow(NotFoundException);
        });
    });

    describe("deleteAgent", () => {
        it("deletes non-default agent", async () => {
            await service.createAgent({ name: "To Delete", workspace: "to-del" });
            await service.deleteAgent("to-del");
            const agent = await service.getAgent("to-del");
            expect(agent).toBeNull();
        });

        it("rejects deleting default agent", async () => {
            await expect(service.deleteAgent(DEFAULT_AGENT_ID)).rejects.toThrow(BadRequestException);
        });
    });
});
