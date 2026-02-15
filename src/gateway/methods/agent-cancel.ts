import type { GatewayClient } from "../types.js";
import { agentManager } from "../../core/agent/agent-manager.js";

/**
 * Handle agent.cancel: abort the current turn for the given session.
 * Uses pi-coding-agent's session.abort() to stop the running agent and wait until idle.
 */
export async function handleAgentCancel(
    client: GatewayClient,
    params: { sessionId?: string }
): Promise<{ status: string }> {
    const sessionId = params?.sessionId ?? client.sessionId;
    if (!sessionId) {
        throw new Error("No session ID available");
    }

    const session = agentManager.getSession(sessionId);
    if (!session) {
        return { status: "no_session" };
    }

    await session.abort();
    return { status: "aborted" };
}
