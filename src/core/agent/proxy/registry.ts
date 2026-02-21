/**
 * AgentProxy 注册表：按 runnerType 注册与获取适配器。
 */
import type { IAgentProxyAdapter } from "./types.js";

const adapters = new Map<string, IAgentProxyAdapter>();

export function registerAgentProxyAdapter(adapter: IAgentProxyAdapter): void {
    if (adapters.has(adapter.type)) {
        console.warn(`[AgentProxyRegistry] overwriting adapter for type "${adapter.type}"`);
    }
    adapters.set(adapter.type, adapter);
}

export function getAgentProxyAdapter(type: string): IAgentProxyAdapter | undefined {
    return adapters.get(type);
}

export function listAgentProxyAdapterTypes(): string[] {
    return Array.from(adapters.keys());
}
