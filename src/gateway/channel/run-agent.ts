/**
 * 通道用：跑 Agent 并收集完整回复文本（无 WebSocket 客户端）。
 * 委托给 core/agent/proxy 统一入口，按 runnerType 分发到 local/coze/openclawx 等适配器。
 */
import { runForChannelStream, runForChannelCollect } from "../../core/agent/proxy/index.js";

export interface RunAgentForChannelOptions {
    /** 会话 ID，建议 channel:platform:threadId */
    sessionId: string;
    /** 用户消息正文 */
    message: string;
    /** 使用的 agentId，缺省 default */
    agentId?: string;
}

export interface RunAgentStreamCallbacks {
    /** 每收到一段助手文本 delta 时调用 */
    onChunk(delta: string): void;
    /** turn_end 时可选调用，供通道按需处理（如本小轮结束、tool 结果已出） */
    onTurnEnd?: () => void;
    /** agent_end 时调用，表示整轮对话真正结束 */
    onDone(): void;
}

/**
 * 使用 AgentProxy 统一入口跑一轮对话，以流式回调方式推送助手回复（onChunk/onDone）。
 */
export async function runAgentAndStreamReply(
    options: RunAgentForChannelOptions,
    callbacks: RunAgentStreamCallbacks
): Promise<void> {
    await runForChannelStream(
        {
            sessionId: options.sessionId,
            message: options.message,
            agentId: options.agentId ?? "default",
        },
        callbacks
    );
}

/**
 * 使用 AgentProxy 统一入口跑一轮对话，收集助手完整回复文本后返回。
 */
export async function runAgentAndCollectReply(options: RunAgentForChannelOptions): Promise<string> {
    return runForChannelCollect({
        sessionId: options.sessionId,
        message: options.message,
        agentId: options.agentId ?? "default",
    });
}
