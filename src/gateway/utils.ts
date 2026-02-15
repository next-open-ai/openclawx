import type { WebSocket } from "ws";
import type { GatewayMessage } from "./types.js";

/**
 * Send JSON message to WebSocket client
 */
export function send(ws: WebSocket, message: GatewayMessage): void {
    try {
        ws.send(JSON.stringify(message));
    } catch (error) {
        console.error("Failed to send message:", error);
    }
}

/**
 * Parse incoming WebSocket message
 */
export function parseMessage(data: Buffer | string): GatewayMessage | null {
    try {
        const text = typeof data === "string" ? data : data.toString();
        const obj = JSON.parse(text);

        // If type is missing, try to infer it
        if (!obj.type) {
            if (obj.method) {
                obj.type = "request";
            } else if (obj.event) {
                obj.type = "event";
            } else if (obj.result !== undefined || obj.error !== undefined) {
                obj.type = "response";
            }
        }

        return obj as GatewayMessage;
    } catch (error) {
        console.error("Failed to parse message:", error);
        return null;
    }
}

/**
 * Create error response
 */
export function createErrorResponse(id: string, message: string, code?: string): GatewayMessage {
    return {
        type: "response",
        id,
        error: { message, code },
    };
}

/**
 * Create success response
 */
export function createSuccessResponse(id: string, result: any): GatewayMessage {
    return {
        type: "response",
        id,
        result,
    };
}

/**
 * Create event message
 */
export function createEvent(event: string, payload: any): GatewayMessage {
    return {
        type: "event",
        event,
        payload,
    };
}
