/**
 * 通道用统一执行入口：根据 agent 配置的 runnerType 选择适配器并执行。
 */
import { loadDesktopAgentConfig } from "../../config/desktop-config.js";
import { getAgentProxyAdapter } from "./registry.js";
import type { RunAgentForChannelOptions, RunAgentStreamCallbacks } from "./types.js";

export async function runForChannelStream(
    options: RunAgentForChannelOptions,
    callbacks: RunAgentStreamCallbacks
): Promise<void> {
    const agentId = options.agentId ?? "default";
    const config = await loadDesktopAgentConfig(agentId);
    if (!config) {
        throw new Error(`Agent config not found for agentId: ${agentId}`);
    }
    const runnerType = config.runnerType ?? "local";
    const adapter = getAgentProxyAdapter(runnerType);
    if (!adapter) {
        throw new Error(`No AgentProxy adapter registered for type: "${runnerType}"`);
    }
    await adapter.runStream({ ...options, agentId, signal: options.signal }, config, callbacks);
}

export async function runForChannelCollect(options: RunAgentForChannelOptions): Promise<string> {
    const agentId = options.agentId ?? "default";
    const config = await loadDesktopAgentConfig(agentId);
    if (!config) {
        throw new Error(`Agent config not found for agentId: ${agentId}`);
    }
    const runnerType = config.runnerType ?? "local";
    const adapter = getAgentProxyAdapter(runnerType);
    if (!adapter) {
        throw new Error(`No AgentProxy adapter registered for type: "${runnerType}"`);
    }
    return adapter.runCollect({ ...options, agentId }, config);
}
