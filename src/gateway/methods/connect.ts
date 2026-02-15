import type { GatewayClient, ConnectParams } from "../types.js";
import { agentManager } from "../../core/agent/agent-manager.js";
import { randomUUID } from "crypto";

/**
 * Handle client connection request.
 * 客户端传入 sessionId、agentId、sessionType，Gateway 不再为配置/类型请求 Nest。
 */
export async function handleConnect(
    client: GatewayClient,
    params: ConnectParams
): Promise<{ sessionId: string; status: string }> {
    client.authenticated = true;
    client.sessionId = params.sessionId || randomUUID();
    if (params.agentId !== undefined) client.agentId = params.agentId;
    if (params.sessionType !== undefined) client.sessionType = params.sessionType;

    console.log(`Client ${client.id} connected with session ${client.sessionId}, agentId=${client.agentId ?? "default"}, type=${client.sessionType ?? "chat"}`);

    return {
        sessionId: client.sessionId || "",
        status: "connected",
    };
}
