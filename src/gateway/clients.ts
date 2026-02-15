import type { GatewayClient } from "./types.js";

/**
 * Connected clients
 */
export const connectedClients = new Set<GatewayClient>();
