/**
 * 桌面配置模块单元测试：getDesktopConfig、getBoundAgentIdForCli、loadDesktopAgentConfig
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
    getDesktopConfig,
    getBoundAgentIdForCli,
    loadDesktopAgentConfig,
    setProviderApiKey,
    setDefaultModel,
    getDesktopConfigList,
    getProviderSupport,
    ensureProviderSupportFile,
    syncDesktopConfigToModelsJson,
    getRagEmbeddingConfigSync,
} from "../../src/core/config/desktop-config.js";
import { getOpenbotAgentDir } from "../../src/core/agent/agent-dir.js";

describe("config/desktop-config", () => {
    let testDir: string;
    let desktopDir: string;
    let originalHome: string | undefined;

    beforeAll(() => {
        originalHome = process.env.HOME;
        testDir = join(tmpdir(), `openbot-desktop-config-test-${Date.now()}`);
        desktopDir = join(testDir, ".openbot", "desktop");
        mkdirSync(desktopDir, { recursive: true });
        process.env.HOME = testDir;
    });

    afterAll(() => {
        if (originalHome !== undefined) process.env.HOME = originalHome;
        else delete process.env.HOME;
        if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    });

    beforeEach(() => {
        // 清空桌面配置目录下的文件，避免用例间互相影响
        try {
            const configPath = join(desktopDir, "config.json");
            const agentsPath = join(desktopDir, "agents.json");
            if (existsSync(configPath)) rmSync(configPath);
            if (existsSync(agentsPath)) rmSync(agentsPath);
        } catch {
            // ignore
        }
    });

    describe("getDesktopConfig", () => {
        it("returns default maxAgentSessions when config.json does not exist", () => {
            const result = getDesktopConfig();
            expect(result.maxAgentSessions).toBe(5);
        });

        it("returns maxAgentSessions from config.json when present", () => {
            writeFileSync(
                join(desktopDir, "config.json"),
                JSON.stringify({ maxAgentSessions: 10 }),
                "utf-8",
            );
            const result = getDesktopConfig();
            expect(result.maxAgentSessions).toBe(10);
        });

        it("returns default when maxAgentSessions is invalid", () => {
            writeFileSync(
                join(desktopDir, "config.json"),
                JSON.stringify({ maxAgentSessions: -1 }),
                "utf-8",
            );
            const result = getDesktopConfig();
            expect(result.maxAgentSessions).toBe(5);
        });
    });

    describe("getBoundAgentIdForCli", () => {
        it("returns default when no config", async () => {
            const id = await getBoundAgentIdForCli();
            expect(id).toBe("default");
        });

        it("returns defaultAgentId from config when set and exists in agents", async () => {
            writeFileSync(
                join(desktopDir, "config.json"),
                JSON.stringify({ defaultAgentId: "my-agent" }),
                "utf-8",
            );
            writeFileSync(
                join(desktopDir, "agents.json"),
                JSON.stringify({ agents: [{ id: "my-agent", workspace: "my-agent", name: "My" }] }),
                "utf-8",
            );
            const id = await getBoundAgentIdForCli();
            expect(id).toBe("my-agent");
        });

        it("returns default when defaultAgentId not in agents", async () => {
            writeFileSync(
                join(desktopDir, "config.json"),
                JSON.stringify({ defaultAgentId: "missing" }),
                "utf-8",
            );
            writeFileSync(
                join(desktopDir, "agents.json"),
                JSON.stringify({ agents: [{ id: "default", workspace: "default", name: "Main" }] }),
                "utf-8",
            );
            const id = await getBoundAgentIdForCli();
            expect(id).toBe("default");
        });
    });

    describe("loadDesktopAgentConfig", () => {
        it("returns default provider/model when config.json does not exist", async () => {
            const result = await loadDesktopAgentConfig("default");
            expect(result).not.toBeNull();
            expect(result!.provider).toBe("deepseek");
            expect(result!.model).toBe("deepseek-chat");
            expect(result!.apiKey).toBeUndefined();
        });

        it("returns provider/model/apiKey for default agent from config and agents", async () => {
            writeFileSync(
                join(desktopDir, "config.json"),
                JSON.stringify({
                    defaultProvider: "openai",
                    defaultModel: "gpt-4",
                    providers: { openai: { apiKey: "sk-test" } },
                }),
                "utf-8",
            );
            writeFileSync(
                join(desktopDir, "agents.json"),
                JSON.stringify({
                    agents: [{ id: "default", workspace: "default", provider: "openai", model: "gpt-4" }],
                }),
                "utf-8",
            );
            const result = await loadDesktopAgentConfig("default");
            expect(result).not.toBeNull();
            expect(result!.provider).toBe("openai");
            expect(result!.model).toBe("gpt-4");
            expect(result!.apiKey).toBe("sk-test");
        });

        it("uses agent-specific provider/model when present in agents", async () => {
            writeFileSync(
                join(desktopDir, "config.json"),
                JSON.stringify({
                    defaultProvider: "deepseek",
                    defaultModel: "deepseek-chat",
                    providers: {
                        deepseek: { apiKey: "sk-ds" },
                        dashscope: { apiKey: "sk-dash" },
                    },
                }),
                "utf-8",
            );
            writeFileSync(
                join(desktopDir, "agents.json"),
                JSON.stringify({
                    agents: [
                        { id: "default", workspace: "default" },
                        { id: "qwen", workspace: "qwen", provider: "dashscope", model: "qwen-max" },
                    ],
                }),
                "utf-8",
            );
            const result = await loadDesktopAgentConfig("qwen");
            expect(result).not.toBeNull();
            expect(result!.provider).toBe("dashscope");
            expect(result!.model).toBe("qwen-max");
            expect(result!.apiKey).toBe("sk-dash");
            expect(result!.workspace).toBe("qwen");
        });

        it("returns workspace from agent.workspace or agent.id", async () => {
            writeFileSync(
                join(desktopDir, "config.json"),
                JSON.stringify({ defaultProvider: "deepseek", defaultModel: "deepseek-chat" }),
                "utf-8",
            );
            writeFileSync(
                join(desktopDir, "agents.json"),
                JSON.stringify({
                    agents: [
                        { id: "default", workspace: "main-ws" },
                        { id: "no-ws", provider: "deepseek", model: "deepseek-chat" },
                    ],
                }),
                "utf-8",
            );
            const defaultResult = await loadDesktopAgentConfig("default");
            expect(defaultResult!.workspace).toBe("main-ws");
            const noWsResult = await loadDesktopAgentConfig("no-ws");
            expect(noWsResult!.workspace).toBe("no-ws");
        });

        it("returns systemPrompt when agent has systemPrompt", async () => {
            writeFileSync(
                join(desktopDir, "config.json"),
                JSON.stringify({ defaultProvider: "deepseek", defaultModel: "deepseek-chat" }),
                "utf-8",
            );
            writeFileSync(
                join(desktopDir, "agents.json"),
                JSON.stringify({
                    agents: [
                        { id: "custom", workspace: "custom", systemPrompt: "You are a code review assistant." },
                    ],
                }),
                "utf-8",
            );
            const result = await loadDesktopAgentConfig("custom");
            expect(result).not.toBeNull();
            expect(result!.systemPrompt).toBe("You are a code review assistant.");
        });
    });

    describe("setProviderApiKey / setDefaultModel / getDesktopConfigList", () => {
        it("setProviderApiKey writes to config.json and loadDesktopAgentConfig reads it", async () => {
            await setProviderApiKey("deepseek", "sk-test-123");
            expect(existsSync(join(desktopDir, "config.json"))).toBe(true);
            const result = await loadDesktopAgentConfig("default");
            expect(result!.apiKey).toBe("sk-test-123");
        });

        it("setDefaultModel writes defaultProvider and defaultModel", async () => {
            await setDefaultModel("dashscope", "qwen-max");
            const list = await getDesktopConfigList();
            expect(list.defaultProvider).toBe("dashscope");
            expect(list.defaultModel).toBe("qwen-max");
        });

        it("getDesktopConfigList returns providers with hasKey", async () => {
            await setProviderApiKey("openai", "sk-openai");
            await setDefaultModel("openai", "gpt-4");
            const list = await getDesktopConfigList();
            expect(list.providers.some((p) => p.provider === "openai" && p.hasKey)).toBe(true);
        });
    });

    describe("provider-support and sync", () => {
        it("ensureProviderSupportFile creates provider-support.json when missing", async () => {
            const supportPath = join(desktopDir, "provider-support.json");
            if (existsSync(supportPath)) {
                const { rmSync } = await import("fs");
                rmSync(supportPath);
            }
            await ensureProviderSupportFile();
            expect(existsSync(supportPath)).toBe(true);
        });

        it("getProviderSupport returns provider catalog with models (id, name only)", async () => {
            const support = await getProviderSupport();
            expect(support.deepseek).toBeDefined();
            expect(support.deepseek.name).toBe("DeepSeek");
            expect(support.deepseek.models.length).toBeGreaterThan(0);
            expect(support.deepseek.models[0]).toMatchObject({
                id: "deepseek-chat",
                name: "DeepSeek Chat",
            });
        });

        it("syncDesktopConfigToModelsJson writes agent dir models.json from configured providers", async () => {
            await setProviderApiKey("deepseek", "sk-deepseek");
            await syncDesktopConfigToModelsJson();
            const agentDir = getOpenbotAgentDir();
            const modelsPath = join(agentDir, "models.json");
            expect(existsSync(modelsPath)).toBe(true);
            const models = JSON.parse(readFileSync(modelsPath, "utf-8"));
            expect(models.providers.deepseek).toBeDefined();
            expect(models.providers.deepseek.models.some((m: any) => m.id === "deepseek-chat")).toBe(true);
        });
    });

    describe("getRagEmbeddingConfigSync", () => {
        it("returns null when config.json does not exist", () => {
            expect(getRagEmbeddingConfigSync()).toBeNull();
        });

        it("returns null when rag is not set", () => {
            writeFileSync(
                join(desktopDir, "config.json"),
                JSON.stringify({ defaultProvider: "deepseek", providers: { deepseek: { apiKey: "sk" } } }),
                "utf-8",
            );
            expect(getRagEmbeddingConfigSync()).toBeNull();
        });

        it("returns null when rag.embeddingProvider or embeddingModel is empty", () => {
            writeFileSync(
                join(desktopDir, "config.json"),
                JSON.stringify({
                    rag: { embeddingModel: "text-embedding-3-small" },
                    providers: { openai: { apiKey: "sk" } },
                }),
                "utf-8",
            );
            expect(getRagEmbeddingConfigSync()).toBeNull();
        });

        it("returns null when provider has no apiKey", () => {
            writeFileSync(
                join(desktopDir, "config.json"),
                JSON.stringify({
                    rag: { embeddingProvider: "openai", embeddingModel: "text-embedding-3-small" },
                    providers: { openai: {} },
                }),
                "utf-8",
            );
            expect(getRagEmbeddingConfigSync()).toBeNull();
        });

        it("returns config when rag and provider apiKey are set", () => {
            writeFileSync(
                join(desktopDir, "config.json"),
                JSON.stringify({
                    rag: { embeddingProvider: "openai", embeddingModel: "text-embedding-3-small" },
                    providers: { openai: { apiKey: "sk-openai" } },
                }),
                "utf-8",
            );
            const cfg = getRagEmbeddingConfigSync();
            expect(cfg).not.toBeNull();
            expect(cfg!.provider).toBe("openai");
            expect(cfg!.modelId).toBe("text-embedding-3-small");
            expect(cfg!.apiKey).toBe("sk-openai");
            expect(cfg!.baseUrl).toBe("https://api.openai.com/v1");
        });
    });
});
