import type { GatewayClient, AgentChatParams } from "../types.js";
import { agentManager } from "../../core/agent/agent-manager.js";
import { runForChannelStream } from "../../core/agent/proxy/index.js";
import { getSessionCurrentAgentResolver, getSessionCurrentAgentUpdater } from "../../core/session-current-agent.js";
import { send, createEvent } from "../utils.js";
import { connectedClients } from "../clients.js";
import { getDesktopConfig, loadDesktopAgentConfig } from "../../core/config/desktop-config.js";

const COMPOSITE_KEY_SEP = "::";

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
    const sessionType = params.sessionType ?? client.sessionType ?? "chat";
    // 当前 agent：请求传入 > 已存（DB）> 连接/默认
    const resolveCurrentAgent = getSessionCurrentAgentResolver();
    const storedAgentId = resolveCurrentAgent?.(targetSessionId);
    const clientAgentId = params.agentId ?? client.agentId ?? "default";
    let currentAgentId = params.agentId ?? storedAgentId ?? clientAgentId ?? "default";
    if (params.agentId) {
        getSessionCurrentAgentUpdater()?.(targetSessionId, params.agentId);
        currentAgentId = params.agentId;
    }
    console.log(
        `[agent.chat] session=${targetSessionId} resolved agentId=${currentAgentId} (params=${params.agentId ?? "—"}, stored=${storedAgentId ?? "—"}, client=${client.agentId ?? "—"})`
    );

    let workspace = "default";
    let provider: string | undefined;
    let modelId: string | undefined;
    let apiKey: string | undefined;
    const agentConfig = await loadDesktopAgentConfig(currentAgentId);
    if (agentConfig) {
        if (agentConfig.workspace) workspace = agentConfig.workspace;
        provider = agentConfig.provider;
        modelId = agentConfig.model;
        if (agentConfig.apiKey) apiKey = agentConfig.apiKey;
    }

    const runnerType = agentConfig?.runnerType ?? "local";
    const isProxyAgent = runnerType === "coze" || runnerType === "openclawx";

    if (isProxyAgent) {
        console.log(`[agent.chat] Using proxy agent (${runnerType}) for session=${targetSessionId}, agentId=${currentAgentId}`);
    }

    // 代理智能体（Coze / OpenClawX）：走 AgentProxy 统一入口，流式结果通过 WebSocket 推给客户端
    if (isProxyAgent) {
        try {
            await runForChannelStream(
                {
                    sessionId: targetSessionId,
                    message,
                    agentId: currentAgentId,
                },
                {
                    onChunk(delta: string) {
                        broadcastToSession(targetSessionId, createEvent("agent.chunk", { text: delta }));
                    },
                    onTurnEnd() {
                        broadcastToSession(targetSessionId, createEvent("turn_end", { sessionId: targetSessionId, content: "" }));
                        broadcastToSession(targetSessionId, createEvent("message_complete", { sessionId: targetSessionId, content: "" }));
                    },
                    onDone() {
                        broadcastToSession(targetSessionId, createEvent("agent_end", { sessionId: targetSessionId }));
                        broadcastToSession(targetSessionId, createEvent("conversation_end", { sessionId: targetSessionId }));
                    },
                }
            );
            return { status: "completed", sessionId: targetSessionId };
        } catch (error: any) {
            console.error(`Error in agent chat (proxy ${runnerType}):`, error);
            throw error;
        }
    }

    const isEphemeralSession = sessionType === "system" || sessionType === "scheduled";
    if (isEphemeralSession) {
        await agentManager.deleteSession(targetSessionId + COMPOSITE_KEY_SEP + currentAgentId);
    }

    const effectiveTargetAgentId = sessionType === "system" ? targetAgentId : currentAgentId;

    const { maxAgentSessions } = getDesktopConfig();
    let session;
    try {
        session = await agentManager.getOrCreateSession(targetSessionId, {
            agentId: currentAgentId,
            workspace,
            provider,
            modelId,
            apiKey,
            maxSessions: maxAgentSessions,
            targetAgentId: effectiveTargetAgentId,
            mcpServers: agentConfig?.mcpServers,
            systemPrompt: agentConfig?.systemPrompt,
            useLongMemory: agentConfig?.useLongMemory,
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

    // 向各通道广播：turn_end（本小轮结束）、agent_end（整轮对话结束），并保留 message_complete / conversation_end 兼容。各端按需处理。
    // 必须等 agent_end 后再 resolve 并 unsubscribe，否则 sendUserMessage 一 return 就 unsubscribe，流式 text_delta 会收不到，前端看不到回复。
    let resolveAgentDone: () => void;
    const agentDonePromise = new Promise<void>((resolve) => {
        resolveAgentDone = resolve;
    });
    let didUnsubscribe = false;
    let unsubscribe: () => void;
    const doUnsubscribe = () => {
        if (didUnsubscribe) return;
        didUnsubscribe = true;
        unsubscribe();
    };
    let hasReceivedAnyChunk = false;
    unsubscribe = session.subscribe((event: any) => {
        if (event.type !== "message_update") {
            console.log(`[agent.chat] event: ${event.type}`);
        }

        let wsMessage: any = null;

        if (event.type === "message_update") {
            const update = event as any;
            if (update.assistantMessageEvent && update.assistantMessageEvent.type === "text_delta") {
                hasReceivedAnyChunk = true;
                wsMessage = createEvent("agent.chunk", { text: update.assistantMessageEvent.delta });
            } else if (update.assistantMessageEvent && update.assistantMessageEvent.type === "thinking_delta") {
                wsMessage = createEvent("agent.chunk", { text: update.assistantMessageEvent.delta, isThinking: true });
            } else if (update.assistantMessageEvent?.type === "error" && update.assistantMessageEvent?.error?.errorMessage) {
                console.warn("[agent.chat] model error:", update.assistantMessageEvent.error.errorMessage);
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
        } else if (event.type === "message_end") {
            const msg = (event as any).message;
            if (msg?.role === "assistant" && msg?.content && Array.isArray(msg.content)) {
                const text = msg.content
                    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
                    .map((c: any) => c.text)
                    .join("");
                if (text) {
                    hasReceivedAnyChunk = true;
                    broadcastToSession(targetSessionId, createEvent("agent.chunk", { text }));
                }
            }
            if (msg?.errorMessage) {
                console.warn("[agent.chat] message_end error:", msg.errorMessage);
                const errText = msg.errorMessage.includes("402") || msg.errorMessage.includes("Insufficient Balance")
                    ? "API 余额不足，请到「设置」检查并充值后重试。"
                    : `请求失败：${msg.errorMessage}`;
                broadcastToSession(targetSessionId, createEvent("agent.chunk", { text: errText }));
            }
            wsMessage = null;
        } else if (event.type === "turn_end") {
            const msg = (event as any).message;
            if (!hasReceivedAnyChunk && msg?.content && Array.isArray(msg.content)) {
                const fullText = msg.content
                    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
                    .map((c: any) => c.text)
                    .join("");
                if (fullText) {
                    broadcastToSession(targetSessionId, createEvent("agent.chunk", { text: fullText }));
                    hasReceivedAnyChunk = true;
                }
            }
            if (msg?.errorMessage) {
                console.warn("[agent.chat] turn message error:", msg.errorMessage);
                const errText = msg.errorMessage.includes("402") || msg.errorMessage.includes("Insufficient Balance")
                    ? "API 余额不足，请到「设置」检查并充值后重试。"
                    : `请求失败：${msg.errorMessage}`;
                broadcastToSession(targetSessionId, createEvent("agent.chunk", { text: errText }));
                hasReceivedAnyChunk = true;
            }
            const usage = msg?.usage;
            const promptTokens = Number(usage?.input ?? usage?.input_tokens ?? 0) || 0;
            const completionTokens = Number(usage?.output ?? usage?.output_tokens ?? 0) || 0;
            const usagePayload =
                promptTokens > 0 || completionTokens > 0
                    ? { promptTokens, completionTokens }
                    : undefined;
            const turnPayload = {
                sessionId: targetSessionId,
                content: "",
                ...(usagePayload && { usage: usagePayload }),
            };
            broadcastToSession(targetSessionId, createEvent("turn_end", turnPayload));
            broadcastToSession(targetSessionId, createEvent("message_complete", turnPayload));
            wsMessage = null;
        } else if (event.type === "agent_end") {
            if (!hasReceivedAnyChunk && Array.isArray((event as any).messages)) {
                const messages = (event as any).messages as { role?: string; content?: Array<{ type?: string; text?: string }> }[];
                const lastAssistant = [...messages].reverse().find((m) => m?.role === "assistant" && m?.content);
                if (lastAssistant?.content) {
                    const text = lastAssistant.content
                        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
                        .map((c: any) => c.text)
                        .join("");
                    if (text) broadcastToSession(targetSessionId, createEvent("agent.chunk", { text }));
                }
            }
            const agentPayload = { sessionId: targetSessionId };
            broadcastToSession(targetSessionId, createEvent("agent_end", agentPayload));
            broadcastToSession(targetSessionId, createEvent("conversation_end", agentPayload));
            wsMessage = null;
            resolveAgentDone!();
            doUnsubscribe();
            if (isEphemeralSession) {
                void agentManager.deleteSession(targetSessionId + COMPOSITE_KEY_SEP + currentAgentId).catch(() => {});
            }
        }

        if (wsMessage) {
            broadcastToSession(targetSessionId, wsMessage);
        }
    });

    try {
        // 若 agent 正在流式输出，deliverAs: 'followUp' 将本条消息排队，避免抛出 "Agent is already processing"
        await session.sendUserMessage(message, { deliverAs: "followUp" });

        await agentDonePromise;

        console.log(`Agent chat completed for session ${targetSessionId}`);

        return {
            status: "completed",
            sessionId: targetSessionId,
        };
    } catch (error: any) {
        console.error(`Error in agent chat:`, error);
        resolveAgentDone!();
        doUnsubscribe();
        throw error;
    }
}
