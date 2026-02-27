import type { GatewayClient } from "../types.js";
import { agentManager } from "../../core/agent/agent-manager.js";
import { abortProxyRun } from "../proxy-run-abort.js";
import { clearSessionStreamSubscription } from "./agent-chat.js";

const COMPOSITE_KEY_SEP = "::";

/**
 * Handle agent.cancel: abort the current turn for the given session.
 * - Proxy agents: abort in-flight run via registered AbortController.
 * - Local agent: uses pi-coding-agent's session.abort().
 */
export async function handleAgentCancel(
    client: GatewayClient,
    params: { sessionId?: string; agentId?: string }
): Promise<{ status: string }> {
    const sessionId = params?.sessionId ?? client.sessionId;
    if (!sessionId) {
        throw new Error("No session ID available");
    }

    const agentId = params?.agentId ?? client.agentId ?? "default";

    if (abortProxyRun(sessionId, agentId)) {
        clearSessionStreamSubscription(sessionId);
        return { status: "aborted" };
    }

    clearSessionStreamSubscription(sessionId);
    const compositeKey = sessionId + COMPOSITE_KEY_SEP + agentId;
    let session = agentManager.getSession(compositeKey);
    if (!session) {
        session = agentManager.getSessionBySessionId(sessionId);
    }
    if (!session) {
        return { status: "no_session" };
    }

    await session.abort();
    return { status: "aborted" };
}
