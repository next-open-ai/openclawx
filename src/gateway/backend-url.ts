/**
 * Backend base URL for the Nest Desktop Server (e.g. http://localhost:38081).
 * Set by startGatewayServer so agent-chat / usage reporting can POST to server-api.
 */
let backendBaseUrl: string | null = null;

export function setBackendBaseUrl(url: string): void {
    backendBaseUrl = url;
}

export function getBackendBaseUrl(): string | null {
    return backendBaseUrl;
}
