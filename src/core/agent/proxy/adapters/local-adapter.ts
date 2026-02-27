/**
 * Local AgentProxy 适配器：使用本机 AgentManager（pi-coding-agent）执行。
 */
import { agentManager } from "../../agent-manager.js";
import { getDesktopConfig } from "../../../config/desktop-config.js";
import type { DesktopAgentConfig } from "../../../config/desktop-config.js";
import type {
    IAgentProxyAdapter,
    RunAgentForChannelOptions,
    RunAgentStreamCallbacks,
} from "../types.js";

const CHANNEL_AGENT_TIMEOUT_MS = 120_000;

export const localAdapter: IAgentProxyAdapter = {
    type: "local",

    async runStream(options, config, callbacks): Promise<void> {
        const { sessionId, message, agentId } = options;
        const workspace = config.workspace ?? agentId ?? "default";
        const { maxAgentSessions } = getDesktopConfig();
        const session = await agentManager.getOrCreateSession(sessionId, {
            agentId,
            workspace,
            provider: config.provider,
            modelId: config.model,
            apiKey: config.apiKey,
            maxSessions: maxAgentSessions,
            targetAgentId: agentId,
            mcpServers: config.mcpServers,
            systemPrompt: config.systemPrompt,
            useLongMemory: config.useLongMemory,
            webSearch: config.webSearch,
        });

        let resolveDone: () => void;
        const donePromise = new Promise<void>((r) => {
            resolveDone = r;
        });

        const unsubscribe = session.subscribe((event: { type: string; assistantMessageEvent?: { type?: string; delta?: string } }) => {
            if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta" && event.assistantMessageEvent?.delta) {
                callbacks.onChunk(event.assistantMessageEvent.delta);
            } else if (event.type === "turn_end") {
                callbacks.onTurnEnd?.();
            } else if (event.type === "agent_end") {
                callbacks.onDone();
                resolveDone();
            }
        });

        try {
            await session.sendUserMessage(message, { deliverAs: "followUp" });
            await Promise.race([
                donePromise,
                new Promise<void>((_, rej) =>
                    setTimeout(() => rej(new Error("Channel agent reply timeout")), CHANNEL_AGENT_TIMEOUT_MS)
                ),
            ]);
        } finally {
            unsubscribe();
        }
    },

    async runCollect(options, config): Promise<string> {
        const { sessionId, message, agentId } = options;
        const workspace = config.workspace ?? agentId ?? "default";
        const { maxAgentSessions } = getDesktopConfig();
        const session = await agentManager.getOrCreateSession(sessionId, {
            agentId,
            workspace,
            provider: config.provider,
            modelId: config.model,
            apiKey: config.apiKey,
            maxSessions: maxAgentSessions,
            targetAgentId: agentId,
            mcpServers: config.mcpServers,
            systemPrompt: config.systemPrompt,
            useLongMemory: config.useLongMemory,
            webSearch: config.webSearch,
        });

        const chunks: string[] = [];
        let resolveDone: () => void;
        const donePromise = new Promise<void>((r) => {
            resolveDone = r;
        });

        const unsubscribe = session.subscribe((event: { type: string; assistantMessageEvent?: { type?: string; delta?: string } }) => {
            if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta" && event.assistantMessageEvent?.delta) {
                chunks.push(event.assistantMessageEvent.delta);
            } else if (event.type === "agent_end") {
                resolveDone();
            }
        });

        try {
            await session.sendUserMessage(message, { deliverAs: "followUp" });
            await Promise.race([
                donePromise,
                new Promise<void>((_, rej) =>
                    setTimeout(() => rej(new Error("Channel agent reply timeout")), CHANNEL_AGENT_TIMEOUT_MS)
                ),
            ]);
        } finally {
            unsubscribe();
        }
        return chunks.join("").trim() || "(无文本回复)";
    },
};
