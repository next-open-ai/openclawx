/**
 * 当前 session 使用的 agent 解析与更新、以及节点上 agent 列表提供。
 * 由 Gateway 启动时注入，供 agent-chat、channel-core、以及 Core 层 switch_agent / list_agents 工具使用。
 */

export type SessionCurrentAgentResolver = (sessionId: string) => string | undefined;
export type SessionCurrentAgentUpdater = (sessionId: string, agentId: string) => void;
export type AgentListProvider = () => Promise<{ id: string; name?: string }[]>;

/** 创建智能体参数：由 create_agent 工具传入，缺省由工具层补齐 */
export type CreateAgentParams = {
    name: string;
    workspace: string;
    systemPrompt?: string;
    provider?: string;
    model?: string;
    modelItemCode?: string;
};
export type CreateAgentResult = { id: string; name: string } | { error: string };
export type CreateAgentProvider = (params: CreateAgentParams) => Promise<CreateAgentResult>;

let resolver: SessionCurrentAgentResolver | null = null;
let updater: SessionCurrentAgentUpdater | null = null;
let agentListProvider: AgentListProvider | null = null;
let createAgentProvider: CreateAgentProvider | null = null;

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

export function setCreateAgentProvider(fn: CreateAgentProvider | null): void {
    createAgentProvider = fn;
}

export function getCreateAgentProvider(): CreateAgentProvider | null {
    return createAgentProvider;
}
