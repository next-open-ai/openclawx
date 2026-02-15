import type { WebSocket } from "ws";
import type { IncomingMessage } from "http";
import { randomUUID } from "node:crypto";
import type { GatewayClient } from "./types.js";
import { send, createEvent } from "./utils.js";
import { handleMessage } from "./message-handler.js";
import { connectedClients } from "./clients.js";

/**
 * Handle new WebSocket connection
 */
export function handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const connId = randomUUID();
    const remoteAddr = req.socket.remoteAddress;

    console.log(`New connection: ${connId} from ${remoteAddr}`);

    // Create client object
    const client: GatewayClient = {
        id: connId,
        ws,
        authenticated: false,
        connectedAt: Date.now(),
    };

    connectedClients.add(client);

    // Send connection challenge
    send(ws, createEvent("connect.challenge", {
        nonce: randomUUID(),
        ts: Date.now(),
    }));

    // Handle incoming messages
    ws.on("message", async (data) => {
        console.log(`Raw message received from ${connId}, type: ${typeof data}`);
        try {
            // Convert RawData to Buffer
            const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data.toString());
            console.log(`Message buffer length: ${buffer.length}`);
            await handleMessage(client, buffer);
        } catch (error: any) {
            console.error(`Error handling message from ${connId}:`, error);
        }
    });

    // Handle connection close
    ws.on("close", (code, reason) => {
        connectedClients.delete(client);
        const duration = Date.now() - client.connectedAt;
        console.log(`Connection closed: ${connId} (duration: ${duration}ms, code: ${code}, reason: ${reason.toString()})`);
    });

    // Handle errors
    ws.on("error", (error) => {
        console.error(`WebSocket error for ${connId}:`, error);
    });
}
