import type { WebSocket } from "ws";
import type { GatewayClient, GatewayRequest } from "./types.js";
import { parseMessage, send, createErrorResponse, createSuccessResponse } from "./utils.js";
import { handleConnect } from "./methods/connect.js";
import { handleAgentChat } from "./methods/agent-chat.js";
import { handleAgentCancel } from "./methods/agent-cancel.js";

/**
 * Handle incoming WebSocket message
 */
export async function handleMessage(client: GatewayClient, data: Buffer | string): Promise<void> {
    const message = parseMessage(data);

    if (!message) {
        send(client.ws, createErrorResponse("unknown", "Invalid message format"));
        return;
    }

    // Only handle request messages
    if (message.type !== "request") {
        return;
    }

    const request = message as GatewayRequest;
    const { id, method, params } = request;

    console.log(`Received request: ${method} (id: ${id})`);

    try {
        let result: any;

        switch (method) {
            case "connect":
                result = await handleConnect(client, params || {});
                break;

            case "agent.chat":
                // Check if client is authenticated
                if (!client.authenticated) {
                    throw new Error("Not authenticated. Call 'connect' first.");
                }
                result = await handleAgentChat(client, params || {});
                break;

            case "agent.cancel":
                if (!client.authenticated) {
                    throw new Error("Not authenticated. Call 'connect' first.");
                }
                result = await handleAgentCancel(client, params || {});
                break;

            case "subscribe_session":
                // Handle session subscription
                // Since handleAgentChat manages its own subscription per request,
                // this might be for listening to async updates.
                // For now, we just acknowledge it to prevent client errors.
                // A more robust implementation would hook into agentManager.
                console.log(`Client ${client.id} subscribed to session ${params.sessionId}`);
                client.sessionId = params.sessionId; // Store session ID on client
                result = { status: "subscribed", sessionId: params.sessionId };
                break;

            case "unsubscribe_session":
                console.log(`Client ${client.id} unsubscribed from session`);
                delete client.sessionId;
                result = { status: "unsubscribed" };
                break;

            default:
                throw new Error(`Unknown method: ${method}`);
        }

        // Send success response
        send(client.ws, createSuccessResponse(id, result));
    } catch (error: any) {
        console.error(`Error handling ${method}:`, error);
        send(client.ws, createErrorResponse(id, error.message || "Internal error"));
    }
}
