/**
 * Registry of AbortControllers for in-flight proxy runs (Coze/OpenClawX/OpenCode).
 * agent.cancel looks up by sessionId+agentId and aborts the controller so the run stops.
 */
const SEP = "::";

function key(sessionId: string, agentId: string): string {
    return sessionId + SEP + agentId;
}

const controllers = new Map<string, AbortController>();

export function registerProxyRunAbort(sessionId: string, agentId: string): { signal: AbortSignal; unregister: () => void } {
    const k = key(sessionId, agentId);
    const existing = controllers.get(k);
    if (existing) {
        existing.abort();
        controllers.delete(k);
    }
    const controller = new AbortController();
    controllers.set(k, controller);
    return {
        signal: controller.signal,
        unregister: () => {
            controllers.delete(k);
        },
    };
}

/** Abort the proxy run for this session+agent if any; returns true if aborted. */
export function abortProxyRun(sessionId: string, agentId: string): boolean {
    const k = key(sessionId, agentId);
    const c = controllers.get(k);
    if (!c) return false;
    try {
        c.abort();
    } finally {
        controllers.delete(k);
    }
    return true;
}
