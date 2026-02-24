/**
 * AgentProxy 模块：统一执行入口与适配器注册。
 * 使用前需确保已通过 registerAgentProxyAdapter 注册各类型适配器；
 * 本模块在加载时注册内置的 local、coze、openclawx、opencode 适配器。
 */
import { registerAgentProxyAdapter } from "./registry.js";
import { localAdapter } from "./adapters/local-adapter.js";
import { cozeAdapter } from "./adapters/coze-adapter.js";
import { openclawxAdapter } from "./adapters/openclawx-adapter.js";
import { opencodeAdapter } from "./adapters/opencode-adapter.js";

registerAgentProxyAdapter(localAdapter);
registerAgentProxyAdapter(cozeAdapter);
registerAgentProxyAdapter(openclawxAdapter);
registerAgentProxyAdapter(opencodeAdapter);

export { runForChannelStream, runForChannelCollect } from "./run-for-channel.js";
export { registerAgentProxyAdapter, getAgentProxyAdapter, listAgentProxyAdapterTypes } from "./registry.js";
export type { IAgentProxyAdapter, RunAgentForChannelOptions, RunAgentStreamCallbacks } from "./types.js";
