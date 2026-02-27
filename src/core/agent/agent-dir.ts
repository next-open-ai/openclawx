import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 获取 openbot agent 配置目录（默认 ~/.openbot/agent）
 * 可通过环境变量 OPENBOT_AGENT_DIR 覆盖
 */
export function getOpenbotAgentDir(): string {
    return process.env.OPENBOT_AGENT_DIR ?? join(homedir(), ".openbot", "agent");
}

/**
 * 获取 openbot 工作空间根目录（默认 ~/.openbot/workspace）
 * 可通过环境变量 OPENBOT_WORKSPACE_DIR 覆盖
 */
export function getOpenbotWorkspaceDir(): string {
    return process.env.OPENBOT_WORKSPACE_DIR ?? join(homedir(), ".openbot", "workspace");
}

/**
 * 获取 openbot 扩展（插件）目录（默认 ~/.openbot/plugins）
 * 可通过环境变量 OPENBOT_PLUGINS_DIR 覆盖
 * openbot extension install 会在此目录下维护 package.json 与 node_modules
 */
export function getOpenbotPluginsDir(): string {
    return process.env.OPENBOT_PLUGINS_DIR ?? join(homedir(), ".openbot", "plugins");
}

/**
 * 确保 agent 目录存在，并创建默认配置文件
 */
export function ensureDefaultAgentDir(agentDir: string): void {
    if (!existsSync(agentDir)) {
        mkdirSync(agentDir, { recursive: true });
    }

    const modelsJsonPath = join(agentDir, "models.json");
    if (!existsSync(modelsJsonPath)) {
        const defaultModels = {
            providers: {
                deepseek: {
                    name: "DeepSeek",
                    apiKey: "OPENAI_API_KEY",
                    api: "openai-completions",
                    baseUrl: "https://api.deepseek.com/v1",
                    authHeader: true,
                    models: [
                        {
                            id: "deepseek-chat",
                            name: "DeepSeek Chat",
                            contextWindow: 64000,
                            supportsTools: true
                        },
                        {
                            id: "deepseek-reasoner",
                            name: "DeepSeek Reasoner",
                            contextWindow: 64000,
                            supportsTools: true
                        }
                    ]
                },
                dashscope: {
                    name: "DashScope (Alibaba)",
                    apiKey: "DASHSCOPE_API_KEY",
                    api: "openai-completions",
                    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
                    authHeader: true,
                    models: [
                        {
                            id: "qwen-max",
                            name: "Qwen Max",
                            contextWindow: 30000,
                            supportsTools: true
                        },
                        {
                            id: "qwen-plus",
                            name: "Qwen Plus",
                            contextWindow: 128000,
                            supportsTools: true
                        }
                    ]
                }
            }
        };
        writeFileSync(modelsJsonPath, JSON.stringify(defaultModels, null, 2), "utf-8");
    }
}
