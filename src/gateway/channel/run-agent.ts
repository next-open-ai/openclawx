/**
 * 通道用：跑 Agent 并收集完整回复文本（无 WebSocket 客户端）。
 */
import { agentManager } from "../../core/agent/agent-manager.js";
import { getDesktopConfig, loadDesktopAgentConfig } from "../../core/config/desktop-config.js";
import { getExperienceContextForUserMessage } from "../../core/memory/index.js";

export interface RunAgentForChannelOptions {
    /** 会话 ID，建议 channel:platform:threadId */
    sessionId: string;
    /** 用户消息正文 */
    message: string;
    /** 使用的 agentId，缺省 default */
    agentId?: string;
}

/**
 * 使用现有 agentManager 跑一轮对话，收集助手完整回复文本后返回。
 * 不依赖 WebSocket 客户端，供通道核心调用。
 */
export async function runAgentAndCollectReply(
    options: RunAgentForChannelOptions
): Promise<string> {
    const { sessionId, message, agentId: optionAgentId } = options;
    const sessionAgentId = optionAgentId ?? "default";

    let workspace = "default";
    let provider: string | undefined;
    let modelId: string | undefined;
    let apiKey: string | undefined;
    const agentConfig = await loadDesktopAgentConfig(sessionAgentId);
    if (agentConfig) {
        if (agentConfig.workspace) workspace = agentConfig.workspace;
        provider = agentConfig.provider;
        modelId = agentConfig.model;
        if (agentConfig.apiKey) apiKey = agentConfig.apiKey;
    }

    const { maxAgentSessions } = getDesktopConfig();
    const session = await agentManager.getOrCreateSession(sessionId, {
        workspace,
        provider,
        modelId,
        apiKey,
        maxSessions: maxAgentSessions,
        targetAgentId: sessionAgentId,
        mcpServers: agentConfig?.mcpServers,
    });

    const chunks: string[] = [];
    let resolveDone: () => void;
    const donePromise = new Promise<void>((r) => {
        resolveDone = r;
    });

    const unsubscribe = session.subscribe((event: any) => {
        if (event.type === "message_update") {
            const update = event as any;
            if (update.assistantMessageEvent?.type === "text_delta" && update.assistantMessageEvent?.delta) {
                chunks.push(update.assistantMessageEvent.delta);
            }
        } else if (event.type === "turn_end") {
            resolveDone!();
        }
    });

    try {
        const experienceBlock = await getExperienceContextForUserMessage();
        const userMessageToSend =
            experienceBlock.trim().length > 0
                ? `${experienceBlock}\n\n用户问题：\n${message}`
                : message;

        await session.sendUserMessage(userMessageToSend, { deliverAs: "followUp" });

        // 等待 turn_end 或超时（如 120s）
        await Promise.race([
            donePromise,
            new Promise<void>((_, rej) => setTimeout(() => rej(new Error("Channel agent reply timeout")), 120_000)),
        ]);
    } finally {
        unsubscribe();
    }

    return chunks.join("").trim() || "(无文本回复)";
}
