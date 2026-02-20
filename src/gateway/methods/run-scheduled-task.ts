import type { IncomingMessage, ServerResponse } from "http";
import { agentManager } from "../../core/agent/agent-manager.js";
import { getExperienceContextForUserMessage } from "../../core/memory/index.js";
import { loadDesktopAgentConfig } from "../../core/config/desktop-config.js";

export interface RunScheduledTaskBody {
    sessionId: string;
    message: string;
    /** 该 session 绑定的 agentId，Gateway 用其本地取配置，不请求 Nest；不传则 default */
    agentId?: string;
    workspace?: string;
    taskId?: string;
    backendBaseUrl?: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
    });
}

/**
 * Run a scheduled task: configure workspace, send message to agent, collect response, POST back to Nest.
 * 执行完成后关闭并移除 AgentSession，避免空悬占用资源。
 */
export async function handleRunScheduledTask(
    req: IncomingMessage,
    res: ServerResponse,
): Promise<void> {
    if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
    }
    let body: RunScheduledTaskBody;
    try {
        const raw = await readBody(req);
        body = JSON.parse(raw) as RunScheduledTaskBody;
    } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
    }
    const { sessionId, message, agentId: bodyAgentId, backendBaseUrl, taskId } = body;
    if (!sessionId || !message) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "sessionId, message required" }));
        return;
    }

    const sessionAgentId = bodyAgentId ?? "default";
    let resolvedWorkspace = "default";
    let provider: string | undefined;
    let modelId: string | undefined;
    let apiKey: string | undefined;
    const agentConfig = await loadDesktopAgentConfig(sessionAgentId);
    if (agentConfig) {
        if (agentConfig.workspace) resolvedWorkspace = agentConfig.workspace;
        provider = agentConfig.provider;
        modelId = agentConfig.model;
        if (agentConfig.apiKey) apiKey = agentConfig.apiKey;
    }

    const COMPOSITE_KEY_SEP = "::";
    try {
        const session = await agentManager.getOrCreateSession(sessionId, {
            agentId: sessionAgentId,
            workspace: resolvedWorkspace,
            provider,
            modelId,
            apiKey,
            mcpServers: agentConfig?.mcpServers,
            systemPrompt: agentConfig?.systemPrompt,
        });
        let assistantContent = "";
        let turnPromptTokens = 0;
        let turnCompletionTokens = 0;

        const unsubscribe = session.subscribe((event: any) => {
            if (event.type === "message_update" && event.assistantMessageEvent) {
                const ev = event.assistantMessageEvent;
                if (ev.type === "text_delta" && ev.delta) {
                    assistantContent += ev.delta;
                }
            } else if (event.type === "turn_end") {
                const usage = event.message?.usage;
                if (usage) {
                    turnPromptTokens += Number(usage.input ?? usage.input_tokens ?? 0) || 0;
                    turnCompletionTokens += Number(usage.output ?? usage.output_tokens ?? 0) || 0;
                }
            }
        });

        const experienceBlock = await getExperienceContextForUserMessage();
        const userMessageToSend =
            experienceBlock.trim().length > 0
                ? `${experienceBlock}\n\n用户问题：\n${message}`
                : message;

        // 定时任务复用同一 session：若上次执行未结束会报 "Agent is already processing"。先等待空闲再发，避免并发。
        const idleTimeoutMs = 10 * 60 * 1000;
        const pollMs = 2000;
        let waited = 0;
        while ((session as any).isStreaming && waited < idleTimeoutMs) {
            await new Promise((r) => setTimeout(r, pollMs));
            waited += pollMs;
        }
        if ((session as any).isStreaming) {
            throw new Error("Session still busy after waiting; try again later.");
        }
        await session.sendUserMessage(userMessageToSend);
        unsubscribe();

        if (backendBaseUrl && assistantContent !== undefined) {
            const url = `${backendBaseUrl.replace(/\/$/, "")}/server-api/agents/sessions/${encodeURIComponent(sessionId)}/messages`;
            await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ role: "assistant", content: assistantContent }),
            }).catch((err) => console.error("[run-scheduled-task] POST assistant message failed:", err));
        }

        const usage =
            turnPromptTokens > 0 || turnCompletionTokens > 0
                ? { promptTokens: turnPromptTokens, completionTokens: turnCompletionTokens }
                : undefined;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
            JSON.stringify({
                success: true,
                sessionId,
                assistantContent: assistantContent ?? "",
                ...(usage && { usage }),
            })
        );
    } catch (error: any) {
        console.error("[run-scheduled-task] error:", error);
        const msg = error?.message ?? String(error);
        const friendlyError =
            msg.includes("No API key") || msg.includes("API key")
                ? "未配置大模型 API Key。请在桌面端「设置」-「模型配置」中为当前智能体选择 Provider 并保存，并确保在「Provider 配置」中已填写对应 API Key。"
                : msg || "Internal server error";
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: friendlyError }));
    } finally {
        agentManager.deleteSession(sessionId + COMPOSITE_KEY_SEP + sessionAgentId);
    }
}
