import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { getOpenbotAgentDir, ensureDefaultAgentDir } from "./agent-dir.js";

export interface ConfigInfo {
    provider: string;
    model: string;
    hasKey: boolean;
}

/**
 * Manage agent configuration (auth.json, models.json)
 */
export class ConfigManager {
    private agentDir: string;
    private authStorage: AuthStorage;

    constructor(agentDir: string = getOpenbotAgentDir()) {
        this.agentDir = agentDir;
        ensureDefaultAgentDir(this.agentDir);
        const authPath = join(this.agentDir, "auth.json");
        this.authStorage = new AuthStorage(authPath);
    }

    /**
     * Save API key for a provider
     */
    async login(provider: string, apiKey: string): Promise<void> {
        this.authStorage.set(provider, {
            type: "api_key",
            key: apiKey
        });
        console.log(`[config] Successfully saved API key for provider: ${provider}`);
    }

    /**
     * Update default model for a provider in models.json
     */
    async setModel(provider: string, modelId: string): Promise<void> {
        const modelsPath = join(this.agentDir, "models.json");
        if (!existsSync(modelsPath)) {
            throw new Error(`models.json not found at ${modelsPath}`);
        }

        const config = JSON.parse(readFileSync(modelsPath, "utf-8"));
        if (!config.providers[provider]) {
            throw new Error(`Provider "${provider}" not found in models.json`);
        }

        // Check if model exists in that provider's list
        const providerConfig = config.providers[provider];
        const modelExists = providerConfig.models?.some((m: any) => m.id === modelId);

        if (!modelExists) {
            console.warn(`[config] Warning: Model "${modelId}" not found in the defined list for "${provider}". Adding it anyway.`);
            if (!providerConfig.models) providerConfig.models = [];
            providerConfig.models.push({
                id: modelId,
                name: modelId,
                contextWindow: 128000,
                supportsTools: true
            });
        }

        // In this simple implementation, we assume the first model in the list
        // might be intended as default by some logic, although the registry 
        // usually needs explicit selection.
        // For now, let's just reorder so the selected model is first.
        const modelIndex = providerConfig.models.findIndex((m: any) => m.id === modelId);
        if (modelIndex > 0) {
            const [model] = providerConfig.models.splice(modelIndex, 1);
            providerConfig.models.unshift(model);
        }

        writeFileSync(modelsPath, JSON.stringify(config, null, 2), "utf-8");
        console.log(`[config] Updated default model for "${provider}" to "${modelId}"`);
    }

    /**
     * List current configurations
     */
    list(): ConfigInfo[] {
        const modelsPath = join(this.agentDir, "models.json");
        if (!existsSync(modelsPath)) return [];

        const config = JSON.parse(readFileSync(modelsPath, "utf-8"));
        const results: ConfigInfo[] = [];

        for (const [providerId, providerConfig] of Object.entries(config.providers) as [string, any][]) {
            const firstModel = providerConfig.models?.[0]?.id || "none";
            results.push({
                provider: providerId,
                model: firstModel,
                hasKey: this.authStorage.has(providerId)
            });
        }

        return results;
    }
}
