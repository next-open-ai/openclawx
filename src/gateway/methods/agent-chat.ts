import type { GatewayClient, AgentChatParams } from "../types.js";
import { agentManager } from "../../core/agent/agent-manager.js";
import { runForChannelStream } from "../../core/agent/proxy/index.js";
import { getSessionCurrentAgentResolver, getSessionCurrentAgentUpdater } from "../../core/session-current-agent.js";
import { preprocessInboundMessage } from "../../core/inbound-message-preprocess.js";
import { send, createEvent } from "../utils.js";
import { connectedClients } from "../clients.js";
import { getDesktopConfig, loadDesktopAgentConfig } from "../../core/config/desktop-config.js";
import { consumePendingAgentReload } from "../../core/config/agent-reload-pending.js";
import { registerProxyRunAbort } from "../proxy-run-abort.js";
import { getSessionOutlet, sendSessionMessage } from "../../core/session-outlet/index.js";
import type { SessionMessage, SessionMessageConsumer } from "../../core/session-outlet/index.js";

const COMPOSITE_KEY_SEP = "::";

/** 将 delta/text 规范为字符串，避免 SDK 或上游返回对象时前端显示 [object Object] 或触发 Unknown value type */
function normalizeChunkText(v: unknown): string {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof (v as { content?: string }).content === "string") return (v as { content: string }).content;
    if (typeof (v as { text?: string }).text === "string") return (v as { text: string }).text;
    try {
        return String(JSON.stringify(v));
    } catch {
        return String(v);
    }
}

/** 当前每个 session 的流式订阅（用于在 cancel 或新 run 前移除旧订阅，避免重复广播） */
const sessionSubscriptionBySessionId = new Map<string, () => void>();

/**
 * 移除某 session 的流式订阅（cancel 或新消息开始时调用，避免同一事件被多个回调处理导致界面重复）
 */
export function clearSessionStreamSubscription(sessionId: string): void {
    const unsub = sessionSubscriptionBySessionId.get(sessionId);
    if (unsub) {
        try {
            unsub();
        } catch (_) {}
        sessionSubscriptionBySessionId.delete(sessionId);
    }
}

/**
 * Broadcast message to all clients subscribed to a session (used by Web consumer).
 */
function broadcastToSession(sessionId: string, message: any) {
    for (const client of connectedClients) {
        if (client.sessionId === sessionId) {
            send(client.ws, message);
        }
    }
}

/** 系统消息前缀，与正常回复同路下发，仅用此前缀区分，前端无需额外逻辑 */
const SYSTEM_MSG_PREFIX = "[System Message] ";
/** 系统消息结尾换行，与当前轮次助手内容分行显示 */
const SYSTEM_MSG_SUFFIX = "\n";

/**
 * 创建 Web 端会话消息消费者：将统一出口的 SessionMessage 转为 Gateway 事件并 broadcast。
 * 系统消息以独立事件 system_message 下发，前端做中间展示、不进入 session 聊天记录；各通道通过统一出口收到原始 system 消息后自行处理。
 */
function createWebSessionConsumer(_sessionId: string): SessionMessageConsumer {
    return {
        send(msg: SessionMessage) {
            const sid = msg.sessionId;
            if (msg.type === "system" && msg.code === "command.result") {
                const raw = (msg.payload?.text as string) ?? "";
                if (raw) broadcastToSession(sid, createEvent("system_message", { text: raw, code: "command.result", sessionId: sid }));
                broadcastToSession(sid, createEvent("turn_end", { sessionId: sid, content: "" }));
                broadcastToSession(sid, createEvent("message_complete", { sessionId: sid, content: "" }));
                broadcastToSession(sid, createEvent("agent_end", { sessionId: sid }));
                broadcastToSession(sid, createEvent("conversation_end", { sessionId: sid }));
                return;
            }
            if (msg.type === "system" && msg.code === "mcp.progress") {
                const raw = (msg.payload?.message as string) ?? (msg.payload?.phase as string) ?? "";
                if (raw) broadcastToSession(sid, createEvent("system_message", { text: raw, code: "mcp.progress", sessionId: sid }));
                return;
            }
            if (msg.type === "chat") {
                if (msg.code === "agent.chunk") {
                    broadcastToSession(sid, createEvent("agent.chunk", { ...msg.payload, sessionId: sid }));
                } else if (msg.code === "agent.tool") {
                    broadcastToSession(sid, createEvent("agent.tool", { ...msg.payload }));
                } else if (msg.code === "turn_end") {
                    broadcastToSession(sid, createEvent("turn_end", { sessionId: sid, ...msg.payload }));
                    broadcastToSession(sid, createEvent("message_complete", { sessionId: sid, ...msg.payload }));
                } else if (msg.code === "message_complete") {
                    broadcastToSession(sid, createEvent("message_complete", { sessionId: sid, ...msg.payload }));
                } else if (msg.code === "agent_end" || msg.code === "conversation_end") {
                    broadcastToSession(sid, createEvent(msg.code === "agent_end" ? "agent_end" : "conversation_end", { sessionId: sid, ...msg.payload }));
                }
            }
        },
    };
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
    const outlet = getSessionOutlet();
    const unregisterConsumer = outlet
        ? outlet.registerConsumer(targetSessionId, createWebSessionConsumer(targetSessionId))
        : () => {};

    try {
        const { targetAgentId } = params;
        const sessionType = params.sessionType ?? client.sessionType ?? "chat";
        const resolveCurrentAgent = getSessionCurrentAgentResolver();
        const storedAgentId = resolveCurrentAgent?.(targetSessionId);
        const clientAgentId = params.agentId ?? client.agentId ?? "default";
        const initialAgentId = params.agentId ?? storedAgentId ?? clientAgentId ?? "default";

        const { message: preprocessedMessage, agentId: preprocessedAgentId, directResponse } = await preprocessInboundMessage({
            sessionId: targetSessionId,
            message: message.trim(),
            currentAgentId: initialAgentId,
        });
        getSessionCurrentAgentUpdater()?.(targetSessionId, preprocessedAgentId);

        if (directResponse != null && directResponse !== "") {
            sendSessionMessage(targetSessionId, {
                type: "system",
                code: "command.result",
                payload: { text: directResponse },
            });
            return { status: "completed", sessionId: targetSessionId };
        }

        message = preprocessedMessage;
        let currentAgentId = preprocessedAgentId;
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
        const isProxyAgent = runnerType === "coze" || runnerType === "openclawx" || runnerType === "opencode" || runnerType === "claude_code";

        if (isProxyAgent) {
        console.log(`[agent.chat] Using proxy agent (${runnerType}) for session=${targetSessionId}, agentId=${currentAgentId}`);
    }

        // 代理智能体（Coze / OpenClawX / OpenCode）：走 AgentProxy 统一入口，流式结果经统一出口推给客户端
        if (isProxyAgent) {
            const { signal, unregister } = registerProxyRunAbort(targetSessionId, currentAgentId);
            const finishAndUnregister = () => {
                unregister();
                sendSessionMessage(targetSessionId, { type: "chat", code: "turn_end", payload: {} });
                sendSessionMessage(targetSessionId, { type: "chat", code: "message_complete", payload: {} });
                sendSessionMessage(targetSessionId, { type: "chat", code: "agent_end", payload: {} });
                sendSessionMessage(targetSessionId, { type: "chat", code: "conversation_end", payload: {} });
            };
            runForChannelStream(
                {
                    sessionId: targetSessionId,
                    message,
                    agentId: currentAgentId,
                    signal,
                },
                {
                    onChunk(delta: string) {
                        sendSessionMessage(targetSessionId, { type: "chat", code: "agent.chunk", payload: { text: delta } });
                    },
                    onTurnEnd() {
                        sendSessionMessage(targetSessionId, { type: "chat", code: "turn_end", payload: {} });
                        sendSessionMessage(targetSessionId, { type: "chat", code: "message_complete", payload: {} });
                    },
                    onDone() {
                        finishAndUnregister();
                    },
                }
            ).catch((error: any) => {
                const isAbort = error?.name === "AbortError" || (typeof error?.message === "string" && error.message.includes("abort"));
                if (!isAbort) console.error(`Error in agent chat (proxy ${runnerType}):`, error);
                finishAndUnregister();
                if (!isAbort) {
                    let errMsg = error?.message || String(error);
                    const needNormalize = typeof errMsg === "object" || (typeof errMsg === "string" && errMsg.includes("[object Object]"));
                    if (needNormalize) {
                        errMsg = normalizeChunkText(errMsg);
                        if (typeof errMsg === "string" && errMsg.includes("Unknown value type") && errMsg.includes("[object Object]")) {
                            errMsg = "模型返回了不支持的数据结构（如工具调用流），请尝试关闭工具或更换模型。";
                        }
                    }
                    sendSessionMessage(targetSessionId, { type: "chat", code: "agent.chunk", payload: { text: `请求失败：${errMsg}` } });
                }
            });
            return { status: "streaming", sessionId: targetSessionId };
        }

        const isEphemeralSession = sessionType === "system" || sessionType === "scheduled";
        if (isEphemeralSession) {
            await agentManager.deleteSession(targetSessionId + COMPOSITE_KEY_SEP + currentAgentId);
        }

        const effectiveTargetAgentId = sessionType === "system" ? targetAgentId : currentAgentId;

        const { maxAgentSessions } = getDesktopConfig();
        if (await consumePendingAgentReload(currentAgentId)) {
            await agentManager.deleteSessionsByAgentId(currentAgentId);
        }
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
                mcpMaxResultTokens: agentConfig?.mcpMaxResultTokens,
                systemPrompt: agentConfig?.systemPrompt,
                useLongMemory: agentConfig?.useLongMemory,
                webSearch: agentConfig?.webSearch,
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

        // 向各通道广播：turn_end（本小轮结束）、agent_end（整轮对话结束），经统一出口推送给已注册消费者
        let resolveAgentDone: () => void;
        const agentDonePromise = new Promise<void>((resolve) => {
            resolveAgentDone = resolve;
        });
        let didUnsubscribe = false;
        let unsubscribe: () => void;
        const doUnsubscribe = () => {
            if (didUnsubscribe) return;
            didUnsubscribe = true;
            sessionSubscriptionBySessionId.delete(targetSessionId);
            unsubscribe();
        };
        clearSessionStreamSubscription(targetSessionId);
        let hasReceivedAnyChunk = false;
        unsubscribe = session.subscribe((event: any) => {
            if (event.type !== "message_update") {
                console.log(`[agent.chat] event: ${event.type}`);
            }

            let wsPayload: { type: "chat"; code: SessionMessage["code"]; payload: Record<string, unknown> } | null = null;

            if (event.type === "message_update") {
                const update = event as any;
                if (update.assistantMessageEvent && update.assistantMessageEvent.type === "text_delta") {
                    hasReceivedAnyChunk = true;
                    wsPayload = { type: "chat", code: "agent.chunk", payload: { text: normalizeChunkText(update.assistantMessageEvent.delta) } };
                } else if (update.assistantMessageEvent && update.assistantMessageEvent.type === "thinking_delta") {
                    wsPayload = { type: "chat", code: "agent.chunk", payload: { text: normalizeChunkText(update.assistantMessageEvent.delta), isThinking: true } };
                } else if (update.assistantMessageEvent?.type === "error" && update.assistantMessageEvent?.error?.errorMessage) {
                    console.warn("[agent.chat] model error:", update.assistantMessageEvent.error.errorMessage);
                }
            } else if (event.type === "tool_execution_start") {
                wsPayload = { type: "chat", code: "agent.tool", payload: { type: "start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args } };
            } else if (event.type === "tool_execution_end") {
                wsPayload = { type: "chat", code: "agent.tool", payload: { type: "end", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError } };
            } else if (event.type === "message_end") {
                const msg = (event as any).message;
                if (msg?.role === "assistant" && msg?.content && Array.isArray(msg.content)) {
                    const text = msg.content
                        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
                        .map((c: any) => c.text)
                        .join("");
                    if (text && !hasReceivedAnyChunk) {
                        sendSessionMessage(targetSessionId, { type: "chat", code: "agent.chunk", payload: { text } });
                    }
                    hasReceivedAnyChunk = true;
                }
                if (msg?.errorMessage) {
                    // 调试：定位本地 LLM 流式报错来源（pi-ai 等 SDK 抛出的原始 errorMessage）
                    console.error("[agent.chat] message_end errorMessage:", msg.errorMessage);
                    if (typeof (msg as any).errorStack === "string") console.error("[agent.chat] message_end errorStack:", (msg as any).errorStack);
                    let errText = msg.errorMessage.includes("402") || msg.errorMessage.includes("Insufficient Balance")
                        ? "API 余额不足，请到「设置」检查并充值后重试。"
                        : `请求失败：${normalizeChunkText(msg.errorMessage)}`;
                    if (errText.includes("Unknown value type") && errText.includes("[object Object]")) {
                        errText = "请求失败：模型返回了不支持的数据结构（如工具调用流），请尝试关闭工具或更换模型。";
                    }
                    const isConnErr = /Connection error|ECONNREFUSED|fetch failed/i.test(msg.errorMessage);
                    const localFailed = process.env.LOCAL_LLM_START_FAILED;
                    const isLocalProvider = provider === "local";
                    const isModelRequired = /model is required|400.*model/i.test(msg.errorMessage);
                    if (isLocalProvider && localFailed && (msg.errorMessage === "terminated" || isConnErr)) {
                        errText = `请求失败：${localFailed}`;
                    } else if ((provider === "openai-custom" || provider === "ollama") && isConnErr) {
                        errText = "请求失败：无法连接到模型服务（若使用 Ollama 请确认已启动且 baseUrl 为 http://localhost:11434/v1，或改用「Ollama」Provider）。";
                    } else if (isModelRequired && (provider === "openai-custom" || provider === "ollama")) {
                        errText =
                            "请求失败：模型名称未被服务端识别。若使用 Ollama，请确保「模型配置」中的模型名与终端中 `ollama list` 显示的名称完全一致（如 qwen3:4b）。";
                    } else if (provider === "local" && /context size.*too large|VRAM|显存/i.test(msg.errorMessage)) {
                        errText =
                            "请求失败：显存/内存不足，当前上下文长度过大。请在「智能体配置」中将该智能体的「上下文长度」调小（如 8192 或 4096）后重新启动本地模型服务再试。";
                    }
                    sendSessionMessage(targetSessionId, { type: "chat", code: "agent.chunk", payload: { text: errText } });
                }
                wsPayload = null;
            } else if (event.type === "turn_end") {
                const msg = (event as any).message;
                if (!hasReceivedAnyChunk && msg?.content && Array.isArray(msg.content)) {
                    const fullText = msg.content
                        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
                        .map((c: any) => c.text)
                        .join("");
                    if (fullText) {
                        sendSessionMessage(targetSessionId, { type: "chat", code: "agent.chunk", payload: { text: fullText } });
                        hasReceivedAnyChunk = true;
                    }
                }
                if (msg?.errorMessage) {
                    // 调试：定位 turn_end 时 SDK 传入的原始错误
                    console.error("[agent.chat] turn_end errorMessage:", msg.errorMessage);
                    if (typeof (msg as any).errorStack === "string") console.error("[agent.chat] turn_end errorStack:", (msg as any).errorStack);
                    let errText = msg.errorMessage.includes("402") || msg.errorMessage.includes("Insufficient Balance")
                        ? "API 余额不足，请到「设置」检查并充值后重试。"
                        : `请求失败：${normalizeChunkText(msg.errorMessage)}`;
                    if (errText.includes("Unknown value type") && errText.includes("[object Object]")) {
                        errText = "请求失败：模型返回了不支持的数据结构（如工具调用流），请尝试关闭工具或更换模型。";
                    }
                    const isConnErr = /Connection error|ECONNREFUSED|fetch failed/i.test(msg.errorMessage);
                    const localFailed = process.env.LOCAL_LLM_START_FAILED;
                    const isLocalProvider = provider === "local";
                    const isModelRequired = /model is required|400.*model/i.test(msg.errorMessage);
                    if (isLocalProvider && localFailed && (msg.errorMessage === "terminated" || isConnErr)) {
                        errText = `请求失败：${localFailed}`;
                    } else if ((provider === "openai-custom" || provider === "ollama") && isConnErr) {
                        errText = "请求失败：无法连接到模型服务（若使用 Ollama 请确认已启动且 baseUrl 为 http://localhost:11434/v1，或改用「Ollama」Provider）。";
                    } else if (isModelRequired && (provider === "openai-custom" || provider === "ollama")) {
                        errText =
                            "请求失败：模型名称未被服务端识别。若使用 Ollama，请确保「模型配置」中的模型名与终端中 `ollama list` 显示的名称完全一致（如 qwen3:4b）。";
                    } else if (provider === "local" && /context size.*too large|VRAM|显存/i.test(msg.errorMessage)) {
                        errText =
                            "请求失败：显存/内存不足，当前上下文长度过大。请在「智能体配置」中将该智能体的「上下文长度」调小（如 8192 或 4096）后重新启动本地模型服务再试。";
                    }
                    sendSessionMessage(targetSessionId, { type: "chat", code: "agent.chunk", payload: { text: errText } });
                    hasReceivedAnyChunk = true;
                }
                const usage = msg?.usage;
                const promptTokens = Number(usage?.input ?? usage?.input_tokens ?? 0) || 0;
                const completionTokens = Number(usage?.output ?? usage?.output_tokens ?? 0) || 0;
                const usagePayload = promptTokens > 0 || completionTokens > 0 ? { promptTokens, completionTokens } : undefined;
                const turnPayload = { content: "", ...(usagePayload && { usage: usagePayload }) };
                sendSessionMessage(targetSessionId, { type: "chat", code: "turn_end", payload: turnPayload });
                sendSessionMessage(targetSessionId, { type: "chat", code: "message_complete", payload: turnPayload });
                wsPayload = null;
            } else if (event.type === "agent_end") {
                if (!hasReceivedAnyChunk && Array.isArray((event as any).messages)) {
                    const messages = (event as any).messages as { role?: string; content?: Array<{ type?: string; text?: string }> }[];
                    const lastAssistant = [...messages].reverse().find((m) => m?.role === "assistant" && m?.content);
                    if (lastAssistant?.content) {
                        const text = lastAssistant.content
                            .filter((c: any) => c?.type === "text" && typeof c.text === "string")
                            .map((c: any) => c.text)
                            .join("");
                        if (text) sendSessionMessage(targetSessionId, { type: "chat", code: "agent.chunk", payload: { text } });
                    }
                }
                sendSessionMessage(targetSessionId, { type: "chat", code: "agent_end", payload: {} });
                sendSessionMessage(targetSessionId, { type: "chat", code: "conversation_end", payload: {} });
                wsPayload = null;
                resolveAgentDone!();
                doUnsubscribe();
                if (isEphemeralSession) {
                    void agentManager.deleteSession(targetSessionId + COMPOSITE_KEY_SEP + currentAgentId).catch(() => {});
                }
            }

            if (wsPayload) {
                sendSessionMessage(targetSessionId, wsPayload);
            }
        });
        sessionSubscriptionBySessionId.set(targetSessionId, unsubscribe);

        try {
            await session.sendUserMessage(message, { deliverAs: "followUp" });
            // 流已启动，立即返回；前端以 agent_end 判断整轮结束，超时以「首包」计算更优
            return { status: "streaming", sessionId: targetSessionId };
        } catch (error: any) {
            console.error(`Error in agent chat:`, error);
            resolveAgentDone!();
            doUnsubscribe();
            throw error;
        }
    } finally {
        unregisterConsumer();
    }
}
