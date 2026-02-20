import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getAgentListProvider } from "../session-current-agent.js";

const ListAgentsSchema = Type.Object({});

/**
 * 创建 list_agents 工具：返回当前节点上配置的所有智能体列表，供用户在对话中选择切换。
 */
export function createListAgentsTool(): ToolDefinition {
    return {
        name: "list_agents",
        label: "List Agents",
        description:
            "列出当前可用的所有智能体（id 与名称）。用户可根据列表选择并让助手调用 switch_agent 切换到对应智能体。",
        parameters: ListAgentsSchema,
        execute: async (
            _toolCallId: string,
            _params: Record<string, unknown>,
            _signal: AbortSignal | undefined,
            _onUpdate: any,
            _ctx: any,
        ) => {
            const provider = getAgentListProvider();
            if (!provider) {
                return {
                    content: [{ type: "text" as const, text: "当前无法获取智能体列表。" }],
                    details: undefined,
                };
            }
            try {
                const list = await provider();
                if (!list?.length) {
                    return {
                        content: [{ type: "text" as const, text: "暂无配置的智能体。" }],
                        details: { agents: [] },
                    };
                }
                const lines = list.map((a) => `- **${a.id}**${a.name ? `：${a.name}` : ""}`);
                const text = "当前可用智能体：\n\n" + lines.join("\n") + "\n\n使用 switch_agent 工具并传入上述 id 可切换。";
                return {
                    content: [{ type: "text" as const, text }],
                    details: { agents: list },
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `获取列表失败: ${msg}` }],
                    details: undefined,
                };
            }
        },
    };
}
