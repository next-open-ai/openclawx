/**
 * 当前 session 使用的 agent 解析与更新、以及节点上 agent 列表提供。
 * 由 Gateway 启动时注入，供 agent-chat、channel-core、以及 Core 层 switch_agent / list_agents 工具使用。
 */

export type SessionCurrentAgentResolver = (sessionId: string) => string | undefined;
export type SessionCurrentAgentUpdater = (sessionId: string, agentId: string) => void;
export type AgentListProvider = () => Promise<{ id: string; name?: string }[]>;

let resolver: SessionCurrentAgentResolver | null = null;
let updater: SessionCurrentAgentUpdater | null = null;
let agentListProvider: AgentListProvider | null = null;

export function setSessionCurrentAgentResolver(fn: SessionCurrentAgentResolver | null): void {
    resolver = fn;
}

export function getSessionCurrentAgentResolver(): SessionCurrentAgentResolver | null {
    return resolver;
}

export function setSessionCurrentAgentUpdater(fn: SessionCurrentAgentUpdater | null): void {
    updater = fn;
}

export function getSessionCurrentAgentUpdater(): SessionCurrentAgentUpdater | null {
    return updater;
}

export function setAgentListProvider(fn: AgentListProvider | null): void {
    agentListProvider = fn;
}

export function getAgentListProvider(): AgentListProvider | null {
    return agentListProvider;
}
