import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { getOpenbotAgentDir } from "./agent-dir.js";
import type { Skill } from "./skills.js";
import { AgentManager } from "./agent-manager.js";

export interface RunOptions {
    /** Workspace name (e.g. "default") */
    workspace?: string;
    /** Additional skill paths */
    skillPaths?: string[];
    /** 用户提示词 */
    userPrompt: string;
    /** 是否仅打印组装后的内容，不调 LLM */
    dryRun?: boolean;
    /** API key，不传则从 pi 的 auth 或 OPENAI_API_KEY 读取 */
    apiKey?: string;
    /** 模型 ID（如 deepseek-chat、qwen-max） */
    model?: string;
    /** Provider（如 deepseek、dashscope、openai） */
    provider?: string;
    /** Agent 配置目录，默认 ~/.openbot/agent */
    agentDir?: string;
}

export interface RunResult {
    systemPrompt: string;
    userPrompt: string;
    /** 若调用了 API，则为助手回复 */
    assistantContent?: string;
    dryRun: boolean;
}

export async function run(options: RunOptions): Promise<RunResult> {
    const {
        workspace = "default",
        skillPaths = [],
        userPrompt,
        dryRun: explicitDryRun,
        apiKey,
        model: modelId = "deepseek-chat",
        provider = "deepseek",
        agentDir = getOpenbotAgentDir(),
    } = options;

    const manager = new AgentManager({ agentDir, workspace, skillPaths });
    const { systemPrompt } = await manager.getContext();

    // Determine dry run
    const dryRun = !!explicitDryRun; // Ensure boolean

    const result: RunResult = {
        systemPrompt,
        userPrompt,
        dryRun,
    };

    if (dryRun) {
        return result;
    }

    // Create a temporary session for this run
    const sessionId = `cli-${Date.now()}`;
    const session = await manager.getOrCreateSession(sessionId, {
        provider,
        modelId,
        apiKey,
    });

    // Collect assistant response
    let assistantContent = "";

    session.subscribe((event: AgentSessionEvent) => {
        switch (event.type) {
            case "message_update": {
                const evt = event.assistantMessageEvent;
                if (evt.type === "text_delta") {
                    assistantContent += evt.delta;
                    process.stdout.write(evt.delta);
                } else if (evt.type === "thinking_delta") {
                    process.stdout.write(evt.delta);
                } else if (evt.type === "error") {
                    console.error(`\n[model:error] ${evt.error.errorMessage || "Unknown error"}`);
                }
                break;
            }
            case "message_end": {
                if (event.message.role === "assistant" && event.message.errorMessage) {
                    console.error(`\n[message:error] ${event.message.errorMessage}`);
                }
                break;
            }
            case "tool_execution_start": {
                console.log(`\n[tool:start] ${event.toolName}(${JSON.stringify(event.args)})`);
                break;
            }
            case "tool_execution_end": {
                const status = event.isError ? "failed" : "ok";
                console.log(`[tool:end] ${event.toolName} -> ${status}`);
                break;
            }
        }
    });

    // Send prompt and wait for completion
    await session.prompt(userPrompt);

    // Clean up session
    manager.deleteSession(sessionId);

    result.assistantContent = assistantContent.trim();
    return result;
}
