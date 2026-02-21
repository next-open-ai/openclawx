/**
 * AgentProxy 统一类型：适配器接口与执行参数。
 */
import type { DesktopAgentConfig } from "../../config/desktop-config.js";

export interface RunAgentForChannelOptions {
    sessionId: string;
    message: string;
    agentId: string;
}

export interface RunAgentStreamCallbacks {
    onChunk(delta: string): void;
    onTurnEnd?(): void;
    onDone(): void;
}

/**
 * 代理适配器接口：按平台实现，对外提供流式/一次性回复。
 */
export interface IAgentProxyAdapter {
    readonly type: string;

    /**
     * 流式执行：通过 callbacks 推送 delta，onDone 表示整轮结束。
     */
    runStream(
        options: RunAgentForChannelOptions,
        config: DesktopAgentConfig,
        callbacks: RunAgentStreamCallbacks
    ): Promise<void>;

    /**
     * 一次性执行：返回完整回复文本。
     */
    runCollect(options: RunAgentForChannelOptions, config: DesktopAgentConfig): Promise<string>;
}
