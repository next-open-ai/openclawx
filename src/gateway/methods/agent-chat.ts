import type { GatewayClient, AgentChatParams } from "../types.js";
import { agentManager } from "../../core/agent/agent-manager.js";
import { getExperienceContextForUserMessage } from "../../core/memory/index.js";
import { send, createEvent } from "../utils.js";
import { connectedClients } from "../clients.js";
import { getDesktopConfig, loadDesktopAgentConfig } from "../../core/config/desktop-config.js";

/**
 * Broadcast message to all clients subscribed to a session
 */
function broadcastToSession(sessionId: string, message: any) {
    for (const client of connectedClients) {
        if (client.sessionId === sessionId) {
            send(client.ws, message);
        }
    }
}

/**
 * Handle agent chat request with streaming support
 */
export async function handleAgentChat(
    client: GatewayClient,
    params: AgentChatParams
): Promise<{ status: string; sessionId: string }> {
    const { message, sessionId, targetAgentId } = params;

    if (!message || !message.trim()) {
        throw new Error("Message is required");
    }

    // Use client's session ID if not provided
    const targetSessionId = sessionId || client.sessionId;
    if (!targetSessionId) {
        throw new Error("No session ID available");
    }

    console.log(`Agent chat request for session ${targetSessionId}: ${message.substring(0, 50)}...`);

    return handleAgentChatInner(client, targetSessionId, message, params);
}

async function handleAgentChatInner(
    client: GatewayClient,
    targetSessionId: string,
    message: string,
    params: AgentChatParams,
): Promise<{ status: string; sessionId: string }> {
    const { targetAgentId } = params;
    // 客户端在 connect 或 agent.chat 传入 agentId/sessionType，Gateway 不再请求 Nest
    const sessionAgentId = params.agentId ?? client.agentId ?? "default";
    const sessionType = params.sessionType ?? client.sessionType ?? "chat";

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

    // system / scheduled：每次对话前先删再建，对话结束马上关闭，节省资源
    const isEphemeralSession = sessionType === "system" || sessionType === "scheduled";
    if (isEphemeralSession) {
        agentManager.deleteSession(targetSessionId);
    }

    // system 会话用请求里的 targetAgentId；chat/scheduled 用 session 对应的 agentId 传给 install_skill
    const effectiveTargetAgentId = sessionType === "system" ? targetAgentId : sessionAgentId;

    const { maxAgentSessions } = getDesktopConfig();
    let session;
    try {
        session = await agentManager.getOrCreateSession(targetSessionId, {
            workspace,
            provider,
            modelId,
            apiKey,
            maxSessions: maxAgentSessions,
            targetAgentId: effectiveTargetAgentId,
            mcpServers: agentConfig?.mcpServers,
        });
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (msg.includes("No API key") || msg.includes("API key")) {
            const prov = provider ?? "deepseek";
            throw new Error(
                `未配置 ${prov} 的 API Key。请在桌面端「设置」-「模型/API」中配置，或运行：openbot login ${prov} <你的API Key>`
            );
        }
        throw err;
    }

    // Set up event listener for streaming
    const unsubscribe = session.subscribe((event: any) => {
        // console.log(`Agent event received: ${event.type}`); // Reduce noise

        let wsMessage: any = null;

        if (event.type === "message_update") {
            const update = event as any;
            if (update.assistantMessageEvent && update.assistantMessageEvent.type === "text_delta") {
                wsMessage = createEvent("agent.chunk", { text: update.assistantMessageEvent.delta });
            } else if (update.assistantMessageEvent && update.assistantMessageEvent.type === "thinking_delta") {
                wsMessage = createEvent("agent.chunk", { text: update.assistantMessageEvent.delta, isThinking: true });
            }
        } else if (event.type === "tool_execution_start") {
            wsMessage = createEvent("agent.tool", {
                type: "start",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args
            });
        } else if (event.type === "tool_execution_end") {
            wsMessage = createEvent("agent.tool", {
                type: "end",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                result: event.result,
                isError: event.isError
            });
        } else if (event.type === "turn_end") {
            const usage = (event as any).message?.usage;
            const promptTokens = Number(usage?.input ?? usage?.input_tokens ?? 0) || 0;
            const completionTokens = Number(usage?.output ?? usage?.output_tokens ?? 0) || 0;
            const usagePayload =
                promptTokens > 0 || completionTokens > 0
                    ? { promptTokens, completionTokens }
                    : undefined;
            wsMessage = createEvent("message_complete", {
                sessionId: targetSessionId,
                content: "",
                ...(usagePayload && { usage: usagePayload }),
            });
        }

        if (wsMessage) {
            broadcastToSession(targetSessionId, wsMessage);
        }
        if (event.type === "turn_end" && isEphemeralSession) {
            agentManager.deleteSession(targetSessionId);
        }
    });

    try {
        const experienceBlock = await getExperienceContextForUserMessage();
        const userMessageToSend =
            experienceBlock.trim().length > 0
                ? `${experienceBlock}\n\n用户问题：\n${message}`
                : message;

        // 若 agent 正在流式输出，deliverAs: 'followUp' 将本条消息排队，避免抛出 "Agent is already processing"
        await session.sendUserMessage(userMessageToSend, { deliverAs: "followUp" });

        console.log(`Agent chat completed for session ${targetSessionId}`);

        return {
            status: "completed",
            sessionId: targetSessionId,
        };
    } catch (error: any) {
        console.error(`Error in agent chat:`, error);
        throw error;
    } finally {
        unsubscribe();
    }
}
