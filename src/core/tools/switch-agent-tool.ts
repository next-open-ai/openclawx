import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getSessionCurrentAgentUpdater } from "../session-current-agent.js";

const SwitchAgentSchema = Type.Object({
    agent_id: Type.String({
        description: "要切换到的智能体 ID，与设置中智能体列表一致（如 default 或工作空间名）",
    }),
});

type SwitchAgentParams = { agent_id: string };

/**
 * 创建 switch_agent 工具：将当前会话的下一次及后续对话切换到指定 agent。
 * 需在 Gateway 启动时通过 setSessionCurrentAgentUpdater 注入更新函数。
 */
export function createSwitchAgentTool(businessSessionId: string): ToolDefinition {
    return {
        name: "switch_agent",
        label: "Switch Agent",
        description:
            "将当前对话切换为使用指定智能体。切换后，用户下一次及后续消息将由该智能体处理。可用于在对话中更换助手（如从主智能体切换到专项智能体）。",
        parameters: SwitchAgentSchema,
        execute: async (
            _toolCallId: string,
            params: SwitchAgentParams,
            _signal: AbortSignal | undefined,
            _onUpdate: any,
            _ctx: any,
        ) => {
            const agentId = (params.agent_id ?? "").trim();
            if (!agentId) {
                return {
                    content: [{ type: "text" as const, text: "请提供要切换到的智能体 ID（如 default 或工作空间名）。" }],
                    details: undefined,
                };
            }
            const updateFn = getSessionCurrentAgentUpdater();
            if (!updateFn) {
                return {
                    content: [{ type: "text" as const, text: "当前环境不支持切换智能体。" }],
                    details: undefined,
                };
            }
            try {
                updateFn(businessSessionId, agentId);
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `已切换到智能体「${agentId}」。后续回复将由该智能体处理。`,
                        },
                    ],
                    details: { agentId },
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `切换失败: ${msg}` }],
                    details: undefined,
                };
            }
        },
    };
}
